import { randomUUID } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { mkdir, unlink } from 'node:fs/promises'
import path from 'node:path'
import { pipeline } from 'node:stream/promises'
// Value import — `Readable.from` is used when persisting the legal PDF.
import { Readable } from 'node:stream'
import { videoSubmissionRepo } from '@capella/db'
import { enqueueTranscription } from '@capella/queue'
import {
  AppError,
  ERROR_CODES,
  type ApprovalDecision,
  type ApproverType,
  type ChapterMarker,
  type PublicVideoSubmission,
  type SubmissionApprovalState,
  type VideoSubmissionDetail,
} from '@capella/types'
import { config } from '../config.js'
import { logger } from '../lib/logger.js'
import * as aemUploadService from './aemUploadService.js'
import * as notificationService from './notificationService.js'
import {
  awaitingApprovers,
  canAct,
  deriveStatus,
  initialNotifyList,
  isFullyApproved,
  nextApproverAfter,
  toChainState,
} from './approvalChain.js'

export const ALLOWED_VIDEO_TYPES = ['video/mp4', 'video/quicktime', 'video/webm'] as const

export interface SubmissionMetadata {
  title: string
  description: string
  program: string
  campaign: string
  usageRights: string
  rightsExpiryDate: string
  submitterName: string
  submitterEmail: string
  submitterOrg: string
  notes?: string
  legalAgreed: boolean
  legalAgreedAt?: string
  parentSubmissionId?: string
}

export interface SubmitVideoInput {
  metadata: SubmissionMetadata
  filename: string
  mimeType: string
  /** The inbound file stream. Piped straight to AEM — never buffered. */
  videoStream: Readable
  contentLength?: number
  /** Optional supplementary signed PDF. Stored locally, never sent to AEM. */
  legalDoc?: { filename: string; buffer: Buffer }
  submitterIp: string | null
}

/**
 * Create a submission: validate, stream the video into AEM staging, write
 * metadata, enqueue transcription, notify approvers.
 *
 * Order matters. The legal agreement is checked before a single byte is read,
 * so an unagreed submission never touches AEM.
 */
