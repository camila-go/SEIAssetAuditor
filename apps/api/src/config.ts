import { existsSync } from 'node:fs'
import path from 'node:path'
import { loadEnvFile } from 'node:process'
import { z } from 'zod'

/**
 * The only file in the API that reads `process.env`. Everything else imports
 * `config`. Validation runs at startup so a misconfigured deploy fails fast
 * rather than at the first request.
 */

/**
 * Load the monorepo root `.env` if one exists.
 *
 * Resolved by walking up from this file, not from `process.cwd()`:
 * `npm run --workspace=…` sets the cwd to the workspace directory, so a
 * cwd-relative lookup silently misses the root `.env` and every required
 * variable reads as missing. Uses Node's built-in loader — no dotenv needed.
 * Variables already present in the real environment always win.
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
  // No .env anywhere above us — expected in production and CI.
}

loadRootEnv()

const booleanFromEnv = z
  .enum(['true', 'false'])
  .default('false')
  .transform((value) => value === 'true')

const schema = z.object({
  // ─── Required ─────────────────────────────────────────────────────────────
  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),
  AEM_PUBLIC_HOST: z.string().url(),

  API_PORT: z.coerce.number().int().positive().default(3001),
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  UI_ORIGIN: z.string().default('http://localhost:5173'),

  // ─── Phase 2: read-only audit account ─────────────────────────────────────
  AEM_API_ENABLED: booleanFromEnv,
  AEM_AUTHOR_HOST: z.string().url().optional(),
  AEM_SERVICE_ACCOUNT_USER: z.string().optional(),
  AEM_SERVICE_ACCOUNT_PASSWORD: z.string().optional(),
  AEM_PAGE_PATH: z.string().default('/content/capella/en'),

  // ─── Video intake: write-scoped account ───────────────────────────────────
  AEM_INTAKE_ENABLED: booleanFromEnv,
  AEM_INTAKE_WRITE_USER: z.string().optional(),
  AEM_INTAKE_WRITE_PASSWORD: z.string().optional(),
  /**
   * Both intake paths moved into the shared SEI DAM (decided 2026-09-17), to sit
   * with the rest of Capella's assets rather than in the legacy
   * `/content/dam/capella/` tree the audit side found is now a minority of the
   * site. These two values are the entire write scope of the intake service
   * account — `assertWritablePath` derives its allowlist from them, so the
   * request handed to IT and the check in code cannot drift apart.
   *
   * Changing either one changes what the tool may write to. The account has to
   * be re-scoped to match, and the dispatcher rule that blocks the staging
   * folder publicly has to move with it.
   */
  AEM_INTAKE_STAGING_PATH: z.string().default('/content/dam/sei/capella/intake/pending'),
  AEM_INTAKE_LIVE_ROOT: z.string().default('/content/dam/sei/capella'),
  APPROVAL_CHAIN_MODE: z.enum(['sequential', 'parallel']).default('sequential'),
  MAX_VIDEO_BYTES: z.coerce.number().int().positive().default(2 * 1024 * 1024 * 1024),

  // ─── Legal document storage ───────────────────────────────────────────────
  LEGAL_DOC_STORAGE_PATH: z.string().default('/var/capella-dam/legal-docs'),
  LEGAL_TERMS_URL: z.string().url().default('https://www.capella.edu/legal/video-submission-terms'),
  MAX_LEGAL_DOC_BYTES: z.coerce.number().int().positive().default(10 * 1024 * 1024),

  // ─── Email ────────────────────────────────────────────────────────────────
  EMAIL_FROM: z.string().default('noreply@capella.edu'),
  EMAIL_SMTP_HOST: z.string().optional(),
  EMAIL_SMTP_PORT: z.coerce.number().int().positive().default(587),
  EMAIL_SMTP_USER: z.string().optional(),
  EMAIL_SMTP_PASSWORD: z.string().optional(),
  LEGAL_APPROVER_EMAIL: z.string().optional(),
  MARKETING_APPROVER_EMAIL: z.string().optional(),

  // ─── Internal auth (approver-only routes) ─────────────────────────────────
  INTERNAL_AUTH_TOKEN: z.string().optional(),

  // ─── Transcription ────────────────────────────────────────────────────────
  TRANSCRIPTION_ENABLED: booleanFromEnv,
  OPENAI_API_KEY: z.string().optional(),
  ANTHROPIC_API_KEY: z.string().optional(),
  // Chapter detection is a cheap bulk extraction over transcript text, which is
  // what Haiku is for. Model IDs carry no date suffix.
  CHAPTER_DETECTION_MODEL: z.string().default('claude-haiku-4-5'),
  FFMPEG_PATH: z.string().default('/usr/bin/ffmpeg'),

  // ─── Scraper ──────────────────────────────────────────────────────────────
  SCRAPER_CONCURRENCY: z.coerce.number().int().positive().max(20).default(5),
  SCRAPER_PAGE_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),
  SCRAPER_BATCH_SIZE: z.coerce.number().int().positive().default(5),
  SCRAPER_USER_AGENT: z.string().default('SEI-Site-Auditor/1.0 (internal)'),
  SCRAPER_POLITENESS_DELAY_MS: z.coerce.number().int().min(0).default(200),
  SCRAPER_SETTLE_MS: z.coerce.number().int().min(0).default(2_000),

  // ─── Semantic search ──────────────────────────────────────────────────────
  // Runs a local sentence model — no API key, no per-query cost. Disable to
  // fall back to the lexical passes alone.
  SEMANTIC_SEARCH_ENABLED: booleanFromEnv.default('true'),

  // ─── Phase 3 ──────────────────────────────────────────────────────────────
  SOCIAL_ENABLED: booleanFromEnv,
  META_ACCESS_TOKEN: z.string().optional(),
  TIKTOK_CLIENT_KEY: z.string().optional(),
  TIKTOK_CLIENT_SECRET: z.string().optional(),
  YOUTUBE_API_KEY: z.string().optional(),
  LINKEDIN_CLIENT_ID: z.string().optional(),
  LINKEDIN_CLIENT_SECRET: z.string().optional(),
})

