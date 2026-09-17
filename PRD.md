# PRD — Capella DAM Asset Intelligence Tool

Read this before implementing any feature. This is the source of truth for what the tool does and why.

## Problem

The Capella design team audits digital assets and content manually — clicking through pages one by one to find which images are live, whether those pages are published, whether duplicate assets exist in the DAM, and where testimonials appear across the site. At tens of thousands of assets, hundreds of pages, and audits that span 1000+ URLs, this is completely unsustainable. Testimonials are especially difficult: stored as both reusable AEM components and hardcoded text, they must be searchable by quote, student name, and program, and audited for freshness and coverage gaps across degree programs.

Additionally, there is no structured intake process for video assets. Internal staff and external vendors submit videos through ad hoc channels (email, shared drives), bypassing legal and marketing review, and assets land in the DAM without consistent metadata, tagging, or approval status. This creates legal exposure and brand inconsistency.

## Users

- **Primary:** Product designers and content designers at Capella
- **Secondary:** Marketing team members tracking asset performance and testimonial coverage
- **Video submitters:** Internal Capella staff and external vendors/agencies submitting video assets for approval
- **Approvers:** Legal team and marketing team reviewing submitted videos before DAM publish

## Phased Scope

### Phase 1 — No AEM auth required (build now)

| Feature | Description |
|---|---|
| Bulk URL audit | Upload CSV/TXT or paste URLs — no cap, processed as a background job |
| Audit job tracking | Real-time progress bar, streaming results, close the tab and come back |
| Sitemap import | Paste a sitemap URL and the tool extracts all page URLs automatically |
| Asset reverse lookup | Paste a DAM asset URL → see every page it appears on + live status |
| Asset search | Search indexed assets by filename or path |
| Direct AEM link | Every asset links to its `/content/dam/capella/...` path in AEM |
| Live status | Pages show Published / Draft badge based on scraped signals |
| Testimonial scraping | Detect both AEM components and hardcoded text testimonials from live pages |
| Testimonial search | Search by keyword/quote text, student name, or program — single input |
| Testimonial page map | For any testimonial, see every page it appears on + live status |
| **Video intake form** | Public-facing form for internal staff and external vendors to submit videos |
| **Legal agreement** | Checkbox agreement to terms of use blocks submission — optional signed PDF upload for supplementary contracts |
| **Video staging in AEM** | Uploads go directly to AEM DAM staging folder — restricted, not publicly accessible |
| **Approval workflow** | Tracks legal and marketing approvals — configurable sequential or parallel |
| **Rejection with resubmission** | Rejected submissions notify the submitter with a reason and allow resubmission |
| **Auto-transcription** | On upload, tool extracts audio, sends to Whisper API, returns full transcript with word-level timestamps |
| **VTT caption file** | Generated from transcript and uploaded to AEM DAM alongside the video |
| **Chapter markers** | LLM pass over transcript detects topic shifts and generates chapter titles + timestamps as metadata |
| **Transcript in admin review** | Approvers see full transcript and chapters in the submission detail view |

**Data source:** Playwright headless Chromium scraper against `https://www.capella.edu`. Capella's site is JS-rendered — a static HTML fetch returns only navigation, not page body content. Playwright waits for `networkidle` before extracting the fully rendered DOM, then pulls `/content/dam/` asset references and testimonial components in a single pass per page.

**Scale architecture — job queue (required for 1000+ URLs):**

Audit jobs run as background tasks, not synchronous API requests. A 1000-URL audit takes 20–40 minutes at safe scraping rates and would time out as a single HTTP request.

```
User uploads CSV / pastes URLs / imports sitemap URL
        ↓
POST /api/v1/audit → creates AuditJob record → returns { jobId }
        ↓
BullMQ worker processes pages in batches of 10
        ↓
Progress written to DB after each batch
        ↓
UI polls GET /api/v1/audit/:jobId/status → live progress bar
        ↓
Results queryable as they arrive (no waiting for full completion)
        ↓
Job complete → full results + CSV export available
```

