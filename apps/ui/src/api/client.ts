import type { ApiErrorBody, PaginationMeta } from '@capella/types'
import { StaticUnsupportedError, staticGet, staticPost } from './staticData'

/**
 * Thin fetch wrapper enforcing the `{ data, error, meta }` contract.
 * Every non-2xx response becomes an ApiError carrying the server's code.
 */

/**
 * Where the API lives.
 *
 * Empty in development, so requests stay relative and Vite's dev proxy handles
 * them — cookies and relative URLs then behave exactly as they do in
 * production. In a split deployment (UI on a static host, API on a container
 * host) `VITE_API_ORIGIN` is set at build time to the API's origin, and the API
 * must allow that UI origin via its own `UI_ORIGIN` — the two have to agree or
 * every request fails CORS preflight.
 *
 * Trailing slashes are stripped because `https://host/` + `/api/v1` is a double
 * slash, which some proxies treat as a different path and will 404 on.
 */
const API_ORIGIN = (import.meta.env?.VITE_API_ORIGIN ?? '').replace(/\/+$/, '')

/** Absolute URL for an API path. Needed wherever the browser, not `fetch`,
 * does the request: `<a href>` downloads, `<video src>`, form posts. Those
 * cannot be relative once the API is on another origin. */
export function apiUrl(path: string): string {
  return `${API_ORIGIN}/api/v1${path.startsWith('/') ? path : `/${path}`}`
}

const BASE_URL = `${API_ORIGIN}/api/v1`

/**
 * Read-only mode, served from a committed snapshot instead of an API.
 *
 * Set at build time so a static host can publish the tool with no backend at
 * all — see scripts/build-static-data.mjs for why that is the only free,
 * always-on option for this particular tool.
 */
export const IS_STATIC = import.meta.env?.VITE_STATIC_DATA === 'true'

export class ApiError extends Error {
  readonly code: string
  readonly status: number
  readonly details?: unknown

  constructor(status: number, body: ApiErrorBody) {
    super(body.message)
    this.name = 'ApiError'
    this.status = status
    this.code = body.code
    this.details = body.details
  }

  /** A gated Phase 2/3 feature rather than a failure — the UI shows a notice, not an error. */
  get isNotConfigured(): boolean {
    return this.status === 501
  }

  /** No API at this address — a deployment problem, not a request problem. */
  get isApiUnreachable(): boolean {
    return this.code === 'API_NOT_REACHABLE'
  }
}

interface Envelope<T> {
  data?: T
  error?: ApiErrorBody
  meta?: PaginationMeta
}

/**
 * The API is not there at all — as opposed to there and unhappy.
 *
 * Two symptoms, one cause. When the UI is deployed to a static host with no
 * `VITE_API_ORIGIN`, its requests go to its own origin, where nothing serves
 * `/api`. The host then answers a GET with the SPA's own `index.html` and a
 * cheerful 200, and rejects a POST with 405 because static hosting allows only
 * GET and HEAD.
 *
 * Reported raw, those read as "Server returned a non-JSON response (HTTP 200)"
 * and "HTTP 405" — two unrelated-looking bugs that are really one missing
 * deployment. Naming it is the difference between a five-minute fix and an
 * afternoon.
 */
function looksLikeMissingApi(response: Response, body: string): boolean {
  if (response.status === 405) return true

  const contentType = response.headers.get('content-type') ?? ''
  return contentType.includes('text/html') || body.trimStart().startsWith('<!doctype')
}

const MISSING_API_MESSAGE =
  'The API is not reachable at this address. The interface is deployed but the ' +
  'backend is not — a static host cannot run the audit worker. Point VITE_API_ORIGIN ' +
  'at the deployed API and rebuild. See docs/deployment.md.'

async function parse<T>(response: Response): Promise<Envelope<T>> {
  const text = await response.text()
  if (!text) return {}

  try {
    return JSON.parse(text) as Envelope<T>
  } catch {
    return {
      error: {
        code: looksLikeMissingApi(response, text) ? 'API_NOT_REACHABLE' : 'INTERNAL_ERROR',
        message: looksLikeMissingApi(response, text)
          ? MISSING_API_MESSAGE
          : `Server returned a non-JSON response (HTTP ${response.status})`,
      } as ApiErrorBody,
    }
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<{ data: T; meta?: PaginationMeta }> {
  if (IS_STATIC) {
    try {
      const result =
        init?.method === 'POST' ? staticPost() : await staticGet(path)
      return result as { data: T; meta?: PaginationMeta }
    } catch (error) {
      // Surfaced as a 501 so the UI reuses its existing "not configured"
      // notice rather than rendering this as a failure.
      if (error instanceof StaticUnsupportedError) {
        throw new ApiError(error.status, { code: error.code, message: error.message } as ApiErrorBody)
      }
      throw error
    }
  }

  const response = await fetch(`${BASE_URL}${path}`, {
    ...init,
    headers: {
      Accept: 'application/json',
      ...(init?.body instanceof FormData ? {} : { 'Content-Type': 'application/json' }),
      ...internalAuthHeaders(),
      ...init?.headers,
    },
  })

  const envelope = await parse<T>(response)

  if (!response.ok || envelope.error) {
    throw new ApiError(
      response.status,
      envelope.error ??
        (response.status === 405
          ? ({ code: 'API_NOT_REACHABLE', message: MISSING_API_MESSAGE } as ApiErrorBody)
          : { code: 'INTERNAL_ERROR', message: `HTTP ${response.status}` }),
    )
  }

  return { data: envelope.data as T, meta: envelope.meta }
}

/**
 * Approver credentials for `/admin/*` routes.
 *
 * Placeholder pending the SSO decision in PRD §11 — held in sessionStorage so
 * it never outlives the browser session. Public intake pages never call an
 * endpoint that needs it.
 */
function internalAuthHeaders(): Record<string, string> {
  try {
    const token = sessionStorage.getItem('capella.internalToken')
    const email = sessionStorage.getItem('capella.approverEmail')
    if (!token || !email) return {}
    return { Authorization: `Bearer ${token}`, 'X-Approver-Email': email }
  } catch {
    // Private-mode browsers can throw on sessionStorage access.
    return {}
  }
}

export function setInternalCredentials(token: string, email: string): void {
  try {
    sessionStorage.setItem('capella.internalToken', token)
    sessionStorage.setItem('capella.approverEmail', email)
  } catch {
    /* storage unavailable — the user will be asked again */
  }
}

export function getApproverEmail(): string | null {
  try {
    return sessionStorage.getItem('capella.approverEmail')
  } catch {
    return null
  }
}

export function hasInternalCredentials(): boolean {
  return Boolean(internalAuthHeaders()['Authorization'])
}

export const api = {
  get: <T>(path: string): Promise<{ data: T; meta?: PaginationMeta }> => request<T>(path),

  post: <T>(path: string, body?: unknown): Promise<{ data: T; meta?: PaginationMeta }> =>
    request<T>(path, {
      method: 'POST',
      ...(body instanceof FormData
        ? { body }
        : body !== undefined
          ? { body: JSON.stringify(body) }
          : {}),
    }),
}

/** Build a query string, omitting empty values so the URL stays readable. */
export function qs(params: Record<string, string | number | boolean | undefined | null>): string {
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '' || value === false) continue
    search.set(key, String(value))
  }
  const rendered = search.toString()
  return rendered ? `?${rendered}` : ''
}
