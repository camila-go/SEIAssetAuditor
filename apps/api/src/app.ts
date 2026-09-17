import express, { type Express } from 'express'
import cors from 'cors'
import helmet from 'helmet'
import { config } from './config.js'
import { requestLogger } from './middleware/requestLogger.js'
import { errorHandler, notFoundHandler } from './middleware/errorHandler.js'
import { standardLimiter } from './middleware/rateLimit.js'
import { auditRouter } from './routes/audit.js'
import { assetsRouter, duplicatesRouter, lookupRouter } from './routes/assets.js'
import { programsRouter, testimonialsRouter } from './routes/testimonials.js'
import { adminIntakeRouter, intakeRouter } from './routes/intake.js'
import { socialRouter } from './routes/social.js'

export function createApp(): Express {
  const app = express()

  // `req.ip` is recorded on the legal agreement audit trail, so the proxy chain
  // has to be trusted or every submission records the load balancer's address.
  app.set('trust proxy', 1)

  app.use(helmet())
  app.use(cors({ origin: config.uiOrigin, credentials: true }))
  app.use(requestLogger)

  // JSON parsing is mounted per-route rather than globally: the intake and audit
  // upload routes are multipart and must not have their stream consumed here.
  const json = express.json({ limit: '1mb' })

  app.get('/health', (_req, res) => {
    res.json({ data: { status: 'ok', phase: phaseSummary() } })
  })

  app.use('/api/v1/audit', standardLimiter, json, auditRouter)
  app.use('/api/v1/assets', standardLimiter, json, assetsRouter)
  app.use('/api/v1/lookup', standardLimiter, json, lookupRouter)
  app.use('/api/v1/duplicates', standardLimiter, json, duplicatesRouter)
  app.use('/api/v1/testimonials', standardLimiter, json, testimonialsRouter)
  app.use('/api/v1/programs', standardLimiter, json, programsRouter)
  app.use('/api/v1/social', standardLimiter, json, socialRouter)

  // Public intake — no `json` on the submit path; busboy owns the request stream.
  app.use('/api/v1/intake', intakeRouter)
  // Internal approver routes, mounted after so the public paths win.
  app.use('/api/v1/intake', json, adminIntakeRouter)

  app.use(notFoundHandler)
  app.use(errorHandler)

  return app
}

/** Which phases are live — the UI uses this to hide gated features. */
function phaseSummary() {
  return {
    aemApiEnabled: config.aemApiEnabled,
    aemIntakeEnabled: config.aemIntakeEnabled,
    transcriptionEnabled: config.transcriptionEnabled,
    socialEnabled: config.socialEnabled,
    approvalChainMode: config.approvalChainMode,
  }
}
