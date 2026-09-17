import { Link, useSearchParams } from 'react-router-dom'
import { usePublicSubmission } from '../api/queries'
import { ErrorState, Skeleton } from '../components/States'
import { formatDateTime } from '../lib/format'

/** `/intake/confirm?id=…` — tracking reference and what happens next. */
export default function IntakeConfirm(): JSX.Element {
  const [params] = useSearchParams()
  const id = params.get('id') ?? ''

  const submission = usePublicSubmission(id)

  if (!id) {
    return (
      <ErrorState error={new Error('No submission reference was provided in the link.')} />
    )
  }

  if (submission.isLoading) return <Skeleton rows={4} />
  if (submission.isError) return <ErrorState error={submission.error} />
  if (!submission.data) return <ErrorState error={new Error('Submission not found')} />

  const data = submission.data

  return (
    <div className="rounded-lg border border-ink-200 bg-white p-6">
      <div className="flex items-start gap-3">
        <span
          aria-hidden="true"
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-verified-100 text-verified-700"
        >
          ✓
        </span>
        <div>
          <h1 className="text-lg font-semibold text-ink-900">Submission received</h1>
          <p className="mt-1 text-sm text-ink-600">
            &ldquo;{data.title}&rdquo; was submitted on {formatDateTime(data.submittedAt)}.
          </p>
        </div>
      </div>

      <div className="mt-6 rounded-md bg-ink-50 px-4 py-3">
        <p className="text-label uppercase text-ink-500">Your tracking reference</p>
        <p className="mt-1 select-all break-all font-mono text-sm font-medium text-ink-900">
          {data.id}
        </p>
      </div>

      <p className="mt-4 text-sm text-ink-700">
        You&apos;ll receive an email at <strong>{data.submitterEmail}</strong> when legal and
        marketing have made a decision. Keep the reference above in case you need to follow up.
      </p>

      {data.status === 'rejected' ? (
        <div className="mt-6 rounded-md border border-critical-200 bg-critical-50 px-4 py-3">
          <p className="text-sm font-medium text-critical-900">This submission was not approved</p>
          {data.rejectionReason ? (
            <p className="mt-1 text-sm text-critical-800">{data.rejectionReason}</p>
          ) : null}
          <Link
            to={`/intake/resubmit/${data.id}`}
            className="mt-3 inline-block rounded-md bg-brand-600 px-3 py-2 text-sm font-medium text-white"
          >
            Submit a revised version
          </Link>
        </div>
      ) : (
        <p className="mt-6 text-sm text-ink-600">
          Need to change something before review starts?{' '}
          <Link to="/intake" className="text-brand-700 hover:underline">
            Submit again
          </Link>{' '}
          and let your Capella contact know which version to use.
        </p>
      )}
    </div>
  )
}
