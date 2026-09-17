import { Prisma } from '@prisma/client'
import { prisma } from './client.js'

/**
 * Query parsing shared by asset and testimonial search.
 *
 * The original implementation passed the whole raw string to a single
 * `contains`, which meant the query had to appear verbatim. Measured against
 * real data, that failed every natural multi-word query:
 *
 *   "flexibility program"  0 hits — both words are in the quote, not adjacent
 *   "capella logo"         0 hits — the file is capella_logo_horizontal…svg
 *   "online degrees"       0 hits — the file is OnlineDegrees-DT.jpg
 *   "full time working"    0 hits — right words, wrong order
 *
 * Splitting into terms and requiring all of them fixes all four, and is still
 * an ordinary indexed `contains` per term rather than raw SQL.
 */

// The parser lives in @capella/types so the UI's <Highlight> splits the
// query identically — see the note there.
export { parseSearchTerms } from '@capella/types'

/**
 * Full-text match on testimonial prose, returning ids only.
 *
 * This is the part `contains` cannot do: `to_tsvector` stems, so "nurse" finds
 * "Nursing" and "flexible" finds "flexibility". Results are unioned with the
 * term match rather than replacing it, because stemming alone would lose infix
 * matches like searching "degre" mid-word.
 *
 * Computed per row rather than from a stored, indexed column. At the corpus
 * size this tool indexes that is comfortably inside the PRD's 2-second target;
 * if the testimonial table grows past roughly 100k rows, promote this to a
 * generated `tsvector` column with a GIN index.
 *
 * `websearch_to_tsquery` is deliberate — it accepts what people actually type
 * ("quoted phrases", OR, -negation) and, unlike `to_tsquery`, never throws on
 * malformed input.
 */
export async function testimonialFullTextIds(query: string, limit = 2_000): Promise<string[]> {
  if (!query.trim()) return []

  try {
    const rows = await prisma.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT id
      FROM testimonials
      WHERE deleted_at IS NULL
        AND to_tsvector('english',
              coalesce(quote_text, '') || ' ' ||
              coalesce(student_name, '') || ' ' ||
              coalesce(program, '')
            ) @@ websearch_to_tsquery('english', ${query})
      LIMIT ${limit}
    `)
    return rows.map((row) => row.id)
  } catch {
    // A malformed query must degrade to term matching, not 500 the search box.
    return []
  }
}

/** Build an AND-of-`contains` across several columns for one term. */
export function termMatchesAnyColumn<T extends string>(
  term: string,
  columns: readonly T[],
): Array<Record<T, { contains: string; mode: 'insensitive' }>> {
  return columns.map(
    (column) =>
      ({ [column]: { contains: term, mode: 'insensitive' } }) as Record<
        T,
        { contains: string; mode: 'insensitive' }
      >,
  )
}
