import { useAssetVerification, useRevalidateAssets } from '../api/queries'

/**
 * How much of what this page shows can currently be trusted.
 *
 * An audit records what a page referenced at the moment it was read, and
 * nothing afterwards tells the tool an asset was deleted, renamed or
 * unpublished. So a page map built from a crawl three months ago looks exactly
 * like one built this morning — which is the failure mode this whole tool keeps
 * finding in itself, a confident answer resting on a stale input.
 *
 * Every asset is now re-checked against the live site on a three-day cycle, and
 * this states plainly when that last happened and what it found. It is not a
 * status badge: it says what the numbers mean and what they do not cover.
 */
export function IndexTransparency(): JSX.Element | null {
  const verification = useAssetVerification()
  const revalidate = useRevalidateAssets()

  // Never block the page on this. It is context, not content.
  if (verification.isLoading || verification.isError || !verification.data) return null

  const { total, checked, missing, newestCheck, everyDays } = verification.data
  const unchecked = total - checked

  return (
    <section className="mb-4 rounded-lg border border-ink-200 bg-white px-4 py-3 shadow-card">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold text-ink-900">Where these numbers come from</h2>

          <p className="mt-1 text-sm leading-relaxed text-ink-600">
            Every asset here was found on a page this tool actually read. Pages nobody
            has audited are not represented, so &ldquo;appears on 2 pages&rdquo; means two{' '}
            <em>audited</em> pages — not two pages on capella.edu.
          </p>

          <p className="mt-2 text-sm leading-relaxed text-ink-600">
            Because an asset can be removed from the DAM long after the audit that found
            it, every asset is re-checked against the live site{' '}
            <strong className="font-medium text-ink-900">every {everyDays} days</strong>.{' '}
            {checked === 0 ? (
              <>Nothing has been re-checked yet.</>
            ) : (
              <>
                Last check{' '}
                <strong className="font-medium text-ink-900">{relativeTime(newestCheck)}</strong>,
                covering {checked.toLocaleString()} of {total.toLocaleString()} assets.
              </>
            )}
          </p>

          <dl className="mt-3 flex flex-wrap gap-x-6 gap-y-1 text-xs text-ink-600">
            <div className="flex gap-1.5">
              <dt>Confirmed still served:</dt>
              <dd className="font-semibold tabular-nums text-ink-900">
                {verification.data.live.toLocaleString()}
              </dd>
            </div>
            <div className="flex gap-1.5">
              <dt>No longer served:</dt>
              <dd
                className={[
                  'font-semibold tabular-nums',
                  missing > 0 ? 'text-critical-700' : 'text-ink-900',
                ].join(' ')}
              >
                {missing.toLocaleString()}
              </dd>
            </div>
            <div className="flex gap-1.5">
              <dt>Not yet checked:</dt>
              <dd className="font-semibold tabular-nums text-ink-900">
                {unchecked.toLocaleString()}
              </dd>
            </div>
          </dl>

          {missing > 0 ? (
            <p className="mt-2 text-xs leading-relaxed text-critical-700">
              {missing.toLocaleString()} asset{missing === 1 ? '' : 's'} returned an error from
              capella.edu on the last check — they are listed in the index but the site no longer
              serves them. Note that part of the DAM is not publicly readable at all, so some of
              these may exist and simply be unreachable without an AEM account.
            </p>
          ) : null}
        </div>

        <button
          type="button"
          onClick={() => revalidate.mutate()}
          disabled={revalidate.isPending}
          className="shrink-0 rounded-md border border-ink-300 px-3 py-2 text-xs font-medium text-ink-700 hover:border-brand-600 hover:text-brand-700 disabled:opacity-50"
        >
          {revalidate.isPending ? 'Queued…' : 'Re-check now'}
        </button>
      </div>

      {revalidate.isSuccess ? (
        <p className="mt-2 text-xs text-verified-700">
          Re-check queued. It runs in the background and this page updates as batches land.
        </p>
      ) : null}
    </section>
  )
}

/** Deliberately coarse — "2 days ago" is the useful precision here, not a timestamp. */
function relativeTime(iso: string | null): string {
  if (!iso) return 'never'

  const then = new Date(iso).getTime()
  if (Number.isNaN(then)) return 'unknown'

  const hours = Math.floor((Date.now() - then) / 3_600_000)
  if (hours < 1) return 'less than an hour ago'
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`

  const days = Math.floor(hours / 24)
  return `${days} day${days === 1 ? '' : 's'} ago`
}
