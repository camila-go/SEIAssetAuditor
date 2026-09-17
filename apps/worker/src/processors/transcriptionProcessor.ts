import { unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { Job } from 'bullmq'
import { execa } from 'execa'
import { videoSubmissionRepo } from '@capella/db'
import type { TranscriptionJobPayload } from '@capella/queue'
// `@capella/api/services` — not `@capella/api`, which would boot the HTTP server.
import {
  aemUploadService,
  detectChapters,
  generateVtt,
  mergeChunkedTranscripts,
  toTimestampedParagraphs,
  transcribeAudioFile,
  type WhisperResponse,
} from '@capella/api/services'
import { config } from '../config.js'
import { logger } from '../lib/logger.js'

/**
 * Transcription pipeline.
 *
 * Boundaries that must hold:
 *   - Only audio ever touches this server's disk, at /tmp/{jobId}.mp3.
 *   - That temp file is deleted in a `finally` block, success or failure.
 *   - The video binary stays in AEM throughout — ffmpeg reads it over HTTP.
 *   - The VTT is built as a string and streamed to AEM; never written to disk.
 *   - Failure never blocks approval. The worst case is transcript_status=failed.
 */

/** Whisper's 25MB limit, with headroom for mp3 container overhead. */
const CHUNK_SECONDS = 20 * 60

export async function processTranscriptionJob(job: Job<TranscriptionJobPayload>): Promise<void> {
  const { submissionId, aemStagingPath } = job.data

  if (!config.transcriptionEnabled) {
    logger.warn({ submissionId }, 'Transcription disabled — marking failed')
    await videoSubmissionRepo.setTranscriptStatus(submissionId, 'failed')
    return
  }

  const audioPath = path.join(tmpdir(), `${job.id ?? submissionId}.mp3`)
  const chunkPaths: string[] = []

  try {
    await videoSubmissionRepo.setTranscriptStatus(submissionId, 'processing')

    // ── 1. Extract audio. `-vn` guarantees no video stream is written. ──────
    const videoUrl = aemUploadService.stagingAssetUrl(aemStagingPath)
    await extractAudio(videoUrl, audioPath)

    // ── 2. Transcribe, chunking if the audio exceeds Whisper's limit ────────
    const whisper = await transcribeWithChunking(audioPath, chunkPaths)

    if (whisper.words.length === 0) {
      logger.warn({ submissionId }, 'Whisper returned no word timings')
    }

    // ── 3. VTT, in memory only ──────────────────────────────────────────────
    const vttContent = generateVtt(whisper.words)
    const vttAemPath = aemStagingPath.replace(/\.[^./]+$/, '.vtt')

    let uploadedVttPath: string | null = null
    try {
      await aemUploadService.uploadFile(vttAemPath, vttContent, 'text/vtt')
      uploadedVttPath = vttAemPath
    } catch (error) {
      // The transcript is still worth keeping without the caption file.
      logger.error({ err: error, submissionId }, 'VTT upload failed')
    }

    // ── 4. Chapters — returns null on any failure, never throws ─────────────
    const timestamped = toTimestampedParagraphs(whisper.words)
    const chapters = await detectChapters(timestamped || whisper.text, whisper.duration)

    // ── 5. Persist ──────────────────────────────────────────────────────────
    await videoSubmissionRepo.setTranscript(submissionId, {
      transcript: timestamped || whisper.text,
      transcriptDurationSeconds: Math.round(whisper.duration),
      chapterMarkers: chapters,
      vttAemPath: uploadedVttPath,
    })

    // ── 6. Write back to AEM (best effort) ──────────────────────────────────
    await aemUploadService
      .updateMetadata(aemStagingPath, {
        'dam:transcriptStatus': 'complete',
        'dam:chapterMarkers': chapters ? JSON.stringify(chapters) : null,
      })
      .catch((error: unknown) =>
        logger.error({ err: error, submissionId }, 'Transcript metadata write failed'),
      )

    logger.info(
      { submissionId, durationSeconds: whisper.duration, chapters: chapters?.length ?? 0 },
      'Transcription complete',
    )
  } catch (error) {
    logger.error({ err: error, submissionId }, 'Transcription failed — approval is unaffected')
    await videoSubmissionRepo.setTranscriptStatus(submissionId, 'failed').catch(() => undefined)
    // Deliberately not rethrown: a retry would re-extract audio and re-bill
    // Whisper for a video that already failed deterministically, and the
    // approval workflow does not depend on this succeeding.
  } finally {
    // Guaranteed cleanup — this is the only place video-derived data exists
    // outside AEM.
    await unlink(audioPath).catch(() => undefined)
    for (const chunkPath of chunkPaths) {
      await unlink(chunkPath).catch(() => undefined)
    }
  }
}

/** Extract an mp3 audio track from the staged video. No video stream is written. */
async function extractAudio(videoUrl: string, outputPath: string): Promise<void> {
  const auth = Buffer.from(
    `${config.aemIntakeWriteUser}:${config.aemIntakeWritePassword}`,
  ).toString('base64')

  await execa(config.ffmpegPath, [
    // The staging folder is not public, so ffmpeg needs the service credentials.
    '-headers',
    `Authorization: Basic ${auth}\r\n`,
    '-i',
    videoUrl,
    '-vn',
    '-acodec',
    'mp3',
    '-q:a',
    '4',
    '-y',
    outputPath,
  ])
}

/**
 * Transcribe, splitting the audio when it would exceed Whisper's 25MB cap.
 * Chunk transcripts are merged with their timestamps offset back into the
 * original timeline, so chapter markers and captions stay aligned.
 */
async function transcribeWithChunking(
  audioPath: string,
  chunkPaths: string[],
): Promise<WhisperResponse> {
  try {
    return await transcribeAudioFile(audioPath)
  } catch (error) {
    const isSizeLimit = error instanceof Error && error.message.includes('25MB limit')
    if (!isSizeLimit) throw error

    logger.info({ audioPath }, 'Audio over Whisper limit — splitting into chunks')

    const segmentPattern = audioPath.replace(/\.mp3$/, '-%03d.mp3')
    await execa(config.ffmpegPath, [
      '-i',
      audioPath,
      '-f',
      'segment',
      '-segment_time',
      String(CHUNK_SECONDS),
      '-c',
      'copy',
      '-y',
      segmentPattern,
    ])

    const results: Array<{ response: WhisperResponse; offsetSeconds: number }> = []

    for (let index = 0; ; index++) {
      const chunkPath = audioPath.replace(/\.mp3$/, `-${String(index).padStart(3, '0')}.mp3`)
      try {
        const response = await transcribeAudioFile(chunkPath)
        chunkPaths.push(chunkPath)
        results.push({ response, offsetSeconds: index * CHUNK_SECONDS })
      } catch (chunkError) {
        // The first missing chunk marks the end of the segment sequence.
        if (isMissingFile(chunkError)) break
        chunkPaths.push(chunkPath)
        throw chunkError
      }
    }

    if (results.length === 0) {
      throw new Error('Audio chunking produced no transcribable segments')
    }

    return mergeChunkedTranscripts(results)
  }
}

function isMissingFile(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: string }).code === 'ENOENT'
  )
}
