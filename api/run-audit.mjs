/**
 * The published site's audit service.
 *
 * A Vercel serverless function. The published site has no backend of its own —
 * crawling needs Chromium, Postgres and Redis, and nothing free hosts a
 * persistent worker — so the crawl itself runs as a GitHub Actions job. This
 * function is what lets the tool's own Audit page drive that job without the
 * person using the tool ever seeing GitHub: the page posts URLs here, then
 * polls here for progress.
 *
 *   POST  { urls?, sitemapUrl?, name? }   start an audit
 *   GET   ?since=<ISO>                    progress of the audit started then
 *   GET   ?list=1                         recent audits
 *   GET   (no params)                     is the service configured?
 *
 * The token stays here, server-side. A static bundle cannot hold one — anyone
 * who opens the page can read it. The function can start one workflow in one
 * repository and read its status; it cannot be used for anything else.
 *
 * Configuration, all server-side:
 *   GITHUB_TOKEN       fine-grained PAT, `actions: write` on this repo only
 *   GITHUB_REPOSITORY  owner/repo (falls back to Vercel's git metadata)
 */

const WORKFLOW_FILE = 'audit.yml'

/**
 * Enough for the whole site. capella.edu's sitemap lists 1,527 pages; at the
 * measured 60–90 minutes per 1,000 that is roughly two and a half hours, inside
 * the workflow's timeout and GitHub's six-hour job limit.
 */
const MAX_URLS = 2000

/** GitHub's limit on a run's inputs is 65,535 characters; leave room for the rest. */
const MAX_INPUT_CHARS = 60_000

/**
 * Sitemaps are only fetched from the site being audited. Fetching whatever URL
 * is posted would make this function an open proxy.
 */
const SITEMAP_HOST = 'www.capella.edu'

