import { Router } from 'express'
import { ERROR_CODES, SOCIAL_PLATFORMS } from '@capella/types'
import { socialLinkRepo } from '@capella/db'
import { asyncRoute } from '../middleware/errorHandler.js'
import { notConfigured, ok, parseEnum, requireString } from '../lib/respond.js'
import { config } from '../config.js'

/**
 * Phase 3. Every route is gated on `config.socialEnabled` — PRD §3 marks this
 * as requiring social API credentials plus a social-to-asset linking strategy
 * that has not been decided yet.
 */
export const socialRouter: Router = Router()

socialRouter.use((_req, res, next) => {
  if (!config.socialEnabled) {
    notConfigured(
      res,
      ERROR_CODES.SOCIAL_NOT_CONFIGURED,
      'Social performance tracking is a Phase 3 feature and is not configured.',
    )
    return
  }
  next()
})

/** POST /api/v1/social/links — manually link an asset to a social post. */
socialRouter.post(
  '/links',
  asyncRoute(async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>

    const platform = parseEnum(body['platform'], SOCIAL_PLATFORMS)
    if (!platform) {
      return notConfigured(
        res,
        ERROR_CODES.VALIDATION_FAILED,
        `platform must be one of: ${SOCIAL_PLATFORMS.join(', ')}`,
      )
    }

    return ok(
      res,
      await socialLinkRepo.link({
        assetId: requireString(body['assetId'], 'assetId'),
        platform,
        postUrl: requireString(body['postUrl'], 'postUrl'),
        postId: typeof body['postId'] === 'string' ? body['postId'] : null,
      }),
    )
  }),
)

/** GET /api/v1/social/links?assetId= */
socialRouter.get(
  '/links',
  asyncRoute(async (req, res) => {
    const assetId = (req.query as Record<string, unknown>)['assetId']
    ok(
      res,
      typeof assetId === 'string'
        ? await socialLinkRepo.findForAsset(assetId)
        : await socialLinkRepo.findAll(),
    )
  }),
)

/**
 * GET /api/v1/social/ranking
 *
 * Not implemented: ranking needs a recency-weighted engagement formula agreed
 * with Marketing, and the metric shapes differ per platform. Returning an
 * arbitrary ranking would be worse than returning nothing.
 */
socialRouter.get('/ranking', (_req, res) => {
  notConfigured(
    res,
    ERROR_CODES.SOCIAL_NOT_CONFIGURED,
    'Performance ranking is not implemented — the recency-weighted engagement formula has not been agreed with Marketing yet.',
  )
})
