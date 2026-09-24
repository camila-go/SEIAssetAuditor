import type { Asset, AssetType, Prisma } from '@prisma/client'
import { prisma, type TxClient } from '../client.js'
import { parseSearchTerms, termMatchesAnyColumn } from '../search.js'
import { fuseRankings, semanticAssetSearch, type FusedHit, type RankedList } from '../semantic.js'

export interface AssetSearchParams {
  query?: string
  assetType?: AssetType
  /** Only assets with zero page references (Phase 2 "unused asset flagging"). */
  unusedOnly?: boolean
  /** Embedding of `query`; absent skips the semantic pass. */
  queryVector?: number[]
  offset: number
  limit: number
}

/** Derive asset type from the file extension. Unknown extensions fall back to `other`. */
export function assetTypeForPath(aemPath: string): AssetType {
  const ext = aemPath.split('.').pop()?.toLowerCase() ?? ''
  if (['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'avif', 'bmp', 'tif', 'tiff'].includes(ext)) {
    return 'image'
  }
  if (['mp4', 'mov', 'webm', 'm4v', 'avi', 'mkv'].includes(ext)) return 'video'
  if (['pdf', 'doc', 'docx', 'ppt', 'pptx', 'xls', 'xlsx', 'txt'].includes(ext)) return 'document'
  if (['mp3', 'wav', 'aac', 'm4a', 'ogg', 'vtt'].includes(ext)) return 'audio'
  return 'other'
}

export function filenameForPath(aemPath: string): string {
  return aemPath.split('/').filter(Boolean).pop() ?? aemPath
}

/**
 * Insert the asset if new, otherwise just refresh `lastSeenAt`.
 * Never overwrites Phase 2 metadata (dimensions, tags) with Phase 1 nulls.
 */
export async function upsertFromScrape(
  aemPath: string,
  seenAt: Date,
  client: TxClient = prisma,
): Promise<Asset> {
  return client.asset.upsert({
    where: { aemPath },
    create: {
      aemPath,
      filename: filenameForPath(aemPath),
      assetType: assetTypeForPath(aemPath),
      lastSeenAt: seenAt,
      isIndexed: true,
    },
    update: {
      lastSeenAt: seenAt,
      isIndexed: true,
      deletedAt: null,
    },
  })
}

export async function findByPath(aemPath: string): Promise<Asset | null> {
  return prisma.asset.findFirst({ where: { aemPath, deletedAt: null } })
}

export async function findById(id: string): Promise<Asset | null> {
  return prisma.asset.findFirst({ where: { id, deletedAt: null } })
}

export interface AssetSearchResult {
  assets: Asset[]
  total: number
  /** Why each returned row matched, keyed by id. Empty when browsing. */
  matches: Map<string, FusedHit>
}

/**
 * Search assets.
 *
 * Two passes, fused: every term appearing in the filename or path, and cosine
 * similarity over an embedding of the humanised path.
 *
 * The semantic pass is genuinely weaker here than for testimonials, and that is
 * a property of the data rather than the implementation — a filename is all the
 * meaning an asset carries until AEM supplies titles and tags in Phase 2.
 * "capella logo horizontal" embeds usefully; "browsinglaptopdog" is one token
 * and does not. Term matching still handles that case, which is exactly why
 * both passes are kept.
 */
export async function search(params: AssetSearchParams): Promise<AssetSearchResult> {
  const where: Prisma.AssetWhereInput = { deletedAt: null }

  if (params.assetType) where.assetType = params.assetType
  if (params.unusedOnly) where.pageReferences = { none: {} }

  if (!params.query?.trim()) {
    const [assets, total] = await prisma.$transaction([
      prisma.asset.findMany({
        where,
        orderBy: [{ lastSeenAt: 'desc' }, { filename: 'asc' }],
        skip: params.offset,
        take: params.limit,
      }),
      prisma.asset.count({ where }),
    ])
    return { assets, total, matches: new Map() }
  }

  // Filenames are separator-joined, not prose, so the query is split on the
  // same separators and every term must appear somewhere. No stemming:
  // `contains` still matches inside a run-on filename, which is how "dog"
  // finds hero_browsinglaptopdog.jpg — a token index would lose that.
  const termMatch: Prisma.AssetWhereInput = {
    AND: parseSearchTerms(params.query).map((term) => ({
      OR: termMatchesAnyColumn(term, ['filename', 'aemPath'] as const),
    })),
  }

  const [exactRows, semanticHits] = await Promise.all([
    prisma.asset.findMany({
      where: { AND: [where, termMatch] },
      select: { id: true },
      orderBy: [{ lastSeenAt: 'desc' }, { filename: 'asc' }],
      take: 200,
    }),
    params.queryVector?.length ? semanticAssetSearch(params.queryVector) : [],
  ])

  const lists: RankedList[] = [{ reason: 'exact', ids: exactRows.map((row) => row.id) }]
  if (semanticHits.length > 0) {
    lists.push({
      reason: 'semantic',
      ids: semanticHits.map((hit) => hit.id),
      scores: new Map(semanticHits.map((hit) => [hit.id, hit.similarity])),
    })
  }

  const fused = fuseRankings(lists)
  if (fused.length === 0) return { assets: [], total: 0, matches: new Map() }

  // The semantic pass bypasses `where`, so re-apply the structured filters.
  const eligible = await prisma.asset.findMany({
    where: { AND: [where, { id: { in: fused.map((hit) => hit.id) } }] },
    select: { id: true },
  })
  const eligibleIds = new Set(eligible.map((row) => row.id))

  const ranked = fused.filter((hit) => eligibleIds.has(hit.id))
  const pageIds = ranked.slice(params.offset, params.offset + params.limit).map((hit) => hit.id)

  const rows = await prisma.asset.findMany({ where: { id: { in: pageIds } } })
  const byId = new Map(rows.map((row) => [row.id, row]))

  return {
    assets: pageIds.map((id) => byId.get(id)).filter((row): row is Asset => row !== undefined),
    total: ranked.length,
    matches: new Map(ranked.map((hit) => [hit.id, hit])),
  }
}

export async function countReferences(assetId: string): Promise<number> {
  return prisma.assetPageReference.count({
    where: { assetId, page: { deletedAt: null } },
  })
}

/** Assets that still need a pHash computed — fed to the pHash background job. */
export async function findNeedingPhash(limit: number): Promise<Asset[]> {
  return prisma.asset.findMany({
    where: {
      assetType: 'image',
      deletedAt: null,
      // BOTH must be null, matching `countHashedImages`. Selecting on `phash`
      // alone re-selected every white-on-transparent logo on every sweep: those
      // rows have `phash = null` *by design*, because flattening them onto white
      // yields a blank square whose hash identifies nothing, so only the
      // black-flattened `phashAlt` is kept. They are fully searchable, yet the
      // sweep kept re-downloading and re-hashing them forever.
      //
      // Invisible while the sweep was manual and occasional. It became real
      // waste against a site we do not own once every completed audit started
      // queueing one — the first run after that change considered 18 images
      // when only 8 could possibly need work.
      AND: [{ phash: null }, { phashAlt: null }],
    },
    take: limit,
    orderBy: { createdAt: 'asc' },
  })
}

export async function setPhash(
  id: string,
  phash: string | null,
  phashAlt: string | null = null,
): Promise<void> {
  await prisma.asset.update({ where: { id }, data: { phash, phashAlt } })
}

/** All image assets with a pHash — the duplicate detector compares these pairwise. */
export async function findAllWithPhash(): Promise<
  Array<
    Pick<
      Asset,
      'id' | 'aemPath' | 'filename' | 'fileSize' | 'width' | 'height' | 'phash' | 'phashAlt'
    >
  >
> {
  return prisma.asset.findMany({
    where: { phash: { not: null }, deletedAt: null },
    select: {
      id: true,
      aemPath: true,
      filename: true,
      fileSize: true,
      width: true,
      height: true,
      phash: true,
      phashAlt: true,
    },
  })
}

/** Soft delete only — audit history must be preserved. */
export async function softDelete(id: string): Promise<void> {
  await prisma.asset.update({ where: { id }, data: { deletedAt: new Date() } })
}

export async function countAll(): Promise<number> {
  return prisma.asset.count({ where: { deletedAt: null } })
}

/** Image assets in the index — the denominator for pHash coverage. */
export async function countImages(): Promise<number> {
  return prisma.asset.count({ where: { assetType: 'image', deletedAt: null } })
}

/**
 * Image assets that actually have a hash, and so can be matched by image.
 *
 * Either hash counts. A white-on-transparent logo has no usable white-flattened
 * hash — that flatten is a blank square — but its black-flattened hash is fully
 * distinctive and searchable. Counting only `phash` reported 46 of 58 when 56
 * were findable, which understates coverage exactly as misleadingly as
 * overstating it would.
 */
export async function countHashedImages(): Promise<number> {
  return prisma.asset.count({
    where: {
      assetType: 'image',
      deletedAt: null,
      OR: [{ phash: { not: null } }, { phashAlt: { not: null } }],
    },
  })
}

/**
 * Rows still needing an embedding for `model`.
 *
 * The OR is load-bearing, not defensive. `NOT (embedding_model = 'x')`
 * evaluates to NULL when the column IS NULL, and a WHERE drops NULL rows — so
 * the obvious `{ not: model }` silently skipped every row that had never been
 * embedded, which was all of them. The sweep reported "0 processed" and looked
 * like it had finished.
 */
export async function findNeedingEmbedding(
  model: string,
  limit: number,
): Promise<Array<{ id: string; filename: string; aemPath: string; tags: string[] }>> {
  return prisma.asset.findMany({
    where: {
      deletedAt: null,
      OR: [{ embeddingModel: null }, { embeddingModel: { not: model } }],
    },
    select: { id: true, filename: true, aemPath: true, tags: true },
    take: limit,
    orderBy: { id: 'asc' },
  })
}

/** Record an embedding. `embeddedAt` is passed in so one batch shares a timestamp. */
export async function setEmbedding(
  id: string,
  embedding: number[],
  model: string,
  embeddedAt: Date,
): Promise<void> {
  await prisma.asset.update({
    where: { id },
    data: { embedding, embeddingModel: model, embeddedAt },
  })
}

// ─── Link-rot verification ───────────────────────────────────────────────────

/**
 * Assets due a liveness re-check, oldest first.
 *
 * Never-checked rows sort first because `lastVerifiedAt` is null, which is what
 * we want: a freshly indexed asset has never been confirmed to still exist.
 */
export async function findNeedingVerification(
  staleBefore: Date,
  limit: number,
  force = false,
): Promise<Array<{ id: string; aemPath: string }>> {
  return prisma.asset.findMany({
    where: {
      deletedAt: null,
      ...(force ? {} : { OR: [{ lastVerifiedAt: null }, { lastVerifiedAt: { lt: staleBefore } }] }),
    },
    select: { id: true, aemPath: true },
    orderBy: [{ lastVerifiedAt: { sort: 'asc', nulls: 'first' } }, { createdAt: 'asc' }],
    take: limit,
  })
}

/** `status` is 0 when the request never completed — DNS, timeout, reset. */
export async function recordVerification(
  id: string,
  status: number,
  checkedAt: Date,
): Promise<void> {
  await prisma.asset.update({
    where: { id },
    data: { lastVerifiedAt: checkedAt, lastVerifiedStatus: status },
  })
}

export interface VerificationSummary {
  total: number
  checked: number
  live: number
  /** Checked and NOT served — the link rot this exists to find. */
  missing: number
  /** Oldest check still on record, so the UI can say how current this is. */
  oldestCheck: Date | null
  newestCheck: Date | null
}

/**
 * How trustworthy the "appears on" answers currently are.
 *
 * Surfaced rather than kept internal for the same reason pHash coverage is: a
 * page map built from a months-old crawl looks identical to one built this
 * morning unless the tool says otherwise.
 */
export async function getVerificationSummary(): Promise<VerificationSummary> {
  const base = { deletedAt: null } as const

  const [total, checked, live, missing, oldest, newest] = await Promise.all([
    prisma.asset.count({ where: base }),
    prisma.asset.count({ where: { ...base, lastVerifiedAt: { not: null } } }),
    prisma.asset.count({ where: { ...base, lastVerifiedStatus: { gte: 200, lt: 400 } } }),
    prisma.asset.count({ where: { ...base, lastVerifiedStatus: { gte: 400 } } }),
    prisma.asset.findFirst({
      where: { ...base, lastVerifiedAt: { not: null } },
      orderBy: { lastVerifiedAt: 'asc' },
      select: { lastVerifiedAt: true },
    }),
    prisma.asset.findFirst({
      where: { ...base, lastVerifiedAt: { not: null } },
      orderBy: { lastVerifiedAt: 'desc' },
      select: { lastVerifiedAt: true },
    }),
  ])

  return {
    total,
    checked,
    live,
    missing,
    oldestCheck: oldest?.lastVerifiedAt ?? null,
    newestCheck: newest?.lastVerifiedAt ?? null,
  }
}

/** Assets confirmed gone, for the maintenance view. */
export async function findMissing(limit = 200): Promise<Asset[]> {
  return prisma.asset.findMany({
    where: { deletedAt: null, lastVerifiedStatus: { gte: 400 } },
    orderBy: { lastVerifiedAt: 'desc' },
    take: limit,
  })
}
