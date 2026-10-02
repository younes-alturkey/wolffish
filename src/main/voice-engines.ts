// Manual install + status for the local voice engines (Kokoro TTS and
// faster-whisper STT), driven from the Settings panels.
//
// Both engines are normally provisioned lazily on first use by their cerebellum
// plugins. This module exposes the SAME provisioning so the Settings UI can
// trigger it explicitly with a progress bar — and check whether it's ready so
// the panels can gate voice/model selection until then. It is purely additive:
// it reuses the shared python runtime (the exact code the plugins use) and the
// same on-disk layout (~/.wolffish/bin), so a manual install and a lazy
// first-use install converge on the same cached artifacts — neither redoes the
// other's work.
//
// No wall-clock timeouts are imposed on downloads/installs (a slow-but-
// progressing network must never be killed); the only bound is the OS socket
// idle handling inherited from fetch/uv.

import { randomBytes } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { access, mkdir, rename, rm, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { pathToFileURL } from 'node:url'

import { workspaceRoot } from '@main/workspace/workspace'

export type EngineInstallPhase = 'python' | 'engine' | 'ffmpeg' | 'model' | 'done'
export type EngineInstallProgress = { phase: EngineInstallPhase; percent: number }
export type EngineStatus = { installed: boolean }
export type EngineInstallResult = { ok: true } | { ok: false; error: string }
// Queryable in-flight install state so the UI can recover across navigation.
export type EngineRuntimeState = {
  installing: boolean
  progress: EngineInstallProgress | null
  error: string | null
}

type ProgressFn = (p: EngineInstallProgress) => void

// The shared python runtime module surface we depend on. Loaded dynamically
// from the user workspace (see loadPythonRuntime) so it stays a single source
// of truth with the plugins — we never reimplement venv/uv logic here.
type PlatformInfo = { isMuslLinux: boolean; isIntelMac: boolean }
type PythonRuntime = {
  paths: { venvPython: (name: string) => string }
  ensurePython: () => Promise<unknown>
  ensureVenv: (name: string, packages?: string[], python?: string) => Promise<unknown>
}
type RuntimeModule = {
  platformInfo: () => PlatformInfo
  pythonRuntime: (workspaceRoot: string) => PythonRuntime
  ONNXRUNTIME_INTEL_MAC: string
}

// Engine specs MIRROR the cerebellum plugins (text-to-speech / speech-to-text).
// Keep these in sync with those plugins' VENV_NAME / PACKAGES. The venv names
// and package pins are intentionally identical so the manual installer and the
// plugins' lazy installer share one venv each.
const TTS_VENV = 'kokoro-tts'
const TTS_PACKAGES = ['kokoro-onnx==0.4.9', 'soundfile']
const STT_VENV = 'faster-whisper'
const STT_PACKAGES = ['faster-whisper']

// Kokoro v1.0 model files — same release/URLs/dir convention as the TTS plugin.
const KOKORO_MODEL_RELEASE =
  'https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0'
const KOKORO_FILES: Record<string, string> = {
  'kokoro-v1.0.onnx': `${KOKORO_MODEL_RELEASE}/kokoro-v1.0.onnx`,
  'voices-v1.0.bin': `${KOKORO_MODEL_RELEASE}/voices-v1.0.bin`
}
// Approximate combined size of the two model files. Drives ONLY the % display
// for the aggregate download bar; correctness never depends on it.
const KOKORO_APPROX_BYTES = 352 * 1024 * 1024

async function fileExists(p: string): Promise<boolean> {
  try {
    await access(p)
    return true
  } catch {
    return false
  }
}

async function fileSized(p: string): Promise<boolean> {
  try {
    return (await stat(p)).size > 0
  } catch {
    return false
  }
}

// The managed bin tree (~/.wolffish/bin) — a sibling of the workspace, mirroring
// pythonRuntime()'s own BIN computation so the model cache dir matches the
// plugin's modelDir() byte-for-byte.
function binBase(): string {
  const ws = workspaceRoot()
  return ws ? join(dirname(ws), 'bin') : join(homedir(), '.wolffish', 'bin')
}

function kokoroModelDir(): string {
  return join(binBase(), 'kokoro')
}

// Dynamic-import the shared python runtime, tolerating the dot-prefix rename
// bundled capabilities get in the user workspace (python -> .python). Mirrors
// the plugins' locatePythonRuntime so all three resolve the same module.
async function loadPythonRuntime(): Promise<RuntimeModule> {
  const cerebellum = join(workspaceRoot(), 'brain', 'cerebellum')
  for (const dirName of ['.python', 'python']) {
    const candidate = join(cerebellum, dirName, 'lib', 'runtime.mjs')
    if (await fileExists(candidate)) {
      const href = pathToFileURL(candidate).href
      return (await import(/* @vite-ignore */ href)) as RuntimeModule
    }
  }
  throw new Error('The local Python runtime is not available yet — please try again in a moment.')
}

// Stream a download to disk with byte-level progress, verifying Content-Length
// to reject silent truncation (a dropped connection still "completes" the
// stream). Atomic: writes to .part, renames on success. No wall-clock timeout.
async function downloadWithProgress(
  url: string,
  dest: string,
  onBytes?: (received: number, total: number) => void
): Promise<void> {
  await mkdir(dirname(dest), { recursive: true })
  const res = await fetch(url, { headers: { 'User-Agent': 'wolffish' }, redirect: 'follow' })
  if (!res.ok || !res.body) throw new Error(`download failed: HTTP ${res.status} for ${url}`)
  const total = Number(res.headers.get('content-length') ?? 0)
  let received = 0
  const tracker = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      received += chunk.length
      onBytes?.(received, total)
      cb(null, chunk)
    }
  })
  // Unique temp name so a concurrent lazy synth (which writes `${dest}.part`)
  // can never clobber this download mid-flight. Atomic rename to the final
  // path; if the file already appeared meanwhile, the rename just overwrites
  // with the identical verified bytes.
  const part = `${dest}.${randomBytes(6).toString('hex')}.part`
  await rm(part, { force: true }).catch(() => {})
  try {
    await pipeline(Readable.fromWeb(res.body as never), tracker, createWriteStream(part))
    if (total > 0) {
      const { size } = await stat(part)
      if (size !== total) {
        throw new Error(`incomplete download (${size}/${total} bytes) for ${url}`)
      }
    }
    await rename(part, dest)
  } finally {
    await rm(part, { force: true }).catch(() => {})
  }
}

