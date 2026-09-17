import { parseTimestamp, sanitizeChapters } from './chapterService.js'

/**
 * These cover the guardrails around the LLM's output, not the call itself.
 * The model is treated as untrusted: a chapter link seeks the video preview,
 * so a bad timestamp is a broken control, not a cosmetic issue.
 */

describe('parseTimestamp', () => {
  it('parses HH:MM:SS', () => {
    expect(parseTimestamp('01:02:03')).toBe(3723)
  })

  it('parses MM:SS', () => {
    expect(parseTimestamp('02:14')).toBe(134)
  })

  it('rejects out-of-range minutes and seconds', () => {
    expect(parseTimestamp('00:99')).toBeNull()
    expect(parseTimestamp('01:99:00')).toBeNull()
  })

  it('rejects free text', () => {
    expect(parseTimestamp('two minutes in')).toBeNull()
    expect(parseTimestamp('')).toBeNull()
  })
})

describe('sanitizeChapters', () => {
  it('keeps well-formed chapters in order', () => {
    const chapters = sanitizeChapters(
      [
        { time: '00:00:00', title: 'Introduction' },
        { time: '00:02:14', title: 'Program Overview' },
      ],
      600,
    )

    expect(chapters).toEqual([
      { time: '00:00:00', title: 'Introduction' },
      { time: '00:02:14', title: 'Program Overview' },
    ])
  })

  it('drops a timestamp past the end of the video', () => {
    const chapters = sanitizeChapters(
      [
        { time: '00:00:00', title: 'Introduction' },
        { time: '01:00:00', title: 'Invented' },
      ],
      600,
    )

    expect(chapters).toHaveLength(1)
  })

  it('drops unparseable timestamps', () => {
    const chapters = sanitizeChapters(
      [
        { time: '00:00:00', title: 'Introduction' },
        { time: 'about halfway', title: 'Nonsense' },
      ],
      600,
    )

    expect(chapters).toHaveLength(1)
  })

  it('sorts chapters chronologically', () => {
    const chapters = sanitizeChapters(
      [
        { time: '00:05:00', title: 'Later' },
        { time: '00:00:00', title: 'Earlier' },
      ],
      600,
    )

    expect(chapters[0]?.title).toBe('Earlier')
  })

  it('removes duplicate timestamps', () => {
    const chapters = sanitizeChapters(
      [
        { time: '00:00:00', title: 'Introduction' },
        { time: '00:00:00', title: 'Also Introduction' },
      ],
      600,
    )

    expect(chapters).toHaveLength(1)
  })

  it('forces the first chapter to the start of the video', () => {
    // Otherwise the table of contents has an unreachable gap at the top.
    const chapters = sanitizeChapters([{ time: '00:00:42', title: 'Introduction' }], 600)
    expect(chapters[0]?.time).toBe('00:00:00')
  })

  it('caps the number of chapters', () => {
    const many = Array.from({ length: 20 }, (_, index) => ({
      time: `00:${String(index).padStart(2, '0')}:00`,
      title: `Chapter ${index}`,
    }))

    expect(sanitizeChapters(many, 3_600).length).toBeLessThanOrEqual(7)
  })

  it('strips trailing punctuation from titles', () => {
    const chapters = sanitizeChapters([{ time: '00:00:00', title: 'Introduction.' }], 600)
    expect(chapters[0]?.title).toBe('Introduction')
  })

  it('drops chapters with an empty title', () => {
    const chapters = sanitizeChapters(
      [
        { time: '00:00:00', title: 'Introduction' },
        { time: '00:01:00', title: '   ' },
      ],
      600,
    )

    expect(chapters).toHaveLength(1)
  })

  it('returns an empty array when nothing survives', () => {
    expect(sanitizeChapters([{ time: 'nope', title: '' }], 600)).toEqual([])
  })
})
