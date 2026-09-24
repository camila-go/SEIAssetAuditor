import { auditJobRepo } from '@capella/db'
import { enqueueAudit, removeAuditJob } from '@capella/queue'
import { fetchSitemapUrls } from '@capella/scraper'
import {
  AppError,
  ERROR_CODES,
  type AuditInputType,
  type AuditJobStatusResponse,
  type AuditResultRow,
  type LiveStatus,
  normalizeUrl,
} from '@capella/types'
import { config } from '../config.js'

// Re-exported: the URL rules moved to @capella/types so the UI shares them,
// but this stays the import site everything here already uses.
export { normalizeUrl }

/**
 * Audit orchestration. The API's only job here is to turn input into
 * AuditJobUrl rows and enqueue — no page is ever fetched in a request.
 */

/** Average seconds per page, used only for the "time remaining" estimate. */
const SECONDS_PER_PAGE = 4

export interface CreateAuditInput {
  name?: string
  inputType: AuditInputType
  /** Raw text for `paste`, file contents for `csv_upload`, a URL for `sitemap`. */
  rawInput: string
  createdBy: string | null
}

export interface CreateAuditResult {
  jobId: string
  status: 'queued'
  totalUrls: number
  /**
   * Input lines that are not page addresses, verbatim and capped.
   *
   * Dropping them silently is the failure this tool exists to avoid: paste
   * three URLs and five filenames and you would get a job for three, with
   * nothing saying the other five were ignored. Returned so the UI can name
   * them back.
   */
  skipped: string[]
}

/** Enough to recognise the mistake without turning the response into the input. */
const MAX_REPORTED_SKIPS = 25

export async function createAudit(input: CreateAuditInput): Promise<CreateAuditResult> {
  const { urls, skipped } = await resolveUrls(input.inputType, input.rawInput)

  if (urls.length === 0) {
    // Name what was rejected. "No valid URLs" against a list that plainly looks
    // like a list is the least useful thing this could say.
    const examples = skipped.slice(0, 3).join(', ')
    throw new AppError(
      ERROR_CODES.NO_URLS_PROVIDED,
      skipped.length > 0
        ? `No valid URLs found. ${skipped.length} line${skipped.length === 1 ? '' : 's'} could not be read as a web address${examples ? ` — for example: ${examples}` : ''}. Filenames and DAM paths are not page URLs; paste the page each one appears on instead.`
        : 'No valid URLs found. Provide at least one http(s) URL.',
    )
  }

  const job = await auditJobRepo.create({
    name: input.name?.trim() || defaultJobName(input.inputType, urls.length),
    inputType: input.inputType,
    urls,
    createdBy: input.createdBy,
  })

  try {
    await enqueueAudit(config.redisUrl, { jobId: job.id })
  } catch (error) {
    // The rows exist but nothing will process them — say so rather than
    // handing back a job id that silently never starts.
    await auditJobRepo.markFailed(
      job.id,
      'Could not enqueue the job — the Redis queue is unreachable.',
    )
    throw new AppError(
      ERROR_CODES.INTERNAL_ERROR,
      `Audit could not be queued: ${error instanceof Error ? error.message : String(error)}`,
    )
  }

  return {
    jobId: job.id,
    status: 'queued',
    totalUrls: job.totalUrls,
    skipped: skipped.slice(0, MAX_REPORTED_SKIPS),
  }
}

export interface ParsedUrls {
  urls: string[]
  /** Input that is not a page address, in the order it appeared. */
  skipped: string[]
}

async function resolveUrls(inputType: AuditInputType, rawInput: string): Promise<ParsedUrls> {
  switch (inputType) {
    case 'paste':
      return parseUrlList(rawInput)
    case 'csv_upload':
      return parseCsvUrls(rawInput)
    case 'sitemap': {
      const sitemapUrl = normalizeUrl(rawInput.trim())
      if (!sitemapUrl) {
        throw new AppError(ERROR_CODES.INVALID_URL, 'Sitemap URL is not a valid http(s) URL')
      }
      // A sitemap is machine-generated: an entry that does not parse is the
      // site's problem, not a user typo, so it is not reported back as a typo.
      const urls = await fetchSitemapUrls(sitemapUrl, config.scraper.userAgent)
      return {
        urls: [...new Set(urls.map(normalizeUrl).filter((url): url is string => url !== null))],
        skipped: [],
      }
    }
  }
}

