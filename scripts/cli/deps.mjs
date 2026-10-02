#!/usr/bin/env node
/**
 * postinstall: install the terminal client's own dependencies under src/cli
 * with Bun (a devDependency of the root), so `npm ci` alone leaves the CLI
 * buildable — on a laptop and on every CI runner.
 *
 * Best-effort: a machine that only wants to run the desktop app can live
 * without it, and a failure here must not fail `npm install`.
 */
import { execFileSync } from 'node:child_process'
import path from 'node:path'

import { repoRoot, resolveBun } from './bun.mjs'

const bun = resolveBun()
const cliDir = path.join(repoRoot, 'src', 'cli')

if (!bun) {
  console.log('[cli] bun not installed yet — skipping CLI dependencies')
  process.exit(0)
}
try {
  execFileSync(bun, ['install', '--frozen-lockfile'], { cwd: cliDir, stdio: 'inherit' })
} catch (error) {
  console.log(`[cli] dependency install failed (${error?.message ?? error}); run it later with: node scripts/cli/deps.mjs`)
}
