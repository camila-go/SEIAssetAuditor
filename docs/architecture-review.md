# Architecture review — 2026-09-21

Reviewed against the boundaries `.claude/rules/architecture.md` sets, by checking
them mechanically rather than by reading. Five checks, four clean.

| Boundary | Result |
|---|---|
| Prisma only in `packages/db/repositories/` | **1 violation**, fixed below |
| `process.env` only in `config.ts` | 1 accepted exception |
| UI never imports server packages | clean |
| `packages/*` never imports Express | clean |
| Worker imports `@capella/api/services`, not `@capella/api` | clean |

## Fixed: queries had leaked into the worker

`apps/worker/src/processors/embeddingProcessor.ts` ran four Prisma queries
directly — `findMany` and `update` against both `testimonial` and `asset`. Added
during the semantic-search work; it bypassed the repository layer entirely.

This is not a style point. The `where` clause in those queries carries a real
subtlety — the `OR: [{ embeddingModel: null }, …]` that exists because
`NOT (col = 'x')` is NULL for a NULL column and a WHERE drops NULL rows. Sitting
in a processor, that logic was invisible to anyone reading the repository and
impossible to reuse. It now lives in `assetRepo.findNeedingEmbedding` /
`setEmbedding` and the matching testimonial pair, with the reasoning at the
definition.

Verified by re-running the sweep: 65/65 assets and 4/4 testimonials embedded
through the new path, and the four search behaviours (exact, stemmed, semantic,
fuzzy) all still resolve.

## Not a violation, despite matching the grep

`auditProcessor.ts` calls `prisma.$transaction`, but only to obtain a `tx` that
it passes *into* repository functions. That is the sanctioned pattern — the rules
require Asset and AssetPageReference to be written in one transaction, and
`TxClient` is exported for exactly this. Left alone.

`packages/db/src/search.ts` and `semantic.ts` also use `prisma`. They are inside
the database package and are its query layer, not callers of it. Left alone.

## Accepted exception

`packages/db/src/client.ts` reads `process.env.NODE_ENV` twice — for the Prisma
log level and for the dev-only global client cache. The rule says config only,
but `packages/db` has no `config.ts` and giving it one to carry a single log-level
flag would be worse. Recorded here as deliberate rather than silently tolerated.

---

# ADR-001: Organise the dashboard by task, not by count

**Status:** Accepted · **Date:** 2026-09-21 · **Decider:** Camila Gonzalez

## Context

The dashboard had four sections: work in flight, needs attention, recent audits,
and a closing row of four totals. The ordering was deliberate and defensible —
state before reference material.

Two problems showed up in use:

1. **The totals were inert.** "65 assets" answers no question on its own, and it
   sat three sections away from the search box that would act on it.
2. **Nothing told a newcomer what the tool is for.** The first-run state does,
   but by definition it disappears the moment someone runs an audit — and this
   is a tool people get sent a link to.

## Decision

Replace the totals row with a task grid, and give each task the figure that
gives it scale. Add a permanent `/guide` page for the "what is this?" question.

## Options considered

### A. Keep the totals, add a separate task section
| Dimension | Assessment |
|---|---|
| Complexity | Low |
| Risk | Low |
| Cost | Dashboard grows a fifth section |

**Pros:** smallest change; nothing existing is disturbed.
**Cons:** the page gets longer while still answering "how many things are there"
in one place and "what can I do" in another. The totals stay inert.

### B. Fold the metrics into task tiles *(chosen)*
| Dimension | Assessment |
|---|---|
| Complexity | Low — one new component, one section removed |
| Risk | Low; no API or data change |
| Cost | Every tile wants a live number, and not every number is cheap to get |

**Pros:** removes a section rather than adding one. Each number appears on the
task it qualifies, so "65 indexed assets to search" states both the job and
whether the answer can be trusted yet. Tile size can then carry importance —
auditing is full-width because nothing else works until it has run.
**Cons:** a tile with no metric needs a deliberate empty state rather than
showing `0`. And the pull toward giving every tile a number is a trap — the
first attempt put an O(n²) query on the landing page to fill one in (see the
self-review below). A metric has to be cheap, or the tile goes without.

### C. A guided wizard on first visit
| Dimension | Assessment |
|---|---|
| Complexity | High |
| Risk | Medium — tours get skipped and then go stale |
| Cost | Ongoing maintenance per feature |

