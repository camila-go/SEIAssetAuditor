/**
 * Why an image has no perceptual hash.
 *
 * Duplicate detection and reverse image search can only see images that carry a
 * hash, so the honest measure of coverage is "hashed out of hashable" — not
 * "hashed out of every image row". Ten of Capella's 665 indexed images can
 * never be hashed: eight the host answers with 403, one is a 1x1 transparent
 * spacer, one is a path that now returns an HTML page. Reporting 655/665 made
 * a finished index look permanently incomplete and kept a "matching is
 * incomplete" notice on screen that no amount of work could clear.
 *
 * Recording the reason also stops the waste. Before this, a skipped image was
 * indistinguishable from an untried one, so every sweep re-downloaded the same
 * ten failures against a site we do not own.
 *
 * A skip is not permanent. It describes what the server did on the day it was
 * asked, and `RETRY_SKIP_AFTER_DAYS` brings each one back for another attempt —
 * a 403 that gets fixed should heal on its own.
 */
export const PHASH_SKIP_REASONS = {
  /** The host would not serve the bytes: 4xx, 5xx, or a redirect to one. */
  NOT_SERVED: 'not_served',
  /**
   * The server returned 200 but sent a web page, not an image. A soft 404 —
   * the asset is gone and the CMS answered with its own error page. Believing
   * the status code alone reports these as live.
   */
  NOT_AN_IMAGE: 'not_an_image',
  /**
   * A single flat colour, so both flattens are blank. A hash of it matches
   * every other blank image, which is worse than having none: spacers and
   * transparent pixels would be reported as duplicates of each other.
   */
  UNIFORM: 'uniform',
  /** Larger than the decoder is allowed to load into memory. */
  TOO_LARGE: 'too_large',
  /** Fetched, but the bytes could not be decoded as an image. */
  DECODE_FAILED: 'decode_failed',
  /** The request never completed — a timeout or a network error. */
  UNREACHABLE: 'unreachable',
} as const

export type PhashSkipReason = (typeof PHASH_SKIP_REASONS)[keyof typeof PHASH_SKIP_REASONS]

/**
 * How long a skipped image is left alone before being tried again.
 *
 * Long enough that a permanently unservable image is not re-fetched on every
 * sweep, short enough that a fixed permission or a restored file is picked up
 * without anyone intervening.
 */
export const RETRY_SKIP_AFTER_DAYS = 14

/** What to show a person, in place of the stored slug. */
export const PHASH_SKIP_LABELS: Record<PhashSkipReason, string> = {
  not_served: 'The site will not serve this file',
  not_an_image: 'That path now returns a web page, not an image',
  uniform: 'A single flat colour — nothing to match on',
  too_large: 'Too large to decode safely',
  decode_failed: 'The file could not be read as an image',
  unreachable: 'The request did not complete',
}

/**
 * Whether the reason says something about the file rather than the server.
 *
 * `unreachable` is the only one that carries no information about the asset —
 * it means the check itself failed — so it should not be presented as a
 * property of the image.
 */
export function isAssetLevelSkip(reason: PhashSkipReason): boolean {
  return reason !== PHASH_SKIP_REASONS.UNREACHABLE
}
