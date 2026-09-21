import type { Prisma, Testimonial, TestimonialSourceType } from '@prisma/client'
import { prisma, type TxClient } from '../client.js'
import { parseSearchTerms, termMatchesAnyColumn, testimonialFullTextIds } from '../search.js'
import {
  fuseRankings,
  fuzzyTestimonialSearch,
  semanticTestimonialSearch,
  type FusedHit,
  type RankedList,
} from '../semantic.js'

export interface TestimonialUpsertInput {
  quoteText: string
  quoteFingerprint: string
  studentName: string | null
  program: string | null
  degreeLevel: string | null
  sourceType: TestimonialSourceType
  rawHtml: string | null
  seenAt: Date
}

/**
 * Upsert on the normalized fingerprint.
 *
 * Conflict rule (PRD §4): if `studentName` or `program` differ from what we
 * already hold for this fingerprint, set `needsReview = true` and keep the
 * existing values. We never silently overwrite an attribution — a human
 * reconciles it. A null incoming value is "no data on this page", not a
 * conflict, so it backfills an existing null but never clears a known value.
 */
export async function upsertByFingerprint(
  input: TestimonialUpsertInput,
  client: TxClient = prisma,
): Promise<Testimonial> {
  const existing = await client.testimonial.findUnique({
    where: { quoteFingerprint: input.quoteFingerprint },
  })

  if (!existing) {
    return client.testimonial.create({
      data: {
        quoteText: input.quoteText,
        quoteFingerprint: input.quoteFingerprint,
        studentName: input.studentName,
        program: input.program,
        degreeLevel: input.degreeLevel,
        sourceType: input.sourceType,
        rawHtml: input.rawHtml,
        firstSeenAt: input.seenAt,
        lastSeenAt: input.seenAt,
        isActive: true,
      },
    })
  }

  const nameConflicts =
    input.studentName !== null &&
    existing.studentName !== null &&
    input.studentName !== existing.studentName

  const programConflicts =
    input.program !== null && existing.program !== null && input.program !== existing.program

  return client.testimonial.update({
    where: { id: existing.id },
    data: {
      lastSeenAt: input.seenAt,
      isActive: true,
      deletedAt: null,
      // Backfill only — a known value is never replaced.
      studentName: existing.studentName ?? input.studentName,
      program: existing.program ?? input.program,
      degreeLevel: existing.degreeLevel ?? input.degreeLevel,
      // Sticky: once flagged, only a human clears it.
      needsReview: existing.needsReview || nameConflicts || programConflicts,
    },
  })
}

export interface TestimonialSearchParams {
  /** Single input — matched against quote, student name and program at once. */
  query?: string
  program?: string
  sourceType?: TestimonialSourceType
  needsReviewOnly?: boolean
  /** Only testimonials last seen more than N days ago (freshness flagging). */
  staleDays?: number
  /**
   * Embedding of `query`, supplied by the caller — the repository does not load
   * the model. Absent means semantic retrieval is skipped, which is what
   * happens before the index has been built.
   */
  queryVector?: number[]
  offset: number
  limit: number
}

export interface TestimonialSearchResult {
  testimonials: Testimonial[]
  total: number
  /** Why each returned row matched, keyed by id. Empty when browsing. */
  matches: Map<string, FusedHit>
}

/**
 * Search testimonials.
 *
 * With no query this is a plain filtered list, ordered by recency. With one, it
 * runs four independent retrieval passes and fuses them:
 *
 *   exact     every term appears somewhere (quote, name or program)
 *   stemmed   Postgres full text — "nurse" reaches "Nursing"
 *   semantic  cosine over sentence embeddings — paraphrase, no shared words
 *   fuzzy     small edit distance on name/program — typos
 *
 * Fused rather than replaced: the passes disagree usefully, and a row several
 * of them agree on is a better answer than one only the semantic pass liked.
 * The structured filters below still apply to whatever the fusion returns, so
 * "needs review only" narrows semantic hits exactly as it narrows literal ones.
 */
