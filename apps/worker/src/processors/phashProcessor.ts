import type { Job } from 'bullmq'
import { assetRepo } from '@capella/db'
import type { PhashJobPayload } from '@capella/queue'
import { computePhashVariants } from '@capella/scraper'
import { config } from '../config.js'
import { logger } from '../lib/logger.js'

/**
 * Background perceptual hashing for duplicate detection.
 *
 * Never runs inline with scraping — each asset has to be downloaded and decoded.
 * One unreadable image never stops the sweep.
 */

const SWEEP_LIMIT = 200
const DOWNLOAD_TIMEOUT_MS = 30_000
/** Sharp will happily try to decode a huge file into memory; cap it first. */
const MAX_IMAGE_BYTES = 50 * 1024 * 1024

export async function processPhashJob(job: Job<PhashJobPayload>): Promise<void> {
  const assets = job.data.assetId
    ? [await assetRepo.findById(job.data.assetId)].filter((asset) => asset !== null)
    : await assetRepo.findNeedingPhash(SWEEP_LIMIT)

  if (assets.length === 0) {
    logger.debug('No assets need a pHash')
    return
  }

  let hashed = 0
  let skipped = 0

  for (const asset of assets) {
    try {
      const buffer = await downloadAsset(asset.aemPath)
      if (!buffer) {
        skipped++
        continue
      }

      // Two hashes for images with alpha — see computePhashVariants.
      const { phash, phashAlt } = await computePhashVariants(buffer)

      // Both blank means a uniform image, which nothing can usefully match.
      // Counting it as skipped keeps the coverage figure honest: it is exactly
      // the number of images reverse search can actually find.
      if (phash === null && phashAlt === null) {
        skipped++
        logger.warn({ aemPath: asset.aemPath }, 'Image is uniform — no usable pHash')
        continue
      }

      await assetRepo.setPhash(asset.id, phash, phashAlt)
      hashed++
    } catch (error) {
      // A corrupt or unsupported image is expected at DAM scale — log and move on.
      skipped++
      logger.warn({ err: error, aemPath: asset.aemPath }, 'Could not compute pHash')
    }
  }

  logger.info({ hashed, skipped, considered: assets.length }, 'pHash sweep complete')
}

/** Fetch an asset's bytes from the public host. Returns null if it isn't usable. */
async function downloadAsset(aemPath: string): Promise<Buffer | null> {
  const response = await fetch(`${config.aemPublicHost}${aemPath}`, {
    headers: { 'User-Agent': config.scraperUserAgent },
    signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
  })

  if (!response.ok) return null

  const contentType = response.headers.get('content-type') ?? ''
  if (!contentType.startsWith('image/')) return null

  const declaredLength = Number(response.headers.get('content-length') ?? 0)
  if (declaredLength > MAX_IMAGE_BYTES) return null

  const buffer = Buffer.from(await response.arrayBuffer())
  // Re-check: content-length may be absent or wrong.
  return buffer.byteLength <= MAX_IMAGE_BYTES ? buffer : null
}
