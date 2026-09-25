import type { ImageSearchCoverage } from '../api/queries'

/**
 * Images that could be fingerprinted but have not been yet.
 *
 * The one number that means "running the sweep would help". Anywhere that
 * hedges a result because the index is incomplete must use this rather than
 * `hashed < total`, or it hedges forever over images that will never hash.
 *
 * That is not hypothetical. Measuring `hashed < total` kept "Only 655 of 665
 * indexed images have been fingerprinted" on screen permanently, with a button
 * that re-downloaded the missing ten and changed nothing. The host 403s eight
 * of them, one path returns a web page, and one is a 1x1 transparent spacer.
 */
export function outstandingFingerprints(coverage: ImageSearchCoverage): number {
  const hashable = Math.max(coverage.totalImages - (coverage.unhashableImages ?? 0), 0)
  return Math.max(hashable - coverage.hashedImages, 0)
}
