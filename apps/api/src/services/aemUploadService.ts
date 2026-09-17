import type { Readable } from 'node:stream'
import { AppError, ERROR_CODES } from '@capella/types'
import { config } from '../config.js'
import { logger } from '../lib/logger.js'

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * THE ONLY FILE IN THIS CODEBASE THAT WRITES TO AEM.
 *
 * Runs as `capella-dam-intake-svc`, whose write scope is limited to
 * `AEM_INTAKE_STAGING_PATH` and `AEM_INTAKE_LIVE_ROOT/{program}/videos/` — by
 * default /content/dam/sei/capella/intake/pending/ and
 * /content/dam/sei/capella/{program}/videos/. It is a different account from
 * the read-only `capella-dam-audit-svc` used by the audit features (PRD §7).
 *
 * Invariants:
 *   - Video bytes are piped straight through. Never buffered, never on disk.
 *   - Only the two paths above are ever targeted — `assertWritablePath` enforces it.
 *   - Nothing here replicates or publishes. Approval moves the asset into the
 *     live DAM; a content author still places it on a page.
 * ─────────────────────────────────────────────────────────────────────────────
 */

const UPLOAD_TIMEOUT_MS = 30 * 60 * 1000
const METADATA_TIMEOUT_MS = 30_000

function authHeader(): string {
  const credentials = `${config.aemIntakeWriteUser}:${config.aemIntakeWritePassword}`
  return `Basic ${Buffer.from(credentials).toString('base64')}`
}

function assertEnabled(): void {
  if (!config.aemIntakeEnabled) {
    throw new AppError(
      ERROR_CODES.AEM_INTAKE_NOT_CONFIGURED,
      'Video intake is not configured — the capella-dam-intake-svc account has not been provisioned yet.',
    )
  }
}

/** Config is operator-supplied, so it must not be able to inject regex syntax. */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Defence in depth behind the AEM-side ACL: a bug in path construction must not
 * be able to aim a write at page content or another DAM folder.
 *
 * Both roots come from config rather than literals, so moving intake (as it
 * moved to the SEI DAM) updates the allowlist, the paths written, and the scope
 * documented for IT together. A hardcoded second root is how a widened write
 * path slips through unnoticed.
 */
export function assertWritablePath(damPath: string): void {
  // `..` can only ever be an attempt to escape the allowlisted roots.
  if (damPath.includes('..')) {
    throw new AppError(ERROR_CODES.AEM_UPLOAD_FAILED, `Refusing a traversing path: ${damPath}`)
  }

  // Staging is flat: exactly one filename segment under the root. Accepting a
  // bare `.../pending/` would aim a write at the folder node itself, and
  // accepting a nested path would put assets somewhere the ACL was not scoped for.
  const isStaging = new RegExp(`^${escapeRegExp(config.aemIntakeStagingPath)}/[^/]+$`).test(damPath)

  const isProgramVideos = new RegExp(
    `^${escapeRegExp(config.aemIntakeLiveRoot)}/[^/]+/videos/[^/]+$`,
  ).test(damPath)

  if (!isStaging && !isProgramVideos) {
    throw new AppError(
      ERROR_CODES.AEM_UPLOAD_FAILED,
      `Refusing to write outside the intake paths: ${damPath}`,
    )
  }
}

/** `/content/dam/sei/capella/intake/pending/x.mp4` -> `sei/capella/intake/pending/x.mp4` */
function toAssetsApiPath(damPath: string): string {
  return damPath.replace(/^\/content\/dam\//, '')
}

/** Strip anything that could traverse a path or confuse AEM's node naming. */
export function sanitizeFilename(filename: string): string {
  const base = filename.split(/[/\\]/).pop() ?? 'upload'
  const cleaned = base
    .replace(/[^\w.\- ]+/g, '-')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[.-]+/, '')
    .slice(0, 180)

  return cleaned.length > 0 ? cleaned : 'upload'
}

/**
 * Make the staged filename unique so two vendors submitting `final.mp4` don't
 * collide in the staging folder.
 */
export function stagingFilenameFor(submissionId: string, originalFilename: string): string {
  const safe = sanitizeFilename(originalFilename)
  const shortId = submissionId.replace(/-/g, '').slice(0, 8)
  const dot = safe.lastIndexOf('.')

  return dot > 0
    ? `${safe.slice(0, dot)}-${shortId}${safe.slice(dot)}`
    : `${safe}-${shortId}`
}

export function stagingPathFor(filename: string): string {
  return `${config.aemIntakeStagingPath}/${filename}`
}

export function livePathFor(program: string, filename: string): string {
  const safeProgram = program
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')

  // A program that sanitizes to nothing would produce a double slash and land
  // outside the allowlist — name it rather than writing somewhere unintended.
  if (safeProgram.length === 0) {
    throw new AppError(ERROR_CODES.AEM_UPLOAD_FAILED, `Program has no usable name: "${program}"`)
  }

  return `${config.aemIntakeLiveRoot}/${safeProgram}/videos/${filename}`
}

