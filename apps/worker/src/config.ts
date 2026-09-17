import { existsSync } from 'node:fs'
import path from 'node:path'
import { loadEnvFile } from 'node:process'
import { z } from 'zod'

/**
 * Load the monorepo root `.env`, resolved by walking up from this file rather
 * than from `process.cwd()` — npm sets the cwd to the workspace directory.
 *
 * Deliberately duplicated from apps/api/src/config.ts: the worker is a separate
 * process that must not import the API's config, and these two files are the
 * only places in the codebase allowed to touch `process.env`.
 */
function loadRootEnv(): void {
  // `import.meta.dirname` is undefined under some transforms (ts-jest), so fall
  // back to the cwd rather than throwing on a path of `undefined`.
  let dir = import.meta.dirname ?? process.cwd()

  for (let depth = 0; depth < 6; depth++) {
    const candidate = path.join(dir, '.env')
    if (existsSync(candidate)) {
      loadEnvFile(candidate)
      return
    }
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
}

loadRootEnv()

/**
 * Worker configuration. The only file in the worker that reads `process.env`.
 * Deliberately a narrower schema than the API's — the worker does not serve
 * HTTP and has no use for CORS, ports or rate limits.
 */

const booleanFromEnv = z
  .enum(['true', 'false'])
  .default('false')
  .transform((value) => value === 'true')

const schema = z.object({
  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),
  AEM_PUBLIC_HOST: z.string().url(),
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),

  AEM_AUTHOR_HOST: z.string().url().optional(),
  AEM_INTAKE_WRITE_USER: z.string().optional(),
  AEM_INTAKE_WRITE_PASSWORD: z.string().optional(),

  TRANSCRIPTION_ENABLED: booleanFromEnv,
  OPENAI_API_KEY: z.string().optional(),
  FFMPEG_PATH: z.string().default('/usr/bin/ffmpeg'),

  SCRAPER_CONCURRENCY: z.coerce.number().int().positive().max(20).default(5),
  SCRAPER_PAGE_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),
  SCRAPER_BATCH_SIZE: z.coerce.number().int().positive().default(5),
  SCRAPER_USER_AGENT: z.string().default('SEI-Site-Auditor/1.0 (internal)'),
  SCRAPER_POLITENESS_DELAY_MS: z.coerce.number().int().min(0).default(200),
  /** Best-effort settle after `load`. networkidle never fires on capella.edu. */
  SCRAPER_SETTLE_MS: z.coerce.number().int().min(0).default(2_000),

  /** How many audit jobs this worker processes at once (not pages — see SCRAPER_CONCURRENCY). */
  WORKER_AUDIT_CONCURRENCY: z.coerce.number().int().positive().max(5).default(1),
  WORKER_TRANSCRIPTION_CONCURRENCY: z.coerce.number().int().positive().max(5).default(2),
})

function load() {
  const parsed = schema.safeParse(process.env)

  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `  ${issue.path.join('.')}: ${issue.message}`)
      .join('\n')
    throw new Error(`Invalid worker environment configuration:\n${issues}`)
  }

  const env = parsed.data

  return {
    nodeEnv: env.NODE_ENV,
    isProduction: env.NODE_ENV === 'production',
    databaseUrl: env.DATABASE_URL,
    redisUrl: env.REDIS_URL,
    aemPublicHost: env.AEM_PUBLIC_HOST.replace(/\/$/, ''),
    aemAuthorHost: env.AEM_AUTHOR_HOST ?? '',
    aemIntakeWriteUser: env.AEM_INTAKE_WRITE_USER ?? '',
    aemIntakeWritePassword: env.AEM_INTAKE_WRITE_PASSWORD ?? '',

    // Mutable: the startup ffmpeg check clears this when ffmpeg is missing
    // rather than crashing the worker.
    transcriptionEnabled: env.TRANSCRIPTION_ENABLED && Boolean(env.OPENAI_API_KEY),
    ffmpegPath: env.FFMPEG_PATH,

    scraperConcurrency: env.SCRAPER_CONCURRENCY,
    scraperPageTimeoutMs: env.SCRAPER_PAGE_TIMEOUT_MS,
    scraperBatchSize: env.SCRAPER_BATCH_SIZE,
    scraperUserAgent: env.SCRAPER_USER_AGENT,
    scraperPolitenessDelayMs: env.SCRAPER_POLITENESS_DELAY_MS,
    scraperSettleMs: env.SCRAPER_SETTLE_MS,

    auditConcurrency: env.WORKER_AUDIT_CONCURRENCY,
    transcriptionConcurrency: env.WORKER_TRANSCRIPTION_CONCURRENCY,
  }
}

export const config = load()
