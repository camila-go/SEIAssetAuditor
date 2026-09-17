import { createReadStream } from 'node:fs'
import { PassThrough, Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { ReadableStream as WebReadableStream } from 'node:stream/web'
import { Router, type Request, type Response } from 'express'
import busboy from 'busboy'
import { AppError, ERROR_CODES, SUBMISSION_STATUSES } from '@capella/types'
import { asyncRoute } from '../middleware/errorHandler.js'
import { internalAuth } from '../middleware/internalAuth.js'
import { intakePublicReadLimiter, intakeSubmitLimiter } from '../middleware/rateLimit.js'
import { created, ok, parseEnum, parsePagination } from '../lib/respond.js'
import * as intakeService from '../services/intakeService.js'
import * as aemUploadService from '../services/aemUploadService.js'
import { config } from '../config.js'

/**
 * Public intake routes. No auth by design — external vendors submit here — so
 * every route is rate limited and nothing leaks an AEM path or internal id.
 */
export const intakeRouter: Router = Router()

const REQUIRED_FIELDS = [
  'title',
  'description',
  'program',
  'campaign',
  'usageRights',
  'rightsExpiryDate',
  'submitterName',
  'submitterEmail',
  'submitterOrg',
] as const

/**
 * POST /api/v1/intake  (public)
 *
 * multipart/form-data: metadata fields + `video` + optional `legalDoc` PDF.
 *
 * The video is piped through to AEM as it arrives. Because busboy delivers
 * parts in wire order and the upload starts as soon as the video part opens,
 * the form must append all metadata fields AND the optional legalDoc BEFORE the
 * video part. `buildIntakeFormData` on the client guarantees that ordering.
 */
intakeRouter.post(
  '/',
  intakeSubmitLimiter,
  asyncRoute(async (req, res) => {
    const submission = await handleSubmission(req)
    created(res, submission)
  }),
)

/** POST /api/v1/intake/:id/resubmit  (public) */
intakeRouter.post(
  '/:id/resubmit',
  intakeSubmitLimiter,
  asyncRoute(async (req, res) => {
    const parentId = req.params['id'] ?? ''
    // Throws unless the parent exists and was actually rejected.
    await intakeService.getResubmissionTemplate(parentId)

    const submission = await handleSubmission(req, parentId)
    created(res, submission)
  }),
)

/** GET /api/v1/intake/:id/public  (public) — confirmation + status page. */
intakeRouter.get(
  '/:id/public',
  intakePublicReadLimiter,
  asyncRoute(async (req, res) => {
    ok(res, await intakeService.getPublicSubmission(req.params['id'] ?? ''))
  }),
)

/** GET /api/v1/intake/:id/resubmission-template  (public) — pre-fills the form. */
intakeRouter.get(
  '/:id/resubmission-template',
  intakePublicReadLimiter,
  asyncRoute(async (req, res) => {
    ok(res, await intakeService.getResubmissionTemplate(req.params['id'] ?? ''))
  }),
)

/** GET /api/v1/intake/config  (public) — terms URL and limits for the form. */
intakeRouter.get('/config', intakePublicReadLimiter, (_req, res) => {
  ok(res, {
    legalTermsUrl: config.legalTermsUrl,
    maxVideoBytes: config.maxVideoBytes,
    maxLegalDocBytes: config.maxLegalDocBytes,
    acceptedVideoTypes: intakeService.ALLOWED_VIDEO_TYPES,
    intakeEnabled: config.aemIntakeEnabled,
  })
})

// ─── Internal (approver) routes ──────────────────────────────────────────────

export const adminIntakeRouter: Router = Router()
adminIntakeRouter.use(internalAuth)

/** GET /api/v1/intake — the approval queue. */
adminIntakeRouter.get(
  '/',
  asyncRoute(async (req, res) => {
    const query = req.query as Record<string, unknown>
    const { page, limit, offset } = parsePagination(query)

    const status = parseEnum(query['status'], SUBMISSION_STATUSES)
    const program = typeof query['program'] === 'string' ? query['program'].trim() : undefined

    const { submissions, total } = await intakeService.listSubmissions({
      ...(status ? { status } : {}),
      ...(program ? { program } : {}),
      offset,
      limit,
    })

    ok(res, submissions, { page, limit, total })
  }),
)

/** GET /api/v1/intake/stats */
adminIntakeRouter.get(
  '/stats',
  asyncRoute(async (_req, res) => {
    ok(res, await intakeService.getStats())
  }),
)

/** GET /api/v1/intake/:id — full detail including transcript and chapters. */
adminIntakeRouter.get(
  '/:id',
  asyncRoute(async (req, res) => {
    ok(res, await intakeService.getSubmissionDetail(req.params['id'] ?? ''))
  }),
)

/** POST /api/v1/intake/:id/approve */
adminIntakeRouter.post(
  '/:id/approve',
  asyncRoute(async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>
    const approverType = parseEnum(body['approverType'], ['legal', 'marketing'] as const)

    if (!approverType) {
      throw new AppError(
        ERROR_CODES.VALIDATION_FAILED,
        'approverType must be "legal" or "marketing"',
      )
    }

    ok(
      res,
      await intakeService.recordDecision({
        submissionId: req.params['id'] ?? '',
        approverType,
        approverEmail: req.approverEmail ?? 'unknown',
        decision: 'approved',
        reason: typeof body['reason'] === 'string' ? body['reason'] : null,
      }),
    )
  }),
)