// ─── Write operations ────────────────────────────────────────────────────────

/**
 * Stream a video into the AEM staging folder.
 *
 * `body` is the inbound request stream. `duplex: 'half'` is required by undici
 * to send a stream body; without it the upload buffers.
 */
export async function uploadVideo(
  damPath: string,
  body: Readable,
  mimeType: string,
  contentLength?: number,
): Promise<void> {
  assertEnabled()
  assertWritablePath(damPath)

  const url = `${config.aemAuthorHost}/api/assets/${toAssetsApiPath(damPath)}`

  const headers: Record<string, string> = {
    Authorization: authHeader(),
    'Content-Type': mimeType,
  }
  if (contentLength !== undefined) headers['Content-Length'] = String(contentLength)

  // `duplex: 'half'` is required by undici to send a stream body; without it the
  // upload buffers. It is not in the standard RequestInit type, so the whole
  // init object is built as a wider type and narrowed on the way in.
  const init: RequestInit & { duplex: 'half' } = {
    method: 'POST',
    headers,
    body: body as unknown as RequestInit['body'],
    duplex: 'half',
    signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
  }

  let response: Response
  try {
    response = await fetch(url, init)
  } catch (error) {
    throw new AppError(
      ERROR_CODES.AEM_UPLOAD_FAILED,
      `Upload to AEM failed: ${error instanceof Error ? error.message : String(error)}`,
    )
  }

  if (!response.ok) {
    const detail = await safeText(response)
    logger.error({ status: response.status, damPath, detail }, 'AEM video upload failed')
    throw new AppError(
      ERROR_CODES.AEM_UPLOAD_FAILED,
      `AEM rejected the upload (HTTP ${response.status})`,
    )
  }

  logger.info({ damPath }, 'Video uploaded to AEM staging')
}

/** Upload a small generated file (the .vtt caption track) alongside the video. */
export async function uploadFile(
  damPath: string,
  content: string,
  mimeType: string,
): Promise<void> {
  assertEnabled()
  assertWritablePath(damPath)

  const url = `${config.aemAuthorHost}/api/assets/${toAssetsApiPath(damPath)}`

  const response = await fetch(url, {
    method: 'POST',
    headers: { Authorization: authHeader(), 'Content-Type': mimeType },
    body: content,
    signal: AbortSignal.timeout(METADATA_TIMEOUT_MS),
  })

  if (!response.ok) {
    throw new AppError(
      ERROR_CODES.AEM_UPLOAD_FAILED,
      `AEM rejected the file upload (HTTP ${response.status})`,
    )
  }
}

export type AemMetadata = Record<string, string | string[] | boolean | null>

export async function updateMetadata(damPath: string, metadata: AemMetadata): Promise<void> {
  assertEnabled()
  assertWritablePath(damPath)

  const url = `${config.aemAuthorHost}/api/assets/${toAssetsApiPath(damPath)}/jcr:content/metadata`

  const response = await fetch(url, {
    method: 'PUT',
    headers: { Authorization: authHeader(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ properties: metadata }),
    signal: AbortSignal.timeout(METADATA_TIMEOUT_MS),
  })

  if (!response.ok) {
    const detail = await safeText(response)
    logger.error({ status: response.status, damPath, detail }, 'AEM metadata write failed')
    throw new AppError(
      ERROR_CODES.AEM_UPLOAD_FAILED,
      `AEM rejected the metadata update (HTTP ${response.status})`,
    )
  }
}

/** Move a staged asset into the live DAM. Called only on full approval. */
export async function moveAsset(fromDamPath: string, toDamPath: string): Promise<void> {
  assertEnabled()
  assertWritablePath(fromDamPath)
  assertWritablePath(toDamPath)

  const url = `${config.aemAuthorHost}/api/assets/${toAssetsApiPath(fromDamPath)}`

  const response = await fetch(url, {
    method: 'MOVE',
    headers: { Authorization: authHeader(), 'X-Destination': toDamPath },
    signal: AbortSignal.timeout(METADATA_TIMEOUT_MS),
  })

  if (!response.ok) {
    const detail = await safeText(response)
    logger.error({ status: response.status, fromDamPath, toDamPath, detail }, 'AEM move failed')
    throw new AppError(
      ERROR_CODES.AEM_UPLOAD_FAILED,
      `AEM rejected the move (HTTP ${response.status})`,
    )
  }

  logger.info({ fromDamPath, toDamPath }, 'Asset moved to live DAM')
}

/**
 * Staging asset URL for the admin preview and for ffmpeg audio extraction.
 * Author-instance only, and the dispatcher blocks /intake/ publicly — this URL
 * must never be handed to a submitter.
 */
export function stagingAssetUrl(damPath: string): string {
  return `${config.aemAuthorHost}${damPath}`
}

async function safeText(response: Response): Promise<string> {
  try {
    return (await response.text()).slice(0, 500)
  } catch {
    return ''
  }
}