function load() {
  const parsed = schema.safeParse(process.env)

  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `  ${issue.path.join('.')}: ${issue.message}`)
      .join('\n')
    throw new Error(`Invalid environment configuration:\n${issues}`)
  }

  const env = parsed.data

  // A feature flag without its credentials is a deployment mistake we want to
  // hear about at boot, not as a 502 during a submission.
  const aemApiEnabled =
    env.AEM_API_ENABLED &&
    requireAll('AEM_API_ENABLED', {
      AEM_AUTHOR_HOST: env.AEM_AUTHOR_HOST,
      AEM_SERVICE_ACCOUNT_USER: env.AEM_SERVICE_ACCOUNT_USER,
      AEM_SERVICE_ACCOUNT_PASSWORD: env.AEM_SERVICE_ACCOUNT_PASSWORD,
    })

  const aemIntakeEnabled =
    env.AEM_INTAKE_ENABLED &&
    requireAll('AEM_INTAKE_ENABLED', {
      AEM_AUTHOR_HOST: env.AEM_AUTHOR_HOST,
      AEM_INTAKE_WRITE_USER: env.AEM_INTAKE_WRITE_USER,
      AEM_INTAKE_WRITE_PASSWORD: env.AEM_INTAKE_WRITE_PASSWORD,
    })

  const transcriptionEnabled =
    env.TRANSCRIPTION_ENABLED &&
    requireAll('TRANSCRIPTION_ENABLED', { OPENAI_API_KEY: env.OPENAI_API_KEY })

  return {
    nodeEnv: env.NODE_ENV,
    isProduction: env.NODE_ENV === 'production',
    apiPort: env.API_PORT,
    uiOrigin: env.UI_ORIGIN,

    databaseUrl: env.DATABASE_URL,
    redisUrl: env.REDIS_URL,
    aemPublicHost: env.AEM_PUBLIC_HOST.replace(/\/$/, ''),

    aemApiEnabled,
    aemAuthorHost: env.AEM_AUTHOR_HOST ?? '',
    aemServiceAccountUser: env.AEM_SERVICE_ACCOUNT_USER ?? '',
    aemServiceAccountPassword: env.AEM_SERVICE_ACCOUNT_PASSWORD ?? '',
    aemPagePath: env.AEM_PAGE_PATH,

    aemIntakeEnabled,
    aemIntakeWriteUser: env.AEM_INTAKE_WRITE_USER ?? '',
    aemIntakeWritePassword: env.AEM_INTAKE_WRITE_PASSWORD ?? '',
    aemIntakeStagingPath: env.AEM_INTAKE_STAGING_PATH.replace(/\/$/, ''),
    aemIntakeLiveRoot: env.AEM_INTAKE_LIVE_ROOT.replace(/\/$/, ''),
    approvalChainMode: env.APPROVAL_CHAIN_MODE,
    maxVideoBytes: env.MAX_VIDEO_BYTES,

    legalDocStoragePath: env.LEGAL_DOC_STORAGE_PATH,
    legalTermsUrl: env.LEGAL_TERMS_URL,
    maxLegalDocBytes: env.MAX_LEGAL_DOC_BYTES,

    emailFrom: env.EMAIL_FROM,
    smtpHost: env.EMAIL_SMTP_HOST,
    smtpPort: env.EMAIL_SMTP_PORT,
    smtpUser: env.EMAIL_SMTP_USER,
    smtpPassword: env.EMAIL_SMTP_PASSWORD,
    legalApproverEmail: env.LEGAL_APPROVER_EMAIL,
    marketingApproverEmail: env.MARKETING_APPROVER_EMAIL,
    emailEnabled: Boolean(env.EMAIL_SMTP_HOST),

    internalAuthToken: env.INTERNAL_AUTH_TOKEN,

    transcriptionEnabled,
    openaiApiKey: env.OPENAI_API_KEY ?? '',
    anthropicApiKey: env.ANTHROPIC_API_KEY ?? '',
    chapterDetectionModel: env.CHAPTER_DETECTION_MODEL,
    ffmpegPath: env.FFMPEG_PATH,

    scraper: {
      concurrency: env.SCRAPER_CONCURRENCY,
      pageTimeoutMs: env.SCRAPER_PAGE_TIMEOUT_MS,
      batchSize: env.SCRAPER_BATCH_SIZE,
      userAgent: env.SCRAPER_USER_AGENT,
      politenessDelayMs: env.SCRAPER_POLITENESS_DELAY_MS,
      settleMs: env.SCRAPER_SETTLE_MS,
    },

    semanticSearchEnabled: env.SEMANTIC_SEARCH_ENABLED,

    socialEnabled: env.SOCIAL_ENABLED,
    social: {
      metaAccessToken: env.META_ACCESS_TOKEN,
      tiktokClientKey: env.TIKTOK_CLIENT_KEY,
      tiktokClientSecret: env.TIKTOK_CLIENT_SECRET,
      youtubeApiKey: env.YOUTUBE_API_KEY,
      linkedinClientId: env.LINKEDIN_CLIENT_ID,
      linkedinClientSecret: env.LINKEDIN_CLIENT_SECRET,
    },
  }
}

function requireAll(flag: string, values: Record<string, string | undefined>): boolean {
  const missing = Object.entries(values)
    .filter(([, value]) => !value)
    .map(([key]) => key)

  if (missing.length > 0) {
    throw new Error(`${flag}=true but these are not set: ${missing.join(', ')}`)
  }
  return true
}

export type Config = ReturnType<typeof load>

export const config: Config = load()

/** Public URL for a DAM asset. Never hardcode the domain at a call site. */
export function publicAssetUrl(aemPath: string): string {
  return `${config.aemPublicHost}${aemPath}`
}
