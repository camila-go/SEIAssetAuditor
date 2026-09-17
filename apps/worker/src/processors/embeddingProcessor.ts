import type { Job } from 'bullmq'
import { prisma } from '@capella/db'
import type { EmbeddingJobPayload } from '@capella/queue'
import { EMBEDDING_MODEL, embedBatch, humanizePath } from '@capella/embedding'
import { logger } from '../lib/logger.js'

/**
 * Build the semantic index.
 *
 * Runs in the worker, never on a request: the model takes seconds to load and
 * embedding a corpus is minutes of CPU. The API only ever embeds the short
 * query string.
 *
 * Only rows that need it are processed — anything already embedded by the
 * current model is skipped, so a repeated sweep is close to free. Changing the
 * model invalidates every row automatically, because the stored
 * `embeddingModel` no longer matches.
 */

/** Small enough to keep memory flat, large enough to amortise the model call. */
const BATCH_SIZE = 32

export async function processEmbeddingJob(job: Job<EmbeddingJobPayload>): Promise<void> {
  const target = job.data.target
  const started = Date.now()

  let testimonials = 0
  let assets = 0

  if (!target || target === 'testimonials') testimonials = await embedTestimonials()
  if (!target || target === 'assets') assets = await embedAssets()

  logger.info(
    { testimonials, assets, seconds: Math.round((Date.now() - started) / 1000) },
    'Embedding sweep complete',
  )
}

/**
 * Embed the quote plus its attribution.
 *
 * The name and program are included because they are part of what someone
 * searches for — "a nursing student talking about flexibility" should reach
 * this row through the program as well as the prose.
 */
async function embedTestimonials(): Promise<number> {
  let processed = 0

  for (;;) {
    const rows = await prisma.testimonial.findMany({
      // NOT the whole predicate: `NOT (embedding_model = 'x')` evaluates to
      // NULL for a row whose column IS NULL, and SQL drops NULL rows from a
      // WHERE. Written the obvious way, the sweep silently skipped every row
      // that had never been embedded — which is all of them.
      where: {
        deletedAt: null,
        OR: [{ embeddingModel: null }, { embeddingModel: { not: EMBEDDING_MODEL } }],
      },
      select: { id: true, quoteText: true, studentName: true, program: true },
      take: BATCH_SIZE,
      orderBy: { id: 'asc' },
    })
    if (rows.length === 0) break

    const texts = rows.map((row) =>
      [row.quoteText, row.studentName, row.program].filter(Boolean).join('. '),
    )

    const vectors = await embedBatch(texts)
    const embeddedAt = new Date()

    for (const [index, row] of rows.entries()) {
      const embedding = vectors[index]
      if (!embedding) continue
      await prisma.testimonial.update({
        where: { id: row.id },
        data: { embedding, embeddingModel: EMBEDDING_MODEL, embeddedAt },
      })
      processed++
    }
  }

  return processed
}

/**
 * Embed a readable form of the filename and path.
 *
 * This is weaker than testimonial embedding and honestly so: a filename is all
 * the semantic surface an asset has until AEM supplies titles, descriptions and
 * tags in Phase 2. "capella logo horizontal" embeds usefully; a run-on like
 * "browsinglaptopdog" does not tokenise and will not.
 */
async function embedAssets(): Promise<number> {
  let processed = 0

  for (;;) {
    const rows = await prisma.asset.findMany({
      // NOT the whole predicate: `NOT (embedding_model = 'x')` evaluates to
      // NULL for a row whose column IS NULL, and SQL drops NULL rows from a
      // WHERE. Written the obvious way, the sweep silently skipped every row
      // that had never been embedded — which is all of them.
      where: {
        deletedAt: null,
        OR: [{ embeddingModel: null }, { embeddingModel: { not: EMBEDDING_MODEL } }],
      },
      select: { id: true, filename: true, aemPath: true, tags: true },
      take: BATCH_SIZE,
      orderBy: { id: 'asc' },
    })
    if (rows.length === 0) break

    const texts = rows.map((row) => {
      const readable = humanizePath(row.aemPath)
      // Tags are empty until Phase 2, but including them now means the index
      // improves on its own the moment AEM metadata arrives.
      return [readable, ...row.tags].filter(Boolean).join('. ')
    })

    const vectors = await embedBatch(texts)
    const embeddedAt = new Date()

    for (const [index, row] of rows.entries()) {
      const embedding = vectors[index]
      if (!embedding) continue
      await prisma.asset.update({
        where: { id: row.id },
        data: { embedding, embeddingModel: EMBEDDING_MODEL, embeddedAt },
      })
      processed++
    }
  }

  return processed
}
