import {
  PHASH_SKIP_LABELS,
  normalizeAssetPath,
  parseSearchTerms,
  type PhashSkipReason,
} from '@capella/types'

/**
 * Serve the UI from a snapshot instead of an API.
 *
 * Built for a specific constraint: the machine this was developed on is being
 * decommissioned and there is no budget for hosting. The tool proper needs a
 * persistent worker driving headless Chromium plus a Postgres and a Redis that
 * survive restarts, and no free tier provides that. But everything the index
 * already knows is static, and a static host serves it for nothing, forever.
 *
 * This implements the same request surface the real client exposes, so no page
 * or hook changes. What it deliberately does NOT do:
 *
 *   - run audits, or anything else that writes
 *   - semantic search: the embeddings are 2.6MB of 384-float vectors that a
 *     browser cannot use without the model, so they are not shipped. Search
 *     here is term matching only, and `matchReasons` says `exact` honestly
 *     rather than implying a meaning-based hit that did not happen.
 *   - reverse image search: perceptual hashing needs to decode the uploaded
 *     image server-side.
 *
 * Anything unsupported returns the same structured 501 the real API uses for
 * gated features, so the UI shows its existing explanatory notice rather than
 * an error.
 */

interface StaticAsset {
  id: string
  aemPath: string
  filename: string
  assetType: string
  fileSize: number | null
  width: number | null
  height: number | null
  phash: string | null
  phashAlt: string | null
  /** Absent in snapshots built before the tool recorded this. */
  phashSkipReason?: string | null
  lastSeenAt: string | null
  lastVerifiedAt: string | null
  lastVerifiedStatus: number | null
}

interface StaticPage {
  id: string
  url: string
  title: string | null
  isPublished: boolean
  crawledAt: string | null
}

interface StaticTestimonial {
  id: string
  quoteText: string
  studentName: string | null
  program: string | null
  degreeLevel: string | null
  sourceType: string
  needsReview: boolean
  firstSeenAt: string
  lastSeenAt: string
}

interface StaticPayload {
  generatedAt: string
  assets: StaticAsset[]
  pages: StaticPage[]
  testimonials: StaticTestimonial[]
  assetPageReferences: Array<{ assetId: string; pageId: string; discoveredAt: string | null }>
  testimonialPageReferences: Array<{
    testimonialId: string
    pageId: string
    discoveredAt: string | null
  }>
  auditJobs: Array<Record<string, unknown>>
  auditJobUrls: Array<{
    id: string
    jobId: string
    url: string
    status: string
    error: string | null
    assetCount: number | null
    testimonialCount: number | null
    pageTitle: string | null
    isPublished: boolean | null
    processedAt: string | null
  }>
}

/** The public host is only used to build preview URLs; no request is made to it. */
const AEM_PUBLIC_HOST = 'https://www.capella.edu'

let cache: Promise<StaticPayload> | null = null

/**
 * Drop the loaded snapshot so the next read fetches the new one.
 *
 * Called when an audit started from this page has finished and the site has
 * rebuilt with its findings, so they appear without a manual reload.
 */
export function reloadStaticData(): void {
  cache = null
}

function load(): Promise<StaticPayload> {
  // Fetched once and reused. A rejected promise is cleared so a transient
  // network failure on first load does not permanently break the page.
  cache ??= fetch(`${import.meta.env.BASE_URL}data/index.json`, { cache: 'no-cache' })
    .then((response) => {
      if (!response.ok) throw new Error(`Snapshot unavailable (HTTP ${response.status})`)
      return response.json() as Promise<StaticPayload>
    })
    .catch((error: unknown) => {
      cache = null
      throw error
    })

  return cache
}

export class StaticUnsupportedError extends Error {
  readonly code = 'STATIC_SNAPSHOT'
  readonly status = 501
  constructor(what: string) {
    super(
      `${what} needs the live API. This is a read-only snapshot of a real audit — ` +
        `browsing, search and the page maps all work, but anything that crawls or ` +
        `writes needs the backend running. See docs/deploy-runbook.md.`,
    )
  }
}

function paginate<T>(rows: T[], query: URLSearchParams): { data: T[]; meta: { page: number; limit: number; total: number } } {
  const page = Math.max(1, Number(query.get('page') ?? 1))
  const limit = Math.min(200, Math.max(1, Number(query.get('limit') ?? 50)))
  const start = (page - 1) * limit

  return { data: rows.slice(start, start + limit), meta: { page, limit, total: rows.length } }
}

/** Term matching over the given fields — the same splitting rule the API uses. */
function matches(query: string, fields: Array<string | null>): boolean {
  const haystack = fields.filter(Boolean).join(' ').toLowerCase()
  return parseSearchTerms(query).every((term) => haystack.includes(term.toLowerCase()))
}

