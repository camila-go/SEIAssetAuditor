import { NavLink, Outlet, useLocation } from 'react-router-dom'

/**
 * Navigation, grouped into areas.
 *
 * Eight flat peers was past the point where scanning works — the eye had to
 * read every label to find one. These are five areas, each landing on the view
 * people actually open it for, with siblings on a second row that appears only
 * inside that area.
 *
 * Two deliberate calls:
 *
 *  - Assets lands on Reverse lookup, not Browse. "Where is this asset used?" is
 *    the tool's headline job, and demoting it to a second click to satisfy the
 *    label would cost more than the moment of surprise. The sub-row resolves
 *    any ambiguity immediately.
 *  - No dropdowns. This is a tool people move around inside all day; a menu
 *    that needs opening before it can be read adds a click to every trip.
 */
interface NavArea {
  label: string
  /** Where the area link goes — its most-opened view. */
  to: string
  /** Every path that belongs to this area, for highlighting the parent. */
  match: readonly string[]
  end?: boolean
  children?: ReadonlyArray<{ to: string; label: string; end?: boolean }>
}

const NAV_AREAS: readonly NavArea[] = [
  { label: 'Dashboard', to: '/', match: ['/'], end: true },
  { label: 'Audit', to: '/audit', match: ['/audit'] },
  {
    label: 'Assets',
    to: '/lookup',
    match: ['/lookup', '/assets', '/duplicates'],
    children: [
      { to: '/lookup', label: 'Reverse lookup' },
      { to: '/assets', label: 'Browse all' },
      { to: '/duplicates', label: 'Duplicates' },
    ],
  },
  {
    label: 'Testimonials',
    to: '/testimonials',
    match: ['/testimonials', '/programs'],
    children: [
      { to: '/testimonials', label: 'Search' },
      { to: '/programs/coverage', label: 'Program coverage' },
    ],
  },
  { label: 'Video', to: '/admin/intake', match: ['/admin/intake'] },
]

/** True when `pathname` sits inside this area. */
function isInArea(area: NavArea, pathname: string): boolean {
  if (area.end) return pathname === area.to
  return area.match.some((base) => pathname === base || pathname.startsWith(`${base}/`))
}

/** Chrome for the internal tool. Public intake pages use `PublicLayout` instead. */
export function Layout(): JSX.Element {
  const { pathname } = useLocation()
  const activeArea = NAV_AREAS.find((area) => isInArea(area, pathname))
  const siblings = activeArea?.children

  return (
    <div className="min-h-screen bg-ink-50">
      <header className="border-b border-ink-200 bg-white">
        <div className="mx-auto max-w-7xl px-4 sm:px-6">
          <div className="flex h-14 items-center justify-between">
            <span className="text-sm font-semibold text-ink-900">SEI Site Auditor</span>
            <div className="flex items-center gap-4">
              {/* Permanent, because "what is this for?" outlives the dashboard's
                  first-run state — which disappears the moment an audit runs. */}
              <NavLink
                to="/guide"
                className={({ isActive }) =>
                  [
                    'text-xs font-medium',
                    isActive ? 'text-ink-900' : 'text-ink-500 hover:text-ink-800',
                  ].join(' ')
                }
              >
                How this works
              </NavLink>
              <a href="/intake" className="text-xs font-medium text-brand-600 hover:text-brand-700">
                Submit a video →
              </a>
            </div>
          </div>

          {/* Five areas fit on a laptop but still overflow at 375px, where the
              last one falls off the edge. The trailing gradient is the only
              thing signalling there is more to scroll to; it fades once the nav
              reaches its end. */}
          <div className="group relative">
            <nav
              aria-label="Main"
              onScroll={(event) => {
                const el = event.currentTarget
                const atEnd = el.scrollLeft + el.clientWidth >= el.scrollWidth - 4
                el.parentElement?.toggleAttribute('data-scroll-end', atEnd)
              }}
              className="-mb-px flex gap-1 overflow-x-auto pb-px [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
            >
              {NAV_AREAS.map((area) => {
                const active = isInArea(area, pathname)
                return (
                  <NavLink
                    key={area.label}
                    to={area.to}
                    end={area.end ?? false}
                    aria-current={active ? 'page' : undefined}
                    className={[
                      'whitespace-nowrap border-b-2 px-3 py-2 text-sm font-medium transition-colors',
                      active
                        ? 'border-brand-600 text-brand-700'
                        : 'border-transparent text-ink-600 hover:border-ink-300 hover:text-ink-900',
                    ].join(' ')}
                  >
                    {area.label}
                  </NavLink>
                )
              })}
            </nav>
            <div
              aria-hidden="true"
              className="pointer-events-none absolute inset-y-0 right-0 w-10 bg-gradient-to-l from-white via-white/80 to-transparent transition-opacity duration-200 group-data-[scroll-end]:opacity-0"
            />
          </div>
        </div>
      </header>

      {/* Sub-navigation, only for areas that have siblings. A tinted band rather
          than another white row, so the two tiers read as a hierarchy instead of
          two equal-weight navs stacked on each other. */}
      {siblings ? (
        <div className="border-b border-ink-200 bg-white/60">
          <nav
            aria-label={`${activeArea?.label ?? ''} views`}
            className="mx-auto flex max-w-7xl gap-1 overflow-x-auto px-4 py-2 sm:px-6 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
          >
            {siblings.map((child) => (
              <NavLink
                key={child.to}
                to={child.to}
                end={child.end ?? false}
                className={({ isActive }) =>
                  [
                    'whitespace-nowrap rounded-md px-3 py-1 text-xs font-medium transition-colors',
                    isActive
                      ? 'bg-brand-50 text-brand-700'
                      : 'text-ink-600 hover:bg-ink-100 hover:text-ink-900',
                  ].join(' ')
                }
              >
                {child.label}
              </NavLink>
            ))}
          </nav>
        </div>
      ) : null}

      <main className="mx-auto max-w-7xl px-4 py-6 sm:px-6">
        <Outlet />
      </main>
    </div>
  )
}

/**
 * Layout for the public intake pages. No internal navigation: an external
 * vendor should not see links into the audit tool.
 */
export function PublicLayout(): JSX.Element {
  return (
    <div className="min-h-screen bg-ink-50">
      <header className="border-b border-ink-200 bg-white">
        <div className="mx-auto flex h-14 max-w-3xl items-center px-4 sm:px-6">
          <span className="text-sm font-semibold text-ink-900">Capella Video Submission</span>
        </div>
      </header>

      <main className="mx-auto max-w-3xl px-4 py-8 sm:px-6">
        <Outlet />
      </main>
    </div>
  )
}

export interface PageHeaderProps {
  title: string
  description?: string
  children?: React.ReactNode
}

export function PageHeader({ title, description, children }: PageHeaderProps): JSX.Element {
  return (
    <div className="mb-6 flex flex-wrap items-start justify-between gap-3">
      <div>
        <h1 className="text-xl font-semibold text-ink-900">{title}</h1>
        {description ? <p className="mt-1 text-sm text-ink-600">{description}</p> : null}
      </div>
      {children ? <div className="flex gap-2">{children}</div> : null}
    </div>
  )
}