export default async function handler(request, response) {
  const repository =
    process.env.GITHUB_REPOSITORY ||
    (process.env.VERCEL_GIT_REPO_OWNER && process.env.VERCEL_GIT_REPO_SLUG
      ? `${process.env.VERCEL_GIT_REPO_OWNER}/${process.env.VERCEL_GIT_REPO_SLUG}`
      : '')
  const token = process.env.GITHUB_TOKEN

  if (!token || !repository) {
    return send(response, 501, {
      code: 'AUDIT_SERVICE_NOT_CONFIGURED',
      message:
        'Audits cannot start on this site yet. It needs a one-time access key: whoever manages ' +
        'the Vercel project adds GITHUB_TOKEN under Settings → Environment Variables and ' +
        'redeploys. Steps are in docs/deploy-runbook.md.',
    })
  }

  const github = (path, init = {}) =>
    fetch(`https://api.github.com/repos/${repository}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      },
    })

  try {
    if (request.method === 'GET') return await handleGet(request, response, github)
    if (request.method === 'POST') return await handlePost(request, response, github)

    response.setHeader('Allow', 'GET, POST')
    return send(response, 405, { code: 'METHOD_NOT_ALLOWED', message: 'GET or POST only.' })
  } catch (error) {
    console.error('[run-audit]', error)
    return send(response, 502, {
      code: 'AUDIT_SERVICE_FAILED',
      message: 'The audit service could not reach GitHub. Try again in a minute.',
    })
  }
}

// ─── Start ───────────────────────────────────────────────────────────────────

async function handlePost(request, response, github) {
  const body = typeof request.body === 'string' ? safeParse(request.body) : (request.body ?? {})

  let urls = String(body.urls ?? '')
    .split(/[\r\n]+/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'))

  // A sitemap is expanded here only to validate and count it. What is sent on
  // is the sitemap address itself: GitHub caps a run's inputs at 65,535
  // characters, and capella.edu's full sitemap is 1,527 URLs, about 90KB. The
  // audit job expands it again when it starts.
  let sitemapUrl = ''
  if (urls.length === 0 && body.sitemapUrl) {
    const expanded = await expandSitemap(String(body.sitemapUrl))
    if (expanded.error) return send(response, 400, expanded.error)
    urls = expanded.urls
    sitemapUrl = String(body.sitemapUrl).trim()
    if (urls.length === 0) {
      return send(response, 400, {
        code: 'EMPTY_SITEMAP',
        message: 'That sitemap could not be read, or lists no pages.',
      })
    }
  }

  // Validated here rather than left to the workflow: a run that starts and
  // fails four minutes later costs a round trip to learn the input was wrong.
  if (urls.length === 0) {
    return send(response, 400, { code: 'NO_URLS', message: 'Give at least one URL to audit.' })
  }
  if (urls.length > MAX_URLS) {
    return send(response, 400, {
      code: 'TOO_MANY_URLS',
      message: `${urls.length} URLs is more than one audit should take. The limit is ${MAX_URLS}.`,
    })
  }

  // The same input cap, for a pasted list. Checked here so the person gets a
  // sentence instead of an opaque refusal from GitHub.
  const urlText = urls.join('\n')
  if (!sitemapUrl && urlText.length > MAX_INPUT_CHARS) {
    return send(response, 400, {
      code: 'URL_LIST_TOO_LONG',
      message:
        `That list is too long to send in one audit (about ${urls.length} URLs). Split it in ` +
        'two, or use the Sitemap tab, which has no such limit.',
    })
  }

  // Recorded before dispatching, so the run it creates is guaranteed to be
  // newer. GitHub returns no run id from a dispatch; the page finds its run by
  // asking for the first one created after this moment.
  const startedAt = new Date(Date.now() - 5_000).toISOString()

  const dispatch = await github(`/actions/workflows/${WORKFLOW_FILE}/dispatches`, {
    method: 'POST',
    body: JSON.stringify({
      ref: 'main',
      inputs: {
        urls: sitemapUrl ? '' : urlText,
        sitemap: sitemapUrl,
        name: String(body.name ?? '').slice(0, 120),
        // Always a string over the API; a real boolean is rejected outright.
        revalidate: 'false',
      },
    }),
  })

  if (!dispatch.ok) {
    console.error('[run-audit] dispatch failed', dispatch.status, (await dispatch.text()).slice(0, 400))
    // GitHub answers 404, not 403, for a repository a token cannot see, so
    // either one almost always means the key is wrong rather than missing.
    return send(response, 502, {
      code: 'AUDIT_START_REFUSED',
      message:
        dispatch.status === 404 || dispatch.status === 403
          ? 'The audit could not start: this site’s access key has expired or lacks permission. ' +
            'Whoever manages the Vercel project needs to replace GITHUB_TOKEN.'
          : `The audit could not start (GitHub returned ${dispatch.status}). Try again in a minute.`,
    })
  }

  return send(response, 202, null, { startedAt, totalUrls: urls.length })
}

// ─── Progress ────────────────────────────────────────────────────────────────

async function handleGet(request, response, github) {
  const query = request.query ?? Object.fromEntries(new URL(request.url, 'http://x').searchParams)

  if (!query.since && !query.list) {
    return send(response, 200, null, { configured: true })
  }

  const runsResponse = await github(`/actions/workflows/${WORKFLOW_FILE}/runs?per_page=10`)
  if (!runsResponse.ok) throw new Error(`runs: HTTP ${runsResponse.status}`)
  const runs = (await runsResponse.json()).workflow_runs ?? []

  if (query.list) {
    return send(response, 200, null, runs.map(summariseRun))
  }

  // The first manually started run at or after the moment this page started
  // one. Oldest first, so two audits started close together each find their
  // own rather than both latching onto the newer.
  const since = Date.parse(String(query.since))
  const run = runs
    .filter((r) => r.event === 'workflow_dispatch' && Date.parse(r.created_at) >= since)
    .sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at))[0]

  if (!run) return send(response, 200, null, { found: false })

  const jobsResponse = await github(`/actions/runs/${run.id}/jobs`)
  const steps = jobsResponse.ok ? ((await jobsResponse.json()).jobs?.[0]?.steps ?? []) : []

  return send(response, 200, null, { found: true, ...summariseRun(run), phase: phaseFor(run, steps) })
}

function summariseRun(run) {
  return {
    id: run.id,
    title: run.display_title ?? 'Audit',
    status: run.status,
    conclusion: run.conclusion ?? null,
    startedAt: run.created_at,
    updatedAt: run.updated_at,
    scheduled: run.event === 'schedule',
  }
}

/**
 * Turn the workflow's steps into something a person following an audit wants
 * to read. Step names are an implementation detail of audit.yml; these are not.
 */
const PHASES = [
  { match: /^Run the audit$/, label: 'Scraping pages' },
  { match: /^Re-check/, label: 'Checking assets are still live' },
  { match: /^Let the fingerprint/, label: 'Fingerprinting images' },
  { match: /^(Summarise|Export|Commit)/, label: 'Saving results' },
]

function phaseFor(run, steps) {
  if (run.status === 'queued' || run.status === 'waiting' || run.status === 'pending') {
    return 'Waiting to start'
  }
  if (run.status === 'completed') {
    return run.conclusion === 'success' ? 'Finished' : `Failed${failedStep(steps)}`
  }

  const current = steps.find((step) => step.status === 'in_progress')
  const phase = current && PHASES.find((p) => p.match.test(current.name))
  return phase ? phase.label : 'Preparing the scraper'
}

function failedStep(steps) {
  const failed = steps.find((step) => step.conclusion === 'failure')
  if (!failed) return ''
  const phase = PHASES.find((p) => p.match.test(failed.name))
  return ` while ${(phase?.label ?? 'preparing the scraper').toLowerCase()}`
}

// ─── Sitemaps ────────────────────────────────────────────────────────────────

async function expandSitemap(raw) {
  let url
  try {
    url = new URL(raw.trim())
  } catch {
    return { error: { code: 'BAD_SITEMAP_URL', message: 'That sitemap address is not a URL.' } }
  }
  if (url.hostname !== SITEMAP_HOST) {
    return {
      error: {
        code: 'SITEMAP_HOST_NOT_ALLOWED',
        message: `Only sitemaps on ${SITEMAP_HOST} can be audited.`,
      },
    }
  }

  const locs = await fetchLocs(url.toString())
  // A sitemap index lists other sitemaps; follow it one level, as the API does.
  const nested = locs.filter((loc) => /\.xml(\?|$)/i.test(loc))
  if (nested.length === 0) return { urls: locs }

  const pages = []
  for (const loc of nested.slice(0, 50)) {
    if (new URL(loc).hostname !== SITEMAP_HOST) continue
    pages.push(...(await fetchLocs(loc)))
    if (pages.length > MAX_URLS) break
  }
  return { urls: [...new Set(pages)] }
}

async function fetchLocs(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(20_000) })
  if (!res.ok) return []
  const xml = await res.text()
  return [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)].map((m) => m[1].replace(/&amp;/g, '&'))
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function send(response, status, error, data = null) {
  response.setHeader('Cache-Control', 'no-store')
  response.status(status).json(error ? { error } : { data })
}

function safeParse(raw) {
  try {
    return JSON.parse(raw)
  } catch {
    return {}
  }
}
