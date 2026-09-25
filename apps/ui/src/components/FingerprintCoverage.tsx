import { useState } from 'react'
import { useUnhashableImages, type ImageSearchCoverage } from '../api/queries'
import { outstandingFingerprints } from '../lib/coverage'

/**
 * How much of the image index can be matched, stated against the right
 * denominator.
 *
 * This used to read "Only 655 of 665 indexed images have been fingerprinted"
 * with a button to fingerprint the rest. The button did nothing, because the
 * remaining ten cannot be fingerprinted by anyone: the site answers 403 for
 * eight of them, one path now returns a web page instead of the file, and one
 * is a 1x1 transparent spacer with no visual content to match on. Running the
 * sweep re-downloaded all ten and changed nothing, so the warning stayed up
 * permanently and the tool looked unfinished when it was done.
 *
 * The fix is not to hide the gap. It is to measure against what is actually
 * achievable and show the excluded files by name, so the shortfall reads as
 * what it is — a set of findings about the site — rather than as outstanding
 * work.
 */
export interface FingerprintCoverageProps {
  coverage: ImageSearchCoverage
  /** Rendered inside the warning when there is genuine work outstanding. */
  action?: React.ReactNode
}

export function FingerprintCoverage({ coverage, action }: FingerprintCoverageProps) {
  const [showExcluded, setShowExcluded] = useState(false)

  const { totalImages, hashedImages } = coverage
  const unhashable = coverage.unhashableImages ?? 0

  // The denominator that matters. An image the host will not serve is not
  // pending work, and counting it as such makes a complete index look partial.
  const hashable = Math.max(totalImages - unhashable, 0)
  const outstanding = outstandingFingerprints(coverage)

  // Only fetched when someone opens the list — it is a rare click.
  const excluded = useUnhashableImages(showExcluded && unhashable > 0)

  if (totalImages === 0) return null

  return (
    <div className="mt-4 text-sm">
      {outstanding > 0 ? (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-caution-200 bg-caution-50 px-4 py-3 text-caution-900">
          <span>
            {hashedImages} of {hashable} images have been fingerprinted. The remaining{' '}
            {outstanding} cannot be matched until they are.
          </span>
          {action}
        </div>
      ) : (
        <p className="text-xs text-ink-500">
          All {hashedImages} images that can be fingerprinted have been, and are searchable.
        </p>
      )}

      {unhashable > 0 ? (
        <div className="mt-2">
          <button
            type="button"
            onClick={() => setShowExcluded((open) => !open)}
            className="text-xs text-ink-600 underline decoration-dotted underline-offset-2 hover:text-ink-900"
            aria-expanded={showExcluded}
          >
            {showExcluded ? 'Hide' : 'Show'} the {unhashable}{' '}
            {unhashable === 1 ? 'image' : 'images'} that cannot be fingerprinted
          </button>

          {showExcluded ? (
            <div className="mt-2 rounded-md border border-ink-200 bg-ink-50 px-4 py-3">
              <p className="mb-2 text-xs text-ink-600">
                These are excluded from the count above. Nothing the tool does will change
                them — each one is a fact about how the site serves that path.
              </p>

              {excluded.isLoading ? (
                <p className="text-xs text-ink-500">Loading…</p>
              ) : excluded.isError ? (
                <p className="text-xs text-ink-500">
                  The list could not be loaded. The count above is still accurate.
                </p>
              ) : (
                <ul className="space-y-2">
                  {(excluded.data ?? []).map((image) => (
                    <li key={image.aemPath} className="text-xs">
                      <span className="font-medium text-ink-900">{image.filename}</span>
                      <span className="ml-2 text-ink-600">{image.label}</span>
                      <div className="truncate font-mono text-[11px] text-ink-400">
                        {image.aemPath}
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
