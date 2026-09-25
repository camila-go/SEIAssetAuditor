import { useState } from 'react'
import { Link } from 'react-router-dom'
import { PageHeader } from '../components/Layout'
import { EmptyState, ErrorState, Skeleton } from '../components/States'
import { useDuplicates } from '../api/queries'
import { outstandingFingerprints } from '../lib/coverage'
import { formatBytes } from '../lib/format'

/**
 * `/duplicates` — Phase 2.
 *
 * Perceptual hashing catches renamed and re-exported copies, which filename
 * matching misses entirely.
 */
export default function Duplicates(): JSX.Element {
  const [threshold, setThreshold] = useState(10)
  const duplicates = useDuplicates(threshold)

  return (
    <div>
      <PageHeader
        title="Duplicate assets"
        description="Visually identical or near-identical images, grouped by perceptual hash."
      />

      <div className="mb-4 flex flex-wrap items-center gap-3">
        <label htmlFor="threshold" className="text-sm text-ink-700">
          Sensitivity
        </label>
        <input
          id="threshold"
          type="range"
          min={0}
          max={20}
          value={threshold}
          onChange={(event) => setThreshold(Number(event.target.value))}
          className="w-48"
        />
        <span className="text-sm tabular-nums text-ink-600">
          Hamming distance ≤ {threshold}
        </span>
        <span className="text-xs text-ink-500">
          Lower is stricter. 10 is the recommended default.
        </span>
      </div>

      {duplicates.isLoading ? (
        <Skeleton rows={6} />
      ) : duplicates.isError ? (
        <ErrorState error={duplicates.error} />
      ) : !duplicates.data || duplicates.data.groups.length === 0 ? (
        <EmptyState
          title="No duplicates found"
          message={
            duplicates.data && outstandingFingerprints(duplicates.data.coverage) > 0
              ? `${duplicates.data.coverage.hashedImages} of ${duplicates.data.coverage.totalImages - (duplicates.data.coverage.unhashableImages ?? 0)} images have been fingerprinted, so this is not conclusive. Fingerprint the rest from Reverse lookup → By image.`
              : `No two indexed images are within a Hamming distance of ${threshold}. Try raising the sensitivity, or run more audits to index more assets.`
          }
        />
      ) : (
        <ul className="space-y-4">
          {duplicates.data.groups.map((group) => (
            <li key={group.phash} className="rounded-lg border border-ink-200 bg-white p-4">
              <p className="mb-3 text-sm font-medium text-ink-900">
                {group.assets.length} similar assets
                <span className="ml-2 font-normal text-ink-500">
                  max distance {group.maxDistance}
                </span>
              </p>

              <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                {group.assets.map((asset) => (
                  <li key={asset.id}>
                    <Link to={`/assets/${asset.id}`} className="block hover:opacity-80">
                      <p className="truncate text-sm text-brand-700" title={asset.filename}>
                        {asset.filename}
                      </p>
                      <p className="mt-1 text-xs text-ink-500">
                        {asset.width && asset.height ? `${asset.width}×${asset.height}` : 'Unknown size'}
                        {asset.fileSize ? ` · ${formatBytes(asset.fileSize)}` : ''}
                      </p>
                      <p className="mt-1 break-all font-mono text-[10px] text-ink-500">
                        {asset.aemPath}
                      </p>
                    </Link>
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
