import { parseSearchTerms } from './search.js'

/**
 * These lock in the behaviour that was measured broken against real data:
 * every one of these queries returned zero results before the fix, despite
 * matching content being present.
 */
describe('parseSearchTerms', () => {
  it('splits on whitespace', () => {
    expect(parseSearchTerms('flexibility program')).toEqual(['flexibility', 'program'])
  })

  it('splits on the separators that appear inside filenames', () => {
    // capella_logo_horizontal_RGB.svg — a designer types "capella logo".
    expect(parseSearchTerms('capella_logo')).toEqual(['capella', 'logo'])
    expect(parseSearchTerms('cu-brand-campaign')).toEqual(['cu', 'brand', 'campaign'])
    expect(parseSearchTerms('/content/dam/capella')).toEqual(['content', 'dam', 'capella'])
  })

  it('lowercases, so matching is case-insensitive downstream', () => {
    expect(parseSearchTerms('Capella LOGO')).toEqual(['capella', 'logo'])
  })

  it('keeps a quoted phrase whole, which is how adjacency is requested', () => {
    expect(parseSearchTerms('"working full time"')).toEqual(['working full time'])
  })

  it('handles a quoted phrase alongside loose terms', () => {
    expect(parseSearchTerms('"full time" nursing')).toEqual(['full time', 'nursing'])
  })

  it('drops one-character noise that would match nearly everything', () => {
    expect(parseSearchTerms('a logo')).toEqual(['logo'])
  })

  it('de-duplicates repeated terms', () => {
    expect(parseSearchTerms('logo logo LOGO')).toEqual(['logo'])
  })

  it('returns nothing for an empty or separator-only query', () => {
    expect(parseSearchTerms('')).toEqual([])
    expect(parseSearchTerms('   ')).toEqual([])
    expect(parseSearchTerms('___---')).toEqual([])
  })

  it('does not split inside a word, so infix matching still works', () => {
    // "dog" must still find hero_browsinglaptopdog_320x181.jpg.
    expect(parseSearchTerms('dog')).toEqual(['dog'])
  })
})

/**
 * The search results and the highlighting must split the query identically.
 * When they diverged, a multi-word query returned a correct hit with nothing
 * marked — the user saw a result and could not tell why it matched.
 */
describe('matching and highlighting agree', () => {
  it.each([
    ['flexibility program', ['flexibility', 'program']],
    ['capella logo', ['capella', 'logo']],
    ['capella_logo', ['capella', 'logo']],
    ['full time working', ['full', 'time', 'working']],
    ['online degrees', ['online', 'degrees']],
  ])('%s yields the terms both sides use', (query, expected) => {
    expect(parseSearchTerms(query)).toEqual(expected)
  })

  it('yields no terms when there is nothing to highlight', () => {
    // <Highlight> renders the text untouched in this case rather than marking
    // everything, which is what an empty pattern would do.
    expect(parseSearchTerms('')).toEqual([])
  })
})

/**
 * Short terms are function words. As bare substrings they mark the middle of
 * unrelated words — "back to school" highlighted the "to" inside "stopped" —
 * so <Highlight> anchors anything under three characters to a word boundary.
 * These assert the term list that behaviour keys off.
 */
describe('short terms', () => {
  it('keeps two-character words as terms', () => {
    // They still matter for matching; it is only the highlight that anchors.
    expect(parseSearchTerms('back to school')).toEqual(['back', 'to', 'school'])
  })

  it('drops single characters entirely', () => {
    expect(parseSearchTerms('a b school')).toEqual(['school'])
  })

  it('keeps three-character terms, which must still match inside a word', () => {
    // "dog" has to keep finding hero_browsinglaptopdog.jpg.
    expect(parseSearchTerms('dog')).toEqual(['dog'])
  })
})
