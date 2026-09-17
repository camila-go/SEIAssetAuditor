import { timingSafeEqual } from 'node:crypto'
import type { RequestHandler } from 'express'
import { ERROR_CODES } from '@capella/types'
import { config } from '../config.js'
import { logger } from '../lib/logger.js'

declare module 'express-serve-static-core' {
  interface Request {
    /** Set by `internalAuth` — the approver acting on this request. */
    approverEmail?: string
  }
}

/**
 * Guards approver-only routes (`/api/v1/intake` list, approve, reject,
 * legal-doc). The public intake routes deliberately do NOT use this.
 *
 * This is a shared bearer token plus a caller-supplied approver identity. It is
 * a placeholder: PRD §11 has an open question on whether internal users should
 * authenticate via Capella SSO. When SSO lands, replace the body of this
 * middleware — the route wiring does not need to change.
 */
export const internalAuth: RequestHandler = (req, res, next) => {
  const expected = config.internalAuthToken

  if (!expected) {
    // Failing closed matters more than convenience: these routes move assets
    // into the live DAM.
    logger.error('INTERNAL_AUTH_TOKEN is not set — refusing all internal requests')
    res.status(401).json({
      error: {
        code: ERROR_CODES.UNAUTHORIZED,
        message: 'Internal authentication is not configured on this server',
      },
    })
    return
  }

  const header = req.get('authorization') ?? ''
  const token = header.startsWith('Bearer ') ? header.slice('Bearer '.length) : ''

  if (!token || !constantTimeEquals(token, expected)) {
    res.status(401).json({
      error: { code: ERROR_CODES.UNAUTHORIZED, message: 'Valid internal credentials required' },
    })
    return
  }

  // Which approver is acting is recorded on every VideoApproval row.
  const approverEmail = req.get('x-approver-email')?.trim()
  if (!approverEmail) {
    res.status(401).json({
      error: {
        code: ERROR_CODES.UNAUTHORIZED,
        message: 'X-Approver-Email header is required so the decision can be attributed',
      },
    })
    return
  }

  req.approverEmail = approverEmail
  next()
}

/** Compare without leaking length or content through timing. */
function constantTimeEquals(a: string, b: string): boolean {
  const bufferA = Buffer.from(a)
  const bufferB = Buffer.from(b)
  if (bufferA.length !== bufferB.length) return false
  return timingSafeEqual(bufferA, bufferB)
}
