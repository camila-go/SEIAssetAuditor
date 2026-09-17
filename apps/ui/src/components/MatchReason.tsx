export type MatchReason = 'exact' | 'stemmed' | 'semantic' | 'fuzzy'

export interface MatchReasonBadgeProps {
  reasons: MatchReason[]
  /** Cosine similarity, when the semantic pass contributed. */
  similarity?: number
}

/**
 * Explain why a result is in the list.
 *
 * Search now returns rows that share no words with the query at all — a
 * paraphrase, or a typo'd name. Without this, "balancing work and study"
 * returns a quote about flexibility and nothing on screen accounts for it, so
 * the result reads as a bug. Naming the reason is what makes non-literal
 * matching trustworthy rather than mysterious.
 *
 * Only the strongest reason is shown. A row that matched four ways does not
 * need four badges — that is noise, and the ranking already reflects it.
 */
export function MatchReasonBadge({ reasons, similarity }: MatchReasonBadgeProps): JSX.Element | null {
  if (reasons.length === 0) return null

  // Strongest first: an exact match is the most useful thing to tell someone.
  const primary =
    (['exact', 'stemmed', 'fuzzy', 'semantic'] as const).find((reason) =>
      reasons.includes(reason),
    ) ?? reasons[0]

  const detail: Record<MatchReason, { label: string; title: string; className: string }> = {
    exact: {
      label: 'Exact',
      title: 'Every word you typed appears in this result',
      className: 'bg-verified-100 text-verified-800',
    },
    stemmed: {
      label: 'Word form',
      title: 'Matches a different form of your word — "nurse" finds "nursing"',
      className: 'bg-verified-100 text-verified-800',
    },
    fuzzy: {
      label: 'Close spelling',
      title: 'The name or program is a character or two away from what you typed',
      className: 'bg-caution-100 text-caution-800',
    },
    semantic: {
      label:
        similarity !== undefined
          ? `Similar meaning · ${Math.round(similarity * 100)}%`
          : 'Similar meaning',
      title:
        'Found by meaning rather than wording — this result may share no words with your search',
      className: 'bg-brand-100 text-brand-800',
    },
  }

  const { label, title, className } = detail[primary as MatchReason]

  return (
    <span
      title={title}
      className={`inline-flex items-center rounded-full px-2 py-1 text-label font-medium ${className}`}
    >
      {label}
    </span>
  )
}

export interface SemanticNoticeProps {
  /** True when at least one result came only from the semantic pass. */
  hasSemanticOnly: boolean
}

/**
 * A one-line explanation above results that contain non-literal matches.
 *
 * Shown only when it is actually needed — a list of exact matches needs no
 * explaining, and an always-present notice is ignored within a day.
 */
export function SemanticNotice({ hasSemanticOnly }: SemanticNoticeProps): JSX.Element | null {
  if (!hasSemanticOnly) return null

  return (
    <p className="mb-3 text-xs text-ink-500">
      Some results were found by meaning rather than exact wording. Put a phrase in
      &ldquo;quotes&rdquo; to require those words.
    </p>
  )
}
