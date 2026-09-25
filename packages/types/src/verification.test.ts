import { SOFT_404, UNREACHABLE, verdictFor } from './verification.js'

/**
 * The distinctions here are the whole point of the sentinels. Collapsing any
 * two of them makes the tool state something the server never said, and each
 * collapse has a specific failure that has already happened once.
 */
describe('verdictFor', () => {
  it('treats a normal 200 as served', () => {
    expect(verdictFor(200)).toBe('live')
  })

  it('treats a redirect as served — the file is still reachable', () => {
    expect(verdictFor(301)).toBe('live')
    expect(verdictFor(302)).toBe('live')
  })

  it('treats 4xx and 5xx as no longer served', () => {
    expect(verdictFor(403)).toBe('missing')
    expect(verdictFor(404)).toBe('missing')
    expect(verdictFor(500)).toBe('missing')
  })

  /**
   * The soft 404. `apple-icon-120x120-precomposed.png` answers 200 with 261KB
   * of `text/html`, and reading the status alone filed it as live forever.
   */
  it('separates a page served in place of the file from a real 200', () => {
    expect(verdictFor(SOFT_404)).toBe('replaced-by-page')
    expect(verdictFor(SOFT_404)).not.toBe('live')
  })

  /**
   * A timeout is not evidence of deletion. Folding it into `missing` turns a
   * flaky network into a report that the whole DAM has been emptied.
   */
  it('does not report an unreachable asset as missing', () => {
    expect(verdictFor(UNREACHABLE)).toBe('unknown')
    expect(verdictFor(UNREACHABLE)).not.toBe('missing')
  })

  it('reports a never-checked asset as unknown, not as live', () => {
    expect(verdictFor(null)).toBe('unknown')
    expect(verdictFor(undefined)).toBe('unknown')
  })
})
