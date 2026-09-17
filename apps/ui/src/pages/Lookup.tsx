import { useEffect, useRef, useState, type DragEvent, type FormEvent } from 'react'
import { Link } from 'react-router-dom'
import { PageHeader } from '../components/Layout'
import { StatusBadge } from '../components/StatusBadge'
import { EmptyState, ErrorState, PhaseNotice, Skeleton } from '../components/States'
import {
  useImageCoverage,
  useImageSearch,
  useIndexImages,
  useReverseLookup,
  type ImageMatch,
  type MatchConfidence,
} from '../api/queries'
import { formatBytes } from '../lib/format'

type Mode = 'path' | 'image'

/**
 * `/lookup` — find where an asset is used, starting from either its DAM path or
 * the picture itself.
 */
export default function Lookup(): JSX.Element {
  const [mode, setMode] = useState<Mode>('path')

  return (
    <div>
      <PageHeader
        title="Reverse lookup"
        description="Find every page an asset appears on — search by its DAM path, or by the image itself."
      />

      <div role="tablist" aria-label="Lookup method" className="mb-5 flex flex-wrap gap-2">
        <TabButton active={mode === 'path'} onClick={() => setMode('path')}>
          By path or URL
        </TabButton>
        <TabButton active={mode === 'image'} onClick={() => setMode('image')}>
          By image
        </TabButton>
      </div>

      {mode === 'path' ? <PathLookup /> : <ImageLookup />}
    </div>
  )
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean
  onClick: () => void
  children: React.ReactNode
}): JSX.Element {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={[
        'rounded-md px-3 py-2 text-sm font-medium',
        active
          ? 'bg-brand-600 text-white'
          : 'bg-white text-ink-700 ring-1 ring-ink-300 hover:bg-ink-50',
      ].join(' ')}
    >
      {children}
    </button>
  )
}

// ─── Path lookup ─────────────────────────────────────────────────────────────

