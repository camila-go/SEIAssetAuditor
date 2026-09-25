/**
 * Starting and watching audits that run in GitHub Actions.
 *
 * The published snapshot can show findings but cannot produce them — crawling
 * needs Chromium, Postgres and Redis, and no free host offers a persistent
 * worker. The workflow in `.github/workflows/audit.yml` runs the real stack for
 * the minutes an audit takes and commits the refreshed index back. That works,
 * but until now it could only be started from the Actions tab, which means
 * leaving the tool, finding the right workflow, and pasting URLs into a form
 * that looks nothing like this one.
 *
 * Two halves, with different requirements:
 *
 * - **Watching** needs nothing. The repository is public, so the GitHub REST
 *   API serves run history unauthenticated. This works on the static site
 *   today, with no configuration at all.
 * - **Starting** needs a token with `actions: write`, which cannot go in a
 *   static bundle — anyone could read it and run workflows in the repository.
 *   So it goes in a serverless function that holds the token server-side, and
 *   the UI calls that. When no function is configured the UI says so and falls
 *   back to handing the URLs to the Actions page.
 *
 * Both halves degrade rather than break: an unconfigured deployment still shows
 * run history and still explains how to start one.
 */

/** `owner/repo`, baked in at build time. Public, so this is not a secret. */
const REPOSITORY = (import.meta.env?.VITE_GITHUB_REPOSITORY ?? '').trim()

/**
 * A serverless endpoint that holds the token and dispatches the workflow.
 *
 * Absent on a deployment that has not been given a token — the common case, and
 * the one the UI has to stay useful in.
 */
const DISPATCH_URL = (import.meta.env?.VITE_GITHUB_DISPATCH_URL ?? '').trim()

const WORKFLOW_FILE = 'audit.yml'

export const actionsConfigured = REPOSITORY.length > 0
export const canDispatchFromUi = actionsConfigured && DISPATCH_URL.length > 0

export const workflowUrl = actionsConfigured
  ? `https://github.com/${REPOSITORY}/actions/workflows/${WORKFLOW_FILE}`
  : ''

export type RunStatus = 'queued' | 'in_progress' | 'completed'
export type RunConclusion = 'success' | 'failure' | 'cancelled' | 'skipped' | null

export interface WorkflowRun {
  id: number
  /** The `run-name` from the workflow — says what was audited, not just "Run an audit". */
  title: string
  number: number
  status: RunStatus
  conclusion: RunConclusion
  startedAt: string
  updatedAt: string
  url: string
  actor: string
  event: string
}

/**
 * Recent runs, read straight from GitHub.
 *
 * Unauthenticated. Public repositories allow this, and it is the reason the
 * watching half needs no setup. Rate limited to 60 requests an hour per IP,
 * which is why nothing here polls faster than every 10 seconds.
 */
export async function fetchRuns(limit = 10): Promise<WorkflowRun[]> {
  if (!actionsConfigured) return []

  const response = await fetch(
    `https://api.github.com/repos/${REPOSITORY}/actions/workflows/${WORKFLOW_FILE}/runs?per_page=${limit}`,
    { headers: { Accept: 'application/vnd.github+json' } },
  )

  if (!response.ok) {
    throw new Error(
      response.status === 403
        ? 'GitHub is rate limiting this browser. Run history will come back shortly.'
        : `GitHub returned ${response.status} for the run history.`,
    )
  }

  const body = (await response.json()) as { workflow_runs?: unknown[] }

  return (body.workflow_runs ?? []).map((raw) => {
    const run = raw as Record<string, never>
    return {
      id: Number(run['id']),
      title: String(run['display_title'] ?? run['name'] ?? 'Audit'),
      number: Number(run['run_number']),
      status: String(run['status']) as RunStatus,
      conclusion: (run['conclusion'] ?? null) as RunConclusion,
      startedAt: String(run['created_at']),
      updatedAt: String(run['updated_at']),
      url: String(run['html_url']),
      actor: String((run['actor'] as unknown as { login?: string })?.login ?? 'unknown'),
      event: String(run['event']),
    }
  })
}

export interface DispatchRequest {
  urls: string
  name?: string
  revalidate?: boolean
}

/**
 * Start an audit.
 *
 * Posts to the serverless function, never to GitHub directly: the token must
 * not be in the bundle. Callers must check `canDispatchFromUi` first — this
 * throws rather than silently doing nothing, so a miswired deployment is
 * visible instead of appearing to work.
 */
export async function dispatchAudit(request: DispatchRequest): Promise<void> {
  if (!canDispatchFromUi) {
    throw new Error(
      'This deployment has no GitHub token configured, so it cannot start a run. ' +
        'See docs/deploy-runbook.md.',
    )
  }

  const response = await fetch(DISPATCH_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      urls: request.urls,
      name: request.name ?? '',
      revalidate: request.revalidate ?? false,
    }),
  })

  if (!response.ok) {
    // The function returns a reason; surface it rather than a bare status,
    // because every likely cause here is a fixable configuration mistake.
    let message = `The run could not be started (HTTP ${response.status}).`
    try {
      const body = (await response.json()) as { error?: { message?: string } }
      if (body.error?.message) message = body.error.message
    } catch {
      // Non-JSON body — keep the status message.
    }
    throw new Error(message)
  }
}

/** How a run should read to someone who did not start it. */
export function describeRun(run: WorkflowRun): { label: string; tone: 'ok' | 'bad' | 'busy' } {
  if (run.status !== 'completed') {
    return { label: run.status === 'queued' ? 'Queued' : 'Running', tone: 'busy' }
  }
  if (run.conclusion === 'success') return { label: 'Finished', tone: 'ok' }
  if (run.conclusion === 'cancelled') return { label: 'Cancelled', tone: 'bad' }
  return { label: 'Failed', tone: 'bad' }
}
