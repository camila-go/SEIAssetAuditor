#!/usr/bin/env node
/**
 * Install just what the UI build needs, from wherever the host starts us.
 *
 * Companion to build-ui.mjs and there for the same reason: this repo's Vercel
 * project has its Root Directory set inside a workspace, so `npm ci --workspace`
 * would run somewhere that has no workspaces to select. See docs/deployment.md —
 * fixing the setting makes this a no-op rather than a necessity.
 *
 * Scoped to @capella/ui on purpose. An unscoped install pulls onnxruntime-node
 * and sharp from the embedding package and Playwright from the root, to build a
 * static bundle that touches none of them: 833MB versus 259MB, measured.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

function findWorkspaceRoot(from) {
  let dir = resolve(from)
  for (;;) {
    const manifest = join(dir, 'package.json')
    if (existsSync(manifest)) {
      try {
        if (JSON.parse(readFileSync(manifest, 'utf8')).workspaces) return dir
      } catch {
        // Unreadable manifest — not the root; keep walking.
      }
    }
    const parent = dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

const root = findWorkspaceRoot(process.cwd())
if (root === null) {
  console.error(`[install-ui] No workspace root above ${process.cwd()}.`)
  process.exit(1)
}

if (root !== process.cwd()) {
  console.warn(`[install-ui] Installing in ${root}, not ${process.cwd()} — see docs/deployment.md.`)
}

execFileSync(
  'npm',
  ['ci', '--workspace=@capella/ui', '--include-workspace-root', '--no-audit', '--no-fund'],
  { cwd: root, stdio: 'inherit' },
)
