import { is } from '@electron-toolkit/utils'
import { wlog } from '@main/workspace/logger'
import { patchConfig, readConfig } from '@main/workspace/workspace'
import { app, BrowserWindow, shell } from 'electron'
import { handle } from '@main/ipc-registry'
import { autoUpdater, type UpdateDownloadedEvent, type UpdateInfo } from 'electron-updater'
import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, readdir, rename, rm, stat } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'

const RELEASES = { owner: 'younes-alturkey', repo: 'wolffish' } as const
const tag = '[updater]'

// Builds are ad-hoc signed, and Squirrel.Mac refuses to install an update into
// an app without a Developer ID signature. On macOS the updater therefore
// fetches the release's .dmg itself into ~/.wolffish/updates, verifies the
// sha512 from latest-mac.yml, and "installing" means opening that image and
// quitting so the user can drag the new app over the old one. Windows (NSIS)
// and Linux (AppImage) install unsigned updates on their own.
const MANUAL_INSTALL = process.platform === 'darwin'
const UPDATES_DIR = path.join(os.homedir(), '.wolffish', 'updates')

export type UpdateAvailableEvent = {
  version: string
  releaseNotes: string | null
}

export type UpdateDownloadProgressEvent = {
  percent: number
}

export type UpdateReadyEvent = {
  version: string
  releaseNotes: string | null
  /** Where the installer was saved when the user has to run it (macOS); null when the app installs itself. */
  installerPath: string | null
}

export type UpdaterPhase =
  | 'idle'
  | 'checking'
  | 'downloading'
  | 'verifying'
  | 'ready'
  | 'installing'
  | 'error'

// Coarse failure category so the renderer can show a friendly, translatable
// reason instead of electron-updater's raw exception text.
export type UpdaterErrorCode =
  | 'checksum'
  | 'network'
  | 'timeout'
  | 'filesystem'
  | 'install'
  | 'unknown'

export type UpdaterErrorInfo = {
  code: UpdaterErrorCode
  /** Short English summary; the renderer translates by `code` and falls back to this. */
  message: string
  /** Sanitized technical detail (long digests shortened) for diagnostics, or null. */
  detail: string | null
}

export type UpdaterState = {
  phase: UpdaterPhase
  version: string | null
  percent: number
  releaseNotes: string | null
  error: UpdaterErrorInfo | null
  installerPath: string | null
}

// A sha512 mismatch error embeds two 88-char base64 digests; left raw they blow
// out the toast/alert width. Collapse any long base64/hex run to a short prefix
// so the detail stays readable.
function shortenDigests(text: string): string {
  return text.replace(/[A-Za-z0-9+/]{20,}={0,2}/g, (m) => `${m.slice(0, 10)}…`)
}

// Map electron-updater's raw error into a friendly category + sanitized detail.
// `fallback` is the bucket for anything unrecognised: 'unknown' ("failed to
// download") while fetching, 'install' once the artifact is verified and the
// failure can only be the install itself.
function classifyUpdaterError(
  err: unknown,
  fallback: UpdaterErrorCode = 'unknown'
): UpdaterErrorInfo {
  const raw = (err instanceof Error ? err.message : String(err)).trim()
  const detail = raw ? shortenDigests(raw) : null
  const lower = raw.toLowerCase()
  if (lower.includes('checksum') || lower.includes('sha512') || lower.includes('sha256')) {
    return {
      code: 'checksum',
      message: 'The downloaded update was corrupted and could not be verified.',
      detail
    }
  }
  if (
    lower.includes('timed out') ||
    lower.includes('etimedout') ||
    lower.includes('esockettimedout')
  ) {
    return { code: 'timeout', message: 'The update timed out before it finished.', detail }
  }
  if (
    /enotfound|econnrefused|econnreset|eai_again|getaddrinfo|enetunreach|net::|network|socket hang up/.test(
      lower
    )
  ) {
    return { code: 'network', message: 'Could not reach the update server.', detail }
  }
  if (/ebusy|eperm|eacces|enospc|locked|being used by another/.test(lower)) {
    return { code: 'filesystem', message: 'Could not save the update to disk.', detail }
  }
  if (fallback === 'install') {
    return { code: 'install', message: 'The update could not be installed.', detail }
  }
  return { code: 'unknown', message: 'The update failed to download.', detail }
}

