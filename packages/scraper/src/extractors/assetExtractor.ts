/**
 * Pure asset-path normalization. Kept out of `page.evaluate` so it can be
 * unit-tested against fixtures without launching a browser.
 */

/**
 * Every DAM path, regardless of brand folder.
 *
 * This was `/content/dam/capella/` — the path the PRD and `.claude/rules/`
 * both specify. On the live site that prefix is a small minority of what is
 * actually referenced, so the scraper was silently discarding most of each
 * page. Measured on three pages (count of matched path roots in the HTML):
 *
 *   capella.edu/           vc/logo 44 · sei/capella 24 · capella/logos 4 · sei/strayer 3
 *   capella.edu/about/     sei/capella 37 · sei/global-logos 28 · sei/strayer 21 · capella/PDF 4
 *   capella.edu/online-degrees/   capella/FlexPath 39 · vc/logo 33 · sei/capella 7
 *
 * Capella has clearly been migrated into the shared SEI DAM, and the site also
 * pulls sibling-brand and global chrome. An audit tool that answers "where is
 * this asset used?" must index all of it: dropping a reference because it sits
 * under the wrong brand folder produces a confidently wrong answer, which is
 * worse than no answer. Brand is still recoverable per asset — see `damBrand`.
 *
 * This widens only what is READ. The AEM write allowlist in
 * `aemUploadService.ts` is a separate, deliberately narrow literal and is
 * untouched by this.
 */
export const DAM_ROOT = '/content/dam/'

/**
 * The brand/section folder an asset lives in — `sei/capella`, `vc`, `capella`.
 *
 * Derived from the path rather than stored, so it needs no migration and can
 * never drift from the path it describes. Two segments for the shared SEI DAM
 * (`sei/capella` and `sei/strayer` are different brands), one otherwise.
 */
export function damBrand(aemPath: string): string | null {
  if (!aemPath.startsWith(DAM_ROOT)) return null

  const segments = aemPath.slice(DAM_ROOT.length).split('/')
  const first = segments[0]
  if (!first) return null

  // A single trailing segment is the filename, not a folder.
  if (segments.length < 2) return null

  return first === 'sei' && segments.length > 2 ? `sei/${segments[1]}` : first
}

/**
 * Pull every DAM path out of one attribute value.
 *
 * Handles three shapes seen on capella.edu:
 *   - a plain path or absolute URL
 *   - a `srcset` list: "path 400w, path 800w"
 *   - an AEM adaptive-image URL where the DAM path is embedded mid-string
 */
export function extractPathsFromAttribute(value: string): string[] {
  if (!value || !value.includes(DAM_ROOT)) return []

  const paths: string[] = []

  // srcset entries are comma-separated; a single src is just a one-entry list.
  for (const candidate of value.split(',')) {
    const urlPart = candidate.trim().split(/\s+/)[0]
    if (!urlPart) continue

    const normalized = normalizeAssetPath(urlPart)
    if (normalized) paths.push(normalized)
  }

  return paths
}

/** `url(...)`, with or without quotes. */
const CSS_URL = /url\(\s*(['"]?)([^'")]+)\1\s*\)/gi

/**
 * Pull every DAM path out of a chunk of CSS — an inline `style` attribute or a
 * computed `background-image`.
 *
 * Capella builds hero and footer banners as CSS backgrounds, not `<img>`:
 *
 *   style="background-image: linear-gradient(90deg, #212322 3.92%, …),
 *                            url(/content/dam/capella/…/12K-desktop-hero.png)"
 *
 * Attribute parsing cannot reach those. This is separate from
 * `extractPathsFromAttribute` because CSS needs different handling on both
 * sides: a value can hold several `url()`s plus gradients full of commas, so
 * splitting on commas the way a `srcset` does would shred it, and the path has
 * to be lifted out of the `url(...)` wrapper before it means anything.
 */
export function extractPathsFromCss(value: string): string[] {
  if (!value || !value.includes(DAM_ROOT)) return []

  const paths: string[] = []

  for (const match of value.matchAll(CSS_URL)) {
    const normalized = normalizeAssetPath(match[2] ?? '')
    if (normalized) paths.push(normalized)
  }

  return paths
}

/**
 * Reduce a reference to its canonical DAM path.
 * Returns null for anything that isn't a Capella DAM asset.
 */
export function normalizeAssetPath(raw: string): string | null {
  if (!raw) return null

  let value = raw.trim()
  if (!value.includes(DAM_ROOT)) return null

  // Strip protocol + host so www.capella.edu/content/dam/... and /content/dam/... unify.
  const damIndex = value.indexOf(DAM_ROOT)
  value = value.slice(damIndex)

  // Drop query strings and fragments — cache busters must not create duplicate assets.
  value = value.split('?')[0] ?? value
  value = value.split('#')[0] ?? value

  // Stop at the first character that cannot appear in a URL path. Without this
  // a path lifted out of surrounding syntax keeps the syntax: the CSS value
  // `url(/content/dam/…/hero.png);` normalized to a path ending in `);`, which
  // indexes a real asset under a filename that does not exist. Trailing junk is
  // silent — it produces an asset row that simply never matches anything.
  value = value.split(/[)"'`<>\s]/)[0] ?? value

  // AEM serves renditions and named transforms off the asset path. Both describe
  // the same underlying asset, so collapse them to the original.
  //   /content/dam/x.jpg/jcr:content/renditions/original  -> /content/dam/x.jpg
  //   /content/dam/x.jpg.transform/thumb/image.jpg        -> /content/dam/x.jpg
  const jcrIndex = value.indexOf('/jcr:content/')
  if (jcrIndex > 0) value = value.slice(0, jcrIndex)

  const transformIndex = value.indexOf('.transform/')
  if (transformIndex > 0) value = value.slice(0, transformIndex)

  try {
    value = decodeURI(value)
  } catch {
    // Malformed percent-encoding — keep the raw form rather than dropping the asset.
  }

  if (!value.startsWith(DAM_ROOT)) return null
  // A bare folder path is not an asset.
  if (!value.slice(DAM_ROOT.length).includes('.')) return null

  return value
}

/** De-duplicate while preserving document order. */
export function dedupePaths(paths: string[]): string[] {
  return [...new Set(paths)]
}
