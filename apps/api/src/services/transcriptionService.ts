import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { AppError, ERROR_CODES } from '@capella/types'
import { config } from '../config.js'
import { logger } from '../lib/logger.js'
import type { WhisperWord } from './vttService.js'

/**
 * Whisper API client.
 *
 * Only ever receives extracted audio — never the video. The caller owns the
 * temp file and is responsible for deleting it in a `finally` block.
 */

const WHISPER_URL = 'https://api.openai.com/v1/audio/transcriptions'
/** Whisper's hard limit. ~45 minutes of mp3 at `-q:a 4`. */
export const WHISPER_MAX_BYTES = 25 * 1024 * 1024
const WHISPER_TIMEOUT_MS = 10 * 60 * 1000
const MAX_ATTEMPTS = 3

export interface WhisperResponse {
  text: string
  duration: number
  words: WhisperWord[]
}

interface WhisperApiPayload {
  text?: string
  duration?: number
  words?: Array<{ word?: string; start?: number; end?: number }>
}

/** Transcribe one audio file. Throws on exhausted retries — the caller marks the job failed. */
export async function transcribeAudioFile(audioPath: string): Promise<WhisperResponse> {
  if (!config.transcriptionEnabled) {
    throw new AppError(
      ERROR_CODES.TRANSCRIPTION_NOT_CONFIGURED,
      'Transcription is disabled or OPENAI_API_KEY is not set',
    )
  }

  const { size } = await stat(audioPath)
  if (size > WHISPER_MAX_BYTES) {
    throw new AppError(
      ERROR_CODES.TRANSCRIPTION_FAILED,
      `Extracted audio is ${(size / 1024 / 1024).toFixed(1)}MB, over Whisper's 25MB limit — the caller must chunk it first`,
    )
  }

  let lastError: unknown

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      return await postToWhisper(audioPath)
    } catch (error) {
      lastError = error
      if (attempt === MAX_ATTEMPTS) break

      const backoffMs = 2 ** attempt * 1_000
      logger.warn({ err: error, attempt, backoffMs }, 'Whisper request failed — retrying')
      await new Promise((resolve) => setTimeout(resolve, backoffMs))
    }
  }

  throw new AppError(
    ERROR_CODES.TRANSCRIPTION_FAILED,
    `Whisper transcription failed after ${MAX_ATTEMPTS} attempts: ${
      lastError instanceof Error ? lastError.message : String(lastError)
    }`,
  )
}

async function postToWhisper(audioPath: string): Promise<WhisperResponse> {
  const form = new FormData()

  // The file is streamed off disk rather than read into memory.
  const stream = createReadStream(audioPath)
  const chunks: Buffer[] = []
  for await (const chunk of stream) chunks.push(chunk as Buffer)

  form.append('file', new Blob([Buffer.concat(chunks)], { type: 'audio/mpeg' }), 'audio.mp3')
  form.append('model', 'whisper-1')
  form.append('response_format', 'verbose_json')
  form.append('timestamp_granularities[]', 'word')

  const response = await fetch(WHISPER_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${config.openaiApiKey}` },
    body: form,
    signal: AbortSignal.timeout(WHISPER_TIMEOUT_MS),
  })

  if (!response.ok) {
    const detail = await response.text().catch(() => '')
    throw new Error(`Whisper returned HTTP ${response.status}: ${detail.slice(0, 300)}`)
  }

  return normalizeResponse((await response.json()) as WhisperApiPayload)
}

/** Narrow the Whisper payload; drop any word missing timing data. */
export function normalizeResponse(payload: WhisperApiPayload): WhisperResponse {
  const words: WhisperWord[] = (payload.words ?? [])
    .filter(
      (word): word is { word: string; start: number; end: number } =>
        typeof word.word === 'string' &&
        typeof word.start === 'number' &&
        typeof word.end === 'number',
    )
    .map((word) => ({ word: word.word, start: word.start, end: word.end }))

  return {
    text: payload.text ?? '',
    duration: typeof payload.duration === 'number' ? payload.duration : 0,
    words,
  }
}

/**
 * Merge chunk transcripts, shifting each chunk's timings by its offset in the
 * original audio. Used when a video exceeds the 25MB Whisper limit.
 */
export function mergeChunkedTranscripts(
  chunks: Array<{ response: WhisperResponse; offsetSeconds: number }>,
): WhisperResponse {
  const words: WhisperWord[] = []
  const texts: string[] = []
  let duration = 0

  for (const chunk of chunks) {
    texts.push(chunk.response.text.trim())
    for (const word of chunk.response.words) {
      words.push({
        word: word.word,
        start: word.start + chunk.offsetSeconds,
        end: word.end + chunk.offsetSeconds,
      })
    }
    duration = Math.max(duration, chunk.offsetSeconds + chunk.response.duration)
  }

  return { text: texts.filter(Boolean).join(' '), duration, words }
}
