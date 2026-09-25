import { useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import {
  actionsConfigured,
  canDispatchFromUi,
  dispatchAudit,
  workflowUrl,
} from '../api/actions'
import { ActionsRuns } from './ActionsRuns'

/**
 * Start an audit from this page when there is no backend to start it with.
 *
 * The published snapshot has no API — crawling needs Chromium, Postgres and
 * Redis, and nothing free hosts a persistent worker. What it does have is a
 * GitHub Actions workflow that runs the real stack for the minutes an audit
 * takes. Until now that could only be started from the Actions tab: leave the
 * tool, find the workflow, paste the URLs into a form that looks nothing like
 * this one, then come back later and hope.
 *
 * So the tool's own form starts it. Two routes, depending on what the
 * deployment has been given:
 *
 * - With a token in a serverless function, this posts the URLs and the run
 *   starts. One click.
 * - Without one, it copies the URLs and opens the workflow page, which is two
 *   clicks and needs no secret at all.
 *
 * The fallback is not a placeholder. A fine-grained token with `actions: write`
 * is a real decision for whoever owns the repository, and the tool should be
 * fully usable by someone who has not made it yet.
 */
export interface RunViaActionsProps {
  /** One URL per line, already filtered to lines that parse as URLs. */
  urls: string[]
  name: string
  disabled: boolean
}

export function RunViaActions({ urls, name, disabled }: RunViaActionsProps): JSX.Element {
  const [copied, setCopied] = useState(false)

  const dispatch = useMutation({
    mutationFn: () => dispatchAudit({ urls: urls.join('\n'), name, revalidate: false }),
  })

  if (!actionsConfigured) {
    return (
      <div className="rounded-md border border-ink-200 bg-ink-50 px-4 py-3 text-sm text-ink-700">
        This build has no repository configured, so it cannot start an audit. Set{' '}
        <code className="font-mono text-xs">VITE_GITHUB_REPOSITORY</code> at build time — see{' '}
        <code className="font-mono text-xs">docs/deploy-runbook.md</code>.
      </div>
    )
  }

  async function copyAndOpen(): Promise<void> {
    try {
      await navigator.clipboard.writeText(urls.join('\n'))
      setCopied(true)
    } catch {
      // Clipboard access is refused in some browsers and over plain http.
      // Opening the workflow is still the useful half, so carry on.
      setCopied(false)
    }
    window.open(workflowUrl, '_blank', 'noopener')
  }

  return (
    <div className="space-y-4">
      <div className="rounded-md border border-ink-200 bg-white p-4">
        <h3 className="text-sm font-semibold text-ink-900">Run this audit on GitHub</h3>
        <p className="mt-1 text-xs leading-relaxed text-ink-600">
          This site is a published snapshot with no backend, so the audit runs in GitHub
          Actions instead — the same scraper, the same database, started on demand and shut
          down afterwards. It takes a few minutes per page. When it finishes, the refreshed
          index is committed and this site rebuilds with the new findings.
        </p>

        {canDispatchFromUi ? (
          <>
            <button
              type="button"
              onClick={() => dispatch.mutate()}
              disabled={disabled || dispatch.isPending || urls.length === 0}
              className="mt-3 rounded-md bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700 disabled:cursor-not-allowed disabled:bg-ink-300"
            >
              {dispatch.isPending
                ? 'Starting…'
                : `Run ${urls.length} URL${urls.length === 1 ? '' : 's'} on GitHub`}
            </button>

            {dispatch.isSuccess ? (
              <p className="mt-2 text-xs text-verified-800">
                Started. It appears below within a few seconds.
              </p>
            ) : null}

            {dispatch.isError ? (
              <p className="mt-2 text-xs text-critical-800">{(dispatch.error as Error).message}</p>
            ) : null}
          </>
        ) : (
          <>
            <button
              type="button"
              onClick={() => void copyAndOpen()}
              disabled={disabled || urls.length === 0}
              className="mt-3 rounded-md bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700 disabled:cursor-not-allowed disabled:bg-ink-300"
            >
              Copy {urls.length} URL{urls.length === 1 ? '' : 's'} and open GitHub
            </button>

            <p className="mt-2 text-xs text-ink-600">
              {copied ? 'Copied. ' : ''}On the page that opens, choose{' '}
              <strong className="font-medium">Run workflow</strong>, paste into the URLs box and
              confirm.
            </p>

            <p className="mt-2 text-xs text-ink-500">
              One click instead of two needs a GitHub token this deployment does not have.{' '}
              <code className="font-mono text-[11px]">docs/deploy-runbook.md</code> covers adding
              one.
            </p>
          </>
        )}
      </div>

      <div>
        <h3 className="mb-2 text-sm font-semibold text-ink-900">Recent runs</h3>
        <ActionsRuns />
      </div>
    </div>
  )
}
