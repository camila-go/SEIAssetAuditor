import { cosineSimilarity, EMBEDDING_MODEL, RELEVANCE_THRESHOLD } from '@capella/embedding'
import { prisma } from './client.js'

/**
 * Semantic (meaning-based) retrieval, and the fusion that combines it with the
 * lexical passes.
 *
 * ── Why similarity is computed in the application ────────────────────────
 * This Postgres has no `vector` extension available (checked: only pg_trgm,
 * fuzzystrmatch and unaccent are), so embeddings are stored as `Float[]` and
 * compared here. A brute-force scan of N 384-dimension vectors is N × 384
 * multiply-adds: at ten thousand rows that is under 4M operations, a few
 * milliseconds, comfortably inside the PRD's 2-second budget.
 *
 * It stops being fine somewhere around 100k rows, or once this runs on every
 * keystroke. At that point install pgvector and replace `semanticSearch` with
 * an `ORDER BY embedding <=> $1 LIMIT k` query against an HNSW index — the
 * shape of this function is deliberately the same as that query so the swap
 * touches nothing else.
 */

export interface SemanticHit {
  id: string
  similarity: number
}

interface EmbeddedRow {
  id: string
  embedding: number[]
  embeddingModel: string | null
}

/**
 * Keep only hits close to the best one.
 *
 * An absolute floor alone is not enough, and the asset corpus shows why: for
 * the query "capella logo", every single asset scored above 0.30 — because
 * every asset genuinely is a Capella asset. The floor admitted the entire
 * table, turning a 4-result search into 14.
 *
 * Measured distributions:
 *   "capella logo"        0.768, 0.736, 0.650, 0.632, … tail at 0.317
 *   "university branding" 0.536, 0.476, 0.467, … tail at 0.082
 *   "dog"                 0.314, then 0.170
 *
 * The signal is the gap below the leaders, not the absolute value, so hits are
 * also required to be within this fraction of the top score. At 0.85 that keeps
 * the three real logos and drops the rest, keeps the single "dog" match, and
 * still admits nothing for an unrelated query.
 */
const RELATIVE_CUTOFF = 0.85

/** No query usefully has more than this many meaning-based matches. */
const MAX_SEMANTIC_HITS = 25

/** Rank rows by cosine similarity to an already-embedded query vector. */
function rank(rows: EmbeddedRow[], queryVector: number[], limit: number): SemanticHit[] {
  if (queryVector.length === 0) return []

  const scored: SemanticHit[] = []

  for (const row of rows) {
    // A row embedded by a different model is not comparable. Skipping it is
    // correct — it will be re-embedded by the next sweep.
    if (row.embeddingModel !== EMBEDDING_MODEL) continue
    if (row.embedding.length === 0) continue

    const similarity = cosineSimilarity(queryVector, row.embedding)
    if (similarity >= RELEVANCE_THRESHOLD) scored.push({ id: row.id, similarity })
  }

  if (scored.length === 0) return []

  scored.sort((a, b) => b.similarity - a.similarity)

  const best = scored[0]?.similarity ?? 0
  const cutoff = Math.max(RELEVANCE_THRESHOLD, best * RELATIVE_CUTOFF)

  return scored
    .filter((hit) => hit.similarity >= cutoff)
    .slice(0, Math.min(limit, MAX_SEMANTIC_HITS))
}

export async function semanticTestimonialSearch(
  queryVector: number[],
  limit = 50,
): Promise<SemanticHit[]> {
  const rows = await prisma.testimonial.findMany({
    where: { deletedAt: null, embeddingModel: EMBEDDING_MODEL },
    select: { id: true, embedding: true, embeddingModel: true },
  })
  return rank(rows, queryVector, limit)
}

export async function semanticAssetSearch(
  queryVector: number[],
  limit = 50,
): Promise<SemanticHit[]> {
  const rows = await prisma.asset.findMany({
    where: { deletedAt: null, embeddingModel: EMBEDDING_MODEL },
    select: { id: true, embedding: true, embeddingModel: true },
  })
  return rank(rows, queryVector, limit)
}

// ─── Typo tolerance ──────────────────────────────────────────────────────────

/**
 * Maximum edit distance that still counts as a typo.
 *
 * Measured on the real corpus: genuine typos score 1–2 ("Wbeb"→"Webb" is 2,
 * "Marcs"→"Marcus" is 1), while unrelated words score 4–5 ("zzzz"→"Webb" is 4,
 * "Okoro"→"Webb" is 5). 2 sits in that gap.
 *
 * Trigram similarity was tried first and rejected: it scores "Wbeb"→"Webb" at
 * 0.111 because trigrams are order-sensitive and a transposition destroys two
 * of them. Edit distance is the right tool for transposed characters.
 */
const MAX_EDIT_DISTANCE = 2

/** Below this length an edit distance of 2 is most of the word, so skip. */
const MIN_FUZZY_TERM_LENGTH = 4

/**
 * Find testimonials whose student name or program is within a small edit
 * distance of one of the terms.
 *
 * Deliberately restricted to those two fields. Running edit distance against
 * a whole quote is meaningless — a 200-character paragraph is 200 edits from
 * any search term — so fuzzy matching only applies where the content is
 * name-shaped.
 */
