import { Worker } from 'bullmq'
import { execa } from 'execa'
import { disconnect } from '@capella/db'
import {
  QUEUE_NAMES,
  REVALIDATION_CRON,
  scheduleRevalidation,
  type RevalidationJobPayload,
  closeConnection,
  getConnection,
  type AuditJobPayload,
  type PhashJobPayload,
  type TranscriptionJobPayload,
  type EmbeddingJobPayload,
} from '@capella/queue'
import { closeBrowser } from '@capella/scraper'
import { config } from './config.js'
import { logger } from './lib/logger.js'
import { processAuditJob } from './processors/auditProcessor.js'
import { processPhashJob } from './processors/phashProcessor.js'
import { processTranscriptionJob } from './processors/transcriptionProcessor.js'
import { processEmbeddingJob } from './processors/embeddingProcessor.js'
import { processRevalidationJob } from './processors/revalidationProcessor.js'

/**
 * Worker entry point. Runs as its own process (`npm run dev:worker`) —
 * separate from the API so a long audit can never block a request.
 */

/**
 * ffmpeg is a deployment dependency, not something the tool installs. Its
 * absence disables transcription and is logged loudly, but must not stop the
 * worker: audit jobs are the primary workload and don't need it.
 */
async function checkFfmpeg(): Promise<void> {
  if (!config.transcriptionEnabled) {
    logger.info('Transcription disabled by configuration')
    return
  }

  try {
    await execa(config.ffmpegPath, ['-version'])
    logger.info({ ffmpegPath: config.ffmpegPath }, 'ffmpeg available — transcription enabled')
  } catch {
    logger.warn(
      { ffmpegPath: config.ffmpegPath },
      'ffmpeg not found — transcription disabled. Install ffmpeg on the worker host to enable it.',
    )
    config.transcriptionEnabled = false
  }
}

async function main(): Promise<void> {
  await checkFfmpeg()

  const connection = getConnection(config.redisUrl)

  const auditWorker = new Worker<AuditJobPayload>(QUEUE_NAMES.audit, processAuditJob, {
    connection,
    concurrency: config.auditConcurrency,
    // An audit of thousands of URLs legitimately runs for over an hour, so the
    // stalled-job check has to be far more patient than the BullMQ default.
    lockDuration: 5 * 60_000,
    stalledInterval: 60_000,
  })

  const phashWorker = new Worker<PhashJobPayload>(QUEUE_NAMES.phash, processPhashJob, {
    connection,
    concurrency: 1,
  })

  const transcriptionWorker = new Worker<TranscriptionJobPayload>(
    QUEUE_NAMES.transcription,
    processTranscriptionJob,
    { connection, concurrency: config.transcriptionConcurrency, lockDuration: 15 * 60_000 },
  )

  /**
   * Concurrency 1: the embedding model is CPU-bound and already uses several
   * threads internally, so a second concurrent sweep would contend rather than
   * parallelise. lockDuration is generous because a cold model load plus a
   * large corpus can run for minutes.
   */
  const revalidationWorker = new Worker<RevalidationJobPayload>(
    QUEUE_NAMES.revalidation,
    processRevalidationJob,
    { connection: getConnection(config.redisUrl), concurrency: 1 },
  )

  const embeddingWorker = new Worker<EmbeddingJobPayload>(
    QUEUE_NAMES.embedding,
    processEmbeddingJob,
    { connection, concurrency: 1, lockDuration: 10 * 60_000 },
  )

  const workers = [auditWorker, phashWorker, transcriptionWorker, embeddingWorker, revalidationWorker]

  // Idempotent: BullMQ keys a repeatable job by name and pattern, so restarting
  // the worker does not stack schedules. Failing to install it must not stop the
  // worker — audits matter more than the maintenance sweep.
  try {
    await scheduleRevalidation(config.redisUrl)
    logger.info({ cron: REVALIDATION_CRON }, 'Asset revalidation scheduled')
  } catch (error) {
    logger.error({ err: error }, 'Could not schedule asset revalidation — link rot will go unnoticed')
  }

  for (const worker of workers) {
    worker.on('failed', (job, error) => {
      logger.error({ err: error, jobId: job?.id, queue: worker.name }, 'Job failed')
    })
    worker.on('error', (error) => {
      logger.error({ err: error, queue: worker.name }, 'Worker error')
    })
  }

  logger.info(
    {
      auditConcurrency: config.auditConcurrency,
      scraperConcurrency: config.scraperConcurrency,
      batchSize: config.scraperBatchSize,
      transcriptionEnabled: config.transcriptionEnabled,
    },
    'SEI Site Auditor worker started',
  )

  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, 'Worker shutting down')
    // `close()` waits for in-flight jobs so a batch finishes and its results are
    // written before the process exits.
    await Promise.all(workers.map((worker) => worker.close()))
    await closeBrowser()
    await closeConnection()
    await disconnect()
    process.exit(0)
  }

  process.on('SIGTERM', () => void shutdown('SIGTERM'))
  process.on('SIGINT', () => void shutdown('SIGINT'))
}

main().catch((error: unknown) => {
  logger.fatal({ err: error }, 'Worker failed to start')
  process.exit(1)
})
