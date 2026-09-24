import { normalizeUrl, parseCsvUrls, parseUrlList, toLiveStatus } from './auditService.js'

describe('normalizeUrl', () => {
  it('keeps a well-formed https URL', () => {
    expect(normalizeUrl('https://www.capella.edu/about/')).toBe('https://www.capella.edu/about/')
  })

  it('assumes https for a bare host', () => {
    expect(normalizeUrl('www.capella.edu/about/')).toBe('https://www.capella.edu/about/')
  })

  it('strips a fragment — it identifies a position, not a page', () => {
    expect(normalizeUrl('https://www.capella.edu/about/#team')).toBe(
      'https://www.capella.edu/about/',
    )
  })

  it('rejects a non-http protocol', () => {
    expect(normalizeUrl('javascript:alert(1)')).toBeNull()
    expect(normalizeUrl('ftp://example.com/file')).toBeNull()
  })

  it('rejects an empty value', () => {
    expect(normalizeUrl('')).toBeNull()
  })
})

describe('parseUrlList', () => {
  it('reads one URL per line', () => {
    expect(parseUrlList('https://a.capella.edu/\nhttps://b.capella.edu/').urls).toEqual([
      'https://a.capella.edu/',
      'https://b.capella.edu/',
    ])
  })

  it('ignores blank lines and comments', () => {
    expect(parseUrlList('# my list\n\nhttps://a.capella.edu/\n\n').urls).toEqual([
      'https://a.capella.edu/',
    ])
  })

  it('deduplicates repeats', () => {
    expect(parseUrlList('https://a.capella.edu/\nhttps://a.capella.edu/').urls).toHaveLength(1)
  })

  it('drops lines that are not URLs', () => {
    expect(parseUrlList('not a url at all\nhttps://a.capella.edu/').urls).toEqual([
      'https://a.capella.edu/',
    ])
  })

  it('handles CRLF line endings from Windows', () => {
    expect(parseUrlList('https://a.capella.edu/\r\nhttps://b.capella.edu/').urls).toHaveLength(2)
  })
})

describe('parseCsvUrls', () => {
  it('takes the first cell that parses as a URL', () => {
    expect(parseCsvUrls('https://a.capella.edu/,Page A,2026-01-01').urls).toEqual([
      'https://a.capella.edu/',
    ])
  })

  it('finds the URL even when it is not the first column', () => {
    expect(parseCsvUrls('Page A,https://a.capella.edu/,2026-01-01').urls).toEqual([
      'https://a.capella.edu/',
    ])
  })

  it('skips a header row, which yields no URL', () => {
    expect(parseCsvUrls('url,title\nhttps://a.capella.edu/,Page A').urls).toEqual([
      'https://a.capella.edu/',
    ])
  })

  it('strips surrounding quotes', () => {
    expect(parseCsvUrls('"https://a.capella.edu/","Page, A"').urls).toEqual(['https://a.capella.edu/'])
  })

  it('does not split on a comma inside quotes', () => {
    // "Page, A" must stay one cell, or the trailing fragment could be misread.
    expect(parseCsvUrls('"Page, A",https://a.capella.edu/').urls).toEqual(['https://a.capella.edu/'])
  })

  it('returns nothing for a file with no URLs', () => {
    expect(parseCsvUrls('title,author\nSomething,Someone').urls).toEqual([])
  })
})

describe('toLiveStatus', () => {
  it.each([
    [true, 'published'],
    [false, 'draft'],
    [null, 'unknown'],
  ])('maps %s to %s', (input, expected) => {
    expect(toLiveStatus(input as boolean | null)).toBe(expected)
  })
})

describe('normalizeUrl — filenames are not hosts', () => {
  /**
   * Regression: a column of filenames pasted from a DAM export was turned into
   * `https://kristen_moris.jpg/` and queued, because `LOOKS_LIKE_HOST` only
   * asked for a dot followed by two or more letters — which `.jpg` satisfies
   * as well as `.edu`. Every row then failed with ERR_NAME_NOT_RESOLVED, a DNS
   * error that says nothing about the real mistake.
   */
  it.each([
    'kristen_moris.jpg',
    'wesley_willis_162x200.jpg',
    'tommy-gabriel.jpg',
    'tina-flores.png',
    'julie_clockston.jpg',
    'Consumer_Information.pdf',
    'report.docx',
    'data.csv',
  ])('rejects %s', (name) => {
    expect(normalizeUrl(name)).toBeNull()
  })

  it('still accepts a real bare host', () => {
    expect(normalizeUrl('capella.edu')).toBe('https://capella.edu/')
    expect(normalizeUrl('www.capella.edu')).toBe('https://www.capella.edu/')
  })

  it('only tests the host, so a file in the path is still a valid address', () => {
    expect(normalizeUrl('capella.edu/photo.jpg')).toBe('https://capella.edu/photo.jpg')
    expect(normalizeUrl('https://www.capella.edu/content/dam/x/photo.jpg')).toBe(
      'https://www.capella.edu/content/dam/x/photo.jpg',
    )
  })
})

describe('skipped input is reported, not swallowed', () => {
  it('names the lines it could not read', () => {
    const { urls, skipped } = parseUrlList(
      ['https://www.capella.edu/about/', 'kristen_moris.jpg', 'tina-flores.png'].join('\n'),
    )
    expect(urls).toEqual(['https://www.capella.edu/about/'])
    expect(skipped).toEqual(['kristen_moris.jpg', 'tina-flores.png'])
  })

  it('reports a CSV row once, not once per column', () => {
    const { urls, skipped } = parseCsvUrls('kristen_moris.jpg,Kristen Moris,nursing\nhttps://www.capella.edu/,ok,ok')
    expect(urls).toEqual(['https://www.capella.edu/'])
    expect(skipped).toEqual(['kristen_moris.jpg,Kristen Moris,nursing'])
  })

  it('does not report blank lines or comments as skipped', () => {
    const { skipped } = parseUrlList('# a comment\n\nhttps://www.capella.edu/\n   \n')
    expect(skipped).toEqual([])
  })
})
