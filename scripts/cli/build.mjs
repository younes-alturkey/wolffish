#!/usr/bin/env node
/**
 * Build the `wolffish` terminal client and lay its binaries out for packaging.
 *
 *   node scripts/cli/build.mjs --host                 build/cli/host/wolffish-cli  (dev)
 *   node scripts/cli/build.mjs --platform darwin      build/cli/dist/wolffish-cli-darwin-{arm64,x64}
 *   node scripts/cli/build.mjs --platform win32       build/cli/dist/wolffish-cli-win32-x64.exe
 *   node scripts/cli/build.mjs --platform linux       build/cli/dist/wolffish-cli-linux-x64
 *
 * electron-builder's beforePack hook calls this with the platform being
 * packed; extraResources then ships build/cli/dist as resources/cli. The
 * compile itself is src/cli/build.ts under Bun (a devDependency), which is
 * why no CI step has to install anything extra.
 */
import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs'
import path from 'node:path'

import { bunBinary, repoRoot as repo, resolveBun } from './bun.mjs'

const bun = resolveBun()
const cliDir = path.join(repo, 'src', 'cli')

const TARGETS = {
  darwin: ['darwin-arm64', 'darwin-x64'],
  win32: ['win32-x64'],
  linux: ['linux-x64']
}

const args = process.argv.slice(2)
const host = args.includes('--host')
const platform = args.includes('--platform') ? args[args.indexOf('--platform') + 1] : null

if (!bun) {
  console.error(`bun not usable at ${bunBinary} — run npm install (bun is a devDependency)`)
  process.exit(1)
}

function run(cmd, cmdArgs, cwd) {
  execFileSync(cmd, cmdArgs, { cwd, stdio: 'inherit' })
}

// The CLI's own dependencies (OpenTUI, Solid) live under src/cli.
if (!existsSync(path.join(cliDir, 'node_modules', '@opentui'))) {
  run(bun, ['install', '--frozen-lockfile'], cliDir)
}

if (host || !platform) {
  run(bun, ['run', 'build.ts'], cliDir)
  process.exit(0)
}

const targets = TARGETS[platform]
if (!targets) {
  console.error(`unknown platform ${platform}`)
  process.exit(2)
}
run(bun, ['run', 'build.ts', '--target', targets.join(',')], cliDir)

const dist = path.join(repo, 'build', 'cli', 'dist')
rmSync(dist, { recursive: true, force: true })
mkdirSync(dist, { recursive: true })
for (const target of targets) {
  const from = path.join(repo, 'build', 'cli', target)
  const exe = target.startsWith('win32') ? '.exe' : ''
  for (const file of readdirSync(from)) {
    const named = file.startsWith('wolffish-cli') ? `wolffish-cli-${target}${exe}` : file
    copyFileSync(path.join(from, file), path.join(dist, named))
  }
}
console.log(`cli binaries staged in ${path.relative(repo, dist)}: ${readdirSync(dist).join(', ')}`)
