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
} from '@capella/types'
import { config } from '../config.js'

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
}

export async function createAudit(input: CreateAuditInput): Promise<CreateAuditResult> {
  const urls = await resolveUrls(input.inputType, input.rawInput)

  if (urls.length === 0) {
    throw new AppError(
      ERROR_CODES.NO_URLS_PROVIDED,
      'No valid URLs found. Provide at least one http(s) URL.',
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

  return { jobId: job.id, status: 'queued', totalUrls: job.totalUrls }
}

async function resolveUrls(inputType: AuditInputType, rawInput: string): Promise<string[]> {
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
      const urls = await fetchSitemapUrls(sitemapUrl, config.scraper.userAgent)
      return urls.map(normalizeUrl).filter((url): url is string => url !== null)
    }
  }
}

/** One URL per line. Blank lines and `#` comments are ignored. */
export function parseUrlList(raw: string): string[] {
  const urls = raw
    .split(/[\r\n]+/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'))
    .map(normalizeUrl)
    .filter((url): url is string => url !== null)

  return [...new Set(urls)]
}

/**
 * URLs from the first column of a CSV/TXT.
 *
 * Deliberately lenient: these files are exported from spreadsheets by hand, so
 * we take the first cell that parses as a URL rather than requiring a header or
 * a strict column position. A header row simply yields no URL and is skipped.
 */
export function parseCsvUrls(raw: string): string[] {
  const urls: string[] = []

  for (const line of raw.split(/[\r\n]+/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue

    for (const cell of splitCsvLine(trimmed)) {
      const normalized = normalizeUrl(cell.trim().replace(/^"|"$/g, ''))
      if (normalized) {
        urls.push(normalized)
        break
      }
    }
  }

  return [...new Set(urls)]
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

/** Anything of the form `scheme:` at the start — not just http. */
const HAS_SCHEME = /^[a-z][a-z0-9+.-]*:/i
/** A bare host: no whitespace, and at least one dot with a plausible TLD. */
const LOOKS_LIKE_HOST = /^[^\s/]+\.[a-z]{2,}(?:[:/?#]|$)/i

/**
 * Normalize one URL, or return null if it isn't a page address.
 *
 * Bare hosts get `https://` assumed, but only when they actually look like a
 * host. Prefixing unconditionally is a trap: it turns `ftp://example.com` into
 * `https://ftp//example.com` and a CSV header cell like `title` into
 * `https://title/` — both of which then get queued and scraped.
 */
export function normalizeUrl(value: string): string | null {
  const trimmed = value.trim()
  if (!trimmed) return null

  // An explicit scheme is honoured as written, so a non-http one is rejected
  // rather than rewritten.
  const candidate = HAS_SCHEME.test(trimmed)
    ? trimmed
    : LOOKS_LIKE_HOST.test(trimmed)
      ? `https://${trimmed}`
      : null

  if (candidate === null) return null

  try {
    const url = new URL(candidate)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
    if (!url.hostname.includes('.')) return null
    // A fragment identifies a position within a page, not a distinct page.
    url.hash = ''
    return url.toString()
  } catch {
    return null
  }
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