export async function fuzzyTestimonialSearch(terms: string[], limit = 50): Promise<string[]> {
  const usable = terms.filter((term) => term.length >= MIN_FUZZY_TERM_LENGTH)
  if (usable.length === 0) return []

  try {
    const rows = await prisma.$queryRawUnsafe<Array<{ id: string }>>(
      `SELECT id FROM testimonials
       WHERE deleted_at IS NULL
         AND EXISTS (
           SELECT 1 FROM unnest($1::text[]) AS term
           WHERE levenshtein(lower(coalesce(student_name,'')), term) <= $2
              OR levenshtein(lower(coalesce(program,'')), term) <= $2
              OR EXISTS (
                SELECT 1 FROM unnest(string_to_array(lower(coalesce(student_name,'') || ' ' || coalesce(program,'')), ' ')) AS word
                WHERE length(word) >= $3 AND levenshtein(word, term) <= $2
              )
         )
       LIMIT $4`,
      usable,
      MAX_EDIT_DISTANCE,
      MIN_FUZZY_TERM_LENGTH,
      limit,
    )
    return rows.map((row) => row.id)
  } catch {
    // fuzzystrmatch may not be installed in every environment. Typo tolerance
    // is an enhancement — losing it must not break search.
    return []
  }
}

/** Create the extensions fuzzy matching needs. Safe to call repeatedly. */
export async function ensureSearchExtensions(): Promise<void> {
  for (const extension of ['pg_trgm', 'fuzzystrmatch']) {
    try {
      await prisma.$executeRawUnsafe(`CREATE EXTENSION IF NOT EXISTS ${extension}`)
    } catch {
      // Requires superuser on a managed Postgres. The fuzzy pass degrades to
      // nothing, which the search already tolerates.
    }
  }
}

// ─── Fusion ──────────────────────────────────────────────────────────────────

/** Why a row is in the results — surfaced so the UI can explain each hit. */
export type MatchReason = 'exact' | 'stemmed' | 'semantic' | 'fuzzy'

export interface FusedHit {
  id: string
  score: number
  reasons: MatchReason[]
  /** Cosine similarity, when the semantic pass contributed. */
  similarity?: number
}

/** Standard RRF constant. Dampens the influence of any single ranker's top slot. */
const RRF_K = 60

/**
 * Weights, highest first: an exact term match is what someone asked for, and
 * must not be pushed below a merely plausible semantic neighbour.
 */
const WEIGHTS: Record<MatchReason, number> = {
  exact: 1,
  stemmed: 0.7,
  semantic: 0.5,
  fuzzy: 0.4,
}

export interface RankedList {
  reason: MatchReason
  ids: string[]
  /** Similarity per id, for the semantic list. */
  scores?: Map<string, number>
}

/**
 * Reciprocal Rank Fusion.
 *
 * Each pass contributes `weight / (K + rank)` for every row it returns, and the
 * contributions are summed. A row several passes agree on outranks one that
 * only a single pass found, which is exactly the behaviour wanted: a quote
 * containing the literal words AND being semantically close should beat one
 * that is only a distant paraphrase.
 *
 * Fusion rather than replacement is the whole point. Semantic search alone
 * reorders exact matches in ways that feel broken — someone who types a
 * filename expects that file first, not a thematically similar one.
 */
export function fuseRankings(lists: RankedList[]): FusedHit[] {
  const accumulated = new Map<string, FusedHit>()

  for (const list of lists) {
    list.ids.forEach((id, index) => {
      const contribution = WEIGHTS[list.reason] / (RRF_K + index + 1)

      const existing = accumulated.get(id)
      if (existing) {
        existing.score += contribution
        if (!existing.reasons.includes(list.reason)) existing.reasons.push(list.reason)
        const similarity = list.scores?.get(id)
        if (similarity !== undefined) existing.similarity = similarity
      } else {
        const similarity = list.scores?.get(id)
        accumulated.set(id, {
          id,
          score: contribution,
          reasons: [list.reason],
          ...(similarity !== undefined ? { similarity } : {}),
        })
      }
    })
  }

  return [...accumulated.values()].sort((a, b) => b.score - a.score)
}

// ─── Index coverage ──────────────────────────────────────────────────────────

export interface SemanticCoverage {
  testimonials: { total: number; embedded: number }
  assets: { total: number; embedded: number }
  model: string
}

/**
 * How much of each corpus is searchable by meaning.
 *
 * Reported to the UI for the same reason pHash coverage is: a row without an
 * embedding cannot match, so "no results" from a half-built index means
 * something entirely different from "no results" from a complete one.
 */
export async function getSemanticCoverage(): Promise<SemanticCoverage> {
  const [tTotal, tEmbedded, aTotal, aEmbedded] = await Promise.all([
    prisma.testimonial.count({ where: { deletedAt: null } }),
    prisma.testimonial.count({ where: { deletedAt: null, embeddingModel: EMBEDDING_MODEL } }),
    prisma.asset.count({ where: { deletedAt: null } }),
    prisma.asset.count({ where: { deletedAt: null, embeddingModel: EMBEDDING_MODEL } }),
  ])

  return {
    testimonials: { total: tTotal, embedded: tEmbedded },
    assets: { total: aTotal, embedded: aEmbedded },
    model: EMBEDDING_MODEL,
  }
}
