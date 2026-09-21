import { useRef, useState } from 'react'
import { useParams } from 'react-router-dom'
import type { ApproverType, VideoSubmissionDetail } from '@capella/types'
import { PageHeader } from '../components/Layout'
import { SubmissionStatusBadge } from '../components/StatusBadge'
import { ErrorState, Skeleton } from '../components/States'
import { useApprovalDecision, useSubmission } from '../api/queries'
import { apiUrl, getApproverEmail } from '../api/client'
import { formatBytes, formatDate, formatDateTime, shortTimestamp, timestampToSeconds } from '../lib/format'

/** `/admin/intake/:id` — review, transcript, and the approve/reject decision. */
export default function AdminIntakeDetail(): JSX.Element {
  const { id = '' } = useParams<{ id: string }>()
  const submission = useSubmission(id)
  const videoRef = useRef<HTMLVideoElement>(null)

  if (submission.isLoading) return <Skeleton rows={8} />
  if (submission.isError) {
    return <ErrorState error={submission.error} onRetry={() => void submission.refetch()} />
  }
  if (!submission.data) return <ErrorState error={new Error('Submission not found')} />

  const data = submission.data

  function seekTo(timestamp: string): void {
    const video = videoRef.current
    if (!video) return
    video.currentTime = timestampToSeconds(timestamp)
    void video.play()
  }

  return (
    <div>
      <PageHeader title={data.title} description={`Submitted ${formatDate(data.submittedAt)}`}>
        <SubmissionStatusBadge status={data.status} />
      </PageHeader>

      <div className="grid gap-6 lg:grid-cols-[1fr_320px]">
        <div className="space-y-6">
          {/* ── Video preview — streamed from AEM staging, never downloaded ── */}
          <section>
            {data.aemStagingPath ? (
              <video
                ref={videoRef}
                controls
                preload="metadata"
                className="w-full rounded-lg bg-black"
                src={apiUrl(`/intake/${data.id}/stream`)}
              >
                <track kind="captions" />
              </video>
            ) : (
              <div className="flex h-48 items-center justify-center rounded-lg bg-ink-100 text-sm text-ink-500">
                No video is staged for this submission.
              </div>
            )}
          </section>

          <TranscriptSection submission={data} onSeek={seekTo} />

          {/* ── Metadata ─────────────────────────────────────────────────── */}
          <section>
            <h2 className="mb-2 text-md font-semibold text-ink-900">Submission details</h2>
            <dl className="grid gap-x-8 gap-y-3 rounded-lg border border-ink-200 bg-white p-4 text-sm sm:grid-cols-2">
              <Field label="Description" value={data.description} span />
              <Field label="Program" value={data.program} />
              <Field label="Campaign" value={data.campaign} />
              <Field label="Usage rights" value={data.usageRights} span />
              <Field label="Rights expire" value={formatDate(data.rightsExpiryDate)} />
              <Field label="File" value={`${data.filename} · ${data.fileSize ? formatBytes(data.fileSize) : 'size unknown'}`} />
              <Field label="Submitter" value={`${data.submitterName} (${data.submitterOrg})`} />
              <Field label="Email" value={data.submitterEmail} />
              {data.notes ? <Field label="Notes for reviewers" value={data.notes} span /> : null}
            </dl>
          </section>

          {/* ── Legal ────────────────────────────────────────────────────── */}
          <section>
            <h2 className="mb-2 text-md font-semibold text-ink-900">Legal agreement</h2>
            <div className="rounded-lg border border-ink-200 bg-white p-4 text-sm">
              <p className="font-medium text-verified-700">✓ Agreement confirmed</p>
              <dl className="mt-2 space-y-1 text-ink-700">
                <div className="flex gap-2">
                  <dt className="text-ink-500">Agreed at:</dt>
                  <dd>{formatDateTime(data.legalAgreedAt)}</dd>
                </div>
                <div className="flex gap-2">
                  <dt className="text-ink-500">IP address:</dt>
                  <dd className="font-mono text-xs">{data.legalAgreedIp ?? 'Not recorded'}</dd>
                </div>
              </dl>

              <div className="mt-3 border-t border-ink-200 pt-3">
                {data.hasLegalDoc ? (
                  <a
                    href={apiUrl(`/intake/${data.id}/legal-doc`)}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-block rounded-md bg-white px-3 py-2 text-sm font-medium text-brand-700 ring-1 ring-ink-300 hover:bg-ink-50"
                  >
                    View signed document →
                  </a>
                ) : (
                  <p className="text-sm text-ink-500">No supplementary document uploaded.</p>
                )}
              </div>
            </div>
          </section>
        </div>

        <DecisionPanel submission={data} />
      </div>
    </div>
  )
}

// ─── Transcript ──────────────────────────────────────────────────────────────

