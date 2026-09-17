import type { ReactNode } from 'react'
import { ApiError } from '../api/client'

/**
 * Loading, empty and error states. Every data-fetching view uses all three —
 * never a bare spinner, never `null` while loading.
 */

export interface SkeletonProps {
  rows?: number
  className?: string
}

export function Skeleton({ rows = 5, className = '' }: SkeletonProps): JSX.Element {
  return (
    <div className={`space-y-3 ${className}`} role="status" aria-label="Loading">
      {Array.from({ length: rows }, (_, index) => (
        <div key={index} className="h-12 animate-pulse rounded-md bg-ink-200" />
      ))}
      <span className="sr-only">Loading…</span>
    </div>
  )
}

export function CardSkeleton(): JSX.Element {
  return (
    <div className="animate-pulse rounded-lg border border-ink-200 bg-white p-4" role="status">
      <div className="mb-3 h-4 w-1/3 rounded bg-ink-200" />
      <div className="mb-2 h-3 w-full rounded bg-ink-200" />
      <div className="h-3 w-2/3 rounded bg-ink-200" />
      <span className="sr-only">Loading…</span>
    </div>
  )
}

export interface EmptyStateProps {
  title: string
  /** Tell the user what to do next — an empty state without an action is a dead end. */
  message: string
  action?: ReactNode
}

export function EmptyState({ title, message, action }: EmptyStateProps): JSX.Element {
  return (
    <div className="rounded-lg border border-dashed border-ink-300 bg-white px-6 py-12 text-center">
      <h3 className="text-md font-semibold text-ink-900">{title}</h3>
      <p className="mx-auto mt-2 max-w-md text-sm text-ink-600">{message}</p>
      {action ? <div className="mt-4">{action}</div> : null}
    </div>
  )
}

export interface ErrorStateProps {
  error: unknown
  onRetry?: () => void
}

/**
 * Error state.
 *
 * A 501 means a Phase 2/3 feature isn't configured yet — that's a product
 * state, not a fault, so it renders as an informational notice with no retry
 * button (retrying cannot help).
 */
export function ErrorState({ error, onRetry }: ErrorStateProps): JSX.Element {
  const notConfigured = error instanceof ApiError && error.isNotConfigured

  const message =
    error instanceof ApiError
      ? error.message
      : error instanceof Error
        ? error.message
        : 'Something went wrong.'

  if (notConfigured) {
    return (
      <div className="rounded-lg border border-brand-200 bg-brand-50 px-6 py-8 text-center">
        <h3 className="text-md font-semibold text-brand-900">Not available yet</h3>
        <p className="mx-auto mt-2 max-w-lg text-sm text-brand-800">{message}</p>
      </div>
    )
  }

  return (
    <div className="rounded-lg border border-critical-200 bg-critical-50 px-6 py-8 text-center">
      <h3 className="text-md font-semibold text-critical-900">Something went wrong</h3>
      <p className="mx-auto mt-2 max-w-lg text-sm text-critical-800">{message}</p>
      {onRetry ? (
        <button
          type="button"
          onClick={onRetry}
          className="mt-4 rounded-md bg-critical-600 px-3 py-2 text-sm font-medium text-white hover:bg-critical-700"
        >
          Try again
        </button>
      ) : null}
    </div>
  )
}

export interface PhaseNoticeProps {
  children: ReactNode
}

/** Inline caveat explaining a Phase 1 limitation, so results aren't over-trusted. */
export function PhaseNotice({ children }: PhaseNoticeProps): JSX.Element {
  return (
    <div className="rounded-md border border-caution-200 bg-caution-50 px-4 py-3 text-sm text-caution-900">
      {children}
    </div>
  )
}
