import { parseSitemapXml } from '../sitemap.js'

describe('parseSitemapXml', () => {
  it('extracts loc entries from a urlset', () => {
    const { urls, isIndex } = parseSitemapXml(`
      <?xml version="1.0" encoding="UTF-8"?>
      <urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
        <url><loc>https://www.capella.edu/a/</loc></url>
        <url><loc>https://www.capella.edu/b/</loc></url>
      </urlset>
    `)

    expect(isIndex).toBe(false)
    expect(urls).toEqual(['https://www.capella.edu/a/', 'https://www.capella.edu/b/'])
  })

  it('recognizes a sitemap index', () => {
    const { isIndex } = parseSitemapXml(`
      <sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
        <sitemap><loc>https://www.capella.edu/sitemap-1.xml</loc></sitemap>
      </sitemapindex>
    `)

    expect(isIndex).toBe(true)
  })

  it('decodes XML entities in a URL', () => {
    const { urls } = parseSitemapXml(
      '<urlset><url><loc>https://www.capella.edu/a?x=1&amp;y=2</loc></url></urlset>',
    )

    expect(urls).toEqual(['https://www.capella.edu/a?x=1&y=2'])
  })

  it('unwraps CDATA sections', () => {
    const { urls } = parseSitemapXml(
      '<urlset><url><loc><![CDATA[https://www.capella.edu/a/]]></loc></url></urlset>',
    )

    expect(urls).toEqual(['https://www.capella.edu/a/'])
  })

  it('tolerates whitespace and newlines inside loc', () => {
    const { urls } = parseSitemapXml(
      '<urlset><url><loc>\n  https://www.capella.edu/a/\n  </loc></url></urlset>',
    )

    expect(urls).toEqual(['https://www.capella.edu/a/'])
  })

  it('deduplicates repeated URLs', () => {
    const { urls } = parseSitemapXml(`
      <urlset>
        <url><loc>https://www.capella.edu/a/</loc></url>
        <url><loc>https://www.capella.edu/a/</loc></url>
      </urlset>
    `)

    expect(urls).toHaveLength(1)
  })

  it('returns nothing for a document with no loc elements', () => {
    expect(parseSitemapXml('<html><body>Not a sitemap</body></html>').urls).toEqual([])
  })
})
