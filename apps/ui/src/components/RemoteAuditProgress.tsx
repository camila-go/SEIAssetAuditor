import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { fetchProgress, fetchSnapshotDate } from '../api/actions'
import { reloadStaticData } from '../api/staticData'

/**
 * Progress of an audit started from the published site, shown in the tool.
 *
 * The crawl runs as a background job elsewhere, but nothing about that is the
 * user's concern: they pressed Start audit here, so they follow it here, and
 * the new findings load here when it is done. Closing the tab is fine — the
 * audit is remembered in this browser and the view resumes on return.
 */

export interface RemoteAudit {
  since: string
  /** When Start audit was pressed, in this browser — what "started N ago" counts from. */
  clickedAt?: string
  totalUrls: number
  name: string
  /** The published snapshot's date when the audit started. */
  snapshotBefore: string | null
}

const STORAGE_KEY = 'sei-auditor.remote-audit'

export function loadRemoteAudit(): RemoteAudit | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    return raw ? (JSON.parse(raw) as RemoteAudit) : null
  } catch {
    return null
  }
}

export function saveRemoteAudit(audit: RemoteAudit | null): void {
  try {
    if (audit) localStorage.setItem(STORAGE_KEY, JSON.stringify(audit))
    else localStorage.removeItem(STORAGE_KEY)
  } catch {
    // Private windows can refuse storage. The audit still runs; only resuming
    // the view after closing the tab is lost.
  }
}

/** In the order a person sees them. Matches the phases api/run-audit.mjs reports. */
const STAGES = [
  'Waiting to start',
  'Preparing the scraper',
  'Scraping pages',
  'Fingerprinting images',
  'Saving results',
  'Updating this site',
] as const

export interface RemoteAuditProgressProps {
  audit: RemoteAudit
  onDismiss: () => void
}