export async function search(
  params: TestimonialSearchParams,
): Promise<TestimonialSearchResult> {
  const where: Prisma.TestimonialWhereInput = { deletedAt: null }

  if (params.program) where.program = params.program
  if (params.sourceType) where.sourceType = params.sourceType
  if (params.needsReviewOnly) where.needsReview = true
  if (params.staleDays !== undefined) {
    const cutoff = new Date(Date.now() - params.staleDays * 24 * 60 * 60 * 1000)
    where.lastSeenAt = { lt: cutoff }
  }

  // ── No query: ordinary filtered browse ────────────────────────────────────
  if (!params.query?.trim()) {
    const [testimonials, total] = await prisma.$transaction([
      prisma.testimonial.findMany({
        where,
        orderBy: { lastSeenAt: 'desc' },
        skip: params.offset,
        take: params.limit,
      }),
      prisma.testimonial.count({ where }),
    ])
    return { testimonials, total, matches: new Map() }
  }

  const terms = parseSearchTerms(params.query)

  // ── Pass 1: every term present somewhere ──────────────────────────────────
  const termMatch: Prisma.TestimonialWhereInput = {
    AND: terms.map((term) => ({
      OR: termMatchesAnyColumn(term, ['quoteText', 'studentName', 'program'] as const),
    })),
  }

  const [exactRows, stemmedIds, semanticHits, fuzzyIds] = await Promise.all([
    prisma.testimonial.findMany({
      where: { AND: [where, termMatch] },
      select: { id: true },
      orderBy: { lastSeenAt: 'desc' },
      take: 200,
    }),
    testimonialFullTextIds(params.query),
    params.queryVector?.length ? semanticTestimonialSearch(params.queryVector) : [],
    fuzzyTestimonialSearch(terms),
  ])

  const lists: RankedList[] = [{ reason: 'exact', ids: exactRows.map((row) => row.id) }]
  if (stemmedIds.length > 0) lists.push({ reason: 'stemmed', ids: stemmedIds })
  if (semanticHits.length > 0) {
    lists.push({
      reason: 'semantic',
      ids: semanticHits.map((hit) => hit.id),
      scores: new Map(semanticHits.map((hit) => [hit.id, hit.similarity])),
    })
  }
  if (fuzzyIds.length > 0) lists.push({ reason: 'fuzzy', ids: fuzzyIds })

  const fused = fuseRankings(lists)
  if (fused.length === 0) return { testimonials: [], total: 0, matches: new Map() }

  // The semantic and fuzzy passes bypass `where`, so re-apply the structured
  // filters before counting or paginating — otherwise "needs review only" would
  // leak rows that do not need review.
  const eligible = await prisma.testimonial.findMany({
    where: { AND: [where, { id: { in: fused.map((hit) => hit.id) } }] },
    select: { id: true },
  })
  const eligibleIds = new Set(eligible.map((row) => row.id))

  const ranked = fused.filter((hit) => eligibleIds.has(hit.id))
  const pageIds = ranked.slice(params.offset, params.offset + params.limit).map((hit) => hit.id)

  const rows = await prisma.testimonial.findMany({ where: { id: { in: pageIds } } })

  // findMany does not preserve `in` order; restore the fused ranking.
  const byId = new Map(rows.map((row) => [row.id, row]))
  const testimonials = pageIds
    .map((id) => byId.get(id))
    .filter((row): row is Testimonial => row !== undefined)

  return {
    testimonials,
    total: ranked.length,
    matches: new Map(ranked.map((hit) => [hit.id, hit])),
  }
}

export async function findById(id: string): Promise<Testimonial | null> {
  return prisma.testimonial.findFirst({ where: { id, deletedAt: null } })
}

export async function countReferences(testimonialId: string): Promise<number> {
  return prisma.testimonialPageReference.count({
    where: { testimonialId, page: { deletedAt: null } },
  })
}

/**
 * Live testimonial count per program — backs the coverage-gap grid.
 * "Live" means the testimonial appears on at least one page we believe is published.
 */
export async function countLiveByProgram(): Promise<Array<{ program: string; count: number }>> {
  const rows = await prisma.testimonial.findMany({
    where: {
      deletedAt: null,
      isActive: true,
      program: { not: null },
      pageReferences: { some: { page: { isPublished: true, deletedAt: null } } },
    },
    select: { program: true },
  })

  const counts = new Map<string, number>()
  for (const row of rows) {
    if (row.program === null) continue
    counts.set(row.program, (counts.get(row.program) ?? 0) + 1)
  }

  return [...counts.entries()]
    .map(([program, count]) => ({ program, count }))
    .sort((a, b) => a.count - b.count)
}

export async function countAll(): Promise<number> {
  return prisma.testimonial.count({ where: { deletedAt: null } })
}

export async function countNeedingReview(): Promise<number> {
  return prisma.testimonial.count({ where: { needsReview: true, deletedAt: null } })
}

/** Unbounded — CSV export only. */
export async function streamAll(): Promise<Testimonial[]> {
  return prisma.testimonial.findMany({
    where: { deletedAt: null },
    orderBy: { lastSeenAt: 'desc' },
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
): Promise<Array<{ id: string; quoteText: string; studentName: string | null; program: string | null }>> {
  return prisma.testimonial.findMany({
    where: {
      deletedAt: null,
      OR: [{ embeddingModel: null }, { embeddingModel: { not: model } }],
    },
    select: { id: true, quoteText: true, studentName: true, program: true },
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
  await prisma.testimonial.update({
    where: { id },
    data: { embedding, embeddingModel: model, embeddedAt },
  })
}