- Redis required for BullMQ job queue
- Worker runs as a separate process (`npm run dev:worker`)
- Jobs are resumable — if the worker crashes, it picks up from the last completed batch
- Rate limit: 10 concurrent requests per job, 200ms delay (safe for CDN-served site)
- One failed URL never stops the whole job — mark failed, continue

**Video intake architecture:**

The intake form is the only part of this tool that writes to AEM. The video file is uploaded directly to a restricted AEM DAM staging folder and never held in this tool's own storage.

```
Submitter fills intake form (public — no AEM credentials required)
        ↓
Submitter must check legal agreement checkbox before form can be submitted
(Submission is blocked entirely until checkbox is checked)
Submitter may optionally upload a signed PDF (vendor contract, talent release, etc.)
        ↓
Tool uploads video to AEM DAM via Assets HTTP API:
  POST /api/assets/capella/intake/pending/{filename}
        ↓
AEM applies intake tag: dam:status = pending-review
Asset stored at: /content/dam/capella/intake/pending/
Dispatcher blocks public access to /content/dam/capella/intake/ entirely
        ↓
VideoSubmission record created in tool DB — tracks metadata + approval state
        ↓
Transcription job triggered automatically (see Transcription Architecture below)
        ↓
Approvers notified by email — transcript and chapters available in review view
        ↓
Legal reviews → approves or rejects (with reason)
Marketing reviews → approves or rejects (with reason)
        ↓
All required approvals collected
        ↓
Tool moves asset via AEM API:
  MOVE /content/dam/capella/intake/pending/{filename}
    to /content/dam/capella/{program}/videos/{filename}
Tool applies approved tags and metadata via Assets REST API
Asset is now in the live DAM — ready for a content author to use on pages
        ↓
OR: Any approver rejects →
  dam:status updated to rejected
  Submitter notified by email with rejection reason
  Asset stays in /intake/pending/ but flagged rejected
  Submitter can resubmit — creates a new VideoSubmission record (new version)
```

**AEM API calls for video intake (requires write-enabled service account — separate from read-only audit account):**

```
# Upload video to staging folder
POST /api/assets/capella/intake/pending/{filename}
Content-Type: video/mp4  (or video/quicktime etc.)
Authorization: Basic {writeServiceAccountCredentials}
Body: binary video file

# Apply metadata and tags after upload
PUT /api/assets/capella/intake/pending/{filename}/jcr:content/metadata
Body: {
  "dam:status": "pending-review",
  "dc:title": "{title}",
  "dc:description": "{description}",
  "cq:tags": ["programs/{program}", "campaigns/{campaign}"],
  "dam:submittedBy": "{submitterEmail}",
  "dam:usageRights": "{usageRights}",
  "dam:rightsExpiry": "{expiryDate}",
  "dam:legalAgreed": "true",
  "dam:legalAgreedAt": "{isoTimestamp}",
  "dam:legalDocUploaded": "true|false",
  "dam:intakeId": "{videoSubmissionId}"
}

# Move asset to live DAM path on approval
MOVE /content/dam/capella/intake/pending/{filename}
Destination: /content/dam/capella/{program}/videos/{filename}
Authorization: Basic {writeServiceAccountCredentials}

# Update status tag
PUT /api/assets/capella/{program}/videos/{filename}/jcr:content/metadata
Body: { "dam:status": "approved" }
```

**Transcription architecture — no video stored in app:**

