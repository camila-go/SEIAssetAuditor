# Open Questions — and how the code handles each one today

From PRD v1.5 §11. Every blocking question has a defensible default in the code
so the build is not stalled, but each default is a placeholder, not a decision.

## Blocking

| Question | Owner | What the code does now | Where to change it |
|---|---|---|---|
| Sequential or parallel approval chain? | Legal + Marketing | **Both are implemented.** `APPROVAL_CHAIN_MODE` switches between them; defaults to `sequential`. | `apps/api/src/services/approvalChain.ts` — pure and fully unit-tested for both modes |
| Who are the named legal approvers? | Legal | Single address in `LEGAL_APPROVER_EMAIL`. Any approver presenting valid credentials can act as "legal". | `notificationService.approverEmailFor()`; per-person identity needs the SSO answer below |
| Who are the named marketing approvers? | Marketing | Single address in `MARKETING_APPROVER_EMAIL`. | Same |
| Does approval auto-make the asset usable, or does an author still place it? | Content | **Approval moves the asset into the live DAM and stops.** Nothing is published; the approval email says so explicitly. | `intakeService.promoteToLiveDam()` |
| Should internal submitters require Capella SSO? | IT / Security | Placeholder: shared bearer token + an `X-Approver-Email` header, held in `sessionStorage`. Approver identity is recorded on every decision. | `apps/api/src/middleware/internalAuth.ts` and `ApproverSignIn` in `apps/ui/src/pages/AdminIntake.tsx` — swapping in SSO touches only those two |
| Is 2GB feasible for the AEM Assets upload API? | AEM Engineering | `MAX_VIDEO_BYTES` defaults to 2GB and is enforced on the upload stream. Bytes are piped straight to AEM, never buffered, so the API's own memory is not the constraint — AEM's limit is. | `config.maxVideoBytes` |
| Legal must approve the checkbox agreement copy | Legal | The checkbox copy is **from the PRD verbatim** and has not been reviewed. It blocks submission client- and server-side. | `apps/ui/src/pages/IntakeForm.tsx`, legal agreement section |
| Where is the full terms document hosted? | Legal | `LEGAL_TERMS_URL` points at a placeholder capella.edu path. The form links to it in a new tab. | `.env` |
| OAuth or Basic Auth for the service accounts? | IT | Basic Auth is implemented. | `aemClient.ts`, `aemUploadService.ts` — header construction only |
| Is ffmpeg available on the server? | IT / DevOps | The worker checks at startup, logs a clear warning, and **disables transcription rather than crashing**. Audits are unaffected. | `apps/worker/src/index.ts` → `checkFfmpeg()` |
| Max expected video length? | Engineering | Audio over Whisper's 25MB limit is **split into 20-minute chunks** and the transcripts merged with timestamp offsets applied. | `transcriptionProcessor.transcribeWithChunking()` |

## Non-blocking

| Question | Owner | What the code does now |
|---|---|---|
| Does Capella's AEM license include Adobe Sensei transcription? | AEM admin | Whisper is used. If Sensei is licensed it would replace `transcriptionService.ts` only — the VTT, chapter and storage steps are independent of the transcriber. |
| Signed PDF — tool DB or document management system? | Legal | Default per PRD: stored on disk under `LEGAL_DOC_STORAGE_PATH`, outside the web root, never pushed to AEM. Served to approvers only. |
| What happens to rejected assets after 90 days? | Legal / DAM admin | **Nothing.** Rejected assets stay in staging flagged `dam:status=rejected`. The tool has no delete permission by design, so any retention policy has to be an AEM-side workflow. |

## Decisions made while building, worth confirming

These were not in the PRD but had to be resolved to write the code.

1. **Phase 1 publish status is often `unknown`.** Public HTML carries no reliable
   published flag. The scraper uses the signals available (HTTP status, `noindex`,
   AEM edit-mode markers, rendered content length) and returns `unknown` when they
   disagree. The UI renders that honestly rather than guessing. Only
   `cq:lastReplicated` is authoritative — Phase 2.

