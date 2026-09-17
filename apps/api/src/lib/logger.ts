import pino from 'pino'
import { config } from '../config.js'

export const logger = pino({
  level: config.isProduction ? 'info' : 'debug',
  // Submitter emails and IPs flow through this service; keep them out of logs.
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers.cookie',
      'submitterEmail',
      'approverEmail',
      'legalAgreedIp',
    ],
    censor: '[redacted]',
  },
  // Pretty output only in dev. `pino-pretty` is a devDependency, so keying on
  // `isProduction` alone would break any environment that has NODE_ENV unset
  // or set to `test` without it installed.
  transport: config.nodeEnv === 'development' ? { target: 'pino-pretty' } : undefined,
})
