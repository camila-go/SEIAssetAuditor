import {
  extractDegreeLevel,
  extractProgram,
  extractStudentName,
  fingerprint,
  isPlausibleQuote,
  parseCandidate,
  parseCandidates,
  TESTIMONIAL_SELECTORS,
  type TestimonialCandidate,
} from '../extractors/testimonialExtractor.js'

function candidate(overrides: Partial<TestimonialCandidate> = {}): TestimonialCandidate {
  return {
    text: 'The flexibility of this program let me keep working full time while finishing my degree.',
    outerHtml: '<blockquote>…</blockquote>',
    sourceType: 'hardcoded_text',
    nameHint: null,
    programHint: null,
    positionOnPage: 0,
    ...overrides,
  }
}

describe('fingerprint', () => {
  it('is stable across punctuation, case and whitespace differences', () => {
    const a = fingerprint('The program was “life-changing,” honestly.')
    const b = fingerprint('the program was life changing honestly')
    expect(a).toBe(b)
  })

  it('collapses smart quotes and straight quotes to the same value', () => {
    expect(fingerprint("It's been great")).toBe(fingerprint('It’s been great'))
  })

  it('strips diacritics so the same quote from two encodings agrees', () => {
    expect(fingerprint('José said it helped')).toBe(fingerprint('Jose said it helped'))
  })

  it('distinguishes genuinely different quotes', () => {
    expect(fingerprint('I loved the program')).not.toBe(fingerprint('I disliked the program'))
  })
})

describe('extractStudentName', () => {
  it('reads an em-dash attribution', () => {
    expect(extractStudentName('Great experience overall. — Marcus Webb', null)).toBe('Marcus Webb')
  })

  it('reads a hyphen attribution', () => {
    expect(extractStudentName('Great experience overall. - Ana Diaz', null)).toBe('Ana Diaz')
  })

  it('prefers an explicit name element over the text pattern', () => {
    expect(extractStudentName('Great experience. — M. Webb', 'Marcus Webb')).toBe('Marcus Webb')
  })

  it('strips a leading dash from the name hint', () => {
    expect(extractStudentName('Great experience.', '— Marcus Webb')).toBe('Marcus Webb')
  })

  it('returns null when there is no attribution', () => {
    expect(extractStudentName('Great experience overall.', null)).toBeNull()
  })
})

describe('extractProgram', () => {
  it('matches a known degree string in the quote', () => {
    expect(extractProgram('I finished my Master of Science in Nursing last year.', null)).toBe(
      'Master of Science in Nursing',
    )
  })

  it('matches an abbreviation', () => {
    expect(extractProgram('The MBA was worth every hour.', null)).toBe('MBA')
  })

  it('prefers the program hint element', () => {
    expect(extractProgram('The MBA was worth it.', 'Doctor of Business Administration')).toBe(
      'Doctor of Business Administration',
    )
  })

  it('returns null when no program is mentioned', () => {
    expect(extractProgram('It was a great experience from start to finish.', null)).toBeNull()
  })
})

describe('extractDegreeLevel', () => {
  it.each([
    ['Master of Science in Nursing', 'masters'],
    ['Doctor of Nursing Practice', 'doctoral'],
    ['Bachelor of Science in Business', 'bachelors'],
    ['MBA', 'masters'],
  ])('maps %s to %s', (program, expected) => {
    expect(extractDegreeLevel(program, '')).toBe(expected)
  })

  it('returns null when nothing indicates a level', () => {
    expect(extractDegreeLevel(null, 'It was a great experience.')).toBeNull()
  })
})

describe('isPlausibleQuote', () => {
  it('rejects short UI chrome caught by a blockquote selector', () => {
    expect(isPlausibleQuote('Read more')).toBe(false)
  })

  it('rejects a long string with too few words', () => {
    expect(isPlausibleQuote('Supercalifragilisticexpialidocious Antidisestablishmentarianism')).toBe(
      false,
    )
  })

  it('accepts a real testimonial', () => {
    expect(
      isPlausibleQuote('The flexibility of this program let me keep working while I studied.'),
    ).toBe(true)
  })
})

