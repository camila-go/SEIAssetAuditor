# API & Backend Rules

Loaded when working in `apps/api/`, `apps/worker/`, or `packages/`.

## Route Structure

```
apps/api/src/
├── routes/
│   ├── assets.ts          # GET /api/v1/assets, GET /api/v1/assets/:id
│   ├── audit.ts           # POST /api/v1/audit, GET /api/v1/audit/:id/status, GET /api/v1/audit/:id/results
│   ├── lookup.ts          # GET /api/v1/lookup?path=...
│   ├── duplicates.ts      # GET /api/v1/duplicates
│   ├── testimonials.ts    # GET /api/v1/testimonials, GET /api/v1/testimonials/:id
│   ├── programs.ts        # GET /api/v1/programs/coverage (Phase 2)
│   ├── intake.ts          # POST /api/v1/intake (public — no auth)
│   │                      # GET /api/v1/intake (list — internal auth required)
│   │                      # GET /api/v1/intake/:id
│   │                      # POST /api/v1/intake/:id/approve (internal auth)
│   │                      # POST /api/v1/intake/:id/reject  (internal auth)
│   │                      # POST /api/v1/intake/:id/resubmit (public — no auth)
│   └── social.ts          # Phase 3 only
├── services/
│   ├── assetService.ts
│   ├── auditService.ts
│   ├── scraperService.ts
│   ├── testimonialService.ts
│   ├── testimonialExtractor.ts
│   ├── intakeService.ts       # Orchestrates submission, AEM upload, approval chain, notifications
│   ├── aemUploadService.ts    # AEM Assets HTTP API write operations — isolated here only
│   ├── notificationService.ts # Email to submitters and approvers
│   └── pHashService.ts
├── middleware/
│   ├── errorHandler.ts
│   ├── internalAuth.ts    # Auth middleware for approver-only routes
│   └── requestLogger.ts
└── config.ts

apps/worker/src/
├── index.ts               # Worker entry — connects to BullMQ, registers processors
├── processors/
│   ├── auditProcessor.ts       # Processes AuditJob batches, writes results to DB
│   ├── pHashProcessor.ts       # Background pHash computation
│   ├── embeddingProcessor.ts   # Background embedding sweep for semantic search
│   └── transcriptionProcessor.ts  # ffmpeg + Whisper, gated on TRANSCRIPTION_ENABLED
└── config.ts

packages/queue/src/
├── queues.ts              # BullMQ Queue instances — shared by API and worker
├── jobs.ts                # Job type definitions
└── index.ts
```

## Audit Jobs — Job Queue Pattern

Never process bulk audits synchronously. The API creates the job and returns immediately.

```typescript
// POST /api/v1/audit — accepts: { urls?: string[], csvFile?: upload, sitemapUrl?: string }
// 1. Validate input (urls or file or sitemap required)
// 2. If sitemapUrl: fetch and parse XML, extract all <loc> elements as URLs
// 3. Create AuditJob record in DB with status: 'queued'
// 4. Create AuditJobUrl row for each URL with status: 'pending'
// 5. Enqueue job to BullMQ
// 6. Return { data: { jobId, status: 'queued', totalUrls } }
```

Worker processes 10 URLs per batch:
- Launch Playwright browser page, navigate to URL, wait for network idle
- Parse fully rendered DOM — extract assets and testimonials in one pass
- Upsert Asset, Page, AssetPageReference, Testimonial, TestimonialPageReference
- Update `AuditJob.completed_urls` after each batch
- On URL failure: mark `AuditJobUrl.status = 'failed'`, store error, continue — never abort the job

## Response Shape

Always return this shape — the UI depends on it:

```typescript
// Success
{ data: T, meta?: { page: number, limit: number, total: number } }

// Error
{ error: { code: string, message: string, details?: unknown } }
```

Never throw unhandled errors from route handlers — wrap in try/catch and call `next(err)`.

## Environment Config

All env vars are validated at startup in `config.ts` using zod. Never access `process.env` directly outside of `config.ts`.

```typescript
// Wrong
const host = process.env.AEM_PUBLIC_HOST

// Correct
import { config } from '../config'
const host = config.aemPublicHost
```

## AEM Query Builder Client (Phase 2)

All Query Builder calls go through `packages/scraper/src/aemClient.ts`. Gate every call with `config.aemApiEnabled`.

**Default limit is 10 — always set `p.limit` explicitly or results will be silently truncated.**