function extractReleaseNotes(info: UpdateInfo): string | null {
  if (!info.releaseNotes) return null
  if (typeof info.releaseNotes === 'string') return info.releaseNotes
  if (Array.isArray(info.releaseNotes)) {
    return info.releaseNotes.map((n) => (typeof n === 'string' ? n : (n.note ?? ''))).join('\n')
  }
  return null
}

function broadcast<T>(channel: string, payload: T): void {
  for (const w of BrowserWindow.getAllWindows()) {
    w.webContents.send(channel, payload)
  }
}

let lastReady: UpdateReadyEvent | null = null

// Set by the 'error' handler while in 'installing'. Read by installUpdate()
// right after quitAndInstall() returns (NSIS/AppImage report a failed spawn
// synchronously through that event) and by the install handler's exit timer
// (Squirrel.Mac reports asynchronously).
let installFailure: UpdaterErrorInfo | null = null

// Main is the single source of truth for update progress. The renderer panels
// (UpdatesPanel, UpdateCard) are fully unmounted on page navigation, so they
// cannot hold the live state — they pull it via updater:getState on mount and
// subscribe to updater:state for changes. Every mutation goes through setState.
let state: UpdaterState = {
  phase: 'idle',
  version: null,
  percent: 0,
  releaseNotes: null,
  error: null,
  installerPath: null
}

/**
 * Listeners beyond the window broadcast — the Mobile channel mirrors this
 * state to the phone's Updates screen through one. Same contract as the
 * broadcast beside it: the whole state on every mutation.
 */
const stateListeners = new Set<(state: UpdaterState) => void>()

export function onUpdaterState(listener: (state: UpdaterState) => void): () => void {
  stateListeners.add(listener)
  return () => {
    stateListeners.delete(listener)
  }
}

/** The live state, for a caller that is not a renderer (the phone's seed). */
export function getUpdaterState(): UpdaterState {
  return state
}

function setState(patch: Partial<UpdaterState>): void {
  state = { ...state, ...patch }
  broadcast<UpdaterState>('updater:state', state)
  for (const listener of stateListeners) listener(state)
}

// Drive the renderer into the error phase. The structured error rides along in
// `updater:state`, so the panel renders its alert straight from state — no
// separate error channel to keep in sync.
function failWith(error: UpdaterErrorInfo): void {
  lastReady = null
  setState({ phase: 'error', error, installerPath: null })
}

function reportProgress(pct: number, transferred: number, total: number): void {
  wlog.info(tag, `download ${pct}%  (${transferred}/${total})`)
  if (pct >= 100 && !verifyWatchdog) {
    verifyWatchdog = setTimeout(() => {
      // The timer has fired — release the handle so a later 100% tick (e.g.
      // after a Retry) can re-arm. Without this, the guard above stays false
      // forever and a second silent post-100% hang would never recover.
      verifyWatchdog = null
      if (state.phase === 'verifying') {
        wlog.warn(tag, 'verification timed out')
        failWith({
          code: 'timeout',
          message: 'The update timed out while being verified.',
          detail: null
        })
      }
    }, VERIFY_TIMEOUT_MS)
  }
  // Monotonic: a late or duplicate low tick must never rewind the bar.
  setState({
    phase: pct >= 100 ? 'verifying' : 'downloading',
    percent: Math.max(state.percent, pct)
  })
  broadcast<UpdateDownloadProgressEvent>('updater:progress', { percent: pct })
}

