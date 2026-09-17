import type { Prisma, SocialLink, SocialPlatform } from '@prisma/client'
import { prisma } from '../client.js'

/** Phase 3. Every caller must first check `config.socialEnabled`. */

export interface CreateSocialLinkInput {
  assetId: string
  platform: SocialPlatform
  postUrl: string
  postId: string | null
}

export async function link(input: CreateSocialLinkInput): Promise<SocialLink> {
  return prisma.socialLink.upsert({
    where: { platform_postUrl: { platform: input.platform, postUrl: input.postUrl } },
    create: input,
    update: { assetId: input.assetId, postId: input.postId },
  })
}

export async function findForAsset(assetId: string): Promise<SocialLink[]> {
  return prisma.socialLink.findMany({ where: { assetId } })
}

export async function setMetrics(
  id: string,
  metricsJson: Record<string, unknown>,
): Promise<void> {
  await prisma.socialLink.update({
    where: { id },
    // Prisma's Json input type does not accept a bare Record — the platform
    // payloads are arbitrary JSON, so narrow at the boundary rather than
    // pretending we know each provider's shape.
    data: { metricsJson: metricsJson as Prisma.InputJsonValue, lastFetchedAt: new Date() },
  })
}

/** Links whose metrics are older than `staleMinutes`, oldest first. */
export async function findStale(staleMinutes: number, limit: number): Promise<SocialLink[]> {
  const cutoff = new Date(Date.now() - staleMinutes * 60 * 1000)
  return prisma.socialLink.findMany({
    where: { OR: [{ lastFetchedAt: null }, { lastFetchedAt: { lt: cutoff } }] },
    orderBy: { lastFetchedAt: 'asc' },
    take: limit,
  })
}

export async function findAll(): Promise<SocialLink[]> {
  return prisma.socialLink.findMany({ orderBy: { lastFetchedAt: 'desc' } })
}
