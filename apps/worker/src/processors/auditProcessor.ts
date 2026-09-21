import type { Job } from 'bullmq'
import { assetRepo, auditJobRepo, pageRepo, prisma, testimonialRepo } from '@capella/db'
import { enqueueEmbedding, enqueuePhash, type AuditJobPayload } from '@capella/queue'
import { extractDegreeLevel, fingerprint, scrapeBatch } from '@capella/scraper'
import type { ScrapedPage, ScraperConfig } from '@capella/types'
import { config } from '../config.js'
import { logger } from '../lib/logger.js'

/**
 * Queue the follow-up sweeps that make newly-found assets searchable.
 *
 * An audit discovers assets; it does not fingerprint or embed them. Until this
 * ran, every audit left the index quietly behind — new images had no pHash, so
 * reverse image search and duplicate detection could not see them, and new rows
 * had no embedding, so meaning-based search could not either. Both were only
 * corrected by someone remembering to run `npm run crawl` by hand, and twice in
 * one session they were not: coverage sat at 9 of 58 images and 14 of 65 assets
 * without anything reporting a problem.
 *
 * Deliberately enqueued rather than run inline. `.claude/rules/backend.md`
 * requires pHash to stay off the scraping path, and it is right to: fingerprinting
 * downloads every image again, which has no business holding up an audit or
 * sharing its retry semantics.
 *
 * Failures here are logged and swallowed. The audit itself has already
 * succeeded and been marked complete; throwing now would fail a finished job,
 * BullMQ would retry the whole thing, and the sweeps are idempotent catch-ups
 * that the next audit — or a manual `npm run crawl` — would queue anyway.
 */
async function scheduleIndexing(jobId: string): Promise<void> {
  try {
    await enqueuePhash(config.redisUrl, {})
    await enqueueEmbedding(config.redisUrl, {})
    logger.info({ jobId }, 'Queued pHash and embedding sweeps for newly indexed assets')
  } catch (error) {
    logger.error(
      { err: error, jobId },
      'Could not queue the follow-up sweeps — new assets stay unfingerprinted until the next audit or `npm run crawl`',
    )
  }
}

/**
 * Audit job processor.
 *
 * Contract:
 *   - URLs are claimed from the DB in batches, so a crash resumes from the last
 *     completed batch rather than restarting the job.
 *   - One failed URL is recorded and skipped. It never aborts the batch or job.
 *   - Counters are written after every batch, so results are queryable live.
 */

const scraperConfig: ScraperConfig = {
  concurrency: config.scraperConcurrency,
  pageTimeoutMs: config.scraperPageTimeoutMs,
  userAgent: config.scraperUserAgent,
  politenessDelayMs: config.scraperPolitenessDelayMs,
  settleMs: config.scraperSettleMs,
}

export async function processAuditJob(job: Job<AuditJobPayload>): Promise<void> {
  const { jobId } = job.data
  const auditJob = await auditJobRepo.findById(jobId)

  if (!auditJob) {
    // The job row was deleted — nothing to do, and retrying won't help.
    logger.warn({ jobId }, 'Audit job no longer exists; dropping')
    return
  }

  if (auditJob.status === 'complete' || auditJob.status === 'cancelled') {
    logger.info({ jobId, status: auditJob.status }, 'Audit job already resolved; skipping')
    return
  }

  await auditJobRepo.markRunning(jobId)
  logger.info({ jobId, totalUrls: auditJob.totalUrls }, 'Audit job started')

  try {
    for (;;) {
      // Re-read each iteration so a cancel issued mid-job takes effect between batches.
      const current = await auditJobRepo.findById(jobId)
      if (current?.status === 'cancelled') {
        logger.info({ jobId }, 'Audit job cancelled; stopping')
        return
      }

      const batch = await auditJobRepo.claimPendingBatch(jobId, config.scraperBatchSize)
      if (batch.length === 0) break

      const outcomes = await scrapeBatch(
        batch.map((row) => row.url),
        scraperConfig,
      )

      const succeeded: Parameters<typeof auditJobRepo.recordBatchResults>[1] = []
      const failed: Parameters<typeof auditJobRepo.recordBatchResults>[2] = []

      for (const [index, outcome] of outcomes.entries()) {
        const row = batch[index]
        if (!row) continue

        if (!outcome || !outcome.ok) {
          failed.push({ id: row.id, error: outcome?.failure.error ?? 'Scrape produced no result' })
          continue
        }

        try {
          const counts = await persistScrapedPage(outcome.page)
          succeeded.push({
            id: row.id,
            pageTitle: outcome.page.title,
            isPublished: outcome.page.isPublished,
            ...counts,
          })
        } catch (error) {
          // A DB write failure for one page is still just one bad URL.
          failed.push({
            id: row.id,
            error: `Could not save results: ${error instanceof Error ? error.message : String(error)}`,
          })
        }
      }

      await auditJobRepo.recordBatchResults(jobId, succeeded, failed)

      await job.updateProgress({
        completed: succeeded.length,
        failed: failed.length,
        batchSize: batch.length,
      })

      logger.debug(
        { jobId, succeeded: succeeded.length, failed: failed.length },
        'Audit batch complete',
      )
    }

    await auditJobRepo.markComplete(jobId)
    logger.info({ jobId }, 'Audit job complete')

    await scheduleIndexing(jobId)
  } catch (error) {
    // Reaching here means something outside per-URL handling broke (Redis, the
    // browser, the DB). BullMQ retries; the pending rows are still pending.
    const message = error instanceof Error ? error.message : String(error)
    logger.error({ err: error, jobId }, 'Audit job failed')

    if (job.attemptsMade + 1 >= (job.opts.attempts ?? 1)) {
      await auditJobRepo.markFailed(jobId, message)
    }
    throw error
  }
}

/**
 * Persist one page's scrape: the Page row, its assets and testimonials, and the
 * reference rows linking them. Written in a transaction so a page is never left
 * with half its references.
 */
async function persistScrapedPage(
  page: ScrapedPage,
): Promise<{ assetCount: number; testimonialCount: number }> {
  const seenAt = new Date()

  return prisma.$transaction(
    async (tx) => {
      const pageRow = await pageRepo.upsertFromScrape(
        { url: page.url, title: page.title, isPublished: page.isPublished, crawledAt: seenAt },
        tx,
      )

      for (const assetPath of page.assetPaths) {
        const asset = await assetRepo.upsertFromScrape(assetPath, seenAt, tx)
        await pageRepo.linkAsset(asset.id, pageRow.id, tx)
      }

      for (const raw of page.testimonials) {
        const testimonial = await testimonialRepo.upsertByFingerprint(
          {
            quoteText: raw.quoteText,
            quoteFingerprint: fingerprint(raw.quoteText),
            studentName: raw.studentName,
            program: raw.program,
            degreeLevel: extractDegreeLevel(raw.program, raw.quoteText),
            sourceType: raw.sourceType,
            rawHtml: raw.rawHtml,
            seenAt,
          },
          tx,
        )
        await pageRepo.linkTestimonial(testimonial.id, pageRow.id, raw.positionOnPage, tx)
      }

      return { assetCount: page.assetPaths.length, testimonialCount: page.testimonials.length }
    },
    // A content-heavy page can carry a hundred assets; the default 5s is tight.
    { timeout: 30_000 },
  )
}
