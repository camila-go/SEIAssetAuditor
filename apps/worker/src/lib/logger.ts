import pino from 'pino'
import { config } from '../config.js'

export const logger = pino({
  name: 'worker',
  level: config.isProduction ? 'info' : 'debug',
  redact: {
    paths: ['submitterEmail', 'approverEmail', 'legalAgreedIp'],
    censor: '[redacted]',
  },
  // Pretty output only in dev — see the note in apps/api/src/lib/logger.ts.
  transport: config.nodeEnv === 'development' ? { target: 'pino-pretty' } : undefined,
})
