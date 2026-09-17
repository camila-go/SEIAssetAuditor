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
    expect(parseUrlList('https://a.capella.edu/\nhttps://b.capella.edu/')).toEqual([
      'https://a.capella.edu/',
      'https://b.capella.edu/',
    ])
  })

  it('ignores blank lines and comments', () => {
    expect(parseUrlList('# my list\n\nhttps://a.capella.edu/\n\n')).toEqual([
      'https://a.capella.edu/',
    ])
  })

  it('deduplicates repeats', () => {
    expect(parseUrlList('https://a.capella.edu/\nhttps://a.capella.edu/')).toHaveLength(1)
  })

  it('drops lines that are not URLs', () => {
    expect(parseUrlList('not a url at all\nhttps://a.capella.edu/')).toEqual([
      'https://a.capella.edu/',
    ])
  })

  it('handles CRLF line endings from Windows', () => {
    expect(parseUrlList('https://a.capella.edu/\r\nhttps://b.capella.edu/')).toHaveLength(2)
  })
})

describe('parseCsvUrls', () => {
  it('takes the first cell that parses as a URL', () => {
    expect(parseCsvUrls('https://a.capella.edu/,Page A,2026-01-01')).toEqual([
      'https://a.capella.edu/',
    ])
  })

  it('finds the URL even when it is not the first column', () => {
    expect(parseCsvUrls('Page A,https://a.capella.edu/,2026-01-01')).toEqual([
      'https://a.capella.edu/',
    ])
  })

  it('skips a header row, which yields no URL', () => {
    expect(parseCsvUrls('url,title\nhttps://a.capella.edu/,Page A')).toEqual([
      'https://a.capella.edu/',
    ])
  })

  it('strips surrounding quotes', () => {
    expect(parseCsvUrls('"https://a.capella.edu/","Page, A"')).toEqual(['https://a.capella.edu/'])
  })

  it('does not split on a comma inside quotes', () => {
    // "Page, A" must stay one cell, or the trailing fragment could be misread.
    expect(parseCsvUrls('"Page, A",https://a.capella.edu/')).toEqual(['https://a.capella.edu/'])
  })

  it('returns nothing for a file with no URLs', () => {
    expect(parseCsvUrls('title,author\nSomething,Someone')).toEqual([])
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