export async function submitVideo(input: SubmitVideoInput): Promise<PublicVideoSubmission> {
  // ── 1. Legal gate — server-side enforcement, not just the disabled button ──
  if (input.metadata.legalAgreed !== true) {
    throw new AppError(
      ERROR_CODES.LEGAL_AGREEMENT_REQUIRED,
      'You must agree to the terms before submitting',
    )
  }

  if (!config.aemIntakeEnabled) {
    throw new AppError(
      ERROR_CODES.AEM_INTAKE_NOT_CONFIGURED,
      'Video intake is not yet available — the AEM intake service account has not been provisioned.',
    )
  }

  if (!(ALLOWED_VIDEO_TYPES as readonly string[]).includes(input.mimeType)) {
    throw new AppError(
      ERROR_CODES.UNSUPPORTED_MEDIA_TYPE,
      `Unsupported video format. Accepted types: ${ALLOWED_VIDEO_TYPES.join(', ')}`,
    )
  }

  const rightsExpiryDate = new Date(input.metadata.rightsExpiryDate)
  if (Number.isNaN(rightsExpiryDate.getTime())) {
    throw new AppError(ERROR_CODES.VALIDATION_FAILED, 'Usage expiry date is not a valid date')
  }

  // ── 2. Persist the legal PDF before anything else can fail mid-upload ──────
  let legalDocStoredPath: string | null = null
  if (input.legalDoc) {
    legalDocStoredPath = await storeLegalDoc(input.legalDoc.filename, input.legalDoc.buffer)
  }

  // ── 3. Create the record so we have an id for the staged filename ─────────
  const submission = await videoSubmissionRepo.create({
    title: input.metadata.title,
    description: input.metadata.description,
    program: input.metadata.program,
    campaign: input.metadata.campaign,
    usageRights: input.metadata.usageRights,
    rightsExpiryDate,
    submitterName: input.metadata.submitterName,
    submitterEmail: input.metadata.submitterEmail,
    submitterOrg: input.metadata.submitterOrg,
    notes: input.metadata.notes ?? null,
    filename: aemUploadService.sanitizeFilename(input.filename),
    fileSize: input.contentLength ?? null,
    mimeType: input.mimeType,
    // Trusting a client clock for a legal audit trail would be a mistake; the
    // client value is only a hint, the server timestamp is what we record.
    legalAgreedAt: new Date(),
    legalAgreedIp: input.submitterIp,
    legalDocFilename: input.legalDoc?.filename ?? null,
    legalDocStoredPath,
    parentSubmissionId: input.metadata.parentSubmissionId ?? null,
  })

  const stagedFilename = aemUploadService.stagingFilenameFor(submission.id, input.filename)
  const stagingPath = aemUploadService.stagingPathFor(stagedFilename)

  // ── 4. Stream to AEM ──────────────────────────────────────────────────────
  try {
    await aemUploadService.uploadVideo(
      stagingPath,
      input.videoStream,
      input.mimeType,
      input.contentLength,
    )
  } catch (error) {
    // Stays `draft`, not `rejected` — nobody reviewed it. A draft with no
    // staging path is an incomplete submission, and keeping it out of the
    // rejected bucket stops failed uploads skewing the approval metrics.
    await videoSubmissionRepo.setStatus(submission.id, 'draft', 'Upload to AEM did not complete')
    if (legalDocStoredPath) await unlink(legalDocStoredPath).catch(() => undefined)
    throw error
  }

  await videoSubmissionRepo.setAemPaths(submission.id, { aemStagingPath: stagingPath })

  // ── 5. Metadata + tags ────────────────────────────────────────────────────
  try {
    await aemUploadService.updateMetadata(stagingPath, {
      'dam:status': 'pending-review',
      'dc:title': input.metadata.title,
      'dc:description': input.metadata.description,
      'cq:tags': [`programs/${input.metadata.program}`, `campaigns/${input.metadata.campaign}`],
      'dam:submittedBy': input.metadata.submitterEmail,
      'dam:usageRights': input.metadata.usageRights,
      'dam:rightsExpiry': rightsExpiryDate.toISOString(),
      'dam:legalAgreed': 'true',
      'dam:legalAgreedAt': submission.legalAgreedAt.toISOString(),
      'dam:legalDocUploaded': input.legalDoc ? 'true' : 'false',
      'dam:intakeId': submission.id,
    })
  } catch (error) {
    // The binary is safely staged; missing tags are recoverable by hand and
    // should not cost the submitter their upload.
    logger.error({ err: error, submissionId: submission.id }, 'Metadata write failed after upload')
  }

  const pending = await videoSubmissionRepo.setStatus(submission.id, 'pending_review')

  // ── 6. Transcription (never blocks the approval workflow) ─────────────────
  if (config.transcriptionEnabled) {
    try {
      await enqueueTranscription(config.redisUrl, {
        submissionId: submission.id,
        aemStagingPath: stagingPath,
        filename: stagedFilename,
      })
    } catch (error) {
      logger.error({ err: error, submissionId: submission.id }, 'Could not enqueue transcription')
      await videoSubmissionRepo.setTranscriptStatus(submission.id, 'failed')
    }
  } else {
    await videoSubmissionRepo.setTranscriptStatus(submission.id, 'failed')
  }

  // ── 7. Notifications ──────────────────────────────────────────────────────
  await notificationService.notifySubmitterReceived(pending)
  for (const approverType of initialNotifyList(config.approvalChainMode)) {
    await notificationService.notifyApprover(approverType, pending)
  }

  return toPublicView(pending)
}

