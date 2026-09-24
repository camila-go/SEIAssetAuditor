import { Link } from 'react-router-dom'
import { PageHeader } from '../components/Layout'

/**
 * `/guide` — what this tool does, and what it cannot do yet.
 *
 * Separate from the dashboard's first-run state, which by definition disappears
 * the moment someone runs an audit. The question "what is this for?" outlives
 * that: a second person gets sent the link, or the first person comes back in a
 * month. So it lives at a permanent URL reachable from the header.
 *
 * It is organised by job rather than by feature, and is explicit about what is
 * still gated — a demo that quietly omits its own limits is how people end up
 * promising a stakeholder something that needs six weeks of IT work first.
 */
export default function Guide(): JSX.Element {
  return (
    <div className="max-w-3xl">
      <PageHeader
        title="How this works"
        description="What the auditor can answer today, what it needs first, and what is still waiting on someone."
      />

      <section className="mb-10">
        <p className="text-sm leading-relaxed text-ink-700">
          The auditor reads capella.edu pages the way a browser does, and records every DAM asset
          and testimonial it finds on them. Everything else in the tool is a different question
          asked of that one index — which is why <strong className="font-semibold text-ink-900">
          running an audit comes first</strong>. Nothing can tell you where an asset is used until
          some pages have been read.
        </p>
      </section>

      {/* ── The jobs ───────────────────────────────────────────────────────── */}
      <section className="mb-10">
        <h2 className="mb-4 text-md font-semibold text-ink-900">What you can do with it</h2>

        <ol className="space-y-4">
          {JOBS.map((job, index) => (
            <li
              key={job.title}
              className="flex gap-4 rounded-lg border border-ink-200 bg-white p-4 shadow-card"
            >
              <span className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-brand-50 text-xs font-semibold text-brand-700">
                {index + 1}
              </span>
              <div className="min-w-0">
                <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                  <Link to={job.to} className="text-sm font-semibold text-brand-700 hover:underline">
                    {job.title}
                  </Link>
                  {job.gated ? (
                    <span className="rounded-full bg-caution-100 px-2 py-0.5 text-label font-medium text-caution-800">
                      Needs AEM access
                    </span>
                  ) : (
                    <span className="rounded-full bg-verified-100 px-2 py-0.5 text-label font-medium text-verified-800">
                      Works now
                    </span>
                  )}
                </div>
                <p className="mt-2 text-sm leading-relaxed text-ink-600">{job.body}</p>
                {job.detail ? (
                  <p className="mt-2 text-xs leading-relaxed text-ink-500">{job.detail}</p>
                ) : null}
              </div>
            </li>
          ))}
        </ol>
      </section>

      {/* ── Worth knowing ──────────────────────────────────────────────────── */}
      <section className="mb-10">
        <h2 className="mb-4 text-md font-semibold text-ink-900">Worth knowing</h2>
        <dl className="divide-y divide-ink-100 overflow-hidden rounded-lg border border-ink-200 bg-white shadow-card">
          {NOTES.map((note) => (
            <div key={note.term} className="px-4 py-3">
              <dt className="text-sm font-medium text-ink-900">{note.term}</dt>
              <dd className="mt-1 text-sm leading-relaxed text-ink-600">{note.description}</dd>
            </div>
          ))}
        </dl>
      </section>

      {/* ── Honest limits ──────────────────────────────────────────────────── */}
      <section>
        <h2 className="mb-4 text-md font-semibold text-ink-900">What it cannot tell you yet</h2>
        <ul className="space-y-2">
          {LIMITS.map((limit) => (
            <li
              key={limit}
              className="flex gap-3 rounded-lg border border-ink-200 bg-white px-4 py-3 text-sm leading-relaxed text-ink-600"
            >
              <span aria-hidden="true" className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-caution-400" />
              <span>{limit}</span>
            </li>
          ))}
        </ul>

        <p className="mt-4 text-xs leading-relaxed text-ink-500">
          Anything gated says so when you open it, with what is missing — it never fails silently or
          shows an empty result that looks like an answer.
        </p>
      </section>
    </div>
  )
}

interface Job {
  title: string
  to: string
  body: string
  detail?: string
  gated?: boolean
}

const JOBS: readonly Job[] = [
  {
    title: 'Audit a set of pages',
    to: '/audit',
    body: 'Paste URLs, upload a CSV, or point it at a sitemap. It reads each page and records the DAM assets, the testimonials, and whether the page looks published.',
    detail:
      'It runs in the background — close the tab and come back. One page that fails is recorded with the reason and skipped; it never stops the rest. When it finishes, anything new is fingerprinted and indexed for search automatically.',
  },
  {
    title: 'Find where an asset is used',
    to: '/lookup',
    body: 'Paste a DAM path or a public URL and get every audited page it appears on. Rendition and transform URLs resolve to the underlying asset.',
    detail:
      'If you only have the picture, drop the image in instead — it matches by visual fingerprint, so a resized or re-exported copy still finds the original.',
  },
  {
    title: 'Search testimonials',
    to: '/testimonials',
    body: 'One box across the quote, the student and the program. It tolerates typos and finds quotes by meaning, not just wording — searching "balancing work and study" finds a quote that uses none of those words.',
    detail: 'Each result says why it matched, so a loose match is never mistaken for an exact one.',
  },
  {
    title: 'Find duplicate images',
    to: '/duplicates',
    body: 'Groups images that are visually the same, including renamed and re-exported copies.',
    detail:
      'It always reports how much of the index has been fingerprinted, so "no duplicates" is never confused with "not checked yet".',
  },
  {
    title: 'Review video submissions',
    to: '/admin/intake',
    body: 'Vendors submit videos through a public form with a blocking legal agreement. Legal and marketing approve or reject, and an approved video moves into the live DAM.',
    detail: 'Needs an approver token to open, and the AEM write account before a video can be accepted.',
    gated: true,
  },
  {
    title: 'See which programs have no testimonials',
    to: '/programs/coverage',
    body: "Coverage gaps by program — the programs with nothing to quote.",
    detail:
      'Gated deliberately: without the full program list from AEM, a program with zero testimonials is invisible, which is exactly the thing being looked for.',
    gated: true,
  },
]

const NOTES: ReadonlyArray<{ term: string; description: string }> = [
  {
    term: 'Results only cover pages that have been audited',
    description:
      '"Appears on 1 page" means one audited page. An asset can be on pages nobody has run yet. Sitewide certainty needs the AEM read account.',
  },
  {
    term: 'Published status is a best guess in Phase 1',
    description:
      'It is inferred from what the page returns. Where that is unclear it says Unknown rather than guessing. Only AEM can answer this authoritatively.',
  },
  {
    term: 'Nothing here writes to AEM except video intake',
    description:
      'Every audit feature is strictly read-only. The one write path is the video intake flow, which is restricted to two folders and is off until IT provisions the account.',
  },
  {
    term: 'Testimonials flagged "needs review" are never auto-resolved',
    description:
      'When the same quote appears with a different name or program, the tool records the conflict and leaves it. Only a person can decide which is right.',
  },
]

const LIMITS: readonly string[] = [
  'Whether an asset is used on a page nobody has audited — that needs the AEM read account.',
  'Asset dimensions, file sizes and tags, which live in AEM metadata rather than on the page.',
  'Whether a video submission actually reached AEM: the write account does not exist yet, so intake returns an explanation instead of accepting a file.',
  'Social performance. The ranking formula is deliberately unimplemented — an invented one would be worse than none.',
]
