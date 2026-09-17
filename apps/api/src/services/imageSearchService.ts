import { isIP } from 'node:net'
import { lookup as dnsLookup } from 'node:dns/promises'
import { assetRepo, pageRepo } from '@capella/db'
import { bestDistance, computePhashVariants } from '@capella/scraper'
import { AppError, ERROR_CODES, type PageAppearance } from '@capella/types'
import { publicAssetUrl } from '../config.js'
import { toLiveStatus } from './auditService.js'
import { logger } from '../lib/logger.js'

/**
 * Reverse IMAGE search — "where is this picture used?", starting from the
 * picture rather than from its DAM path.
 *
 * Works in Phase 1 with no AEM credentials: DAM assets are publicly served, so
 * the pHash index is built by fetching them over HTTP like any browser would.
 *
 * Accuracy depends entirely on pHash coverage. An asset with no hash cannot
 * match, so every response reports coverage and the UI says so rather than
 * letting "no matches" read as "not in the DAM".
 */

export const MAX_IMAGE_BYTES = 25 * 1024 * 1024
const FETCH_TIMEOUT_MS = 20_000

/** Default Hamming distance ceiling. Hashes are 256-bit, so this is strict. */
export const DEFAULT_MATCH_THRESHOLD = 12
export const MAX_MATCH_THRESHOLD = 48

export const ACCEPTED_IMAGE_TYPES = [
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
  'image/avif',
  'image/tiff',
  'image/bmp',
  'image/svg+xml',
] as const

/**
 * How confident we are that two images are the same picture.
 *
 * Bands are expressed in bits of difference rather than a percentage because
 * that is what the distance actually measures. They are heuristics for
 * presentation — the raw distance is always returned alongside.
 */
export type MatchConfidence = 'exact' | 'near_identical' | 'very_similar' | 'similar'

export function confidenceFor(distance: number): MatchConfidence {
  if (distance === 0) return 'exact'
  if (distance <= 6) return 'near_identical'
  if (distance <= 12) return 'very_similar'
  return 'similar'
}

export interface ImageMatch {
  assetId: string
  aemPath: string
  filename: string
  publicUrl: string
  width: number | null
  height: number | null
  fileSize: number | null
  /** Bits that differ between the two perceptual hashes. 0 is identical. */
  distance: number
  /** 0–1, derived from distance over the hash length. */
  similarity: number
  confidence: MatchConfidence
  referenceCount: number
  pages: PageAppearance[]
}

export interface ImageSearchCoverage {
  /** Image assets in the index. */
  totalImages: number
  /** Image assets that have a pHash and can therefore be matched. */
  hashedImages: number
}

export interface ImageSearchResult {
  queryPhash: string
  threshold: number
  matches: ImageMatch[]
  coverage: ImageSearchCoverage
}

/**
 * Hash the supplied image and rank every indexed asset against it.
 *
 * `sharp` decodes the buffer, so an unreadable or non-image payload surfaces as
 * a validation error rather than a 500.
 */
export async function searchByImage(
  imageBuffer: Buffer,
  threshold = DEFAULT_MATCH_THRESHOLD,
): Promise<ImageSearchResult> {
  if (imageBuffer.byteLength === 0) {
    throw new AppError(ERROR_CODES.VALIDATION_FAILED, 'The uploaded image is empty')
  }

  let queryHashes: { phash: string | null; phashAlt: string | null }
  try {
    queryHashes = await computePhashVariants(imageBuffer)
  } catch (error) {
    logger.warn({ err: error }, 'Could not decode the uploaded image')
    throw new AppError(
      ERROR_CODES.UNSUPPORTED_MEDIA_TYPE,
      'That file could not be read as an image. Supported: JPEG, PNG, GIF, WebP, AVIF, TIFF, BMP, SVG.',
    )
  }

  // A uniform image (a blank square, or a white logo flattened onto white)
  // yields no usable hash. Matching on one would return the entire index.
  if (queryHashes.phash === null && queryHashes.phashAlt === null) {
    throw new AppError(
      ERROR_CODES.VALIDATION_FAILED,
      'That image is a single flat colour, so there is nothing to match it on. Try the original asset rather than a flattened export.',
    )
  }

  const bounded = Math.min(Math.max(threshold, 0), MAX_MATCH_THRESHOLD)
  const candidates = await assetRepo.findAllWithPhash()

  const queryVariants = [queryHashes.phash, queryHashes.phashAlt]

  const scored = candidates
    .map((asset) => ({
      asset,
      // Best pairing across both backgrounds, so a transparent logo still
      // matches its JPEG export whichever colour the transparency became.
      distance: bestDistance(queryVariants, [asset.phash, asset.phashAlt]),
    }))
    // Infinity means no comparable pair — e.g. hashes of different lengths from
    // an older row, not a genuinely distant image.
    .filter((entry) => Number.isFinite(entry.distance) && entry.distance <= bounded)
    .sort((a, b) => a.distance - b.distance)

  // Non-null by the guard above: at least one variant survived.
  const queryPhash = queryHashes.phash ?? queryHashes.phashAlt ?? ''
  const totalBits = queryPhash.length * 4

  const matches: ImageMatch[] = await Promise.all(
    scored.map(async ({ asset, distance }) => {
      const pages = await pageRepo.findPagesForAsset(asset.id)

      const appearances: PageAppearance[] = pages.map((page) => ({
        pageId: page.id,
        url: page.url,
        title: page.title,
        liveStatus: toLiveStatus(page.isPublished),
        lastCrawledAt: page.lastCrawledAt?.toISOString() ?? null,
        discoveredAt: page.discoveredAt.toISOString(),
      }))

      return {
        assetId: asset.id,
        aemPath: asset.aemPath,
        filename: asset.filename,
        publicUrl: publicAssetUrl(asset.aemPath),
        width: asset.width,
        height: asset.height,
        fileSize: asset.fileSize,
        distance,
        similarity: totalBits === 0 ? 0 : 1 - distance / totalBits,
        confidence: confidenceFor(distance),
        referenceCount: appearances.length,
        pages: appearances,
      }
    }),
  )

  return {
    queryPhash,
    threshold: bounded,
    matches,
    coverage: await getCoverage(),
  }
}