/** Write the signed PDF outside the web root. Never pushed to AEM. */
async function storeLegalDoc(filename: string, buffer: Buffer): Promise<string> {
  if (buffer.byteLength > config.maxLegalDocBytes) {
    throw new AppError(ERROR_CODES.FILE_TOO_LARGE, 'Signed document must be 10MB or smaller')
  }

  // Magic bytes, not the declared content type — a client can claim anything.
  if (buffer.subarray(0, 5).toString('latin1') !== '%PDF-') {
    throw new AppError(ERROR_CODES.UNSUPPORTED_MEDIA_TYPE, 'Signed document must be a PDF')
  }

  await mkdir(config.legalDocStoragePath, { recursive: true })

  // Generated name: the submitter's filename never becomes a path on our disk.
  const safeName = `${randomUUID()}.pdf`
  const storedPath = path.join(config.legalDocStoragePath, safeName)

  await pipeline(Readable.from(buffer), createWriteStream(storedPath))
  logger.info({ originalFilename: filename, storedPath }, 'Legal document stored')

  return storedPath
}

// ─── Approvals ───────────────────────────────────────────────────────────────

export interface DecisionInput {
  submissionId: string
  approverType: ApproverType
  approverEmail: string
  decision: ApprovalDecision
  reason: string | null
}

/**
 * Record one approver's decision and advance the chain.
 *
 * On full approval the asset moves from staging into the live DAM. Nothing is
 * published — a content author still places it on a page (PRD §9).
 */
export async function recordDecision(input: DecisionInput): Promise<VideoSubmissionDetail> {
  const submission = await videoSubmissionRepo.findByIdWithApprovals(input.submissionId)
  if (!submission) {
    throw new AppError(ERROR_CODES.SUBMISSION_NOT_FOUND, 'No submission with that id')
  }

  if (input.decision === 'rejected' && !input.reason?.trim()) {
    throw new AppError(ERROR_CODES.VALIDATION_FAILED, 'A reason is required when rejecting')
  }

  const state = toChainState(submission.approvals)

  if (state[input.approverType] !== null) {
    throw new AppError(
      ERROR_CODES.ALREADY_DECIDED,
      `${input.approverType} has already recorded a decision on this submission`,
    )
  }

  if (!canAct(config.approvalChainMode, state, input.approverType)) {
    throw new AppError(
      ERROR_CODES.INVALID_STATE_TRANSITION,
      config.approvalChainMode === 'sequential'
        ? `In sequential mode this submission is not yet at the ${input.approverType} step`
        : 'This submission is already resolved',
    )
  }

  const approval = await videoSubmissionRepo.recordApproval({
    submissionId: input.submissionId,
    approverType: input.approverType,
    approverEmail: input.approverEmail,
    decision: input.decision,
    reason: input.reason,
  })

  const nextState = toChainState([...submission.approvals, approval])
  const nextStatus = deriveStatus(nextState)

  if (nextStatus === 'rejected') {
    await videoSubmissionRepo.setStatus(input.submissionId, 'rejected', input.reason)

    // The asset stays in staging, flagged — it is never deleted (PRD §7).
    if (submission.aemStagingPath) {
      await aemUploadService
        .updateMetadata(submission.aemStagingPath, { 'dam:status': 'rejected' })
        .catch((error: unknown) =>
          logger.error({ err: error, submissionId: submission.id }, 'Could not flag rejected asset'),
        )
    }

    await notificationService.notifySubmitterRejected(submission, input.reason ?? 'No reason given')
    return getSubmissionDetail(input.submissionId)
  }

  if (isFullyApproved(nextState)) {
    await promoteToLiveDam(submission.id)
  } else {
    await videoSubmissionRepo.setStatus(input.submissionId, nextStatus)

    const next = nextApproverAfter(config.approvalChainMode, nextState, input.approverType)
    if (next) await notificationService.notifyNextApprover(next, submission)
  }

  return getSubmissionDetail(input.submissionId)
}

/**
 * Move the staged asset into `AEM_INTAKE_LIVE_ROOT/{program}/videos/`.
 *
 * If the move fails the submission stays at its partial-approval status rather
 * than claiming `approved` — an approved record pointing at a staging path
 * would be a lie, and retrying is safe.
 */