```typescript
// Find pages referencing a specific asset
// Uses p.hits=selective to minimize response payload
const params = new URLSearchParams({
  'path': '/content/capella/en',
  'type': 'nt:base',
  'property': 'fileReference',
  'property.value': assetPath,
  'p.limit': '500',
  'p.hits': 'selective',
  'p.properties': 'path jcr:content/jcr:title jcr:content/cq:lastReplicated',
  'p.guessTotal': 'true'
})
GET /bin/querybuilder.json?${params}

// Find testimonial components (all)
const params = new URLSearchParams({
  'path': '/content/capella/en',
  'type': 'nt:base',
  'nodename': 'testimonial',
  'p.limit': '1000',
  'p.hits': 'full'
})

// Find pages by program tag
const params = new URLSearchParams({
  'type': 'cq:Page',
  'path': '/content/capella/en',
  'tagid': `programs/${programId}`,
  'tagid.property': 'jcr:content/cq:tags',
  'p.limit': '200',
  'p.guessTotal': 'true'
})

// Paginated page listing — use p.guessTotal for performance
const params = new URLSearchParams({
  'type': 'cq:Page',
  'path': '/content/capella/en',
  'orderby': '@jcr:content/cq:lastModified',
  'orderby.sort': 'desc',
  'p.offset': String(offset),
  'p.limit': '20',
  'p.guessTotal': '100'   // exact count up to 100, "more" flag above
})

// Multiple paths with OR (group predicate)
const params = new URLSearchParams({
  'group.p.or': 'true',
  'group.1_path': '/content/capella/en/programs',
  'group.2_path': '/content/capella/en/about',
  'type': 'cq:Page',
  'p.limit': '200',
  'p.guessTotal': 'true'
})
```

**p.guessTotal guidance:**
- `p.guessTotal=true` — fastest, returns `more: true` when results exceed limit, no exact count
- `p.guessTotal=100` — exact count up to 100, then `more: true` — good for UI pagination display
- No guessTotal — exact count always, but slow for large result sets (reads entire set for access control)

## AEM Scraper — Playwright (Phase 1)

Capella's site is JS-rendered — static HTML fetch returns only navigation, not page body content. Playwright is required to get the fully rendered DOM.

```typescript
// packages/scraper/src/scraper.ts
async function scrapePage(url: string): Promise<{ assets: string[], testimonials: RawTestimonial[] }> {
  const page = await browser.newPage()
  try {
    await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 })
    
    // Extract assets from rendered DOM
    const assets = await page.evaluate(() => {
      const paths: string[] = []
      document.querySelectorAll('img[src], source[srcset], a[href], [data-src], [data-asset-path]')
        .forEach(el => {
          const val = el.getAttribute('src') || el.getAttribute('srcset') || 
                      el.getAttribute('href') || el.getAttribute('data-src') ||
                      el.getAttribute('data-asset-path') || ''
          if (val.includes('/content/dam/')) paths.push(val)  // see DAM_ROOT — not /capella/
        })
      return [...new Set(paths)]
    })

    // Extract testimonials from rendered DOM
    const testimonials = await page.evaluate(() => {
      const selectors = [
        '[data-component="testimonial"]',
        '.cmp-testimonial',
        '.testimonial',
        '.student-quote',
        'blockquote'
      ]
      const results: RawTestimonial[] = []
      selectors.forEach(selector => {
        document.querySelectorAll(selector).forEach(el => {
          results.push({
            quote_text: el.textContent?.trim() || '',
            raw_html: el.outerHTML,
            source_type: el.hasAttribute('data-component') ? 'structured_component' : 'hardcoded_text'
          })
        })
      })
      return results
    })

    return { assets, testimonials }
  } finally {
    await page.close()
  }
}
```

**Browser lifecycle — one shared browser instance per worker:**
```typescript
// Worker startup — reuse browser across jobs, don't launch per page
const browser = await chromium.launch({ headless: true })
process.on('SIGTERM', () => browser.close())
```

**Performance at scale:**
- Capella's site: ~3–5 seconds per page (JS render + network idle)
- 101 URLs from the audit doc: ~8–10 minutes total
- 1000 URLs: ~60–90 minutes — acceptable for a background job
- Run pages in batches of 5 concurrent Playwright pages (not 10 — Playwright is heavier than fetch)
- Reduce `SCRAPER_CONCURRENCY` default to 5 in `.env.example`

**Phase 2 upgrade path:**
When AEM API access is available, testimonial extraction switches to Query Builder — faster and more reliable than DOM parsing. Asset extraction (img src, srcset etc.) stays with Playwright since those are page-level references AEM doesn't expose via API.

**Asset references are not only attributes.** Capella builds hero and footer
banners as CSS `background-image`, and preloads images via `link[href]`. Attribute
selectors alone missed both images on the `12k-tuition-cap` page. Extraction must
cover, in this order of yield:

1. `img[src]`, `img[srcset]`, `source[src]`, `source[srcset]`, `a[href]`, `link[href]`, `[data-src]`, `[data-srcset]`, `[data-asset-path]`
2. `url()` inside an inline `style` attribute
3. `url()` inside the **computed** `background-image` of every element — catches
   backgrounds applied from a stylesheet, which no attribute exposes. Measured at
   5ms per ~2000 elements, so it is not capped.

