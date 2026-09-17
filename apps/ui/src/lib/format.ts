/** Shared formatting helpers. */

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB'] as const

export function formatBytes(bytes: number): string {
  if (bytes <= 0) return '0 B'

  const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), UNITS.length - 1)
  const value = bytes / 1024 ** exponent
  // Whole numbers for bytes, one decimal above that.
  return `${exponent === 0 ? value : value.toFixed(1)} ${UNITS[exponent]}`
}

export function formatDate(iso: string | null): string {
  if (!iso) return '—'
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleDateString()
}

export function formatDateTime(iso: string | null): string {
  if (!iso) return '—'
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString()
}

/** `HH:MM:SS` or `MM:SS` to seconds — used to seek the video preview. */
export function timestampToSeconds(value: string): number {
  const parts = value.split(':').map(Number)
  if (parts.some((part) => Number.isNaN(part))) return 0

  if (parts.length === 3) return (parts[0] ?? 0) * 3600 + (parts[1] ?? 0) * 60 + (parts[2] ?? 0)
  if (parts.length === 2) return (parts[0] ?? 0) * 60 + (parts[1] ?? 0)
  return parts[0] ?? 0
}

/** Drop a leading `00:` so chapter lists read as `2:14` rather than `00:02:14`. */
export function shortTimestamp(value: string): string {
  return value.replace(/^00:/, '').replace(/^0/, '')
}
