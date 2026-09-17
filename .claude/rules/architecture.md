# Architecture Rules

Loaded for all files. Defines how the codebase is structured and how layers communicate.

## Layer Boundaries

```
UI (React)  →  API routes (Express)  →  Services  →  Prisma  →  PostgreSQL
                                     ↘  BullMQ Queue  →  Redis
                                              ↓
                                         Worker Process
                                              ↓
                                         Scraper  →  Prisma  →  PostgreSQL
                                     ↘  AEM client (Phase 2)
                                     ↘  Social clients (Phase 3)
```

- UI never imports from `apps/api` directly — all data goes through HTTP
- Services own all business logic — route handlers are thin (validate → call service → respond)
- Prisma queries live in `packages/db/repositories/` — never write raw SQL or inline Prisma calls in services
- The scraper (`packages/scraper/`) is a standalone module — no Express imports
- The worker (`apps/worker/`) is a separate process — imports from `packages/queue`, `packages/scraper`, `packages/db` only
- Queue definitions live in `packages/queue/` — shared between API (enqueues) and worker (processes)

## Job Queue — Audit Jobs

All bulk URL audits run as background jobs. Never process more than one page synchronously in a request.

```typescript
// API — creates job and returns immediately
POST /api/v1/audit
→ creates AuditJob in DB
→ creates AuditJobUrl row for each URL
→ enqueues job to BullMQ
→ returns { jobId, status: 'queued', totalUrls }

// UI polls for progress
GET /api/v1/audit/:jobId/status
→ returns { status, totalUrls, completedUrls, failedUrls, percentComplete, estimatedMinutesRemaining }

// Results queryable before job completes
GET /api/v1/audit/:jobId/results?page=1&limit=50&assetType=image&liveStatus=published
```

Worker processes pages in batches of 10. After each batch it writes results to DB and updates `AuditJob.completed_urls`. Jobs are resumable — if the worker crashes, BullMQ re-queues from the last checkpoint. One bad URL must never stop the whole job.

## API Conventions

- All routes prefixed `/api/v1/`
- Responses always shaped: `{ data, error, meta }` — never bare objects
- Errors always include `{ code, message }` — use the error codes in `packages/types/errors.ts`
- Pagination via `{ page, limit, total }` in `meta` — default limit 50, max 200
- Asset paths in requests/responses always include the leading slash: `/content/dam/capella/...`

## AEM Asset URLs

- Internal references use the AEM path: `/content/dam/capella/images/hero.jpg`
- Public URLs are constructed at render time: `https://www.capella.edu` + aem_path
- Never hardcode the domain — use `AEM_PUBLIC_HOST` from env
- Renditions accessed via: `{aem_path}/jcr:content/renditions/original`

## AEM Query Builder — Critical Rules (Phase 2)

The Query Builder JSON servlet is at `GET /bin/querybuilder.json`. Key constraints:

- **Default limit is 10 hits** — always pass `p.limit` explicitly or results will be silently truncated
- Use `p.hits=selective` + `p.properties` to limit response payload — never use `p.hits=full` in production queries
- Use `p.guessTotal=true` for paginated queries — avoids full result set count which is slow at scale
- Use `p.guessTotal=N` (e.g. `p.guessTotal=100`) when you want exact counts below N but fast "more than N" above
- Numeric prefixes required when using the same predicate more than once: `1_property`, `2_property`
- Group predicates with `group.p.or=true` for OR logic; default is AND
- `tagid` predicate for tag matching — always pair with `tagid.property=jcr:content/cq:tags`
- `orderby=@jcr:content/cq:lastModified` with `orderby.sort=desc` for recency ordering

## Scraper Rules

Capella's site is JS-rendered — `node-fetch` + static HTML parsing returns only navigation, not page body content. Playwright is required.

- One shared Chromium browser instance per worker process — do not launch per page
- `waitUntil: 'networkidle'` — ensures JS has fully rendered before DOM extraction
- Max 5 concurrent Playwright pages per worker (heavier than fetch — reduce from 10)
- 30 second timeout per page — mark as failed and continue if exceeded
- User-agent set via Playwright context: `Capella-DAM-Tool/1.0 (internal)`
- Extract from rendered DOM: `img[src]`, `source[srcset]`, `a[href]`, `[data-src]`, `[data-asset-path]`
- Index every path under `/content/dam/` — see the DAM root note in `CLAUDE.md`. The
  narrower `/content/dam/capella/` this rule used to specify is a minority of what the
  live site serves and silently dropped most assets. Use `DAM_ROOT` from
  `packages/scraper`, never a literal.
- Sitemap: fetch XML with plain `node-fetch` (static XML, no JS needed), extract `<loc>` elements
- Phase 2: testimonial extraction moves to AEM Query Builder — Playwright retained for asset references

## Phase Gating

Features that require AEM API or social APIs must be guarded:

```typescript
if (!config.aemApiEnabled) {
  return res.status(501).json({
    error: { code: 'AEM_API_NOT_CONFIGURED', message: 'AEM API access not yet configured — see IT request' }
  })
}
```

Never throw — always return a structured error so the UI can display a graceful message.

## Video Intake — Write Boundary

The intake flow is the only place this tool writes to AEM. This boundary must be strictly maintained:

- All AEM writes go through `aemUploadService.ts` only — no other file touches AEM write APIs
- The intake write service account (`AEM_INTAKE_WRITE_USER`) is separate from the read-only audit account (`AEM_SERVICE_ACCOUNT_USER`) — different credentials, different permission scope
- Intake writes go to the shared SEI DAM (`/content/dam/sei/capella/...`), not the legacy `/content/dam/capella/` tree. Both roots come from config — never hardcode a second copy, or the allowlist and the granted ACL drift apart.
- The `/intake` and `/intake/resubmit/:id` routes are public (no auth) — rate limit aggressively
- The `/admin/intake/*` routes require internal auth — use `internalAuth` middleware
- Video files are streamed directly to AEM — never buffered in memory or written to local disk
- The tool's DB tracks approval state only — the video binary lives in AEM at all times

## AEM Staging Folder Access Control

The dispatcher must block public access to `AEM_INTAKE_STAGING_PATH`'s parent — `/content/dam/sei/capella/intake/` by default — entirely. This is an AEM/IT configuration — document it as a deployment requirement, not something the tool enforces. The tool assumes the restriction is in place.

## Transcription — Temp File Boundary

The transcription flow is the only moment any video-derived data touches the app server. Rules:

- ffmpeg extracts audio to `/tmp/{jobId}.mp3` only — no video files ever written to disk
- Temp file is deleted in a `finally` block — guaranteed deletion even on error
- Whisper API receives audio stream — never the video
- Transcript text passes through the app in memory only — stored in DB and written to AEM
- VTT file is generated as a string in memory and streamed directly to AEM — never written to disk
- If ffmpeg is not available in the deployment environment, transcription fails gracefully — approval workflow continues unaffected

## ffmpeg Requirement

ffmpeg must be available on the worker process host. This is a deployment dependency — document for IT/DevOps. The worker startup should check for ffmpeg availability and log a warning if not found, but not crash.

```typescript
// Worker startup check
try {
  await execa('ffmpeg', ['-version'])
  logger.info('ffmpeg available — transcription enabled')
} catch {
  logger.warn('ffmpeg not found — transcription will be disabled. Install ffmpeg to enable.')
  config.transcriptionEnabled = false
}
```