async function promoteToLiveDam(submissionId: string): Promise<void> {
  const submission = await videoSubmissionRepo.findById(submissionId)
  if (!submission?.aemStagingPath) {
    throw new AppError(ERROR_CODES.AEM_UPLOAD_FAILED, 'Submission has no staged asset to promote')
  }

  const stagedFilename = submission.aemStagingPath.split('/').pop() ?? submission.filename
  const finalPath = aemUploadService.livePathFor(submission.program, stagedFilename)

  await aemUploadService.moveAsset(submission.aemStagingPath, finalPath)
  await aemUploadService.updateMetadata(finalPath, { 'dam:status': 'approved' })

  await videoSubmissionRepo.setAemPaths(submissionId, { aemFinalPath: finalPath })
  const approved = await videoSubmissionRepo.setStatus(submissionId, 'approved')

  await notificationService.notifySubmitterApproved(approved)
}

// ─── Reads ───────────────────────────────────────────────────────────────────

export async function getSubmissionDetail(id: string): Promise<VideoSubmissionDetail> {
  const submission = await videoSubmissionRepo.findByIdWithApprovals(id)
  if (!submission) {
    throw new AppError(ERROR_CODES.SUBMISSION_NOT_FOUND, 'No submission with that id')
  }

  const state = toChainState(submission.approvals)

  const approvalState: SubmissionApprovalState = {
    mode: config.approvalChainMode,
    legal: state.legal ? serializeApproval(state.legal) : null,
    marketing: state.marketing ? serializeApproval(state.marketing) : null,
    awaiting: awaitingApprovers(config.approvalChainMode, state),
  }

  return {
    ...serializeSubmission(submission),
    approvals: submission.approvals.map(serializeApproval),
    approvalState,
    hasLegalDoc: submission.legalDocStoredPath !== null,
    daysWaiting: Math.floor(
      (Date.now() - submission.submittedAt.getTime()) / (24 * 60 * 60 * 1000),
    ),
  }
}

export async function listSubmissions(params: {
  status?: VideoSubmissionDetail['status']
  program?: string
  offset: number
  limit: number
}): Promise<{ submissions: VideoSubmissionDetail[]; total: number }> {
  const { submissions, total } = await videoSubmissionRepo.list(params)

  return {
    submissions: submissions.map((submission) => {
      const state = toChainState(submission.approvals)
      return {
        ...serializeSubmission(submission),
        approvals: submission.approvals.map(serializeApproval),
        approvalState: {
          mode: config.approvalChainMode,
          legal: state.legal ? serializeApproval(state.legal) : null,
          marketing: state.marketing ? serializeApproval(state.marketing) : null,
          awaiting: awaitingApprovers(config.approvalChainMode, state),
        },
        hasLegalDoc: submission.legalDocStoredPath !== null,
        daysWaiting: Math.floor(
          (Date.now() - submission.submittedAt.getTime()) / (24 * 60 * 60 * 1000),
        ),
      }
    }),
    total,
  }
}

/** Public status view — deliberately omits AEM paths, transcript and internal ids. */
export async function getPublicSubmission(id: string): Promise<PublicVideoSubmission> {
  const submission = await videoSubmissionRepo.findById(id)
  if (!submission) {
    throw new AppError(ERROR_CODES.SUBMISSION_NOT_FOUND, 'No submission with that id')
  }
  return toPublicView(submission)
}

/** Data used to pre-fill the resubmission form. Only a rejected submission qualifies. */
export async function getResubmissionTemplate(id: string): Promise<{
  parentSubmissionId: string
  rejectionReason: string | null
  metadata: Omit<SubmissionMetadata, 'legalAgreed' | 'legalAgreedAt' | 'parentSubmissionId'>
}> {
  const submission = await videoSubmissionRepo.findById(id)
  if (!submission) {
    throw new AppError(ERROR_CODES.SUBMISSION_NOT_FOUND, 'No submission with that id')
  }

  if (submission.status !== 'rejected') {
    throw new AppError(
      ERROR_CODES.NOT_REJECTED,
      'Only a rejected submission can be resubmitted',
    )
  }

  return {
    parentSubmissionId: submission.id,
    rejectionReason: submission.rejectionReason,
    metadata: {
      title: submission.title,
      description: submission.description,
      program: submission.program,
      campaign: submission.campaign,
      usageRights: submission.usageRights,
      rightsExpiryDate: submission.rightsExpiryDate.toISOString().slice(0, 10),
      submitterName: submission.submitterName,
      submitterEmail: submission.submitterEmail,
      submitterOrg: submission.submitterOrg,
      notes: submission.notes ?? undefined,
    },
  }
}

