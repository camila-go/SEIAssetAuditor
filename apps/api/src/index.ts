import { createApp } from './app.js'
import { config } from './config.js'
import { logger } from './lib/logger.js'
import { disconnect } from '@capella/db'
import { closeQueues } from '@capella/queue'

const app = createApp()

const server = app.listen(config.apiPort, () => {
  logger.info(
    {
      port: config.apiPort,
      aemApiEnabled: config.aemApiEnabled,
      aemIntakeEnabled: config.aemIntakeEnabled,
      transcriptionEnabled: config.transcriptionEnabled,
      approvalChainMode: config.approvalChainMode,
    },
    'SEI Site Auditor API listening',
  )

  if (!config.aemApiEnabled) {
    logger.warn('AEM API disabled — Phase 2 features return 501 (see docs/dam-permissions.md)')
  }
  if (!config.aemIntakeEnabled) {
    logger.warn('AEM intake disabled — video submission returns 501')
  }
})

/**
 * Drain in-flight requests before exiting. An intake upload can be streaming to
 * AEM when a deploy lands; killing the process mid-stream leaves a partial asset.
 */
async function shutdown(signal: string): Promise<void> {
  logger.info({ signal }, 'Shutting down')

  server.close(async () => {
    await closeQueues().catch(() => undefined)
    await disconnect().catch(() => undefined)
    process.exit(0)
  })

  setTimeout(() => {
    logger.error('Forced exit — connections did not drain in 30s')
    process.exit(1)
  }, 30_000).unref()
}

process.on('SIGTERM', () => void shutdown('SIGTERM'))
process.on('SIGINT', () => void shutdown('SIGINT'))

/**
 * Node terminates the process on an unhandled rejection. That is the right
 * default — the alternative is serving requests from a process in an unknown
 * state — but the bare stack trace it prints does not reach structured logs.
 * Log it properly first so the cause is diagnosable, then let the exit happen.
 */
process.on('unhandledRejection', (reason) => {
  logger.fatal({ err: reason }, 'Unhandled promise rejection — exiting')
  process.exit(1)
})

process.on('uncaughtException', (error) => {
  logger.fatal({ err: error }, 'Uncaught exception — exiting')
  process.exit(1)
})
