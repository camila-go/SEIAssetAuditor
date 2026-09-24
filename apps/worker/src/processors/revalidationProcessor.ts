import type { Job } from 'bullmq'
import { assetRepo } from '@capella/db'
import { enqueueRevalidation, type RevalidationJobPayload } from '@capella/queue'
import { config } from '../config.js'
import { logger } from '../lib/logger.js'

/**
 * Scheduled link-rot check: are the assets we claim are on the site still served?
 *
 * An audit records what a page referenced at the moment it was read. Nothing
 * after that tells the tool an asset was deleted, renamed, or unpublished — so
 * without this, "appears on 3 pages" keeps being reported with full confidence
 * for as long as nobody happens to re-audit those pages. That is the same
 * failure this tool keeps finding in itself: a confident answer built on a
 * stale input.
 *
 * Runs every three days rather than on demand, because link rot is slow and
 * checking is polite-but-real traffic against a site we do not own.
 */

/** Per job, so a run is bounded and cannot stall. Chained while work remains. */
const BATCH = 150

/** How current a check has to be to be left alone. Matches the schedule. */
const STALE_AFTER_DAYS = 3

/** HEAD is enough to answer "is it served?" and transfers no body. */
const REQUEST_TIMEOUT_MS = 15_000

/** Small pause between requests — this is someone else's production site. */
const POLITENESS_DELAY_MS = 50

export async function processRevalidationJob(job: Job<RevalidationJobPayload>): Promise<void> {
  const force = job.data.force === true
  const staleBefore = new Date(Date.now() - STALE_AFTER_DAYS * 24 * 60 * 60 * 1000)

  const due = await assetRepo.findNeedingVerification(staleBefore, BATCH, force)
  if (due.length === 0) {
    logger.info('Asset revalidation: nothing due')
    return
  }

  const checkedAt = new Date()
  let live = 0
  let missing = 0
  let unreachable = 0

  for (const asset of due) {
    const status = await checkStatus(asset.aemPath)

    if (status >= 200 && status < 400) live++
    else if (status >= 400) {
      missing++
      // Worth a line each: this is the actual finding, not noise.
      logger.warn({ aemPath: asset.aemPath, status }, 'Asset is no longer served')
    } else unreachable++

    await assetRepo.recordVerification(asset.id, status, checkedAt)
    await sleep(POLITENESS_DELAY_MS)
  }

  logger.info(
    { considered: due.length, live, missing, unreachable },
    'Asset revalidation batch complete',
  )

  // Continue while a full batch came back, the same chaining the pHash sweep
  // uses. Unlike that one this cannot loop forever: every row is written with a
  // fresh `lastVerifiedAt` whatever the outcome, so it stops being due.
  if (due.length === BATCH) {
    try {
      await enqueueRevalidation(config.redisUrl, force ? { force } : {})
    } catch (error) {
      logger.error({ err: error }, 'Could not queue the next revalidation batch')
    }
  }
}

/**
 * The HTTP status, or 0 when the request never produced one.
 *
 * 0 is deliberately distinct from a 4xx. A DNS failure or a timeout means "we
 * could not tell", which is not the same claim as "the server said this is
 * gone", and reporting the two as one would turn a flaky network into a report
 * of mass deletion.
 */
async function checkStatus(aemPath: string): Promise<number> {
  const url = `${config.aemPublicHost}${aemPath}`

  try {
    const response = await fetch(url, {
      method: 'HEAD',
      redirect: 'follow',
      headers: { 'User-Agent': config.scraperUserAgent },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
    return response.status
  } catch {
    return 0
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
