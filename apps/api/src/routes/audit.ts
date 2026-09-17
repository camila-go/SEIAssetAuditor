import { Router, type Request } from 'express'
import busboy from 'busboy'
import { AppError, ERROR_CODES, type AuditInputType, type LiveStatus } from '@capella/types'
import { asyncRoute } from '../middleware/errorHandler.js'
import { auditCreateLimiter } from '../middleware/rateLimit.js'
import { accepted, ok, parseEnum, parsePagination } from '../lib/respond.js'
import * as auditService from '../services/auditService.js'
import { auditJobRepo } from '@capella/db'

export const auditRouter: Router = Router()

const MAX_CSV_BYTES = 10 * 1024 * 1024

/**
 * POST /api/v1/audit
 *
 * Accepts JSON (`{ urls }` or `{ sitemapUrl }`) or a multipart CSV/TXT upload.
 * Always returns immediately with a jobId — no page is fetched in the request.
 */
auditRouter.post(
  '/',
  auditCreateLimiter,
  asyncRoute(async (req, res) => {
    const contentType = req.get('content-type') ?? ''

    const { inputType, rawInput, name } = contentType.includes('multipart/form-data')
      ? await readMultipart(req)
      : readJsonBody(req.body)

    const result = await auditService.createAudit({
      inputType,
      rawInput,
      ...(name ? { name } : {}),
      createdBy: req.get('x-user-email') ?? null,
    })

    // 202: the work is queued, not done.
    accepted(res, result)
  }),
)

function readJsonBody(body: unknown): {
  inputType: AuditInputType
  rawInput: string
  name?: string
} {
  const payload = (body ?? {}) as Record<string, unknown>
  const name = typeof payload['name'] === 'string' ? payload['name'] : undefined

  if (typeof payload['sitemapUrl'] === 'string' && payload['sitemapUrl'].trim()) {
    return { inputType: 'sitemap', rawInput: payload['sitemapUrl'], ...(name ? { name } : {}) }
  }

  const urls = payload['urls']
  if (Array.isArray(urls)) {
    return {
      inputType: 'paste',
      rawInput: urls.filter((url): url is string => typeof url === 'string').join('\n'),
      ...(name ? { name } : {}),
    }
  }
  if (typeof urls === 'string') {
    return { inputType: 'paste', rawInput: urls, ...(name ? { name } : {}) }
  }

  throw new AppError(
    ERROR_CODES.NO_URLS_PROVIDED,
    'Provide `urls` (array or newline-separated string), `sitemapUrl`, or upload a CSV file',
  )
}

/** Read a CSV/TXT upload. Bounded — these files are URL lists, not datasets. */
function readMultipart(
  req: Request,
): Promise<{ inputType: AuditInputType; rawInput: string; name?: string }> {
  return new Promise((resolve, reject) => {
    const parser = busboy({ headers: req.headers, limits: { files: 1, fileSize: MAX_CSV_BYTES } })

    const chunks: Buffer[] = []
    let name: string | undefined
    let truncated = false
    let sawFile = false

    parser.on('field', (fieldname, value) => {
      if (fieldname === 'name') name = value
    })

    parser.on('file', (_fieldname, stream) => {
      sawFile = true
      stream.on('data', (chunk: Buffer) => chunks.push(chunk))
      stream.on('limit', () => {
        truncated = true
        stream.resume()
      })
    })

    parser.on('error', (error: unknown) => reject(error))

    parser.on('close', () => {
      if (truncated) {
        reject(new AppError(ERROR_CODES.FILE_TOO_LARGE, 'URL list must be 10MB or smaller'))
        return
      }
      if (!sawFile) {
        reject(new AppError(ERROR_CODES.NO_URLS_PROVIDED, 'No file was included in the upload'))
        return
      }
      resolve({
        inputType: 'csv_upload',
        rawInput: Buffer.concat(chunks).toString('utf8'),
        ...(name ? { name } : {}),
      })
    })

    req.pipe(parser)
  })
}

/** GET /api/v1/audit — recent jobs for the dashboard. */
auditRouter.get(
  '/',
  asyncRoute(async (req, res) => {
    const { limit } = parsePagination(req.query as Record<string, unknown>)
    ok(res, await auditService.listRecent(limit))
  }),
)

/** GET /api/v1/audit/:jobId/status — polled every 3s by the UI. */
auditRouter.get(
  '/:jobId/status',
  asyncRoute(async (req, res) => {
    ok(res, await auditService.getStatus(req.params['jobId'] ?? ''))
  }),
)

/** GET /api/v1/audit/:jobId/results — queryable before the job completes. */
auditRouter.get(
  '/:jobId/results',
  asyncRoute(async (req, res) => {
    const query = req.query as Record<string, unknown>
    const { page, limit, offset } = parsePagination(query)

    const urlStatus = parseEnum(query['urlStatus'], ['pending', 'done', 'failed'] as const)
    const liveStatus = parseEnum(query['liveStatus'], [
      'published',
      'draft',
      'unknown',
    ] as const satisfies readonly LiveStatus[])

    const { rows, total } = await auditService.getResults({
      jobId: req.params['jobId'] ?? '',
      ...(urlStatus ? { urlStatus } : {}),
      ...(liveStatus ? { liveStatus } : {}),
      offset,
      limit,
    })

    ok(res, rows, { page, limit, total })
  }),
)

/** GET /api/v1/audit/:jobId/failures — the collapsible failed-URL panel. */
auditRouter.get(
  '/:jobId/failures',
  asyncRoute(async (req, res) => {
    ok(res, await auditService.getFailures(req.params['jobId'] ?? ''))
  }),
)

/**
 * GET /api/v1/audit/:jobId/export — CSV download.
 * Streamed row by row so a 10k-URL export never materializes as one string.
 */
auditRouter.get(
  '/:jobId/export',
  asyncRoute(async (req, res) => {
    const jobId = req.params['jobId'] ?? ''
    const job = await auditJobRepo.findById(jobId)
    if (!job) throw new AppError(ERROR_CODES.JOB_NOT_FOUND, `No audit job with id ${jobId}`)

    res.setHeader('Content-Type', 'text/csv; charset=utf-8')
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="audit-${jobId.slice(0, 8)}.csv"`,
    )

    res.write('url,page_title,live_status,url_status,asset_count,testimonial_count,processed_at,error\n')

    for (const row of await auditJobRepo.streamAllResults(jobId)) {
      res.write(
        [
          csvCell(row.url),
          csvCell(row.pageTitle ?? ''),
          csvCell(auditService.toLiveStatus(row.isPublished)),
          csvCell(row.status),
          String(row.assetCount),
          String(row.testimonialCount),
          csvCell(row.processedAt?.toISOString() ?? ''),
          csvCell(row.error ?? ''),
        ].join(',') + '\n',
      )
    }

    res.end()
  }),
)

/** POST /api/v1/audit/:jobId/cancel */
auditRouter.post(
  '/:jobId/cancel',
  asyncRoute(async (req, res) => {
    await auditService.cancelAudit(req.params['jobId'] ?? '')
    ok(res, { cancelled: true })
  }),
)

/**
 * Quote every cell and double inner quotes. A leading =, +, - or @ is prefixed
 * with a single quote so Excel treats it as text rather than a formula — page
 * titles are scraped from a live site and are untrusted input.
 */
function csvCell(value: string): string {
  const guarded = /^[=+\-@]/.test(value) ? `'${value}` : value
  return `"${guarded.replace(/"/g, '""')}"`
}