/**
 * The page list, in the shape the API returns it.
 *
 * `pages`, not `references` — this adapter used the wrong key, so every asset
 * and testimonial detail page rendered an empty list. The link between an asset
 * and the URLs it appears on is the whole point of the tool, and it was the one
 * thing the snapshot did not show.
 */
function pagesFor(
  db: StaticPayload,
  ids: Array<{ pageId: string; discoveredAt: string | null }>,
): Array<Record<string, unknown>> {
  const byId = new Map(db.pages.map((page) => [page.id, page]))

  const rows: Array<Record<string, unknown>> = []

  for (const ref of ids) {
    const page = byId.get(ref.pageId)
    if (!page) continue

    rows.push({
      pageId: page.id,
      url: page.url,
      title: page.title,
      // The snapshot records only what the crawl concluded, and `unknown` is
      // the honest value for anything it could not confirm — same as the API.
      liveStatus: page.isPublished ? 'published' : 'unknown',
      lastCrawledAt: page.crawledAt,
      discoveredAt: ref.discoveredAt,
    })
  }

  return rows
}

function testimonialOut(t: StaticTestimonial, refCount: number): Record<string, unknown> {
  const days = Math.floor((Date.now() - new Date(t.lastSeenAt).getTime()) / 86_400_000)
  return {
    ...t,
    referenceCount: refCount,
    daysSinceLastSeen: days,
    isActive: days <= 90,
    matchReasons: [],
  }
}

function assetOut(asset: StaticAsset, refCount: number): Record<string, unknown> {
  return {
    ...asset,
    publicUrl: `${AEM_PUBLIC_HOST}${asset.aemPath}`,
    referenceCount: refCount,
    matchReasons: [],
    tags: [],
  }
}