function PathLookup(): JSX.Element {
  const [input, setInput] = useState('')
  const [submitted, setSubmitted] = useState('')

  const lookup = useReverseLookup(submitted, submitted.length > 0)

  function handleSubmit(event: FormEvent): void {
    event.preventDefault()
    setSubmitted(input.trim())
  }

  return (
    <div>
      <form onSubmit={handleSubmit} className="flex flex-col gap-2 sm:flex-row">
        <input
          type="text"
          value={input}
          onChange={(event) => setInput(event.target.value)}
          data-testid="lookup-input"
          placeholder="/content/dam/capella/images/hero.jpg"
          spellCheck={false}
          className="w-full min-w-0 rounded-md border border-ink-300 px-3 py-2 font-mono text-sm sm:flex-1"
        />
        <button
          type="submit"
          disabled={input.trim().length === 0}
          className="rounded-md bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700 disabled:bg-ink-300"
        >
          Look up
        </button>
      </form>

      <p className="mt-2 text-xs text-ink-500">
        Rendition and transform URLs work too — they are reduced to the underlying asset.
      </p>

      <div className="mt-6">
        {!submitted ? (
          <EmptyState
            title="Nothing looked up yet"
            message="Copy an asset path out of AEM, or right-click an image on capella.edu and copy its address."
          />
        ) : lookup.isLoading ? (
          <Skeleton rows={5} />
        ) : lookup.isError ? (
          <ErrorState error={lookup.error} />
        ) : lookup.data ? (
          <article className="rounded-lg border border-ink-200 bg-white p-4">
            <div className="flex flex-wrap gap-4">
              <img
                src={lookup.data.publicUrl}
                alt={lookup.data.filename}
                loading="lazy"
                className="asset-preview h-24 w-32 rounded border border-ink-200 p-1"
                onError={(event) => {
                  event.currentTarget.style.display = 'none'
                }}
              />
              <div className="min-w-0 flex-1">
                <h2 className="font-medium text-ink-900">{lookup.data.filename}</h2>
                <p className="mt-1 break-all font-mono text-xs text-ink-500">
                  {lookup.data.aemPath}
                </p>
                <p className="mt-2 text-sm text-ink-600">
                  Appears on {lookup.data.referenceCount} page
                  {lookup.data.referenceCount === 1 ? '' : 's'}
                  {lookup.data.width && lookup.data.height
                    ? ` · ${lookup.data.width}×${lookup.data.height}`
                    : ''}
                </p>
                <a
                  href={lookup.data.publicUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="mt-2 inline-block text-sm text-brand-700 hover:underline"
                >
                  Open in AEM →
                </a>
              </div>
            </div>

            <h3 className="mt-6 text-md font-semibold text-ink-900">Pages using this asset</h3>
            <PageList pages={lookup.data.pages} emptyMessage="Indexed, but not currently referenced by any audited page. It may be used on a page that has not been audited yet." />

            <PhaseNotice>
              This shows pages that have been audited. An asset can also be referenced on pages
              nobody has audited yet — accurate, DAM-wide reverse lookup needs AEM Query Builder
              access.
            </PhaseNotice>
          </article>
        ) : null}
      </div>
    </div>
  )
}

// ─── Image lookup ────────────────────────────────────────────────────────────

const CONFIDENCE_LABELS: Record<MatchConfidence, { label: string; className: string }> = {
  exact: { label: 'Exact match', className: 'bg-verified-100 text-verified-800' },
  near_identical: { label: 'Almost certainly the same', className: 'bg-verified-100 text-verified-800' },
  very_similar: { label: 'Very similar', className: 'bg-brand-100 text-brand-800' },
  similar: { label: 'Similar', className: 'bg-caution-100 text-caution-800' },
}

function ImageLookup(): JSX.Element {
  const [file, setFile] = useState<File | null>(null)
  const [imageUrl, setImageUrl] = useState('')
  const [preview, setPreview] = useState<string | null>(null)
  const [isDragging, setIsDragging] = useState(false)
  const [strict, setStrict] = useState(true)

  const fileInput = useRef<HTMLInputElement>(null)

  const coverage = useImageCoverage()
  const search = useImageSearch()
  const indexImages = useIndexImages()

  // Object URLs leak if they are not revoked when the selection changes.
  useEffect(() => {
    if (!file) {
      setPreview(null)
      return
    }
    const url = URL.createObjectURL(file)
    setPreview(url)
    return () => URL.revokeObjectURL(url)
  }, [file])

  function chooseFile(next: File | null): void {
    setFile(next)
    setImageUrl('')
    search.reset()
  }

  function handleDrop(event: DragEvent<HTMLLabelElement>): void {
    event.preventDefault()
    setIsDragging(false)
    const dropped = event.dataTransfer.files[0]
    if (dropped) chooseFile(dropped)
  }

  function handleSubmit(event: FormEvent): void {
    event.preventDefault()
    // Strict finds the same picture; loose also surfaces visually similar ones.
    const threshold = strict ? 12 : 32

    if (file) search.mutate({ file, threshold })
    else if (imageUrl.trim()) search.mutate({ imageUrl: imageUrl.trim(), threshold })
  }

  const canSearch = (file !== null || imageUrl.trim().length > 0) && !search.isPending
  const hashed = coverage.data?.hashedImages ?? 0
  const totalImages = coverage.data?.totalImages ?? 0
  const lowCoverage = totalImages > 0 && hashed < totalImages

  return (
    <div>
      <form onSubmit={handleSubmit} className="space-y-4">
        <label
          onDragOver={(event) => {
            event.preventDefault()
            setIsDragging(true)
          }}
          onDragLeave={() => setIsDragging(false)}
          onDrop={handleDrop}
          className={[
            'flex cursor-pointer flex-col items-center justify-center rounded-lg border-2 border-dashed px-6 py-8 text-center',
            isDragging ? 'border-brand-600 bg-brand-50' : 'border-ink-300 bg-white',
          ].join(' ')}
        >
          <input
            ref={fileInput}
            type="file"
            accept="image/*"
            data-testid="image-search-input"
            onChange={(event) => chooseFile(event.target.files?.[0] ?? null)}
            className="sr-only"
          />

          {preview ? (
            <img
              src={preview}
              alt="Selected"
              className="asset-preview mb-3 max-h-40 rounded border border-ink-200 p-2"
            />
          ) : null}

          <span className="text-sm font-medium text-ink-900">
            {file ? file.name : 'Drop an image here, or click to choose one'}
          </span>
          <span className="mt-1 text-xs text-ink-500">
            {file
              ? `${formatBytes(file.size)} — click to pick a different image`
              : 'JPEG, PNG, GIF, WebP, AVIF, TIFF, BMP or SVG, up to 25MB'}
          </span>
        </label>

        <div className="flex items-center gap-3">
          <span className="h-px flex-1 bg-ink-200" />
          <span className="text-label uppercase text-ink-500">or paste a URL</span>
          <span className="h-px flex-1 bg-ink-200" />
        </div>

        <input
          type="url"
          value={imageUrl}
          onChange={(event) => {
            setImageUrl(event.target.value)
            setFile(null)
            search.reset()
          }}
          data-testid="image-search-url"
          placeholder="https://example.com/some-image.jpg"
          className="w-full rounded-md border border-ink-300 px-3 py-2 text-sm"
        />

        <div className="flex flex-wrap items-center justify-between gap-3">
          <label className="flex items-center gap-2 text-sm text-ink-700">
            <input
              type="checkbox"
              checked={strict}
              onChange={(event) => setStrict(event.target.checked)}
              className="rounded border-ink-300"
            />
            Only the same picture
            <span className="text-xs text-ink-500">
              (uncheck to include visually similar images)
            </span>
          </label>

          <button
            type="submit"
            disabled={!canSearch}
            data-testid="image-search-submit"
            className="rounded-md bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700 disabled:cursor-not-allowed disabled:bg-ink-300"
          >
            {search.isPending ? 'Searching…' : 'Search the DAM'}
          </button>
        </div>
      </form>

      {/* Coverage matters: an unhashed asset cannot match, so "no results"
          would otherwise read as "not in the DAM". */}
      {coverage.isLoading ? null : lowCoverage ? (
        <div className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-md border border-caution-200 bg-caution-50 px-4 py-3 text-sm text-caution-900">
          <span>
            Only {hashed} of {totalImages} indexed images have been fingerprinted. Images that
            have not been fingerprinted cannot be matched.
          </span>
          <button
            type="button"
            onClick={() => indexImages.mutate()}
            disabled={indexImages.isPending}
            className="rounded-md bg-caution-600 px-3 py-2 text-xs font-medium text-white hover:bg-caution-700 disabled:bg-ink-300"
          >
            {indexImages.isPending ? 'Queued…' : 'Fingerprint the rest'}
          </button>
        </div>
      ) : totalImages > 0 ? (
        <p className="mt-4 text-xs text-ink-500">
          All {totalImages} indexed images are fingerprinted and searchable.
        </p>
      ) : null}

      {indexImages.isSuccess ? (
        <p className="mt-2 text-xs text-ink-600">
          Fingerprinting queued — it runs in the background. Search again in a moment.
        </p>
      ) : null}

      <div className="mt-6">
        {search.isPending ? (
          <Skeleton rows={3} />
        ) : search.isError ? (
          <ErrorState error={search.error} />
        ) : search.isSuccess ? (
          search.data.matches.length === 0 ? (
            <EmptyState
              title="No matching asset in the DAM"
              message={
                lowCoverage
                  ? 'Nothing matched — but not every indexed image has been fingerprinted yet, so this is not conclusive. Fingerprint the rest and try again.'
                  : strict
                    ? 'No indexed asset is the same picture. Try unchecking "Only the same picture" to see visually similar images.'
                    : 'Nothing in the index looks like this image. It may not be in the DAM, or it may live on a page that has not been audited yet.'
              }
            />
          ) : (
            <>
              <h2 className="mb-3 text-md font-semibold text-ink-900">
                {search.data.matches.length} match
                {search.data.matches.length === 1 ? '' : 'es'} in the DAM
              </h2>
              <ul className="space-y-3">
                {search.data.matches.map((match) => (
                  <li key={match.assetId}>
                    <MatchCard match={match} />
                  </li>
                ))}
              </ul>
            </>
          )
        ) : null}
      </div>
    </div>
  )
}

function MatchCard({ match }: { match: ImageMatch }): JSX.Element {
  const confidence = CONFIDENCE_LABELS[match.confidence]

  return (
    <article className="rounded-lg border border-ink-200 bg-white p-4">
      <div className="flex flex-wrap gap-4">
        <img
          src={match.publicUrl}
          alt={match.filename}
          loading="lazy"
          className="asset-preview h-24 w-24 shrink-0 rounded border border-ink-200 p-1"
          onError={(event) => {
            event.currentTarget.style.visibility = 'hidden'
          }}
        />

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span
              className={`inline-flex items-center rounded-full px-2 py-1 text-xs font-medium ${confidence.className}`}
              title={`${match.distance} of ${match.aemPath.length > 0 ? 256 : 0} bits differ`}
            >
              {confidence.label}
            </span>
            <span className="text-xs tabular-nums text-ink-500">
              {(match.similarity * 100).toFixed(1)}% similar
            </span>
          </div>

          <Link
            to={`/assets/${match.assetId}`}
            className="mt-1 block font-medium text-brand-700 hover:underline"
          >
            {match.filename}
          </Link>
          <p className="mt-1 break-all font-mono text-xs text-ink-500">{match.aemPath}</p>
          <p className="mt-1 text-xs text-ink-500">
            {match.width && match.height ? `${match.width}×${match.height}` : 'Dimensions unknown'}
            {match.fileSize ? ` · ${formatBytes(match.fileSize)}` : ''}
          </p>
        </div>
      </div>

      <h3 className="mt-4 text-md font-semibold text-ink-900">
        Used on {match.referenceCount} page{match.referenceCount === 1 ? '' : 's'}
      </h3>
      <PageList
        pages={match.pages}
        emptyMessage="This asset is in the index but no audited page references it."
      />
    </article>
  )
}

// ─── Shared ──────────────────────────────────────────────────────────────────

function PageList({
  pages,
  emptyMessage,
}: {
  pages: ImageMatch['pages']
  emptyMessage: string
}): JSX.Element {
  if (pages.length === 0) {
    return <p className="mt-2 text-sm text-ink-600">{emptyMessage}</p>
  }

  return (
    <ul className="mt-2 divide-y divide-ink-100">
      {pages.map((page) => (
        <li key={page.pageId} className="flex flex-wrap items-center gap-2 py-2">
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
  )
}
