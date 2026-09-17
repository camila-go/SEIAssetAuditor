import { AppError, ERROR_CODES } from '@capella/types'

/**
 * Sitemap parsing. Sitemaps are static XML — no JS render needed, so this uses
 * plain fetch rather than Playwright.
 */

const MAX_SITEMAP_BYTES = 50 * 1024 * 1024
const MAX_INDEX_DEPTH = 2

/** Pull `<loc>` values out of a sitemap or sitemap index document. */
export function parseSitemapXml(xml: string): { urls: string[]; isIndex: boolean } {
  const isIndex = /<sitemapindex[\s>]/i.test(xml)

  const locations: string[] = []
  const pattern = /<loc>\s*([\s\S]*?)\s*<\/loc>/gi

  let match: RegExpExecArray | null
  while ((match = pattern.exec(xml)) !== null) {
    const raw = match[1]
    if (!raw) continue

    const decoded = decodeXmlEntities(raw.trim())
    if (decoded) locations.push(decoded)
  }

  return { urls: [...new Set(locations)], isIndex }
}

function decodeXmlEntities(value: string): string {
  return value
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    // Ampersand last, so "&amp;lt;" doesn't decode twice.
    .replace(/&amp;/g, '&')
    .trim()
}

/**
 * Fetch a sitemap and return every page URL it lists.
 *
 * Sitemap indexes are followed one level deep by default — capella.edu splits
 * its sitemap by section, so the URL a user pastes is usually an index.
 */
export async function fetchSitemapUrls(
  sitemapUrl: string,
  userAgent: string,
  depth = 0,
): Promise<string[]> {
  let response: Response
  try {
    response = await fetch(sitemapUrl, {
      headers: { 'User-Agent': userAgent, Accept: 'application/xml, text/xml' },
      signal: AbortSignal.timeout(30_000),
    })
  } catch (error) {
    throw new AppError(
      ERROR_CODES.SITEMAP_FETCH_FAILED,
      `Could not fetch sitemap: ${error instanceof Error ? error.message : String(error)}`,
    )
  }

  if (!response.ok) {
    throw new AppError(
      ERROR_CODES.SITEMAP_FETCH_FAILED,
      `Sitemap returned HTTP ${response.status}`,
    )
  }

  const contentLength = Number(response.headers.get('content-length') ?? 0)
  if (contentLength > MAX_SITEMAP_BYTES) {
    throw new AppError(ERROR_CODES.INVALID_SITEMAP, 'Sitemap is larger than 50MB')
  }

  const xml = await response.text()
  const { urls, isIndex } = parseSitemapXml(xml)

  if (urls.length === 0) {
    throw new AppError(
      ERROR_CODES.INVALID_SITEMAP,
      'No <loc> entries found — is this a sitemap XML file?',
    )
  }

  if (!isIndex || depth >= MAX_INDEX_DEPTH) return urls

  // Child sitemaps are fetched sequentially: an index can list dozens, and
  // hammering them in parallel is exactly the kind of load we're avoiding.
  const collected: string[] = []
  for (const childUrl of urls) {
    try {
      collected.push(...(await fetchSitemapUrls(childUrl, userAgent, depth + 1)))
    } catch {
      // One unreachable child sitemap must not sink the whole import.
      continue
    }
  }

  if (collected.length === 0) {
    throw new AppError(
      ERROR_CODES.INVALID_SITEMAP,
      'Sitemap index contained no readable child sitemaps',
    )
  }

  return [...new Set(collected)]
}