2. **Program coverage is gated behind the AEM API even though counting is
   possible in Phase 1.** A program with zero testimonials produces no rows to
   count, so without AEM's program taxonomy the report would be silently missing
   exactly the gaps it exists to find. It returns a `501` with that explanation
   rather than a misleading grid.

3. **Testimonial attribution is stripped before fingerprinting.** The same quote
   credited "— Jane D." on one page and "— Jane Doe" on another would otherwise
   create two rows. The name is extracted first, then removed from the text that
   gets fingerprinted.

4. **`needs_review` is sticky.** Once set, no scrape clears it. Only a human can.

5. **Rate limits on the public intake route are deliberately tight** (5
   submissions per hour per IP). It is unauthenticated and each request streams a
   file to AEM.

6. **Chapter detection uses Claude Haiku 4.5.** The `.claude/rules/` files named
   `claude-sonnet-4-6`, which is not a current model ID. Haiku is the right tier
   for a cheap bulk extraction over transcript text; the model is configurable via
   `CHAPTER_DETECTION_MODEL`.

## Corrections the live site forced (2026-09-16)

Found by running a real audit against capella.edu. These contradict the PRD and
the rules files, and the PRD should be updated.

1. **`waitUntil: 'networkidle'` does not work on capella.edu.** Prescribed in
   PRD §3 and `.claude/rules/`. The site keeps analytics connections open, so
   network-idle is never reached — measured: still not reached 5s after `load`.
   The first live audit failed 3 of 3 URLs on timeout. The scraper now uses
   `waitUntil: 'load'` (~1.8s) plus a bounded best-effort settle
   (`SCRAPER_SETTLE_MS`, default 2000).

2. **None of the five testimonial selectors in PRD §8 match anything.** Capella
   uses `.testimonialPromo` and `.testimonial-promo`; `.testimonial` is an exact
   class match and hits neither. Added `[class*="testimonial" i]`. Without it the
   tool reports zero testimonials sitewide — silently, which is the worst
   possible failure mode for an audit tool.

3. **The attribution format in PRD §8 is wrong.** The spec says to look for
   `— Name`. The live markup has no dash: one element contains
   `"quote" Name* Degree *Legal disclaimer`, with no inner element holding just
   the quote. Parsing now splits on the quotation marks and reads the name from
   the head of what follows. Without this the legal disclaimer ends up inside
   `quote_text` and inside the dedup fingerprint, so the same quote appearing on
   two pages with slightly different boilerplate would fail to dedup.

4. **Names carry footnote markers.** "Stephanie Dewald*" — the asterisk points at
   the disclaimer elsewhere on the page. Stripped from `student_name`.

All four are covered by tests in `testimonialExtractor.test.ts` under the
`real capella.edu markup` block, using the exact 267-character string the live
page produces.

## Bugs found by running it

Worth recording because none were visible from reading the code:

- **An intake failure crashed the whole API.** `submitVideo`'s promise was
  created inside a busboy event handler and only awaited in a later `close`
  handler; a rejection in between was unhandled, and Node terminated the
  process. Any disabled-flag 501 took the server down. Fixed by attaching the
  rejection handler at creation.
- **BullMQ rejects `:` in custom job ids.** `audit:${id}` was refused, so no
  audit could ever be queued.
- **Nothing loaded `.env`.** `loadEnvFile()` resolves from `process.cwd()`,
  which npm sets to the workspace directory, so the root `.env` was never
  found. Now resolved by walking up from the config file itself.
- **`normalizeUrl` turned any text into a URL.** Blind `https://` prefixing made
  `ftp://example.com` into `https://ftp//example.com` and a CSV header cell
  `title` into `https://title/` — both would then be queued and scraped.

## Semantic search (added 2026-09-17)

Search was substring matching, then term-based. It is now hybrid: four passes
fused into one ranking. What each one exists to fix, measured on the real corpus:

| Pass | Was failing | Now |
|---|---|---|
| exact | `flexibility program` → 0 | 1 |
| stemmed | `nurse` → 0 | 1 |
| semantic | `balancing work and study` → 0 | 1 |
| fuzzy | `Wbeb` → 0 | 1 |

