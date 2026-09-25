/**
 * Canonical error codes. Every `{ error: { code, message } }` response uses one
 * of these — the UI switches on `code`, never on `message`.
 */
export const ERROR_CODES = {
  // Validation
  VALIDATION_FAILED: 'VALIDATION_FAILED',
  NO_URLS_PROVIDED: 'NO_URLS_PROVIDED',
  INVALID_URL: 'INVALID_URL',
  INVALID_SITEMAP: 'INVALID_SITEMAP',
  INVALID_ASSET_PATH: 'INVALID_ASSET_PATH',
  FILE_TOO_LARGE: 'FILE_TOO_LARGE',
  UNSUPPORTED_MEDIA_TYPE: 'UNSUPPORTED_MEDIA_TYPE',

  // Not found
  NOT_FOUND: 'NOT_FOUND',
  JOB_NOT_FOUND: 'JOB_NOT_FOUND',
  ASSET_NOT_FOUND: 'ASSET_NOT_FOUND',
  TESTIMONIAL_NOT_FOUND: 'TESTIMONIAL_NOT_FOUND',
  SUBMISSION_NOT_FOUND: 'SUBMISSION_NOT_FOUND',
  LEGAL_DOC_NOT_FOUND: 'LEGAL_DOC_NOT_FOUND',

  // Intake / legal
  LEGAL_AGREEMENT_REQUIRED: 'LEGAL_AGREEMENT_REQUIRED',
  ALREADY_DECIDED: 'ALREADY_DECIDED',
  INVALID_STATE_TRANSITION: 'INVALID_STATE_TRANSITION',
  NOT_REJECTED: 'NOT_REJECTED',

  // Auth
  UNAUTHORIZED: 'UNAUTHORIZED',
  FORBIDDEN: 'FORBIDDEN',

  // Phase gating — returned as 501, never thrown
  AEM_API_NOT_CONFIGURED: 'AEM_API_NOT_CONFIGURED',
  AEM_INTAKE_NOT_CONFIGURED: 'AEM_INTAKE_NOT_CONFIGURED',
  SOCIAL_NOT_CONFIGURED: 'SOCIAL_NOT_CONFIGURED',
  TRANSCRIPTION_NOT_CONFIGURED: 'TRANSCRIPTION_NOT_CONFIGURED',

  // Upstream
  AEM_REQUEST_FAILED: 'AEM_REQUEST_FAILED',
  AEM_UPLOAD_FAILED: 'AEM_UPLOAD_FAILED',
  SITEMAP_FETCH_FAILED: 'SITEMAP_FETCH_FAILED',
  TRANSCRIPTION_FAILED: 'TRANSCRIPTION_FAILED',

  // Generic
  RATE_LIMITED: 'RATE_LIMITED',
  INTERNAL_ERROR: 'INTERNAL_ERROR',

  /**
   * Raised by the UI, never by the API — the API cannot report that it is
   * absent. Set when a response is plainly not this API: HTML from a static
   * host's SPA fallback, or a 405 because that host only allows GET and HEAD.
   * Both mean the interface is deployed and the backend is not.
   */
  API_NOT_REACHABLE: 'API_NOT_REACHABLE',

  /** Read-only snapshot build: the feature needs the live API. */
  STATIC_SNAPSHOT: 'STATIC_SNAPSHOT',
} as const

export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES]

/** Default HTTP status for each code. Used by the error handler. */
export const ERROR_STATUS: Record<ErrorCode, number> = {
  VALIDATION_FAILED: 400,
  NO_URLS_PROVIDED: 400,
  INVALID_URL: 400,
  INVALID_SITEMAP: 400,
  INVALID_ASSET_PATH: 400,
  FILE_TOO_LARGE: 413,
  UNSUPPORTED_MEDIA_TYPE: 415,

  NOT_FOUND: 404,
  JOB_NOT_FOUND: 404,
  ASSET_NOT_FOUND: 404,
  TESTIMONIAL_NOT_FOUND: 404,
  SUBMISSION_NOT_FOUND: 404,
  LEGAL_DOC_NOT_FOUND: 404,

  LEGAL_AGREEMENT_REQUIRED: 400,
  ALREADY_DECIDED: 409,
  INVALID_STATE_TRANSITION: 409,
  NOT_REJECTED: 409,

  UNAUTHORIZED: 401,
  FORBIDDEN: 403,

  AEM_API_NOT_CONFIGURED: 501,
  AEM_INTAKE_NOT_CONFIGURED: 501,
  SOCIAL_NOT_CONFIGURED: 501,
  TRANSCRIPTION_NOT_CONFIGURED: 501,

  AEM_REQUEST_FAILED: 502,
  AEM_UPLOAD_FAILED: 502,
  SITEMAP_FETCH_FAILED: 502,
  TRANSCRIPTION_FAILED: 502,

  RATE_LIMITED: 429,
  INTERNAL_ERROR: 500,
  // Client-side only; the status is whatever the static host gave us.
  API_NOT_REACHABLE: 503,
  STATIC_SNAPSHOT: 501,
}

/**
 * The only error type route handlers should throw. The error handler
 * converts it to the standard `{ error: { code, message, details } }` shape.
 */
export class AppError extends Error {
  readonly code: ErrorCode
  readonly status: number
  readonly details?: unknown

  constructor(code: ErrorCode, message: string, details?: unknown) {
    super(message)
    this.name = 'AppError'
    this.code = code
    this.status = ERROR_STATUS[code]
    this.details = details
  }
}