function markReady(
  version: string,
  releaseNotes: string | null,
  installerPath: string | null
): void {
  clearVerifyWatchdog()
  const event: UpdateReadyEvent = { version, releaseNotes, installerPath }
  lastReady = event
  setState({ phase: 'ready', version, percent: 100, releaseNotes, error: null, installerPath })
  broadcast<UpdateReadyEvent>('updater:ready', event)
}

async function sha512Of(file: string): Promise<string> {
  const hash = createHash('sha512')
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer)
  return hash.digest('base64')
}

/**
 * macOS: fetch the release's disk image into UPDATES_DIR, streaming the sha512
 * as it lands, and resolve with its path. A copy from an earlier launch that
 * still matches the manifest is reused rather than fetched again; anything
 * else in the folder (older versions, broken partials) is dropped first.
 */
async function downloadInstaller(info: UpdateInfo): Promise<string> {
  const file = info.files.find((f) => f.url.endsWith('.dmg')) ?? info.files[0]
  if (!file) throw new Error('the release manifest lists no installer')
  const name = path.basename(file.url)
  const dest = path.join(UPDATES_DIR, name)
  await mkdir(UPDATES_DIR, { recursive: true })
  for (const entry of await readdir(UPDATES_DIR)) {
    if (entry !== name) await rm(path.join(UPDATES_DIR, entry), { recursive: true, force: true })
  }
  const existing = await stat(dest).catch(() => null)
  if (existing?.isFile()) {
    setState({ phase: 'verifying', percent: 100 })
    if ((await sha512Of(dest)) === file.sha512) return dest
    await rm(dest, { force: true })
  }
  // The provider records the tag it resolved; fall back to our own scheme.
  const tag = (info as { tag?: string }).tag ?? `v${info.version}`
  const url = `https://github.com/${RELEASES.owner}/${RELEASES.repo}/releases/download/${tag}/${name}`
  wlog.info(tag, `fetching ${url}`)
  const res = await fetch(url)
  if (!res.ok || !res.body) throw new Error(`network: HTTP ${res.status} for ${url}`)
  const total = file.size ?? Number(res.headers.get('content-length') ?? 0)
  const hash = createHash('sha512')
  let received = 0
  let lastPct = -1
  const meter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      hash.update(chunk)
      received += chunk.length
      const pct = total > 0 ? Math.min(100, Math.floor((received / total) * 100)) : 0
      if (pct !== lastPct) {
        lastPct = pct
        reportProgress(pct, received, total)
      }
      callback(null, chunk)
    }
  })
  const part = `${dest}.part`
  await pipeline(Readable.fromWeb(res.body as never), meter, createWriteStream(part))
  if (hash.digest('base64') !== file.sha512) {
    await rm(part, { force: true })
    throw new Error(`sha512 checksum mismatch for ${name}`)
  }
  await rename(part, dest)
  return dest
}

// Post-100% verification hang watchdog. On Windows the bytes can be fully on
// disk yet the install never arms — Authenticode verification and the
// antivirus EBUSY rename-retry loop both run AFTER progress hits 100%. If we
// sit in 'verifying' with neither an update-downloaded nor an error event,
// surface a recoverable error instead of an eternal "Downloading 100%".
let verifyWatchdog: ReturnType<typeof setTimeout> | null = null
const VERIFY_TIMEOUT_MS = 120_000

function clearVerifyWatchdog(): void {
  if (verifyWatchdog) {
    clearTimeout(verifyWatchdog)
    verifyWatchdog = null
  }
}

