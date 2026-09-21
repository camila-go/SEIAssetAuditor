import type { ApiErrorBody, PaginationMeta } from '@capella/types'

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
const API_ORIGIN = (import.meta.env.VITE_API_ORIGIN ?? '').replace(/\/+$/, '')

/** Absolute URL for an API path. Needed wherever the browser, not `fetch`,
 * does the request: `<a href>` downloads, `<video src>`, form posts. Those
 * cannot be relative once the API is on another origin. */
export function apiUrl(path: string): string {
  return `${API_ORIGIN}/api/v1${path.startsWith('/') ? path : `/${path}`}`
}

const BASE_URL = `${API_ORIGIN}/api/v1`

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
}

interface Envelope<T> {
  data?: T
  error?: ApiErrorBody
  meta?: PaginationMeta
}

async function parse<T>(response: Response): Promise<Envelope<T>> {
  const text = await response.text()
  if (!text) return {}

  try {
    return JSON.parse(text) as Envelope<T>
  } catch {
    return {
      error: {
        code: 'INTERNAL_ERROR',
        message: `Server returned a non-JSON response (HTTP ${response.status})`,
      } as ApiErrorBody,
    }
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<{ data: T; meta?: PaginationMeta }> {
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
      envelope.error ?? { code: 'INTERNAL_ERROR', message: `HTTP ${response.status}` },
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