function TranscriptSection({
  submission,
  onSeek,
}: {
  submission: VideoSubmissionDetail
  onSeek: (timestamp: string) => void
}): JSX.Element {
  const { transcriptStatus, transcript, chapterMarkers, vttAemPath } = submission

  if (transcriptStatus === 'pending' || transcriptStatus === 'processing') {
    return (
      <section>
        <h2 className="mb-2 text-md font-semibold text-ink-900">Transcript</h2>
        <div className="flex items-center gap-2 rounded-lg border border-ink-200 bg-white p-4 text-sm text-ink-600">
          <span
            aria-hidden="true"
            className="h-3 w-3 animate-spin rounded-full border-2 border-ink-300 border-t-ink-600"
          />
          Transcript generating…
        </div>
      </section>
    )
  }

  if (transcriptStatus === 'failed') {
    return (
      <section>
        <h2 className="mb-2 text-md font-semibold text-ink-900">Transcript</h2>
        <p className="rounded-lg border border-ink-200 bg-white p-4 text-sm text-ink-600">
          Transcription unavailable. You can still review and approve this submission — the
          transcript is a convenience, not a requirement.
        </p>
      </section>
    )
  }

  return (
    <section>
      <h2 className="mb-2 text-md font-semibold text-ink-900">Transcript</h2>

      {chapterMarkers && chapterMarkers.length > 0 ? (
        <div className="mb-3 rounded-lg border border-ink-200 bg-white p-4">
          <h3 className="text-label font-semibold uppercase text-ink-500">Chapters</h3>
          <ul className="mt-2 space-y-1">
            {chapterMarkers.map((chapter) => (
              <li key={chapter.time}>
                <button
                  type="button"
                  onClick={() => onSeek(chapter.time)}
                  className="flex w-full gap-3 rounded px-1 py-1 text-left text-sm hover:bg-ink-50"
                >
                  <span className="w-12 shrink-0 font-mono text-xs tabular-nums text-ink-500">
                    {shortTimestamp(chapter.time)}
                  </span>
                  <span className="text-brand-700">{chapter.title}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {/* Browser find (ctrl+F) is enough here — no custom search needed. */}
      <div className="max-h-96 overflow-y-auto rounded-lg border border-ink-200 bg-white p-4">
        {transcript ? (
          <div className="space-y-3 text-sm leading-relaxed text-ink-800">
            {transcript.split('\n\n').map((paragraph, index) => {
              const match = /^\[(\d{1,2}:\d{2}(?::\d{2})?)\]\s*(.*)$/s.exec(paragraph)
              return (
                <p key={index}>
                  {match ? (
                    <>
                      <span className="mr-2 font-mono text-xs text-ink-500">[{match[1]}]</span>
                      {match[2]}
                    </>
                  ) : (
                    paragraph
                  )}
                </p>
              )
            })}
          </div>
        ) : (
          <p className="text-sm text-ink-500">The transcript is empty.</p>
        )}
      </div>

      {vttAemPath ? (
        <a
          href={apiUrl(`/intake/${submission.id}/captions`)}
          className="mt-2 inline-block text-sm text-brand-700 hover:underline"
        >
          Download captions (.vtt)
        </a>
      ) : null}
    </section>
  )
}

// ─── Decision ────────────────────────────────────────────────────────────────

function DecisionPanel({ submission }: { submission: VideoSubmissionDetail }): JSX.Element {
  const decide = useApprovalDecision(submission.id)
  const approverEmail = getApproverEmail()

  const { awaiting, mode, legal, marketing } = submission.approvalState
  const [approverType, setApproverType] = useState<ApproverType>(awaiting[0] ?? 'legal')
  const [reason, setReason] = useState('')
  const [rejecting, setRejecting] = useState(false)

  // An approver who has already recorded a decision cannot act again — the
  // buttons go away rather than failing on submit.
  const canAct = awaiting.length > 0

  return (
    <aside className="space-y-4">
      <section className="rounded-lg border border-ink-200 bg-white p-4">
        <h2 className="text-md font-semibold text-ink-900">Approval chain</h2>
        <p className="mt-1 text-xs text-ink-500">
          {mode === 'sequential' ? 'Sequential: legal, then marketing' : 'Parallel: both required'}
        </p>

        <ul className="mt-3 space-y-2 text-sm">
          <ChainStep label="Legal" approval={legal} awaiting={awaiting.includes('legal')} />
          <ChainStep label="Marketing" approval={marketing} awaiting={awaiting.includes('marketing')} />
        </ul>
      </section>

      {canAct ? (
        <section className="rounded-lg border border-ink-200 bg-white p-4">
          <h2 className="text-md font-semibold text-ink-900">Record your decision</h2>
          <p className="mt-1 text-xs text-ink-500">Acting as {approverEmail ?? 'unknown'}</p>

          {awaiting.length > 1 ? (
            <div className="mt-3">
              <label htmlFor="approver-type" className="block text-xs text-ink-600">
                Reviewing as
              </label>
              <select
                id="approver-type"
                value={approverType}
                onChange={(event) => setApproverType(event.target.value as ApproverType)}
                className="mt-1 select-field"
              >
                {awaiting.map((type) => (
                  <option key={type} value={type}>
                    {type === 'legal' ? 'Legal' : 'Marketing'}
                  </option>
                ))}
              </select>
            </div>
          ) : (
            <p className="mt-3 text-sm text-ink-700">
              Reviewing as <strong>{awaiting[0] === 'legal' ? 'Legal' : 'Marketing'}</strong>
            </p>
          )}

          {rejecting ? (
            <div className="mt-3">
              <label htmlFor="reject-reason" className="block text-xs font-medium text-ink-700">
                Reason for rejection <span className="text-critical-600">*</span>
              </label>
              <textarea
                id="reject-reason"
                rows={4}
                required
                value={reason}
                onChange={(event) => setReason(event.target.value)}
                placeholder="This is sent to the submitter, so be specific about what needs to change."
                className="mt-1 w-full rounded-md border border-ink-300 px-2 py-2 text-sm"
              />
            </div>
          ) : null}

          {decide.isError ? (
            <p className="mt-3 rounded-md bg-critical-50 px-3 py-2 text-xs text-critical-800">
              {decide.error instanceof Error ? decide.error.message : 'Could not record the decision'}
            </p>
          ) : null}

          <div className="mt-4 space-y-2">
            {rejecting ? (
              <>
                <button
                  type="button"
                  disabled={decide.isPending || reason.trim().length === 0}
                  onClick={() =>
                    decide.mutate({
                      decision: 'rejected',
                      approverType: awaiting.length > 1 ? approverType : (awaiting[0] ?? 'legal'),
                      reason: reason.trim(),
                    })
                  }
                  className="w-full rounded-md bg-critical-600 px-3 py-2 text-sm font-medium text-white hover:bg-critical-700 disabled:bg-ink-300"
                >
                  {decide.isPending ? 'Recording…' : 'Confirm rejection'}
                </button>
                <button
                  type="button"
                  onClick={() => setRejecting(false)}
                  className="w-full rounded-md px-3 py-2 text-sm text-ink-600 hover:bg-ink-50"
                >
                  Cancel
                </button>
              </>
            ) : (
              <>
                <button
                  type="button"
                  disabled={decide.isPending}
                  data-testid="approve-button"
                  onClick={() =>
                    decide.mutate({
                      decision: 'approved',
                      approverType: awaiting.length > 1 ? approverType : (awaiting[0] ?? 'legal'),
                    })
                  }
                  className="w-full rounded-md bg-verified-600 px-3 py-2 text-sm font-medium text-white hover:bg-verified-700 disabled:bg-ink-300"
                >
                  {decide.isPending ? 'Recording…' : 'Approve'}
                </button>
                <button
                  type="button"
                  onClick={() => setRejecting(true)}
                  className="w-full rounded-md bg-white px-3 py-2 text-sm font-medium text-critical-700 ring-1 ring-critical-300 hover:bg-critical-50"
                >
                  Reject
                </button>
              </>
            )}
          </div>
        </section>
      ) : (
        <section className="rounded-lg border border-ink-200 bg-ink-50 p-4 text-sm text-ink-600">
          {submission.status === 'approved'
            ? 'Fully approved. The asset has been moved into the live DAM — a content author still needs to place it on a page.'
            : submission.status === 'rejected'
              ? 'This submission was rejected. The submitter has been emailed and can resubmit.'
              : 'No decision is required from you right now.'}
        </section>
      )}

      {submission.approvals.length > 0 ? (
        <section className="rounded-lg border border-ink-200 bg-white p-4">
          <h2 className="text-md font-semibold text-ink-900">Decision history</h2>
          <ul className="mt-2 space-y-2 text-xs text-ink-600">
            {submission.approvals.map((approval) => (
              <li key={approval.id}>
                <span className="font-medium capitalize text-ink-900">
                  {approval.approverType} {approval.decision}
                </span>
                <span className="block">{approval.approverEmail}</span>
                <span className="block">{formatDateTime(approval.decidedAt)}</span>
                {approval.reason ? (
                  <span className="mt-1 block italic">“{approval.reason}”</span>
                ) : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </aside>
  )
}

function ChainStep({
  label,
  approval,
  awaiting,
}: {
  label: string
  approval: VideoSubmissionDetail['approvalState']['legal']
  awaiting: boolean
}): JSX.Element {
  return (
    <li className="flex items-center justify-between gap-2">
      <span className="text-ink-700">{label}</span>
      {approval ? (
        <span
          className={
            approval.decision === 'approved'
              ? 'text-xs font-medium text-verified-700'
              : 'text-xs font-medium text-critical-700'
          }
        >
          {approval.decision === 'approved' ? '✓ Approved' : '✕ Rejected'}
        </span>
      ) : awaiting ? (
        <span className="text-xs font-medium text-caution-700">Awaiting</span>
      ) : (
        <span className="text-xs text-ink-500">Not yet</span>
      )}
    </li>
  )
}

function Field({
  label,
  value,
  span,
}: {
  label: string
  value: string
  span?: boolean
}): JSX.Element {
  return (
    <div className={span ? 'sm:col-span-2' : undefined}>
      <dt className="text-label uppercase text-ink-500">{label}</dt>
      <dd className="mt-1 whitespace-pre-wrap text-ink-900">{value}</dd>
    </div>
  )
}
