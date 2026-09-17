# Frontend Rules

Loaded when working in `apps/ui/`.

## Stack

- React 18 + TypeScript strict
- Tailwind CSS — utility classes only, no custom CSS files
- Zustand for global state (audit session)
- React Query (`@tanstack/react-query`) for all server state and caching
- React Router v6 for routing

## Component Conventions

- Named exports only — no default exports except route-level pages
- One component per file
- Props interfaces named `{ComponentName}Props` in the same file
- No `any` — use `unknown` and narrow, or import from `packages/types`
- Co-locate component tests as `ComponentName.test.tsx`

## Key Views

```
/                         → Dashboard (recent audits, DAM health, testimonial coverage, pending intake count)
/lookup                   → Asset reverse lookup (paste AEM URL)
/audit                    → Start audit (tabs: paste URLs / upload CSV / sitemap URL)
/audit/:jobId             → Live job progress + streaming results table
/assets                   → Search & browse indexed assets
/assets/:id               → Asset detail (references, status, social links)
/duplicates               → Duplicate asset groups
/testimonials             → Search & browse all testimonials
/testimonials/:id         → Testimonial detail (pages, status, source type)
/programs/coverage        → Program coverage gaps (Phase 2)
/intake                   → Video intake form (public — no login required)
/intake/confirm           → Submission confirmation + tracking ID
/intake/resubmit/:id      → Resubmission form (pre-filled from original, public)
/admin/intake             → Intake queue — list of pending submissions (internal auth)
/admin/intake/:id         → Submission detail — approve or reject with reason (internal auth)
```

## Audit Job UI

The `/audit` view has three input modes as tabs:
1. **Paste URLs** — textarea, one URL per line, no enforced cap
2. **Upload CSV/TXT** — drag and drop, extracts URLs from first column
3. **Sitemap URL** — single input, tool crawls the sitemap XML

On submit → navigate immediately to `/audit/:jobId`.

The `/audit/:jobId` view:
- Polls `GET /api/v1/audit/:jobId/status` every 3 seconds while `running` or `queued`
- Shows progress bar: `completedUrls / totalUrls` with estimated time remaining
- Results table populates live as batches complete — never wait for full completion
- User can close the tab — job continues in background, URL resumes on return
- Completed jobs show a "Download CSV" button
- Failed URLs in a collapsible panel at the bottom with error messages

## State Management

- Server data (assets, pages, references, audit results): React Query — never put in Zustand
- UI state (selected rows, active filters, modal open): local `useState`
- Cross-page state (current audit session, job ID): Zustand `useAuditStore`

## AEM Asset Previews

Always render asset images using the public URL — never import or embed binaries:

```tsx
// Correct
<img src={`${AEM_PUBLIC_HOST}${asset.aem_path}`} alt={asset.filename} loading="lazy" />

// Wrong — never fetch and embed binaries
```

Show a broken-image fallback if the AEM URL returns non-200.

## Testimonial UI Conventions

**Search:** Single input searches across `quote_text`, `student_name`, and `program` simultaneously. Highlight matched terms with `<mark>` tags.

**Source type badge:**
- `structured_component` → blue "Component" badge
- `hardcoded_text` → orange "Hardcoded" badge (signals it may be harder to update in AEM)

**Needs review flag:** `needs_review: true` → yellow warning icon. Human must reconcile — never auto-resolve in the UI.

**Freshness:** Days since `last_seen_at`. Over 90 days → amber. Over 180 days → red. Informational only.

**Program coverage (Phase 2):** Grid of programs. Zero testimonials → red. 1–2 → amber. 3+ → green. Clicking filters the testimonials view.

## Status Badges

Use the shared `<StatusBadge status="published" | "draft" | "unknown" />` component.
- published → green
- draft → grey
- unknown → yellow (scraped but status unclear)

## Empty & Error States

Every data-fetching view must handle:
1. Loading skeleton — never a spinner, never `null`
2. Empty state with actionable message
3. Error state with retry option

