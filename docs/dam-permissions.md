# DAM Permissions Request — SEI Site Auditor

**For:** Capella IT / AEM administration
**From:** Product Design Team
**Source:** PRD v1.5 §7

This is the access the tool needs. Two service accounts are requested rather
than one, so that a compromise of either has a limited blast radius. Neither
account can publish, replicate, or delete.

---

## Account 1 — `capella-dam-audit-svc` (read-only)

Powers asset metadata, page-reference lookups, Query Builder queries, and
accurate publish status. Required for Phase 2 audit features.

| Permission | Path | Why |
|---|---|---|
| `dam:read` | `/content/dam/` | Read asset metadata and browse the DAM |
| `jcr:read` | `/content/dam/` | Read JCR properties including `cq:tags`, `dc:title` |
| `jcr:read` | `/content/capella/en/` | Read page content nodes for reference lookups |
| Access to `/bin/querybuilder.json` | Author instance only | Query Builder — dispatcher-blocked by default |
| Access to `/api/assets/` | Author instance only | Assets REST API |

### Explicitly NOT requested

- `dam:create`, `dam:modify`, `dam:delete`
- `jcr:write` anywhere
- `crx:replicate` — the tool never publishes
- Membership in `dam-administrators`
- Any access to the publish instance

---

## Account 2 — `capella-dam-intake-svc` (write, scoped to intake)

Powers video intake: upload to staging, metadata writes, and the move to the
live DAM on approval. Write access is deliberately narrow — two paths, nothing
else.

| Permission | Path | Why |
|---|---|---|
| `dam:read` + `dam:create` | `/content/dam/sei/capella/intake/pending/` | Upload new video assets |
| `dam:modify` + `jcr:write` | `/content/dam/sei/capella/intake/pending/` | Write metadata after upload |
| `dam:modify` + `jcr:write` | `/content/dam/sei/capella/{program}/videos/` | Move the asset to the live DAM on approval |

### Explicitly NOT requested

- `dam:delete` — the tool never deletes an asset, including rejected ones
- `jcr:write` on `/content/capella/en/` — the tool never modifies pages
- `crx:replicate` — approval moves the asset into the live DAM; a content author
  still places it on a page and publishes
- Write access anywhere outside the two paths above
- Membership in any replication agent group

The application enforces this second boundary in code as well: every AEM write
goes through a single module (`apps/api/src/services/aemUploadService.ts`), which
rejects any path outside those two roots before issuing a request.

---

## Dispatcher configuration

These are IT configuration items. The tool assumes they are in place and does
not enforce them.

| Requirement | Instance | Why |
|---|---|---|
| Block public access to `/content/dam/sei/capella/intake/` | Publish dispatcher | **Required before launch.** Staged videos must not be publicly reachable before approval. |
| Allow `/bin/querybuilder.json` for `capella-dam-audit-svc` | Author only | Query Builder is typically dispatcher-blocked |
| Allow `/api/assets/` for both service accounts | Author only | Assets REST API may be dispatcher-blocked |

Both accounts hit the **author instance only** — never publish.

---

## Permission summary

| | `capella-dam-audit-svc` | `capella-dam-intake-svc` |
|---|---|---|
| Read `/content/dam/` | Yes | Intake subfolder only |
| Write `/content/dam/sei/capella/intake/` | No | Yes |
| Write `/content/dam/sei/capella/{program}/videos/` | No | Yes |
| Read `/content/capella/en/` | Yes | No |
| Query Builder API | Yes | No |
| Replicate / publish | No | No |
| Delete assets | No | No |

---

## Authentication

OAuth service tokens are preferred (AEMaaCS) — they avoid storing credentials in
environment variables. Basic Auth is acceptable for AEM 6.x.

**Open question for IT:** which does the author instance support? The tool
currently implements Basic Auth; moving to OAuth changes only the
`Authorization` header construction in `aemClient.ts` and `aemUploadService.ts`.

---

## Until these are granted

The tool runs in Phase 1 with no AEM credentials at all:

- Bulk URL audits, asset discovery, and testimonial scraping work via the
  public-HTML Playwright scraper
- Every Phase 2 feature returns a structured `501 AEM_API_NOT_CONFIGURED` and
  the UI shows an explanatory notice rather than an error
- Video intake returns `501 AEM_INTAKE_NOT_CONFIGURED` — the intake form tells
  submitters it is not open yet rather than accepting a file it cannot store

Publish status in Phase 1 is inferred from scraped signals and is often
`unknown`. That is a genuine limitation, not a bug: only `cq:lastReplicated`
from the JCR node is authoritative, and reading it needs Account 1.


---

## Why these paths changed (2026-09-17)

An earlier version of this request named `/content/dam/capella/` throughout.
That is the legacy tree. Capella's assets have been migrated into the shared
SEI DAM, and counting DAM references in the HTML of three live pages showed
`/content/dam/capella/` matching 14 assets where the full DAM root matches 51 —
the audit tool was scoped to a quarter of the site.

Two consequences for this request:

**Read scope widened to `/content/dam/`.** The audit account has to see
`sei/capella/`, and in practice also `vc/`, `sei/global-logos/` and the
sibling-brand chrome that Capella pages reference, or "where is this asset
used?" returns a confident and wrong answer. It remains strictly read-only. If
a narrower read scope is preferred, `/content/dam/sei/capella/` plus
`/content/dam/capella/` covers most but not all of it — say so and we will
measure what that misses before it ships.

**Video intake moved to `/content/dam/sei/capella/`.** New assets should land
where the rest of Capella's assets live, not in the legacy tree. This is a
deliberate scoping decision, not a consequence of the read change: the write
account stays restricted to exactly two paths, and the tool enforces that
allowlist in code (`assertWritablePath` in `aemUploadService.ts`) independently
of whatever the AEM ACL permits.

**If the intake paths are provisioned differently from what is listed above,
tell us the exact paths** — they are configuration (`AEM_INTAKE_STAGING_PATH`
and `AEM_INTAKE_LIVE_ROOT`), and the code's allowlist is derived from those two
values, so the two cannot drift. Uploads fail closed if they disagree.

**The dispatcher rule moves with the staging folder.** Blocking
`/content/dam/capella/intake/` no longer protects anything; the rule must
target `/content/dam/sei/capella/intake/`.
