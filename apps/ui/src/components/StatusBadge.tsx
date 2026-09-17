import type { LiveStatus, SubmissionStatus, TestimonialSourceType } from '@capella/types'

const BASE = 'inline-flex items-center rounded-full px-2 py-1 text-xs font-medium'

export interface StatusBadgeProps {
  status: LiveStatus
}

/**
 * Page live status.
 *
 * `unknown` is a real, common answer in Phase 1 — the publish state is inferred
 * from scraped signals. The tooltip says so rather than letting a yellow badge
 * read as a warning.
 */
export function StatusBadge({ status }: StatusBadgeProps): JSX.Element {
  const styles: Record<LiveStatus, string> = {
    published: 'bg-verified-100 text-verified-800',
    draft: 'bg-ink-200 text-ink-700',
    unknown: 'bg-caution-100 text-caution-800',
  }

  const labels: Record<LiveStatus, string> = {
    published: 'Published',
    draft: 'Draft',
    unknown: 'Unknown',
  }

  const titles: Record<LiveStatus, string> = {
    published: 'Page appears to be live',
    draft: 'Page appears not to be live',
    unknown: 'Scraped, but the publish state could not be determined. Accurate status needs AEM API access.',
  }

  return (
    <span className={`${BASE} ${styles[status]}`} title={titles[status]}>
      {labels[status]}
    </span>
  )
}

export interface SourceTypeBadgeProps {
  sourceType: TestimonialSourceType
}

/** Hardcoded testimonials are harder to update in AEM — the badge flags that cost. */
export function SourceTypeBadge({ sourceType }: SourceTypeBadgeProps): JSX.Element {
  return sourceType === 'structured_component' ? (
    <span className={`${BASE} bg-brand-100 text-brand-800`} title="Reusable AEM component">
      Component
    </span>
  ) : (
    <span
      className={`${BASE} bg-structural-100 text-structural-800`}
      title="Hardcoded in page text — updating this means editing each page individually"
    >
      Hardcoded
    </span>
  )
}

export interface SubmissionStatusBadgeProps {
  status: SubmissionStatus
}

export function SubmissionStatusBadge({ status }: SubmissionStatusBadgeProps): JSX.Element {
  const styles: Record<SubmissionStatus, string> = {
    draft: 'bg-ink-200 text-ink-700',
    pending_review: 'bg-caution-100 text-caution-800',
    legal_approved: 'bg-brand-100 text-brand-800',
    marketing_approved: 'bg-brand-100 text-brand-800',
    approved: 'bg-verified-100 text-verified-800',
    rejected: 'bg-critical-100 text-critical-800',
    resubmitted: 'bg-ink-200 text-ink-700',
  }

  const labels: Record<SubmissionStatus, string> = {
    draft: 'Draft',
    pending_review: 'Pending',
    legal_approved: 'Legal approved',
    marketing_approved: 'Marketing approved',
    approved: 'Approved',
    rejected: 'Rejected',
    resubmitted: 'Resubmitted',
  }

  return <span className={`${BASE} ${styles[status]}`}>{labels[status]}</span>
}

export interface FreshnessBadgeProps {
  daysSinceLastSeen: number
}

/**
 * Testimonial freshness. Informational only — the tool never concludes a
 * testimonial is stale, it reports how long since it was last seen live.
 */
export function FreshnessBadge({ daysSinceLastSeen }: FreshnessBadgeProps): JSX.Element {
  const tone =
    daysSinceLastSeen > 180
      ? 'bg-critical-100 text-critical-800'
      : daysSinceLastSeen > 90
        ? 'bg-caution-100 text-caution-800'
        : 'bg-ink-100 text-ink-600'

  return (
    <span className={`${BASE} ${tone}`} title="Days since this testimonial was last seen on a page">
      Seen {daysSinceLastSeen}d ago
    </span>
  )
}

/** `needs_review` — a human must reconcile it. Never auto-resolved in the UI. */
export function NeedsReviewBadge(): JSX.Element {
  return (
    <span
      className={`${BASE} bg-caution-100 text-caution-900`}
      title="The student name or program conflicts between pages. A person needs to reconcile this."
    >
      <span aria-hidden="true" className="mr-1">
        ⚠
      </span>
      Needs review
    </span>
  )
}
