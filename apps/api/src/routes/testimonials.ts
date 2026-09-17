import { Router } from 'express'
import { ERROR_CODES, TESTIMONIAL_SOURCE_TYPES } from '@capella/types'
import { asyncRoute } from '../middleware/errorHandler.js'
import { notConfigured, ok, parseEnum, parsePagination } from '../lib/respond.js'
import * as testimonialService from '../services/testimonialService.js'
import { getSemanticCoverage, testimonialRepo } from '@capella/db'
import { enqueueEmbedding } from '@capella/queue'
import { config } from '../config.js'

export const testimonialsRouter: Router = Router()

/**
 * GET /api/v1/testimonials
 *
 * `query` is a single input searched across quote text, student name and
 * program at once — the UI has one search box, not three.
 */
testimonialsRouter.get(
  '/',
  asyncRoute(async (req, res) => {
    const query = req.query as Record<string, unknown>
    const { page, limit, offset } = parsePagination(query)

    const search = typeof query['query'] === 'string' ? query['query'].trim() : undefined
    const program = typeof query['program'] === 'string' ? query['program'].trim() : undefined
    const sourceType = parseEnum(query['sourceType'], TESTIMONIAL_SOURCE_TYPES)
    const staleRaw = Number(query['staleDays'])

    const { testimonials, total } = await testimonialService.search({
      ...(search ? { query: search } : {}),
      ...(program ? { program } : {}),
      ...(sourceType ? { sourceType } : {}),
      needsReviewOnly: query['needsReview'] === 'true',
      ...(Number.isFinite(staleRaw) && staleRaw > 0 ? { staleDays: Math.floor(staleRaw) } : {}),
      offset,
      limit,
    })

    ok(res, testimonials, { page, limit, total })
  }),
)

/**
 * GET /api/v1/testimonials/search-index
 *
 * How much of the corpus can be matched by meaning. A half-built index is the
 * difference between "nothing matches" and "nothing is indexed yet".
 */
testimonialsRouter.get(
  '/search-index',
  asyncRoute(async (_req, res) => {
    ok(res, { ...(await getSemanticCoverage()), enabled: config.semanticSearchEnabled })
  }),
)

/** POST /api/v1/testimonials/search-index — build or refresh it. */
testimonialsRouter.post(
  '/search-index',
  asyncRoute(async (_req, res) => {
    await enqueueEmbedding(config.redisUrl, {})
    ok(res, { queued: true, ...(await getSemanticCoverage()) })
  }),
)

/** GET /api/v1/testimonials/stats */
testimonialsRouter.get(
  '/stats',
  asyncRoute(async (_req, res) => {
    ok(res, await testimonialService.getStats())
  }),
)

/** GET /api/v1/testimonials/export — CSV of every testimonial. */
testimonialsRouter.get(
  '/export',
  asyncRoute(async (_req, res) => {
    res.setHeader('Content-Type', 'text/csv; charset=utf-8')
    res.setHeader('Content-Disposition', 'attachment; filename="testimonials.csv"')
    res.write('quote_text,student_name,program,degree_level,source_type,needs_review,first_seen_at,last_seen_at\n')

    for (const testimonial of await testimonialRepo.streamAll()) {
      res.write(
        [
          csvCell(testimonial.quoteText),
          csvCell(testimonial.studentName ?? ''),
          csvCell(testimonial.program ?? ''),
          csvCell(testimonial.degreeLevel ?? ''),
          csvCell(testimonial.sourceType),
          String(testimonial.needsReview),
          csvCell(testimonial.firstSeenAt.toISOString()),
          csvCell(testimonial.lastSeenAt.toISOString()),
        ].join(',') + '\n',
      )
    }

    res.end()
  }),
)

/** GET /api/v1/testimonials/:id — detail with the full page map. */
testimonialsRouter.get(
  '/:id',
  asyncRoute(async (req, res) => {
    ok(res, await testimonialService.getById(req.params['id'] ?? ''))
  }),
)

export const programsRouter: Router = Router()

/**
 * GET /api/v1/programs/coverage — Phase 2.
 *
 * Gated: without AEM's program taxonomy we only know about programs that
 * already have a testimonial, which is exactly the opposite of what a coverage
 * gap report needs. Returning partial data here would be actively misleading.
 */
programsRouter.get(
  '/coverage',
  asyncRoute(async (_req, res) => {
    if (!config.aemApiEnabled) {
      return notConfigured(
        res,
        ERROR_CODES.AEM_API_NOT_CONFIGURED,
        'Program coverage needs the full program list from AEM. Without it, a program with zero testimonials is invisible — which is the gap you are looking for.',
      )
    }

    // TODO(Phase 2): source the program list from the AEM tag taxonomy
    // (tagid=programs/*) rather than from indexed testimonials.
    return ok(res, await testimonialService.getProgramCoverage([]))
  }),
)

function csvCell(value: string): string {
  const guarded = /^[=+\-@]/.test(value) ? `'${value}` : value
  return `"${guarded.replace(/"/g, '""')}"`
}
