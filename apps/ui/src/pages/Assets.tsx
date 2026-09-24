import { useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { PageHeader } from '../components/Layout'
import { StatusBadge } from '../components/StatusBadge'
import { EmptyState, ErrorState, Skeleton } from '../components/States'
import { useAsset, useAssets } from '../api/queries'
import { formatBytes } from '../lib/format'
import { MatchReasonBadge, SemanticNotice } from '../components/MatchReason'
import { AssetPreview } from '../components/AssetPreview'
import { IndexTransparency } from '../components/IndexTransparency'

/** `/assets` — search and browse everything indexed. */
export default function Assets(): JSX.Element {
  const [query, setQuery] = useState('')
  const [assetType, setAssetType] = useState('')
  const [page, setPage] = useState(1)

  const assets = useAssets({
    ...(query.trim() ? { query: query.trim() } : {}),
    ...(assetType ? { assetType } : {}),
    page,
    limit: 50,
  })

  const totalPages = assets.data?.meta ? Math.ceil(assets.data.meta.total / assets.data.meta.limit) : 1

  return (
    <div>
      <PageHeader
        title="Assets"
        description="Every DAM asset discovered by an audit. Search by filename or path."
      />

      <IndexTransparency />

      {/* Stacks below sm — see the note in Testimonials.tsx. */}
      <div className="mb-4 flex flex-col gap-2 sm:flex-row sm:flex-wrap">
        <input
          type="search"
          value={query}
          onChange={(event) => {
            setQuery(event.target.value)
            setPage(1)
          }}
          data-testid="asset-search"
          placeholder="hero, /nursing/, .mp4…"
          className="w-full min-w-0 rounded-md border border-ink-300 px-3 py-2 text-sm sm:flex-1"
        />
        <select
          value={assetType}
          onChange={(event) => {
            setAssetType(event.target.value)
            setPage(1)
          }}
          aria-label="Filter by asset type"
          className="select-field sm:w-auto"
        >
          <option value="">All types</option>
          <option value="image">Images</option>
          <option value="video">Video</option>
          <option value="document">Documents</option>
          <option value="audio">Audio</option>
          <option value="other">Other</option>
        </select>
      </div>

      {assets.isLoading ? (
        <Skeleton rows={8} />
      ) : assets.isError ? (
        <ErrorState error={assets.error} onRetry={() => void assets.refetch()} />
      ) : !assets.data || assets.data.assets.length === 0 ? (
        <EmptyState
          title="No assets found"
          message={
            query
              ? 'Nothing matches that search. Try a shorter term, or part of the path.'
              : 'Nothing has been indexed yet. Run an audit to populate the index.'
          }
          action={
            <Link
              to="/audit"
              className="rounded-md bg-brand-600 px-3 py-2 text-sm font-medium text-white"
            >
              Run an audit
            </Link>
          }
        />
      ) : (
        <>
        <SemanticNotice
          hasSemanticOnly={assets.data.assets.some(
            (a) => a.matchReasons.length > 0 && a.matchReasons.every((r) => r === 'semantic'),
          )}
        />
        <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {assets.data.assets.map((asset) => (
            <li key={asset.id}>
              <Link
                to={`/assets/${asset.id}`}
                className="block h-full rounded-lg border border-ink-200 bg-white p-3 hover:border-brand-600"
              >
                {asset.assetType === 'image' ? (
                  <AssetPreview
                    src={asset.publicUrl}
                    className="asset-preview mb-2 h-32 w-full rounded border border-ink-200 p-2"
                  />
                ) : (
                  <div className="mb-2 flex h-32 items-center justify-center rounded bg-ink-100 text-label uppercase text-ink-500">
                    {asset.assetType}
                  </div>
                )}
                <p className="truncate text-sm font-medium text-ink-900" title={asset.filename}>
                  {asset.filename}
                </p>
                <p className="mt-1 text-xs text-ink-500">
                  {asset.referenceCount} page{asset.referenceCount === 1 ? '' : 's'}
                  {asset.fileSize ? ` · ${formatBytes(asset.fileSize)}` : ''}
                </p>
                {asset.matchReasons.length > 0 ? (
                  <div className="mt-2">
                    <MatchReasonBadge
                      reasons={asset.matchReasons}
                      {...(asset.similarity !== undefined ? { similarity: asset.similarity } : {})}
                    />
                  </div>
                ) : null}
              </Link>
            </li>
          ))}
        </ul>
        </>
      )}

      {totalPages > 1 ? (
        <div className="mt-4 flex items-center justify-between text-sm">
          <button
            type="button"
            onClick={() => setPage((current) => Math.max(1, current - 1))}
            disabled={page === 1}
            className="rounded-md px-3 py-1 ring-1 ring-ink-300 disabled:opacity-40"
          >
            Previous
          </button>
          <span className="text-ink-600">
            Page {page} of {totalPages}
          </span>
          <button
            type="button"
            onClick={() => setPage((current) => Math.min(totalPages, current + 1))}
            disabled={page >= totalPages}
            className="rounded-md px-3 py-1 ring-1 ring-ink-300 disabled:opacity-40"
          >
            Next
          </button>
        </div>
      ) : null}
    </div>
  )
}

/** `/assets/:id` */
export function AssetDetail(): JSX.Element {
  const { id = '' } = useParams<{ id: string }>()
  const asset = useAsset(id)

  if (asset.isLoading) return <Skeleton rows={6} />
  if (asset.isError) return <ErrorState error={asset.error} onRetry={() => void asset.refetch()} />
  if (!asset.data) return <ErrorState error={new Error('Asset not found')} />

  const data = asset.data

  return (
    <div>
      <PageHeader title={data.filename} description={data.aemPath} />

      <div className="grid gap-6 lg:grid-cols-[320px_1fr]">
        <div>
          {data.assetType === 'image' ? (
            <img
              src={data.publicUrl}
              alt={data.filename}
              loading="lazy"
              className="asset-preview w-full rounded-lg border border-ink-200 p-3"
            />
          ) : (
            <div className="flex h-48 items-center justify-center rounded-lg bg-ink-100 text-sm uppercase tracking-wide text-ink-500">
              {data.assetType}
            </div>
          )}

          <dl className="mt-4 space-y-1 text-sm">
            <Row label="Type" value={data.assetType} />
            <Row
              label="Dimensions"
              value={data.width && data.height ? `${data.width}×${data.height}` : 'Unknown'}
            />
            <Row label="Size" value={data.fileSize ? formatBytes(data.fileSize) : 'Unknown'} />
            <Row
              label="Last seen"
              value={data.lastSeenAt ? new Date(data.lastSeenAt).toLocaleDateString() : 'Never'}
            />
          </dl>

          <a
            href={data.publicUrl}
            target="_blank"
            rel="noreferrer"
            className="mt-4 inline-block text-sm text-brand-700 hover:underline"
          >
            Open in AEM →
          </a>
        </div>

        <section>
          <h2 className="text-md font-semibold text-ink-900">
            Used on {data.referenceCount} page{data.referenceCount === 1 ? '' : 's'}
          </h2>

          {data.pages.length === 0 ? (
            <p className="mt-2 text-sm text-ink-600">
              No audited page references this asset. It may be unused, or used on a page that has
              not been audited.
            </p>
          ) : (
            <ul className="mt-2 divide-y divide-ink-100 rounded-lg border border-ink-200 bg-white">
              {data.pages.map((page) => (
                <li key={page.pageId} className="flex flex-wrap items-center gap-2 px-3 py-2">
                  <a
                    href={page.url}
                    target="_blank"
                    rel="noreferrer"
                    className="min-w-0 flex-1 truncate text-sm text-brand-700 hover:underline"
                  >
                    {page.title ?? page.url}
                  </a>
                  <StatusBadge status={page.liveStatus} />
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  )
}

function Row({ label, value }: { label: string; value: string }): JSX.Element {
  return (
    <div className="flex justify-between gap-4">
      <dt className="text-ink-500">{label}</dt>
      <dd className="text-right text-ink-900">{value}</dd>
    </div>
  )
}