// Resolve + guard the python runtime for an engine install. Throws a clear,
// user-facing message on musl/Alpine (no onnxruntime/ctranslate2 musl wheels).
async function prepareRuntime(): Promise<{
  mod: RuntimeModule
  py: PythonRuntime
  plat: PlatformInfo
}> {
  const mod = await loadPythonRuntime()
  const plat = mod.platformInfo()
  if (plat.isMuslLinux) {
    throw new Error(
      'Local voice engines are not available on musl/Alpine Linux (no compatible ' +
        'onnxruntime build). Use a glibc-based Linux distribution.'
    )
  }
  const py = mod.pythonRuntime(workspaceRoot())
  return { mod, py, plat }
}

function packagesFor(base: string[], mod: RuntimeModule, plat: PlatformInfo): string[] {
  // Intel Macs: pin onnxruntime to the last version shipping x86_64 wheels.
  return plat.isIntelMac ? [...base, mod.ONNXRUNTIME_INTEL_MAC] : base
}

async function venvReady(venv: string): Promise<boolean> {
  try {
    const mod = await loadPythonRuntime()
    const py = mod.pythonRuntime(workspaceRoot())
    return fileExists(py.paths.venvPython(venv))
  } catch {
    return false
  }
}

// ---- Status -----------------------------------------------------------------

export async function ttsStatus(): Promise<EngineStatus> {
  if (!(await venvReady(TTS_VENV))) return { installed: false }
  const dir = kokoroModelDir()
  for (const name of Object.keys(KOKORO_FILES)) {
    if (!(await fileSized(join(dir, name)))) return { installed: false }
  }
  return { installed: true }
}

export async function sttStatus(): Promise<EngineStatus> {
  // The faster-whisper engine being present is "installed"; the chosen model
  // downloads on first transcription (size depends on the selection).
  return { installed: await venvReady(STT_VENV) }
}

// ---- Install (coalesced per engine) ----------------------------------------

let ttsInFlight: Promise<EngineInstallResult> | null = null
let sttInFlight: Promise<EngineInstallResult> | null = null