/** One URL per line. Blank lines and `#` comments are ignored. */
export function parseUrlList(raw: string): ParsedUrls {
  const urls: string[] = []
  const skipped: string[] = []

  for (const line of raw.split(/[\r\n]+/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue

    const normalized = normalizeUrl(trimmed)
    if (normalized) urls.push(normalized)
    else skipped.push(trimmed)
  }

  return { urls: [...new Set(urls)], skipped }
}

/**
 * URLs from the first column of a CSV/TXT.
 *
 * Deliberately lenient: these files are exported from spreadsheets by hand, so
 * we take the first cell that parses as a URL rather than requiring a header or
 * a strict column position. A header row simply yields no URL and is skipped.
 */
export function parseCsvUrls(raw: string): ParsedUrls {
  const urls: string[] = []
  const skipped: string[] = []

  for (const line of raw.split(/[\r\n]+/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue

    let found = false
    for (const cell of splitCsvLine(trimmed)) {
      const normalized = normalizeUrl(cell.trim().replace(/^"|"$/g, ''))
      if (normalized) {
        urls.push(normalized)
        found = true
        break
      }
    }

    // No cell on this row was a URL. Report the row, not each cell — a DAM
    // export has many columns and naming them all would bury the point.
    if (!found) skipped.push(trimmed)
  }

  return { urls: [...new Set(urls)], skipped }
}

/** Split on commas that are not inside double quotes. */
function splitCsvLine(line: string): string[] {
  const cells: string[] = []
  let current = ''
  let inQuotes = false

  for (const char of line) {
    if (char === '"') {
      inQuotes = !inQuotes
      continue
    }
    if (char === ',' && !inQuotes) {
      cells.push(current)
      current = ''
      continue
    }
    current += char
  }
  cells.push(current)

  return cells
}

function defaultJobName(inputType: AuditInputType, count: number): string {
  const label = { paste: 'Pasted URLs', csv_upload: 'CSV upload', sitemap: 'Sitemap import' }[
    inputType
  ]
  return `${label} — ${count} URL${count === 1 ? '' : 's'} — ${new Date().toISOString().slice(0, 10)}`
}

// ─── Status & results ────────────────────────────────────────────────────────

export async function getStatus(jobId: string): Promise<AuditJobStatusResponse> {
  const job = await auditJobRepo.findById(jobId)
  if (!job) throw new AppError(ERROR_CODES.JOB_NOT_FOUND, `No audit job with id ${jobId}`)

  const processed = job.completedUrls + job.failedUrls
  const percentComplete =
    job.totalUrls === 0 ? 0 : Math.min(100, Math.round((processed / job.totalUrls) * 100))

  return {
    jobId: job.id,
    status: job.status,
    totalUrls: job.totalUrls,
    completedUrls: job.completedUrls,
    failedUrls: job.failedUrls,
    percentComplete,
    estimatedMinutesRemaining: estimateRemaining(job.status, job.totalUrls, processed),
    startedAt: job.startedAt?.toISOString() ?? null,
    completedAt: job.completedAt?.toISOString() ?? null,
    errorMessage: job.errorMessage,
  }
}

/**
 * Wall-clock estimate from the configured concurrency. Intentionally simple —
 * it drives a "~12 minutes remaining" label, not scheduling.
 */
function estimateRemaining(
  status: string,
  totalUrls: number,
  processed: number,
): number | null {
  if (status !== 'running' && status !== 'queued') return null

  const remaining = Math.max(0, totalUrls - processed)
  if (remaining === 0) return 0

  const seconds = (remaining * SECONDS_PER_PAGE) / Math.max(1, config.scraper.concurrency)
  return Math.max(1, Math.ceil(seconds / 60))
}

export interface GetResultsParams {
  jobId: string
  urlStatus?: 'pending' | 'done' | 'failed'
  liveStatus?: LiveStatus
  offset: number
  limit: number
}

export async function getResults(
  params: GetResultsParams,
): Promise<{ rows: AuditResultRow[]; total: number }> {
  const job = await auditJobRepo.findById(params.jobId)
  if (!job) throw new AppError(ERROR_CODES.JOB_NOT_FOUND, `No audit job with id ${params.jobId}`)

  const { rows, total } = await auditJobRepo.findResults(params.jobId, {
    ...(params.urlStatus ? { urlStatus: params.urlStatus } : {}),
    ...(params.liveStatus ? { liveStatus: params.liveStatus } : {}),
    offset: params.offset,
    limit: params.limit,
  })

  return {
    rows: rows.map((row) => ({
      url: row.url,
      pageTitle: row.pageTitle,
      liveStatus: toLiveStatus(row.isPublished),
      urlStatus: row.status,
      assetCount: row.assetCount,
      testimonialCount: row.testimonialCount,
      processedAt: row.processedAt?.toISOString() ?? null,
      error: row.error,
    })),
    total,
  }
}

export function toLiveStatus(isPublished: boolean | null): LiveStatus {
  if (isPublished === true) return 'published'
  if (isPublished === false) return 'draft'
  return 'unknown'
}

export async function getFailures(
  jobId: string,
): Promise<Array<{ url: string; error: string | null; processedAt: string | null }>> {
  const failures = await auditJobRepo.findFailures(jobId)
  return failures.map((failure) => ({
    url: failure.url,
    error: failure.error,
    processedAt: failure.processedAt?.toISOString() ?? null,
  }))
}

export async function cancelAudit(jobId: string): Promise<void> {
  const job = await auditJobRepo.findById(jobId)
  if (!job) throw new AppError(ERROR_CODES.JOB_NOT_FOUND, `No audit job with id ${jobId}`)

  if (job.status === 'complete' || job.status === 'failed') {
    throw new AppError(
      ERROR_CODES.INVALID_STATE_TRANSITION,
      `Job is already ${job.status} and cannot be cancelled`,
    )
  }

  // Mark first: the worker checks job status between batches, so this stops it
  // even if the queue removal races.
  await auditJobRepo.markCancelled(jobId)
  await removeAuditJob(config.redisUrl, jobId).catch(() => undefined)
}

export async function listRecent(limit: number) {
  const jobs = await auditJobRepo.findRecent(limit)
  return jobs.map((job) => ({
    id: job.id,
    name: job.name,
    status: job.status,
    inputType: job.inputType,
    totalUrls: job.totalUrls,
    completedUrls: job.completedUrls,
    failedUrls: job.failedUrls,
    createdAt: job.createdAt.toISOString(),
    completedAt: job.completedAt?.toISOString() ?? null,
  }))
}