**Model choice was measured, not assumed.** all-MiniLM-L6-v2 scores an unrelated
control query at 0.09 and genuine matches at 0.36–0.58. bge-small-en-v1.5 — the
usual "better" recommendation — scores the same control at **0.39**, above
several of MiniLM's correct answers. It compresses everything into a narrow
high band, so no threshold separates signal from noise. MiniLM won on separation,
and is also smaller and faster.

**Two thresholds, both measured:**
- Absolute floor 0.30 — the empty band between the control (0.09) and real
  matches (0.36+).
- Relative cutoff 0.85 of the top score. The floor alone was not enough: for
  "capella logo" *every* asset scored above 0.30, because every asset is a
  Capella asset. That turned a 4-result search into 14. The signal is the gap
  below the leaders, not the absolute value.

**Typo tolerance uses edit distance, not trigrams.** Trigram similarity scores
"Wbeb"→"Webb" at 0.111 because trigrams are order-sensitive and a transposition
destroys two of them. Levenshtein separates cleanly: typos 1–2, unrelated 4–5.
Applied only to name and program — a 200-character quote is 200 edits from any
search term, so fuzzy matching on prose is meaningless.

**Still not solved:** ranking between two closely related quotes. "juggling a job
with school" returns a defensible but arguably second-best result. Tuned on four
testimonials; re-check at real volume.

## Bugs found building semantic search

- **`NOT { embeddingModel: MODEL }` matched nothing.** In SQL,
  `NOT (col = 'x')` is NULL when the column is NULL, and a WHERE drops NULL
  rows — so the sweep skipped every row that had never been embedded, which was
  all of them. Needs an explicit `OR col IS NULL`.
- **A fixed BullMQ job id made the sweep run exactly once.** The id was meant to
  coalesce concurrent requests, but BullMQ rejects a duplicate id against a
  *completed* job too, and completed jobs were being retained. Every later sweep
  silently did nothing. Fixed with `removeOnComplete: true`.
- **The worker could not reach huggingface.co.** The model is now vendored into
  `.model-cache/` by `npm run embed:prewarm`, so the worker needs no network —
  which is what you want on a locked-down host anyway.
- **Short search terms highlighted inside unrelated words.** "back to school"
  marked the "to" in "s(to)pped". Terms under three characters are now anchored
  to word boundaries.


## The DAM root the PRD specifies does not exist (found 2026-09-17)

PRD §4 and `.claude/rules/architecture.md` both say to index only
`/content/dam/capella/`. Reverse lookup rejected a perfectly valid asset URL a
designer pasted straight out of the browser, which is how this surfaced.

Counting DAM path roots in the HTML of three live pages:

| Page | `/content/dam/capella/` | everything else |
|---|---|---|
| `/` | 4 | `vc/logo` 44 · `sei/capella` 24 · `sei/strayer` 3 · `sei/global-logos` 3 |
| `/about/` | 4 | `sei/capella` 37 · `sei/global-logos` 28 · `sei/strayer` 21 · `su-edu/…` 14 |
| `/online-degrees/` | 39 (`capella/FlexPath`) | `vc/logo` 33 · `sei/capella` 7 |

Capella has been migrated into the shared SEI DAM. Re-running the same three-URL
audit after widening `DAM_ROOT` to `/content/dam/` took the index from 14 assets
to **51** — the tool had been discarding roughly three quarters of every page and
reporting the remainder as if it were the whole picture.

That is the worst failure mode this tool has: not an error, but a confident
undercount. Anyone asking "is this asset still used anywhere?" would have been
told no.

**Open question for IT / DAM owners:** which of these roots are in scope for a
Capella audit? All of them are indexed now, and `damBrand()` derives the brand
per asset so they can be filtered, but nobody has said whether
`/content/dam/sei/strayer/` appearing on a Capella page is a finding or just
shared footer chrome.

**Video intake moved too — as a separate, deliberate decision** (2026-09-17).
It was left alone in the first pass precisely because widening a write path as a
side effect of a read fix is how boundaries erode. Camila then made the call:
new video assets belong with the rest of Capella's assets, so staging is now
`/content/dam/sei/capella/intake/pending/` and the live destination is
`/content/dam/sei/capella/{program}/videos/`.

