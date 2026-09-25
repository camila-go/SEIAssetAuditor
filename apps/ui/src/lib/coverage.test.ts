import { outstandingFingerprints } from './coverage'

/**
 * The bug this replaced: coverage was measured as `hashed < total`, so the
 * tool showed "Only 655 of 665 indexed images have been fingerprinted" and a
 * "Fingerprint the rest" button permanently. The remaining ten cannot be
 * fingerprinted by anyone — the host 403s eight, one path returns a web page,
 * one is a 1x1 transparent spacer — so the button re-downloaded them and
 * changed nothing, and a finished index looked broken.
 */
describe('outstandingFingerprints', () => {
  it('is zero when every fingerprintable image is fingerprinted', () => {
    expect(
      outstandingFingerprints({ totalImages: 665, hashedImages: 655, unhashableImages: 10 }),
    ).toBe(0)
  })

  it('counts only images that could actually still be fingerprinted', () => {
    expect(
      outstandingFingerprints({ totalImages: 665, hashedImages: 600, unhashableImages: 10 }),
    ).toBe(55)
  })

  /**
   * A snapshot published before the tool recorded skip reasons has no such
   * field. That has to read as "none known" — the old behaviour — rather than
   * producing NaN and rendering an empty warning.
   */
  it('treats a missing unhashable count as zero', () => {
    expect(outstandingFingerprints({ totalImages: 665, hashedImages: 655 })).toBe(10)
  })

  it('never goes negative if the counts disagree', () => {
    expect(
      outstandingFingerprints({ totalImages: 10, hashedImages: 10, unhashableImages: 5 }),
    ).toBe(0)
  })

  it('is zero for an empty index rather than undefined', () => {
    expect(outstandingFingerprints({ totalImages: 0, hashedImages: 0, unhashableImages: 0 })).toBe(
      0,
    )
  })
})
