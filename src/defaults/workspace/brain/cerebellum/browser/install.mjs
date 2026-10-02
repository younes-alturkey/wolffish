// Best-effort Chromium download for the browser capability.
//
// `playwright-core install chromium` validates the host OS before downloading
// and HARD-FAILS (exit 1) on any platform/distro it doesn't recognize — e.g.
// a brand-new Ubuntu release ("Playwright does not support chromium on
// ubuntu26.04-x64"). When that ran directly as the postinstall script it took
// the entire `npm install` down with it, which left the whole browser
// capability uninstalled and broke `browser_launch`.
//
// We never want a browser-binary hiccup to disable the capability: the launch
// path (plugin/index.mjs) falls back to a system-installed Chrome / Edge /
// Chromium when Playwright's bundled build is missing. So here we ATTEMPT the
// download on every platform and ALWAYS exit 0 — success gives us the bundled
// browser (the seamless path on Windows/macOS/standard Linux), failure simply
// defers to the system browser at launch time.
//
// Pure Node + cross-platform: we invoke Playwright's own CLI via the current
// Node binary (process.execPath) so there is no shell-quoting or .bin/.cmd
// resolution to get wrong on Windows.

import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { existsSync } from 'node:fs'
import path from 'node:path'

const require = createRequire(import.meta.url)

// Honour the standard Playwright opt-out so CI / offline installs stay fast.
if (process.env.PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD) {
  process.exit(0)
}

let cli
try {
  // package.json is always resolvable even when a package restricts its
  // "exports"; cli.js sits next to it in every playwright-core release.
  const pkgPath = require.resolve('playwright-core/package.json')
  cli = path.join(path.dirname(pkgPath), 'cli.js')
} catch {
  // playwright-core itself didn't install — nothing we can do here, and the
  // launch path will report a clear error. Don't fail the install.
  process.exit(0)
}

if (!cli || !existsSync(cli)) {
  process.exit(0)
}

// If a system Chrome / Edge / Chromium is already on this machine, the launch
// path (plugin/index.mjs) drives it directly via Playwright's `channel` support
// (chrome/msedge) or an explicit executablePath — so Playwright's own bundled
// Chromium is redundant. Skip its ~150 MB download: it keeps the capability
// install fast and, crucially, never lets a slow or stalled download hang the
// task. Windows always ships Edge, so this is the normal path there; most macOS
// machines have Chrome or Edge too. Only a browser-less host (some Linux) falls
// through to the download below.
function systemChromiumExists() {
  const candidates = []
  if (process.platform === 'win32') {
    const pf = process.env['PROGRAMFILES'] || 'C:\\Program Files'
    const pf86 = process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)'
    const local = process.env['LOCALAPPDATA'] || ''
    candidates.push(
      path.join(pf, 'Google\\Chrome\\Application\\chrome.exe'),
      path.join(pf86, 'Google\\Chrome\\Application\\chrome.exe'),
      path.join(pf, 'Microsoft\\Edge\\Application\\msedge.exe'),
      path.join(pf86, 'Microsoft\\Edge\\Application\\msedge.exe')
    )
    if (local) candidates.push(path.join(local, 'Google\\Chrome\\Application\\chrome.exe'))
  } else if (process.platform === 'darwin') {
    candidates.push(
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'
    )
  } else {
    candidates.push(
      '/usr/bin/google-chrome',
      '/usr/bin/google-chrome-stable',
      '/usr/bin/chromium',
      '/usr/bin/chromium-browser',
      '/snap/bin/chromium',
      '/usr/bin/microsoft-edge'
    )
  }
  return candidates.some((c) => c && existsSync(c))
}

if (systemChromiumExists()) {
  console.log(
    '[browser] A system Chrome/Edge/Chromium is already installed — skipping the ' +
      'Playwright Chromium download; browser_launch will use it directly.'
  )
  process.exit(0)
}

// A stalled or trickling download must never hang `npm install` (and with it
// the whole task) indefinitely. Two layers guard against that:
//   1. PLAYWRIGHT_DOWNLOAD_CONNECTION_TIMEOUT — Playwright gives up on a
//      connection that can't be established (default 30s; set explicitly).
//   2. spawnSync `timeout` — a HARD backstop that kills a process wedged
//      mid-stream (TCP alive but no bytes), which (1) does not catch.
// On either timeout we exit 0 and defer to the system browser at launch.
const DOWNLOAD_TIMEOUT_MS = 240_000 // 4 min hard cap on the whole download

const result = spawnSync(process.execPath, [cli, 'install', 'chromium'], {
  stdio: 'inherit',
  timeout: DOWNLOAD_TIMEOUT_MS,
  env: {
    ...process.env,
    PLAYWRIGHT_DOWNLOAD_CONNECTION_TIMEOUT:
      process.env.PLAYWRIGHT_DOWNLOAD_CONNECTION_TIMEOUT ?? '60000'
  }
})

if (result.error?.code === 'ETIMEDOUT') {
  console.warn(
    '[browser] Chromium download exceeded its time budget and was stopped — ' +
      'browser_launch will use a system-installed Chrome / Edge / Chromium instead.'
  )
} else if (result.status !== 0) {
  console.warn(
    "[browser] Playwright couldn't download Chromium on this OS — " +
      'browser_launch will use a system-installed Chrome / Edge / Chromium instead.'
  )
}

// Always succeed so `npm install` for the capability completes.
process.exit(0)
