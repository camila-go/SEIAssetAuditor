import { pageRepo, testimonialRepo } from '@capella/db'
import {
  AppError,
  ERROR_CODES,
  type PageAppearance,
  type ProgramCoverage,
  type TestimonialSourceType,
  type TestimonialWithReferences,
} from '@capella/types'
import { toLiveStatus } from './auditService.js'
import { embed, isModelLoaded } from '@capella/embedding'
import { config } from '../config.js'
import { logger } from '../lib/logger.js'
import type { MatchReason } from '@capella/db'

/**
 * Embed the search query for the semantic pass.
 *
 * Returns undefined rather than throwing on any failure — a cold model, a
 * missing download, semantic search switched off. The lexical passes still run,
 * so search degrades in quality rather than breaking.
 *
 * The first call pays the model load (a few seconds). Every later one is
 * milliseconds, because the pipeline is cached in-process.
 */
async function embedQuery(query: string): Promise<number[] | undefined> {
  if (!config.semanticSearchEnabled) return undefined

  try {
    return await embed(query)
  } catch (error) {
    logger.warn({ err: error, modelLoaded: isModelLoaded() }, 'Query embedding failed — lexical only')
    return undefined
  }
}

/** Freshness thresholds from the frontend rules. Informational only. */
export const STALE_AMBER_DAYS = 90
export const STALE_RED_DAYS = 180

/** Coverage thresholds: 0 red, 1–2 amber, 3+ green. */
const COVERAGE_AMBER_MIN = 1
const COVERAGE_GREEN_MIN = 3

export function daysSince(date: Date): number {
  return Math.max(0, Math.floor((Date.now() - date.getTime()) / (24 * 60 * 60 * 1000)))
}

export async function search(params: {
  query?: string
  program?: string
  sourceType?: TestimonialSourceType
  needsReviewOnly?: boolean
  staleDays?: number
  offset: number
  limit: number
}): Promise<{ testimonials: TestimonialSummary[]; total: number }> {
  const queryVector = params.query?.trim() ? await embedQuery(params.query) : undefined

  const { testimonials, total, matches } = await testimonialRepo.search({
    ...params,
    ...(queryVector?.length ? { queryVector } : {}),
  })

  const rows = await Promise.all(
    testimonials.map(async (testimonial) => ({
      id: testimonial.id,
      quoteText: testimonial.quoteText,
      studentName: testimonial.studentName,
      program: testimonial.program,
      degreeLevel: testimonial.degreeLevel,
      sourceType: testimonial.sourceType,
      needsReview: testimonial.needsReview,
      isActive: testimonial.isActive,
      firstSeenAt: testimonial.firstSeenAt.toISOString(),
      lastSeenAt: testimonial.lastSeenAt.toISOString(),
      daysSinceLastSeen: daysSince(testimonial.lastSeenAt),
      referenceCount: await testimonialRepo.countReferences(testimonial.id),
      matchReasons: matches.get(testimonial.id)?.reasons ?? [],
      ...(matches.get(testimonial.id)?.similarity !== undefined
        ? { similarity: matches.get(testimonial.id)?.similarity }
        : {}),
    })),
  )

  return { testimonials: rows, total }
}

export interface TestimonialSummary {
  id: string
  quoteText: string
  studentName: string | null
  program: string | null
  degreeLevel: string | null
  sourceType: TestimonialSourceType
  needsReview: boolean
  isActive: boolean
  firstSeenAt: string
  lastSeenAt: string
  daysSinceLastSeen: number
  referenceCount: number
  /** Why this row matched. Empty when browsing without a query. */
  matchReasons: MatchReason[]
  /** Cosine similarity, present only when the semantic pass contributed. */
  similarity?: number
}

/** Testimonial detail with its full page map. */
export async function getById(id: string): Promise<TestimonialWithReferences> {
  const testimonial = await testimonialRepo.findById(id)
  if (!testimonial) {
    throw new AppError(ERROR_CODES.TESTIMONIAL_NOT_FOUND, `No testimonial with id ${id}`)
  }

  const pages = await pageRepo.findPagesForTestimonial(id)

  const appearances: PageAppearance[] = pages.map((page) => ({
    pageId: page.id,
    url: page.url,
    title: page.title,
    liveStatus: toLiveStatus(page.isPublished),
    lastCrawledAt: page.lastCrawledAt?.toISOString() ?? null,
    discoveredAt: page.discoveredAt.toISOString(),
  }))

  return {
    id: testimonial.id,
    quoteText: testimonial.quoteText,
    quoteFingerprint: testimonial.quoteFingerprint,
    studentName: testimonial.studentName,
    program: testimonial.program,
    degreeLevel: testimonial.degreeLevel,
    sourceType: testimonial.sourceType,
    rawHtml: testimonial.rawHtml,
    aemComponentPath: testimonial.aemComponentPath,
    needsReview: testimonial.needsReview,
    firstSeenAt: testimonial.firstSeenAt.toISOString(),
    lastSeenAt: testimonial.lastSeenAt.toISOString(),
    isActive: testimonial.isActive,
    deletedAt: testimonial.deletedAt?.toISOString() ?? null,
    referenceCount: appearances.length,
    daysSinceLastSeen: daysSince(testimonial.lastSeenAt),
    pages: appearances,
  }
}

/**
 * Program coverage gaps.
 *
 * `knownPrograms` matters: a program with zero testimonials produces no rows to
 * count, so it can only appear as a gap if we're told it exists. Until AEM's
 * program taxonomy is available (Phase 2), callers pass the programs seen in
 * the index, which means a program nobody has ever written about stays
 * invisible. That limitation is surfaced in the UI rather than hidden here.
 */
export async function getProgramCoverage(knownPrograms: string[] = []): Promise<ProgramCoverage[]> {
  const counts = await testimonialRepo.countLiveByProgram()
  const byProgram = new Map(counts.map((entry) => [entry.program, entry.count]))

  for (const program of knownPrograms) {
    if (!byProgram.has(program)) byProgram.set(program, 0)
  }

  return [...byProgram.entries()]
    .map(([program, count]) => ({
      program,
      liveTestimonialCount: count,
      severity: severityFor(count),
    }))
    .sort((a, b) => a.liveTestimonialCount - b.liveTestimonialCount || a.program.localeCompare(b.program))
}

function severityFor(count: number): ProgramCoverage['severity'] {
  if (count >= COVERAGE_GREEN_MIN) return 'green'
  if (count >= COVERAGE_AMBER_MIN) return 'amber'
  return 'red'
}

export async function getStats(): Promise<{
  totalTestimonials: number
  needingReview: number
  stale: number
}> {
  const [totalTestimonials, needingReview, staleResult] = await Promise.all([
    testimonialRepo.countAll(),
    testimonialRepo.countNeedingReview(),
    testimonialRepo.search({ staleDays: STALE_AMBER_DAYS, offset: 0, limit: 1 }),
  ])

  return { totalTestimonials, needingReview, stale: staleResult.total }
}