```
Video upload to AEM staging completes
        ↓
BullMQ transcription job enqueued (async — does not block submission response)
        ↓
Worker: fetch audio stream only from AEM staging URL
  ffmpeg -i {aemStagingUrl} -vn -acodec mp3 /tmp/{jobId}.mp3
  (Audio only — ~10MB for a 10-minute video vs ~500MB for video)
        ↓
Audio file sent to OpenAI Whisper API
  POST https://api.openai.com/v1/audio/transcriptions
  model: whisper-1
  response_format: verbose_json  (returns word-level timestamps)
        ↓
Temp audio file deleted immediately: rm /tmp/{jobId}.mp3
        ↓
Tool generates from Whisper response:
  1. Full transcript text (stored in VideoSubmission.transcript)
  2. .vtt caption file (generated from word timestamps, grouped into caption blocks)
  3. Chapter markers (LLM pass on transcript → detects topic shifts → generates titles + timestamps)
        ↓
Tool writes back to AEM:
  POST /api/assets/capella/intake/pending/{filename}.vtt  ← caption file in DAM
  PUT  /api/assets/capella/intake/pending/{filename}/jcr:content/metadata
       { "dam:transcriptStatus": "complete",
         "dam:chapterMarkers": "[{time: 0, title: 'Introduction'}, ...]" }
        ↓
VideoSubmission.transcript_status updated to 'complete'
Transcript + chapters visible in admin review view
```

**Transcription cost estimate:**
- Whisper API: $0.006 per minute of audio
- 10-minute video: ~$0.06
- 100 videos per month: ~$6.00
- Temp audio storage: seconds only, negligible

**VTT file format generated:**
```
WEBVTT

00:00:00.000 --> 00:00:04.500
Welcome to Capella University's online learning program.

00:00:04.500 --> 00:00:09.200
Today we'll be covering the foundations of your degree path.
```

**Chapter marker format stored in AEM metadata:**
```json
[
  { "time": "00:00:00", "title": "Introduction" },
  { "time": "00:02:14", "title": "Program Overview" },
  { "time": "00:05:47", "title": "Next Steps" }
]
```

**Chapter detection prompt (LLM pass — runs on transcript text only):**
```
Given this video transcript with timestamps, identify 3-7 major topic shifts
and return chapter markers as JSON: [{ time: "HH:MM:SS", title: "Chapter Title" }].
Keep chapter titles concise (under 5 words). Return JSON only.
```

**Approval chain — configurable (TBD pending stakeholder alignment):**

The order of legal vs marketing review is not yet decided. The tool must support both modes via a config flag:

```
APPROVAL_CHAIN_MODE=sequential   # legal → marketing → publish
APPROVAL_CHAIN_MODE=parallel     # legal + marketing simultaneously → both must approve → publish
```

In sequential mode, the next approver is only notified after the previous one approves. In parallel mode, both are notified immediately on submission.

**Intake metadata captured at submission:**

| Field | Required | Notes |
|---|---|---|
| Video file | Yes | MP4, MOV, WebM — max 2GB |
| Title | Yes | Becomes `dc:title` in AEM |
| Description | Yes | Becomes `dc:description` |
| Program | Yes | Maps to `cq:tags` program tag |
| Campaign or project | Yes | Maps to `cq:tags` campaign tag |
| Usage rights | Yes | Free text — e.g. "Licensed for digital use only" |
| Usage expiry date | Yes | Date field — alerts generated before expiry |
| Submitter name | Yes | Stored in submission record |
| Submitter email | Yes | Used for approval/rejection notifications |
| Submitter organization | Yes | Internal Capella dept or external agency name |
| **Legal agreement checkbox** | **Yes — blocks submission if unchecked** | Submitter confirms they have rights to submit this video and agrees to Capella's terms of use. Timestamp and IP address recorded on agreement. |
| **Signed legal document (PDF)** | No — optional | Upload of a supplementary signed agreement (vendor contract, talent release, licensing doc). Stored in tool DB, not pushed to AEM. Visible to approvers in the admin review view. |
| Additional notes | No | Free text for context to approvers |

**Legal agreement terms copy (placeholder — legal team must approve final wording):**

> "I confirm that I have all necessary rights, licenses, and permissions to submit this video for use by Capella University, including rights to any individuals appearing in the video, music, and other third-party content. I agree that Capella University may use this video for educational and marketing purposes as described in my submission. Submitting this form does not guarantee the video will be approved or published."

The checkbox label must link to the full terms document hosted separately. Legal team owns the terms copy.
- AEM components: look for `[data-component="testimonial"]`, `.cmp-testimonial`, `.testimonial`, `.student-quote`
- Hardcoded text: look for quote patterns near a student name + program string
- Flag source type on every record: `structured_component` or `hardcoded_text`
- Store raw extracted HTML alongside normalized fields so edge cases can be reviewed

