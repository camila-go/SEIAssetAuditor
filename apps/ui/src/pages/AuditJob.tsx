import { useState } from 'react'
import { useParams } from 'react-router-dom'
import { PageHeader } from '../components/Layout'
import { StatusBadge } from '../components/StatusBadge'
import { EmptyState, ErrorState, Skeleton } from '../components/States'
import { apiUrl } from '../api/client'
import {
  useAuditFailures,
  useAuditResults,
  useAuditStatus,
  useCancelAudit,
} from '../api/queries'

/**
 * `/audit/:jobId` — live progress and streaming results.
 *
 * The job runs server-side, so this view is purely an observer: it can be
 * closed and reopened at any point without affecting the audit.
 */
export default function AuditJob(): JSX.Element {
  const { jobId = '' } = useParams<{ jobId: string }>()

  const [page, setPage] = useState(1)
  const [urlStatus, setUrlStatus] = useState<string>('')
  const [liveStatus, setLiveStatus] = useState<string>('')
  const [showFailures, setShowFailures] = useState(false)

  const status = useAuditStatus(jobId)
  const isLive = status.data?.status === 'running' || status.data?.status === 'queued'

  const results = useAuditResults(
    jobId,
    { page, limit: 50, ...(urlStatus ? { urlStatus } : {}), ...(liveStatus ? { liveStatus } : {}) },
    isLive,
  )
  const failures = useAuditFailures(jobId, showFailures)
  const cancelAudit = useCancelAudit(jobId)

  if (status.isLoading) return <Skeleton rows={6} />
  if (status.isError) return <ErrorState error={status.error} onRetry={() => void status.refetch()} />
  if (!status.data) return <ErrorState error={new Error('Job not found')} />

  const job = status.data
  const totalPages = results.data?.meta ? Math.ceil(results.data.meta.total / results.data.meta.limit) : 1

  return (
    <div>
      <PageHeader title={`Audit ${jobId.slice(0, 8)}`} description={describeStatus(job.status)}>
        {job.status === 'complete' ? (
          <a
            href={apiUrl(`/audit/${jobId}/export`)}
            className="rounded-md bg-brand-600 px-3 py-2 text-sm font-medium text-white hover:bg-brand-700"
          >
            Download CSV
          </a>
        ) : null}
        {isLive ? (
          <button
            type="button"
            onClick={() => cancelAudit.mutate()}
            disabled={cancelAudit.isPending}
            className="rounded-md bg-white px-3 py-2 text-sm font-medium text-ink-700 ring-1 ring-ink-300 hover:bg-ink-50"
          >
            Cancel
          </button>
        ) : null}
      </PageHeader>

      {/* ── Progress ─────────────────────────────────────────────────────── */}
      <section className="rounded-lg border border-ink-200 bg-white p-4">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <p className="text-sm font-medium text-ink-900">
            {job.completedUrls + job.failedUrls} of {job.totalUrls} URLs processed
          </p>
          <p className="text-sm text-ink-600">
            {job.estimatedMinutesRemaining !== null && isLive
              ? `~${job.estimatedMinutesRemaining} min remaining`
              : job.status === 'complete'
                ? 'Complete'
                : null}
          </p>
        </div>

        <div
          className="mt-2 h-2 w-full overflow-hidden rounded-full bg-ink-200"
          role="progressbar"
          aria-valuenow={job.percentComplete}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label="Audit progress"
        >
          <div
            className={`h-full transition-[width] duration-500 ${
              job.status === 'failed' ? 'bg-critical-500' : 'bg-brand-600'
            }`}
            style={{ width: `${job.percentComplete}%` }}
          />
        </div>

        <dl className="mt-3 flex flex-wrap gap-x-6 gap-y-1 text-xs text-ink-600">
          <div>
            <dt className="inline font-medium">Succeeded: </dt>
            <dd className="inline">{job.completedUrls}</dd>
          </div>
          <div>
            <dt className="inline font-medium">Failed: </dt>
            <dd className="inline">{job.failedUrls}</dd>
          </div>
        </dl>

        {isLive ? (
          <p className="mt-3 text-xs text-ink-500">
            This runs on the server. You can close the tab and come back to this URL — progress is
            not lost.
          </p>
        ) : null}

        {job.errorMessage ? (
          <p className="mt-3 rounded-md bg-critical-50 px-3 py-2 text-sm text-critical-800">
            {job.errorMessage}
          </p>
        ) : null}
      </section>

      {/* ── Results ──────────────────────────────────────────────────────── */}
      <section className="mt-6">
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <select
            value={urlStatus}
            onChange={(event) => {
              setUrlStatus(event.target.value)
              setPage(1)
            }}
            aria-label="Filter by processing status"
            className="select-field w-auto"
          >
            <option value="">All URLs</option>
            <option value="done">Processed</option>
            <option value="failed">Failed</option>
            <option value="pending">Not yet processed</option>
          </select>

          <select
            value={liveStatus}
            onChange={(event) => {
              setLiveStatus(event.target.value)
              setPage(1)
            }}
            aria-label="Filter by live status"
            className="select-field w-auto"
          >
            <option value="">Any live status</option>
            <option value="published">Published</option>
            <option value="draft">Draft</option>
            <option value="unknown">Unknown</option>
          </select>
        </div>

        {results.isLoading ? (
          <Skeleton rows={8} />
        ) : results.isError ? (
          <ErrorState error={results.error} onRetry={() => void results.refetch()} />
        ) : !results.data || results.data.rows.length === 0 ? (
          <EmptyState
            title={isLive ? 'No results yet' : 'No results match these filters'}
            message={
              isLive
                ? 'The first batch is still being scraped. Results appear here as they land — no need to refresh.'
                : 'Try clearing the filters above.'
            }
          />
        ) : (
          <div className="overflow-x-auto rounded-lg border border-ink-200 bg-white">
            <table className="min-w-full divide-y divide-ink-200 text-sm" data-testid="audit-results-table">
              <thead className="bg-ink-50 text-left text-label uppercase text-ink-500">
                <tr>
                  <th scope="col" className="px-4 py-2 font-medium">URL</th>
                  <th scope="col" className="px-4 py-2 font-medium">Status</th>
                  <th scope="col" className="px-4 py-2 text-right font-medium">Assets</th>
                  <th scope="col" className="px-4 py-2 text-right font-medium">Testimonials</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-ink-100">
                {results.data.rows.map((row) => (
                  <tr key={row.url} className="hover:bg-ink-50">
                    <td className="max-w-md px-4 py-2">
                      <a
                        href={row.url}
                        target="_blank"
                        rel="noreferrer"
                        className="block truncate text-brand-700 hover:underline"
                        title={row.url}
                      >
                        {row.pageTitle ?? row.url}
                      </a>
                      {row.pageTitle ? (
                        <span className="block truncate text-xs text-ink-500">{row.url}</span>
                      ) : null}
                    </td>
                    <td className="px-4 py-2">
                      {row.urlStatus === 'failed' ? (
                        <span className="text-xs text-critical-700" title={row.error ?? undefined}>
                          Failed
                        </span>
                      ) : row.urlStatus === 'pending' ? (
                        <span className="text-xs text-ink-500">Queued</span>
                      ) : (
                        <StatusBadge status={row.liveStatus} />
                      )}
                    </td>
                    <td className="px-4 py-2 text-right tabular-nums">{row.assetCount}</td>
                    <td className="px-4 py-2 text-right tabular-nums">{row.testimonialCount}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {totalPages > 1 ? (
          <div className="mt-3 flex items-center justify-between text-sm">
            <button
              type="button"
              onClick={() => setPage((current) => Math.max(1, current - 1))}
              disabled={page === 1}
              className="rounded-md px-3 py-1 ring-1 ring-ink-300 disabled:opacity-40"
            >
              Previous
            </button>
            <span className="text-ink-600">
              Page {page} of {totalPages}
            </span>
            <button
              type="button"
              onClick={() => setPage((current) => Math.min(totalPages, current + 1))}
              disabled={page >= totalPages}
              className="rounded-md px-3 py-1 ring-1 ring-ink-300 disabled:opacity-40"
            >
              Next
            </button>
          </div>
        ) : null}
      </section>

      {/* ── Failures ─────────────────────────────────────────────────────── */}
      {job.failedUrls > 0 ? (
        <section className="mt-6">
          <button
            type="button"
            onClick={() => setShowFailures((open) => !open)}
            aria-expanded={showFailures}
            className="text-sm font-medium text-ink-700 hover:text-ink-900"
          >
            {showFailures ? '▾' : '▸'} {job.failedUrls} failed URL
            {job.failedUrls === 1 ? '' : 's'}
          </button>

          {showFailures ? (
            failures.isLoading ? (
              <Skeleton rows={3} className="mt-3" />
            ) : (
              <ul className="mt-3 space-y-2">
                {(failures.data ?? []).map((failure) => (
                  <li
                    key={failure.url}
                    className="rounded-md border border-critical-200 bg-critical-50 px-3 py-2 text-sm"
                  >
                    <p className="break-all font-medium text-critical-900">{failure.url}</p>
                    <p className="mt-1 text-xs text-critical-700">{failure.error}</p>
                  </li>
                ))}
              </ul>
            )
          ) : null}
        </section>
      ) : null}
    </div>
  )
}

function describeStatus(status: string): string {
  switch (status) {
    case 'queued':
      return 'Queued — waiting for a worker to pick it up.'
    case 'running':
      return 'Running. Results stream in as each batch completes.'
    case 'complete':
      return 'Complete.'
    case 'failed':
      return 'The job failed. Any results collected before the failure are still below.'
    case 'cancelled':
      return 'Cancelled. Results collected before cancelling are still below.'
    default:
      return ''
  }
}
