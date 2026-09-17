import type { ReactNode } from 'react';
/**
 * Loading, empty and error states. Every data-fetching view uses all three —
 * never a bare spinner, never `null` while loading.
 */
export interface SkeletonProps {
    rows?: number;
    className?: string;
}
export declare function Skeleton({ rows, className }: SkeletonProps): JSX.Element;
export declare function CardSkeleton(): JSX.Element;
export interface EmptyStateProps {
    title: string;
    /** Tell the user what to do next — an empty state without an action is a dead end. */
    message: string;
    action?: ReactNode;
}
export declare function EmptyState({ title, message, action }: EmptyStateProps): JSX.Element;
export interface ErrorStateProps {
    error: unknown;
    onRetry?: () => void;
}
/**
 * Error state.
 *
 * A 501 means a Phase 2/3 feature isn't configured yet — that's a product
 * state, not a fault, so it renders as an informational notice with no retry
 * button (retrying cannot help).
 */
export declare function ErrorState({ error, onRetry }: ErrorStateProps): JSX.Element;
export interface PhaseNoticeProps {
    children: ReactNode;
}
/** Inline caveat explaining a Phase 1 limitation, so results aren't over-trusted. */
export declare function PhaseNotice({ children }: PhaseNoticeProps): JSX.Element;
//# sourceMappingURL=States.d.ts.map