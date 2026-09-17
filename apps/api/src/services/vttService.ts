/**
 * WebVTT generation from Whisper word-level timestamps.
 *
 * Pure — no network, no filesystem. The worker calls this and streams the
 * result straight to AEM; a .vtt file is never written to disk.
 */

export interface WhisperWord {
  word: string
  start: number
  end: number
}

/** Max seconds of speech in one caption block. */
const MAX_BLOCK_SECONDS = 7
/** Max characters in one caption block — two readable lines. */
const MAX_BLOCK_CHARS = 84
/** A gap this long implies a natural break even mid-sentence. */
const SILENCE_BREAK_SECONDS = 0.8

const SENTENCE_END = /[.!?]["')\]]?$/

/** `HH:MM:SS.mmm`, the WebVTT cue timestamp format. */
export function formatVttTimestamp(seconds: number): string {
  const safe = Math.max(0, seconds)

  const hours = Math.floor(safe / 3600)
  const minutes = Math.floor((safe % 3600) / 60)
  const secs = Math.floor(safe % 60)
  const millis = Math.round((safe - Math.floor(safe)) * 1000)

  return (
    `${String(hours).padStart(2, '0')}:` +
    `${String(minutes).padStart(2, '0')}:` +
    `${String(secs).padStart(2, '0')}.` +
    String(millis).padStart(3, '0')
  )
}

/** `H:MM:SS` — the human-facing form used for chapter markers. */
export function formatChapterTimestamp(seconds: number): string {
  const safe = Math.max(0, Math.floor(seconds))
  const hours = Math.floor(safe / 3600)
  const minutes = Math.floor((safe % 3600) / 60)
  const secs = safe % 60

  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`
}

export interface CaptionBlock {
  start: number
  end: number
  text: string
}

/**
 * Group words into caption blocks.
 *
 * A block closes on whichever comes first: a sentence ending, a noticeable
 * silence, the duration cap, or the character cap. Sentence endings are
 * preferred because captions that break mid-clause are hard to read.
 */
export function groupWordsIntoBlocks(words: WhisperWord[]): CaptionBlock[] {
  const blocks: CaptionBlock[] = []

  let current: WhisperWord[] = []
  let blockStart = 0

  const flush = (): void => {
    if (current.length === 0) return

    const first = current[0]
    const last = current[current.length - 1]
    if (!first || !last) return

    blocks.push({
      start: blockStart,
      end: last.end,
      text: current
        .map((word) => word.word.trim())
        .join(' ')
        .replace(/\s+([,.!?;:])/g, '$1')
        .trim(),
    })
    current = []
  }

  for (const word of words) {
    if (current.length === 0) blockStart = word.start

    const previous = current[current.length - 1]
    const gap = previous ? word.start - previous.end : 0

    // A long pause before this word belongs to the next block, not this one.
    if (previous && gap >= SILENCE_BREAK_SECONDS) {
      flush()
      blockStart = word.start
    }

    current.push(word)

    const duration = word.end - blockStart
    const charCount = current.reduce((sum, entry) => sum + entry.word.trim().length + 1, 0)
    const endsSentence = SENTENCE_END.test(word.word.trim())

    if (endsSentence || duration >= MAX_BLOCK_SECONDS || charCount >= MAX_BLOCK_CHARS) {
      flush()
    }
  }

  flush()

  return blocks
}

/**
 * Render a valid WebVTT document. Always starts with the `WEBVTT` magic line —
 * a player rejects the file outright without it.
 */
export function generateVtt(words: WhisperWord[]): string {
  const blocks = groupWordsIntoBlocks(words)

  if (blocks.length === 0) {
    // A valid but empty track is better than a malformed one.
    return 'WEBVTT\n\n'
  }

  const cues = blocks.map((block, index) => {
    const start = formatVttTimestamp(block.start)
    // Guard against a zero-length cue, which some players drop.
    const end = formatVttTimestamp(Math.max(block.end, block.start + 0.1))
    return `${index + 1}\n${start} --> ${end}\n${block.text}`
  })

  return `WEBVTT\n\n${cues.join('\n\n')}\n`
}

/**
 * Transcript grouped into readable paragraphs with a leading timestamp.
 * The admin view shows paragraph-level timestamps only — word-level is unreadable.
 */
export function toTimestampedParagraphs(words: WhisperWord[], secondsPerParagraph = 30): string {
  const blocks = groupWordsIntoBlocks(words)
  if (blocks.length === 0) return ''

  const paragraphs: string[] = []
  let currentText: string[] = []
  let paragraphStart = blocks[0]?.start ?? 0

  for (const block of blocks) {
    if (block.start - paragraphStart >= secondsPerParagraph && currentText.length > 0) {
      paragraphs.push(`[${formatChapterTimestamp(paragraphStart)}] ${currentText.join(' ')}`)
      currentText = []
      paragraphStart = block.start
    }
    currentText.push(block.text)
  }

  if (currentText.length > 0) {
    paragraphs.push(`[${formatChapterTimestamp(paragraphStart)}] ${currentText.join(' ')}`)
  }

  return paragraphs.join('\n\n')
}
