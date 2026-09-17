import { AppError, ERROR_CODES, type QueryBuilderResponse } from '@capella/types'

/**
 * AEM Query Builder + Assets REST client (Phase 2, read-only).
 *
 * Every call runs as `capella-dam-audit-svc` against the AUTHOR instance.
 * This client never writes — video intake writes go through
 * `aemUploadService.ts` under a separate, write-scoped account.
 *
 * Callers must gate on `config.aemApiEnabled` before constructing this.
 */

export interface AemClientOptions {
  authorHost: string
  username: string
  password: string
  /** Content root for page queries. */
  pagePath?: string
  timeoutMs?: number
}

const DEFAULT_PAGE_PATH = '/content/capella/en'
const DEFAULT_TIMEOUT_MS = 30_000

/**
 * The Query Builder servlet silently truncates to 10 hits when `p.limit` is
 * absent — the single most common way to get quietly wrong results. Every
 * builder below therefore takes `limit` as a required argument, and
 * `buildQuery` asserts it was set. There is deliberately no way to issue a
 * query through this client without one.
 */
export function buildQuery(params: Record<string, string>): URLSearchParams {
  if (!params['p.limit']) {
    throw new AppError(
      ERROR_CODES.VALIDATION_FAILED,
      'Query Builder call is missing p.limit — results would be silently truncated to 10 hits',
    )
  }
  return new URLSearchParams(params)
}

export class AemClient {
  private readonly authorHost: string
  private readonly authHeader: string
  private readonly pagePath: string
  private readonly timeoutMs: number

  constructor(options: AemClientOptions) {
    this.authorHost = options.authorHost.replace(/\/$/, '')
    this.authHeader = `Basic ${Buffer.from(`${options.username}:${options.password}`).toString('base64')}`
    this.pagePath = options.pagePath ?? DEFAULT_PAGE_PATH
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  }

  // ─── Query builders (pure — unit tested without network) ───────────────────

  /** Pages referencing a specific asset, via the `fileReference` property. */
  static pagesReferencingAssetQuery(assetPath: string, limit: number, pagePath = DEFAULT_PAGE_PATH) {
    return buildQuery({
      path: pagePath,
      type: 'nt:base',
      property: 'fileReference',
      'property.value': assetPath,
      'p.limit': String(limit),
      'p.hits': 'selective',
      'p.properties': 'path jcr:content/jcr:title jcr:content/cq:lastReplicated',
      'p.guessTotal': 'true',
    })
  }

  /** All pages, most recently modified first. */
  static pagesByLastModifiedQuery(offset: number, limit: number, pagePath = DEFAULT_PAGE_PATH) {
    return buildQuery({
      type: 'cq:Page',
      path: pagePath,
      orderby: '@jcr:content/cq:lastModified',
      'orderby.sort': 'desc',
      'p.offset': String(offset),
      'p.limit': String(limit),
      'p.hits': 'selective',
      'p.properties': 'path jcr:content/jcr:title jcr:content/cq:lastReplicated',
      // Exact count up to 100, then `more: true` — what the UI pager needs.
      'p.guessTotal': '100',
    })
  }

  /** Pages carrying a given program tag. */
  static pagesByProgramTagQuery(programId: string, limit: number, pagePath = DEFAULT_PAGE_PATH) {
    return buildQuery({
      type: 'cq:Page',
      path: pagePath,
      tagid: `programs/${programId}`,
      'tagid.property': 'jcr:content/cq:tags',
      'p.limit': String(limit),
      'p.hits': 'selective',
      'p.properties': 'path jcr:content/jcr:title',
      'p.guessTotal': 'true',
    })
  }

  /**
   * All testimonial component nodes.
   *
   * This is the one place `p.hits=full` is justified: we need every property on
   * the node to map a component to quote, name and program, and we don't know
   * the property names ahead of time. It is bounded by `p.limit` and runs as a
   * background reindex, never on a user request path.
   */
  static testimonialComponentsQuery(limit: number, pagePath = DEFAULT_PAGE_PATH) {
    return buildQuery({
      path: pagePath,
      type: 'nt:base',
      nodename: 'testimonial',
      'p.limit': String(limit),
      'p.hits': 'full',
    })
  }

