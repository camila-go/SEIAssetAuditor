// Named export — pino-http has no default export under NodeNext resolution.
import { pinoHttp } from 'pino-http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { logger } from '../lib/logger.js'

export const requestLogger = pinoHttp({
  logger,
  // Health checks would otherwise dominate the log.
  autoLogging: { ignore: (req: IncomingMessage) => req.url === '/health' },
  customLogLevel: (_req: IncomingMessage, res: ServerResponse, err?: Error) => {
    if (err || res.statusCode >= 500) return 'error'
    if (res.statusCode >= 400) return 'warn'
    return 'info'
  },
})
