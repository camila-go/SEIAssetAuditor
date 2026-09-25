# Handoff

Written for whoever picks this up next. It assumes you have not seen the tool
before and that the person who built it is not available to ask.

---

## What this is

An internal auditor for capella.edu. It reads pages the way a browser does and
records every DAM asset and testimonial it finds, then answers questions of that
index: where is this asset used, which images are duplicates, what testimonials
exist, what has disappeared from the site.

Built to PRD v1.5 (`PRD.md`). It runs, it has been pointed at the live site, and
**a snapshot of its real findings is committed to this repo** — 112 audited
pages, 779 assets, 46 testimonials, and every image that can be fingerprinted
fingerprinted (655 of 665; the other ten the site will not serve, or are a
single flat colour, and the tool names each one).

## Start here, in this order

1. **[`docs/readiness.md`](docs/readiness.md)** — what works today, what needs a
   credential, what needs a human decision. Read this first; it is the honest
   state of the thing.
2. **[`docs/open-questions.md`](docs/open-questions.md)** — every non-obvious
   decision and every bug found by running it, with the measurements. This is
   where the reasoning lives.
3. **[`README.md`](README.md)** — architecture and setup.
4. **`.claude/rules/`** — the conventions the code actually follows.

## Run it in ten minutes

```bash
npm install
cp .env.example .env          # defaults are fine; no credentials needed
npm run db:migrate
npm run db:restore            # loads the committed index — real findings
npm run dev
```

You need Node 20+, PostgreSQL and Redis. `README.md` documents how all three
were installed into `~/.local` without admin rights on the original machine, if
that helps.

`npm run db:restore` is the important one: without it you get an empty shell and
the tool looks like it does nothing.

## The four things it found that the PRD got wrong

These are the most valuable output of the project so far, and each one would
have shipped as a silent undercount — an empty result that looks like a clean
bill of health.

1. **The DAM root in the spec is the legacy one.** Capella has been migrated
   into the shared SEI DAM. The spec's `/content/dam/capella/` matched 14 assets
   where the real root matches 51 — three quarters of every page was being
   discarded.
2. **Assets are not only in attributes.** Hero and footer banners are CSS
   `background-image`; images are preloaded via `link[href]`. On one page that
   was 11 of 31 references, including both images a person would name.
3. **The prescribed page-load wait never fires.** The site holds analytics
   connections open, so `networkidle` never arrives. The first live audit failed
   3 of 3 URLs on timeout.
4. **None of the five testimonial selectors match anything.** Capella uses
   `.testimonialPromo`. Before the fix the tool reported zero testimonials
   sitewide, silently.

Sections 3, 4 and 8 of the PRD should be corrected before anyone else builds
from it.

## What is not done

- **No AEM instance was ever available.** Every Query Builder and Assets API
  call is unit-tested for shape but has never hit a real server. Phase 2 and the
  video intake write path are unproven.
- **The deployment image has never been built** — no Docker on the original
  machine. `Dockerfile` and `render.yaml` are reasoned from the dependency graph
  and validated against Render's spec, not executed.
- **Approver auth is a shared token**, pending an SSO decision.
- **Search thresholds were tuned on 46 testimonials.** They are measured, not
  guessed, but re-check them at real volume.

## What IT still has to grant

See [`docs/dam-permissions.md`](docs/dam-permissions.md) — written to hand over
directly. Two service accounts: one read-only for auditing, one write-scoped to
exactly two paths for video intake. Also a dispatcher rule blocking the intake
staging folder publicly, which the tool assumes and cannot enforce.

Until those exist, every Phase 2 feature returns a structured `501` with an
explanation. Nothing fails silently.

---

## Hosting, and what it costs

The UI is a static bundle and is free to host anywhere. The backend is not: it
needs a **persistent worker** driving a headless Chromium, plus Postgres and
Redis that survive restarts.

### Option A — read-only snapshot (free, no backend)

```bash
npm run build:static      # bakes the index into the bundle
```

Publishes to any static host for nothing. Browsing, search, duplicates and the
page maps all work against the committed snapshot; running new audits does not.
Every page carries a banner saying so. This is what to use for a demo or a
stakeholder link.

Deployed this way the tool is frozen at the snapshot date — refresh it with
`npm run db:snapshot` on a machine that has run audits.

### Option B — the real thing (~$14/month)

[`docs/deploy-runbook.md`](docs/deploy-runbook.md) is a click-by-click guide.
Render, from the committed `render.yaml`:

| Resource | Plan | Rough cost |
|---|---|---|
| API (web) | `1c-2g` | ~$7/mo |
| Worker | `2c-4g` | ~$7/mo minimum; more if you size up |
| Key Value (Redis) | `free` | $0 |
| Postgres | `0.1c-256mb` | ~$7/mo |

Call it **$14–21/month** depending on worker size. Check Render's current
pricing — these are the plan identifiers, not quotes.

Two things that are not optional:
- **Postgres must not be the free tier.** Render deletes a free database after
  30 days.
- **The worker must not be under 2GB.** Chromium at `SCRAPER_CONCURRENCY=5` gets
  OOM-killed on less, and it surfaces as every URL in a batch failing for no
  stated reason.

### Option A+ — free, and audits still run

The gap in Option A is that a snapshot cannot produce new findings. GitHub
Actions closes it.

`.github/workflows/audit.yml` runs the **real** tool — Chromium, Postgres,
Redis, the worker — inside an Actions job, then commits the refreshed index
back. The static site rebuilds on that push. It also runs the three-day
link-rot check on a schedule.

**Audits are started from the tool's own Audit page**, exactly as with a
backend: paste URLs, upload a CSV or give a sitemap, press **Start audit**. The
page follows the audit and loads the new findings when it finishes. Nobody
using the tool touches GitHub; the site's audit service (`api/run-audit.mjs`)
starts and watches the job. It needs a one-time access key and the right Vercel
Root Directory — see
[the free path in the runbook](docs/deploy-runbook.md#the-free-path--no-render-no-cost).
Each run also writes a summary to its GitHub page for whoever maintains the tool.

This repository is public, and **public repositories get unlimited Actions
minutes**, so it costs nothing. Nothing is always-on; the stack exists for the
minutes an audit takes and then goes away.

What you give up against Option B: results appear when the audit finishes and
the site has updated — a few minutes after — rather than page by page, and one
audit runs at a time. For a tool run occasionally against a set of URLs, that is
a small loss.

### What is not viable

Free always-on *hosting* — a backend sitting there answering requests. Render
offers no background workers on its free plan at all; free web services sleep
after 15 minutes, which kills a 60–90 minute audit; free Redis loses its data on
restart, taking the job queue with it. Fly and Railway have both removed their
free allowances. Checked against their documentation, not assumed.

That is what makes Option A+ the answer rather than a workaround: the tool does
not actually need to be always-on. It needs to crawl occasionally and serve
findings continuously, and those two halves can live in different places.

### Before real credentials go anywhere

This tool will eventually hold AEM service-account credentials and a complete
map of the site. Putting that on a third-party host is a procurement and
security decision at SEI, not a settings change.

---

## Where things live

| | |
|---|---|
| Code | `github.com/camila-go/SEIAssetAuditor` |
| Index snapshot | `packages/db/prisma/snapshot/` (2.9MB, restorable) |
| Reasoning and findings | `docs/open-questions.md` |
| Readiness assessment | `docs/readiness.md` |
| IT request | `docs/dam-permissions.md` |
| Deploy guide | `docs/deploy-runbook.md` |

The repo is under a personal GitHub account. **Transferring it to an SEI-owned
org should be the first thing that happens**, before access to that account
matters.
