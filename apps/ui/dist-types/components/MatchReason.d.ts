export type MatchReason = 'exact' | 'stemmed' | 'semantic' | 'fuzzy';
export interface MatchReasonBadgeProps {
    reasons: MatchReason[];
    /** Cosine similarity, when the semantic pass contributed. */
    similarity?: number;
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
export declare function MatchReasonBadge({ reasons, similarity }: MatchReasonBadgeProps): JSX.Element | null;
export interface SemanticNoticeProps {
    /** True when at least one result came only from the semantic pass. */
    hasSemanticOnly: boolean;
}
/**
 * A one-line explanation above results that contain non-literal matches.
 *
 * Shown only when it is actually needed — a list of exact matches needs no
 * explaining, and an always-present notice is ignored within a day.
 */
export declare function SemanticNotice({ hasSemanticOnly }: SemanticNoticeProps): JSX.Element | null;
//# sourceMappingURL=MatchReason.d.ts.map