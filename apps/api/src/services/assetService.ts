import { assetRepo, pageRepo } from '@capella/db'
import { AemClient, DAM_ROOT, groupDuplicates, normalizeAssetPath } from '@capella/scraper'
import {
  AppError,
  ERROR_CODES,
  type AssetType,
  type AssetWithReferences,
  type DuplicateGroup,
  type PageAppearance,
} from '@capella/types'
import { config, publicAssetUrl } from '../config.js'
import { embed } from '@capella/embedding'
import type { MatchReason } from '@capella/db'
import { toLiveStatus } from './auditService.js'
import { logger } from '../lib/logger.js'

/**
 * Asset search, reverse lookup and duplicate detection.
 *
 * Reverse lookup is Phase 1 (indexed scrape results) with a Phase 2 upgrade:
 * when the AEM API is available, Query Builder is authoritative because it sees
 * references on pages we never crawled.
 */

export async function search(params: {
  query?: string
  assetType?: AssetType
  unusedOnly?: boolean
  offset: number
  limit: number
}): Promise<{ assets: SearchRow[]; total: number }> {
  // Same degrade-gracefully contract as testimonial search: a failed embed
  // costs semantic recall, not the whole result set.
  let queryVector: number[] | undefined
  if (config.semanticSearchEnabled && params.query?.trim()) {
    try {
      queryVector = await embed(params.query)
    } catch (error) {
      logger.warn({ err: error }, 'Asset query embedding failed — lexical only')
    }
  }

  const { assets, total, matches } = await assetRepo.search({
    ...params,
    ...(queryVector?.length ? { queryVector } : {}),
  })

  const rows = await Promise.all(
    assets.map(async (asset) => ({
      id: asset.id,
      aemPath: asset.aemPath,
      filename: asset.filename,
      assetType: asset.assetType,
      publicUrl: publicAssetUrl(asset.aemPath),
      width: asset.width,
      height: asset.height,
      fileSize: asset.fileSize,
      tags: asset.tags,
      lastSeenAt: asset.lastSeenAt?.toISOString() ?? null,
      referenceCount: await assetRepo.countReferences(asset.id),
      matchReasons: matches.get(asset.id)?.reasons ?? [],
      ...(matches.get(asset.id)?.similarity !== undefined
        ? { similarity: matches.get(asset.id)?.similarity }
        : {}),
    })),
  )

  return { assets: rows, total }
}

export interface SearchRow {
  id: string
  aemPath: string
  filename: string
  assetType: AssetType
  publicUrl: string
  width: number | null
  height: number | null
  fileSize: number | null
  tags: string[]
  lastSeenAt: string | null
  referenceCount: number
  /** Why this row matched. Empty when browsing without a query. */
  matchReasons: MatchReason[]
  /** Cosine similarity, present only when the semantic pass contributed. */
  similarity?: number
}

/**
 * Reverse lookup: every page an asset appears on.
 *
 * Accepts a full public URL, a DAM path, or a rendition URL — designers paste
 * whatever they copied out of AEM or the browser address bar.
 */