export async function staticGet(
  path: string,
): Promise<{ data: unknown; meta?: { page: number; limit: number; total: number } }> {
  const [rawPath, rawQuery = ''] = path.split('?')
  const query = new URLSearchParams(rawQuery)
  const p = rawPath ?? ''
  const db = await load()

  const refCounts = new Map<string, number>()
  for (const ref of db.assetPageReferences) {
    refCounts.set(ref.assetId, (refCounts.get(ref.assetId) ?? 0) + 1)
  }

  // ── Assets ────────────────────────────────────────────────────────────────
  if (p === '/assets/stats') {
    return {
      data: {
        totalAssets: db.assets.length,
        totalPages: db.pages.length,
        publishedPages: db.pages.filter((page) => page.isPublished).length,
      },
    }
  }

  if (p === '/assets/verification') {
    const checked = db.assets.filter((a) => a.lastVerifiedAt !== null)
    return {
      data: {
        total: db.assets.length,
        checked: checked.length,
        live: checked.filter((a) => (a.lastVerifiedStatus ?? 0) >= 200 && (a.lastVerifiedStatus ?? 0) < 400).length,
        missing: checked.filter((a) => (a.lastVerifiedStatus ?? 0) >= 400).length,
        oldestCheck: checked.length > 0 ? checked.map((a) => a.lastVerifiedAt).sort()[0] : null,
        newestCheck: checked.length > 0 ? checked.map((a) => a.lastVerifiedAt).sort().reverse()[0] : null,
        everyDays: 3,
      },
    }
  }

  if (p === '/assets/missing') {
    const missing = db.assets.filter((a) => (a.lastVerifiedStatus ?? 0) >= 400)
    return { data: missing.map((a) => assetOut(a, refCounts.get(a.id) ?? 0)) }
  }

  if (p === '/assets') {
    const search = query.get('query')?.trim()
    const type = query.get('assetType')

    let rows = db.assets
    if (type) rows = rows.filter((a) => a.assetType === type)
    if (search) rows = rows.filter((a) => matches(search, [a.filename, a.aemPath]))

    const { data, meta } = paginate(rows, query)
    return { data: data.map((a) => assetOut(a, refCounts.get(a.id) ?? 0)), meta }
  }

  if (p.startsWith('/assets/')) {
    const id = p.slice('/assets/'.length)
    const asset = db.assets.find((a) => a.id === id)
    if (!asset) throw new StaticUnsupportedError('That asset')

    const refs = db.assetPageReferences.filter((r) => r.assetId === id)
    return { data: { ...assetOut(asset, refs.length), pages: pagesFor(db, refs) } }
  }

  // ── Reverse lookup ────────────────────────────────────────────────────────
  //
  // The tool's headline question — "where is this asset used?" — and the one
  // thing the snapshot could not answer, because this path was never handled.
  // It returned a 501 while the banner promised the page maps worked.
  if (p === '/lookup') {
    const raw = query.get('path')?.trim()
    if (!raw) throw new StaticUnsupportedError('A lookup without a path')

    // The same normalizer the API uses, from @capella/types: a public URL, a
    // rendition URL and a bare DAM path must all resolve to one asset, and a
    // second implementation here would drift from the one being tested.
    const aemPath = normalizeAssetPath(raw)
    if (aemPath === null) {
      throw new StaticUnsupportedError(
        `"${raw.slice(0, 60)}" is not a DAM asset path, so lookup`,
      )
    }

    const asset = db.assets.find((a) => a.aemPath === aemPath)
    if (!asset) {
      throw new StaticUnsupportedError(
        `${aemPath} is not in this snapshot — it may exist but sit on a page nobody audited, so lookup`,
      )
    }

    const refs = db.assetPageReferences.filter((r) => r.assetId === asset.id)
    return { data: { ...assetOut(asset, refs.length), pages: pagesFor(db, refs) } }
  }

  // ── Testimonials ──────────────────────────────────────────────────────────
  if (p === '/testimonials/stats') {
    const now = Date.now()
    return {
      data: {
        totalTestimonials: db.testimonials.length,
        needingReview: db.testimonials.filter((t) => t.needsReview).length,
        stale: db.testimonials.filter(
          (t) => now - new Date(t.lastSeenAt).getTime() > 90 * 24 * 60 * 60 * 1000,
        ).length,
      },
    }
  }

  if (p === '/testimonials/search-index') {
    // Zero embedded, stated plainly — the UI's coverage notice then explains
    // that meaning-based matching is unavailable rather than quietly missing.
    return {
      data: {
        testimonials: { total: db.testimonials.length, embedded: 0 },
        assets: { total: db.assets.length, embedded: 0 },
        model: 'not available in the static snapshot',
        enabled: false,
      },
    }
  }

  if (p === '/testimonials') {
    const search = query.get('query')?.trim()
    let rows = db.testimonials
    if (query.get('needsReview') === 'true') rows = rows.filter((t) => t.needsReview)
    if (query.get('sourceType')) rows = rows.filter((t) => t.sourceType === query.get('sourceType'))
    if (search) rows = rows.filter((t) => matches(search, [t.quoteText, t.studentName, t.program]))

    const { data, meta } = paginate(rows, query)
    const testimonialRefCounts = new Map<string, number>()
    for (const ref of db.testimonialPageReferences) {
      testimonialRefCounts.set(ref.testimonialId, (testimonialRefCounts.get(ref.testimonialId) ?? 0) + 1)
    }

    return {
      data: data.map((t) => testimonialOut(t, testimonialRefCounts.get(t.id) ?? 0)),
      meta,
    }
  }

  if (p.startsWith('/testimonials/')) {
    const id = p.slice('/testimonials/'.length)
    const testimonial = db.testimonials.find((t) => t.id === id)
    if (!testimonial) throw new StaticUnsupportedError('That testimonial')

    const refs = db.testimonialPageReferences.filter((r) => r.testimonialId === id)
    return {
      data: {
        ...testimonialOut(testimonial, refs.length),
        rawHtml: null,
        aemComponentPath: null,
        quoteFingerprint: null,
        deletedAt: null,
        pages: pagesFor(db, refs),
      },
    }
  }

  // ── Audits ────────────────────────────────────────────────────────────────
  if (p === '/audit') return { data: db.auditJobs }

  // A job page and its failures, so the dashboard's "N URLs could not be
  // scraped" leads somewhere rather than to a 501.
  const jobMatch = /^\/audit\/([^/]+)(\/[a-z]+)?$/.exec(p)
  if (jobMatch) {
    const jobId = jobMatch[1] as string
    const section = jobMatch[2] ?? ''
    const job = db.auditJobs.find((j) => j['id'] === jobId)
    if (!job) throw new StaticUnsupportedError('That audit')

    const rows = db.auditJobUrls.filter((u) => u.jobId === jobId)

    if (section === '/status') {
      const processed = Number(job['completedUrls'] ?? 0) + Number(job['failedUrls'] ?? 0)
      const total = Number(job['totalUrls'] ?? 0)
      return {
        data: {
          jobId,
          status: job['status'],
          totalUrls: total,
          completedUrls: job['completedUrls'],
          failedUrls: job['failedUrls'],
          percentComplete: total === 0 ? 0 : Math.round((processed / total) * 100),
          estimatedMinutesRemaining: null,
          startedAt: job['createdAt'],
          completedAt: job['completedAt'],
          errorMessage: job['errorMessage'] ?? null,
        },
      }
    }

    if (section === '/failures') {
      return { data: rows.filter((u) => u.status === 'failed') }
    }

    if (section === '/results' || section === '') {
      const done = rows.filter((u) => u.status !== 'failed')
      const { data, meta } = paginate(done, query)
      return {
        data: data.map((u) => ({
          url: u.url,
          pageTitle: u.pageTitle,
          liveStatus: u.isPublished === null ? 'unknown' : u.isPublished ? 'published' : 'draft',
          urlStatus: u.status,
          assetCount: u.assetCount ?? 0,
          testimonialCount: u.testimonialCount ?? 0,
          processedAt: u.processedAt,
          error: u.error,
        })),
        meta,
      }
    }
  }

  // ── Duplicates ────────────────────────────────────────────────────────────
  if (p === '/duplicates') {
    return { data: { groups: groupDuplicates(db.assets), coverage: imageCoverage(db) } }
  }

  if (p === '/lookup/image/coverage') {
    return { data: imageCoverage(db) }
  }

  if (p === '/lookup/image/unhashable') {
    return {
      data: db.assets
        .filter(isUnhashableImage)
        .map((a) => ({
          aemPath: a.aemPath,
          filename: a.filename,
          reason: a.phashSkipReason,
          label: PHASH_SKIP_LABELS[a.phashSkipReason as PhashSkipReason] ?? a.phashSkipReason,
        }))
        .sort((a, b) => a.aemPath.localeCompare(b.aemPath)),
    }
  }

  throw new StaticUnsupportedError('That view')
}

