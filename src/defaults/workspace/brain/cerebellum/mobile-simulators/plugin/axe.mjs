// AXe (https://github.com/cameroncooke/AXe, MIT): the iOS Simulator input
// and accessibility backend. simctl has no input injection at all, and the
// alternatives either need a daemon (idb) or a signed XCTest runner (WDA).
// AXe is one Swift binary plus the idb-derived simulator-control frameworks
// it links, so it is fetched on first use into the managed bin folder,
// version-pinned and checksum-verified, the same no-root pattern as
// cloudflared and ffmpeg. `axe_check` / `axe_install` let `requires: [axe]`
// provision it through ensureSystemTool.
//
// Resolution: WOLFFISH_AXE_PATH → managed pin → `axe` on PATH (any version,
// reported). The managed copy runs with DYLD_FRAMEWORK_PATH pointing at its
// own Frameworks directory.
import { createHash } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { access, chmod, constants, mkdir, readFile, rm, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

import { run } from './exec.mjs'
import { CODES, fail, infra, stderrOf } from './errors.mjs'

export const AXE_VERSION = '1.8.0'
export const AXE_URL = `https://github.com/cameroncooke/AXe/releases/download/v${AXE_VERSION}/AXe-macOS-v${AXE_VERSION}-universal.tar.gz`
// sha256 of the universal archive above, measured 2026-09-15.
export const AXE_SHA256 = '7b76340b72e90d0f211bc7c4636f15009076eff07acef2f2b632b175debd8834'

const MANAGED_DIR = path.join(homedir(), '.wolffish', 'bin', 'axe', AXE_VERSION)

let cached = null

async function executable(p) {
  try {
    await access(p, constants.X_OK)
    return true
  } catch {
    return false
  }
}

function whichAxe() {
  return run(process.platform === 'win32' ? 'where' : 'which', ['axe'], { timeout: 5000 }).then((r) => (r.code === 0 ? r.out.trim().split('\n')[0]?.trim() || null : null))
}

/** `{ path, source: 'env'|'managed'|'path', env }` or null. Cached until __resetAxe. */
export async function resolveAxe({ fresh = false } = {}) {
  if (cached && !fresh) return cached
  if (process.platform !== 'darwin') return null
  const envPath = process.env.WOLFFISH_AXE_PATH
  if (envPath && (await executable(envPath))) {
    cached = { path: envPath, source: 'env', env: { DYLD_FRAMEWORK_PATH: path.join(path.dirname(envPath), 'Frameworks') } }
    return cached
  }
  const managed = path.join(MANAGED_DIR, 'axe')
  if (await executable(managed)) {
    cached = { path: managed, source: 'managed', env: { DYLD_FRAMEWORK_PATH: path.join(MANAGED_DIR, 'Frameworks') } }
    return cached
  }
  const onPath = await whichAxe()
  if (onPath) {
    cached = { path: onPath, source: 'path', env: {} }
    return cached
  }
  return null
}

export function __resetAxe() {
  cached = null
}

export async function axeVersion(bin) {
  const r = await run(bin.path, ['--version'], { timeout: 10_000, env: bin.env })
  return r.code === 0 ? r.out.trim().split('\n')[0] : null
}

async function sha256File(p) {
  const h = createHash('sha256')
  h.update(await readFile(p))
  return h.digest('hex')
}

/** Download, verify, extract and smoke-test the pinned AXe. */
export async function installAxe({ signal } = {}) {
  if (process.platform !== 'darwin') return fail(CODES.UNSUPPORTED, 'AXe drives the iOS Simulator and exists only on macOS')
  await mkdir(MANAGED_DIR, { recursive: true })
  const archive = path.join(MANAGED_DIR, 'axe.tar.gz.part')
  try {
    const res = await fetch(AXE_URL, { redirect: 'follow', signal })
    if (!res.ok || !res.body) return infra(`AXe download failed: HTTP ${res.status} for ${AXE_URL}`)
    await pipeline(Readable.fromWeb(res.body), createWriteStream(archive))
  } catch (e) {
    await rm(archive, { force: true }).catch(() => {})
    return infra(`AXe download failed: ${e?.message ?? e}`)
  }
  const sum = await sha256File(archive)
  if (sum !== AXE_SHA256) {
    await rm(archive, { force: true }).catch(() => {})
    return infra(`AXe archive checksum mismatch (got ${sum.slice(0, 12)}…, expected ${AXE_SHA256.slice(0, 12)}…) — refusing to install`, { retryable: false })
  }
  const ex = await run('tar', ['-xzf', archive, '-C', MANAGED_DIR], { timeout: 120_000 })
  await rm(archive, { force: true }).catch(() => {})
  if (ex.code !== 0) return infra(`AXe extract failed: ${stderrOf(ex)}`)
  const bin = path.join(MANAGED_DIR, 'axe')
  await chmod(bin, 0o755).catch(() => {})
  // Downloaded files carry the quarantine attribute; the archive is signed
  // by its author and verified by checksum above, so clear it for the
  // binary and its frameworks, else Gatekeeper refuses to load them.
  await run('xattr', ['-dr', 'com.apple.quarantine', MANAGED_DIR], { timeout: 30_000 })
  cached = null
  const resolved = await resolveAxe({ fresh: true })
  if (!resolved || resolved.source !== 'managed') return infra('AXe was extracted but the binary is not executable', { retryable: false })
  const v = await axeVersion(resolved)
  if (v !== AXE_VERSION) return infra(`installed AXe reports version ${v ?? 'unknown'}, expected ${AXE_VERSION}`, { retryable: false })
  return { success: true, output: `AXe ${AXE_VERSION} installed at ${bin} (no root; ${Math.round(((await stat(bin)).size ?? 0) / 1024)} KB binary + frameworks).` }
}

/** Tool: axe_check → JSON `{ installed, version, path, source }`. */
export async function axeCheck() {
  const bin = await resolveAxe({ fresh: true })
  if (!bin) return { success: true, output: JSON.stringify({ installed: false, version: '', pinned: AXE_VERSION }) }
  const v = await axeVersion(bin)
  return { success: true, output: JSON.stringify({ installed: !!v, version: v ?? 'unknown', path: bin.path, source: bin.source, pinned: AXE_VERSION }) }
}

/** Tool: axe_install → managed install (idempotent). */
export async function axeInstall(args, signal) {
  const have = await resolveAxe({ fresh: true })
  if (have && have.source !== 'path') {
    const v = await axeVersion(have)
    if (v === AXE_VERSION) return { success: true, output: `AXe ${v} already installed (${have.source}) at ${have.path}.` }
  }
  return installAxe({ signal })
}

/**
 * Run an AXe command against a simulator. Returns the raw run result plus
 * `unavailable` when there is no AXe at all (callers turn that into the
 * typed AXE_UNAVAILABLE error and, where they can, fall back).
 */
export async function axe(args, { udid, timeout = 30_000, signal, input } = {}) {
  const bin = await resolveAxe()
  if (!bin) return { code: -1, out: '', err: 'axe not installed', unavailable: true }
  const full = udid ? [...args, '--udid', udid] : args
  return run(bin.path, full, { timeout, env: bin.env, signal, input })
}

export function axeUnavailableError() {
  return fail(CODES.AXE_UNAVAILABLE, 'the iOS input backend (AXe) is not installed', 'call axe_install once (managed, no root); until then use computer-use on the Simulator window as the fallback')
}

export function managedDir() {
  return MANAGED_DIR
}