export async function reverseLookup(rawPath: string): Promise<AssetWithReferences> {
  const aemPath = normalizeAssetPath(rawPath)

  if (!aemPath) {
    throw new AppError(
      ERROR_CODES.INVALID_ASSET_PATH,
      `That does not look like a DAM asset. Expected a path containing ${DAM_ROOT} and ending in a filename — for example ${DAM_ROOT}sei/capella/photo.jpg. Page URLs and folder paths have no asset to look up.`,
    )
  }

  const asset = await assetRepo.findByPath(aemPath)
  if (!asset) {
    throw new AppError(
      ERROR_CODES.ASSET_NOT_FOUND,
      `${aemPath} has not been indexed yet. Run an audit that covers the pages it appears on.`,
    )
  }

  const pages = await pageRepo.findPagesForAsset(asset.id)

  const appearances: PageAppearance[] = pages.map((page) => ({
    pageId: page.id,
    url: page.url,
    title: page.title,
    liveStatus: toLiveStatus(page.isPublished),
    lastCrawledAt: page.lastCrawledAt?.toISOString() ?? null,
    discoveredAt: page.discoveredAt.toISOString(),
  }))

  // Phase 2: AEM knows about references on pages we never crawled.
  if (config.aemApiEnabled) {
    try {
      appearances.push(...(await aemReferences(aemPath, new Set(appearances.map((a) => a.url)))))
    } catch (error) {
      // A degraded lookup beats no lookup — the scraped results still stand.
      logger.warn({ err: error, aemPath }, 'AEM reverse lookup failed; returning scraped results only')
    }
  }

  return {
    id: asset.id,
    aemPath: asset.aemPath,
    filename: asset.filename,
    assetType: asset.assetType,
    width: asset.width,
    height: asset.height,
    fileSize: asset.fileSize,
    tags: asset.tags,
    lastSeenAt: asset.lastSeenAt?.toISOString() ?? null,
    phash: asset.phash,
    isIndexed: asset.isIndexed,
    deletedAt: asset.deletedAt?.toISOString() ?? null,
    createdAt: asset.createdAt.toISOString(),
    updatedAt: asset.updatedAt.toISOString(),
    publicUrl: publicAssetUrl(asset.aemPath),
    referenceCount: appearances.length,
    pages: appearances,
  }
}

/** Query Builder references, excluding pages we already found by scraping. */
async function aemReferences(aemPath: string, knownUrls: Set<string>): Promise<PageAppearance[]> {
  const client = new AemClient({
    authorHost: config.aemAuthorHost,
    username: config.aemServiceAccountUser,
    password: config.aemServiceAccountPassword,
    pagePath: config.aemPagePath,
  })

  const hits = await client.findPagesReferencingAsset(aemPath, 500)

  return hits
    .map((hit): PageAppearance => {
      // JCR path -> public URL: /content/capella/en/about -> {host}/about
      const publicPath = hit.path.replace(/^\/content\/capella\/en/, '') || '/'
      return {
        pageId: `aem:${hit.path}`,
        url: `${config.aemPublicHost}${publicPath}`,
        title: hit.title,
        // cq:lastReplicated is set only on a published page — this is the
        // authoritative signal the Phase 1 heuristic cannot reach.
        liveStatus: hit.lastReplicated ? 'published' : 'draft',
        lastCrawledAt: null,
        discoveredAt: new Date().toISOString(),
      }
    })
    .filter((appearance) => !knownUrls.has(appearance.url))
}

export async function getById(id: string): Promise<AssetWithReferences> {
  const asset = await assetRepo.findById(id)
  if (!asset) throw new AppError(ERROR_CODES.ASSET_NOT_FOUND, `No asset with id ${id}`)
  return reverseLookup(asset.aemPath)
}

/**
 * Duplicate groups by perceptual hash.
 *
 * Phase 2 feature: pHashes are only populated once the background hashing job
 * has run, which itself requires downloading each image.
 */
export async function findDuplicates(threshold: number): Promise<DuplicateGroup[]> {
  const assets = await assetRepo.findAllWithPhash()

  // groupDuplicates compares the primary hash only. Both hashes of a given
  // asset describe the same file, so the alt hash adds nothing when comparing
  // two DAM assets to each other — it only matters for an external query image
  // whose transparency was already baked in.
  return groupDuplicates(assets, threshold).map((group) => ({
    phash: group.members[0]?.phash ?? '',
    maxDistance: group.maxDistance,
    assets: group.members.map((member) => ({
      id: member.id,
      aemPath: member.aemPath,
      filename: member.filename,
      fileSize: member.fileSize,
      width: member.width,
      height: member.height,
    })),
  }))
}

/** Dashboard tile: indexed assets, pages, published pages. */
export async function getStats(): Promise<{
  totalAssets: number
  totalPages: number
  publishedPages: number
}> {
  const [totalAssets, totalPages, publishedPages] = await Promise.all([
    assetRepo.countAll(),
    pageRepo.countAll(),
    pageRepo.countPublished(),
  ])
  return { totalAssets, totalPages, publishedPages }
}
