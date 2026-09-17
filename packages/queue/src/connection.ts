// Named import, not default: ioredis ships CommonJS, and under ESM the default
// resolves to the module namespace rather than the constructor.
import { Redis } from 'ioredis'

let connection: Redis | null = null

/**
 * One shared Redis connection per process.
 *
 * `maxRetriesPerRequest: null` is required by BullMQ — without it, blocking
 * commands used by the worker throw once the retry budget is spent.
 */
export function getConnection(redisUrl: string): Redis {
  if (connection) return connection

  connection = new Redis(redisUrl, {
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
  })

  return connection
}

export async function closeConnection(): Promise<void> {
  if (!connection) return
  await connection.quit()
  connection = null
}