The write scope stays exactly two paths. What changed structurally is that both
now come from config (`AEM_INTAKE_STAGING_PATH`, `AEM_INTAKE_LIVE_ROOT`) and the
in-code allowlist is *derived* from them instead of being a second hardcoded
copy — previously the live root was a literal regex in `assertWritablePath`, so
moving intake would have required remembering to change two places that nothing
checked against each other.

**This needs IT before it works.** The service account has to be re-scoped to
the new paths and the dispatcher rule blocking the staging folder has to move
with it (`docs/dam-permissions.md` is updated and states both). Until then
uploads fail closed, which is the correct behaviour but is a launch blocker, not
a warning.

Writing the write boundary's first tests as part of this turned up a real hole:
a path of exactly `{staging}/` — the folder node, no filename — passed the
allowlist, because the check was `startsWith` against the root. Staging is flat,
so it now requires exactly one non-empty filename segment.

**Consequence for anything audited before this fix:** those asset counts are
wrong and low. Re-run the audit.


## CSS background images were invisible to the audit (found 2026-09-17)

Reported from the page itself: the `12k-tuition-cap` hero was not being picked
up. The asset was in the HTML the whole time — the extractor was only ever
looking at attributes.

Capella builds hero and footer banners as CSS, not `<img>`:

```html
<div style="background-image: linear-gradient(90deg, #212322 3.92%, …),
                              url(/content/dam/capella/…/12K-desktop-hero.png);">
```

Classifying every DAM reference on that page by where it appears:

| Where | Refs | Reachable before |
|---|---|---|
| `img[src]` / `srcset` | 13 | yes |
| `link[href]` (preload, favicons) | 9 | **no** |
| `a[href]` | 6 | yes |
| `url()` in a `style` attribute | 2 | **no** |

The two CSS references were the hero and the footer banner — the two images
anyone looking at that page would name. Re-auditing after the fix took it from
20 indexed assets to 30.

Three changes:
- `extractPathsFromCss` parses `url()` out of CSS. Separate from the attribute
  parser because a CSS value can hold several `url()`s plus gradients full of
  commas, so `srcset`-style comma splitting shreds it.
- The scraper reads the computed `background-image` of every element, not just
  the `style` attribute — measured at **5ms for ~2000 elements**, and on this
  page one background image is set from a stylesheet where no attribute shows
  it at all. No element cap: at that cost a cap would only buy a silent
  undercount.
- `link[href]` added to the selector. This also indexes favicons, which are
  genuinely DAM assets referenced by the page; brand filtering is the answer to
  that noise, not dropping the data.

**A second bug fell out of writing the test.** The first assertion said the
attribute parser should return nothing for a CSS value. It did not — it returned
the correct asset with `);` still attached. `normalizeAssetPath` never checked
where a path ended, so any path lifted out of surrounding syntax kept the
syntax, indexing a real asset under a filename that does not exist. It now stops
at the first character that cannot appear in a URL path. Nothing downstream
would ever have flagged that: the row looks fine and simply never matches.

**Still not covered:** assets referenced only from JavaScript (a JSON config
block, a data attribute holding a serialized payload). One reference on this
page falls in that bucket. Worth revisiting if a specific asset turns up missing;
parsing arbitrary JS for paths guesses more than it knows.


## Duplicate detection was reporting ten brands as one image (found 2026-09-17)

Running the pHash sweep over the newly-discovered assets produced a "duplicate"
group containing the JWMI, Strayer, Devmountain, Sophia, SEI, ETS, Torrens,
Media Design School and DegreesWork logos — nine different brands, at Hamming
distance 0, the strongest possible match.

Cause: a white logo on a transparent background, flattened onto white, is a
blank white square. blockhash returns all-ones for it. Every such logo therefore
carried the identical hash `ffff…`.

The dual-hash design (white-flattened and black-flattened) was already there and
was already correct — the black-flattened hashes of those same logos are fully
distinctive. What was missing was the rule that **a uniform hash carries no
information and must not be used for matching**. A hash whose every bit is the
same is now discarded.

Two things this changed downstream:

- An image that is a single flat colour now has no usable hash at all, so it is
  reported as uncovered rather than matching the entire index. Reverse image
  search rejects such an upload with an explanation instead of returning
  everything.
