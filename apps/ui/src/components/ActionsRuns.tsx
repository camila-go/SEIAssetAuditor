import { useQuery } from '@tanstack/react-query'
import { describeRun, fetchRuns, workflowUrl, type WorkflowRun } from '../api/actions'

/**
 * Recent audit runs, read live from GitHub.
 *
 * Needs no token and no backend: the repository is public, so GitHub serves
 * this unauthenticated. That matters more than it sounds — it means the
 * published snapshot, which has no API at all, can still show whether an audit
 * is running right now and whether the last one worked. Before this the only
 * answer the static site could give was "running an audit needs the backend",
 * which was true and useless.
 */

/** GitHub allows 60 unauthenticated requests an hour per IP. Stay well inside. */
const IDLE_POLL_MS = 60_000
const ACTIVE_POLL_MS = 15_000

export function ActionsRuns(): JSX.Element | null {
  const runs = useQuery({
    queryKey: ['workflow-runs'],
    queryFn: () => fetchRuns(8),
    // Poll quickly only while something is actually in flight, so an idle tab
    // does not burn the hourly allowance and get itself rate limited.
    refetchInterval: (query) => {
      const data = query.state.data as WorkflowRun[] | undefined
      const busy = data?.some((run) => run.status !== 'completed')
      return busy ? ACTIVE_POLL_MS : IDLE_POLL_MS
    },
    retry: false,
  })

  if (runs.isLoading) {
    return <p className="text-xs text-ink-500">Checking for recent runs…</p>
  }

  if (runs.isError) {
    return (
      <p className="text-xs text-ink-500">
        {(runs.error as Error).message}{' '}
        <a href={workflowUrl} target="_blank" rel="noreferrer" className="underline">
          See the runs on GitHub
        </a>
        .
      </p>
    )
  }

  const data = runs.data ?? []

  if (data.length === 0) {
    return (
      <p className="text-xs text-ink-500">
        No audits have been run yet.{' '}
        <a href={workflowUrl} target="_blank" rel="noreferrer" className="underline">
          Open the workflow on GitHub
        </a>
        .
      </p>
    )
  }

  return (
    <div>
      <ul className="divide-y divide-ink-100 rounded-md border border-ink-200 bg-white">
        {data.map((run) => {
          const { label, tone } = describeRun(run)

          return (
            <li key={run.id} className="flex items-center justify-between gap-3 px-4 py-3">
              <div className="min-w-0">
                <a
                  href={run.url}
                  target="_blank"
                  rel="noreferrer"
                  className="block truncate text-sm font-medium text-ink-900 hover:underline"
                >
                  {run.title}
                </a>
                <p className="mt-0.5 text-xs text-ink-500">
                  {run.event === 'schedule' ? 'Scheduled' : `Started by ${run.actor}`} ·{' '}
                  {relativeTime(run.startedAt)}
                </p>
              </div>

              <span
                className={[
                  'shrink-0 rounded-full px-2.5 py-1 text-xs font-medium',
                  tone === 'ok'
                    ? 'bg-verified-50 text-verified-800'
                    : tone === 'bad'
                      ? 'bg-critical-50 text-critical-800'
                      : 'bg-caution-50 text-caution-900',
                ].join(' ')}
              >
                {tone === 'busy' ? (
                  <span className="mr-1.5 inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-caution-600 align-middle" />
                ) : null}
                {label}
              </span>
            </li>
          )
        })}
      </ul>

      <p className="mt-2 text-xs text-ink-500">
        Results land in this tool when a run finishes and the site rebuilds — a few minutes
        after the run goes green.{' '}
        <a href={workflowUrl} target="_blank" rel="noreferrer" className="underline">
          Full logs on GitHub
        </a>
        .
      </p>
    </div>
  )
}

/** Rough and readable. Exact timestamps are a click away on the run page. */
function relativeTime(iso: string): string {
  const seconds = Math.round((Date.now() - Date.parse(iso)) / 1000)

  if (!Number.isFinite(seconds)) return 'recently'
  if (seconds < 60) return 'just now'
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min ago`
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)} h ago`
  return `${Math.floor(seconds / 86_400)} d ago`
}