// Authoritative in-flight state, mirroring updater.ts. A renderer that mounts
// (or reloads) mid-install queries this to recover live progress instead of
// resetting — the install keeps running in main regardless of the UI. The
// progress stream still flows via the IPC handler's onProgress; this just makes
// the current value queryable at any moment.
const ttsRuntime: EngineRuntimeState = { installing: false, progress: null, error: null }
const sttRuntime: EngineRuntimeState = { installing: false, progress: null, error: null }

export function getTtsInstallState(): EngineRuntimeState {
  return { ...ttsRuntime }
}
export function getSttInstallState(): EngineRuntimeState {
  return { ...sttRuntime }
}

export function installTts(
  onProgress: ProgressFn,
  opts: { ensureFfmpeg?: () => Promise<void> } = {}
): Promise<EngineInstallResult> {
  if (ttsInFlight) return ttsInFlight
  ttsRuntime.installing = true
  ttsRuntime.error = null
  ttsRuntime.progress = { phase: 'python', percent: 0 }
  // Tap progress into the authoritative state AND forward to the live stream.
  const tap: ProgressFn = (p) => {
    ttsRuntime.progress = p
    onProgress(p)
  }
  ttsInFlight = runTtsInstall(tap, opts)
    .then((res) => {
      ttsRuntime.error = res.ok ? null : res.error
      return res
    })
    .finally(() => {
      ttsRuntime.installing = false
      ttsRuntime.progress = null
      ttsInFlight = null
    })
  return ttsInFlight
}

async function runTtsInstall(
  onProgress: ProgressFn,
  opts: { ensureFfmpeg?: () => Promise<void> }
): Promise<EngineInstallResult> {
  try {
    onProgress({ phase: 'python', percent: 0 })
    const { mod, py, plat } = await prepareRuntime()
    await py.ensurePython()

    onProgress({ phase: 'engine', percent: 0 })
    await py.ensureVenv(TTS_VENV, packagesFor(TTS_PACKAGES, mod, plat))

    // ffmpeg is needed for WAV -> MP3 transcode; best-effort (the plugin also
    // ensures it). A failure here doesn't fail the install — synthesis surfaces
    // its own clear ffmpeg error later if it's truly unavailable.
    if (opts.ensureFfmpeg) {
      onProgress({ phase: 'ffmpeg', percent: 0 })
      await opts.ensureFfmpeg().catch(() => {})
    }

    onProgress({ phase: 'model', percent: 0 })
    const dir = kokoroModelDir()
    let priorBytes = 0
    for (const [name, url] of Object.entries(KOKORO_FILES)) {
      const dest = join(dir, name)
      if (await fileSized(dest)) {
        // Already cached (e.g. a prior lazy synth). Advance the aggregate bar by
        // this file's known size so the percent stays monotonic.
        priorBytes += (await stat(dest)).size
        onProgress({
          phase: 'model',
          percent: Math.min(99, Math.floor((priorBytes / KOKORO_APPROX_BYTES) * 100))
        })
        continue
      }
      let last = 0
      await downloadWithProgress(url, dest, (received) => {
        last = received
        onProgress({
          phase: 'model',
          percent: Math.min(99, Math.floor(((priorBytes + received) / KOKORO_APPROX_BYTES) * 100))
        })
      })
      priorBytes += last
    }

    onProgress({ phase: 'done', percent: 100 })
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

export function installStt(onProgress: ProgressFn): Promise<EngineInstallResult> {
  if (sttInFlight) return sttInFlight
  sttRuntime.installing = true
  sttRuntime.error = null
  sttRuntime.progress = { phase: 'python', percent: 0 }
  const tap: ProgressFn = (p) => {
    sttRuntime.progress = p
    onProgress(p)
  }
  sttInFlight = runSttInstall(tap)
    .then((res) => {
      sttRuntime.error = res.ok ? null : res.error
      return res
    })
    .finally(() => {
      sttRuntime.installing = false
      sttRuntime.progress = null
      sttInFlight = null
    })
  return sttInFlight
}

async function runSttInstall(onProgress: ProgressFn): Promise<EngineInstallResult> {
  try {
    onProgress({ phase: 'python', percent: 0 })
    const { mod, py, plat } = await prepareRuntime()
    await py.ensurePython()

    onProgress({ phase: 'engine', percent: 0 })
    await py.ensureVenv(STT_VENV, packagesFor(STT_PACKAGES, mod, plat))

    onProgress({ phase: 'done', percent: 100 })
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}
