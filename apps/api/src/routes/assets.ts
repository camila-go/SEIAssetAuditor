import { Router, type Request } from 'express'
import busboy from 'busboy'
import { ASSET_TYPES, AppError, ERROR_CODES } from '@capella/types'
import { enqueuePhash, enqueueRevalidation } from '@capella/queue'
import { assetRepo } from '@capella/db'
import { asyncRoute } from '../middleware/errorHandler.js'
import { accepted, notConfigured, ok, parseEnum, parsePagination, requireString } from '../lib/respond.js'
import * as assetService from '../services/assetService.js'
import * as imageSearchService from '../services/imageSearchService.js'
import { config } from '../config.js'

export const assetsRouter: Router = Router()

/** GET /api/v1/assets?query=&assetType=&unusedOnly= */
assetsRouter.get(
  '/',
  asyncRoute(async (req, res) => {
    const query = req.query as Record<string, unknown>
    const { page, limit, offset } = parsePagination(query)

    const search = typeof query['query'] === 'string' ? query['query'].trim() : undefined
    const assetType = parseEnum(query['assetType'], ASSET_TYPES)
    const unusedOnly = query['unusedOnly'] === 'true'

    // Unused-asset flagging is only meaningful once AEM can tell us about
    // references on pages we never crawled.
    if (unusedOnly && !config.aemApiEnabled) {
      return notConfigured(
        res,
        ERROR_CODES.AEM_API_NOT_CONFIGURED,
        'Unused-asset flagging needs AEM API access — until then, an asset can only be shown as unused across the pages that have actually been audited.',
      )
    }

    const { assets, total } = await assetService.search({
      ...(search ? { query: search } : {}),
      ...(assetType ? { assetType } : {}),
      unusedOnly,
      offset,
      limit,
    })

    return ok(res, assets, { page, limit, total })
  }),
)

/** GET /api/v1/assets/stats — dashboard tiles. */
assetsRouter.get(
  '/stats',
  asyncRoute(async (_req, res) => {
    ok(res, await assetService.getStats())
  }),
)

/**
 * POST /api/v1/assets/index-images
 *
 * Enqueue a pHash sweep so reverse image search and duplicate detection have
 * something to match against. Safe to call repeatedly — the job only picks up
 * assets that do not have a hash yet.
 */
assetsRouter.post(
  '/index-images',
  asyncRoute(async (_req, res) => {
    await enqueuePhash(config.redisUrl, {})
    accepted(res, { queued: true, coverage: await imageSearchService.getCoverage() })
  }),
)

/**
 * GET /api/v1/assets/verification
 *
 * How recently the index was confirmed against the live site. Surfaced for the
 * same reason pHash coverage is: a page map from a months-old crawl looks
 * identical to one from this morning unless the tool says which it is.
 */
assetsRouter.get(
  '/verification',
  asyncRoute(async (_req, res) => {
    ok(res, { ...(await assetRepo.getVerificationSummary()), everyDays: 3 })
  }),
)

/** POST /api/v1/assets/verification — re-check now, outside the schedule. */
assetsRouter.post(
  '/verification',
  asyncRoute(async (req, res) => {
    const force = (req.query as Record<string, unknown>)['force'] === 'true'
    await enqueueRevalidation(config.redisUrl, force ? { force } : {})
    ok(res, { queued: true, ...(await assetRepo.getVerificationSummary()) })
  }),
)

/** GET /api/v1/assets/missing — assets the site no longer serves. */
assetsRouter.get(
  '/missing',
  asyncRoute(async (_req, res) => {
    ok(res, await assetRepo.findMissing())
  }),
)

/** GET /api/v1/assets/:id */
assetsRouter.get(
  '/:id',
  asyncRoute(async (req, res) => {
    ok(res, await assetService.getById(req.params['id'] ?? ''))
  }),
)

export const lookupRouter: Router = Router()

/**
 * GET /api/v1/lookup?path=...
 * Reverse lookup. Accepts a DAM path, a public URL, or a rendition URL.
 */
lookupRouter.get(
  '/',
  asyncRoute(async (req, res) => {
    const path = requireString((req.query as Record<string, unknown>)['path'], 'path')
    ok(res, await assetService.reverseLookup(path))
  }),
)

/** GET /api/v1/lookup/image/coverage — how much of the image index is searchable. */
lookupRouter.get(
  '/image/coverage',
  asyncRoute(async (_req, res) => {
    ok(res, await imageSearchService.getCoverage())
  }),
)

