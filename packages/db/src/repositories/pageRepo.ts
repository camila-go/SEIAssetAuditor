import type { Page } from '@prisma/client'
import { prisma, type TxClient } from '../client.js'

export interface PageUpsertInput {
  url: string
  title: string | null
  isPublished: boolean | null
  crawledAt: Date
}

export async function upsertFromScrape(
  input: PageUpsertInput,
  client: TxClient = prisma,
): Promise<Page> {
  return client.page.upsert({
    where: { url: input.url },
    create: {
      url: input.url,
      title: input.title,
      isPublished: input.isPublished,
      lastCrawledAt: input.crawledAt,
    },
    update: {
      title: input.title,
      isPublished: input.isPublished,
      lastCrawledAt: input.crawledAt,
      deletedAt: null,
    },
  })
}

export async function findByUrl(url: string): Promise<Page | null> {
  return prisma.page.findFirst({ where: { url, deletedAt: null } })
}

/** Every page a given asset appears on, newest discovery first. */
export async function findPagesForAsset(assetId: string): Promise<
  Array<Page & { discoveredAt: Date }>
> {
  const refs = await prisma.assetPageReference.findMany({
    where: { assetId, page: { deletedAt: null } },
    include: { page: true },
    orderBy: { discoveredAt: 'desc' },
  })
  return refs.map((ref) => ({ ...ref.page, discoveredAt: ref.discoveredAt }))
}

export async function findPagesForTestimonial(testimonialId: string): Promise<
  Array<Page & { discoveredAt: Date; positionOnPage: number | null }>
> {
  const refs = await prisma.testimonialPageReference.findMany({
    where: { testimonialId, page: { deletedAt: null } },
    include: { page: true },
    orderBy: { discoveredAt: 'desc' },
  })
  return refs.map((ref) => ({
    ...ref.page,
    discoveredAt: ref.discoveredAt,
    positionOnPage: ref.positionOnPage,
  }))
}

export async function linkAsset(
  assetId: string,
  pageId: string,
  client: TxClient = prisma,
): Promise<void> {
  // Re-crawling a page must not duplicate the reference row.
  await client.assetPageReference.upsert({
    where: { assetId_pageId: { assetId, pageId } },
    create: { assetId, pageId },
    update: {},
  })
}

export async function linkTestimonial(
  testimonialId: string,
  pageId: string,
  positionOnPage: number | null,
  client: TxClient = prisma,
): Promise<void> {
  await client.testimonialPageReference.upsert({
    where: { testimonialId_pageId: { testimonialId, pageId } },
    create: { testimonialId, pageId, positionOnPage },
    update: { positionOnPage },
  })
}

export async function countAll(): Promise<number> {
  return prisma.page.count({ where: { deletedAt: null } })
}

export async function countPublished(): Promise<number> {
  return prisma.page.count({ where: { isPublished: true, deletedAt: null } })
}
