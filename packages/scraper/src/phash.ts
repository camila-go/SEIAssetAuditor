import { bmvbhash } from 'blockhash-core'
import sharp from 'sharp'

/**
 * Perceptual hashing for duplicate detection (PRD Phase 2).
 *
 * Runs only as a background job — never inline during scraping, since it has to
 * download and decode each image.
 */

/** Hamming distance at or below this counts as a duplicate candidate. */
export const DUPLICATE_THRESHOLD = 10

const HASH_BITS = 16
/** blockhash operates on a fixed-size raw bitmap. */
const SAMPLE_SIZE = 256

/** Compute a 64-character hex pHash from image bytes, flattened onto `background`. */
export async function computePhash(
  imageBuffer: Buffer,
  background = '#ffffff',
): Promise<string> {
  const { data, info } = await sharp(imageBuffer)
    .resize(SAMPLE_SIZE, SAMPLE_SIZE, { fit: 'fill' })
    // blockhash needs 4-channel RGBA; flatten removes alpha ambiguity from PNGs.
    .flatten({ background })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true })

  return bmvbhash({ width: info.width, height: info.height, data }, HASH_BITS)
}

export interface PhashVariants {
  /** Primary hash: transparency flattened onto white. Null if degenerate. */
  phash: string | null
  /**
   * Secondary hash with transparency flattened onto black. Only produced for
   * images that actually have an alpha channel — null otherwise, or if degenerate.
   */
  phashAlt: string | null
}

/**
 * A hash with every bit the same describes a uniform image and identifies
 * nothing.
 *
 * This is not a theoretical edge case, it is most of this DAM. A white logo on
 * a transparent background flattened onto white is a blank white square, and
 * blockhash returns all-ones for it. Every such logo therefore produced the
 * identical hash `ffff…`, and duplicate detection cheerfully reported the
 * Strayer, JWMI, Sophia, Devmountain and Torrens logos as ten copies of one
 * image — all at Hamming distance 0, the strongest possible match.
 *
 * Discarding the blank hash is what makes the dual-hash design actually work:
 * the black-flattened hash of those same logos is fully distinctive. Better to
 * hold one good hash than two where one is confidently wrong.
 */
function isDegenerate(hash: string): boolean {
  return /^(.)\1*$/.test(hash)
}

/**
 * Hash an image once per plausible background.
 *
 * Measured: a resize to 120px scores a Hamming distance of 0, JPEG q60 and
 * WebP q70 score 2 — this hash is very robust to scaling and compression. The
 * one thing that destroys it is transparency being flattened onto a different
 * colour: the same logo exported white-on-transparent versus baked onto black
 * scores 108 out of 256 bits, which is close to unrelated.
 *
 * That case is not hypothetical — it is what happens whenever a transparent PNG
 * logo is exported to JPEG, and logos are exactly what people reverse-search.
 * So an image with alpha gets a second hash against black, and a search matches
 * on whichever pairing is closest.
 */
export async function computePhashVariants(imageBuffer: Buffer): Promise<PhashVariants> {
  const metadata = await sharp(imageBuffer).metadata()

  const white = await computePhash(imageBuffer, '#ffffff')
  const black = metadata.hasAlpha ? await computePhash(imageBuffer, '#000000') : null

  // A uniform flatten carries no signal — see `isDegenerate`. Both can be blank
  // for a genuinely blank image, which then indexes with no hash at all and is
  // reported as uncovered rather than matching everything.
  const usable = (hash: string | null): string | null =>
    hash !== null && !isDegenerate(hash) ? hash : null

  return { phash: usable(white), phashAlt: usable(black) }
}

/**
 * Closest distance between two images given every hash either one has.
 * Returns Infinity when no pair is comparable.
 */
export function bestDistance(
  left: ReadonlyArray<string | null>,
  right: ReadonlyArray<string | null>,
): number {
  let best = Number.POSITIVE_INFINITY

  for (const a of left) {
    if (!a) continue
    for (const b of right) {
      if (!b) continue
      const distance = hammingDistance(a, b)
      if (distance < best) best = distance
    }
  }

  return best
}

/**
 * Hamming distance between two hex pHashes.
 * Returns Infinity when the hashes are not comparable.
 */
export function hammingDistance(a: string, b: string): number {
  if (a.length !== b.length) return Number.POSITIVE_INFINITY

  let distance = 0
  for (let i = 0; i < a.length; i++) {
    const left = Number.parseInt(a[i] ?? '', 16)
    const right = Number.parseInt(b[i] ?? '', 16)
    if (Number.isNaN(left) || Number.isNaN(right)) return Number.POSITIVE_INFINITY

    // popcount of the 4-bit XOR
    let diff = left ^ right
    while (diff > 0) {
      distance += diff & 1
      diff >>= 1
    }
  }

  return distance
}

export function isDuplicate(a: string, b: string, threshold = DUPLICATE_THRESHOLD): boolean {
  return hammingDistance(a, b) <= threshold
}

export interface HashedAsset {
  id: string
  phash: string | null
}

/**
 * Group assets into duplicate clusters by single-link agglomeration: an asset
 * joins a group if it is within `threshold` of any member.
 *
 * This is O(n²) over hashed images. At Capella's scale (tens of thousands of
 * assets) that is a few seconds in a background job; if the DAM grows an order
 * of magnitude, swap this for BK-tree or LSH bucketing.
 */
export function groupDuplicates<T extends HashedAsset>(
  assets: T[],
  threshold = DUPLICATE_THRESHOLD,
): Array<{ members: T[]; maxDistance: number }> {
  const hashed = assets.filter((asset): asset is T & { phash: string } => asset.phash !== null)

  const parent = new Map<string, string>()
  const find = (id: string): string => {
    let root = id
    while ((parent.get(root) ?? root) !== root) root = parent.get(root) ?? root
    // Path compression keeps repeated lookups cheap.
    let cursor = id
    while ((parent.get(cursor) ?? cursor) !== root) {
      const next = parent.get(cursor) ?? cursor
      parent.set(cursor, root)
      cursor = next
    }
    return root
  }
  const union = (a: string, b: string): void => {
    const rootA = find(a)
    const rootB = find(b)
    if (rootA !== rootB) parent.set(rootA, rootB)
  }

  for (const asset of hashed) parent.set(asset.id, asset.id)

  const distances = new Map<string, number>()

  for (let i = 0; i < hashed.length; i++) {
    for (let j = i + 1; j < hashed.length; j++) {
      const left = hashed[i]
      const right = hashed[j]
      if (!left || !right) continue

      const distance = hammingDistance(left.phash, right.phash)
      if (distance <= threshold) {
        union(left.id, right.id)
        distances.set(`${left.id}:${right.id}`, distance)
      }
    }
  }

  const groups = new Map<string, T[]>()
  for (const asset of hashed) {
    const root = find(asset.id)
    const existing = groups.get(root)
    if (existing) existing.push(asset)
    else groups.set(root, [asset])
  }

  return [...groups.values()]
    // A group of one is not a duplicate.
    .filter((members) => members.length > 1)
    .map((members) => {
      const ids = new Set(members.map((member) => member.id))
      let maxDistance = 0
      for (const [key, distance] of distances) {
        const [a, b] = key.split(':')
        if (a && b && ids.has(a) && ids.has(b)) maxDistance = Math.max(maxDistance, distance)
      }
      return { members, maxDistance }
    })
    .sort((a, b) => b.members.length - a.members.length)
}
