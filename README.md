# SEI Site Auditor

Internal tooling to audit AEM DAM assets and testimonials across capella.edu,
plus a public video intake flow with legal and marketing approval.

Built to PRD v1.5. See [`PRD.md`](./PRD.md) and the conventions in
[`.claude/rules/`](./.claude/rules/).

> **Status: running and verified locally.** Type-checks clean, 218 tests pass,
> and a real audit has scraped live capella.edu pages end to end. See
> [What has actually been verified](#what-has-actually-been-verified) for the
> exact list, and [What has not](#what-has-not-been-verified) for the gaps.

---

## What it does

**Phase 1 — no AEM credentials needed**

- Bulk URL audit: paste URLs, upload a CSV/TXT, or import a sitemap. No cap.
- Background job queue with live progress — close the tab, come back, results
  stream in as batches land.
- Asset reverse lookup: paste a DAM path or public URL, see every page it is on.
- **Reverse image search**: drop in a picture (or paste an image URL) and find
  the matching DAM asset plus every page it appears on. Perceptual hashing, so
  it matches resized, recompressed and reformatted copies — not just identical
  files.
- Duplicate detection across indexed images, including renamed copies.
- Asset search and browse, with a direct link to the AEM path.
- Testimonial scraping (both AEM components and hardcoded text), search across
  quote / student / program, and a per-testimonial page map.
- **Hybrid search** on testimonials and assets — exact terms, stemming,
  meaning-based (semantic) retrieval, and typo tolerance, fused into one
  ranking. Every result says which of those found it.
- Public video intake with a blocking legal agreement, direct-to-AEM streaming
  upload, a legal + marketing approval chain, rejection with resubmission, and
  Whisper transcription with VTT captions and LLM chapter markers.

**Phase 2 — needs the read-only service account**

Accurate reverse lookup via Query Builder, rich asset metadata, authoritative
publish status from `cq:lastReplicated`, unused-asset flagging, testimonial
freshness, program coverage gaps, CSV export.

> The PRD files duplicate detection under Phase 2, but it needs no AEM access —
> DAM assets are publicly served, so the perceptual-hash index is built over
> plain HTTP. Verified working with every AEM flag off, so it ships in Phase 1
> along with reverse image search, which uses the same index.

**Phase 3 — needs social API credentials**

Asset-to-social-post linking and platform metrics. Scaffolded and gated; the
ranking formula is deliberately unimplemented pending a decision from Marketing.

Everything gated returns a structured `501` with an explanation, never a crash.

---

## Stack

React + TypeScript (Vite) · Node + Express · PostgreSQL via Prisma ·
BullMQ + Redis · Playwright (headless Chromium) · sharp + blockhash-core ·
transformers.js (local sentence embeddings) · OpenAI Whisper + ffmpeg ·
Anthropic SDK for chapter detection

---

## Setup

### Prerequisites

| | Why |
|---|---|
| Node 20+ | Runtime |
| PostgreSQL 14+ | Primary datastore |
| Redis 6+ | BullMQ job queue — **required**, audits cannot run without it |
| ffmpeg | Audio extraction for transcription. Optional: the worker logs a warning and disables transcription if it is missing. |

On macOS with Homebrew:

```bash
brew install node postgresql@16 redis ffmpeg && brew services start postgresql@16 && brew services start redis
```

### Local services on this machine (no Homebrew, no admin password)

This machine had none of the prerequisites and no admin rights, so they were
installed into `~/.local` instead. Nothing was written to a system path.

| | Where | Start it |
|---|---|---|
| Node 24.21.0 | `~/.local/opt/node` | on `PATH` via `~/.local/bin` |
| PostgreSQL 17.4 | `~/.local/var/capella-pg` | `pg_ctl -D ~/.local/var/capella-pg -l ~/.local/var/pg.log start` |
| Redis 8.10.1 | built from source | `redis-server --port 6379 --dir ~/.local/var/redis --save '' --appendonly no` |

Add `~/.local/bin` to your PATH first:

```bash
export PATH="$HOME/.local/bin:$PATH"
```

Postgres listens on **55432**, not 5432, so it cannot collide with a future
Homebrew install. That is what `.env` points at. ffmpeg is not installed, so
transcription is off — Playwright ships one at
`~/Library/Caches/ms-playwright/ffmpeg-1011/` if you want to wire it up.

### Install and run

```bash
npm install
```

```bash
cp .env.example .env
```

Fill in at minimum `DATABASE_URL`, `REDIS_URL`, and `AEM_PUBLIC_HOST`. Every
`*_ENABLED` flag can stay `false` — Phase 1 audit features need no credentials.

```bash
npm run db:migrate && npm run db:seed
```

```bash
npm run dev
```

That starts the UI (5173), API (3001), and worker concurrently. The worker is a
**separate process** — without it, audit jobs queue forever and never run.

### Other commands

```bash
npm run test          # Jest unit + integration
npm run test:e2e      # Playwright E2E (needs `npm run dev` running)
npm run lint          # ESLint + tsc
npm run db:studio     # Prisma Studio
npm run crawl         # Enqueue a pHash sweep by hand
```

---

## Architecture

```
UI (React)  →  API (Express)  →  Services  →  Repositories  →  PostgreSQL
                              ↘  BullMQ  →  Redis
                                      ↓
                                 Worker process
                                      ↓
                          Playwright scraper  →  PostgreSQL
                          Whisper + ffmpeg    →  AEM
```

- Route handlers are thin: validate, call a service, respond.
- Every Prisma query lives in `packages/db/src/repositories/`.
- The worker imports `@capella/api/services`, not `@capella/api` — the latter
  would boot an HTTP server inside the worker.
- No bulk audit is ever processed in a request. `POST /api/v1/audit` creates the
  job rows and returns a `jobId` immediately.

### Why the audit is resumable

The unit of work is a row in `audit_job_urls`, not a position in a queue. The
worker claims `pending` rows in batches, writes results, and updates counters
after each batch. A crash mid-job resumes from whatever is still `pending`; a
replayed batch recomputes counters from the rows rather than incrementing them,
so nothing is double-counted. One failed URL is recorded and skipped — it can
never abort a batch or a job.

### The AEM write boundary

`apps/api/src/services/aemUploadService.ts` is the only file that writes to AEM.
It runs as `capella-dam-intake-svc` (separate from the read-only audit account)
and rejects any path outside `AEM_INTAKE_STAGING_PATH` and
`AEM_INTAKE_LIVE_ROOT/{program}/videos/` before issuing a request — by default
`/content/dam/sei/capella/intake/pending/` and
`/content/dam/sei/capella/{program}/videos/`. The allowlist is derived from
those two config values rather than written out a second time, so the paths
granted to the service account and the paths enforced in code cannot drift. Video bytes
are piped browser → API → AEM and are never buffered in memory or written to
disk.

### How search works

Four independent passes run for every query and are fused with Reciprocal Rank
Fusion, weighted so a literal match always outranks a merely plausible one:

| Pass | Finds | Example |
|---|---|---|
| exact | every term present, any order, any field | `flexibility program` |
| stemmed | Postgres full text | `nurse` → "Nursing" |
| semantic | cosine over sentence embeddings | `scared about going back to school` → *"I came back to school… I was terrified"* |
| fuzzy | small edit distance on name/program | `Wbeb` → "Webb" |

Fused rather than replaced, deliberately. Semantic search alone reorders exact
matches in ways that read as broken — someone who types a filename expects that
file first, not a thematically similar one.

Embeddings come from **all-MiniLM-L6-v2 running locally** — no API key, no
per-query cost, and it works offline once `npm run embed:prewarm` has cached the
weights. bge-small-en-v1.5 was measured against it and rejected: it scores an
unrelated control query at 0.39, higher than several of MiniLM's correct
answers, so no threshold can separate signal from noise with it.

Similarity is computed in the application because this Postgres has no
`pgvector`. That is fine to roughly 100k rows; past that, install the extension
and swap `semanticSearch` for an indexed `<=>` query — the function is shaped
like that query so nothing else changes.

### The transcription temp-file boundary

ffmpeg extracts audio to `/tmp/{jobId}.mp3` and nothing else touches this
server's disk. That file is deleted in a `finally` block, on every path. The
VTT is generated as a string in memory and streamed to AEM. Transcription
failure never blocks the approval workflow.

---

## Before this can go live

1. **IT must grant the two service accounts** — see
   [`docs/dam-permissions.md`](./docs/dam-permissions.md), written as a request
   you can hand over directly.
2. **The dispatcher must block `/content/dam/sei/capella/intake/` publicly.** The
   tool assumes this and cannot enforce it. Staged videos are not approved for
   public use.
3. **Legal must approve the agreement copy** on the intake form. The current
   text is from the PRD and has not been reviewed.
4. **The approval chain mode must be decided** — sequential or parallel. Both
   are implemented; `APPROVAL_CHAIN_MODE` selects one.
5. **Replace the approver auth placeholder.** It is a shared bearer token. See
   [`docs/open-questions.md`](./docs/open-questions.md).

---

## What has actually been verified

Run locally against real PostgreSQL 17, Redis 8, and the live capella.edu site.

- `tsc --build` across all seven projects: **zero errors**.
- `eslint`: **clean**.
- `jest`: **218 tests, 13 suites, all passing**.
- Prisma migration applied to a real PostgreSQL database; seed script runs.
- API, worker and UI all boot; `/health` reports the phase flags.
- **A real audit ran end to end**: 3 URLs enqueued → BullMQ → worker →
  Playwright → 51 DAM assets across 8 brand folders and 4 testimonials
  extracted and persisted →
  results polled live through the API.
- One deliberately broken URL was correctly recorded as not-published with zero
  assets, and did not affect the other two — the "one bad URL never stops the
  job" rule holds in practice, not just in theory.
- Reverse lookup resolves a public URL, a rendition URL and a bare DAM path to
  the same asset, and returns the pages it appears on.
- Phase 2/3 gating returns structured 501s; internal auth fails closed; the
  legal-agreement gate blocks a submission server-side.
- UI renders at 375px with no horizontal overflow.

### Deviations from the rules, forced by the live site

Two things in `.claude/rules/` do not survive contact with capella.edu. Both are
documented at the call site and covered by tests:

1. **`waitUntil: 'networkidle'` never fires.** The site holds analytics
   connections open indefinitely, so every navigation hit the 30s timeout and
   the first live audit failed 100% of its URLs. `scraper.ts` now uses
   `waitUntil: 'load'` (~1.8s) plus a short best-effort settle.
2. **The DAM root in the PRD is wrong.** The rules say to index only
   `/content/dam/capella/`. On the live site that is a small minority — Capella has
   been migrated into the shared SEI DAM, so most assets are under
   `/content/dam/sei/capella/`, alongside `vc/`, `sei/global-logos/` and sibling-brand
   chrome. Measured on three pages, the narrow prefix matched 14 assets where the full
   DAM root matches 51, so roughly three quarters of every page was being discarded
   without warning. `DAM_ROOT` is now `/content/dam/` and `damBrand()` recovers the
   brand per asset. **Reads only** — the intake write allowlist is a separate literal
   and is unchanged.
3. **Assets are referenced in ways the prescribed selectors miss.** The rules
   list `img[src]`, `source[srcset]`, `a[href]` and the `data-` attributes.
   Capella's hero and footer banners are CSS `background-image` values, and
   preloaded images are `link[href]` — on the `12k-tuition-cap` page that is 11
   of 31 references, including both images a person would actually name. The
   scraper now also parses `url()` out of inline styles and computed
   backgrounds.
4. **None of the five prescribed testimonial selectors match.** Capella uses
   `.testimonialPromo` / `.testimonial-promo`, and `.testimonial` is an exact
   class match that misses both. A substring selector was added. The attribution
   also has no dash — the markup is
   `"quote" Name* Degree *Legal disclaimer` in a single element, so the parser
   now splits on the quotation marks.

## What has not been verified

- **No AEM instance was available.** Every Query Builder and Assets API request
  shape is written from the PRD and unit-tested for parameter correctness, but
  has never hit a real server. Phase 2 and the video intake write path are
  therefore unproven against AEM.
- **Transcription has not run.** It needs an OpenAI key and a video in AEM
  staging, both unavailable. The pure parts (VTT generation, chapter
  sanitization) are tested; ffmpeg invocation and the Whisper call are not.
- **Email notifications have not been sent** — no SMTP host configured, so they
  log instead.
- **Only 3 URLs have been scraped.** Behaviour at 1000 URLs, and the
  90-minute success metric, are untested.
- **Semantic search is tuned against a 4-testimonial corpus.** The thresholds
  (0.30 floor, 0.85 relative cutoff) are measured, not guessed, but they should
  be re-checked once real volume exists. Ranking between two closely related
  quotes is the weak spot: "juggling a job with school" picks a defensible but
  arguably second-best result.
- **Asset semantic search is limited by having only filenames to embed.** It
  improves on its own when AEM supplies titles and tags in Phase 2 — the tags
  are already included in the embedded text.
- The publish-status heuristic is validated only on one 404 and two live pages.