export function staticPost(): never {
  throw new StaticUnsupportedError('Running an audit')
}

/**
 * Group visually identical images.
 *
 * A straight port of the server's rule — Hamming distance over whichever hashes
 * both images have, threshold 10 — so the static view groups exactly what the
 * live tool would. Quadratic, but over a few hundred images in a browser that
 * is milliseconds.
 */
/** An image tried and found impossible to fingerprint — see PHASH_SKIP_REASONS. */
function isUnhashableImage(asset: StaticAsset): boolean {
  return (
    asset.assetType === 'image' &&
    asset.phash === null &&
    asset.phashAlt === null &&
    Boolean(asset.phashSkipReason)
  )
}

/**
 * The same three numbers the live API reports, computed from the snapshot.
 *
 * `unhashableImages` is what lets the static site say "everything that can be
 * fingerprinted has been" rather than showing a shortfall it cannot explain.
 */
function imageCoverage(db: StaticPayload): {
  totalImages: number
  hashedImages: number
  unhashableImages: number
} {
  const images = db.assets.filter((a) => a.assetType === 'image')
  return {
    totalImages: images.length,
    hashedImages: images.filter((a) => a.phash !== null || a.phashAlt !== null).length,
    unhashableImages: images.filter(isUnhashableImage).length,
  }
}

function groupDuplicates(assets: StaticAsset[]): Array<Record<string, unknown>> {
  const images = assets.filter((a) => a.assetType === 'image' && (a.phash ?? a.phashAlt))
  const seen = new Set<string>()
  const groups: Array<Record<string, unknown>> = []

  for (const asset of images) {
    if (seen.has(asset.id)) continue

    const members = images.filter(
      (other) => !seen.has(other.id) && (other.id === asset.id || bestDistance(asset, other) <= 10),
    )
    if (members.length < 2) continue

    for (const member of members) seen.add(member.id)
    groups.push({
      assets: members.map((m) => ({
        ...m,
        publicUrl: `${AEM_PUBLIC_HOST}${m.aemPath}`,
        referenceCount: 0,
      })),
      maxDistance: Math.max(...members.map((m) => bestDistance(asset, m))),
    })
  }

  return groups
}

function bestDistance(a: StaticAsset, b: StaticAsset): number {
  let best = Infinity
  for (const left of [a.phash, a.phashAlt]) {
    for (const right of [b.phash, b.phashAlt]) {
      if (left === null || right === null) continue
      const distance = hamming(left, right)
      if (distance < best) best = distance
    }
  }
  return best
}

function hamming(a: string, b: string): number {
  if (a.length !== b.length) return Infinity

  let bits = 0
  for (let i = 0; i < a.length; i += 1) {
    const left = Number.parseInt(a[i] as string, 16)
    const right = Number.parseInt(b[i] as string, 16)
    if (Number.isNaN(left) || Number.isNaN(right)) return Infinity

    let diff = left ^ right
    while (diff > 0) {
      bits += diff & 1
      diff >>= 1
    }
  }
  return bits
}
