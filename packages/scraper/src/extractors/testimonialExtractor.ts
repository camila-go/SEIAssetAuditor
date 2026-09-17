import type { RawTestimonial, TestimonialSourceType } from '@capella/types'

/**
 * Testimonial parsing. Everything here is pure so it can be tested against HTML
 * fixtures without Playwright — `page.evaluate` only collects raw candidates.
 */

/**
 * Selectors in priority order. The first five are the PRD §8 list; the
 * substring matcher was added after checking the live site.
 *
 * Measured against capella.edu on 2026-09-16: the program pages wrap
 * testimonials in `.testimonialPromo` and `.testimonial-promo`, and NONE of
 * the five prescribed selectors match either one — `.testimonial` is an exact
 * class match and these are not it. Without the substring rule the scraper
 * finds zero testimonials on the actual target site.
 *
 * It is placed after the exact selectors so a real `.cmp-testimonial` is still
 * classified from the more specific rule first.
 */
export const TESTIMONIAL_SELECTORS: ReadonlyArray<{
  selector: string
  sourceType: TestimonialSourceType
}> = [
  { selector: '[data-component="testimonial"]', sourceType: 'structured_component' },
  { selector: '.cmp-testimonial', sourceType: 'structured_component' },
  { selector: '.testimonial', sourceType: 'structured_component' },
  { selector: '.student-quote', sourceType: 'structured_component' },
  // Catches .testimonialPromo, .testimonial-promo, and any future variant.
  { selector: '[class*="testimonial" i]', sourceType: 'structured_component' },
  { selector: 'blockquote', sourceType: 'hardcoded_text' },
  { selector: '[class*="quote"]', sourceType: 'hardcoded_text' },
]

/** A candidate as collected from the DOM, before parsing. */
export interface TestimonialCandidate {
  /** Full visible text of the matched element, whitespace already collapsed. */
  text: string
  outerHtml: string
  sourceType: TestimonialSourceType
  /** Text of a nearby `.name` / `[class*="name"]` element, if one exists. */
  nameHint: string | null
  /** Text of a nearby `.program` / `[class*="program"]` element, if one exists. */
  programHint: string | null
  /** Document order of the match on the page. */
  positionOnPage: number
}

/** Shortest string we'll accept as a quote — filters out stray blockquote chrome. */
const MIN_QUOTE_LENGTH = 25
const MAX_QUOTE_LENGTH = 2_000

/**
 * Normalized fingerprint used as the dedup key.
 *
 * Lowercase, strip punctuation, collapse whitespace. Two pages that render the
 * same quote with different smart quotes or trailing periods must produce the
 * same fingerprint, or we'd create duplicate Testimonial rows.
 */
export function fingerprint(quoteText: string): string {
  return quoteText
    .toLowerCase()
    .normalize('NFKD')
    // Strip combining marks left by NFKD so "José" and "Jose" agree.
    .replace(/[̀-ͯ]/g, '')
    // Unicode punctuation and symbols -> space. Keeps letters, digits, whitespace.
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Attribution patterns: "— Jane Doe", "- Jane Doe", "– Jane Doe". */
const ATTRIBUTION_PATTERN = /[—–-]\s*([A-Z][\p{L}'’.-]+(?:\s+[A-Z][\p{L}'’.-]+){0,3})\s*$/u

/**
 * A curly- or straight-quoted quote followed by a bare name, with no dash:
 *   “…never too late to pursue your education” Stephanie Dewald
 *
 * This is how Capella's `.testimonialPromo` component renders, verified on the
 * live site. The dash pattern above never fires on it, so without this rule the
 * name and the quote stay fused into one string and every fingerprint carries
 * the attribution with it.
 */
/**
 * A quotation-marked span, plus everything that follows it.
 *
 * Verified against capella.edu: the `.testimonialPromo` component renders the
 * quote, the student's name, their degree, AND the legal disclaimer as siblings
 * inside one element, so `textContent` is:
 *
 *   “…never too late to pursue your education” Stephanie Dewald* BS Business,
 *   FlexPath *Actual Capella graduate who agreed to appear in promotional
 *   materials for Capella.
 *
 * There is no element anywhere in the DOM holding just the quote. The quotation
 * marks are the only reliable boundary, so the quote is taken as what sits
 * between them and everything after is treated as the attribution block.
 */
const QUOTED_BLOCK = /[“"„«]\s*(?<quote>[\s\S]+?)\s*[”"»]\s*(?<trailing>[\s\S]*)$/u

/**
 * The leading Title Case words of an attribution block, stopping at a footnote
 * marker — "Stephanie Dewald* BS Business, FlexPath *Actual…" yields
 * "Stephanie Dewald" and leaves the degree and disclaimer behind.
 */
const LEADING_NAME = /^(?<name>\p{Lu}[\p{L}'’.-]+(?:\s+\p{Lu}[\p{L}'’.-]+){0,3})/u

/**
 * Footnote markers that Capella appends to attributions, e.g.
 * "Stephanie Dewald*" where the asterisk points at a disclaimer elsewhere on
 * the page. Part of the layout, not part of the person's name — and left in
 * place it would also break the attribution match above.
 */
