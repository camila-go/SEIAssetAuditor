import { Link } from 'react-router-dom'
import { PageHeader } from '../components/Layout'
import { CardSkeleton, ErrorState } from '../components/States'
import { TaskGrid, type Task } from '../components/TaskGrid'
import { useAuditJobs, useDashboardStats, type AuditJobSummary, type DashboardStats } from '../api/queries'
import { useAuditStore } from '../store/auditStore'
import { formatDateTime } from '../lib/format'

/**
 * `/` — the dashboard.
 *
 * Two kinds of content, in this order:
 *
 * 1. State — what is running and what is broken. Time-sensitive, so it is
 *    first, and each part renders nothing at all when there is nothing to say.
 *    A permanent panel reading "0 issues" trains people to skip the region
 *    where real problems will later appear.
 * 2. Tasks — the jobs the tool exists to do, as a grid sized by importance.
 *
 * Recent audits sit below both. They are history: useful for getting back to a
 * job, but they were pushing the tasks off the first screen, and a list of five
 * near-identical rows is a poor thing to lead with.
 *
 * The row of totals that used to close the page is gone. Those numbers were
 * accurate and inert; each now sits on the task it gives scale to, which is the
 * only place it means anything.
 */
export default function Dashboard(): JSX.Element {
  const stats = useDashboardStats()
  const jobs = useAuditJobs(5)
  const recentJobs = useAuditStore((state) => state.recentJobs)

  const allJobs = jobs.data ?? []

  // Surfaced first: the user was told they could close the tab, so returning
  // to find the job still running has to be immediately obvious.
  const liveJobs = allJobs.filter((job) => job.status === 'running' || job.status === 'queued')

  const isLoading = stats.isLoading || jobs.isLoading

  // Nothing indexed and nothing ever run — a first-time visitor, not an empty
  // result. Four zeroes tell them nothing; one instruction tells them everything.
  const isFirstRun =
    !isLoading &&
    allJobs.length === 0 &&
    (stats.data?.assets.totalPages ?? 0) === 0 &&
    (stats.data?.assets.totalAssets ?? 0) === 0

  if (isFirstRun) return <FirstRun />

  return (
    <div>
      <PageHeader
        title="Dashboard"
        description="What is running, what needs attention, and what you can do with the index."
      >
        <Link
          to="/audit"
          className="rounded-md bg-brand-600 px-3 py-2 text-sm font-medium text-white hover:bg-brand-700"
        >
          Run an audit
        </Link>
      </PageHeader>

      {/* ── 1. In flight ─────────────────────────────────────────────────── */}
      {liveJobs.length > 0 ? (
        <section className="mb-8">
          <h2 className="mb-2 text-md font-semibold text-ink-900">Running now</h2>
          <ul className="space-y-2">
            {liveJobs.map((job) => {
              const processed = job.completedUrls + job.failedUrls
              const percent = job.totalUrls === 0 ? 0 : Math.round((processed / job.totalUrls) * 100)

              return (
                <li key={job.id}>
                  <Link
                    to={`/audit/${job.id}`}
                    className="block rounded-lg border border-brand-100 bg-brand-50 p-3 hover:border-brand-600"
                  >
                    <div className="flex flex-wrap items-baseline justify-between gap-2">
                      <span className="text-sm font-medium text-ink-900">{job.name}</span>
                      <span className="text-xs tabular-nums text-ink-600">
                        {processed} / {job.totalUrls}
                      </span>
                    </div>
                    <div className="mt-2 h-2 overflow-hidden rounded-full bg-white">
                      <div className="h-full bg-brand-600" style={{ width: `${percent}%` }} />
                    </div>
                  </Link>
                </li>
              )
            })}
          </ul>
        </section>
      ) : null}

      {/* ── 2. What is broken ────────────────────────────────────────────── */}
      {isLoading ? null : <NeedsAttention stats={stats.data} jobs={allJobs} />}

      {/* ── 3. What you can do — the point of the page ───────────────────── */}
      <section className="mb-8">
        <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-md font-semibold text-ink-900">What you can do</h2>
          <Link to="/guide" className="text-xs font-medium text-brand-700 hover:underline">
            How this works →
          </Link>
        </div>

        {stats.isError ? (
          <ErrorState error={stats.error} onRetry={() => void stats.refetch()} />
        ) : (
          <TaskGrid tasks={buildTasks(stats.data)} />
        )}
      </section>

      {/* ── 4. Recent audits — history, so it goes last ──────────────────── */}
      <section className="mb-8">
        <h2 className="mb-2 text-md font-semibold text-ink-900">Recent audits</h2>

        {jobs.isLoading ? (
          <CardSkeleton />
        ) : allJobs.length === 0 ? (
          <p className="rounded-lg border border-dashed border-ink-300 bg-white px-4 py-8 text-center text-sm text-ink-600">
            No audits yet.{' '}
            <Link to="/audit" className="text-brand-700 hover:underline">
              Run your first one
            </Link>
            .
          </p>
        ) : (
          <ul className="divide-y divide-ink-100 rounded-lg border border-ink-200 bg-white shadow-card">
            {allJobs.map((job) => (
              <li key={job.id}>
                <Link
                  to={`/audit/${job.id}`}
                  className="flex flex-wrap items-center justify-between gap-2 px-4 py-3 hover:bg-ink-50"
                >
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-ink-900">{job.name}</p>
                    <p className="text-xs text-ink-500">
                      {formatDateTime(job.completedAt ?? job.createdAt)} · {job.totalUrls} URLs
                      {job.failedUrls > 0 ? (
                        <span className="text-critical-700"> · {job.failedUrls} failed</span>
                      ) : null}
                    </p>
                  </div>
                  <span className="text-xs capitalize text-ink-600">{job.status}</span>
                </Link>
              </li>
            ))}
          </ul>
        )}

        {recentJobs.length > 0 ? (
          <p className="mt-2 text-xs text-ink-500">
            Audits you started in this browser are remembered here even after the tab closes.
          </p>
        ) : null}
      </section>

    </div>
  )
}

