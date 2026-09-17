// `Prisma` is imported as a value, not a type — `Prisma.JsonNull` is a runtime
// sentinel used to null out a Json column.
import { Prisma } from '@prisma/client'
import type {
  ApprovalDecision,
  ApproverType,
  SubmissionStatus,
  TranscriptStatus,
  VideoApproval,
  VideoSubmission,
} from '@prisma/client'
import { prisma } from '../client.js'

export interface CreateSubmissionInput {
  title: string
  description: string
  program: string
  campaign: string
  usageRights: string
  rightsExpiryDate: Date
  submitterName: string
  submitterEmail: string
  submitterOrg: string
  notes: string | null
  filename: string
  fileSize: number | null
  mimeType: string
  legalAgreedAt: Date
  legalAgreedIp: string | null
  legalDocFilename: string | null
  legalDocStoredPath: string | null
  parentSubmissionId: string | null
}

export async function create(input: CreateSubmissionInput): Promise<VideoSubmission> {
  return prisma.videoSubmission.create({
    data: {
      ...input,
      legalAgreed: true,
      status: 'draft',
      transcriptStatus: 'pending',
    },
  })
}

export async function findById(id: string): Promise<VideoSubmission | null> {
  return prisma.videoSubmission.findUnique({ where: { id } })
}

export async function findByIdWithApprovals(
  id: string,
): Promise<(VideoSubmission & { approvals: VideoApproval[] }) | null> {
  return prisma.videoSubmission.findUnique({
    where: { id },
    include: { approvals: { orderBy: { decidedAt: 'asc' } } },
  })
}

export interface SubmissionListParams {
  status?: SubmissionStatus
  program?: string
  offset: number
  limit: number
}

export async function list(
  params: SubmissionListParams,
): Promise<{ submissions: Array<VideoSubmission & { approvals: VideoApproval[] }>; total: number }> {
  const where: Prisma.VideoSubmissionWhereInput = {}
  if (params.status) where.status = params.status
  if (params.program) where.program = params.program

  const [submissions, total] = await prisma.$transaction([
    prisma.videoSubmission.findMany({
      where,
      include: { approvals: { orderBy: { decidedAt: 'asc' } } },
      orderBy: { submittedAt: 'desc' },
      skip: params.offset,
      take: params.limit,
    }),
    prisma.videoSubmission.count({ where }),
  ])

  return { submissions, total }
}

export async function setAemPaths(
  id: string,
  paths: { aemStagingPath?: string; aemFinalPath?: string },
): Promise<VideoSubmission> {
  return prisma.videoSubmission.update({ where: { id }, data: paths })
}

export async function setStatus(
  id: string,
  status: SubmissionStatus,
  rejectionReason?: string | null,
): Promise<VideoSubmission> {
  return prisma.videoSubmission.update({
    where: { id },
    data: { status, ...(rejectionReason !== undefined ? { rejectionReason } : {}) },
  })
}

export async function setFileSize(id: string, fileSize: number): Promise<void> {
  await prisma.videoSubmission.update({ where: { id }, data: { fileSize } })
}

// ─── Transcription ───────────────────────────────────────────────────────────

export async function setTranscriptStatus(
  id: string,
  transcriptStatus: TranscriptStatus,
): Promise<void> {
  await prisma.videoSubmission.update({ where: { id }, data: { transcriptStatus } })
}

export interface TranscriptResult {
  transcript: string
  transcriptDurationSeconds: number
  chapterMarkers: Array<{ time: string; title: string }> | null
  vttAemPath: string | null
}

export async function setTranscript(id: string, result: TranscriptResult): Promise<void> {
  await prisma.videoSubmission.update({
    where: { id },
    data: {
      transcript: result.transcript,
      transcriptStatus: 'complete',
      transcriptDurationSeconds: result.transcriptDurationSeconds,
      chapterMarkers: result.chapterMarkers ?? Prisma.JsonNull,
      vttAemPath: result.vttAemPath,
    },
  })
}

// ─── Approvals ───────────────────────────────────────────────────────────────

export interface RecordApprovalInput {
  submissionId: string
  approverType: ApproverType
  approverEmail: string
  decision: ApprovalDecision
  reason: string | null
}

/**
 * Records one approver's decision. The unique constraint on
 * (submissionId, approverType) is what actually enforces "an approver can only
 * act once" — the service checks first for a friendly error, but the constraint
 * is the guarantee under concurrent requests.
 */
export async function recordApproval(input: RecordApprovalInput): Promise<VideoApproval> {
  return prisma.videoApproval.create({
    data: {
      submissionId: input.submissionId,
      approverType: input.approverType,
      approverEmail: input.approverEmail,
      decision: input.decision,
      reason: input.reason,
    },
  })
}

export async function findApprovals(submissionId: string): Promise<VideoApproval[]> {
  return prisma.videoApproval.findMany({
    where: { submissionId },
    orderBy: { decidedAt: 'asc' },
  })
}

export async function countByStatus(status: SubmissionStatus): Promise<number> {
  return prisma.videoSubmission.count({ where: { status } })
}

/** Submissions whose usage rights expire within `days` — feeds the expiry alert. */
export async function findExpiringRights(days: number): Promise<VideoSubmission[]> {
  const cutoff = new Date(Date.now() + days * 24 * 60 * 60 * 1000)
  return prisma.videoSubmission.findMany({
    where: { status: 'approved', rightsExpiryDate: { lte: cutoff, gte: new Date() } },
    orderBy: { rightsExpiryDate: 'asc' },
  })
}
