import type { Response } from 'express'
import {
  AppError,
  DEFAULT_PAGE_LIMIT,
  ERROR_CODES,
  MAX_PAGE_LIMIT,
  type ErrorCode,
  type PaginationMeta,
} from '@capella/types'

/**
 * Response helpers. Every route replies through these so the
 * `{ data, error, meta }` contract holds without each handler restating it.
 */

export function ok<T>(res: Response, data: T, meta?: PaginationMeta): Response {
  return res.status(200).json(meta ? { data, meta } : { data })
}

export function created<T>(res: Response, data: T): Response {
  return res.status(201).json({ data })
}

export function accepted<T>(res: Response, data: T): Response {
  return res.status(202).json({ data })
}

export function fail(
  res: Response,
  status: number,
  code: ErrorCode,
  message: string,
  details?: unknown,
): Response {
  return res.status(status).json({ error: { code, message, ...(details ? { details } : {}) } })
}

/**
 * A Phase 2/3 feature was called while its flag is off. Returns 501 with a
 * structured error — never throws, so the UI can show a graceful message.
 */
export function notConfigured(res: Response, code: ErrorCode, message: string): Response {
  return fail(res, 501, code, message)
}

export function notFound(res: Response, code: ErrorCode, message: string): Response {
  return fail(res, 404, code, message)
}

/** Parse `?page` / `?limit`, clamped to the documented bounds. */
export function parsePagination(query: Record<string, unknown>): { page: number; limit: number; offset: number } {
  const rawPage = Number(query['page'])
  const rawLimit = Number(query['limit'])

  const page = Number.isFinite(rawPage) && rawPage >= 1 ? Math.floor(rawPage) : 1
  const limit =
    Number.isFinite(rawLimit) && rawLimit >= 1
      ? Math.min(Math.floor(rawLimit), MAX_PAGE_LIMIT)
      : DEFAULT_PAGE_LIMIT

  return { page, limit, offset: (page - 1) * limit }
}

/** Narrow an untrusted query value to one of a known set. */
export function parseEnum<T extends string>(
  value: unknown,
  allowed: readonly T[],
): T | undefined {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : undefined
}

export function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new AppError(ERROR_CODES.VALIDATION_FAILED, `${field} is required`)
  }
  return value.trim()
}