/**
 * How much of the image index is actually searchable.
 *
 * Surfaced on every search: with low coverage, "no matches" means "not indexed
 * yet", which is a completely different answer from "not in the DAM".
 */
export async function getCoverage(): Promise<ImageSearchCoverage> {
  const [totalImages, hashedImages] = await Promise.all([
    assetRepo.countImages(),
    assetRepo.countHashedImages(),
  ])
  return { totalImages, hashedImages }
}

/**
 * Fetch an image by URL so a designer can paste a link instead of saving the
 * file first.
 *
 * This makes the server issue a request to a user-supplied address, so the
 * destination is validated first: http(s) only, no credentials in the URL, and
 * the resolved address must be public. Redirects are not followed, because the
 * destination of a redirect would bypass that check.
 */
export async function fetchImageForSearch(rawUrl: string): Promise<Buffer> {
  const url = await assertPublicHttpUrl(rawUrl)

  let response: Response
  try {
    response = await fetch(url, {
      redirect: 'error',
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: { Accept: 'image/*' },
    })
  } catch (error) {
    throw new AppError(
      ERROR_CODES.VALIDATION_FAILED,
      `Could not fetch that image: ${error instanceof Error ? error.message : String(error)}`,
    )
  }

  if (!response.ok) {
    throw new AppError(
      ERROR_CODES.VALIDATION_FAILED,
      `The image URL returned HTTP ${response.status}`,
    )
  }

  const declared = Number(response.headers.get('content-length') ?? 0)
  if (declared > MAX_IMAGE_BYTES) {
    throw new AppError(ERROR_CODES.FILE_TOO_LARGE, 'That image is larger than 25MB')
  }

  const buffer = Buffer.from(await response.arrayBuffer())
  if (buffer.byteLength > MAX_IMAGE_BYTES) {
    throw new AppError(ERROR_CODES.FILE_TOO_LARGE, 'That image is larger than 25MB')
  }

  return buffer
}

/** Reject anything that is not a plainly public http(s) address. */
async function assertPublicHttpUrl(rawUrl: string): Promise<URL> {
  let url: URL
  try {
    url = new URL(rawUrl.trim())
  } catch {
    throw new AppError(ERROR_CODES.INVALID_URL, 'That is not a valid URL')
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new AppError(ERROR_CODES.INVALID_URL, 'Only http and https image URLs are supported')
  }

  if (url.username || url.password) {
    throw new AppError(ERROR_CODES.INVALID_URL, 'Image URLs must not contain credentials')
  }

  // Resolve first: a public-looking hostname can still point at a private
  // address, which is the usual way this kind of fetch gets abused.
  const addresses = isIP(url.hostname)
    ? [url.hostname]
    : await dnsLookup(url.hostname, { all: true })
        .then((entries) => entries.map((entry) => entry.address))
        .catch(() => {
          throw new AppError(ERROR_CODES.INVALID_URL, `Could not resolve ${url.hostname}`)
        })

  if (addresses.length === 0 || addresses.some(isPrivateAddress)) {
    throw new AppError(
      ERROR_CODES.INVALID_URL,
      'That URL resolves to a private address, which this tool will not fetch',
    )
  }

  return url
}

/** Loopback, link-local, and RFC1918 / unique-local ranges. */
export function isPrivateAddress(address: string): boolean {
  const version = isIP(address)
  if (version === 0) return true

  if (version === 4) {
    const parts = address.split('.').map(Number)
    const [a = 0, b = 0] = parts
    if (a === 10 || a === 127 || a === 0) return true
    if (a === 172 && b >= 16 && b <= 31) return true
    if (a === 192 && b === 168) return true
    if (a === 169 && b === 254) return true
    // Carrier-grade NAT
    if (a === 100 && b >= 64 && b <= 127) return true
    return false
  }

  const normalized = address.toLowerCase()
  if (normalized === '::' || normalized === '::1') return true
  // Unique local (fc00::/7) and link-local (fe80::/10)
  if (/^f[cd]/.test(normalized)) return true
  if (/^fe[89ab]/.test(normalized)) return true
  // IPv4-mapped IPv6 — re-check the embedded v4 address.
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(normalized)
  if (mapped?.[1]) return isPrivateAddress(mapped[1])

  return false
}