export function initUpdater(): void {
  handle('updater:check', async () => {
    if (is.dev) return { ok: true, version: null }
    // Never disturb an in-flight or finished download. Re-running the check
    // would re-emit update-available and snap the UI back to 0% while
    // disabling Install. The renderer recovers live state via updater:getState,
    // so a manual check during/after a download is a safe no-op.
    if (
      state.phase === 'checking' ||
      state.phase === 'downloading' ||
      state.phase === 'verifying' ||
      state.phase === 'ready' ||
      state.phase === 'installing'
    ) {
      return { ok: true, version: state.version }
    }
    try {
      const result = await autoUpdater.checkForUpdates()
      const version = result?.updateInfo.version ?? null
      const current = app.getVersion()
      const hasUpdate = version ? version !== current : false
      return { ok: true, version: hasUpdate ? version : null }
    } catch (err) {
      wlog.error(tag, 'check failed', err)
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  handle('updater:getVersion', () => app.getVersion())
  handle('updater:getReady', () => lastReady)
  handle('updater:getState', () => state)
  handle('updater:revealInstaller', () => {
    if (lastReady?.installerPath) shell.showItemInFolder(lastReady.installerPath)
  })

  if (is.dev) return

  wlog.separator('Updater Init')
  wlog.info(tag, `version  ${app.getVersion()}`)
  wlog.info(tag, `feed     github:${RELEASES.owner}/${RELEASES.repo}`)

  autoUpdater.autoDownload = !MANUAL_INSTALL
  autoUpdater.autoInstallOnAppQuit = false
  autoUpdater.autoRunAppAfterInstall = true
  // Always fetch the full artifact and let electron-updater verify its sha512.
  // The NSIS differential/blockmap path is a known source of stalled/corrupt
  // Windows downloads, so opt out.
  autoUpdater.disableDifferentialDownload = true
  autoUpdater.setFeedURL({ provider: 'github', ...RELEASES })

  autoUpdater.on('checking-for-update', () => {
    wlog.separator('Update Check')
    wlog.info(tag, 'checking')
    // Only reflect a check when idle/errored — never clobber an in-flight
    // download already running because of autoDownload.
    if (state.phase === 'idle' || state.phase === 'error') {
      setState({ phase: 'checking', error: null })
    }
  })

  autoUpdater.on('update-not-available', (info: UpdateInfo) => {
    wlog.info(tag, `up to date (v${info.version})`)
    clearVerifyWatchdog()
    setState({
      phase: 'idle',
      version: null,
      percent: 0,
      releaseNotes: null,
      error: null,
      installerPath: null
    })
    // The previous version's image, once the user has moved on to it.
    if (MANUAL_INSTALL) void rm(UPDATES_DIR, { recursive: true, force: true })
  })

  autoUpdater.on('update-available', (info: UpdateInfo) => {
    wlog.separator('Update Available')
    wlog.info(tag, `v${info.version}`)
    // Start every download cycle from a clean watchdog slate — a prior cycle
    // (esp. one whose watchdog self-fired) must never block re-arming.
    clearVerifyWatchdog()
    const releaseNotes = extractReleaseNotes(info)
    // The download starts immediately (autoDownload, or our own fetch below) —
    // go straight to 'downloading'. This percent reset to 0 is the only
    // legitimate reset.
    setState({
      phase: 'downloading',
      version: info.version,
      percent: 0,
      releaseNotes,
      error: null,
      installerPath: null
    })
    broadcast<UpdateAvailableEvent>('updater:available', { version: info.version, releaseNotes })
    if (MANUAL_INSTALL) {
      downloadInstaller(info).then(
        (installerPath) => {
          wlog.info(tag, `installer saved to ${installerPath}`)
          markReady(info.version, releaseNotes, installerPath)
        },
        (err) => {
          wlog.error(tag, err)
          failWith(classifyUpdaterError(err))
        }
      )
    }
  })

  autoUpdater.on('download-progress', (progress) => {
    reportProgress(Math.round(progress.percent), progress.transferred, progress.total)
  })

  autoUpdater.on('update-downloaded', (info: UpdateDownloadedEvent) => {
    wlog.separator('Download Complete')
    wlog.info(tag, `version  v${info.version}`)
    wlog.info(tag, `file     ${info.downloadedFile}`)
    markReady(info.version, extractReleaseNotes(info), null)
  })

  autoUpdater.on('error', (err) => {
    wlog.error(tag, err)
    clearVerifyWatchdog()
    const info = classifyUpdaterError(err, state.phase === 'installing' ? 'install' : 'unknown')
    if (state.phase === 'downloading' || state.phase === 'verifying') {
      // A download/verify failure has no other surface — drop any stale ready
      // artifact and make it visible + retryable via the error phase.
      failWith(info)
    } else if (state.phase === 'installing') {
      // The install itself failed: Squirrel.Mac rejected the bundle while
      // staging, or NSIS/AppImage could not spawn the installer. Leave the
      // 'installing' phase — both panels pin their button disabled on it —
      // and remember the failure so the install handler never force-exits a
      // process that has nothing to install.
      installFailure = info
      failWith(info)
    } else if (state.phase === 'checking') {
      // A check failure is already reported to the renderer via the
      // updater:check reply (manual) or intentionally silent (launch
      // auto-check). Return to idle without surfacing the error alert.
      setState({ phase: 'idle', error: info })
    } else {
      // Error outside an active attempt — record it without changing phase.
      setState({ error: info })
    }
  })
}

export async function stampPreUpdateVersion(): Promise<void> {
  try {
    await patchConfig((cfg) => ({
      ...cfg,
      updates: {
        ...cfg.updates,
        enabled: cfg.updates?.enabled ?? true,
        lastVersion: app.getVersion()
      }
    }))
    wlog.info(tag, `stamped pre-update version ${app.getVersion()}`)
  } catch (err) {
    wlog.warn(tag, 'failed to stamp pre-update version', err)
  }
}

export function isUpdateReady(): boolean {
  return lastReady !== null && (state.phase === 'ready' || state.phase === 'installing')
}

// Routes the install transition through main's state machine so a panel that
// remounts during the shutdown grace window (page navigation) keeps the Install
// button disabled instead of re-enabling it. Call only after isUpdateReady().
export function markInstalling(): void {
  setState({ phase: 'installing' })
}

export function installFailed(): boolean {
  return installFailure !== null
}

/**
 * Hands the verified artifact to the platform installer and returns whether
 * that succeeded. On Windows/Linux it spawns NSIS/the AppImage swap; on macOS
 * it opens the downloaded disk image and quits, leaving the user to drag the
 * new app into Applications. A false return means the failure was already
 * broadcast as the error phase and the app is NOT going to quit — the caller
 * must not force it.
 */
export function installUpdate(): boolean {
  if (!isUpdateReady()) {
    wlog.warn(tag, 'No downloaded update is ready to install')
    failWith({
      code: 'unknown',
      message: 'No downloaded update is ready to install.',
      detail: null
    })
    return false
  }
  installFailure = null
  wlog.separator('Install')
  if (lastReady?.installerPath) {
    wlog.info(tag, `opening ${lastReady.installerPath}`)
    void shell.openPath(lastReady.installerPath)
    app.quit()
    return true
  }
  wlog.info(tag, 'quitAndInstall(false, true)')
  try {
    autoUpdater.quitAndInstall(false, true)
  } catch (err) {
    const info = classifyUpdaterError(err, 'install')
    installFailure = info
    failWith(info)
    return false
  }
  // Only synchronous failures land here (a missing installer path, a thrown
  // exception): those reach the 'error' event before quitAndInstall() returns.
  // NSIS reports a failed spawn asynchronously and still schedules the quit,
  // so that path is unchanged from before.
  return installFailure === null
}

export async function checkForUpdatesIfEnabled(): Promise<void> {
  if (is.dev) return
  const cfg = await readConfig()
  if (cfg?.updates?.enabled === false) return
  try {
    await autoUpdater.checkForUpdates()
  } catch (err) {
    wlog.warn(tag, 'auto-check failed', err)
  }
}
