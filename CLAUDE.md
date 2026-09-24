# SEI Site Auditor

Internal tool for auditing AEM DAM assets and testimonials across capella.edu — asset reverse lookup, live status, duplicate detection, testimonial search and page mapping, program coverage gaps, large-scale background job processing, and social performance tracking.

## Stack

- **Frontend:** React + TypeScript + Tailwind CSS (Vite)
- **Backend:** Node.js + Express + TypeScript
- **Database:** PostgreSQL (via Prisma ORM)
- **Job queue:** BullMQ + Redis (background audit jobs + transcription jobs)
- **Transcription:** OpenAI Whisper API + ffmpeg (audio extraction only — temp files deleted immediately)
- **Duplicate detection:** `sharp` + `blockhash-core` (perceptual hashing)
- **Scraping:** Playwright (headless Chromium) — required for JS-rendered pages

## Commands

```bash
npm run dev          # Start frontend (5173) + backend (3001) + worker concurrently
npm run dev:api      # Backend only
npm run dev:ui       # Frontend only
npm run dev:worker   # BullMQ worker only
npm run build        # Production build
npm run test         # Jest (unit + integration)
npm run test:e2e     # Playwright
npm run lint         # ESLint + TypeScript check
npm run db:migrate   # Run Prisma migrations
npm run db:seed      # Seed with sample Capella asset paths
npm run db:studio    # Open Prisma Studio
npm run crawl        # Force a pHash sweep — a completed audit queues one itself
```

## Project Structure

```
/
├── apps/
│   ├── api/         # Express backend
│   ├── worker/      # BullMQ worker process (audit job processor)
│   └── ui/          # React frontend
├── packages/
│   ├── db/          # Prisma schema + migrations
│   ├── queue/       # BullMQ queue definitions + job types (shared by api + worker)
│   ├── scraper/     # AEM HTML scraper + pHash engine + testimonial extractor
│   └── types/       # Shared TypeScript types
├── .claude/
│   └── rules/       # Modular instruction files (loaded per context)
├── .env.example
└── PRD.md           # Full product requirements — read before implementing features
```

See `.claude/rules/` for module-specific conventions.

## AEM Context

- Live site: `https://www.capella.edu`
- Asset base path: `/content/dam/` — **not** `/content/dam/capella/`, which the PRD
  specifies but the live site contradicts. Capella has been migrated into the shared SEI
  DAM, so most references are `/content/dam/sei/capella/...`, alongside `vc/`,
  `sei/global-logos/` and sibling-brand chrome. Filtering to `/content/dam/capella/`
  silently discarded ~73% of each page's assets. Brand is derived per asset via
  `damBrand()`. This applies to READS only — the intake write allowlist stays narrow.
- Page content path: `/content/capella/en/`
- Assets are publicly served — no auth needed for Phase 1 scraping
- AEM API access (Phase 2) requires a read-only service account from IT — see `.env.example`
- Query Builder endpoint: `GET /bin/querybuilder.json` — default limit is 10 hits, always set `p.limit` explicitly

## Environment

Copy `.env.example` to `.env` and fill in values. Never commit `.env`.
AEM credentials are optional in Phase 1 — the scraper falls back to public HTML parsing.

## Definition of Done

A feature is complete when:
1. The specified behavior works for the happy path and documented edge cases
2. A unit or integration test exists and passes
3. TypeScript compiles with zero errors (`npm run lint` passes)
4. No new `any` types introduced
5. Mobile viewport (375px) renders without layout breakage
