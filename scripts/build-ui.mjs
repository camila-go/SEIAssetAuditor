#!/usr/bin/env node
/**
 * Build the UI from wherever a host happens to start us.
 *
 * This exists because of a Vercel project setting, not because the build is
 * complicated. The Root Directory is set to `apps/api`, so Vercel runs npm with
 * that as the working directory — which is why the build failed twice with two
 * unrelated-looking errors (`tsc: command not found`, then
 * `Missing script: "build:ui"`). Both meant the same thing: npm never installed
 * the workspace root, where `typescript` and the `build:ui` script live.
 *
 * The correct fix is one dropdown — set Root Directory to the repository root —
 * and it is documented in docs/deployment.md. This script is the safety net for
 * as long as that setting is wrong, because a deploy that depends on a setting
 * nobody can see from the repo is a deploy that breaks again.
 *
 * It walks up to the real workspace root, builds there, and then mirrors the
 * output to wherever the caller is standing so that `outputDirectory` resolves
 * either way.
 */
import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, readFileSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

const OUTPUT = join('apps', 'ui', 'dist')

/** The directory whose package.json declares the workspaces. */
function findWorkspaceRoot(from) {
  let dir = resolve(from)

  for (;;) {
    const manifest = join(dir, 'package.json')
    if (existsSync(manifest)) {
      try {
        if (JSON.parse(readFileSync(manifest, 'utf8')).workspaces) return dir
      } catch {
        // An unreadable package.json is not the root we want; keep walking.
      }
    }

    const parent = dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

const startedIn = process.cwd()
const root = findWorkspaceRoot(startedIn)

if (root === null) {
  console.error(
    `[build-ui] No workspace root above ${startedIn}. Expected a package.json with a "workspaces" field.`,
  )
  process.exit(1)
}

if (root !== startedIn) {
  console.warn(
    `[build-ui] Started in ${startedIn}, which is not the workspace root.\n` +
      `[build-ui] This host's Root Directory is misconfigured — see docs/deployment.md.\n` +
      `[build-ui] Building in ${root} and mirroring the output back.`,
  )
}

execFileSync('npm', ['run', 'build:ui:workspace'], { cwd: root, stdio: 'inherit' })

const built = join(root, OUTPUT)
if (!existsSync(built)) {
  console.error(`[build-ui] Build reported success but ${built} does not exist.`)
  process.exit(1)
}

// Mirror only when we were started somewhere else, so the normal case writes
// nothing extra and leaves no stray directories in the repo.
if (root !== startedIn) {
  const mirror = join(startedIn, OUTPUT)
  rmSync(mirror, { recursive: true, force: true })
  cpSync(built, mirror, { recursive: true })
  console.warn(`[build-ui] Mirrored to ${mirror} so outputDirectory resolves from here too.`)
}