- Coverage counts an image as searchable if **either** hash survives. Counting
  only the primary hash reported 46 of 58 when 56 were findable — understating
  coverage is as misleading as overstating it, just in the safer direction.

After the fix the index reports one duplicate group: `apple-icon-167x167.png`
and `apple-icon-180x180.png`, which genuinely are the same icon at two sizes.

This is the third instance of the same failure shape in this tool — confident,
plausible-looking output built on an input that silently carried no signal. The
other two were the all-assets semantic match ("capella logo" matching the entire
DAM because every asset is a Capella asset) and the narrow DAM root.


## Part of the DAM is not publicly served (found 2026-09-21)

Measured with a redirect-following request against the live site:

```
/content/dam/vc/logo/accreditation/ACBSP_Logo_3.png
  -> 301 to the same path with a trailing slash -> 403 text/html

/content/dam/sei/capella/logos/Capella_FlexPath_2024_White_051425.svg
  -> 200 image/svg+xml
```

So the dispatcher serves `sei/capella` publicly but not `vc`. Two consequences,
both of which were previously invisible:

- **Thumbnails for those assets cannot load.** All three call sites responded to
  an image error by setting `visibility: hidden`, leaving a blank hole that is
  indistinguishable from a bug in this tool. They now render a labelled
  placeholder — this is the broken-image fallback `.claude/rules/frontend.md`
  asked for and never had.
- **Those images can never be fingerprinted over HTTP**, so reverse image search
  and duplicate detection cannot cover them in Phase 1. This is the real reason
  pHash coverage stops short of every image rather than a bug in the sweep. It
  was 56 of 58 when this was found and is 62 of 64 now — the shortfall is always
  exactly the images the dispatcher will not serve.

**Open question for IT:** is `/content/dam/vc/` meant to be publicly
unreachable? If it is deliberate, full reverse-image coverage needs the AEM read
account rather than public HTTP, and that should be said plainly in the readiness
assessment. If it is an oversight in the dispatcher rules, it is a one-line fix
on their side.


## Fingerprinting now runs itself (2026-09-21)

An audit discovers assets; it never fingerprinted or embedded them. Both sweeps
had to be started by hand with `npm run crawl`, and twice in one session nobody
did — coverage sat at 9 of 58 images and 14 of 65 assets with nothing reporting
a problem. Reverse image search and duplicate detection simply could not see the
newest assets, and neither could meaning-based search.

A completed audit now queues both sweeps. Verified end to end on two fresh
pages with no manual step: pHash 56/58 → 62/64, embeddings 65/65 → 72/72.

Still enqueued, never inline. `.claude/rules/backend.md` is right to forbid
fingerprinting on the scraping path — it re-downloads every image, which has no
business holding up an audit or sharing its retry semantics. A failure to
enqueue is logged and swallowed: the audit has already succeeded, and throwing
would fail a finished job and make BullMQ retry the whole thing.

**Two bugs this surfaced immediately**, both invisible while the sweep was manual:

- `enqueuePhash` had no job id, so nothing coalesced. Several audits finishing
  together would have stacked concurrent sweeps, all claiming the same rows and
  downloading the same images from capella.edu at once. Now pinned to
  `phash-sweep` with `removeOnComplete: true` — the same pairing the embedding
  queue already needed, for the same reason.
- `findNeedingPhash` selected on `phash: null`, but `countHashedImages` counts a
  row as hashed if *either* hash exists. White-on-transparent logos keep
  `phash = null` by design — their white-flattened hash is a blank square — so
  every sweep re-selected and re-downloaded all ten of them, forever. The first
  automatic run considered 18 images when only 8 could need work; after aligning
  the two definitions it considers 2.

**Open, and it grows with scale:** those remaining 2 are the `/content/dam/vc/`
images the dispatcher returns 403 for. They have no hash, so every sweep retries
them. Bounded and harmless at 2, but if a whole tree stays unfetchable this
becomes hundreds of pointless downloads per audit. The fix is a failed-attempt
count with backoff, so a permanently unreachable asset stops being retried
without being confused for one that has simply not been reached yet.


## Filenames were being turned into hostnames (found 2026-09-24)