const FOOTNOTE_MARKERS = /[*†‡§¹²³]+\s*$/u

/** Strip footnote markers and stray punctuation from an extracted name. */
export function cleanName(value: string): string {
  return value.trim().replace(FOOTNOTE_MARKERS, '').replace(/[,;:]+$/, '').trim()
}

/** Remove wrapping quotation marks so the stored quote reads cleanly. */
export function stripWrappingQuotes(value: string): string {
  return value
    .trim()
    .replace(/^[“"„«]\s*/u, '')
    .replace(/\s*[”"»]$/u, '')
    .trim()
}

/**
 * The optional " in <Field>" suffix on a degree name.
 *
 * Deliberately restricted to Title Case words: a permissive `[\p{L}\s]+` runs
 * straight past the field into the rest of the sentence, so
 * "my Master of Science in Nursing last year" captured "…Nursing last year".
 * Capella writes programs in title case, so requiring an initial capital is
 * what actually ends the match in the right place. Lowercase connectors
 * ("of", "and", "in") are allowed only between two capitalised words.
 */
const FIELD_SUFFIX = String.raw`(?:\s+in\s+\p{Lu}[\p{L}-]*(?:\s+(?:of|and|in|&)\s+\p{Lu}[\p{L}-]*|\s+\p{Lu}[\p{L}-]*){0,3})?`

/**
 * Known Capella degree strings. Order matters — longer, more specific phrases
 * are matched first so "Master of Science in Nursing" doesn't resolve to "Nursing".
 *
 * These are case-sensitive on the field name by design (see FIELD_SUFFIX), so
 * the degree stems are spelled out in both cases rather than using the `i` flag.
 */
export const KNOWN_PROGRAM_PATTERNS: ReadonlyArray<RegExp> = [
  new RegExp(String.raw`\b(?:Doctor of Philosophy|PhD)${FIELD_SUFFIX}`, 'u'),
  /\b(?:Doctor of Business Administration|DBA)\b/u,
  /\b(?:Doctor of Nursing Practice|DNP)\b/u,
  /\b(?:Doctor of Psychology|PsyD)\b/u,
  new RegExp(
    String.raw`\b(?:Master of (?:Science|Arts|Business Administration|Education|Social Work|Public Health))${FIELD_SUFFIX}`,
    'u',
  ),
  new RegExp(String.raw`\b(?:Bachelor of (?:Science|Arts))${FIELD_SUFFIX}`, 'u'),
  /\b(?:MBA|MSN|BSN|MSW|MPH|BSIT|MSIT)\b/u,
  new RegExp(String.raw`\b(?:Associate of (?:Science|Arts))${FIELD_SUFFIX}`, 'u'),
]

const DEGREE_LEVELS: ReadonlyArray<{ level: string; pattern: RegExp }> = [
  { level: 'doctoral', pattern: /\b(?:doctor|doctoral|phd|dba|dnp|psyd|ed\.?d)\b/iu },
  { level: 'masters', pattern: /\b(?:master|masters|mba|msn|msw|mph|m\.?s\.?|m\.?a\.?)\b/iu },
  { level: 'bachelors', pattern: /\b(?:bachelor|bachelors|bsn|bsit|b\.?s\.?|b\.?a\.?)\b/iu },
  { level: 'associate', pattern: /\b(?:associate|a\.?s\.?|a\.?a\.?)\b/iu },
  { level: 'certificate', pattern: /\bcertificate\b/iu },
]

/** Pull "— Name" attribution off the end of a quote. */
export function extractStudentName(text: string, nameHint: string | null): string | null {
  // An explicit .name element beats pattern matching on the quote text.
  if (nameHint) {
    const cleaned = nameHint.replace(/^[—–\-\s]+/u, '').trim()
    if (cleaned.length > 1 && cleaned.length <= 100) return cleaned
  }

  const match = ATTRIBUTION_PATTERN.exec(text.trim())
  return match?.[1]?.trim() ?? null
}

export function extractProgram(text: string, programHint: string | null): string | null {
  if (programHint) {
    const cleaned = programHint.trim()
    if (cleaned.length > 1 && cleaned.length <= 120) return cleaned
  }

  for (const pattern of KNOWN_PROGRAM_PATTERNS) {
    const match = pattern.exec(text)
    if (match?.[0]) return match[0].trim().replace(/\s+/g, ' ')
  }

  return null
}

export function extractDegreeLevel(program: string | null, text: string): string | null {
  const haystack = program ?? text
  for (const { level, pattern } of DEGREE_LEVELS) {
    if (pattern.test(haystack)) return level
  }
  return null
}

/**
 * Strip the attribution suffix so the quote itself is what gets fingerprinted.
 * Without this, the same quote credited as "— Jane D." on one page and
 * "— Jane Doe" on another would produce two Testimonial rows.
 *
 * The strip is unconditional. An earlier version fell back to the original
 * text when the result looked too short, which put the name straight back into
 * the fingerprint — reintroducing the exact duplicate this function exists to
 * prevent. If what remains is too short to be a quote, the candidate was mostly
 * attribution and `parseCandidate` rejects it outright.
 */
export function stripAttribution(text: string, studentName: string | null): string {
  if (!studentName) return text.trim()

  return text
    .trim()
    .replace(new RegExp(`[—–-]\\s*${escapeRegExp(studentName)}\\s*$`, 'u'), '')
    .trim()
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Reject obvious non-testimonials before they reach the database. */
export function isPlausibleQuote(text: string): boolean {
  const trimmed = text.trim()
  if (trimmed.length < MIN_QUOTE_LENGTH || trimmed.length > MAX_QUOTE_LENGTH) return false
  // Needs at least a few words — "Read more" inside a blockquote is not a testimonial.
  if (trimmed.split(/\s+/).length < 5) return false
  return true
}

/**
 * Parse one DOM candidate into a RawTestimonial, or null if it doesn't look
 * like a testimonial.
 */
export function parseCandidate(candidate: TestimonialCandidate): RawTestimonial | null {
  const collapsed = candidate.text.replace(/\s+/g, ' ').trim()
  if (!isPlausibleQuote(collapsed)) return null

  const program = extractProgram(collapsed, candidate.programHint)

  // `"quote" Name` first — it identifies both halves in one match, so the
  // generic dash rule never has to guess where the quote ends.
  const quoted = QUOTED_BLOCK.exec(collapsed)
  const quotedText = quoted?.groups?.['quote']
  const trailing = quoted?.groups?.['trailing']?.trim()

  // Prefer a dedicated name element; otherwise read the head of the attribution
  // block; otherwise fall back to the "— Name" suffix pattern.
  const rawName =
    candidate.nameHint ??
    (trailing ? LEADING_NAME.exec(trailing)?.groups?.['name'] : undefined) ??
    extractStudentName(collapsed, candidate.nameHint)

  const studentName = rawName ? cleanName(rawName) || null : null

  const quoteText = stripWrappingQuotes(
    quotedText ?? stripAttribution(collapsed, studentName),
  )

  if (!isPlausibleQuote(quoteText)) return null

  return {
    quoteText,
    studentName,
    program,
    rawHtml: candidate.outerHtml,
    sourceType: candidate.sourceType,
    positionOnPage: candidate.positionOnPage,
  }
}

/**
 * Parse a page's candidates into deduplicated testimonials.
 *
 * The selector list overlaps by design (a `.cmp-testimonial` may contain a
 * `blockquote`), so the same quote can be collected more than once per page.
 * First match wins, which is the higher-priority selector — that keeps
 * `structured_component` from being downgraded to `hardcoded_text`.
 */
export function parseCandidates(candidates: TestimonialCandidate[]): RawTestimonial[] {
  const byFingerprint = new Map<string, RawTestimonial>()

  for (const candidate of candidates) {
    const parsed = parseCandidate(candidate)
    if (!parsed) continue

    const key = fingerprint(parsed.quoteText)
    if (!key) continue

    const existing = byFingerprint.get(key)
    if (!existing) {
      byFingerprint.set(key, parsed)
      continue
    }

    // Same quote seen twice on the page — keep the richer record.
    byFingerprint.set(key, {
      ...existing,
      studentName: existing.studentName ?? parsed.studentName,
      program: existing.program ?? parsed.program,
    })
  }

  return collapseNested([...byFingerprint.entries()])
}

/**
 * Drop candidates whose text merely wraps another candidate's.
 *
 * AEM nests these components — on capella.edu the same quote appears in both
 * `.testimonialPromo` and its `.testimonial-promo` container, and the
 * container's `textContent` also sweeps up the attribution, the degree line
 * and the legal disclaimer ("*Actual Capella graduate who agreed to appear in
 * promotional materials"). Fingerprint equality does not catch this, because
 * the two strings genuinely differ.
 *
 * Whenever one fingerprint contains another, the shorter one is the actual
 * quote. The wrapper is discarded, but any attribution only it carried (the
 * degree line usually sits outside the quote element) is merged onto the
 * survivor first.
 */
function collapseNested(entries: Array<[string, RawTestimonial]>): RawTestimonial[] {
  // Shortest first, so a wrapper is always compared against a quote we already kept.
  const ordered = [...entries].sort((a, b) => a[0].length - b[0].length)

  const kept: Array<[string, RawTestimonial]> = []

  for (const [key, testimonial] of ordered) {
    const inner = kept.find(([keptKey]) => key.includes(keptKey))

    if (inner) {
      // This is a wrapper. Salvage attribution the inner element lacked.
      inner[1] = {
        ...inner[1],
        studentName: inner[1].studentName ?? testimonial.studentName,
        program: inner[1].program ?? testimonial.program,
      }
      continue
    }

    kept.push([key, testimonial])
  }

  // Restore document order so `positionOnPage` still reads sensibly.
  return kept
    .map(([, testimonial]) => testimonial)
    .sort((a, b) => a.positionOnPage - b.positionOnPage)
}
