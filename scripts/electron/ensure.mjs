// Self-heals an incomplete Electron install after `npm install`.
//
// Electron downloads its prebuilt binary in its own postinstall (install.js),
// which unzips the release with `extract-zip`. On some Linux setups that step
// silently extracts only part of the archive (e.g. just `locales/`), leaving
// the ~200 MB `electron` binary and `path.txt` missing. electron-vite then
// fails to launch with `Error: Electron uninstall`.
//
// This runs from the project's own postinstall (after Electron's) and repairs
// the install in escalating steps:
//   1. re-run Electron's installer (re-extracts from the cached zip — fast)
//   2. force a clean re-download (handles a corrupt/partial cached zip)
//   3. extract the cached zip with the system `unzip`/`python3` — the only
//      thing that reliably worked when extract-zip kept truncating the output
//
// It is a no-op when the binary is already present, so it's cheap on every
// install and on platforms that never hit the bug.

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'

const require = createRequire(import.meta.url)
const electronDir = path.dirname(require.resolve('electron/package.json'))
const { version } = require('electron/package.json')

// Mirrors getPlatformPath() in electron/install.js — the value written to path.txt.
const platformBin =
  process.platform === 'win32'
    ? 'electron.exe'
    : process.platform === 'darwin'
      ? 'Electron.app/Contents/MacOS/Electron'
      : 'electron'

const distDir = path.join(electronDir, 'dist')
const binPath = path.join(distDir, platformBin)
const pathTxt = path.join(electronDir, 'path.txt')

const isInstalled = () => fs.existsSync(binPath) && fs.existsSync(pathTxt)

if (isInstalled()) {
  process.exit(0)
}

console.warn(`[ensure-electron] Electron ${version} binary missing/incomplete — repairing…`)

runInstaller({}) // 1. re-extract from cache
if (!isInstalled()) runInstaller({ force_no_cache: 'true' }) // 2. forced re-download
if (!isInstalled()) repairFromCachedZip() // 3. manual unzip fallback

if (!isInstalled()) {
  console.error('[ensure-electron] Could not install Electron automatically.')
  console.error('  Fix manually with: rm -rf node_modules/electron && npm install')
  process.exit(1)
}

console.log('[ensure-electron] Electron binary ready.')

function runInstaller(extraEnv) {
  try {
    execFileSync(process.execPath, [path.join(electronDir, 'install.js')], {
      cwd: electronDir,
      stdio: 'inherit',
      env: { ...process.env, ...extraEnv }
    })
  } catch (err) {
    console.warn(`[ensure-electron] installer step failed: ${err.message}`)
  }
}

// Locate the release zip @electron/get cached, then extract it ourselves.
function repairFromCachedZip() {
  const zipName = `electron-v${version}-${process.platform}-${process.arch}.zip`
  const zip = findInCache(zipName)
  if (!zip) {
    console.warn('[ensure-electron] cached release zip not found; cannot run unzip fallback.')
    return
  }

  console.warn(`[ensure-electron] extracting ${zipName} directly…`)
  fs.rmSync(distDir, { recursive: true, force: true })
  fs.mkdirSync(distDir, { recursive: true })

  if (!extract(zip, distDir)) return

  // Mirror the tail of electron/install.js: hoist the type defs, write path.txt.
  const dts = path.join(distDir, 'electron.d.ts')
  if (fs.existsSync(dts)) fs.renameSync(dts, path.join(electronDir, 'electron.d.ts'))
  fs.writeFileSync(pathTxt, platformBin)
}

// Try `unzip`, then `python3`'s zipfile module — one is present on virtually
// every machine that hits this (the bug is Linux-only in practice).
function extract(zip, dest) {
  const tools = [
    { cmd: 'unzip', args: ['-q', '-o', zip, '-d', dest] },
    { cmd: 'python3', args: ['-m', 'zipfile', '-e', zip, dest] }
  ]
  for (const { cmd, args } of tools) {
    try {
      execFileSync(cmd, args, { stdio: 'inherit' })
      return true
    } catch {
      // tool missing or failed — try the next one
    }
  }
  console.warn(
    '[ensure-electron] neither `unzip` nor `python3` is available to extract the archive.'
  )
  return false
}

function findInCache(name) {
  const root = process.env.electron_config_cache || process.env.ELECTRON_CACHE || defaultCacheRoot()
  try {
    return walk(root, name)
  } catch {
    return null
  }
}

function defaultCacheRoot() {
  if (process.platform === 'win32') {
    return path.join(process.env.LOCALAPPDATA || os.homedir(), 'electron', 'Cache')
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Caches', 'electron')
  }
  return path.join(os.homedir(), '.cache', 'electron')
}

function walk(dir, name) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      const hit = walk(full, name)
      if (hit) return hit
    } else if (entry.name === name) {
      return full
    }
  }
  return null
}
