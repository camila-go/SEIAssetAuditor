import { parseSearchTerms } from '@capella/types'

export interface HighlightProps {
  text: string
  /** The raw search query. Empty renders the text unchanged. */
  query: string
}

/**
 * Mark the parts of `text` that caused this result to match.
 *
 * Splits the query with the same parser the database uses, so the highlighting
 * always agrees with the matching. Previously it matched the whole query as one
 * string: once search became term-based, "flexibility program" returned a
 * result with nothing highlighted at all — the user could see a hit but not why
 * it was one. Showing the match is part of the search working, not decoration.
 *
 * Terms are escaped before reaching RegExp, so a designer searching `C++` or
 * `(MSN)` cannot produce an invalid pattern.
 */
export function Highlight({ text, query }: HighlightProps): JSX.Element {
  const terms = parseSearchTerms(query)
  if (terms.length === 0) return <>{text}</>

  // Longest first: with "nurse" and "nursing" both present, the longer term
  // should win the overlap rather than leaving a stray fragment unmarked.
  const alternatives = [...terms]
    .sort((a, b) => b.length - a.length)
    .map((term) => {
      const escaped = escapeRegExp(term)
      // Short terms are almost always function words, and as bare substrings
      // they land in the middle of unrelated ones — searching "back to school"
      // highlighted the "to" inside "s(to)pped", which reads as a bug. Anchor
      // anything under three characters to a word boundary. Longer terms stay
      // unanchored so a partial like "flexib" still marks inside "flexibility".
      return term.length < 3 ? `\\b${escaped}\\b` : escaped
    })

  const pattern = new RegExp(`(${alternatives.join('|')})`, 'gi')

  const parts = text.split(pattern)

  return (
    <>
      {parts.map((part, index) =>
        // split() with one capture group puts matches at odd indices.
        index % 2 === 1 ? <mark key={index}>{part}</mark> : <span key={index}>{part}</span>,
      )}
    </>
  )
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