Reported from a real audit: five URLs failed with
`net::ERR_NAME_NOT_RESOLVED`, for addresses like `https://kristen_moris.jpg/`.

Those were never URLs. They were filenames — almost certainly a column pasted
from a DAM export — and `normalizeUrl` prefixed `https://` and treated the
filename as a host. `LOOKS_LIKE_HOST` asked only for a dot followed by two or
more letters, which `capella.edu` and `kristen_moris.jpg` satisfy equally well.
The comment above it claimed "a plausible TLD" and never checked that the
ending was a TLD rather than a file extension.

This is the second time the same normalizer has invented an address. The first
was a CSV header cell — `title` became `https://title/` — and the fix then
added the dot requirement, which this case walks straight through.

Three changes, because the parsing bug was the smallest part of it:

- **Filenames are rejected.** Only the host portion is tested, so
  `example.com/photo.jpg` and an explicit `https://.../photo.jpg` are unaffected.
- **Skipped input is named back.** Rejecting silently would have been worse than
  the original bug: paste three URLs and five filenames and you would get a job
  of three with nothing saying the rest were dropped. The audit page now lists
  what was left out, and an all-filename paste gets an error that names examples
  instead of "No valid URLs found".
- **The rule moved to `@capella/types`.** The form counted non-blank lines while
  the API decided what to queue, so the preview read "6 URLs detected" for five
  filenames and one address. Same fix as `parseSearchTerms`: one rule, one
  place. The form now warns before submitting, which is where the mistake is
  actually made.

**The deeper pattern, now three for three:** every one of this tool's worst bugs
has been input that carried no signal being confidently turned into an answer —
a degenerate pHash matching every white logo, a semantic threshold matching
every Capella asset, and now a filename becoming a hostname. The shape to watch
for is a permissive rule with a comment claiming it is strict.


## Fingerprinting stalled at 416 of 665 — two causes (found 2026-09-24)

A completed audit had been queueing the pHash sweep since 2026-09-21, and
coverage still sat at 416 of 665 with the UI correctly reporting that the rest
could not be matched.

**Cause one: the sweep did one batch and stopped.** `SWEEP_LIMIT` was 200 with
no loop, unlike the embedding sweep which runs until nothing remains. One audit
queues one sweep, so an index of 665 images could never be covered however many
audits ran. The sweep now continues itself while a batch comes back full, with
the limit *lowered* to 100 — see cause two.

**Cause two, and the reason it never recovered: a failed job poisoned the
queue.** Redis held `bull:phash:phash-sweep` with
`failedReason: "job stalled more than allowable limit"`. BullMQ rejects a
duplicate job id against a **failed** job exactly as it does against a completed
one, and `removeOnFail` was set to a 7-day retention — so every `enqueuePhash`
for a week was silently dropped.

That is the same trap already documented for the embedding queue, reintroduced
on the failure side when coalescing was added to the pHash queue three days
earlier. `removeOnFail` is now `true`: a blocked queue is far worse than a lost
failure record, and the failure is in the worker log either way.

The stall itself is why the batch got smaller, not bigger — 200 downloads plus
native image decoding is long enough for BullMQ to give up on the job.

Verified by clearing every hash and re-running: 0 → 653 of 665 across 8 chained
sweeps, terminating when the last batch came back short. The remaining 12 are
the images the dispatcher will not serve.

## Assets are now re-checked on a schedule (added 2026-09-24)

An audit records what a page referenced at the moment it was read. Nothing after
that told the tool an asset had been deleted, renamed or unpublished — so
"appears on 3 pages" kept being reported with full confidence for as long as
nobody happened to re-audit those pages.

Every asset is now re-checked against the live site **every three days** (a
BullMQ repeatable job, `REVALIDATION_CRON`), and the assets page states when the
last check ran and what it found.

First full run over 779 assets: **769 still served, 10 not**. Those ten are real
findings — entries in the index that capella.edu no longer serves.

Two distinctions the implementation keeps deliberately:

- A request that never completed (DNS, timeout) records status `0`, not a 4xx.
  "We could not tell" is not the same claim as "the server said it is gone", and
  collapsing them would turn a flaky network into a report of mass deletion.
