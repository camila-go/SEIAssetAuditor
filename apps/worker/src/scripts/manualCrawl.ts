/**
 * `npm run crawl` — enqueue a pHash sweep by hand.
 *
 * Useful after a bulk audit, when many new image assets have been indexed but
 * not yet hashed for duplicate detection.
 */
import { closeConnection, enqueuePhash } from '@capella/queue'
import { assetRepo, disconnect } from '@capella/db'
import { config } from '../config.js'
import { logger } from '../lib/logger.js'

async function main(): Promise<void> {
  const pending = await assetRepo.findNeedingPhash(1_000)

  if (pending.length === 0) {
    logger.info('Every indexed image already has a pHash — nothing to do')
    return
  }

  await enqueuePhash(config.redisUrl, {})
  logger.info({ pending: pending.length }, 'pHash sweep enqueued')
}

main()
  .catch((error: unknown) => {
    logger.fatal({ err: error }, 'Manual crawl failed')
    process.exitCode = 1
  })
  .finally(async () => {
    await closeConnection()
    await disconnect()
  })
