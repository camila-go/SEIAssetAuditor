import { useState } from 'react'

/**
 * An asset thumbnail that says something useful when it cannot load.
 *
 * The three previous call sites all set `visibility: hidden` or `display: none`
 * on error, which leaves a blank hole. That is indistinguishable from a bug in
 * this tool, and for these assets it is not one: capella.edu's dispatcher does
 * not serve every DAM folder publicly. `/content/dam/vc/...` redirects to a
 * trailing slash and returns 403, while `/content/dam/sei/capella/...` returns
 * 200 — measured, not guessed.
 *
 * So a missing thumbnail is a real finding about the asset, and it is also why
 * pHash coverage stops short of 100%: an image the tool cannot fetch is an image
 * it cannot fingerprint. Saying so costs one line of text and prevents someone
 * concluding the auditor is broken.
 */
export interface AssetPreviewProps {
  src: string
  /** Alt text stays empty by default: the filename is always adjacent. */
  alt?: string
  /** Applied to both the image and the fallback, so layout never shifts. */
  className?: string
  /** Shown in the fallback. Keep it to a couple of words. */
  label?: string
}

export function AssetPreview({
  src,
  alt = '',
  className = '',
  label = 'Not publicly served',
}: AssetPreviewProps): JSX.Element {
  const [failed, setFailed] = useState(false)

  if (failed) {
    return (
      <div
        className={`grid place-items-center bg-ink-100 px-2 text-center ${className}`}
        role="img"
        aria-label={`Preview unavailable — ${label}`}
      >
        <span className="text-label font-medium uppercase leading-tight tracking-wide text-ink-500">
          {label}
        </span>
      </div>
    )
  }

  return (
    <img
      src={src}
      alt={alt}
      loading="lazy"
      className={className}
      onError={() => setFailed(true)}
    />
  )
}
