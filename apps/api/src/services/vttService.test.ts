import {
  formatChapterTimestamp,
  formatVttTimestamp,
  generateVtt,
  groupWordsIntoBlocks,
  toTimestampedParagraphs,
  type WhisperWord,
} from './vttService.js'

function words(...entries: Array<[string, number, number]>): WhisperWord[] {
  return entries.map(([word, start, end]) => ({ word, start, end }))
}

describe('formatVttTimestamp', () => {
  it('formats as HH:MM:SS.mmm', () => {
    expect(formatVttTimestamp(0)).toBe('00:00:00.000')
    expect(formatVttTimestamp(62.4)).toBe('00:01:02.400')
    expect(formatVttTimestamp(3661.5)).toBe('01:01:01.500')
  })

  it('clamps a negative value rather than emitting an invalid cue', () => {
    expect(formatVttTimestamp(-5)).toBe('00:00:00.000')
  })
})

describe('formatChapterTimestamp', () => {
  it('formats as HH:MM:SS with no milliseconds', () => {
    expect(formatChapterTimestamp(134)).toBe('00:02:14')
    expect(formatChapterTimestamp(3661)).toBe('01:01:01')
  })
})

describe('groupWordsIntoBlocks', () => {
  it('breaks a block at a sentence ending', () => {
    const blocks = groupWordsIntoBlocks(
      words(['Welcome', 0, 0.5], ['to', 0.5, 0.7], ['Capella.', 0.7, 1.2], ['We', 1.3, 1.5]),
    )

    expect(blocks).toHaveLength(2)
    expect(blocks[0]?.text).toBe('Welcome to Capella.')
  })

  it('breaks on a long silence even mid-sentence', () => {
    const blocks = groupWordsIntoBlocks(words(['Welcome', 0, 0.5], ['back', 3.0, 3.4]))
    expect(blocks).toHaveLength(2)
  })

  it('breaks at the duration cap when nobody pauses', () => {
    const long = Array.from({ length: 40 }, (_, index): WhisperWord => ({
      word: 'and',
      start: index * 0.3,
      end: index * 0.3 + 0.25,
    }))

    const blocks = groupWordsIntoBlocks(long)
    expect(blocks.length).toBeGreaterThan(1)
    for (const block of blocks) {
      expect(block.end - block.start).toBeLessThanOrEqual(8)
    }
  })

  it('does not put a space before punctuation', () => {
    const blocks = groupWordsIntoBlocks(words(['Hello', 0, 0.4], [',', 0.4, 0.45], ['there.', 0.45, 0.9]))
    expect(blocks[0]?.text).toBe('Hello, there.')
  })

  it('returns nothing for an empty word list', () => {
    expect(groupWordsIntoBlocks([])).toEqual([])
  })
})

describe('generateVtt', () => {
  it('starts with the WEBVTT magic line', () => {
    const vtt = generateVtt(words(['Welcome', 0, 0.5], ['to', 0.5, 0.7], ['Capella.', 0.7, 1.2]))
    expect(vtt.startsWith('WEBVTT\n\n')).toBe(true)
  })

  it('numbers cues and uses the arrow separator', () => {
    const vtt = generateVtt(words(['Welcome', 0, 0.5], ['to', 0.5, 0.7], ['Capella.', 0.7, 1.2]))
    expect(vtt).toContain('1\n00:00:00.000 --> 00:00:01.200')
  })

  it('returns a valid but empty track when there are no words', () => {
    // A player rejects a file without the magic line outright, so an empty
    // transcript must still produce a parseable document.
    expect(generateVtt([])).toBe('WEBVTT\n\n')
  })

  it('never emits a zero-length cue', () => {
    const vtt = generateVtt(words(['Hi.', 1.0, 1.0]))
    const match = /(\d{2}:\d{2}:\d{2}\.\d{3}) --> (\d{2}:\d{2}:\d{2}\.\d{3})/.exec(vtt)
    expect(match?.[1]).not.toBe(match?.[2])
  })
})

describe('toTimestampedParagraphs', () => {
  it('prefixes each paragraph with a timestamp', () => {
    const output = toTimestampedParagraphs(
      words(['Welcome', 0, 0.5], ['to', 0.5, 0.7], ['Capella.', 0.7, 1.2]),
    )
    expect(output).toMatch(/^\[00:00:00\]/)
  })

  it('starts a new paragraph after the interval elapses', () => {
    const long = Array.from({ length: 60 }, (_, index): WhisperWord => ({
      word: 'word.',
      start: index * 2,
      end: index * 2 + 1,
    }))

    const paragraphs = toTimestampedParagraphs(long, 30).split('\n\n')
    expect(paragraphs.length).toBeGreaterThan(1)
  })

  it('returns an empty string for no words', () => {
    expect(toTimestampedParagraphs([])).toBe('')
  })
})