Paths are normalized by `normalizeAssetPath`, which stops at the first character
that cannot appear in a URL path — a path lifted out of `url(...)` otherwise keeps
the trailing `);`.

**Testimonial selectors (priority order):**
```
[data-component="testimonial"]        → source_type: structured_component
.cmp-testimonial                      → source_type: structured_component
.testimonial, .student-quote          → source_type: structured_component
blockquote + [class*="name"]          → source_type: hardcoded_text
[class*="quote"] + [class*="student"] → source_type: hardcoded_text
```

**Testimonial deduplication:** Normalize `quote_text` (lowercase, strip punctuation) as fingerprint. Upsert on fingerprint. Conflicting `student_name`/`program` → set `needs_review = true`, never overwrite.

## pHash Duplicate Detection

- Compute pHash using `sharp` + `blockhash-core` when indexing each asset
- Store as `phash` string on the Asset model
- Hamming distance ≤ 10 = duplicate candidate
- Run as background job via BullMQ — never inline during scraping
- **A completed audit enqueues the sweep itself** (`scheduleIndexing` in
  `auditProcessor.ts`), along with the embedding sweep. Before that, both needed
  someone to remember `npm run crawl`, and the index silently fell behind every
  audit. Enqueue failures are logged and swallowed: the audit has already
  succeeded, so throwing would fail a finished job and force a full retry.
- Both sweeps coalesce on a fixed job id, so audits finishing together produce
  one sweep rather than several racing for the same rows. A fixed id requires
  `removeOnComplete: true` — BullMQ rejects a duplicate id against a *completed*
  job too, which otherwise makes the id permanently taken and silently no-ops
  every later sweep.
- `findNeedingPhash` must match `countHashedImages`: a row needs work only when
  **both** hashes are null. Selecting on `phash` alone re-selects every
  white-on-transparent logo forever, because those keep `phash = null` by design.
- Expose via `GET /api/v1/duplicates?threshold=10`

## Database

- All DB access via repository functions in `packages/db/repositories/`
- Use Prisma transactions when writing Asset + AssetPageReference together
- Required indexes: `assets.aem_path` (unique), `assets.phash`, `pages.url` (unique), `audit_jobs.status`, `testimonials.quote_fingerprint` (unique)
- Soft deletes only (`deleted_at`) — never hard delete, audit history must be preserved

## Video Intake — AEM Write Operations

All AEM write operations are isolated to `aemUploadService.ts`. No other service writes to AEM.
The intake write service account is separate from the read-only audit account — configure separately in env.

**Legal agreement validation — must run before any file upload begins:**
```typescript
// intakeService.ts — validate before processing
if (!body.legalAgreed || body.legalAgreed !== true) {
  return res.status(400).json({
    error: { code: 'LEGAL_AGREEMENT_REQUIRED', message: 'You must agree to the terms before submitting' }
  })
}
// Record agreement audit trail
const legalAgreedAt = new Date().toISOString()
const legalAgreedIp = req.ip
```

**Optional PDF upload — stored in tool DB, not pushed to AEM:**
```typescript
// If PDF uploaded, store locally and record path in VideoSubmission
// PDF is NOT uploaded to AEM — it is only available to approvers via the admin view
// Serve PDF via GET /api/v1/intake/:id/legal-doc (internal auth required)
```

```typescript
// 1. Upload video binary to AEM staging folder
POST /api/assets/sei/capella/intake/pending/{filename}
Authorization: Basic {AEM_INTAKE_WRITE_USER}:{AEM_INTAKE_WRITE_PASSWORD}
Content-Type: video/mp4
Body: binary stream — never buffer entire file in memory, pipe directly

// 2. Set metadata and intake tag immediately after upload
PUT /api/assets/sei/capella/intake/pending/{filename}/jcr:content/metadata
Body: {
  "dam:status": "pending-review",
  "dc:title": title,
  "dc:description": description,
  "cq:tags": [`programs/${program}`, `campaigns/${campaign}`],
  "dam:submittedBy": submitterEmail,
  "dam:usageRights": usageRights,
  "dam:rightsExpiry": rightsExpiryDate,
  "dam:intakeId": videoSubmissionId
}

// 3. On full approval — move asset to live DAM path
MOVE /content/dam/sei/capella/intake/pending/{filename}
Destination: /content/dam/sei/capella/{program}/videos/{filename}
Authorization: Basic {AEM_INTAKE_WRITE_USER}:{AEM_INTAKE_WRITE_PASSWORD}

// 4. Update status tag on live asset
PUT /api/assets/sei/capella/{program}/videos/{filename}/jcr:content/metadata
Body: { "dam:status": "approved" }
```

