import sharp from 'sharp'
import {
  bestDistance,
  computePhashVariants,
  groupDuplicates,
  hammingDistance,
  isDuplicate,
} from '../phash.js'

/** A solid-colour PNG with an alpha channel, like a white logo's bounding box. */
async function solidPng(color: string, alpha = 1): Promise<Buffer> {
  return sharp({
    create: { width: 64, height: 64, channels: 4, background: { ...parse(color), alpha } },
  })
    .png()
    .toBuffer()
}

function parse(hex: string): { r: number; g: number; b: number } {
  return {
    r: parseInt(hex.slice(1, 3), 16),
    g: parseInt(hex.slice(3, 5), 16),
    b: parseInt(hex.slice(5, 7), 16),
  }
}

describe('computePhashVariants — degenerate hashes', () => {
  /**
   * Regression: every white-on-transparent logo flattened onto white produced
   * the identical all-ones hash, so duplicate detection reported ten different
   * brands' logos as copies of one image at distance 0.
   */
  it('discards a hash of a uniform image rather than returning all-ones', async () => {
    const { phash, phashAlt } = await computePhashVariants(await solidPng('#ffffff'))
    expect(phash).toBeNull()
    expect(phashAlt).toBeNull()
  })

  it('keeps the usable hash when only one background is blank', async () => {
    // Transparent everywhere: blank on white, blank on black — both discarded.
    const transparent = await computePhashVariants(await solidPng('#ffffff', 0))
    expect(transparent.phash).toBeNull()
    expect(transparent.phashAlt).toBeNull()
  })

  it('two different uniform images never compare as duplicates', async () => {
    const white = await computePhashVariants(await solidPng('#ffffff'))
    const black = await computePhashVariants(await solidPng('#000000'))

    // Infinity, not 0 — nothing to compare, rather than a perfect match.
    expect(
      bestDistance([white.phash, white.phashAlt], [black.phash, black.phashAlt]),
    ).toBe(Infinity)
  })
})

describe('bestDistance', () => {
  it('returns the closest pairing across both backgrounds', () => {
    // A transparent logo stored white-flattened, queried as a black-flattened
    // JPEG export: the primary pairing is far apart, the alt pairing is exact.
    expect(bestDistance(['0000', 'ffff'], ['ffff', null])).toBe(0)
  })

  it('falls back to the primary pairing when there is no alt hash', () => {
    expect(bestDistance(['0000', null], ['0001', null])).toBe(1)
  })

  it('ignores null hashes on either side', () => {
    expect(bestDistance([null, '0000'], [null, '0000'])).toBe(0)
  })

  it('returns Infinity when nothing is comparable', () => {
    expect(bestDistance([null, null], ['0000', null])).toBe(Number.POSITIVE_INFINITY)
    expect(bestDistance(['0000', null], [null, null])).toBe(Number.POSITIVE_INFINITY)
  })

  it('returns Infinity when hash lengths do not line up', () => {
    // A legacy 64-bit row against a current 256-bit hash is not a distant
    // image, it is an incomparable one — it must not score as a near match.
    expect(bestDistance(['ffff'], ['ffffffffffffffff'])).toBe(Number.POSITIVE_INFINITY)
  })
})

describe('hammingDistance', () => {
  it('is zero for identical hashes', () => {
    expect(hammingDistance('ffc3c3c3', 'ffc3c3c3')).toBe(0)
  })

  it('counts differing bits, not differing characters', () => {
    // 0x0 ^ 0x1 = 1 bit; 0x0 ^ 0xf = 4 bits.
    expect(hammingDistance('00', '01')).toBe(1)
    expect(hammingDistance('00', '0f')).toBe(4)
  })

  it('returns Infinity for hashes of different lengths', () => {
    expect(hammingDistance('ffc3', 'ffc3c3c3')).toBe(Number.POSITIVE_INFINITY)
  })

  it('returns Infinity for a non-hex hash rather than a misleading number', () => {
    expect(hammingDistance('zzzz', 'ffff')).toBe(Number.POSITIVE_INFINITY)
  })
})

describe('isDuplicate', () => {
  it('treats a near-identical hash as a duplicate at the default threshold', () => {
    expect(isDuplicate('ffc3c3c3c3c3ffff', 'ffc3c3c3c3c7ffff')).toBe(true)
  })

  it('treats a clearly different hash as distinct', () => {
    expect(isDuplicate('0000000000000000', 'ffffffffffffffff')).toBe(false)
  })

  it('respects a stricter threshold', () => {
    expect(isDuplicate('00', '0f', 3)).toBe(false)
    expect(isDuplicate('00', '0f', 4)).toBe(true)
  })
})

describe('groupDuplicates', () => {
  it('groups assets within the threshold', () => {
    const groups = groupDuplicates([
      { id: 'a', phash: 'ffc3c3c3c3c3ffff' },
      { id: 'b', phash: 'ffc3c3c3c3c7ffff' },
      { id: 'c', phash: '0000000000000000' },
    ])

    expect(groups).toHaveLength(1)
    expect(groups[0]?.members.map((member) => member.id).sort()).toEqual(['a', 'b'])
  })

  it('excludes singletons — one asset is not a duplicate', () => {
    const groups = groupDuplicates([
      { id: 'a', phash: '0000000000000000' },
      { id: 'b', phash: 'ffffffffffffffff' },
    ])

    expect(groups).toEqual([])
  })

  it('ignores assets with no hash yet', () => {
    const groups = groupDuplicates([
      { id: 'a', phash: null },
      { id: 'b', phash: null },
    ])

    expect(groups).toEqual([])
  })

  it('chains transitively similar assets into one group', () => {
    // a~b and b~c, but a and c are further apart than the threshold. Single-link
    // clustering should still place all three together rather than splitting
    // them into two overlapping groups.
    const groups = groupDuplicates(
      [
        { id: 'a', phash: '0000' },
        { id: 'b', phash: '0003' },
        { id: 'c', phash: '000f' },
      ],
      2,
    )

    expect(groups).toHaveLength(1)
    expect(groups[0]?.members).toHaveLength(3)
  })

  it('reports the widest distance within a group', () => {
    const groups = groupDuplicates(
      [
        { id: 'a', phash: '0000' },
        { id: 'b', phash: '0001' },
        { id: 'c', phash: '0003' },
      ],
      4,
    )

    expect(groups[0]?.maxDistance).toBe(2)
  })
})
