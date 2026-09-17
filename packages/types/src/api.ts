import type { ErrorCode } from './errors.js'

/** Pagination envelope. Default limit 50, max 200 (see architecture rules). */
export interface PaginationMeta {
  page: number
  limit: number
  total: number
}

export const DEFAULT_PAGE_LIMIT = 50
export const MAX_PAGE_LIMIT = 200

export interface ApiErrorBody {
  code: ErrorCode
  message: string
  details?: unknown
}

/**
 * Every API response uses this shape — never a bare object.
 * Exactly one of `data` / `error` is present.
 */
export interface ApiResponse<T> {
  data?: T
  error?: ApiErrorBody
  meta?: PaginationMeta
}

export interface PaginatedResponse<T> {
  data: T[]
  meta: PaginationMeta
}

export interface PaginationQuery {
  page: number
  limit: number
}

export function paginationMeta(page: number, limit: number, total: number): PaginationMeta {
  return { page, limit, total }
}

export function offsetFor(page: number, limit: number): number {
  return (page - 1) * limit
}