**Pros:** highest chance a first-timer reads something.
**Cons:** disproportionate for five tasks, and it answers the question once
rather than whenever it is asked. A permanent page is re-readable and linkable.

## Trade-off analysis

The real choice is between A and B, and it turns on whether totals deserve their
own region. They do not: a count is only meaningful next to the action it
constrains. B is also the only option that makes the page *shorter*.

C was rejected on proportionality, not on merit — with five tasks and a
one-screen guide, a tour is machinery around content that can simply be read.

## Consequences

**Easier:** a newcomer can see every job the tool does in one screen, with its
current scale. Adding a task is one entry in an array.

**Harder:** every figure on this page is now load-bearing for the landing page's
latency. That constraint bit immediately — the duplicates count was reverted for
exactly this reason — so a new tile's metric must come from an indexed count,
not from analysis.

**To revisit:** the tile order is a judgement about what people come to do,
based on the PRD rather than observed use. If audits get scheduled rather than
run by hand, "audit a set of pages" stops deserving the widest tile.

## Action items

1. [x] `TaskGrid` component; totals section removed
2. [x] `/guide` page, linked permanently from the header
3. [x] Recent audits moved below the task grid — it is history
4. [x] Verified at 1280px and 375px, no horizontal overflow
5. [ ] Revisit tile order once there is real usage data


---

# Self-review of the above changes — 2026-09-21

Four defects found by reviewing the session's own diff. All four were introduced
by that diff, not pre-existing.

## 1. Migrations would not have run (deploy-blocking)

`render.yaml` ran `npx prisma migrate deploy` as a pre-deploy step inside the
built container — but `prisma` was a devDependency and the runtime stage installs
with `--omit=dev`. The CLI simply was not there. `npx` would then try to fetch it
from the network mid-deploy: a hard failure on a restricted host, or a silent
version mismatch against the lockfile.

The confusing part is that it would not have looked like a migration problem. The
deploy fails at a step most people skim, and the app that follows it starts
against a schema-less database.

Fixed by moving `prisma` to a root `dependencies` block. It is genuinely a
runtime dependency of the deployed image now, so that is where it belongs.

## 2. The SPA fallback swallowed `/api`

`vercel.json` rewrote `/((?!assets/).*)` to `/index.html`, which matches
`/api/v1/anything`. If `VITE_API_ORIGIN` were ever unset or misspelled in
production, every API call would return the app's own HTML with a **200**, and
the UI's error path would report "Server returned a non-JSON response (HTTP
200)" on every screen.

A misconfiguration that produces 200s is far worse than one that produces 404s —
it looks like a bug in the application. Now excluded, so an unset origin fails
where the mistake actually is.

## 3. The landing page carried an O(n²) query

The duplicates tile showed a live group count, which meant calling `/duplicates`
on every dashboard load. That endpoint compares every hashed image against every
other one: 1,540 comparisons at today's 56 images (~6ms, measured), but ~500,000
at a thousand images and ~50,000,000 at ten thousand.

Fast today, quietly quadratic as the index grows, and on the one page everybody
opens. The metric is removed; the tile stands without it.

**Follow-up:** a cheap `GET /duplicates/count` — or reusing the two indexed
`count()` queries already behind pHash coverage — would let the number come back
without the pairwise scan.

## 4. A failed thumbnail could persist onto the next asset

`AssetPreview` stored failure as a plain boolean, so an instance reused for a
different `src` would keep showing the previous asset's "not publicly served"
placeholder.

Worth recording that **I could not reproduce this.** Every current call site
either keys its list by asset id or unmounts the block while loading, so the
component always remounts. The bug was real but masked by circumstance — and the
circumstance is incidental, not a guarantee. Fixed by storing *which* `src`
failed rather than a bare flag.

## Two things checked and cleared

- **An infinite loop in the embedding sweep.** The batch loop only advances by
  rows getting `embeddingModel` set, and a row is skipped when its vector is
  missing — so a short vector array would spin forever. Traced `embedBatch`: it
  maps over its input, so the lengths cannot diverge. Not reachable.
- **Missing Tailwind shades.** A script suggested ten `ink-*` classes were
  undeclared. The script's regex was at fault; grepping the built CSS confirmed
  every class is present. Reported here because a false positive that survives
  into a review is worse than one that never happens.
