#!/usr/bin/env node
/**
 * Drive one audit to completion, for CI.
 *
 * The static snapshot can show findings but cannot produce them — crawling
 * needs a browser, a queue and a database. Rather than paying for a server to
 * sit idle between audits, this runs the real stack inside a GitHub Actions
 * job: services for Postgres and Redis, Chromium on the runner, and the
 * resulting index committed back to the repo. Public repos get unlimited
 * Actions minutes, so the whole thing costs nothing.
 *
 * Deliberately talks to the running API over HTTP rather than importing the
 * services directly. That means CI exercises the same path a person does —
 * including the URL parsing that has twice turned non-URLs into audits — rather
 * than a shortcut that only CI uses.
 */

const API = process.env.API_URL ?? 'http://127.0.0.1:3001'
const POLL_MS = 5_000
/** A 1000-URL audit is 60–90 minutes; this is the ceiling before we give up. */
const TIMEOUT_MS = Number(process.env.AUDIT_TIMEOUT_MS ?? 100 * 60 * 1000)

const urls = (process.env.AUDIT_URLS ?? '').trim()
if (!urls) {
  console.error('[ci-audit] AUDIT_URLS is empty. Nothing to audit.')
  process.exit(1)
}

const name = process.env.AUDIT_NAME?.trim() || `CI audit — ${new Date().toISOString().slice(0, 10)}`

async function json(path, init) {
  const response = await fetch(`${API}${path}`, init)
  const text = await response.text()

  let body
  try {
    body = JSON.parse(text)
  } catch {
    throw new Error(`${path} returned non-JSON (HTTP ${response.status}): ${text.slice(0, 200)}`)
  }

  if (body.error) throw new Error(`${path}: ${body.error.code} — ${body.error.message}`)
  return body
}

// Wait for the API to come up; the workflow starts it moments before this runs.
process.stdout.write('[ci-audit] waiting for the API')
for (let i = 0; i < 60; i += 1) {
  try {
    await fetch(`${API}/health`)
    break
  } catch {
    process.stdout.write('.')
    await new Promise((resolve) => setTimeout(resolve, 1000))
  }
}
console.log('')

const created = await json('/api/v1/audit', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ name, urls }),
})

const { jobId, totalUrls, skipped = [] } = created.data
console.log(`[ci-audit] job ${jobId} — ${totalUrls} URL(s) queued`)

// Report rejected input rather than letting it vanish, exactly as the UI does.
if (skipped.length > 0) {
  console.log(`[ci-audit] ${skipped.length} line(s) were not web addresses and were skipped:`)
  for (const line of skipped.slice(0, 10)) console.log(`             ${line}`)
}

const startedAt = Date.now()
let status

for (;;) {
  if (Date.now() - startedAt > TIMEOUT_MS) {
    console.error(`[ci-audit] gave up after ${Math.round(TIMEOUT_MS / 60000)} minutes.`)
    process.exit(1)
  }

  await new Promise((resolve) => setTimeout(resolve, POLL_MS))
  status = (await json(`/api/v1/audit/${jobId}/status`)).data

  const processed = status.completedUrls + status.failedUrls
  console.log(
    `[ci-audit] ${status.status.padEnd(9)} ${processed}/${status.totalUrls}` +
      (status.failedUrls > 0 ? ` (${status.failedUrls} failed)` : ''),
  )

  if (status.status === 'complete' || status.status === 'failed') break
}

if (status.status === 'failed') {
  console.error(`[ci-audit] the audit failed outright: ${status.errorMessage ?? 'no reason recorded'}`)
  process.exit(1)
}

// Per-URL failures are expected at scale — one bad URL never stops a job — so
// they are reported but do not fail the workflow. A job that failed entirely,
// above, does.
if (status.failedUrls > 0) {
  const failures = (await json(`/api/v1/audit/${jobId}/failures`)).data
  console.log(`\n[ci-audit] ${status.failedUrls} URL(s) could not be scraped:`)
  for (const failure of failures.slice(0, 20)) {
    console.log(`             ${failure.url}\n               ${String(failure.error).slice(0, 160)}`)
  }
}

console.log(`\n[ci-audit] done — ${status.completedUrls} scraped, ${status.failedUrls} failed`)

/**
 * Write a summary to the Actions run page.
 *
 * Without this the only record of what an audit found is buried in a step's
 * stdout, which nobody scrolls to. The run page is where someone looks to
 * answer "did it work and what did it find", so it should answer that.
 */
const summaryFile = process.env.GITHUB_STEP_SUMMARY
if (summaryFile) {
  const { writeFileSync } = await import('node:fs')
  const results = (await json(`/api/v1/audit/${jobId}/results?limit=200`)).data

  const rows = results
    .map(
      (r) =>
        `| ${r.url.replace('https://www.capella.edu', '')} | ${r.assetCount ?? 0} | ` +
        `${r.testimonialCount ?? 0} | ${r.liveStatus} |`,
    )
    .join('\n')

  const failureRows =
    status.failedUrls > 0
      ? '\n\n### Could not be scraped\n\n' +
        (await json(`/api/v1/audit/${jobId}/failures`)).data
          .map((f) => `- \`${f.url}\`\n  ${String(f.error).slice(0, 200)}`)
          .join('\n')
      : ''

  writeFileSync(
    summaryFile,
    `## ${name}\n\n` +
      `**${status.completedUrls} scraped · ${status.failedUrls} failed**` +
      (skipped.length > 0 ? ` · ${skipped.length} skipped (not web addresses)` : '') +
      `\n\n| Page | Assets | Testimonials | Status |\n|---|--:|--:|---|\n${rows}\n` +
      failureRows +
      `\n\n<sub>The refreshed index is committed to this repository; the published ` +
      `snapshot rebuilds from it.</sub>\n`,
    { flag: 'a' },
  )
  console.log('[ci-audit] wrote the run summary')
}
