import { useEffect, useState, type DragEvent, type FormEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import { PageHeader } from '../components/Layout'
import { ErrorState, PhaseNotice } from '../components/States'
import { useMutation, useQuery } from '@tanstack/react-query'
import { useCreateAudit } from '../api/queries'
import { useAuditStore } from '../store/auditStore'
import { IS_STATIC } from '../api/client'
import { checkService, fetchSnapshotDate, startAudit } from '../api/actions'
import {
  RemoteAuditProgress,
  loadRemoteAudit,
  saveRemoteAudit,
  type RemoteAudit,
} from '../components/RemoteAuditProgress'
import { normalizeUrl } from '@capella/types'

type InputMode = 'paste' | 'csv' | 'sitemap'

const TABS: Array<{ mode: InputMode; label: string }> = [
  { mode: 'paste', label: 'Paste URLs' },
  { mode: 'csv', label: 'Upload CSV / TXT' },
  { mode: 'sitemap', label: 'Sitemap URL' },
]

/** `/audit` — three input modes. On submit, go straight to the live job view. */
export default function StartAudit(): JSX.Element {
  const navigate = useNavigate()
  const trackJob = useAuditStore((state) => state.trackJob)
  const createAudit = useCreateAudit()

  const [mode, setMode] = useState<InputMode>('paste')
  const [name, setName] = useState('')
  const [urls, setUrls] = useState('')
  const [sitemapUrl, setSitemapUrl] = useState('')
  const [file, setFile] = useState<File | null>(null)
  const [isDragging, setIsDragging] = useState(false)

  // Counted with the same rule the API queues by, so the preview cannot promise
  // more than the audit delivers. Counting non-blank lines said "6 URLs
  // detected" for five filenames and one real address.
  const parsedUrls = urls
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'))
  const urlCount = parsedUrls.filter((line) => normalizeUrl(line) !== null).length
  const unreadableCount = parsedUrls.length - urlCount

  // ── The published site ────────────────────────────────────────────────────
  //
  // No backend here, so Start audit goes to the site's own audit service
  // (api/run-audit.mjs) instead of the API. Same form, same button; the person
  // using the tool should not be able to tell the difference except that
  // results arrive when the audit finishes rather than page by page.
  //
  // A CSV is read in the browser, because the service takes a list of URLs.
  // A sitemap is sent as-is and expanded by the service.
  const [csvUrls, setCsvUrls] = useState<string[]>([])
  const [remoteAudit, setRemoteAudit] = useState<RemoteAudit | null>(() =>
    IS_STATIC ? loadRemoteAudit() : null,
  )

  const service = useQuery({
    queryKey: ['audit-service'],
    queryFn: checkService,
    enabled: IS_STATIC,
    staleTime: 5 * 60_000,
  })
  const serviceBlocked =
    service.data?.kind === 'not-configured' || service.data?.kind === 'missing'

  const startRemote = useMutation({
    mutationFn: async () => {
      const snapshotBefore = await fetchSnapshotDate()
      const started = await startAudit({
        name: name.trim(),
        ...(mode === 'sitemap' ? { sitemapUrl: sitemapUrl.trim() } : { urls: dispatchableUrls }),
      })
      return { ...started, snapshotBefore }
    },
    onSuccess: (started) => {
      const audit: RemoteAudit = {
        since: started.startedAt,
        clickedAt: new Date().toISOString(),
        totalUrls: started.totalUrls,
        name: name.trim(),
        snapshotBefore: started.snapshotBefore,
      }
      saveRemoteAudit(audit)
      setRemoteAudit(audit)
    },
  })

  function dismissRemoteAudit(): void {
    saveRemoteAudit(null)
    setRemoteAudit(null)
    startRemote.reset()
  }

  useEffect(() => {
    if (!IS_STATIC || mode !== 'csv' || file === null) {
      setCsvUrls([])
      return
    }

    let cancelled = false
    void file.text().then((text) => {
      if (cancelled) return
      setCsvUrls(
        text
          .split(/\r?\n/)
          // First column only, matching what the API does with an upload.
          .map((line) => (line.split(',')[0] ?? '').trim())
          .filter((line) => line.length > 0 && !line.startsWith('#'))
          .filter((line) => normalizeUrl(line) !== null),
      )
    })

    return () => {
      cancelled = true
    }
  }, [mode, file])

  const dispatchableUrls =
    mode === 'csv'
      ? csvUrls
      : mode === 'paste'
        ? parsedUrls.filter((line) => normalizeUrl(line) !== null)
        : []

  const hasInput =
    (mode === 'paste' && urlCount > 0) ||
    (mode === 'csv' && (IS_STATIC ? csvUrls.length > 0 : file !== null)) ||
    (mode === 'sitemap' && sitemapUrl.trim().length > 0)

  const canSubmit = IS_STATIC
    ? hasInput && !startRemote.isPending && !serviceBlocked
    : hasInput && !createAudit.isPending

  async function handleSubmit(event: FormEvent): Promise<void> {
    event.preventDefault()
    if (!canSubmit) return

    if (IS_STATIC) {
      startRemote.mutate()
      return
    }

    const result = await createAudit.mutateAsync({
      ...(name.trim() ? { name: name.trim() } : {}),
      ...(mode === 'paste' ? { urls } : {}),
      ...(mode === 'sitemap' ? { sitemapUrl: sitemapUrl.trim() } : {}),
      ...(mode === 'csv' && file ? { file } : {}),
    })

    trackJob({
      jobId: result.jobId,
      name: name.trim() || 'Audit',
      totalUrls: result.totalUrls,
      startedAt: new Date().toISOString(),
    })

    // Carried in navigation state rather than shown here: submitting leaves
    // this page immediately, so a notice rendered here would never be read.
    navigate(`/audit/${result.jobId}`, { state: { skipped: result.skipped } })
  }

  function handleDrop(event: DragEvent<HTMLLabelElement>): void {
    event.preventDefault()
    setIsDragging(false)
    const dropped = event.dataTransfer.files[0]
    if (dropped) setFile(dropped)
  }

  return (
    <div>
      <PageHeader
        title="Run an audit"
        description="Scrapes each page for DAM asset references and testimonials. Runs in the background — you can close this tab."
      />

      {remoteAudit ? (
        <div className="mb-6">
          <RemoteAuditProgress audit={remoteAudit} onDismiss={dismissRemoteAudit} />
        </div>
      ) : null}

      <PhaseNotice>
        {IS_STATIC
          ? 'An audit takes a few minutes to start, then about ten seconds a page. The findings appear throughout the tool when it finishes.'
          : 'A 1000-URL audit takes roughly 60–90 minutes at safe scraping rates. Results are queryable as soon as the first batch lands, so there is no need to wait for the whole job.'}
      </PhaseNotice>

      {IS_STATIC && service.data?.kind === 'not-configured' ? (
        <div className="mt-4 rounded-md border border-caution-200 bg-caution-50 px-4 py-3 text-sm text-caution-900">
          {service.data.message}
        </div>
      ) : null}

      {IS_STATIC && service.data?.kind === 'missing' ? (
        <div className="mt-4 rounded-md border border-caution-200 bg-caution-50 px-4 py-3 text-sm text-caution-900">
          Audits cannot start on this site: it was published without its audit service. Whoever
          manages the Vercel project needs to set <strong>Root Directory</strong> to the
          repository root and redeploy — see docs/deploy-runbook.md.
        </div>
      ) : null}

      <form onSubmit={(event) => void handleSubmit(event)} className="mt-6 space-y-6">
        <div>
          <label htmlFor="job-name" className="block text-sm font-medium text-ink-700">
            Audit name <span className="font-normal text-ink-500">(optional)</span>
          </label>
          <input
            id="job-name"
            type="text"
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="Q3 nursing program audit"
            className="mt-1 w-full max-w-md rounded-md border border-ink-300 px-3 py-2 text-sm"
          />
        </div>

        <div>
          <div role="tablist" aria-label="Input method" className="flex flex-wrap gap-2">
            {TABS.map((tab) => (
              <button
                key={tab.mode}
                type="button"
                role="tab"
                aria-selected={mode === tab.mode}
                onClick={() => setMode(tab.mode)}
                className={[
                  'rounded-md px-3 py-2 text-sm font-medium',
                  mode === tab.mode
                    ? 'bg-brand-600 text-white'
                    : 'bg-white text-ink-700 ring-1 ring-ink-300 hover:bg-ink-50',
                ].join(' ')}
              >
                {tab.label}
              </button>
            ))}
          </div>

          <div className="mt-4">
            {mode === 'paste' ? (
              <div>
                <label htmlFor="urls" className="block text-sm font-medium text-ink-700">
                  One URL per line — no cap
                </label>
                <textarea
                  id="urls"
                  data-testid="audit-urls-input"
                  value={urls}
                  onChange={(event) => setUrls(event.target.value)}
                  rows={12}
                  spellCheck={false}
                  placeholder={'https://www.capella.edu/online-degrees/\nhttps://www.capella.edu/capella-experience/about/'}
                  className="mt-1 w-full rounded-md border border-ink-300 px-3 py-2 font-mono text-xs"
                />
                <p className="mt-1 text-xs text-ink-500">
                  {urlCount} URL{urlCount === 1 ? '' : 's'} detected. Blank lines and lines starting
                  with # are ignored.
                </p>
                {unreadableCount > 0 ? (
                  <p className="mt-1 text-xs text-caution-700">
                    {unreadableCount} line{unreadableCount === 1 ? '' : 's'} will be skipped — not a
                    web address. A filename or DAM path is not a page URL.
                  </p>
                ) : null}
              </div>
            ) : null}

            {mode === 'csv' ? (
              <div>
                <label
                  onDragOver={(event) => {
                    event.preventDefault()
                    setIsDragging(true)
                  }}
                  onDragLeave={() => setIsDragging(false)}
                  onDrop={handleDrop}
                  className={[
                    'flex cursor-pointer flex-col items-center justify-center rounded-lg border-2 border-dashed px-6 py-10 text-center',
                    isDragging ? 'border-brand-600 bg-brand-50' : 'border-ink-300 bg-white',
                  ].join(' ')}
                >
                  <input
                    type="file"
                    accept=".csv,.txt,text/csv,text/plain"
                    data-testid="audit-csv-input"
                    onChange={(event) => setFile(event.target.files?.[0] ?? null)}
                    className="sr-only"
                  />
                  <span className="text-sm font-medium text-ink-900">
                    {file ? file.name : 'Drop a CSV or TXT file, or click to choose'}
                  </span>
                  <span className="mt-1 text-xs text-ink-500">
                    URLs are read from the first column that contains one. A header row is ignored.
                  </span>
                </label>
              </div>
            ) : null}

            {mode === 'sitemap' ? (
              <div>
                <label htmlFor="sitemap" className="block text-sm font-medium text-ink-700">
                  Sitemap URL
                </label>
                <input
                  id="sitemap"
                  type="url"
                  data-testid="audit-sitemap-input"
                  value={sitemapUrl}
                  onChange={(event) => setSitemapUrl(event.target.value)}
                  placeholder="https://www.capella.edu/sitemap.xml"
                  className="mt-1 w-full max-w-xl rounded-md border border-ink-300 px-3 py-2 text-sm"
                />
                <p className="mt-1 text-xs text-ink-500">
                  Sitemap indexes are followed one level, so the top-level sitemap works.
                </p>
              </div>
            ) : null}
          </div>
        </div>

        {createAudit.isError ? <ErrorState error={createAudit.error} /> : null}

        {startRemote.isError ? (
          <div
            role="alert"
            className="rounded-md border border-critical-200 bg-critical-50 px-4 py-3 text-sm text-critical-800"
          >
            {(startRemote.error as Error).message}
          </div>
        ) : null}

        {IS_STATIC && mode === 'csv' && file !== null && csvUrls.length === 0 ? (
          <p className="text-xs text-ink-500">No web addresses found in the first column of that file.</p>
        ) : null}

        <button
          type="submit"
          disabled={!canSubmit || (IS_STATIC && remoteAudit !== null)}
          data-testid="audit-submit"
          className="rounded-md bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700 disabled:cursor-not-allowed disabled:bg-ink-300"
        >
          {createAudit.isPending || startRemote.isPending ? 'Starting…' : 'Start audit'}
        </button>

        {IS_STATIC && remoteAudit !== null ? (
          <p className="text-xs text-ink-500">
            One audit at a time — start another once the current one finishes.
          </p>
        ) : null}
      </form>
    </div>
  )
}