  /** Several content roots at once, OR'd together. */
  static pagesInAnyPathQuery(paths: string[], limit: number) {
    const params: Record<string, string> = {
      'group.p.or': 'true',
      type: 'cq:Page',
      'p.limit': String(limit),
      'p.hits': 'selective',
      'p.properties': 'path jcr:content/jcr:title',
      'p.guessTotal': 'true',
    }
    // Repeated predicates need numeric prefixes: group.1_path, group.2_path, ...
    paths.forEach((path, index) => {
      params[`group.${index + 1}_path`] = path
    })
    return buildQuery(params)
  }

  // ─── Requests ──────────────────────────────────────────────────────────────

  private async request<T>(path: string): Promise<T> {
    let response: Response
    try {
      response = await fetch(`${this.authorHost}${path}`, {
        headers: { Authorization: this.authHeader, Accept: 'application/json' },
        signal: AbortSignal.timeout(this.timeoutMs),
      })
    } catch (error) {
      throw new AppError(
        ERROR_CODES.AEM_REQUEST_FAILED,
        `AEM request failed: ${error instanceof Error ? error.message : String(error)}`,
      )
    }

    if (response.status === 401 || response.status === 403) {
      throw new AppError(
        ERROR_CODES.AEM_REQUEST_FAILED,
        `AEM rejected the audit service account (HTTP ${response.status}) — check capella-dam-audit-svc permissions and dispatcher rules`,
      )
    }

    if (!response.ok) {
      throw new AppError(ERROR_CODES.AEM_REQUEST_FAILED, `AEM returned HTTP ${response.status}`)
    }

    return (await response.json()) as T
  }

  async query(params: URLSearchParams): Promise<QueryBuilderResponse> {
    return this.request<QueryBuilderResponse>(`/bin/querybuilder.json?${params.toString()}`)
  }

  /** Pages referencing an asset. Returns paths plus replication timestamps. */
  async findPagesReferencingAsset(
    assetPath: string,
    limit = 500,
  ): Promise<Array<{ path: string; title: string | null; lastReplicated: string | null }>> {
    const response = await this.query(
      AemClient.pagesReferencingAssetQuery(assetPath, limit, this.pagePath),
    )

    return response.hits.map((hit) => ({
      path: hit.path,
      title: asString(hit['jcr:content/jcr:title']),
      lastReplicated: asString(hit['jcr:content/cq:lastReplicated']),
    }))
  }

  /**
   * Asset metadata via the Assets REST API — dimensions, tags, size.
   * `assetPath` is a full DAM path: /content/dam/capella/images/hero.jpg
   */
  async getAssetMetadata(assetPath: string): Promise<AemAssetMetadata | null> {
    const relative = assetPath.replace(/^\/content\/dam\//, '')
    try {
      const json = await this.request<AemAssetApiResponse>(`/api/assets/${relative}.json`)
      const metadata = json.properties?.metadata ?? {}
      return {
        width: asNumber(metadata['tiff:ImageWidth']),
        height: asNumber(metadata['tiff:ImageLength']),
        fileSize: asNumber(json.properties?.['dam:size']),
        tags: asStringArray(metadata['cq:tags']),
        title: asString(metadata['dc:title']),
      }
    } catch (error) {
      // A missing asset is a legitimate answer, not an outage.
      if (error instanceof AppError && error.message.includes('HTTP 404')) return null
      throw error
    }
  }

  /**
   * Authoritative publish status: a page is published if `cq:lastReplicated`
   * is set on its jcr:content node.
   */
  async getPublishStatus(pagePath: string): Promise<{ isPublished: boolean; lastReplicated: string | null }> {
    const response = await this.query(
      buildQuery({
        path: pagePath,
        type: 'cq:Page',
        'p.limit': '1',
        'p.hits': 'selective',
        'p.properties': 'path jcr:content/cq:lastReplicated',
      }),
    )

    const lastReplicated = asString(response.hits[0]?.['jcr:content/cq:lastReplicated'])
    return { isPublished: lastReplicated !== null, lastReplicated }
  }
}

export interface AemAssetMetadata {
  width: number | null
  height: number | null
  fileSize: number | null
  tags: string[]
  title: string | null
}

interface AemAssetApiResponse {
  properties?: {
    'dam:size'?: unknown
    metadata?: Record<string, unknown>
  }
}

// ─── Narrowing helpers — AEM property types are not guaranteed ───────────────

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

function asNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string') {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

function asStringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((entry): entry is string => typeof entry === 'string')
  if (typeof value === 'string') return [value]
  return []
}