export async function getLegalDocPath(id: string): Promise<{ storedPath: string; filename: string }> {
  const submission = await videoSubmissionRepo.findById(id)
  if (!submission) {
    throw new AppError(ERROR_CODES.SUBMISSION_NOT_FOUND, 'No submission with that id')
  }
  if (!submission.legalDocStoredPath) {
    throw new AppError(ERROR_CODES.LEGAL_DOC_NOT_FOUND, 'No supplementary document was uploaded')
  }
  return {
    storedPath: submission.legalDocStoredPath,
    filename: submission.legalDocFilename ?? 'signed-agreement.pdf',
  }
}

export async function getStats(): Promise<{ pending: number; approved: number; rejected: number }> {
  const [pending, approved, rejected] = await Promise.all([
    videoSubmissionRepo.countByStatus('pending_review'),
    videoSubmissionRepo.countByStatus('approved'),
    videoSubmissionRepo.countByStatus('rejected'),
  ])
  return { pending, approved, rejected }
}

// ─── Serialization ───────────────────────────────────────────────────────────

type SubmissionRecord = Awaited<ReturnType<typeof videoSubmissionRepo.findById>>
type ApprovalRecord = Awaited<ReturnType<typeof videoSubmissionRepo.findApprovals>>[number]

function serializeSubmission(submission: NonNullable<SubmissionRecord>) {
  return {
    id: submission.id,
    title: submission.title,
    description: submission.description,
    program: submission.program,
    campaign: submission.campaign,
    usageRights: submission.usageRights,
    rightsExpiryDate: submission.rightsExpiryDate.toISOString(),
    submitterName: submission.submitterName,
    submitterEmail: submission.submitterEmail,
    submitterOrg: submission.submitterOrg,
    notes: submission.notes,
    filename: submission.filename,
    fileSize: submission.fileSize,
    mimeType: submission.mimeType,
    legalAgreed: submission.legalAgreed,
    legalAgreedAt: submission.legalAgreedAt.toISOString(),
    legalAgreedIp: submission.legalAgreedIp,
    legalDocFilename: submission.legalDocFilename,
    transcript: submission.transcript,
    transcriptStatus: submission.transcriptStatus,
    transcriptDurationSeconds: submission.transcriptDurationSeconds,
    chapterMarkers: (submission.chapterMarkers as ChapterMarker[] | null) ?? null,
    vttAemPath: submission.vttAemPath,
    aemStagingPath: submission.aemStagingPath,
    aemFinalPath: submission.aemFinalPath,
    status: submission.status,
    rejectionReason: submission.rejectionReason,
    parentSubmissionId: submission.parentSubmissionId,
    submittedAt: submission.submittedAt.toISOString(),
    updatedAt: submission.updatedAt.toISOString(),
  }
}

function serializeApproval(approval: ApprovalRecord) {
  return {
    id: approval.id,
    submissionId: approval.submissionId,
    approverType: approval.approverType,
    approverEmail: approval.approverEmail,
    decision: approval.decision,
    reason: approval.reason,
    decidedAt: approval.decidedAt.toISOString(),
  }
}

function toPublicView(submission: NonNullable<SubmissionRecord>): PublicVideoSubmission {
  return {
    id: submission.id,
    title: submission.title,
    status: submission.status,
    submittedAt: submission.submittedAt.toISOString(),
    rejectionReason: submission.rejectionReason,
    submitterEmail: submission.submitterEmail,
  }
}