### Phase 2 — With AEM API access (pending IT approval)

| Feature | Description |
|---|---|
| Accurate reverse lookup | Query Builder API — find all pages referencing a given asset path |
| Rich asset metadata | Asset dimensions, tags, file size via AEM Assets REST API |
| Accurate publish status | Read `cq:lastReplicated` from page JCR node |
| Duplicate detection | pHash comparison across all indexed assets |
| Unused asset flagging | Assets with zero page references across the indexed site |
| Structured testimonial extraction | Query AEM directly for testimonial components via Query Builder |
| Testimonial freshness flagging | Flag testimonials not seen on any live page in 90+ days |
| Program coverage gaps | Show which degree programs have zero or fewer than 3 live testimonials |
| CSV export | All audit results downloadable — assets and testimonials |

### Phase 3 — Social performance (requires social API credentials)

| Feature | Description |
|---|---|
| Social post linking | Manually link an AEM asset → a social post URL (stored in tool's own DB) |
| Platform metrics | Pull views, engagement from Meta, TikTok, YouTube, LinkedIn APIs |
| Performance ranking | Rank assets by engagement across platforms with recency weighting |

## Key Data Models

```
Asset
  id, aem_path (unique), filename, asset_type
  width, height, file_size, tags[]
  last_seen_at, phash, is_indexed, deleted_at

Page
  id, url (unique), title
  is_published, last_replicated_at, last_crawled_at, deleted_at

AssetPageReference
  id, asset_id → Asset, page_id → Page, discovered_at

AuditJob
  id, name, status (queued | running | complete | failed | cancelled)
  input_type (paste | csv_upload | sitemap)
  total_urls, completed_urls, failed_urls
  created_at, started_at, completed_at, created_by, error_message

AuditJobUrl
  id, job_id → AuditJob, url
  status (pending | done | failed), processed_at, error

VideoSubmission
  id, title, description, program, campaign
  usage_rights, rights_expiry_date
  submitter_name, submitter_email, submitter_org
  notes, filename, file_size, mime_type
  legal_agreed (bool — always true if record exists, submission blocked otherwise)
  legal_agreed_at (timestamp)
  legal_agreed_ip (IP address — recorded for audit trail)
  legal_doc_filename (nullable — original filename of uploaded PDF)
  legal_doc_stored_path (nullable — internal storage path of PDF, not pushed to AEM)
  transcript (nullable — full transcript text from Whisper)
  transcript_status (pending | processing | complete | failed)
  transcript_duration_seconds (nullable)
  chapter_markers (nullable — JSON array of { time, title })
  vtt_aem_path (nullable — path of .vtt file in AEM DAM)
  aem_staging_path (/content/dam/capella/intake/pending/{filename})
  aem_final_path (nullable — set on approval)
  status (draft | pending_review | legal_approved | marketing_approved | approved | rejected | resubmitted)
  rejection_reason (nullable)
  parent_submission_id (nullable — set when this is a resubmission)
  submitted_at, updated_at

VideoApproval
  id, submission_id → VideoSubmission
  approver_type (legal | marketing)
  approver_email, decision (approved | rejected)
  reason (nullable), decided_at

Testimonial
  id, quote_text, quote_fingerprint (unique — normalized)
  student_name, program, degree_level
  source_type: structured_component | hardcoded_text
  raw_html, aem_component_path (nullable — Phase 2)
  needs_review (bool), first_seen_at, last_seen_at, is_active, deleted_at

TestimonialPageReference
  id, testimonial_id → Testimonial, page_id → Page
  position_on_page, discovered_at

SocialLink  (Phase 3)
  id, asset_id → Asset, platform, post_url, post_id
  metrics_json, last_fetched_at
```

**Testimonial deduplication:** Normalize `quote_text` (lowercase, strip punctuation) as unique fingerprint. Upsert on fingerprint. If `student_name` or `program` conflicts between pages for the same fingerprint, set `needs_review = true` — never silently overwrite.

## AEM API Endpoints (Phase 2)

All Query Builder calls go to `GET /bin/querybuilder.json` on the AEM author instance. Responses are JSON. **By default the servlet returns a maximum of 10 hits — always set `p.limit` explicitly.**

```
# ── Asset metadata ────────────────────────────────────────────────────
GET /api/assets/capella/{path}.json
# Returns: dimensions, tags, file size, last modified

GET /content/dam/capella/{path}.references.json
# Returns: pages referencing this asset (alternate endpoint)

# ── Which pages reference a specific asset ────────────────────────────
GET /bin/querybuilder.json
  ?path=/content/capella/en
  &type=nt:base
  &property=fileReference
  &property.value=/content/dam/capella/images/hero.jpg
  &p.limit=500
  &p.hits=selective
  &p.properties=path jcr:content/jcr:title jcr:content/cq:lastReplicated

# ── Find all pages ordered by last modified (descending) ──────────────
GET /bin/querybuilder.json
  ?type=cq:Page
  &path=/content/capella/en
  &orderby=@jcr:content/cq:lastModified
  &orderby.sort=desc
  &p.limit=100
  &p.guessTotal=true

# ── Find pages by program tag ─────────────────────────────────────────
GET /bin/querybuilder.json
  ?type=cq:Page
  &path=/content/capella/en
  &tagid=programs/masters-degree
  &tagid.property=jcr:content/cq:tags
  &p.limit=200
  &p.guessTotal=true

# ── Find all testimonial components ──────────────────────────────────
GET /bin/querybuilder.json
  ?path=/content/capella/en
  &type=nt:base
  &nodename=testimonial
  &p.limit=1000
  &p.hits=full

# ── Find testimonial components filtered by program tag ───────────────
GET /bin/querybuilder.json
  ?path=/content/capella/en
  &type=capella/components/testimonial
  &property=cq:tags
  &property.value=programs/masters-degree
  &p.limit=500
  &p.hits=selective
  &p.properties=path jcr:content/quote jcr:content/studentName jcr:content/program

# ── Search across multiple paths using OR group ───────────────────────
GET /bin/querybuilder.json
  ?group.p.or=true
  &group.1_path=/content/capella/en/programs
  &group.2_path=/content/capella/en/about
  &type=cq:Page
  &p.limit=200
  &p.guessTotal=true

# ── Paginated results with guessTotal ─────────────────────────────────
GET /bin/querybuilder.json
  ?type=cq:Page
  &path=/content/capella/en
  &p.offset=0
  &p.limit=20
  &p.guessTotal=100
# If total < 100 → exact count returned
# If total > 100 → response includes "more: true"
```

**Key Query Builder parameters — reference:**

| Parameter | Purpose |
|---|---|
| `p.limit` | Max results returned. Always set explicitly. Use `-1` for all results (use with caution on large sets) |
| `p.offset` | Pagination start index |
| `p.guessTotal=true` | Fast pagination — avoids full result set count, major perf gain at scale. Returns `more: true` when results exceed limit |
| `p.guessTotal=N` | Count up to N exactly, then return `more: true` beyond that — best of both worlds |
| `p.hits=full` | Return all properties per node |
| `p.hits=selective` | Return only properties listed in `p.properties` — always prefer this to reduce payload |
| `p.properties` | Space-separated property list for `selective` mode, e.g. `path jcr:content/jcr:title` |
| `orderby` | Property to sort by, prefix with `@` for JCR property: `@jcr:content/cq:lastModified` |
| `orderby.sort` | `asc` or `desc` |
| `group.p.or=true` | Combine predicates in group with OR instead of default AND |
| `N_property` | Numeric prefix to use same predicate multiple times: `1_property`, `2_property` |
| `property.N_value` | Multiple values for one property predicate: `property.1_value=A`, `property.2_value=B` |
| `tagid` | Match by tag ID — use with `tagid.property=jcr:content/cq:tags` |
| `type` | JCR node type filter: `cq:Page`, `nt:base`, `dam:Asset`, `nt:file` |
| `nodename` | Filter by node name, supports wildcards: `nodename=*.jar` |

**Performance note:** For large result sets (thousands of pages) always use `p.guessTotal=true` or `p.guessTotal=N` instead of letting Query Builder count exact totals. Exact counts require checking every result for access control and reading the entire result set — this is a significant difference in execution time and memory at scale.

## Testimonial Scraping Selectors (Phase 1)

The scraper must detect testimonials using these patterns — in priority order:

```
1. [data-component="testimonial"]        AEM component data attribute
2. .cmp-testimonial                      AEM Core Components class
3. .testimonial, .student-quote          Capella custom classes
4. blockquote + [class*="name"]          Quote + attribution pattern
5. [class*="quote"] + [class*="student"] Generic quote + student combo
```

For each match, extract:
- `quote_text` — the visible quote string (strip HTML tags)
- `student_name` — text matching pattern: `— Name` or `- Name` or nearby `.name` element
- `program` — text matching known Capella degree/program strings, or nearby `.program` element
- `raw_html` — the full matched element's outer HTML

## Non-Goals

- Do NOT write to AEM except for the video intake flow — all other operations are read-only
- Do NOT host or store video files — upload directly to AEM DAM, never buffer in this tool
- Do NOT build a full DAM or video management platform — intake and approval only
- Do NOT build a social publishing tool
- Do NOT replace AEM's native DAM interface
- Do NOT attempt to verify whether a testimonial is still accurate or from a current student — flag for human review only
- Do NOT process bulk audits synchronously — all multi-URL jobs must use the job queue
- Do NOT publish AEM pages automatically — video approval moves the asset to the live DAM path only; a content author still places it on pages

## Success Metrics

- 1000-URL audit completes in under 45 minutes as a background job
- Asset reverse lookup returns results in under 5 seconds
- Testimonial search returns results in under 2 seconds
- Program coverage gaps view loads in under 3 seconds
- Audit results are queryable before the job completes (streaming results)
- Video intake form submission completes (including AEM upload) in under 60 seconds for files up to 500MB
- Transcription completes within 3 minutes of upload for videos up to 30 minutes long
- Approvers notified within 5 minutes of submission or prior approval
- Rejected submitters receive email with reason within 5 minutes of rejection decision
- 80% of design team uses the tool within 30 days of launch

## Open Questions — Video Intake

These must be resolved with stakeholders before video intake ships:

| Question | Owner | Blocking? |
|---|---|---|
| Sequential or parallel approval chain — legal first, or simultaneous? | Legal + Marketing leads | Yes |
| Who are the named approvers for legal? Is it a team inbox or individuals? | Legal | Yes |
| Who are the named approvers for marketing? | Marketing | Yes |
| Does approval automatically make the asset usable, or does a content author still need to place it? | Content team | Yes |
| Should the intake form require a Capella SSO login for internal submitters, or be fully public? | IT / Security | Yes |
| Max file size — 2GB is proposed, is that feasible for AEM asset upload API? | AEM Engineering / IT | Yes |
| **Legal team must review and approve the checkbox agreement terms copy before launch** | **Legal** | **Yes** |
| **Where should the full terms of use document be hosted, and who owns it?** | **Legal** | **Yes** |
| **Should the optional signed PDF upload be stored in this tool's DB or pushed to a document management system?** | **Legal** | **No — default is tool DB** |
| Does Capella's AEM license include Adobe Sensei smart content / transcription services? If yes, use that instead of Whisper | AEM admin / IT | No — check before building |
| Is ffmpeg available on the server environment, or does it need to be provisioned? | IT / DevOps | Yes — required for audio extraction |
| What is the maximum expected video length? Whisper API has a 25MB audio file limit — longer videos need chunking | Engineering | Yes |
| What happens to rejected assets after 90 days — auto-delete from staging? | Legal / DAM admin | No |
| Should approvers be able to add comments visible to other approvers, or just to the submitter? | Marketing / Legal | No |