## Video Intake UI Conventions

**Intake form (`/intake`)** — public, no login:
- Clear notice at the top: "Your video will be reviewed by legal and marketing before appearing on the site"
- File upload: drag-and-drop + click, accept `video/mp4,video/quicktime,video/webm`, max 2GB
- Show upload progress bar during submission — file goes directly to AEM, this can take time
- Required fields: title, description, program (dropdown), campaign/project, usage rights (text), rights expiry date, submitter name, submitter email, submitter organization
- Optional: additional notes for approvers
- **Legal agreement section — must appear directly above the submit button:**
  - Checkbox: "I agree to the [Terms of Video Submission](#) and confirm I have all necessary rights to submit this video" — link opens terms in a new tab
  - Submit button is disabled until checkbox is checked — not just visually, disabled attribute set
  - Below checkbox: optional PDF upload — "Upload a signed agreement (optional)" — accept `application/pdf` only, max 10MB — label makes clear this is supplementary, not a replacement for the checkbox
  - On submit: record timestamp in hidden field — sent to API as `legalAgreedAt`
- On submit: show spinner during AEM upload, then navigate to `/intake/confirm` with tracking ID
- Never show AEM paths or internal IDs to the submitter
- Never allow form submission if checkbox unchecked — enforce on both client and server

**Confirmation page (`/intake/confirm`)**:
- Show tracking ID (VideoSubmission ID) prominently
- "You'll receive an email at {email} when a decision is made"
- Link to resubmit if they need to make changes before review starts

**Resubmission form (`/intake/resubmit/:id`)**:
- Pre-fill all metadata fields from the original submission
- Show the rejection reason from the previous attempt
- File upload required again (they must re-upload the video)
- Submit creates a new VideoSubmission with `parent_submission_id` pointing to original

**Admin intake queue (`/admin/intake`)**:
- Table of all submissions with: title, submitter, program, submitted date, status badge, days waiting
- Filter by status: all | pending | legal_approved | marketing_approved | approved | rejected
- Status badges: pending (yellow) | legal approved (blue) | marketing approved (blue) | approved (green) | rejected (red)
- Highlight submissions waiting over 5 business days in amber

**Submission detail (`/admin/intake/:id`)**:
- Video preview — stream directly from AEM staging path, do not download
- All metadata fields displayed
- **Legal section:** shows agreement checkbox timestamp, IP address, and "Agreement confirmed" status. If a PDF was uploaded, show a "View signed document" button that opens it in a new tab via `GET /api/v1/intake/:id/legal-doc` (internal auth). If no PDF, show "No supplementary document uploaded"
- Approval chain status — which approvers have acted, which are pending
- Approve / Reject buttons — reject requires a reason (textarea, required)
- Approver can only act once — button disabled after decision recorded
- Show full approval history with timestamps

## Transcription UI Conventions

**Admin submission detail (`/admin/intake/:id`) — transcript section:**
- Shows below the video preview
- Three states:
  - `pending` / `processing` → "Transcript generating..." with a subtle spinner
  - `complete` → full scrollable transcript with timestamps inline, chapter markers as jump links above
  - `failed` → "Transcription unavailable" with a note that approval can still proceed
- Chapter markers render as a clickable table of contents above the transcript — clicking jumps to that timestamp in the video preview
- Transcript text is searchable (browser ctrl+F is sufficient — no custom search needed)
- VTT file shows as a "Download captions (.vtt)" link if `vtt_aem_path` is set

**Chapter markers display:**
```
Chapters
────────────────────
0:00  Introduction
2:14  Program Overview  
5:47  Enrollment Next Steps
```

Each chapter title is a link that seeks the video preview to that timestamp.

**Transcript display:**
- Scrollable container, max height 400px
- Timestamps shown every paragraph as subtle grey text: `[0:42]`
- Do not show word-level timestamps — paragraph-level only for readability