/**
 * POST /api/v1/lookup/image — reverse IMAGE search.
 *
 * Accepts either a multipart upload (field `image`) or JSON `{ imageUrl }`.
 * Returns indexed assets ranked by perceptual similarity, each with the pages
 * it appears on.
 */
lookupRouter.post(
  '/image',
  asyncRoute(async (req, res) => {
    const contentType = req.get('content-type') ?? ''

    const threshold = parseThreshold(
      contentType.includes('multipart/form-data')
        ? undefined
        : ((req.body ?? {}) as Record<string, unknown>)['threshold'],
    )

    let buffer: Buffer
    let thresholdOverride = threshold

    if (contentType.includes('multipart/form-data')) {
      const upload = await readImageUpload(req)
      buffer = upload.buffer
      if (upload.threshold !== undefined) thresholdOverride = parseThreshold(upload.threshold)
    } else {
      const body = (req.body ?? {}) as Record<string, unknown>
      const imageUrl = body['imageUrl']

      if (typeof imageUrl !== 'string' || !imageUrl.trim()) {
        throw new AppError(
          ERROR_CODES.VALIDATION_FAILED,
          'Provide an image file (multipart field `image`) or an `imageUrl`',
        )
      }

      buffer = await imageSearchService.fetchImageForSearch(imageUrl)
    }

    ok(res, await imageSearchService.searchByImage(buffer, thresholdOverride))
  }),
)

function parseThreshold(value: unknown): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed >= 0
    ? Math.min(Math.floor(parsed), imageSearchService.MAX_MATCH_THRESHOLD)
    : imageSearchService.DEFAULT_MATCH_THRESHOLD
}

/**
 * Buffer the uploaded image.
 *
 * Buffering is correct here, unlike the video intake path: the image has to be
 * fully decoded by `sharp` to be hashed, so it cannot be streamed through, and
 * it is capped at 25MB.
 */
function readImageUpload(req: Request): Promise<{ buffer: Buffer; threshold?: string }> {
  return new Promise((resolve, reject) => {
    const parser = busboy({
      headers: req.headers,
      limits: { files: 1, fileSize: imageSearchService.MAX_IMAGE_BYTES },
    })

    const chunks: Buffer[] = []
    let threshold: string | undefined
    let sawFile = false
    let tooLarge = false

    parser.on('field', (name, value) => {
      if (name === 'threshold') threshold = value
    })

    parser.on('file', (fieldname, stream) => {
      if (fieldname !== 'image') {
        stream.resume()
        return
      }

      // The declared Content-Type is deliberately NOT used to gate this.
      // Clients get it wrong constantly — curl sends application/octet-stream
      // for a .webp — and a client-declared type is not a security control
      // anyway. `sharp` decoding the bytes is the real check, and it produces a
      // clear UNSUPPORTED_MEDIA_TYPE of its own. Size is capped by `limits`.
      sawFile = true
      stream.on('data', (chunk: Buffer) => chunks.push(chunk))
      stream.on('limit', () => {
        tooLarge = true
        stream.resume()
      })
    })

    parser.on('error', reject)

    parser.on('close', () => {
      if (tooLarge) {
        reject(new AppError(ERROR_CODES.FILE_TOO_LARGE, 'Image must be 25MB or smaller'))
        return
      }
      if (!sawFile) {
        reject(new AppError(ERROR_CODES.VALIDATION_FAILED, 'No image was included in the upload'))
        return
      }
      resolve({ buffer: Buffer.concat(chunks), ...(threshold ? { threshold } : {}) })
    })

    req.pipe(parser)
  })
}

export const duplicatesRouter: Router = Router()

/**
 * GET /api/v1/duplicates?threshold=10
 *
 * The PRD files this under Phase 2, but it does not need AEM access: DAM assets
 * are publicly served, so the pHash index is built by fetching them over HTTP.
 * Verified working with every AEM flag off. Gating it would have withheld a
 * feature that already works.
 *
 * It does depend on the hashing job having run — `coverage` says how far along
 * that is, so an empty result is not mistaken for "no duplicates".
 */
duplicatesRouter.get(
  '/',
  asyncRoute(async (req, res) => {
    const raw = Number((req.query as Record<string, unknown>)['threshold'])
    // Above ~20 the hashes stop being meaningfully similar and everything collapses
    // into one group.
    const threshold = Number.isFinite(raw) ? Math.min(Math.max(Math.floor(raw), 0), 20) : 10

    ok(res, {
      groups: await assetService.findDuplicates(threshold),
      coverage: await imageSearchService.getCoverage(),
    })
  }),
)
