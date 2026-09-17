import { fuseRankings, type RankedList } from './semantic.js'

/**
 * Fusion is where semantic search either helps or ruins the results. The rule
 * it has to hold: adding meaning-based recall must never demote what someone
 * literally asked for.
 */
describe('fuseRankings', () => {
  it('ranks a row that several passes agree on above one only a single pass found', () => {
    const lists: RankedList[] = [
      { reason: 'exact', ids: ['agreed', 'exact-only'] },
      { reason: 'semantic', ids: ['agreed', 'semantic-only'] },
    ]
    const fused = fuseRankings(lists)
    expect(fused[0]?.id).toBe('agreed')
    expect(fused[0]?.reasons.sort()).toEqual(['exact', 'semantic'])
  })

  it('keeps an exact match above a semantic one when each is top of its own list', () => {
    // The core guarantee. Someone who types a literal phrase gets the row
    // containing it first, not a thematically similar neighbour.
    const fused = fuseRankings([
      { reason: 'exact', ids: ['literal'] },
      { reason: 'semantic', ids: ['paraphrase'] },
    ])
    expect(fused[0]?.id).toBe('literal')
  })

  it('orders the weighted passes exact > stemmed > semantic > fuzzy', () => {
    const fused = fuseRankings([
      { reason: 'fuzzy', ids: ['d'] },
      { reason: 'semantic', ids: ['c'] },
      { reason: 'stemmed', ids: ['b'] },
      { reason: 'exact', ids: ['a'] },
    ])
    expect(fused.map((hit) => hit.id)).toEqual(['a', 'b', 'c', 'd'])
  })

  it('respects each list’s own order', () => {
    const fused = fuseRankings([{ reason: 'exact', ids: ['first', 'second', 'third'] }])
    expect(fused.map((hit) => hit.id)).toEqual(['first', 'second', 'third'])
  })

  it('carries the similarity score through for the semantic pass', () => {
    const fused = fuseRankings([
      { reason: 'semantic', ids: ['x'], scores: new Map([['x', 0.42]]) },
    ])
    expect(fused[0]?.similarity).toBeCloseTo(0.42)
  })

  it('leaves similarity undefined when only lexical passes matched', () => {
    // The UI keys the "similar meaning · NN%" badge off this, so an absent
    // score must stay absent rather than defaulting to zero.
    const fused = fuseRankings([{ reason: 'exact', ids: ['x'] }])
    expect(fused[0]?.similarity).toBeUndefined()
  })

  it('does not repeat a reason when one pass lists a row twice', () => {
    const fused = fuseRankings([
      { reason: 'exact', ids: ['x'] },
      { reason: 'exact', ids: ['x'] },
    ])
    expect(fused[0]?.reasons).toEqual(['exact'])
  })

  it('returns nothing for no lists, and for empty lists', () => {
    expect(fuseRankings([])).toEqual([])
    expect(fuseRankings([{ reason: 'exact', ids: [] }])).toEqual([])
  })

  it('surfaces a fuzzy-only hit rather than dropping it', () => {
    // A typo'd name matches nothing lexically; if fusion discarded single-pass
    // hits, typo tolerance would silently do nothing.
    const fused = fuseRankings([{ reason: 'fuzzy', ids: ['typo-match'] }])
    expect(fused).toHaveLength(1)
    expect(fused[0]?.reasons).toEqual(['fuzzy'])
  })
})