/**
 * The tiles, with live figures attached.
 *
 * Every metric is phrased as scale rather than as an achievement — "across 65
 * indexed assets" tells someone whether an answer can be trusted yet, which a
 * bare "65" does not.
 */
function buildTasks(stats: DashboardStats | undefined): Task[] {
  const assets = stats?.assets.totalAssets ?? 0
  const pages = stats?.assets.totalPages ?? 0
  const testimonials = stats?.testimonials.totalTestimonials ?? 0

  return [
    {
      title: 'Audit a set of pages',
      body: 'Paste URLs, upload a CSV, or point it at a sitemap. Everything else here reads the index this builds.',
      to: '/audit',
      span: 'full',
      tone: 'primary',
      metric: { value: pages.toLocaleString(), label: pages === 1 ? 'page audited so far' : 'pages audited so far' },
    },
    {
      title: 'Find where an asset is used',
      body: 'Search by DAM path or public URL — or drop in the picture itself and match it visually.',
      to: '/lookup',
      span: 'half',
      metric: { value: assets.toLocaleString(), label: 'indexed assets to search' },
    },
    {
      title: 'Search testimonials',
      body: 'One box across quote, student and program. Tolerates typos and finds quotes by meaning.',
      to: '/testimonials',
      span: 'half',
      metric: { value: testimonials.toLocaleString(), label: testimonials === 1 ? 'quote indexed' : 'quotes indexed' },
    },
    {
      title: 'Find duplicate images',
      body: 'Groups images that are visually the same, including renamed and re-exported copies.',
      to: '/duplicates',
      span: 'half',
      // Deliberately no metric. Showing a live group count meant calling
      // /duplicates on every dashboard load, and that endpoint compares every
      // hashed image against every other one: 1,540 comparisons at today's 56
      // images, but ~50 million at ten thousand. That is not a cost the landing
      // page should carry to display one number. A cheap count endpoint would
      // bring it back — see docs/architecture-review.md.
    },
    {
      title: 'Review video submissions',
      body: 'Approve or reject videos vendors have submitted, with the legal agreement they signed.',
      to: '/admin/intake',
      span: 'half',
      ...(stats?.intake
        ? {
            metric: {
              value: stats.intake.pending.toLocaleString(),
              label: stats.intake.pending === 1 ? 'awaiting a decision' : 'awaiting a decision',
            },
          }
        : { gated: 'Approver sign-in required' }),
    },
  ]
}

// ─── Needs attention ─────────────────────────────────────────────────────────

interface Attention {
  label: string
  detail: string
  to: string
  tone: 'caution' | 'critical'
}

/**
 * The part of the page that answers "what is broken".
 *
 * Renders nothing at all when nothing is wrong. An always-present panel reading
 * "0 issues" is noise that trains people to skip the region where real problems
 * will later appear.
 */
