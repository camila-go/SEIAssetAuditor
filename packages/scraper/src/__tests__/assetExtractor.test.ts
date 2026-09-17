import {
  damBrand,
  dedupePaths,
  extractPathsFromAttribute,
  extractPathsFromCss,
  normalizeAssetPath,
} from '../extractors/assetExtractor.js'

describe('extractPathsFromCss', () => {
  // Verbatim from the 12k-tuition-cap page, where both the hero and the footer
  // banner were invisible to the audit because they are CSS, not <img>.
  const HERO_STYLE =
    'background-image: linear-gradient(90deg, #212322 3.92%, #425563 46.58%, ' +
    'rgba(124, 135, 144, 0.00) 74.69%),  ' +
    'url(/content/dam/capella/tuition-financial-aid/tuition-cap-detail-page-image-assets/12K-desktop-hero-G1343102158-dark.png);'

  it('finds the asset behind a gradient in an inline style', () => {
    expect(extractPathsFromCss(HERO_STYLE)).toEqual([
      '/content/dam/capella/tuition-financial-aid/tuition-cap-detail-page-image-assets/12K-desktop-hero-G1343102158-dark.png',
    ])
  })

  it('never lets surrounding syntax into the path', () => {
    // This asserted `[]` first, and the failure was the interesting part: the
    // attribute parser returned the right asset with `);` still glued to the
    // end. A path that keeps its punctuation indexes an asset under a filename
    // that does not exist, and nothing downstream would ever flag it.
    for (const path of extractPathsFromAttribute(HERO_STYLE)) {
      expect(path).not.toMatch(/[)"'`<>\s]/)
    }
    expect(normalizeAssetPath('url(/content/dam/capella/a.png);')).toBe(
      '/content/dam/capella/a.png',
    )
  })

  it('handles the absolute, quoted form a computed style returns', () => {
    expect(
      extractPathsFromCss('url("https://www.capella.edu/content/dam/capella/images/hero.jpg")'),
    ).toEqual(['/content/dam/capella/images/hero.jpg'])
    expect(extractPathsFromCss("url('/content/dam/sei/capella/photos/a.png')")).toEqual([
      '/content/dam/sei/capella/photos/a.png',
    ])
  })

  it('finds every layer when several images are stacked', () => {
    expect(
      extractPathsFromCss(
        'url(/content/dam/capella/a.png), url(/content/dam/sei/capella/b.png)',
      ),
    ).toEqual(['/content/dam/capella/a.png', '/content/dam/sei/capella/b.png'])
  })

  it('ignores CSS with no DAM asset in it', () => {
    expect(extractPathsFromCss('background-image: linear-gradient(90deg, #fff, #000)')).toEqual([])
    expect(extractPathsFromCss('url(/etc.clientlibs/foo/icon.svg)')).toEqual([])
    expect(extractPathsFromCss('')).toEqual([])
  })

  it('does not mistake a folder url for an asset', () => {
    expect(extractPathsFromCss('url(/content/dam/capella/images/)')).toEqual([])
  })
})

describe('damBrand', () => {
  it('keeps two segments inside the shared SEI DAM', () => {
    expect(damBrand('/content/dam/sei/capella/photography/hero.jpg')).toBe('sei/capella')
    expect(damBrand('/content/dam/sei/strayer/logo.png')).toBe('sei/strayer')
  })

  it('uses one segment elsewhere', () => {
    expect(damBrand('/content/dam/capella/logos/mark.svg')).toBe('capella')
    expect(damBrand('/content/dam/vc/logo/capella-logo.svg')).toBe('vc')
  })

  it('returns null when there is no folder, only a filename', () => {
    expect(damBrand('/content/dam/loose-file.pdf')).toBeNull()
    expect(damBrand('/content/capella/en/about.html')).toBeNull()
  })
})

describe('normalizeAssetPath', () => {
  it('accepts a bare DAM path', () => {
    expect(normalizeAssetPath('/content/dam/capella/images/hero.jpg')).toBe(
      '/content/dam/capella/images/hero.jpg',
    )
  })

  it('strips the protocol and host from an absolute URL', () => {
    expect(normalizeAssetPath('https://www.capella.edu/content/dam/capella/images/hero.jpg')).toBe(
      '/content/dam/capella/images/hero.jpg',
    )
  })

  it('drops a cache-busting query string so one asset is not indexed twice', () => {
    expect(normalizeAssetPath('/content/dam/capella/images/hero.jpg?v=20260714')).toBe(
      '/content/dam/capella/images/hero.jpg',
    )
  })

  it('collapses a rendition URL to the underlying asset', () => {
    expect(
      normalizeAssetPath('/content/dam/capella/images/hero.jpg/jcr:content/renditions/original'),
    ).toBe('/content/dam/capella/images/hero.jpg')
  })

  it('collapses an AEM transform URL to the underlying asset', () => {
    expect(
      normalizeAssetPath('/content/dam/capella/images/hero.jpg.transform/thumb/image.jpg'),
    ).toBe('/content/dam/capella/images/hero.jpg')
  })

  // Capella lives in the shared SEI DAM, not only under /content/dam/capella/.
  // This used to assert the opposite and the scraper dropped most of each page.
  it('accepts the shared SEI DAM path the live site actually serves', () => {
    expect(
      normalizeAssetPath(
        'https://www.capella.edu/content/dam/sei/capella/photography/hero.jpg/jcr:content/renditions/aem6dam-web-desktop.webp',
      ),
    ).toBe('/content/dam/sei/capella/photography/hero.jpg')
  })

  it('accepts sibling-brand and global chrome referenced on capella.edu', () => {
    expect(normalizeAssetPath('/content/dam/vc/logo/capella-logo.svg')).toBe(
      '/content/dam/vc/logo/capella-logo.svg',
    )
    expect(normalizeAssetPath('/content/dam/sei/strayer/logo.png')).toBe(
      '/content/dam/sei/strayer/logo.png',
    )
  })

  it('still rejects a path outside the DAM entirely', () => {
    expect(normalizeAssetPath('/content/capella/en/about.html')).toBeNull()
    expect(normalizeAssetPath('https://www.capella.edu/about/')).toBeNull()
  })

  it('rejects a folder path with no file extension', () => {
    expect(normalizeAssetPath('/content/dam/capella/images/')).toBeNull()
    expect(normalizeAssetPath('/content/dam/sei/capella/photography/')).toBeNull()
  })

  it('rejects an empty value', () => {
    expect(normalizeAssetPath('')).toBeNull()
  })
})

describe('extractPathsFromAttribute', () => {
  it('pulls every candidate out of a srcset', () => {
    const paths = extractPathsFromAttribute(
      '/content/dam/capella/images/hero.jpg 400w, /content/dam/capella/images/hero-lg.jpg 800w',
    )

    expect(paths).toEqual([
      '/content/dam/capella/images/hero.jpg',
      '/content/dam/capella/images/hero-lg.jpg',
    ])
  })

  it('treats a plain src as a one-entry list', () => {
    expect(extractPathsFromAttribute('/content/dam/capella/images/hero.jpg')).toEqual([
      '/content/dam/capella/images/hero.jpg',
    ])
  })

  it('returns nothing for an unrelated attribute value', () => {
    expect(extractPathsFromAttribute('/etc/clientlibs/site/main.css')).toEqual([])
  })

  it('returns nothing for an empty value', () => {
    expect(extractPathsFromAttribute('')).toEqual([])
  })
})

describe('dedupePaths', () => {
  it('removes repeats while preserving document order', () => {
    expect(dedupePaths(['/a.jpg', '/b.jpg', '/a.jpg'])).toEqual(['/a.jpg', '/b.jpg'])
  })
})
