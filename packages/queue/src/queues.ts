import { Queue, type JobsOptions } from 'bullmq'
import { getConnection } from './connection.js'
import {
  JOB_NAMES,
  QUEUE_NAMES,
  type AuditJobPayload,
  type PhashJobPayload,
  type TranscriptionJobPayload,
  type EmbeddingJobPayload,
  type RevalidationJobPayload,
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
  // Also true, and for a reason that cost a week of silence: BullMQ rejects a
  // duplicate job id against a FAILED job exactly as it does against a
  // completed one. A sweep that stalled left `phash-sweep` in the failed set
  // with a 7-day retention, so every later enqueue — from every completed
  // audit — was dropped without a word, and coverage sat at 416 of 665 with no
  // way to recover but waiting out the retention.
  //
  // A blocked queue is far worse than a lost failure record; the failure is in
  // the worker log either way.
  removeOnFail: true,
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

/**
 * Link-rot re-checks. Same removeOnFail reasoning as the pHash sweep: a
 * retained failed id would block the repeatable schedule permanently, which is
 * the worst possible failure for a job whose entire purpose is to run
 * unattended.
 */
const REVALIDATION_JOB_OPTIONS: JobsOptions = {
  attempts: 2,
  backoff: { type: 'fixed', delay: 60_000 },
  removeOnComplete: { age: 30 * 24 * 60 * 60, count: 20 },
  removeOnFail: true,
}

/** Every three days. */
export const REVALIDATION_CRON = '0 3 */3 * *'

interface Queues {
  audit: Queue<AuditJobPayload>
  revalidation: Queue<RevalidationJobPayload>
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
    revalidation: new Queue<RevalidationJobPayload>(QUEUE_NAMES.revalidation, { connection }),
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

/**
 * Continue a sweep that filled its batch.
 *
 * Deliberately NOT the coalescing `phash-sweep` id: that id belongs to the job
 * currently running, and BullMQ would reject the duplicate, so a sweep could
 * never hand off to the next one. A timestamped id lets the chain advance while
 * `phash-sweep` still coalesces everything triggered from outside.
 */
export async function enqueuePhashContinuation(redisUrl: string): Promise<void> {
  await getQueues(redisUrl).phash.add(
    JOB_NAMES.computePhash,
    {},
    { ...PHASH_JOB_OPTIONS, jobId: `phash-sweep-cont-${Date.now()}` },
  )
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

// ─── Asset revalidation ──────────────────────────────────────────────────────

/**
 * Install the recurring link-rot check.
 *
 * Called on every worker start and idempotent: BullMQ keys a repeatable job by
 * name plus pattern, so restarting does not stack schedules. The old schedule
 * is removed first so that changing `REVALIDATION_CRON` actually takes effect —
 * without that, the previous pattern keeps firing alongside the new one and the
 * only symptom is the job running more often than the code says it should.
 */
export async function scheduleRevalidation(redisUrl: string): Promise<void> {
  const queue = getQueues(redisUrl).revalidation

  for (const existing of await queue.getRepeatableJobs()) {
    if (existing.pattern !== REVALIDATION_CRON) {
      await queue.removeRepeatableByKey(existing.key)
    }
  }

  await queue.add(
    JOB_NAMES.revalidateAssets,
    {},
    {
      ...REVALIDATION_JOB_OPTIONS,
      repeat: { pattern: REVALIDATION_CRON },
      jobId: 'revalidate-scheduled',
    },
  )
}

/** Run a check now, outside the schedule. */
export async function enqueueRevalidation(
  redisUrl: string,
  payload: RevalidationJobPayload = {},
): Promise<void> {
  await getQueues(redisUrl).revalidation.add(JOB_NAMES.revalidateAssets, payload, {
    ...REVALIDATION_JOB_OPTIONS,
    jobId: `revalidate-now-${Date.now()}`,
  })
}
