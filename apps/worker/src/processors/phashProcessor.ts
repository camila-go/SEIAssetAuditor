import type { Job } from 'bullmq'
import { assetRepo } from '@capella/db'
import { enqueuePhashContinuation, type PhashJobPayload } from '@capella/queue'
import { computePhashVariants } from '@capella/scraper'
import { PHASH_SKIP_REASONS, type PhashSkipReason } from '@capella/types'
import { config } from '../config.js'
import { logger } from '../lib/logger.js'

/**
 * Background perceptual hashing for duplicate detection.
 *
 * Never runs inline with scraping — each asset has to be downloaded and decoded.
 * One unreadable image never stops the sweep.
 */

/**
 * How many images one sweep will attempt.
 *
 * This used to be 200 with no loop, so a sweep hashed 200 images and stopped —
 * and since a completed audit queues exactly one sweep, an index of 665 images
 * sat at 416 covered with the UI correctly reporting that matching was
 * incomplete and nothing ever finishing the job.
 *
 * The cap stays, because a single job that runs unbounded is worse: it holds a
 * worker slot for as long as the DAM is large. Instead the sweep now continues
 * itself while work remains, so each job is bounded and the whole index still
 * gets covered.
 *
 * Lowered from 200 rather than raised. The sweep that broke this queue died
 * with "job stalled more than allowable limit" — 200 downloads plus native
 * image decoding is long enough for BullMQ to give up on the job, and a stalled
 * sweep then poisoned the queue's job id. Shorter jobs, chained, keep each one
 * comfortably inside the stall window.
 */
const SWEEP_LIMIT = 100
const DOWNLOAD_TIMEOUT_MS = 30_000
/** Sharp will happily try to decode a huge file into memory; cap it first. */
const MAX_IMAGE_BYTES = 50 * 1024 * 1024

export async function processPhashJob(job: Job<PhashJobPayload>): Promise<void> {
  const isSingle = Boolean(job.data.assetId)

  const assets = isSingle
    ? [await assetRepo.findById(job.data.assetId as string)].filter((asset) => asset !== null)
    : await assetRepo.findNeedingPhash(SWEEP_LIMIT)

  if (assets.length === 0) {
    logger.debug('No assets need a pHash')
    return
  }

  let hashed = 0
  let skipped = 0

  for (const asset of assets) {
    // Every outcome is written to the row, not just the successful one. A
    // skipped image used to be left with two null hashes, which is exactly what
    // an untried image looks like — so the next sweep picked it up again, and
    // the one after that. The same ten unservable images were re-fetched on
    // every run and coverage could never reach 100%.
    try {
      const downloaded = await downloadAsset(asset.aemPath)
      if (downloaded.reason !== null) {
        await assetRepo.setPhashSkipped(asset.id, downloaded.reason)
        skipped++
        continue
      }

      // Two hashes for images with alpha — see computePhashVariants.
      const { phash, phashAlt } = await computePhashVariants(downloaded.buffer)

      // Both blank means a uniform image, which nothing can usefully match.
      // Counting it as skipped keeps the coverage figure honest: it is exactly
      // the number of images reverse search can actually find.
      if (phash === null && phashAlt === null) {
        await assetRepo.setPhashSkipped(asset.id, PHASH_SKIP_REASONS.UNIFORM)
        skipped++
        logger.warn({ aemPath: asset.aemPath }, 'Image is uniform — no usable pHash')
        continue
      }

      await assetRepo.setPhash(asset.id, phash, phashAlt)
      hashed++
    } catch (error) {
      // A corrupt or unsupported image is expected at DAM scale — record why
      // and move on. `computePhashVariants` throwing means sharp could not
      // decode what the host served, which is a fact about the file; a fetch
      // that never completed is a fact about the network, and the two are not
      // reported as the same thing.
      const reason = isAbortLike(error)
        ? PHASH_SKIP_REASONS.UNREACHABLE
        : PHASH_SKIP_REASONS.DECODE_FAILED

      await assetRepo.setPhashSkipped(asset.id, reason).catch(() => undefined)
      skipped++
      logger.warn({ err: error, aemPath: asset.aemPath, reason }, 'Could not compute pHash')
    }
  }

  logger.info({ hashed, skipped, considered: assets.length }, 'pHash sweep complete')

  // A full batch means more almost certainly remain. Continue rather than
  // leaving the index half-covered until someone notices the coverage notice.
  //
  // This used to also require `hashed > 0`, to stop a batch of permanently
  // unservable images queueing itself forever. That guard cost more than it
  // bought: one batch of 100 failures would abandon the sweep with thousands
  // still untried. It is no longer needed — every image considered here gets
  // `phashAttemptedAt` written whatever the outcome, so it drops out of the
  // next selection and the chain terminates on its own.
  if (!isSingle && assets.length === SWEEP_LIMIT) {
    try {
      await enqueuePhashContinuation(config.redisUrl)
      logger.info({ after: assets.length }, 'Queued a continuation sweep — more images remain')
    } catch (error) {
      logger.error(
        { err: error },
        'Could not queue the continuation sweep — coverage stays partial until the next audit',
      )
    }
  }
}

/**
 * Fetch an asset's bytes from the public host.
 *
 * Returns either the bytes or the reason there are none. It used to return
 * `null` for all four distinct failures, which is why the tool could report
 * that ten images were unhashed but never why.
 */
type Download =
  | { buffer: Buffer; reason: null }
  | { buffer: null; reason: PhashSkipReason }

async function downloadAsset(aemPath: string): Promise<Download> {
  const response = await fetch(`${config.aemPublicHost}${aemPath}`, {
    headers: { 'User-Agent': config.scraperUserAgent },
    signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
  })

  if (!response.ok) return { buffer: null, reason: PHASH_SKIP_REASONS.NOT_SERVED }

  // A 200 is not a promise that the body is the asset. Capella answers some
  // dead DAM paths with its own 200 HTML error page — `apple-icon-120x120-
  // precomposed.png` returns 261KB of `text/html` — so trusting the status
  // alone both fails to hash and reports the asset as live.
  const contentType = response.headers.get('content-type') ?? ''
  if (!contentType.startsWith('image/')) {
    return { buffer: null, reason: PHASH_SKIP_REASONS.NOT_AN_IMAGE }
  }

  const declaredLength = Number(response.headers.get('content-length') ?? 0)
  if (declaredLength > MAX_IMAGE_BYTES) {
    return { buffer: null, reason: PHASH_SKIP_REASONS.TOO_LARGE }
  }

  const buffer = Buffer.from(await response.arrayBuffer())
  // Re-check: content-length may be absent or wrong.
  return buffer.byteLength <= MAX_IMAGE_BYTES
    ? { buffer, reason: null }
    : { buffer: null, reason: PHASH_SKIP_REASONS.TOO_LARGE }
}

/** A timeout or network failure, as opposed to bytes that would not decode. */
function isAbortLike(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  return error.name === 'AbortError' || error.name === 'TimeoutError' || error.name === 'TypeError'
}
