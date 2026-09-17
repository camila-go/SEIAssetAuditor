import { Link } from 'react-router-dom'
import { PageHeader } from '../components/Layout'
import { EmptyState, ErrorState, Skeleton } from '../components/States'
import { useProgramCoverage } from '../api/queries'

/**
 * `/programs/coverage` — Phase 2.
 *
 * Which degree programs are short on live testimonials. Red = 0, amber = 1–2,
 * green = 3+.
 */
export default function ProgramCoverage(): JSX.Element {
  const coverage = useProgramCoverage()

  return (
    <div>
      <PageHeader
        title="Program coverage"
        description="Live testimonials per degree program. Click a program to see its testimonials."
      />

      {coverage.isLoading ? (
        <Skeleton rows={6} />
      ) : coverage.isError ? (
        <ErrorState error={coverage.error} />
      ) : !coverage.data || coverage.data.length === 0 ? (
        <EmptyState
          title="No program data yet"
          message="Coverage is calculated from testimonials found on published pages. Run an audit across the program pages first."
        />
      ) : (
        <>
          <div className="mb-4 flex flex-wrap gap-4 text-xs text-ink-600">
            <Legend className="bg-critical-500" label="No live testimonials" />
            <Legend className="bg-caution-500" label="1–2 testimonials" />
            <Legend className="bg-verified-500" label="3 or more" />
          </div>

          <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {coverage.data.map((program) => (
              <li key={program.program}>
                <Link
                  to={`/testimonials?program=${encodeURIComponent(program.program)}`}
                  className={[
                    'block rounded-lg border-l-4 bg-white p-4 shadow-sm hover:shadow',
                    program.severity === 'red'
                      ? 'border-critical-500'
                      : program.severity === 'amber'
                        ? 'border-caution-500'
                        : 'border-verified-500',
                  ].join(' ')}
                >
                  <p className="text-sm font-medium text-ink-900">{program.program}</p>
                  <p className="mt-1 text-2xl font-semibold tabular-nums text-ink-900">
                    {program.liveTestimonialCount}
                  </p>
                  <p className="text-xs text-ink-500">
                    live testimonial{program.liveTestimonialCount === 1 ? '' : 's'}
                  </p>
                </Link>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  )
}

function Legend({ className, label }: { className: string; label: string }): JSX.Element {
  return (
    <span className="flex items-center gap-2">
      <span className={`h-3 w-3 rounded-sm ${className}`} aria-hidden="true" />
      {label}
    </span>
  )
}
