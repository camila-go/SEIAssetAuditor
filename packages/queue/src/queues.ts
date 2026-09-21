import { Queue, type JobsOptions } from 'bullmq'
import { getConnection } from './connection.js'
import {
  JOB_NAMES,
  QUEUE_NAMES,
  type AuditJobPayload,
  type PhashJobPayload,
  type TranscriptionJobPayload,
  type EmbeddingJobPayload,
} from './jobs.js'

/**
 * Audit jobs are long-running and resumable: the worker claims `pending`
 * AuditJobUrl rows from the DB, so a retry after a crash naturally picks up
 * where it left off rather than reprocessing the whole job.
 */
const AUDIT_JOB_OPTIONS: JobsOptions = {
  attempts: 3,
  backoff: { type: 'exponential', delay: 30_000 },
  removeOnComplete: { age: 7 * 24 * 60 * 60, count: 500 },
  removeOnFail: false,
}

/**
 * The pHash sweep coalesces, for the same reason the embedding sweep does.
 *
 * It is now enqueued automatically whenever an audit completes, so several
 * audits finishing close together would otherwise stack several sweeps. They
 * would all claim the same `findNeedingPhash` rows and download the same images
 * from capella.edu concurrently — wasteful, and impolite to a site we do not
 * own.
 *
 * `removeOnComplete: true` is load-bearing with a fixed id, not tidiness:
 * BullMQ rejects a duplicate id against a *completed* job too, so retaining
 * them would make the id permanently taken and silently no-op every later
 * sweep. That exact bug already cost a debugging session on the embedding
 * queue.
 */
const PHASH_JOB_OPTIONS: JobsOptions = {
  attempts: 2,
  backoff: { type: 'fixed', delay: 10_000 },
  removeOnComplete: true,
  removeOnFail: { age: 7 * 24 * 60 * 60 },
}

/** Whisper is billed per minute, so retries are capped and spaced out. */
const TRANSCRIPTION_JOB_OPTIONS: JobsOptions = {
  attempts: 3,
  backoff: { type: 'exponential', delay: 60_000 },
  removeOnComplete: { age: 7 * 24 * 60 * 60 },
  removeOnFail: false,
}

/**
 * Embedding is a background sweep; a single retry is plenty.
 *
 * `removeOnComplete: true` is load-bearing, not tidiness. This queue uses a
 * fixed job id per target so that pressing "build the index" twice while one is
 * already running coalesces into a single sweep. BullMQ enforces that by
 * rejecting a duplicate id — including against a *completed* job still in the
 * set. Retaining completed jobs therefore made the id permanently taken, and
 * every later sweep silently did nothing. Dropping them on completion keeps the
 * coalescing while the job is pending or active, which is the actual intent.
 */
const EMBEDDING_JOB_OPTIONS: JobsOptions = {
  attempts: 2,
  backoff: { type: 'fixed', delay: 15_000 },
  removeOnComplete: true,
  removeOnFail: { age: 7 * 24 * 60 * 60, count: 20 },
}

interface Queues {
  audit: Queue<AuditJobPayload>
  phash: Queue<PhashJobPayload>
  transcription: Queue<TranscriptionJobPayload>
  embedding: Queue<EmbeddingJobPayload>
}

let queues: Queues | null = null

export function getQueues(redisUrl: string): Queues {
  if (queues) return queues

  const connection = getConnection(redisUrl)

  queues = {
    audit: new Queue<AuditJobPayload>(QUEUE_NAMES.audit, { connection }),
    phash: new Queue<PhashJobPayload>(QUEUE_NAMES.phash, { connection }),
    transcription: new Queue<TranscriptionJobPayload>(QUEUE_NAMES.transcription, { connection }),
    embedding: new Queue<EmbeddingJobPayload>(QUEUE_NAMES.embedding, { connection }),
  }

  return queues
}

/**
 * BullMQ rejects a custom job id containing `:` — it uses the colon as its own
 * Redis key separator. Hyphens throughout.
 */
const auditJobId = (jobId: string): string => `audit-${jobId}`
const transcriptionJobId = (submissionId: string): string => `transcribe-${submissionId}`

export async function enqueueAudit(redisUrl: string, payload: AuditJobPayload): Promise<void> {
  // jobId pinned to the AuditJob id so a double POST can't run the same audit twice.
  await getQueues(redisUrl).audit.add(JOB_NAMES.runAudit, payload, {
    ...AUDIT_JOB_OPTIONS,
    jobId: auditJobId(payload.jobId),
  })
}

export async function enqueuePhash(redisUrl: string, payload: PhashJobPayload): Promise<void> {
  await getQueues(redisUrl).phash.add(JOB_NAMES.computePhash, payload, {
    ...PHASH_JOB_OPTIONS,
    // One sweep at a time — see PHASH_JOB_OPTIONS. A sweep already queued will
    // pick up anything an audit finishing right now adds, because it reads the
    // rows needing work when it runs, not when it is queued.
    jobId: 'phash-sweep',
  })
}

export async function enqueueTranscription(
  redisUrl: string,
  payload: TranscriptionJobPayload,
): Promise<void> {
  await getQueues(redisUrl).transcription.add(JOB_NAMES.transcribe, payload, {
    ...TRANSCRIPTION_JOB_OPTIONS,
    jobId: transcriptionJobId(payload.submissionId),
  })
}

/**
 * Queue an embedding sweep. The job id is fixed per target so repeatedly
 * pressing "build the index" coalesces into one run rather than stacking.
 */
export async function enqueueEmbedding(
  redisUrl: string,
  payload: EmbeddingJobPayload,
): Promise<void> {
  await getQueues(redisUrl).embedding.add(JOB_NAMES.buildEmbeddings, payload, {
    ...EMBEDDING_JOB_OPTIONS,
    jobId: `embed-${payload.target ?? 'all'}`,
  })
}

/** Cancelling an audit removes the queued job; the worker also checks job status per batch. */
export async function removeAuditJob(redisUrl: string, jobId: string): Promise<void> {
  const job = await getQueues(redisUrl).audit.getJob(auditJobId(jobId))
  await job?.remove()
}

export async function closeQueues(): Promise<void> {
  if (!queues) return
  await Promise.all([
    queues.audit.close(),
    queues.phash.close(),
    queues.transcription.close(),
    queues.embedding.close(),
  ])
  queues = null
}
