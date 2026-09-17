/**
 * Domain types shared by API, worker, scraper and UI.
 * These mirror the Prisma models but are transport-safe (dates as ISO strings).
 */

// ─── Enums (kept as string unions so the UI can import without Prisma) ──────

export const ASSET_TYPES = ['image', 'video', 'document', 'audio', 'other'] as const
export type AssetType = (typeof ASSET_TYPES)[number]

export const AUDIT_JOB_STATUSES = ['queued', 'running', 'complete', 'failed', 'cancelled'] as const
export type AuditJobStatus = (typeof AUDIT_JOB_STATUSES)[number]

export const AUDIT_INPUT_TYPES = ['paste', 'csv_upload', 'sitemap'] as const
export type AuditInputType = (typeof AUDIT_INPUT_TYPES)[number]

export const AUDIT_URL_STATUSES = ['pending', 'done', 'failed'] as const
export type AuditUrlStatus = (typeof AUDIT_URL_STATUSES)[number]

export const TESTIMONIAL_SOURCE_TYPES = ['structured_component', 'hardcoded_text'] as const
export type TestimonialSourceType = (typeof TESTIMONIAL_SOURCE_TYPES)[number]

export const SUBMISSION_STATUSES = [
  'draft',
  'pending_review',
  'legal_approved',
  'marketing_approved',
  'approved',
  'rejected',
  'resubmitted',
] as const
export type SubmissionStatus = (typeof SUBMISSION_STATUSES)[number]

export const APPROVER_TYPES = ['legal', 'marketing'] as const
export type ApproverType = (typeof APPROVER_TYPES)[number]

export const APPROVAL_DECISIONS = ['approved', 'rejected'] as const
export type ApprovalDecision = (typeof APPROVAL_DECISIONS)[number]

export const TRANSCRIPT_STATUSES = ['pending', 'processing', 'complete', 'failed'] as const
export type TranscriptStatus = (typeof TRANSCRIPT_STATUSES)[number]

export const SOCIAL_PLATFORMS = ['meta', 'tiktok', 'youtube', 'linkedin'] as const
export type SocialPlatform = (typeof SOCIAL_PLATFORMS)[number]

/** Live status derived from scraped signals (Phase 1) or cq:lastReplicated (Phase 2). */
export type LiveStatus = 'published' | 'draft' | 'unknown'

// ─── Core models ────────────────────────────────────────────────────────────

export interface Asset {
  id: string
  aemPath: string
  filename: string
  assetType: AssetType
  width: number | null
  height: number | null
  fileSize: number | null
  tags: string[]
  lastSeenAt: string | null
  phash: string | null
  isIndexed: boolean
  deletedAt: string | null
  createdAt: string
  updatedAt: string
}

export interface Page {
  id: string
  url: string
  title: string | null
  isPublished: boolean | null
  lastReplicatedAt: string | null
  lastCrawledAt: string | null
  deletedAt: string | null
}

export interface AssetPageReference {
  id: string
  assetId: string
  pageId: string
  discoveredAt: string
}

export interface Testimonial {
  id: string
  quoteText: string
  quoteFingerprint: string
  studentName: string | null
  program: string | null
  degreeLevel: string | null
  sourceType: TestimonialSourceType
  rawHtml: string | null
  aemComponentPath: string | null
  needsReview: boolean
  firstSeenAt: string
  lastSeenAt: string
  isActive: boolean
  deletedAt: string | null
}

export interface TestimonialPageReference {
  id: string
  testimonialId: string
  pageId: string
  positionOnPage: number | null
  discoveredAt: string
}

export interface AuditJob {
  id: string
  name: string
  status: AuditJobStatus
  inputType: AuditInputType
  totalUrls: number
  completedUrls: number
  failedUrls: number
  createdAt: string
  startedAt: string | null
  completedAt: string | null
  createdBy: string | null
  errorMessage: string | null
}

