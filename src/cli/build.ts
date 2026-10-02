#!/usr/bin/env bun
/**
 * Compile the wolffish CLI into per-platform executables.
 *
 *   bun run build.ts                 host platform only → build/cli/host/
 *   bun run build.ts --all           every target       → build/cli/<target>/
 *   bun run build.ts --target darwin-arm64,darwin-x64
 *
 * Output: build/cli/<target>/wolffish-cli[.exe] plus the OpenTUI native
 * library beside it (the binary dlopens it at start). Mirrors OpenCode's
 * script: install the native package for every OS and CPU, apply the Solid
 * JSX transform as a Bun plugin, compile, smoke-test the host binary.
 */
import { $ } from 'bun'
import { createSolidTransformPlugin } from '@opentui/solid/bun-plugin'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const repo = path.resolve(here, '..', '..')
process.chdir(here)

type Target = { os: 'darwin' | 'linux' | 'win32'; arch: 'arm64' | 'x64' }
const ALL: Target[] = [
  { os: 'darwin', arch: 'arm64' },
  { os: 'darwin', arch: 'x64' },
  { os: 'linux', arch: 'x64' },
  { os: 'linux', arch: 'arm64' },
  { os: 'win32', arch: 'x64' }
]

const args = process.argv.slice(2)
const all = args.includes('--all')
const picked = args.includes('--target') ? args[args.indexOf('--target') + 1].split(',') : null
const hostOnly = !all && !picked
const version = JSON.parse(readFileSync(path.join(repo, 'package.json'), 'utf8')).version as string

const targets = hostOnly
  ? [{ os: process.platform as Target['os'], arch: process.arch as Target['arch'] }]
  : picked
    ? ALL.filter((t) => picked.includes(`${t.os}-${t.arch}`))
    : ALL

if (!hostOnly) {
  // The native OpenTUI library for every target we compile.
  const core = JSON.parse(readFileSync(path.join(here, 'package.json'), 'utf8')).dependencies[
    '@opentui/core'
  ]
  await $`bun install --os="*" --cpu="*" @opentui/core@${core}`.quiet()
}

const plugin = createSolidTransformPlugin()

for (const target of targets) {
  const name = `${target.os}-${target.arch}`
  const outDir = hostOnly
    ? path.join(repo, 'build', 'cli', 'host')
    : path.join(repo, 'build', 'cli', name)
  mkdirSync(outDir, { recursive: true })
  const outfile = path.join(outDir, target.os === 'win32' ? 'wolffish-cli.exe' : 'wolffish-cli')
  const bunTarget = `bun-${target.os === 'win32' ? 'windows' : target.os}-${target.arch}`
  console.log(`building ${name} → ${path.relative(repo, outfile)}`)
  const result = await Bun.build({
    entrypoints: ['./index.ts'],
    conditions: ['bun', 'node'],
    tsconfig: './tsconfig.json',
    plugins: [plugin],
    format: 'esm',
    minify: true,
    sourcemap: 'none',
    compile: {
      autoloadBunfig: false,
      autoloadDotenv: false,
      autoloadTsconfig: true,
      autoloadPackageJson: true,
      target: bunTarget as never,
      outfile,
      windows: {}
    } as never,
    define: {
      WOLFFISH_CLI_VERSION: JSON.stringify(version)
    }
  })
  if (!result.success) {
    for (const log of result.logs) console.error(String(log))
    process.exit(1)
  }
}

// Smoke test the host binary: it must at least start and print its version.
const hostDir = hostOnly
  ? path.join(repo, 'build', 'cli', 'host')
  : path.join(repo, 'build', 'cli', `${process.platform}-${process.arch}`)
const hostBin = path.join(
  hostDir,
  process.platform === 'win32' ? 'wolffish-cli.exe' : 'wolffish-cli'
)
if (existsSync(hostBin)) {
  const text = await $`${hostBin} --version`.text()
  console.log(`smoke test: ${text.trim()}`)
}
