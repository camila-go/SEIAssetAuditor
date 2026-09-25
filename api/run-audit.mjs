/**
 * Start the audit workflow, on behalf of the published UI.
 *
 * A Vercel serverless function. It exists for exactly one reason: dispatching a
 * workflow needs a token with `actions: write`, and a static bundle cannot hold
 * one. Anything in the bundle is readable by anyone who opens the page, and
 * that token can run workflows in the repository. So the token stays here, in
 * an environment variable the browser never sees, and the browser posts URLs to
 * this function instead.
 *
 * Deliberately narrow. It takes a list of URLs and a name, and can start one
 * specific workflow in one specific repository. It cannot be used to run
 * anything else, whatever is posted to it.
 *
 * Configuration, all server-side:
 *   GITHUB_TOKEN       fine-grained PAT, `actions: write` on this repo only
 *   GITHUB_REPOSITORY  owner/repo
 *
 * Without those it returns 501 with an explanation rather than failing
 * obscurely — the UI shows that text, so a missing token reads as a setup step
 * rather than a bug.
 */

const WORKFLOW_FILE = 'audit.yml'

/** One run is 20–90 minutes of someone else's compute; this is not a free-for-all. */
const MAX_URLS = 500

export default async function handler(request, response) {
  if (request.method !== 'POST') {
    response.setHeader('Allow', 'POST')
    return send(response, 405, { code: 'METHOD_NOT_ALLOWED', message: 'POST only.' })
  }

  const token = process.env.GITHUB_TOKEN
  const repository = process.env.GITHUB_REPOSITORY

  if (!token || !repository) {
    return send(response, 501, {
      code: 'GITHUB_DISPATCH_NOT_CONFIGURED',
      message:
        'This deployment has no GitHub token, so it cannot start a run. Add GITHUB_TOKEN and ' +
        'GITHUB_REPOSITORY to the hosting environment — see docs/deploy-runbook.md. You can ' +
        'still start one from the Actions tab.',
    })
  }

  const body = typeof request.body === 'string' ? safeParse(request.body) : (request.body ?? {})

  // Validate here rather than letting the workflow discover it. A run that
  // starts and fails 4 minutes later costs the person a round trip to find out
  // they pasted the wrong thing.
  const urls = String(body.urls ?? '')
    .split(/[\r\n]+/)
    .map((line) => line.trim())
    .filter(Boolean)

  if (urls.length === 0) {
    return send(response, 400, {
      code: 'NO_URLS',
      message: 'Give at least one URL to audit.',
    })
  }

  if (urls.length > MAX_URLS) {
    return send(response, 400, {
      code: 'TOO_MANY_URLS',
      message: `${urls.length} URLs is more than one run should take. The limit is ${MAX_URLS}.`,
    })
  }

  const dispatch = await fetch(
    `https://api.github.com/repos/${repository}/actions/workflows/${WORKFLOW_FILE}/dispatches`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        ref: 'main',
        inputs: {
          urls: urls.join('\n'),
          name: String(body.name ?? '').slice(0, 120),
          // A string, not a boolean: workflow_dispatch inputs are always
          // strings over the API, and a real boolean is rejected outright.
          revalidate: body.revalidate ? 'true' : 'false',
        },
      }),
    },
  )

  if (!dispatch.ok) {
    const detail = await dispatch.text()

    // 403 and 404 both mean the token cannot see or write this repository —
    // GitHub returns 404 rather than 403 for a repo a token cannot read, so
    // "not found" almost always means "wrong scope", and saying so saves a long
    // hunt for a repository that is plainly there.
    const message =
      dispatch.status === 404 || dispatch.status === 403
        ? 'GitHub refused the request. The token is most likely missing `actions: write` on ' +
          'this repository, or has expired.'
        : `GitHub returned ${dispatch.status} when starting the run.`

    console.error('[run-audit] dispatch failed', dispatch.status, detail.slice(0, 400))
    return send(response, 502, { code: 'DISPATCH_FAILED', message })
  }

  // 204 with no body, and no run id — GitHub does not return one here. The UI
  // finds the new run by polling the run list, which it is doing anyway.
  return send(response, 202, null, { queued: true, urls: urls.length })
}

function send(response, status, error, data = null) {
  response.status(status).json(error ? { error } : { data })
}

function safeParse(raw) {
  try {
    return JSON.parse(raw)
  } catch {
    return {}
  }
}
