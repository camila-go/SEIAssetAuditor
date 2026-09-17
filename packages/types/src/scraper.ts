import type { TestimonialSourceType } from './domain.js'

/** A testimonial as extracted from the DOM, before normalization or dedup. */
export interface RawTestimonial {
  quoteText: string
  studentName: string | null
  program: string | null
  rawHtml: string
  sourceType: TestimonialSourceType
  /** Index of the match within the page, in document order. */
  positionOnPage: number
}

/** Everything one page visit yields. Assets and testimonials come from a single pass. */
export interface ScrapedPage {
  url: string
  title: string | null
  /** Distinct `/content/dam/capella/...` paths, leading slash preserved. */
  assetPaths: string[]
  testimonials: RawTestimonial[]
  /**
   * Phase 1 heuristic only — derived from scraped signals (HTTP status, noindex,
   * AEM wcmmode markers). Phase 2 replaces this with cq:lastReplicated.
   */
  isPublished: boolean | null
}

export interface ScrapeFailure {
  url: string
  error: string
}

export type ScrapeOutcome =
  | { ok: true; page: ScrapedPage }
  | { ok: false; failure: ScrapeFailure }

export interface ScraperConfig {
  concurrency: number
  pageTimeoutMs: number
  userAgent: string
  /** Delay between page navigations within a batch, in ms. */
  politenessDelayMs: number
  /**
   * Extra time after `load` to let late-rendering components settle, in ms.
   * Best effort — the page is scraped whether or not the network goes quiet.
   */
  settleMs: number
}

/** Raw hit shape returned by the AEM Query Builder JSON servlet. */
export interface QueryBuilderHit {
  path: string
  [property: string]: unknown
}

export interface QueryBuilderResponse {
  success: boolean
  results: number
  total: number
  /** Present when `p.guessTotal` is used and more results exist beyond the limit. */
  more?: boolean
  offset: number
  hits: QueryBuilderHit[]
}
