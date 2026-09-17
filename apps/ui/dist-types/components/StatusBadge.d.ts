import type { LiveStatus, SubmissionStatus, TestimonialSourceType } from '@capella/types';
export interface StatusBadgeProps {
    status: LiveStatus;
}
/**
 * Page live status.
 *
 * `unknown` is a real, common answer in Phase 1 — the publish state is inferred
 * from scraped signals. The tooltip says so rather than letting a yellow badge
 * read as a warning.
 */
export declare function StatusBadge({ status }: StatusBadgeProps): JSX.Element;
export interface SourceTypeBadgeProps {
    sourceType: TestimonialSourceType;
}
/** Hardcoded testimonials are harder to update in AEM — the badge flags that cost. */
export declare function SourceTypeBadge({ sourceType }: SourceTypeBadgeProps): JSX.Element;
export interface SubmissionStatusBadgeProps {
    status: SubmissionStatus;
}
export declare function SubmissionStatusBadge({ status }: SubmissionStatusBadgeProps): JSX.Element;
export interface FreshnessBadgeProps {
    daysSinceLastSeen: number;
}
/**
 * Testimonial freshness. Informational only — the tool never concludes a
 * testimonial is stale, it reports how long since it was last seen live.
 */
export declare function FreshnessBadge({ daysSinceLastSeen }: FreshnessBadgeProps): JSX.Element;
/** `needs_review` — a human must reconcile it. Never auto-resolved in the UI. */
export declare function NeedsReviewBadge(): JSX.Element;
//# sourceMappingURL=StatusBadge.d.ts.map