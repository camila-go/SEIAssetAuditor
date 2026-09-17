import { useState } from 'react'
import { Link } from 'react-router-dom'
import { PageHeader } from '../components/Layout'
import { SubmissionStatusBadge } from '../components/StatusBadge'
import { EmptyState, ErrorState, Skeleton } from '../components/States'
import { useIntakeQueue } from '../api/queries'
import { hasInternalCredentials, setInternalCredentials } from '../api/client'
import { formatDate } from '../lib/format'

/** Waiting longer than this is highlighted for the queue view. */
const SLOW_REVIEW_DAYS = 5

/** `/admin/intake` — the approval queue. */
export default function AdminIntake(): JSX.Element {
  const [status, setStatus] = useState('')
  const [page, setPage] = useState(1)
  const [authed, setAuthed] = useState(hasInternalCredentials())

  const queue = useIntakeQueue({ ...(status ? { status } : {}), page, limit: 50 })

  if (!authed) return <ApproverSignIn onSignedIn={() => setAuthed(true)} />

  const totalPages = queue.data?.meta ? Math.ceil(queue.data.meta.total / queue.data.meta.limit) : 1

  return (
    <div>
      <PageHeader
        title="Video intake queue"
        description="Submissions awaiting legal and marketing review."
      />

      <div className="mb-4">
        <select
          value={status}
          onChange={(event) => {
            setStatus(event.target.value)
            setPage(1)
          }}
          aria-label="Filter by status"
          className="select-field w-auto"
        >
          <option value="">All submissions</option>
          <option value="pending_review">Pending</option>
          <option value="legal_approved">Legal approved</option>
          <option value="marketing_approved">Marketing approved</option>
          <option value="approved">Approved</option>
          <option value="rejected">Rejected</option>
        </select>
      </div>

      {queue.isLoading ? (
        <Skeleton rows={6} />
      ) : queue.isError ? (
        <ErrorState error={queue.error} onRetry={() => void queue.refetch()} />
      ) : !queue.data || queue.data.submissions.length === 0 ? (
        <EmptyState
          title="Nothing in the queue"
          message={
            status
              ? 'No submissions have that status right now.'
              : 'No videos have been submitted yet.'
          }
        />
      ) : (
        <div className="overflow-x-auto rounded-lg border border-ink-200 bg-white">
          <table className="min-w-full divide-y divide-ink-200 text-sm">
            <thead className="bg-ink-50 text-left text-label uppercase text-ink-500">
              <tr>
                <th scope="col" className="px-4 py-2 font-medium">Title</th>
                <th scope="col" className="px-4 py-2 font-medium">Submitter</th>
                <th scope="col" className="px-4 py-2 font-medium">Program</th>
                <th scope="col" className="px-4 py-2 font-medium">Submitted</th>
                <th scope="col" className="px-4 py-2 font-medium">Status</th>
                <th scope="col" className="px-4 py-2 text-right font-medium">Waiting</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-ink-100">
              {queue.data.submissions.map((submission) => {
                const isPending =
                  submission.status !== 'approved' && submission.status !== 'rejected'
                const isSlow = isPending && submission.daysWaiting > SLOW_REVIEW_DAYS

                return (
                  <tr key={submission.id} className={isSlow ? 'bg-caution-50' : 'hover:bg-ink-50'}>
                    <td className="px-4 py-2">
                      <Link
                        to={`/admin/intake/${submission.id}`}
                        className="font-medium text-brand-700 hover:underline"
                      >
                        {submission.title}
                      </Link>
                    </td>
                    <td className="px-4 py-2 text-ink-700">
                      {submission.submitterName}
                      <span className="block text-xs text-ink-500">{submission.submitterOrg}</span>
                    </td>
                    <td className="px-4 py-2 text-ink-700">{submission.program}</td>
                    <td className="px-4 py-2 text-ink-600">{formatDate(submission.submittedAt)}</td>
                    <td className="px-4 py-2">
                      <SubmissionStatusBadge status={submission.status} />
                    </td>
                    <td className="px-4 py-2 text-right tabular-nums text-ink-700">
                      {isPending ? (
                        <span title={isSlow ? `Waiting over ${SLOW_REVIEW_DAYS} days` : undefined}>
                          {submission.daysWaiting}d
                        </span>
                      ) : (
                        '—'
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
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

/**
 * Approver sign-in.
 *
 * Placeholder for the SSO decision in PRD §11 — a shared token plus the
 * approver's email, held in sessionStorage. When SSO lands, this component and
 * `internalAuthHeaders` in the API client are the only things that change.
 */
function ApproverSignIn({ onSignedIn }: { onSignedIn: () => void }): JSX.Element {
  const [token, setToken] = useState('')
  const [email, setEmail] = useState('')

  return (
    <div className="mx-auto max-w-md rounded-lg border border-ink-200 bg-white p-6">
      <h1 className="text-lg font-semibold text-ink-900">Approver sign-in</h1>
      <p className="mt-2 text-sm text-ink-600">
        The video queue is restricted to legal and marketing approvers.
      </p>

      <form
        onSubmit={(event) => {
          event.preventDefault()
          setInternalCredentials(token.trim(), email.trim())
          onSignedIn()
        }}
        className="mt-4 space-y-3"
      >
        <div>
          <label htmlFor="approver-email" className="block text-sm font-medium text-ink-700">
            Your email
          </label>
          <input
            id="approver-email"
            type="email"
            required
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            className="mt-1 w-full rounded-md border border-ink-300 px-3 py-2 text-sm"
          />
          <p className="mt-1 text-xs text-ink-500">Recorded against every decision you make.</p>
        </div>

        <div>
          <label htmlFor="approver-token" className="block text-sm font-medium text-ink-700">
            Access token
          </label>
          <input
            id="approver-token"
            type="password"
            required
            value={token}
            onChange={(event) => setToken(event.target.value)}
            className="mt-1 w-full rounded-md border border-ink-300 px-3 py-2 text-sm"
          />
        </div>

        <button
          type="submit"
          className="w-full rounded-md bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700"
        >
          Continue
        </button>
      </form>

      <p className="mt-4 text-xs text-ink-500">
        Cleared when you close the browser. Capella SSO will replace this — see the open questions
        in the PRD.
      </p>
    </div>
  )
}