describe('parseCandidate', () => {
  it('strips the attribution out of the quote text', () => {
    const parsed = parseCandidate(
      candidate({
        text: 'The flexibility of this program let me keep working full time. — Marcus Webb',
      }),
    )

    expect(parsed?.studentName).toBe('Marcus Webb')
    expect(parsed?.quoteText).not.toContain('Marcus Webb')
  })

  it('keeps the original text when stripping would leave too little behind', () => {
    // Attribution-only content is not a testimonial; the guard must not produce
    // an empty quote.
    const parsed = parseCandidate(candidate({ text: 'Short one here now. — Marcus Webb' }))
    expect(parsed).toBeNull()
  })

  it('collapses whitespace introduced by DOM formatting', () => {
    const parsed = parseCandidate(
      candidate({ text: '\n   The program\n\n  was genuinely excellent for me.   \n' }),
    )
    expect(parsed?.quoteText).toBe('The program was genuinely excellent for me.')
  })

  it('returns null for non-testimonial content', () => {
    expect(parseCandidate(candidate({ text: 'Apply now' }))).toBeNull()
  })
})

describe('real capella.edu markup', () => {
  // Captured from https://www.capella.edu/online-degrees/ on 2026-09-16.
  // The component is `.testimonialPromo` / `.testimonial-promo`, and the
  // attribution is a bare name after a curly-quoted quote — no dash.
  const LIVE_TEXT =
    '“One of the most fulfilling aspects of my degree is showing others that you are never too old and it\'s never too late to pursue your education” Stephanie Dewald'

  it('extracts the student name with no dash separator', () => {
    const parsed = parseCandidate(
      candidate({ text: LIVE_TEXT, sourceType: 'structured_component' }),
    )
    expect(parsed?.studentName).toBe('Stephanie Dewald')
  })

  it('keeps the name out of the quote text', () => {
    const parsed = parseCandidate(
      candidate({ text: LIVE_TEXT, sourceType: 'structured_component' }),
    )
    expect(parsed?.quoteText).not.toContain('Stephanie Dewald')
    expect(parsed?.quoteText.startsWith('One of the most fulfilling')).toBe(true)
  })

  it('strips the surrounding curly quotes', () => {
    const parsed = parseCandidate(candidate({ text: LIVE_TEXT }))
    expect(parsed?.quoteText.startsWith('“')).toBe(false)
    expect(parsed?.quoteText.endsWith('”')).toBe(false)
  })

  it('collapses the nested .testimonialPromo and .testimonial-promo into one', () => {
    // Both the inner component and its outer container carry the same text.
    const parsed = parseCandidates([
      candidate({ text: LIVE_TEXT, sourceType: 'structured_component', positionOnPage: 0 }),
      candidate({ text: LIVE_TEXT, sourceType: 'structured_component', positionOnPage: 1 }),
    ])
    expect(parsed).toHaveLength(1)
  })

  it('drops the footnote marker the live page appends to the name', () => {
    // The live page renders "Stephanie Dewald*", where the asterisk points at a
    // disclaimer. Left in place it is both wrong and breaks the name match.
    const parsed = parseCandidate(
      candidate({ text: LIVE_TEXT.replace('Stephanie Dewald', 'Stephanie Dewald*') }),
    )
    expect(parsed?.studentName).toBe('Stephanie Dewald')
  })

  it('still strips the quotes when a footnote marker is present', () => {
    const parsed = parseCandidate(
      candidate({ text: LIVE_TEXT.replace('Stephanie Dewald', 'Stephanie Dewald*') }),
    )
    expect(parsed?.quoteText.startsWith('“')).toBe(false)
    expect(parsed?.quoteText).not.toContain('Stephanie')
  })

  it('fingerprints identically with and without the footnote marker', () => {
    const withMarker = parseCandidate(
      candidate({ text: LIVE_TEXT.replace('Stephanie Dewald', 'Stephanie Dewald*') }),
    )
    const without = parseCandidate(candidate({ text: LIVE_TEXT }))
    expect(fingerprint(withMarker!.quoteText)).toBe(fingerprint(without!.quoteText))
  })

  /**
   * The exact 267-character string both `.testimonialPromo` and
   * `.testimonial-promo` expose as textContent. No element in the DOM holds
   * just the quote — name, degree and disclaimer are siblings inside the same
   * wrapper, so the quotation marks are the only usable boundary.
   */
  const LIVE_FULL = `${LIVE_TEXT}* BS Business, FlexPath *Actual Capella graduate who agreed to appear in promotional materials for Capella.`

  it('keeps only the quoted span, dropping the degree line and disclaimer', () => {
    const parsed = parseCandidate(candidate({ text: LIVE_FULL }))

    expect(parsed?.quoteText).not.toContain('Actual Capella graduate')
    expect(parsed?.quoteText).not.toContain('BS Business')
    expect(parsed?.quoteText).not.toContain('Stephanie')
    expect(parsed?.quoteText.startsWith('One of the most fulfilling')).toBe(true)
    expect(parsed?.quoteText.endsWith('pursue your education')).toBe(true)
  })

  it('reads the name from the head of the attribution block', () => {
    const parsed = parseCandidate(candidate({ text: LIVE_FULL }))
    expect(parsed?.studentName).toBe('Stephanie Dewald')
  })

  it('fingerprints the same whether or not the disclaimer is present', () => {
    // The disclaimer is boilerplate repeated across pages; if it reached the
    // fingerprint, the same quote on two pages could dedup differently.
    const withDisclaimer = parseCandidate(candidate({ text: LIVE_FULL }))
    const without = parseCandidate(candidate({ text: LIVE_TEXT }))
    expect(fingerprint(withDisclaimer!.quoteText)).toBe(fingerprint(without!.quoteText))
  })

  it('collapses the two identical nested elements into one testimonial', () => {
    const parsed = parseCandidates([
      candidate({ text: LIVE_FULL, positionOnPage: 0 }),
      candidate({ text: LIVE_FULL, positionOnPage: 1 }),
    ])
    expect(parsed).toHaveLength(1)
  })

  it('has a selector that actually matches the live class names', () => {
    const substringSelector = TESTIMONIAL_SELECTORS.find((entry) =>
      entry.selector.includes('class*="testimonial"'),
    )
    expect(substringSelector).toBeDefined()
    expect(substringSelector?.sourceType).toBe('structured_component')
  })
})