export interface AuditJobUrl {
  id: string
  jobId: string
  url: string
  status: AuditUrlStatus
  processedAt: string | null
  error: string | null
}

export interface ChapterMarker {
  /** `HH:MM:SS` */
  time: string
  title: string
}

export interface VideoSubmission {
  id: string
  title: string
  description: string
  program: string
  campaign: string
  usageRights: string
  rightsExpiryDate: string
  submitterName: string
  submitterEmail: string
  submitterOrg: string
  notes: string | null
  filename: string
  fileSize: number | null
  mimeType: string
  legalAgreed: boolean
  legalAgreedAt: string
  legalAgreedIp: string | null
  legalDocFilename: string | null
  transcript: string | null
  transcriptStatus: TranscriptStatus
  transcriptDurationSeconds: number | null
  chapterMarkers: ChapterMarker[] | null
  vttAemPath: string | null
  aemStagingPath: string | null
  aemFinalPath: string | null
  status: SubmissionStatus
  rejectionReason: string | null
  parentSubmissionId: string | null
  submittedAt: string
  updatedAt: string
}

export interface VideoApproval {
  id: string
  submissionId: string
  approverType: ApproverType
  approverEmail: string
  decision: ApprovalDecision
  reason: string | null
  decidedAt: string
}

export interface SocialLink {
  id: string
  assetId: string
  platform: SocialPlatform
  postUrl: string
  postId: string | null
  metricsJson: Record<string, unknown> | null
  lastFetchedAt: string | null
}

// ─── View models returned by the API ────────────────────────────────────────

/** A page an asset or testimonial appears on, with its live status. */
export interface PageAppearance {
  pageId: string
  url: string
  title: string | null
  liveStatus: LiveStatus
  lastCrawledAt: string | null
  discoveredAt: string
}

export interface AssetWithReferences extends Asset {
  /** Public URL: AEM_PUBLIC_HOST + aemPath. Built at render time, never stored. */
  publicUrl: string
  referenceCount: number
  pages: PageAppearance[]
}

export interface TestimonialWithReferences extends Testimonial {
  referenceCount: number
  /** Whole days since lastSeenAt. >90 amber, >180 red — informational only. */
  daysSinceLastSeen: number
  pages: PageAppearance[]
}

export interface AuditJobStatusResponse {
  jobId: string
  status: AuditJobStatus
  totalUrls: number
  completedUrls: number
  failedUrls: number
  percentComplete: number
  estimatedMinutesRemaining: number | null
  startedAt: string | null
  completedAt: string | null
  errorMessage: string | null
}

export interface AuditResultRow {
  url: string
  pageTitle: string | null
  liveStatus: LiveStatus
  urlStatus: AuditUrlStatus
  assetCount: number
  testimonialCount: number
  processedAt: string | null
  error: string | null
}

export interface DuplicateGroup {
  /** Representative pHash for the group. */
  phash: string
  /** Max Hamming distance found within the group. */
  maxDistance: number
  assets: Array<Pick<Asset, 'id' | 'aemPath' | 'filename' | 'fileSize' | 'width' | 'height'>>
}

export interface ProgramCoverage {
  program: string
  liveTestimonialCount: number
  /** red = 0, amber = 1–2, green = 3+ */
  severity: 'red' | 'amber' | 'green'
}

export interface SubmissionApprovalState {
  mode: 'sequential' | 'parallel'
  legal: VideoApproval | null
  marketing: VideoApproval | null
  /** Which approver types may still act right now. */
  awaiting: ApproverType[]
}

export interface VideoSubmissionDetail extends VideoSubmission {
  approvals: VideoApproval[]
  approvalState: SubmissionApprovalState
  hasLegalDoc: boolean
  daysWaiting: number
}

/** Public view of a submission — never exposes AEM paths or internal ids. */
export type PublicVideoSubmission = Pick<
  VideoSubmission,
  'id' | 'title' | 'status' | 'submittedAt' | 'rejectionReason' | 'submitterEmail'
>
