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
| Cost | Every tile needs a live number, so the duplicates count is now fetched on the dashboard |

**Pros:** removes a section rather than adding one. Each number appears on the
task it qualifies, so "65 indexed assets to search" states both the job and
whether the answer can be trusted yet. Tile size can then carry importance —
auditing is full-width because nothing else works until it has run.
**Cons:** one extra request on load (`/duplicates`). A tile with no metric needs
a deliberate empty state rather than showing `0`.

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

**Harder:** the dashboard now depends on `/duplicates`, so that endpoint being
slow is felt on the landing page. It is a bounded pairwise comparison over
hashed images, fine at this size, worth watching past a few thousand.

**To revisit:** the tile order is a judgement about what people come to do,
based on the PRD rather than observed use. If audits get scheduled rather than
run by hand, "audit a set of pages" stops deserving the widest tile.

## Action items

1. [x] `TaskGrid` component; totals section removed
2. [x] `/guide` page, linked permanently from the header
3. [x] Recent audits moved below the task grid — it is history
4. [x] Verified at 1280px and 375px, no horizontal overflow
5. [ ] Revisit tile order once there is real usage data
