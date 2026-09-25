/**
 * How the stored `lastVerifiedStatus` is to be read.
 *
 * The column holds an HTTP status, plus two sentinels for the cases HTTP has no
 * number for. Both exist because collapsing them into a real status would make
 * the tool state something the server never said.
 */

/**
 * The check itself never produced a status — DNS failure, timeout, connection
 * reset.
 *
 * Deliberately distinct from a 4xx. "We could not tell" is not the same claim
 * as "the server said this is gone", and reporting the two as one turns a flaky
 * network into a report of mass deletion.
 */
export const UNREACHABLE = 0

/**
 * The server answered 200, but sent a web page instead of the asset.
 *
 * A soft 404: the file is gone and the CMS is answering in its place. Capella
 * does this — one indexed favicon path returns 200 with 261KB of `text/html` —
 * so a status-only check files it as live indefinitely.
 *
 * Negative so it can never collide with a real status, and separate from
 * `UNREACHABLE` because this one is a finding about the asset, not about the
 * check.
 */
export const SOFT_404 = -1

export type VerificationVerdict = 'live' | 'missing' | 'replaced-by-page' | 'unknown'

/** Turn a stored status into the thing a person actually wants to know. */
export function verdictFor(status: number | null | undefined): VerificationVerdict {
  if (status === null || status === undefined) return 'unknown'
  if (status === SOFT_404) return 'replaced-by-page'
  if (status === UNREACHABLE) return 'unknown'
  if (status >= 200 && status < 400) return 'live'
  if (status >= 400) return 'missing'
  return 'unknown'
}

export const VERIFICATION_LABELS: Record<VerificationVerdict, string> = {
  live: 'Served',
  missing: 'No longer served',
  'replaced-by-page': 'Returns a web page, not the file',
  unknown: 'Could not be checked',
}
