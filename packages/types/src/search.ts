/**
 * Query parsing, shared by the database layer and the UI.
 *
 * It lives in `types` because both sides must agree exactly: the repository
 * splits the query into terms to decide what matches, and `<Highlight>` splits
 * it the same way to show which words caused the match. Two implementations
 * would drift, and the symptom would be a result with nothing highlighted —
 * the user sees a hit and cannot tell why.
 *
 * Pure string logic, no dependencies.
 */

/** Separators that appear inside filenames and paths but not inside words. */
const SEPARATORS = /[\s_\-./\\:]+/

/** A single character would match nearly everything, so it is dropped. */
const MIN_TERM_LENGTH = 2

/**
 * Split a query into searchable terms.
 *
 * Separators are treated as whitespace, so "capella logo", "capella_logo" and
 * "capella-logo" all yield the same two terms. A "quoted phrase" is kept whole,
 * which is the one way to ask for adjacency back.
 */
export function parseSearchTerms(raw: string): string[] {
  const terms: string[] = []

  // Quoted phrases first, so their internal spaces survive the split below.
  const remainder = raw.replace(/"([^"]+)"/g, (_match, phrase: string) => {
    const trimmed = phrase.trim()
    if (trimmed.length >= MIN_TERM_LENGTH) terms.push(trimmed)
    return ' '
  })

  for (const token of remainder.split(SEPARATORS)) {
    const trimmed = token.trim()
    if (trimmed.length >= MIN_TERM_LENGTH) terms.push(trimmed)
  }

  // Repeating a term only costs a redundant predicate.
  return [...new Set(terms.map((term) => term.toLowerCase()))]
}
