import type { AuditInputType, AuditJob, AuditJobUrl, Prisma } from '@prisma/client'
import { prisma } from '../client.js'

export interface CreateAuditJobInput {
  name: string
  inputType: AuditInputType
  urls: string[]
  createdBy: string | null
}

/**
 * Creates the job and one AuditJobUrl row per URL in a single transaction.
 * The URL rows are the unit of resumability — the worker claims `pending` rows,
 * so a crash mid-job resumes from whatever was not yet marked done or failed.
 */
export async function create(input: CreateAuditJobInput): Promise<AuditJob> {
  // De-duplicate up front: the (jobId, url) unique constraint would otherwise
  // reject the whole createMany batch.
  const uniqueUrls = [...new Set(input.urls)]

  return prisma.$transaction(async (tx) => {
    const job = await tx.auditJob.create({
      data: {
        name: input.name,
        inputType: input.inputType,
        status: 'queued',
        totalUrls: uniqueUrls.length,
        createdBy: input.createdBy,
      },
    })

    // Chunked so a 10k-URL sitemap doesn't build one enormous INSERT.
    const CHUNK = 1_000
    for (let i = 0; i < uniqueUrls.length; i += CHUNK) {
      await tx.auditJobUrl.createMany({
        data: uniqueUrls.slice(i, i + CHUNK).map((url) => ({ jobId: job.id, url })),
      })
    }

    return job
  })
}

export async function findById(id: string): Promise<AuditJob | null> {
  return prisma.auditJob.findUnique({ where: { id } })
}

export async function markRunning(id: string): Promise<void> {
  await prisma.auditJob.update({
    where: { id },
    data: { status: 'running', startedAt: new Date() },
  })
}

export async function markComplete(id: string): Promise<void> {
  await prisma.auditJob.update({
    where: { id },
    data: { status: 'complete', completedAt: new Date() },
  })
}

export async function markFailed(id: string, errorMessage: string): Promise<void> {
  await prisma.auditJob.update({
    where: { id },
    data: { status: 'failed', completedAt: new Date(), errorMessage },
  })
}

export async function markCancelled(id: string): Promise<void> {
  await prisma.auditJob.update({
    where: { id },
    data: { status: 'cancelled', completedAt: new Date() },
  })
}

/**
 * The next batch of unprocessed URLs. Ordering by id keeps batches stable
 * across a resume so we don't reprocess rows.
 */
export async function claimPendingBatch(jobId: string, batchSize: number): Promise<AuditJobUrl[]> {
  return prisma.auditJobUrl.findMany({
    where: { jobId, status: 'pending' },
    take: batchSize,
    orderBy: { id: 'asc' },
  })
}

export interface UrlResult {
  id: string
  pageTitle: string | null
  isPublished: boolean | null
  assetCount: number
  testimonialCount: number
}

/**
 * Records the outcome of one batch and advances the job counters atomically.
 * Counters are recomputed from the URL rows rather than incremented, so a
 * replayed batch after a crash can never double-count.
 */
export async function recordBatchResults(
  jobId: string,
  succeeded: UrlResult[],
  failed: Array<{ id: string; error: string }>,
): Promise<void> {
  const processedAt = new Date()

  await prisma.$transaction(async (tx) => {
    for (const result of succeeded) {
      await tx.auditJobUrl.update({
        where: { id: result.id },
        data: {
          status: 'done',
          processedAt,
          pageTitle: result.pageTitle,
          isPublished: result.isPublished,
          assetCount: result.assetCount,
          testimonialCount: result.testimonialCount,
        },
      })
    }

    for (const failure of failed) {
      await tx.auditJobUrl.update({
        where: { id: failure.id },
        // Truncated: a Playwright stack trace can be enormous and the UI only
        // shows the first line in the failed-URLs panel.
        data: { status: 'failed', processedAt, error: failure.error.slice(0, 1_000) },
      })
    }

    const [completed, failedCount] = await Promise.all([
      tx.auditJobUrl.count({ where: { jobId, status: 'done' } }),
      tx.auditJobUrl.count({ where: { jobId, status: 'failed' } }),
    ])

    await tx.auditJob.update({
      where: { id: jobId },
      data: { completedUrls: completed, failedUrls: failedCount },
    })
  })
}

export interface ResultFilters {
  urlStatus?: 'pending' | 'done' | 'failed'
  liveStatus?: 'published' | 'draft' | 'unknown'
  offset: number
  limit: number
}

export async function findResults(
  jobId: string,
  filters: ResultFilters,
): Promise<{ rows: AuditJobUrl[]; total: number }> {
  const where: Prisma.AuditJobUrlWhereInput = { jobId }

  if (filters.urlStatus) where.status = filters.urlStatus
  if (filters.liveStatus === 'published') where.isPublished = true
  if (filters.liveStatus === 'draft') where.isPublished = false
  if (filters.liveStatus === 'unknown') where.isPublished = null

  const [rows, total] = await prisma.$transaction([
    prisma.auditJobUrl.findMany({
      where,
      orderBy: [{ processedAt: 'desc' }, { id: 'asc' }],
      skip: filters.offset,
      take: filters.limit,
    }),
    prisma.auditJobUrl.count({ where }),
  ])

  return { rows, total }
}

/** Every failed URL with its error — the collapsible panel at the bottom of the results view. */
export async function findFailures(jobId: string): Promise<AuditJobUrl[]> {
  return prisma.auditJobUrl.findMany({
    where: { jobId, status: 'failed' },
    orderBy: { processedAt: 'asc' },
  })
}

/** Unbounded — used only by the CSV export stream, never by a JSON route. */
export async function streamAllResults(jobId: string): Promise<AuditJobUrl[]> {
  return prisma.auditJobUrl.findMany({ where: { jobId }, orderBy: { id: 'asc' } })
}

export async function findRecent(limit: number): Promise<AuditJob[]> {
  return prisma.auditJob.findMany({ orderBy: { createdAt: 'desc' }, take: limit })
}
