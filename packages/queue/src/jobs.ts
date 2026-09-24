/** Queue names. Shared so API and worker can never drift apart. */
export const QUEUE_NAMES = {
  audit: 'audit',
  phash: 'phash',
  transcription: 'transcription',
  embedding: 'embedding',
  revalidation: 'revalidation',
} as const

export type QueueName = (typeof QUEUE_NAMES)[keyof typeof QUEUE_NAMES]

/** Job names within each queue. */
export const JOB_NAMES = {
  runAudit: 'run-audit',
  computePhash: 'compute-phash',
  transcribe: 'transcribe',
  buildEmbeddings: 'build-embeddings',
  revalidateAssets: 'revalidate-assets',
} as const

// ─── Payloads ────────────────────────────────────────────────────────────────

export interface AuditJobPayload {
  /** AuditJob.id — the worker reads URL rows from the DB, not from the payload. */
  jobId: string
}

export interface PhashJobPayload {
  /** Process a specific asset, or omit to sweep everything missing a pHash. */
  assetId?: string
}

export interface EmbeddingJobPayload {
  /** Which corpus to embed. Omit to sweep both. */
  target?: 'testimonials' | 'assets'
}

export interface TranscriptionJobPayload {
  submissionId: string
  /** Path in AEM staging — the worker builds the asset URL from it. */
  aemStagingPath: string
  filename: string
}

export type JobPayloadMap = {
  [QUEUE_NAMES.audit]: AuditJobPayload
  [QUEUE_NAMES.phash]: PhashJobPayload
  [QUEUE_NAMES.transcription]: TranscriptionJobPayload
  [QUEUE_NAMES.embedding]: EmbeddingJobPayload
}

/**
 * Re-check that indexed assets are still served.
 *
 * Empty payload: the worker reads which rows are due from the DB rather than
 * carrying a list, so a schedule set up weeks ago cannot be operating on a
 * stale idea of what exists.
 */
export interface RevalidationJobPayload {
  /** Re-check everything, not just rows past the staleness window. */
  force?: boolean
}
