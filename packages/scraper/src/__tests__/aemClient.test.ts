import { AemClient, buildQuery } from '../aemClient.js'

/**
 * The Query Builder servlet silently truncates to 10 hits when `p.limit` is
 * missing. These tests exist to make that failure impossible to introduce.
 */
describe('buildQuery', () => {
  it('throws when p.limit is missing', () => {
    expect(() => buildQuery({ path: '/content/capella/en', type: 'cq:Page' })).toThrow(/p\.limit/)
  })

  it('accepts a query with p.limit set', () => {
    expect(() => buildQuery({ path: '/content/capella/en', 'p.limit': '100' })).not.toThrow()
  })
})

describe('pagesReferencingAssetQuery', () => {
  const params = AemClient.pagesReferencingAssetQuery(
    '/content/dam/capella/images/hero.jpg',
    500,
  )

  it('sets p.limit explicitly', () => {
    expect(params.get('p.limit')).toBe('500')
  })

  it('filters on the fileReference property', () => {
    expect(params.get('property')).toBe('fileReference')
    expect(params.get('property.value')).toBe('/content/dam/capella/images/hero.jpg')
  })

  it('uses selective hits to keep the payload small', () => {
    expect(params.get('p.hits')).toBe('selective')
    expect(params.get('p.properties')).toContain('jcr:content/cq:lastReplicated')
  })

  it('uses guessTotal to avoid a full result-set count', () => {
    expect(params.get('p.guessTotal')).toBe('true')
  })
})

describe('pagesByLastModifiedQuery', () => {
  const params = AemClient.pagesByLastModifiedQuery(40, 20)

  it('sets an explicit limit and offset', () => {
    expect(params.get('p.limit')).toBe('20')
    expect(params.get('p.offset')).toBe('40')
  })

  it('orders by last modified, newest first', () => {
    expect(params.get('orderby')).toBe('@jcr:content/cq:lastModified')
    expect(params.get('orderby.sort')).toBe('desc')
  })

  it('uses a numeric guessTotal so the pager can show an exact count below it', () => {
    expect(params.get('p.guessTotal')).toBe('100')
  })
})

describe('pagesByProgramTagQuery', () => {
  const params = AemClient.pagesByProgramTagQuery('masters-degree', 200)

  it('pairs tagid with tagid.property', () => {
    expect(params.get('tagid')).toBe('programs/masters-degree')
    expect(params.get('tagid.property')).toBe('jcr:content/cq:tags')
  })

  it('sets p.limit explicitly', () => {
    expect(params.get('p.limit')).toBe('200')
  })
})

describe('testimonialComponentsQuery', () => {
  const params = AemClient.testimonialComponentsQuery(1_000)

  it('filters by node name', () => {
    expect(params.get('nodename')).toBe('testimonial')
  })

  it('bounds the full-hits query with an explicit limit', () => {
    expect(params.get('p.hits')).toBe('full')
    expect(params.get('p.limit')).toBe('1000')
  })
})

describe('pagesInAnyPathQuery', () => {
  const params = AemClient.pagesInAnyPathQuery(
    ['/content/capella/en/programs', '/content/capella/en/about'],
    200,
  )

  it('enables OR logic for the group', () => {
    expect(params.get('group.p.or')).toBe('true')
  })

  it('numbers repeated predicates', () => {
    expect(params.get('group.1_path')).toBe('/content/capella/en/programs')
    expect(params.get('group.2_path')).toBe('/content/capella/en/about')
  })

  it('sets p.limit explicitly', () => {
    expect(params.get('p.limit')).toBe('200')
  })
})
