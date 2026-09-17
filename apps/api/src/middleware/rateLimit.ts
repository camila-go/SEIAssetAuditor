import rateLimit from 'express-rate-limit'
import { ERROR_CODES } from '@capella/types'

const errorBody = {
  error: {
    code: ERROR_CODES.RATE_LIMITED,
    message: 'Too many requests — please wait a moment and try again.',
  },
}

/** Baseline for the internal audit/lookup surface. */
export const standardLimiter = rateLimit({
  windowMs: 60_000,
  limit: 120,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: errorBody,
})

/**
 * The intake submission route is public and unauthenticated, and each request
 * streams a file to AEM — it gets the tightest budget in the app.
 */
export const intakeSubmitLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 5,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: errorBody,
})

/** Public read of a submission's own status — cheap, but still public. */
export const intakePublicReadLimiter = rateLimit({
  windowMs: 60_000,
  limit: 30,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: errorBody,
})

/** Audit creation can enqueue thousands of page fetches against a live site. */
export const auditCreateLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 20,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: errorBody,
})