- The UI says plainly that part of the DAM is not publicly readable, so some of
  the ten may exist and simply be unreachable without an AEM account.

`removeOnFail: true` here too, for the same reason as the pHash queue — a
retained failed id would permanently block a schedule whose entire purpose is to
run unattended.


## Renditions were indexed as separate assets (found 2026-09-25)

Spotted in the duplicates view of the static build: groups like

```
CAEP-Accredited-Shield-255x180.png/_jcr_content/renditions/rendition-png-480-300.png
CAEP-Accredited-Shield-255x180.png/_jcr_content/renditions/rendition-png-319-200.png
CAEP-Accredited-Shield-255x180.png/_jcr_content/renditions/cq5dam.web.1280.1280.png
```

Three rows for one image. `normalizeAssetPath` collapses a rendition URL back to
its underlying asset, but only recognised `/jcr:content/`. AEM also emits
`/_jcr_content/`, and **that is the only spelling capella.edu uses**: of 779
indexed assets, 54 carried the underscore form and **zero** carried the colon
form. The collapsing logic had never fired in production — it was written for a
shape the real site does not produce.

Effect: 54 rows that are really 18 images, inflating the asset count by 36 and
making duplicate detection correctly report each image as a duplicate of itself.

This is the fourth instance of the same pattern: **code written against the
spec's idea of the site rather than the site.** The others were the DAM root,
the testimonial selectors and `networkidle`. Worth treating as the default
suspicion whenever a rule "handles" something and the handling never seems to
matter.

Fixed by collapsing both spellings. Existing rows stay inflated until the next
audit re-normalises them — a re-crawl, not a migration, because the index is
derived data.

## Why a static snapshot mode exists (added 2026-09-25)

The machine this was built on is being decommissioned and there is no hosting
budget. Those two facts together rule out every option that was on the table:
the tool needs a persistent worker driving headless Chromium plus a Postgres and
a Redis that survive restarts, and no free tier provides any of the three —
checked against Render's own documentation rather than assumed.

But everything the index already knows is static data, and a static host serves
that for nothing, forever. `npm run build:static` bakes the committed snapshot
into the bundle and the UI reads it directly. Browsing, search, duplicates and
the page maps all work; anything that crawls or writes returns the same
structured 501 the tool already uses for gated features.

Embeddings are deliberately not shipped: 2,651KB of the 2,899KB snapshot is
384-float vectors a browser cannot use without the model. Without them the whole
payload is 117KB gzipped. Semantic search is therefore **absent and labelled**
rather than silently degraded — the search-index endpoint reports zero embedded,
so the existing coverage notice explains itself.

Every page carries a banner saying it is a snapshot. That is the same principle
as pHash coverage and the three-day revalidation: a published snapshot is the
largest version of the stale-answer problem, because it looks exactly like the
working tool and the numbers stopped moving on a date nobody can see.


## "Needs attention" led to pages that did not show the thing (found 2026-09-25)

Reported as "it leads to nothing", and it was three separate problems wearing
one coat.

**The failures panel was collapsed on arrival.** "8 URLs could not be scraped"
linked to the audit's page, where the failures sit behind a `▸ N failed URLs`
toggle that starts closed. You clicked a specific finding and landed on a page
that did not show it. The links now carry `?failures=1` and the panel opens on
arrival.

**The detail line overstated its own link.** It said "across recent audits" but
linked to the first job with failures. It now counts the jobs involved and says
which one it is opening when there is more than one.

**In the static build the link 501'd entirely.** The snapshot shipped audit jobs
but not their per-URL rows, so a job page had no status, no results and no
failures. Those rows are 141 entries and about 8KB; they are shipped now, and
job pages work without an API.

Fixing that surfaced a fourth thing. The results table on a job where every URL
failed said **"No results match these filters — try clearing the filters
above"** with no filters set. The table was empty because nothing was scraped
successfully, and blaming filters sends someone looking in the wrong place. It
now says "Every URL in this audit failed" and points at the reasons below.

All four are the same failure: the interface describing a state it is not
actually in. Cheap to fix, and each one costs a person real time before they
work out the message was wrong rather than the data.