describe('parseCandidates', () => {
  it('deduplicates a quote collected by two overlapping selectors', () => {
    const text = 'The flexibility of this program let me keep working full time while I studied.'

    const parsed = parseCandidates([
      candidate({ text, sourceType: 'structured_component', positionOnPage: 0 }),
      candidate({ text: `${text}!`, sourceType: 'hardcoded_text', positionOnPage: 1 }),
    ])

    expect(parsed).toHaveLength(1)
  })

  it('keeps the higher-priority selector when a quote matches twice', () => {
    const text = 'The flexibility of this program let me keep working full time while I studied.'

    const parsed = parseCandidates([
      candidate({ text, sourceType: 'structured_component' }),
      candidate({ text, sourceType: 'hardcoded_text' }),
    ])

    expect(parsed[0]?.sourceType).toBe('structured_component')
  })

  it('merges attribution across duplicate matches', () => {
    const text = 'The flexibility of this program let me keep working full time while I studied.'

    const parsed = parseCandidates([
      candidate({ text, nameHint: null, programHint: null }),
      candidate({ text, nameHint: 'Marcus Webb', programHint: 'Master of Science in Nursing' }),
    ])

    expect(parsed).toHaveLength(1)
    expect(parsed[0]?.studentName).toBe('Marcus Webb')
    expect(parsed[0]?.program).toBe('Master of Science in Nursing')
  })

  it('keeps genuinely distinct quotes separate', () => {
    const parsed = parseCandidates([
      candidate({ text: 'The flexibility of this program let me keep working full time.' }),
      candidate({ text: 'My advisor walked me through every single step of the application.' }),
    ])

    expect(parsed).toHaveLength(2)
  })
})
