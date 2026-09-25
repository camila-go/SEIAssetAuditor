#!/usr/bin/env node
/**
 * Write the state of the index to the Actions run page.
 *
 * Runs on every workflow run, including the scheduled link check — which does
 * no audit and so otherwise produces a completely blank run page. "Did anything
 * rot in the last three days" was only answerable by opening the raw step logs
 * and reading worker output, which nobody does, which meant the scheduled job
 * was doing real work that nobody ever saw.
 *
 * Takes the three API payloads as argv rather than fetching them, so the
 * workflow decides what to ask for and a failed curl degrades to an empty
 * object instead of failing the step.
 */
import { appendFileSync } from 'node:fs'

const summaryFile = process.env.GITHUB_STEP_SUMMARY
if (!summaryFile) {
  console.log('[ci-index-summary] Not running in Actions — nothing to write.')
  process.exit(0)
}

/** A failed request degrades to `{}`, never to a crash that fails the run. */
function parse(raw) {
  try {
    return JSON.parse(raw ?? '{}').data ?? {}
  } catch {
    return {}
  }
}

const verification = parse(process.argv[2])
const coverage = parse(process.argv[3])
const unhashable = Array.isArray(parse(process.argv[4])) ? parse(process.argv[4]) : []

const lines = ['## Index after this run', '']

if (verification.total) {
  const { total, live = 0, missing = 0, replacedByPage = 0, newestCheck } = verification

  lines.push(`**${total} assets indexed.** Every one re-checked against the live site.`, '')
  lines.push('| | |', '|---|--:|')
  lines.push(`| Still served | ${live} |`)
  if (missing > 0) lines.push(`| **No longer served** | **${missing}** |`)
  if (replacedByPage > 0) {
    lines.push(`| **Returns a web page, not the file** | **${replacedByPage}** |`)
  }
  lines.push('')

  if (missing === 0 && replacedByPage === 0) {
    lines.push('No link rot found.', '')
  } else {
    // The point of the scheduled run. Name it rather than leaving a number.
    lines.push(
      `> ${missing + replacedByPage} asset(s) the index claims are on the site are not being ` +
        'served. Open **Assets → filter by status** in the tool to see which pages reference them.',
      '',
    )
  }

  if (newestCheck) lines.push(`<sub>Last checked ${newestCheck}.</sub>`, '')
}

if (coverage.totalImages) {
  const hashable = coverage.totalImages - (coverage.unhashableImages ?? 0)
  lines.push('### Image fingerprints', '')
  lines.push(
    `${coverage.hashedImages} of ${hashable} fingerprintable images are fingerprinted` +
      (coverage.hashedImages >= hashable ? ' — complete.' : '.'),
    '',
  )

  // Stated explicitly, because "655 of 665" otherwise reads as unfinished work
  // that running the sweep again would fix. It would not.
  if (unhashable.length > 0) {
    lines.push(
      `<details><summary>${unhashable.length} image(s) can never be fingerprinted</summary>`,
      '',
      '| File | Why |',
      '|---|---|',
      ...unhashable.map((image) => `| \`${image.aemPath}\` | ${image.label} |`),
      '',
      '</details>',
      '',
    )
  }
}

if (lines.length <= 2) {
  lines.push('_The API did not respond, so the index could not be summarised._', '')
}

appendFileSync(summaryFile, lines.join('\n'))
console.log('[ci-index-summary] wrote the index summary')
