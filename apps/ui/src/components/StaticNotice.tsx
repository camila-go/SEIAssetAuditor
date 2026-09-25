import { Link } from 'react-router-dom'
import { IS_STATIC } from '../api/client'

/**
 * Says, on every page, that this is a snapshot rather than a live tool.
 *
 * The whole tool is built around not letting a stale or partial answer pass for
 * a current one — pHash coverage, the search-index notice, the three-day
 * revalidation. A published snapshot is the largest version of that problem:
 * everything looks exactly like the working tool, and the numbers stopped moving
 * on a date nobody can see. So it is stated once, permanently, at the top.
 */
export function StaticNotice(): JSX.Element | null {
  if (!IS_STATIC) return null

  return (
    <div className="border-b border-caution-200 bg-caution-50">
      <div className="mx-auto max-w-7xl px-4 py-2 text-xs leading-relaxed text-caution-900 sm:px-6">
        <strong className="font-semibold">Published snapshot.</strong> Real findings from a real
        audit of capella.edu — browsing, search, duplicates and the page maps all work. New audits
        run in GitHub Actions and are started from{' '}
        <Link to="/audit" className="underline">
          Audit
        </Link>
        ; findings appear here once the run finishes and the site rebuilds. Search is term matching
        only — meaning-based search needs the embedding model, which needs the backend.
      </div>
    </div>
  )
}
