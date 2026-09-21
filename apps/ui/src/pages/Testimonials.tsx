import { useState } from 'react'
import { Link, useParams, useSearchParams } from 'react-router-dom'
import { PageHeader } from '../components/Layout'
import { Highlight } from '../components/Highlight'
import {
  FreshnessBadge,
  NeedsReviewBadge,
  SourceTypeBadge,
  StatusBadge,
} from '../components/StatusBadge'
import { EmptyState, ErrorState, PhaseNotice, Skeleton } from '../components/States'
import { MatchReasonBadge, SemanticNotice } from '../components/MatchReason'
import { useBuildSearchIndex, useSearchIndex, useTestimonial, useTestimonials } from '../api/queries'
import { formatDate } from '../lib/format'
import { apiUrl } from '../api/client'

/**
 * `/testimonials` — one search box across quote text, student name and program.
 * Designers don't know which field a remembered phrase lives in.
 */
export default function Testimonials(): JSX.Element {
  /**
   * Filters come in by URL as well as from the controls: the dashboard links
   * to `?needsReview=true` and the coverage grid to `?program=…`. They are read
   * once as the initial state rather than driving it, so typing in the search
   * box afterwards does not fight the querystring.
   */
  const [searchParams] = useSearchParams()
  const programFilter = searchParams.get('program') ?? ''

  const [query, setQuery] = useState('')
  const [sourceType, setSourceType] = useState('')
  const [needsReview, setNeedsReview] = useState(searchParams.get('needsReview') === 'true')
  const [page, setPage] = useState(1)

  const testimonials = useTestimonials({
    ...(query.trim() ? { query: query.trim() } : {}),
    ...(programFilter ? { program: programFilter } : {}),
    ...(sourceType ? { sourceType } : {}),
    ...(needsReview ? { needsReview: true } : {}),
    page,
    limit: 25,
  })

  const searchIndex = useSearchIndex()
  const buildIndex = useBuildSearchIndex()

  const totalPages = testimonials.data?.meta
    ? Math.ceil(testimonials.data.meta.total / testimonials.data.meta.limit)
    : 1

  return (
    <div>
      <PageHeader
        title="Testimonials"
        description="Every testimonial found on an audited page — both AEM components and hardcoded text."
      >
        <a
          href={apiUrl('/testimonials/export')}
          className="rounded-md bg-white px-3 py-2 text-sm font-medium text-ink-700 ring-1 ring-ink-300 hover:bg-ink-50"
        >
          Export CSV
        </a>
      </PageHeader>

      {/* Stacks below sm: at 375px a flex-wrap row squeezed the search box to
          about 60px, which is unusable for the primary control on the page. */}
      <div className="mb-4 flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
        <input
          type="search"
          value={query}
          onChange={(event) => {
            setQuery(event.target.value)
            setPage(1)
          }}
          data-testid="testimonial-search"
          placeholder="Search quote, student name or program"
          className="w-full min-w-0 rounded-md border border-ink-300 px-3 py-2 text-sm sm:flex-1"
        />

        <select
          value={sourceType}
          onChange={(event) => {
            setSourceType(event.target.value)
            setPage(1)
          }}
          aria-label="Filter by source type"
          className="select-field sm:w-auto"
        >
          <option value="">Any source</option>
          <option value="structured_component">Component</option>
          <option value="hardcoded_text">Hardcoded</option>
        </select>

        <label className="flex items-center gap-2 text-sm text-ink-700">
          <input
            type="checkbox"
            checked={needsReview}
            onChange={(event) => {
              setNeedsReview(event.target.checked)
              setPage(1)
            }}
            className="rounded border-ink-300"
          />
          Needs review only
        </label>
      </div>

      {/* Without an index, meaning-based search silently does nothing — the
          same failure mode as an unbuilt fingerprint index. Say so, and offer
          the fix, rather than letting it look like there is simply no match. */}
      {searchIndex.data &&
      searchIndex.data.enabled &&
      searchIndex.data.testimonials.embedded < searchIndex.data.testimonials.total ? (
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-md border border-caution-200 bg-caution-50 px-4 py-3 text-sm text-caution-900">
          <span>
            {searchIndex.data.testimonials.embedded} of {searchIndex.data.testimonials.total}{' '}
            testimonials are indexed for meaning-based search. The rest can only be found by their
            exact words.
          </span>
          <button
            type="button"
            onClick={() => buildIndex.mutate()}
            disabled={buildIndex.isPending}
            className="rounded-md bg-caution-600 px-3 py-2 text-xs font-medium text-white hover:bg-caution-700 disabled:bg-ink-300"
          >
            {buildIndex.isPending ? 'Queued…' : 'Build the index'}
          </button>
        </div>
      ) : null}

      {/* A filter arriving by URL is invisible otherwise — the list would just
          look short with no explanation of why. */}
      {programFilter ? (
        <p className="mb-4 flex flex-wrap items-center gap-2 text-sm text-ink-600">
          <span>
            Showing testimonials for <strong className="text-ink-900">{programFilter}</strong>
          </span>
          <Link to="/testimonials" className="text-brand-700 hover:underline">
            Clear
          </Link>
        </p>
      ) : null}

      {testimonials.isLoading ? (
        <Skeleton rows={6} />
      ) : testimonials.isError ? (
        <ErrorState error={testimonials.error} onRetry={() => void testimonials.refetch()} />
      ) : !testimonials.data || testimonials.data.testimonials.length === 0 ? (
        <EmptyState
          title="No testimonials found"
          message={
            query
              ? 'Nothing matches that search. Try a distinctive phrase from the quote itself.'
              : 'Nothing has been indexed yet. Run an audit over pages that carry testimonials.'
          }
          action={
            <Link
              to="/audit"
              className="rounded-md bg-brand-600 px-3 py-2 text-sm font-medium text-white"
            >
              Run an audit
            </Link>
          }
        />
      ) : (
        <>
        <SemanticNotice
          hasSemanticOnly={testimonials.data.testimonials.some(
            (t) => t.matchReasons.length > 0 && t.matchReasons.every((r) => r === 'semantic'),
          )}
        />
        <ul className="space-y-3" data-testid="testimonial-results">
          {testimonials.data.testimonials.map((testimonial) => (
            <li key={testimonial.id}>
              <Link
                to={`/testimonials/${testimonial.id}`}
                className="block rounded-lg border border-ink-200 bg-white p-4 hover:border-brand-600"
              >
                <blockquote className="text-sm text-ink-800">
                  <Highlight text={truncate(testimonial.quoteText, 240)} query={query} />
                </blockquote>

                <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-ink-600">
                  {testimonial.studentName ? (
                    <span className="font-medium text-ink-900">
                      <Highlight text={testimonial.studentName} query={query} />
                    </span>
                  ) : (
                    <span className="italic text-ink-500">No name captured</span>
                  )}
                  {testimonial.program ? (
                    <span>
                      · <Highlight text={testimonial.program} query={query} />
                    </span>
                  ) : null}
                  <span>
                    · {testimonial.referenceCount} page
                    {testimonial.referenceCount === 1 ? '' : 's'}
                  </span>
                </div>

                <div className="mt-2 flex flex-wrap gap-2">
                  <MatchReasonBadge
                    reasons={testimonial.matchReasons}
                    {...(testimonial.similarity !== undefined
                      ? { similarity: testimonial.similarity }
                      : {})}
                  />
                  <SourceTypeBadge sourceType={testimonial.sourceType} />
                  <FreshnessBadge daysSinceLastSeen={testimonial.daysSinceLastSeen} />
                  {testimonial.needsReview ? <NeedsReviewBadge /> : null}
                </div>
              </Link>
            </li>
          ))}
        </ul>
        </>
      )}

      {totalPages > 1 ? (
        <div className="mt-4 flex items-center justify-between text-sm">
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
    </div>
  )
}

/** `/testimonials/:id` — the page map plus provenance. */
export function TestimonialDetail(): JSX.Element {
  const { id = '' } = useParams<{ id: string }>()
  const testimonial = useTestimonial(id)

  if (testimonial.isLoading) return <Skeleton rows={6} />
  if (testimonial.isError) {
    return <ErrorState error={testimonial.error} onRetry={() => void testimonial.refetch()} />
  }
  if (!testimonial.data) return <ErrorState error={new Error('Testimonial not found')} />

  const data = testimonial.data

  return (
    <div>
      <PageHeader title="Testimonial" description={data.studentName ?? 'No name captured'} />

      <blockquote className="rounded-lg border-l-4 border-brand-600 bg-white p-4 text-base text-ink-800">
        {data.quoteText}
      </blockquote>

      <div className="mt-3 flex flex-wrap gap-2">
        <SourceTypeBadge sourceType={data.sourceType} />
        <FreshnessBadge daysSinceLastSeen={data.daysSinceLastSeen} />
        {data.needsReview ? <NeedsReviewBadge /> : null}
      </div>

      {data.needsReview ? (
        <PhaseNotice>
          The student name or program differs between pages showing this quote. The tool keeps what
          it saw first and flags it — nothing is overwritten automatically. Someone needs to check
          which attribution is correct and fix it in AEM.
        </PhaseNotice>
      ) : null}

      <dl className="mt-6 grid gap-x-8 gap-y-2 text-sm sm:grid-cols-2">
        <Field label="Student" value={data.studentName ?? 'Not captured'} />
        <Field label="Program" value={data.program ?? 'Not captured'} />
        <Field label="Degree level" value={data.degreeLevel ?? 'Not captured'} />
        <Field label="First seen" value={formatDate(data.firstSeenAt)} />
        <Field label="Last seen" value={formatDate(data.lastSeenAt)} />
        <Field
          label="Source"
          value={
            data.sourceType === 'structured_component'
              ? 'AEM component — editable in one place'
              : 'Hardcoded text — must be edited on each page'
          }
        />
      </dl>

      <section className="mt-6">
        <h2 className="text-md font-semibold text-ink-900">
          Appears on {data.referenceCount} page{data.referenceCount === 1 ? '' : 's'}
        </h2>

        {data.pages.length === 0 ? (
          <p className="mt-2 text-sm text-ink-600">No audited page currently shows this quote.</p>
        ) : (
          <ul className="mt-2 divide-y divide-ink-100 rounded-lg border border-ink-200 bg-white">
            {data.pages.map((page) => (
              <li key={page.pageId} className="flex flex-wrap items-center gap-2 px-3 py-2">
                <a
                  href={page.url}
                  target="_blank"
                  rel="noreferrer"
                  className="min-w-0 flex-1 truncate text-sm text-brand-700 hover:underline"
                >
                  {page.title ?? page.url}
                </a>
                <StatusBadge status={page.liveStatus} />
              </li>
            ))}
          </ul>
        )}
      </section>

      {data.rawHtml ? (
        <details className="mt-6">
          <summary className="cursor-pointer text-sm font-medium text-ink-700">
            Raw HTML as scraped
          </summary>
          <pre className="mt-2 overflow-x-auto rounded-md bg-ink-900 p-3 text-xs text-ink-100">
            {data.rawHtml}
          </pre>
        </details>
      ) : null}
    </div>
  )
}

function Field({ label, value }: { label: string; value: string }): JSX.Element {
  return (
    <div>
      <dt className="text-label uppercase text-ink-500">{label}</dt>
      <dd className="mt-1 text-ink-900">{value}</dd>
    </div>
  )
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max).trimEnd()}…`
}
