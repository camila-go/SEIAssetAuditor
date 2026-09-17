import type { Page } from 'playwright'
import type { ScrapedPage, ScraperConfig, ScrapeOutcome } from '@capella/types'
import { getContext } from './browser.js'
import {
  DAM_ROOT,
  dedupePaths,
  extractPathsFromAttribute,
  extractPathsFromCss,
} from './extractors/assetExtractor.js'
import {
  parseCandidates,
  TESTIMONIAL_SELECTORS,
  type TestimonialCandidate,
} from './extractors/testimonialExtractor.js'

/** Attributes that can carry a DAM reference on capella.edu. */
const ASSET_ATTRIBUTES = ['src', 'srcset', 'href', 'data-src', 'data-srcset', 'data-asset-path']

const ASSET_SELECTOR =
  'img[src], img[srcset], source[src], source[srcset], a[href], link[href], [data-src], [data-srcset], [data-asset-path]'


/**
 * Scrape one page. Assets and testimonials come from a single pass over the
 * fully rendered DOM — Capella's site is JS-rendered, so a static fetch returns
 * navigation only.
 *
 * Never throws: a failure is returned as `{ ok: false }` so one bad URL can
 * never abort the surrounding batch or job.
 */
export async function scrapePage(url: string, config: ScraperConfig): Promise<ScrapeOutcome> {
  let page: Page | null = null

  try {
    const context = await getContext(config)
    page = await context.newPage()

    /**
     * `waitUntil: 'load'`, then a best-effort settle — NOT `waitUntil: 'networkidle'`.
     *
     * The rules originally specified `networkidle`, but measured against the
     * real site it never fires: capella.edu keeps analytics and tag-manager
     * connections open indefinitely, so every navigation hit the 30s timeout
     * and the first live audit failed 100% of its URLs. `load` returns in
     * ~1.8s with the JS-rendered DOM fully populated (64 DAM references on the
     * home page, verified).
     *
     * The short `networkidle` wait afterwards is a bonus for late-rendering
     * components, and its timeout is swallowed — reaching it is not required
     * for the page to be usable.
     */
    const response = await page.goto(url, {
      waitUntil: 'load',
      timeout: config.pageTimeoutMs,
    })

    await page
      .waitForLoadState('networkidle', { timeout: config.settleMs })
      .catch(() => undefined)

    // A 404 or 500 is a real result about the page, not a scraper failure —
    // record it as an unpublished page rather than a failed URL.
    const httpStatus = response?.status() ?? 0
    if (httpStatus >= 400) {
      return {
        ok: true,
        page: {
          url,
          title: null,
          assetPaths: [],
          testimonials: [],
          isPublished: false,
        },
      }
    }

    const raw = await extractFromDom(page)

    const assetPaths = dedupePaths([
      ...raw.assetAttributeValues.flatMap((value) => extractPathsFromAttribute(value)),
      ...raw.cssValues.flatMap((value) => extractPathsFromCss(value)),
    ])

    return {
      ok: true,
      page: {
        url,
        title: raw.title,
        assetPaths,
        testimonials: parseCandidates(raw.testimonialCandidates),
        isPublished: derivePublishStatus(raw),
      } satisfies ScrapedPage,
    }
  } catch (error) {
    return {
      ok: false,
      failure: { url, error: error instanceof Error ? error.message : String(error) },
    }
  } finally {
    await page?.close().catch(() => undefined)
  }
}

interface RawDomExtract {
  title: string | null
  assetAttributeValues: string[]
  /** Inline `style` attributes and computed `background-image` values. */
  cssValues: string[]
  testimonialCandidates: TestimonialCandidate[]
  hasNoIndex: boolean
  hasWcmModeEdit: boolean
  bodyTextLength: number
}

/**
 * Everything read out of the browser in one `evaluate` call. Only serializable
 * data crosses the boundary — all parsing happens in Node so it stays testable.
 */