/** POST /api/v1/intake/:id/reject — a reason is mandatory. */
adminIntakeRouter.post(
  '/:id/reject',
  asyncRoute(async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>
    const approverType = parseEnum(body['approverType'], ['legal', 'marketing'] as const)

    if (!approverType) {
      throw new AppError(
        ERROR_CODES.VALIDATION_FAILED,
        'approverType must be "legal" or "marketing"',
      )
    }

    const reason = typeof body['reason'] === 'string' ? body['reason'].trim() : ''
    if (!reason) {
      throw new AppError(ERROR_CODES.VALIDATION_FAILED, 'A reason is required when rejecting')
    }

    ok(
      res,
      await intakeService.recordDecision({
        submissionId: req.params['id'] ?? '',
        approverType,
        approverEmail: req.approverEmail ?? 'unknown',
        decision: 'rejected',
        reason,
      }),
    )
  }),
)

/**
 * GET /api/v1/intake/:id/stream — video preview for approvers.
 *
 * The staging folder is dispatcher-blocked and sits behind the intake service
 * account, so the browser cannot fetch it directly. This proxies the bytes
 * through, forwarding Range headers so the player can seek to a chapter marker
 * without downloading the whole file.
 */
adminIntakeRouter.get(
  '/:id/stream',
  asyncRoute(async (req, res) => {
    const submission = await intakeService.getSubmissionDetail(req.params['id'] ?? '')
    const damPath = submission.aemFinalPath ?? submission.aemStagingPath

    if (!damPath) {
      throw new AppError(ERROR_CODES.NOT_FOUND, 'No video is staged for this submission')
    }

    await proxyFromAem(damPath, req, res, submission.mimeType)
  }),
)

/** GET /api/v1/intake/:id/captions — the generated .vtt track. */
adminIntakeRouter.get(
  '/:id/captions',
  asyncRoute(async (req, res) => {
    const submission = await intakeService.getSubmissionDetail(req.params['id'] ?? '')

    if (!submission.vttAemPath) {
      throw new AppError(ERROR_CODES.NOT_FOUND, 'No caption file has been generated')
    }

    await proxyFromAem(submission.vttAemPath, req, res, 'text/vtt')
  }),
)

/**
 * Stream an asset out of AEM to the approver, never buffering it here.
 * Read-only: this uses the intake account's read scope, not its write scope.
 */
async function proxyFromAem(
  damPath: string,
  req: Request,
  res: Response,
  fallbackType: string,
): Promise<void> {
  const range = req.get('range')

  const upstream = await fetch(aemUploadService.stagingAssetUrl(damPath), {
    headers: {
      Authorization: `Basic ${Buffer.from(
        `${config.aemIntakeWriteUser}:${config.aemIntakeWritePassword}`,
      ).toString('base64')}`,
      ...(range ? { Range: range } : {}),
    },
  })

  if (!upstream.ok && upstream.status !== 206) {
    throw new AppError(
      ERROR_CODES.AEM_REQUEST_FAILED,
      `Could not load the asset from AEM (HTTP ${upstream.status})`,
    )
  }

  res.status(upstream.status)
  res.setHeader('Content-Type', upstream.headers.get('content-type') ?? fallbackType)
  res.setHeader('Accept-Ranges', 'bytes')
  for (const header of ['content-length', 'content-range'] as const) {
    const value = upstream.headers.get(header)
    if (value) res.setHeader(header, value)
  }
  // An unapproved submission must never be cached by a shared proxy.
  res.setHeader('Cache-Control', 'private, no-store')

  if (!upstream.body) {
    res.end()
    return
  }

  await pipeline(Readable.fromWeb(upstream.body as WebReadableStream), res)
}

/** GET /api/v1/intake/:id/legal-doc — serves the signed PDF to approvers only. */
adminIntakeRouter.get(
  '/:id/legal-doc',
  asyncRoute(async (req, res) => {
    const { storedPath, filename } = await intakeService.getLegalDocPath(req.params['id'] ?? '')

    res.setHeader('Content-Type', 'application/pdf')
    // `inline` so it opens in a tab rather than downloading.
    res.setHeader('Content-Disposition', `inline; filename="${filename.replace(/"/g, '')}"`)

    createReadStream(storedPath).pipe(res)
  }),
)