function NeedsAttention({
  stats,
  jobs,
}: {
  stats: DashboardStats | undefined
  jobs: AuditJobSummary[]
}): JSX.Element | null {
  const items: Attention[] = []

  const failedUrls = jobs.reduce((total, job) => total + job.failedUrls, 0)
  if (failedUrls > 0) {
    // `?failures=1` opens the panel on arrival. Without it this landed on the
    // job page with the failures collapsed behind a toggle — you clicked a
    // specific finding and got a page that did not show it.
    const withFailures = jobs.filter((entry) => entry.failedUrls > 0)
    const job = withFailures[0]
    const spread = withFailures.length > 1

    items.push({
      label: `${failedUrls} URL${failedUrls === 1 ? '' : 's'} could not be scraped`,
      detail: spread
        ? `Across ${withFailures.length} audits. Opens the most recent; each failure records why.`
        : 'Each failure records why.',
      to: job ? `/audit/${job.id}?failures=1` : '/audit',
      tone: 'critical',
    })
  }

  const failedJobs = jobs.filter((job) => job.status === 'failed')
  if (failedJobs.length > 0) {
    items.push({
      label: `${failedJobs.length} audit${failedJobs.length === 1 ? '' : 's'} failed outright`,
      detail: 'Something outside the page-by-page handling went wrong.',
      to: `/audit/${failedJobs[0]?.id ?? ''}?failures=1`,
      tone: 'critical',
    })
  }

  if (stats && stats.testimonials.needingReview > 0) {
    items.push({
      label: `${stats.testimonials.needingReview} testimonial${stats.testimonials.needingReview === 1 ? '' : 's'} need review`,
      detail: 'The name or program conflicts between pages. Only a person can reconcile it.',
      to: '/testimonials?needsReview=true',
      tone: 'caution',
    })
  }

  if (stats && stats.testimonials.stale > 0) {
    items.push({
      label: `${stats.testimonials.stale} testimonial${stats.testimonials.stale === 1 ? '' : 's'} not seen in 90+ days`,
      detail: 'They may have been removed from the pages that carried them.',
      to: '/testimonials',
      tone: 'caution',
    })
  }

  if (stats?.intake && stats.intake.pending > 0) {
    items.push({
      label: `${stats.intake.pending} video${stats.intake.pending === 1 ? '' : 's'} awaiting a decision`,
      detail: 'Legal or marketing review has not happened yet.',
      to: '/admin/intake',
      tone: 'caution',
    })
  }

  if (items.length === 0) return null

  return (
    <section className="mb-8">
      <h2 className="mb-2 text-md font-semibold text-ink-900">Needs attention</h2>
      <ul className="divide-y divide-ink-100 overflow-hidden rounded-lg border border-ink-200 bg-white shadow-card">
        {items.map((item) => (
          <li key={item.label}>
            <Link
              to={item.to}
              className="flex items-start gap-3 px-4 py-3 hover:bg-ink-50"
            >
              <span
                aria-hidden="true"
                className={[
                  'mt-2 h-2 w-2 shrink-0 rounded-full',
                  item.tone === 'critical' ? 'bg-critical-500' : 'bg-caution-400',
                ].join(' ')}
              />
              <span className="min-w-0">
                <span className="block text-sm font-medium text-ink-900">{item.label}</span>
                <span className="block text-xs text-ink-500">{item.detail}</span>
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  )
}

// ─── First run ───────────────────────────────────────────────────────────────

/**
 * What a brand-new install shows.
 *
 * The dashboard's normal layout is useless here: every number is zero and every
 * list is empty, which looks like a broken page rather than a new one. This says
 * what the tool does and gives one obvious thing to do.
 */
function FirstRun(): JSX.Element {
  return (
    <div className="mx-auto max-w-2xl py-6">
      <h1 className="text-2xl font-semibold text-ink-900">Nothing audited yet</h1>
      <p className="mt-2 text-ink-600">
        Point the auditor at some capella.edu pages and it will record every DAM asset and
        testimonial it finds on them, along with whether each page looks published.
      </p>

      <ol className="mt-6 space-y-3">
        {[
          {
            title: 'Run an audit',
            body: 'Paste URLs, upload a CSV, or give it a sitemap. There is no cap — it runs in the background and you can close the tab.',
          },
          {
            title: 'Look things up',
            body: 'Once pages are indexed, find where any asset is used — by its DAM path, or by dropping in the picture itself.',
          },
          {
            title: 'Search testimonials',
            body: 'Every quote found on an audited page, searchable by text, student or program, with the pages it appears on.',
          },
        ].map((step, index) => (
          <li
            key={step.title}
            className="flex gap-3 rounded-lg border border-ink-200 bg-white p-4 shadow-card"
          >
            <span className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-brand-50 text-xs font-semibold text-brand-700">
              {index + 1}
            </span>
            <span>
              <span className="block text-sm font-medium text-ink-900">{step.title}</span>
              <span className="mt-1 block text-sm text-ink-600">{step.body}</span>
            </span>
          </li>
        ))}
      </ol>

      <Link
        to="/audit"
        className="mt-6 inline-block rounded-md bg-brand-600 px-4 py-3 text-sm font-medium text-white hover:bg-brand-700"
      >
        Run the first audit
      </Link>

      <p className="mt-6 text-xs text-ink-500">
        None of this needs AEM credentials. Features that do — sitewide reference lookup, program
        coverage, video intake — say so when you open them.
      </p>
    </div>
  )
}