async function extractFromDom(page: Page): Promise<RawDomExtract> {
  return page.evaluate(
    ({ assetSelector, assetAttributes, damMarker, testimonialSelectors }) => {
      const assetAttributeValues: string[] = []
      document.querySelectorAll(assetSelector).forEach((el) => {
        for (const attr of assetAttributes) {
          const value = el.getAttribute(attr)
          if (value) assetAttributeValues.push(value)
        }
      })

      // Hero and footer banners are CSS backgrounds, not <img>. Reading the
      // computed value rather than only the `style` attribute also catches
      // backgrounds applied from a stylesheet, which no attribute exposes.
      // Pre-filtering on the DAM marker keeps the string traffic across the
      // evaluate boundary proportional to what actually matched.
      // Every element, uncapped: measured at 5ms for ~2000 elements on a real
      // Capella page, so a cap would only buy a silent undercount.
      const cssValues: string[] = []

      for (const el of Array.from(document.querySelectorAll('*'))) {
        const inline = el.getAttribute('style')
        if (inline && inline.includes(damMarker)) cssValues.push(inline)

        // Not redundant with the attribute above: on this site one background
        // image per page is set from a stylesheet, where no attribute shows it.
        const background = window.getComputedStyle(el).backgroundImage
        if (background && background !== 'none' && background.includes(damMarker)) {
          cssValues.push(background)
        }
      }

      const nearbyText = (el: Element, selector: string): string | null => {
        // Look inside the component first, then at its immediate siblings —
        // both layouts appear in Capella's markup.
        const inner = el.querySelector(selector)
        if (inner?.textContent?.trim()) return inner.textContent.trim()

        for (const sibling of [el.nextElementSibling, el.previousElementSibling]) {
          if (!sibling) continue
          if (sibling.matches(selector) && sibling.textContent?.trim()) {
            return sibling.textContent.trim()
          }
          const nested = sibling.querySelector(selector)
          if (nested?.textContent?.trim()) return nested.textContent.trim()
        }
        return null
      }

      const candidates: Array<{
        text: string
        outerHtml: string
        sourceType: 'structured_component' | 'hardcoded_text'
        nameHint: string | null
        programHint: string | null
        positionOnPage: number
      }> = []

      // `seen` prevents one element matching several selectors from being
      // collected repeatedly — the first (highest priority) match wins.
      const seen = new Set<Element>()
      let position = 0

      for (const { selector, sourceType } of testimonialSelectors) {
        document.querySelectorAll(selector).forEach((el) => {
          if (seen.has(el)) return
          seen.add(el)

          const text = el.textContent ?? ''
          if (!text.trim()) return

          candidates.push({
            text,
            // Capped: a whole page section can end up in raw_html otherwise.
            outerHtml: el.outerHTML.slice(0, 10_000),
            sourceType,
            nameHint: nearbyText(el, '[class*="name"], [class*="author"], cite, footer'),
            programHint: nearbyText(el, '[class*="program"], [class*="degree"]'),
            positionOnPage: position++,
          })
        })
      }

      const robots = document
        .querySelector('meta[name="robots"]')
        ?.getAttribute('content')
        ?.toLowerCase()

      return {
        title: document.title?.trim() || null,
        assetAttributeValues,
        cssValues,
        testimonialCandidates: candidates,
        hasNoIndex: robots?.includes('noindex') ?? false,
        // AEM author/preview markers never appear on a published page.
        hasWcmModeEdit:
          document.body?.classList.contains('cq-Editable-dom') ||
          document.querySelector('[data-cq-wcmmode="edit"], #CQ') !== null,
        bodyTextLength: document.body?.innerText?.length ?? 0,
      }
    },
    {
      assetSelector: ASSET_SELECTOR,
      assetAttributes: ASSET_ATTRIBUTES,
      damMarker: DAM_ROOT,
      testimonialSelectors: TESTIMONIAL_SELECTORS.map((entry) => ({ ...entry })),
    },
  )
}

/**
 * Phase 1 publish heuristic.
 *
 * There is no reliable published flag in public HTML, so this reads the signals
 * that are available and returns null when they disagree or are absent. Phase 2
 * replaces this wholesale with `cq:lastReplicated` from the JCR node — until
 * then, `unknown` is an honest answer and the UI renders it as a yellow badge.
 */
function derivePublishStatus(raw: RawDomExtract): boolean | null {
  if (raw.hasWcmModeEdit) return false
  if (raw.hasNoIndex) return false
  // A page that rendered real body content and isn't excluded from indexing is
  // almost certainly live. Too little content means the render likely failed.
  if (raw.bodyTextLength > 500) return true
  return null
}
