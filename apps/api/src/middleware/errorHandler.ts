import type { ErrorRequestHandler, RequestHandler } from 'express'
import { ZodError } from 'zod'
import { AppError, ERROR_CODES } from '@capella/types'
import { logger } from '../lib/logger.js'
import { config } from '../config.js'

/**
 * Terminal error handler. Every failure leaves the API in the standard
 * `{ error: { code, message, details } }` shape.
 */
export const errorHandler: ErrorRequestHandler = (err, _req, res, next) => {
  if (res.headersSent) {
    // A streaming response (CSV export, video upload) already started —
    // Express must destroy the socket rather than append JSON.
    return next(err)
  }

  if (err instanceof AppError) {
    // 4xx are the client's problem and are noisy at error level.
    const level = err.status >= 500 ? 'error' : 'warn'
    logger[level]({ code: err.code, err }, err.message)
    return res.status(err.status).json({
      error: { code: err.code, message: err.message, ...(err.details ? { details: err.details } : {}) },
    })
  }

  if (err instanceof ZodError) {
    return res.status(400).json({
      error: {
        code: ERROR_CODES.VALIDATION_FAILED,
        message: 'Request validation failed',
        details: err.issues.map((issue) => ({
          field: issue.path.join('.'),
          message: issue.message,
        })),
      },
    })
  }

  logger.error({ err }, 'Unhandled error')

  return res.status(500).json({
    error: {
      code: ERROR_CODES.INTERNAL_ERROR,
      // Never leak internals to a caller in production — the intake routes are public.
      message: config.isProduction
        ? 'Something went wrong. Please try again.'
        : err instanceof Error
          ? err.message
          : String(err),
    },
  })
}

export const notFoundHandler: RequestHandler = (req, res) => {
  res.status(404).json({
    error: { code: ERROR_CODES.NOT_FOUND, message: `No route for ${req.method} ${req.path}` },
  })
}

/**
 * Wraps an async handler so a rejected promise reaches `errorHandler`.
 * Express 4 does not forward async rejections on its own.
 */
export function asyncRoute(
  handler: (...args: Parameters<RequestHandler>) => Promise<unknown>,
): RequestHandler {
  return (req, res, next) => {
    handler(req, res, next).catch(next)
  }
}