export function RemoteAuditProgress({ audit, onDismiss }: RemoteAuditProgressProps): JSX.Element {
  const queryClient = useQueryClient()
  const [now, setNow] = useState(() => Date.now())
  const [published, setPublished] = useState(false)

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [])

  const progress = useQuery({
    queryKey: ['remote-audit', audit.since],
    queryFn: () => fetchProgress(audit.since),
    refetchInterval: (query) =>
      query.state.data?.status === 'completed' ? false : 10_000,
    // Keep following while the tab is in the background, so someone who
    // starts an audit and switches away comes back to a current view — and
    // the new findings have already loaded — rather than a frozen one.
    refetchIntervalInBackground: true,
    retry: 2,
  })

  const run = progress.data
  const finished = run?.status === 'completed'
  const succeeded = finished && run?.conclusion === 'success'
  const failed = finished && !succeeded

  // After the job succeeds, the index is committed and the site rebuilds.
  // Watch the published snapshot's date, then load the new findings in place.
  const snapshot = useQuery({
    queryKey: ['snapshot-date', audit.since],
    queryFn: fetchSnapshotDate,
    enabled: Boolean(succeeded) && !published,
    refetchInterval: 20_000,
    refetchIntervalInBackground: true,
  })

  useEffect(() => {
    if (!succeeded || published) return
    const date = snapshot.data
    if (date && date !== audit.snapshotBefore) {
      reloadStaticData()
      void queryClient.invalidateQueries()
      setPublished(true)
    }
  }, [succeeded, published, snapshot.data, audit.snapshotBefore, queryClient])

  const stage = published
    ? STAGES.length
    : succeeded
      ? STAGES.indexOf('Updating this site')
      : Math.max(STAGES.indexOf((run?.phase ?? 'Waiting to start') as (typeof STAGES)[number]), 0)

  // `since` is deliberately a few seconds early (it is how the run is found),
  // so it would overstate how long ago this started.
  const elapsed = formatDuration(now - Date.parse(audit.clickedAt ?? audit.since))
  const title = audit.name || `Audit of ${audit.totalUrls} page${audit.totalUrls === 1 ? '' : 's'}`

  return (
    <section
      data-testid="remote-audit"
      aria-live="polite"
      className="rounded-lg border border-ink-200 bg-white p-4 sm:p-5"
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h2 className="text-md font-semibold text-ink-900">{title}</h2>
          <p className="mt-0.5 text-xs text-ink-500">
            {audit.totalUrls} URL{audit.totalUrls === 1 ? '' : 's'} · started {elapsed} ago
          </p>
        </div>
        <StatusPill published={published} failed={failed} />
      </div>

      {failed ? (
        <div className="mt-4 rounded-md border border-critical-200 bg-critical-50 px-4 py-3 text-sm text-critical-800">
          <p className="font-medium">{run?.phase ?? 'The audit failed'}.</p>
          <p className="mt-1 text-xs">
            Nothing in the tool was changed. This is usually a temporary problem reaching the
            site — starting the audit again normally works.
          </p>
        </div>
      ) : (
        <ol className="mt-4 space-y-2">
          {STAGES.map((label, index) => {
            const state = index < stage ? 'done' : index === stage ? 'current' : 'todo'
            return (
              <li key={label} className="flex items-center gap-3 text-sm">
                <span
                  aria-hidden="true"
                  className={[
                    'flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold',
                    state === 'done'
                      ? 'bg-verified-600 text-white'
                      : state === 'current'
                        ? 'bg-brand-600 text-white'
                        : 'bg-ink-100 text-ink-500',
                  ].join(' ')}
                >
                  {state === 'done' ? '✓' : index + 1}
                </span>
                <span
                  className={
                    state === 'todo'
                      ? 'text-ink-500'
                      : state === 'current'
                        ? 'font-medium text-ink-900'
                        : 'text-ink-700'
                  }
                >
                  {label}
                  {state === 'current' ? (
                    <span className="ml-2 inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-brand-600 align-middle" />
                  ) : null}
                </span>
              </li>
            )
          })}
        </ol>
      )}

      <p className="mt-4 text-xs text-ink-500">
        {published
          ? 'The new findings are loaded. Everything in the tool now includes this audit.'
          : failed
            ? ''
            : succeeded
              ? 'The audit is done. Its findings are being published to this site — this takes a few minutes and loads by itself.'
              : 'Takes a few minutes, plus about ten seconds a page. You can leave this page; come back to Audit to see where it is.'}
      </p>

      {progress.isError && !finished ? (
        <p className="mt-2 text-xs text-caution-900">
          {(progress.error as Error).message} Still checking.
        </p>
      ) : null}

      {finished || published ? (
        <div className="mt-4 flex flex-wrap gap-2">
          {published ? (
            <Link
              to="/assets"
              className="rounded-md bg-brand-600 px-3 py-2 text-xs font-medium text-white hover:bg-brand-700"
            >
              Browse the assets
            </Link>
          ) : null}
          <button
            type="button"
            onClick={onDismiss}
            className="rounded-md bg-white px-3 py-2 text-xs font-medium text-ink-700 ring-1 ring-ink-300 hover:bg-ink-50"
          >
            {failed ? 'Start again' : 'Start another audit'}
          </button>
        </div>
      ) : null}
    </section>
  )
}

function StatusPill({ published, failed }: { published: boolean; failed: boolean }): JSX.Element {
  const [label, tone] = published
    ? ['Done', 'bg-verified-50 text-verified-800']
    : failed
      ? ['Failed', 'bg-critical-50 text-critical-800']
      : ['Running', 'bg-brand-50 text-brand-700']
  return <span className={`rounded-full px-2.5 py-1 text-xs font-medium ${tone}`}>{label}</span>
}

function formatDuration(ms: number): string {
  const seconds = Math.max(Math.round(ms / 1000), 0)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes} min`
  return `${Math.floor(minutes / 60)} h ${minutes % 60} min`
}
