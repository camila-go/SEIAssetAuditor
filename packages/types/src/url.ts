/**
 * What counts as a page address.
 *
 * Shared deliberately. The UI counts "N URLs detected" before submitting and
 * the API decides what actually gets queued; when those were two
 * implementations they disagreed — a paste of five filenames and one URL read
 * as "6 URLs detected" and produced a job of one. Same reasoning as
 * `parseSearchTerms`: one rule, one place, so the preview and the result
 * cannot drift.
 */

/** Anything of the form `scheme:` at the start — not just http. */
const HAS_SCHEME = /^[a-z][a-z0-9+.-]*:/i
/** A bare host: no whitespace, and at least one dot with a plausible TLD. */
const LOOKS_LIKE_HOST = /^[^\s/]+\.[a-z]{2,}(?:[:/?#]|$)/i

/**
 * Endings that mean "file", not "host".
 *
 * `LOOKS_LIKE_HOST` only asks for a dot followed by two or more letters, which
 * `capella.edu` and `kristen_moris.jpg` satisfy equally well. A column of
 * filenames pasted from a DAM export therefore became
 * `https://kristen_moris.jpg/` and was queued, and the only feedback was a
 * Playwright `ERR_NAME_NOT_RESOLVED` per row — a DNS error that says nothing
 * about the actual mistake.
 *
 * Only the host portion is tested, so `example.com/photo.jpg` is untouched and
 * an explicit `https://example.com/photo.jpg` never reaches here at all.
 */
const FILE_EXTENSION =
  /\.(jpe?g|png|gif|webp|avif|svg|bmp|tiff?|ico|pdf|docx?|xlsx?|pptx?|csv|txt|zip|mp[34]|mov|avi|webm|wav|json|xml|ya?ml)$/i

/** Everything before the first `/`, `?` or `#` — the host, in a bare reference. */
function hostPart(value: string): string {
  return value.split(/[/?#]/)[0] ?? value
}

/**
 * Normalize one URL, or return null if it isn't a page address.
 *
 * Bare hosts get `https://` assumed, but only when they actually look like a
 * host. Prefixing unconditionally is a trap: it turns `ftp://example.com` into
 * `https://ftp//example.com` and a CSV header cell like `title` into
 * `https://title/` — both of which then get queued and scraped.
 */
export function normalizeUrl(value: string): string | null {
  const trimmed = value.trim()
  if (!trimmed) return null

  // An explicit scheme is honoured as written, so a non-http one is rejected
  // rather than rewritten.
  let candidate: string | null
  if (HAS_SCHEME.test(trimmed)) {
    candidate = trimmed
  } else if (LOOKS_LIKE_HOST.test(trimmed) && !FILE_EXTENSION.test(hostPart(trimmed))) {
    candidate = `https://${trimmed}`
  } else {
    candidate = null
  }

  if (candidate === null) return null

  try {
    const url = new URL(candidate)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
    if (!url.hostname.includes('.')) return null
    // A fragment identifies a position within a page, not a distinct page.
    url.hash = ''
    return url.toString()
  } catch {
    return null
  }
}