**Streaming upload — never buffer:**
```typescript
// Pipe multipart upload directly to AEM — do not load into memory
req.pipe(aemUploadRequest)
```

**Approval chain — gated by config:**
```typescript
// Sequential: notify next approver only after previous approves
// Parallel: notify all approvers immediately on submission
const mode = config.approvalChainMode // 'sequential' | 'parallel'
```

**Approval status transitions:**
```
submitted → pending_review
  → (sequential) legal_approved → marketing_approved → approved → [move to live DAM]
  → (parallel)   both legal_approved + marketing_approved → approved → [move to live DAM]
  → any approver rejects → rejected → [notify submitter with reason]
rejected → resubmitted (new VideoSubmission, parent_submission_id set)
```

**Email notifications (via notificationService.ts):**
- On submission: notify all relevant approvers (based on chain mode)
- On sequential approval: notify next approver in chain
- On full approval: notify submitter — video is live in DAM
- On rejection: notify submitter with `rejection_reason` from the VideoApproval record

## Transcription — Whisper API via BullMQ

Transcription runs as a background job — never inline with the upload request.

```
packages/queue/src/jobs.ts  → TranscriptionJob type
apps/worker/src/processors/transcriptionProcessor.ts  → job handler
apps/api/src/services/transcriptionService.ts  → enqueues job, updates DB
apps/api/src/services/vttService.ts  → generates VTT from Whisper response
apps/api/src/services/chapterService.ts  → LLM chapter detection from transcript
```

**Full transcription flow:**
```typescript
// 1. Enqueue after AEM upload completes
await transcriptionQueue.add('transcribe', { submissionId, aemStagingPath, filename })

// 2. Worker: extract audio with ffmpeg — temp file only
const tmpPath = `/tmp/${jobId}.mp3`
await execa('ffmpeg', ['-i', aemAssetUrl, '-vn', '-acodec', 'mp3', '-q:a', '4', tmpPath])

// 3. Send to Whisper API
const formData = new FormData()
formData.append('file', fs.createReadStream(tmpPath))
formData.append('model', 'whisper-1')
formData.append('response_format', 'verbose_json')  // word-level timestamps
formData.append('timestamp_granularities[]', 'word')
const response = await fetch('https://api.openai.com/v1/audio/transcriptions', {
  method: 'POST',
  headers: { Authorization: `Bearer ${config.openaiApiKey}` },
  body: formData
})

// 4. Delete temp file immediately — before any further processing
await fs.unlink(tmpPath)

// 5. Generate VTT from word timestamps
const vttContent = generateVtt(response.words)  // group words into caption blocks

// 6. LLM chapter detection
const chapters = await detectChapters(response.text)  // see chapterService.ts

// 7. Write VTT file to AEM
await aemUploadService.uploadFile(
  vttContent,
  `${aemStagingPath.replace('.mp4', '.vtt')}`,
  'text/vtt'
)

// 8. Write metadata back to AEM
await aemUploadService.updateMetadata(aemStagingPath, {
  'dam:transcriptStatus': 'complete',
  'dam:chapterMarkers': JSON.stringify(chapters)
})

// 9. Update VideoSubmission in DB
await videoSubmissionRepo.update(submissionId, {
  transcript: response.text,
  transcript_status: 'complete',
  transcript_duration_seconds: Math.round(response.duration),
  chapter_markers: chapters,
  vtt_aem_path: vttAemPath
})
```

**VTT generation — group words into blocks of ~7 seconds:**
```typescript
function generateVtt(words: WhisperWord[]): string {
  // Group words into caption blocks — max 7 seconds or natural sentence breaks
  // Format timestamps as HH:MM:SS.mmm
  // Return valid WebVTT string starting with 'WEBVTT\n\n'
}
```

**Chapter detection — single LLM call on transcript text:**
```typescript
// Use claude-sonnet-4-6 or gpt-4o-mini — transcript text only, no video
// Prompt: identify 3-7 topic shifts, return JSON [{ time: "HH:MM:SS", title: string }]
// Validate response is valid JSON before storing
// If LLM call fails, store transcript and VTT but set chapter_markers to null
```

**Whisper API 25MB audio limit:**
If extracted audio exceeds 25MB (approx. 45+ minute video at mp3 q:a 4):
- Split audio into overlapping chunks using ffmpeg segment filter
- Transcribe each chunk separately
- Merge transcripts with timestamp offsets applied
- Document this as a known edge case with a clear error if chunking fails

**Error handling:**
- ffmpeg failure → set transcript_status = 'failed', log error, do NOT block approval workflow
- Whisper API failure → retry 3 times with exponential backoff, then set transcript_status = 'failed'
- Temp file must be deleted in a finally block — even if transcription fails
- Transcription failure never blocks the approval workflow — approvers proceed without it
