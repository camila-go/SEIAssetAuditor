import { termMatchesAnyColumn } from './search.js'

describe('termMatchesAnyColumn', () => {
  it('builds one case-insensitive contains per column', () => {
    expect(termMatchesAnyColumn('logo', ['filename', 'aemPath'] as const)).toEqual([
      { filename: { contains: 'logo', mode: 'insensitive' } },
      { aemPath: { contains: 'logo', mode: 'insensitive' } },
    ])
  })

  it('returns nothing for no columns', () => {
    expect(termMatchesAnyColumn('logo', [] as const)).toEqual([])
  })
})
