import Anthropic from '@anthropic-ai/sdk'
// JSON Schema rather than the SDK's zod helper: that helper is typed against
// Zod v4, and this project is on v3 for env validation. Using a plain schema
// keeps one Zod version in the codebase and still gives a typed `parsed_output`.
import { jsonSchemaOutputFormat } from '@anthropic-ai/sdk/helpers/json-schema'
import type { ChapterMarker } from '@capella/types'
import { config } from '../config.js'
import { logger } from '../lib/logger.js'
import { formatChapterTimestamp } from './vttService.js'

/**
 * Chapter detection: one LLM pass over the transcript text.
 *
 * Text only — the video never leaves AEM. Failure is always non-fatal: chapters
 * are a convenience for approvers, and the transcript and VTT stand on their own.
 */

const MAX_CHAPTERS = 7
const MIN_CHAPTERS = 3
/** Below this, a video is too short to have meaningful topic shifts. */
const MIN_TRANSCRIPT_CHARS = 500

const CHAPTER_SCHEMA = {
  type: 'object',
  properties: {
    chapters: {
      type: 'array',
      description: `Between ${MIN_CHAPTERS} and ${MAX_CHAPTERS} chapters, in chronological order`,
      items: {
        type: 'object',
        properties: {
          time: {
            type: 'string',
            description: 'Start of the chapter as HH:MM:SS, copied from a [timestamp] marker',
          },
          title: {
            type: 'string',
            description: 'Short descriptive title, 2-6 words, no trailing punctuation',
          },
        },
        required: ['time', 'title'],
        additionalProperties: false,
      },
    },
  },
  required: ['chapters'],
  additionalProperties: false,
} as const

const SYSTEM_PROMPT = `You segment video transcripts into chapters for an internal review tool at Capella University.

The transcript is annotated with [HH:MM:SS] markers at the start of each paragraph.

Rules:
- Identify ${MIN_CHAPTERS}-${MAX_CHAPTERS} genuine topic shifts. Fewer is better than inventing boundaries.
- The first chapter always starts at 00:00:00.
- Every time must be copied from a [HH:MM:SS] marker present in the transcript. Never invent or interpolate one.
- Titles describe what that section covers, in 2-6 words. No numbering, no trailing punctuation.
- Chapters must be in chronological order and must not repeat a timestamp.`

let client: Anthropic | null = null

function getClient(): Anthropic {
  client ??= new Anthropic({ apiKey: config.anthropicApiKey })
  return client
}

/**
 * Detect chapters from a timestamped transcript.
 *
 * Returns null rather than throwing on every failure path — no API key, a short
 * transcript, a malformed response, a network error. The caller stores the
 * transcript regardless and the approval workflow is unaffected.
 */
export async function detectChapters(
  timestampedTranscript: string,
  durationSeconds: number,
): Promise<ChapterMarker[] | null> {
  if (!config.anthropicApiKey) {
    logger.info('ANTHROPIC_API_KEY not set — skipping chapter detection')
    return null
  }

  if (timestampedTranscript.trim().length < MIN_TRANSCRIPT_CHARS) {
    logger.info('Transcript too short for chapter detection')
    return null
  }

  try {
    const response = await getClient().messages.parse({
      model: config.chapterDetectionModel,
      max_tokens: 2_000,
      system: SYSTEM_PROMPT,
      messages: [
        {
          role: 'user',
          content: `Transcript (total duration ${formatChapterTimestamp(durationSeconds)}):\n\n${timestampedTranscript}`,
        },
      ],
      output_config: { format: jsonSchemaOutputFormat(CHAPTER_SCHEMA) },
    })

    // `parsed_output` is null when the model's output failed schema validation.
    const parsed = response.parsed_output
    if (!parsed) {
      logger.warn('Chapter detection returned no parseable output')
      return null
    }

    const chapters = sanitizeChapters(parsed.chapters, durationSeconds)
    return chapters.length >= 2 ? chapters : null
  } catch (error) {
    logger.error({ err: error }, 'Chapter detection failed — continuing without chapters')
    return null
  }
}

/**
 * Enforce the invariants the UI depends on, rather than trusting the model:
 * well-formed timestamps, within the video, chronological, unique, starting at
 * zero, and capped. Chapter links seek the video preview, so an out-of-range
 * timestamp is a broken control.
 */
export function sanitizeChapters(
  raw: Array<{ time: string; title: string }>,
  durationSeconds: number,
): ChapterMarker[] {
  const seen = new Set<number>()

  const chapters = raw
    .map((chapter) => ({ seconds: parseTimestamp(chapter.time), title: chapter.title.trim() }))
    .filter(
      (chapter): chapter is { seconds: number; title: string } =>
        chapter.seconds !== null && chapter.title.length > 0,
    )
    .filter((chapter) => chapter.seconds <= durationSeconds)
    .filter((chapter) => {
      if (seen.has(chapter.seconds)) return false
      seen.add(chapter.seconds)
      return true
    })
    .sort((a, b) => a.seconds - b.seconds)
    .slice(0, MAX_CHAPTERS)

  if (chapters.length === 0) return []

  // The first chapter must be the start of the video, or the table of contents
  // has an unreachable gap at the top.
  const first = chapters[0]
  if (first && first.seconds !== 0) first.seconds = 0

  return chapters.map((chapter) => ({
    time: formatChapterTimestamp(chapter.seconds),
    title: chapter.title.replace(/[.:;,]+$/, ''),
  }))
}

/** `HH:MM:SS` or `MM:SS` to seconds. Null if it isn't a timestamp. */
export function parseTimestamp(value: string): number | null {
  const match = /^(?:(\d{1,2}):)?(\d{1,2}):(\d{2})$/.exec(value.trim())
  if (!match) return null

  const hours = Number(match[1] ?? 0)
  const minutes = Number(match[2])
  const seconds = Number(match[3])

  if (!Number.isFinite(minutes) || !Number.isFinite(seconds)) return null
  if (minutes > 59 || seconds > 59) return null

  return hours * 3600 + minutes * 60 + seconds
}