// ─── Multipart handling ──────────────────────────────────────────────────────

/**
 * Parse the multipart body and hand the video stream to the intake service.
 *
 * The video part is bridged through a PassThrough rather than buffered, so the
 * bytes flow browser -> API -> AEM without ever being held in memory or on disk.
 */
function handleSubmission(
  req: Request,
  parentSubmissionId?: string,
): Promise<Awaited<ReturnType<typeof intakeService.submitVideo>>> {
  return new Promise((resolve, reject) => {
    const parser = busboy({
      headers: req.headers,
      limits: { files: 2, fileSize: config.maxVideoBytes },
    })

    const fields: Record<string, string> = {}
    const legalDocChunks: Buffer[] = []
    let legalDocFilename: string | null = null

    let settled = false
    let submissionPromise: Promise<Awaited<ReturnType<typeof intakeService.submitVideo>>> | null =
      null

    const failOnce = (error: unknown): void => {
      if (settled) return
      settled = true
      req.unpipe(parser)
      reject(error)
    }

    parser.on('field', (name, value) => {
      fields[name] = value
    })

    parser.on('file', (fieldname, stream, info) => {
      if (fieldname === 'legalDoc') {
        legalDocFilename = info.filename
        stream.on('data', (chunk: Buffer) => legalDocChunks.push(chunk))
        stream.on('limit', () =>
          failOnce(new AppError(ERROR_CODES.FILE_TOO_LARGE, 'Signed document is too large')),
        )
        return
      }

      if (fieldname !== 'video') {
        stream.resume()
        return
      }

      const missing = REQUIRED_FIELDS.filter((field) => !fields[field]?.trim())
      if (missing.length > 0) {
        stream.resume()
        failOnce(
          new AppError(
            ERROR_CODES.VALIDATION_FAILED,
            `Missing required fields: ${missing.join(', ')}. Send all metadata fields before the video part.`,
          ),
        )
        return
      }

      // Checked before a byte is read, and again server-side in the service.
      if (fields['legalAgreed'] !== 'true') {
        stream.resume()
        failOnce(
          new AppError(
            ERROR_CODES.LEGAL_AGREEMENT_REQUIRED,
            'You must agree to the terms before submitting',
          ),
        )
        return
      }

      const bridge = new PassThrough()
      stream.pipe(bridge)

      stream.on('limit', () => {
        bridge.destroy(
          new AppError(
            ERROR_CODES.FILE_TOO_LARGE,
            `Video exceeds the ${Math.round(config.maxVideoBytes / 1024 / 1024 / 1024)}GB limit`,
          ),
        )
      })

      submissionPromise = intakeService.submitVideo({
        metadata: {
          title: fields['title'] ?? '',
          description: fields['description'] ?? '',
          program: fields['program'] ?? '',
          campaign: fields['campaign'] ?? '',
          usageRights: fields['usageRights'] ?? '',
          rightsExpiryDate: fields['rightsExpiryDate'] ?? '',
          submitterName: fields['submitterName'] ?? '',
          submitterEmail: fields['submitterEmail'] ?? '',
          submitterOrg: fields['submitterOrg'] ?? '',
          ...(fields['notes'] ? { notes: fields['notes'] } : {}),
          legalAgreed: true,
          ...(parentSubmissionId ? { parentSubmissionId } : {}),
        },
        filename: info.filename,
        mimeType: info.mimeType,
        videoStream: bridge,
        // Deliberately not passing Content-Length: the request's value covers the
        // whole multipart envelope, not this part, and sending a wrong length on
        // the AEM upload is worse than sending none (chunked transfer is fine).
        ...(legalDocFilename
          ? { legalDoc: { filename: legalDocFilename, buffer: Buffer.concat(legalDocChunks) } }
          : {}),
        submitterIp: req.ip ?? null,
      })

      // Attach a rejection handler NOW, not in the 'close' listener.
      //
      // submitVideo can reject well before busboy emits 'close' — a disabled
      // intake flag rejects almost immediately. Without a handler attached at
      // creation time that rejection is unhandled, and Node terminates the
      // whole API process. The real settling still happens in 'close'; this
      // only marks the promise as handled.
      submissionPromise.catch(() => undefined)
    })

    parser.on('error', failOnce)

    parser.on('close', () => {
      if (settled) return

      if (!submissionPromise) {
        failOnce(new AppError(ERROR_CODES.VALIDATION_FAILED, 'No video file was included'))
        return
      }

      settled = true
      submissionPromise.then(resolve, reject)
    })

    req.pipe(parser)
  })
}
