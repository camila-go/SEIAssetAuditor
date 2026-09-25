/**
 * Running audits from the published site.
 *
 * The published site has no backend, so the crawl runs as a background job and
 * this page drives it through the site's own audit service,
 * `/api/run-audit` (see api/run-audit.mjs). The person using the tool fills in
 * the same form, presses the same Start audit button, and watches progress
 * here. They never leave the tool and never need an account anywhere else —
 * an earlier version sent them to GitHub to finish starting a run, which made
 * the Audit page unusable for exactly the people it is for.
 *
 * Everything goes through the site's own origin. Nothing here calls GitHub
 * directly: the access key lives in the function, and the browser only ever
 * sees plain status.
 */

const SERVICE_URL = (import.meta.env?.VITE_AUDIT_SERVICE_URL ?? '/api/run-audit').trim()

export type ServiceState =
  | { kind: 'ready' }
  /** Deployed, but not given its access key yet. `message` says what to do. */
  | { kind: 'not-configured'; message: string }
  /** No function at this address — the site was deployed without it. */
  | { kind: 'missing' }

export interface StartedAudit {
  startedAt: string
  totalUrls: number
}

export interface AuditProgress {
  found: boolean
  id?: number
  title?: string
  status?: 'queued' | 'in_progress' | 'completed' | 'waiting' | 'pending'
  conclusion?: 'success' | 'failure' | 'cancelled' | null
  startedAt?: string
  updatedAt?: string
  /** Plain-language stage, e.g. "Scraping pages". */
  phase?: string
}

export interface RecentAudit {
  id: number
  title: string
  status: string
  conclusion: string | null
  startedAt: string
  scheduled: boolean
}

export class AuditServiceError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AuditServiceError'
  }
}

async function call<T>(init?: RequestInit, query = ''): Promise<T> {
  let response: Response
  try {
    response = await fetch(`${SERVICE_URL}${query}`, { cache: 'no-store', ...init })
  } catch {
    throw new AuditServiceError('The audit service could not be reached. Check your connection.')
  }

  const text = await response.text()
  let body: { data?: T; error?: { code?: string; message?: string } } | null = null
  try {
    body = JSON.parse(text)
  } catch {
    body = null
  }

  if (body?.error?.message) {
    const error = new AuditServiceError(body.error.message)
    ;(error as AuditServiceError & { code?: string; status?: number }).code = body.error.code
    ;(error as AuditServiceError & { status?: number }).status = response.status
    throw error
  }
  if (!response.ok || body === null) {
    const error = new AuditServiceError(
      response.status === 404 || body === null
        ? 'This site was published without its audit service, so audits cannot start here.'
        : `The audit service returned an error (${response.status}).`,
    )
    ;(error as AuditServiceError & { status?: number }).status = body === null ? 404 : response.status
    throw error
  }
  return body.data as T
}

/** Asked once when the Audit page opens, so a problem is shown before anyone types. */
export async function checkService(): Promise<ServiceState> {
  try {
    await call<{ configured: boolean }>()
    return { kind: 'ready' }
  } catch (error) {
    const status = (error as { status?: number }).status
    if (status === 501) return { kind: 'not-configured', message: (error as Error).message }
    if (status === 404) return { kind: 'missing' }
    // A transient failure should not block the form; starting will report it.
    return { kind: 'ready' }
  }
}

export function startAudit(input: {
  urls?: string[]
  sitemapUrl?: string
  name?: string
}): Promise<StartedAudit> {
  return call<StartedAudit>({
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      urls: (input.urls ?? []).join('\n'),
      sitemapUrl: input.sitemapUrl ?? '',
      name: input.name ?? '',
    }),
  })
}

export function fetchProgress(since: string): Promise<AuditProgress> {
  return call<AuditProgress>(undefined, `?since=${encodeURIComponent(since)}`)
}

export function fetchRecentAudits(): Promise<RecentAudit[]> {
  return call<RecentAudit[]>(undefined, '?list=1')
}

/**
 * When the published findings were generated.
 *
 * A finished audit commits a new index and the site rebuilds itself, which
 * takes a few minutes. Watching this timestamp is how the page knows the new
 * findings have actually arrived, rather than telling someone to reload and
 * hope.
 */
export async function fetchSnapshotDate(): Promise<string | null> {
  try {
    const response = await fetch(`${import.meta.env.BASE_URL}data/version.json`, {
      cache: 'no-store',
    })
    if (!response.ok) return null
    const body = (await response.json()) as { generatedAt?: string }
    return body.generatedAt ?? null
  } catch {
    return null
  }
}
