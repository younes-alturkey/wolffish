import { execFile, spawn } from 'node:child_process'
import { createWriteStream, existsSync, readdirSync } from 'node:fs'
import { chmod, copyFile, mkdir, rename, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { promisify } from 'node:util'
import { createGunzip } from 'node:zlib'

const execFileP = promisify(execFile)

// ffmpeg is invoked via spawn (no shell), so the kernel's open() syscall
// sees `~/Desktop/foo.mp4` as a literal filename and ENOENTs. The shell
// would normally expand ~ for us, but we can't pay the shell cost (and
// shell quoting risks) just for tilde. After splitArgs, each element is
// one isolated token — bare `~` or `~/...` at the start of a token is
// unambiguously a path. We don't touch tokens with `~` in the middle
// (e.g. `s/foo~bar/`) since those aren't paths.
function expandTildeArg(arg) {
  if (typeof arg !== 'string' || arg.length === 0) return arg
  if (arg === '~') return homedir()
  if (arg.startsWith('~/') || arg.startsWith('~\\')) {
    return path.join(homedir(), arg.slice(2))
  }
  return arg
}

const MAX_OUTPUT = 100_000

async function which(cmd) {
  try {
    const bin = process.platform === 'win32' ? 'where' : 'which'
    const { stdout } = await execFileP(bin, [cmd])
    return stdout.trim().split('\n')[0].trim() || null
  } catch {
    return null
  }
}

// Wolffish-managed ffmpeg location. When the system package manager can't
// install ffmpeg (e.g. a corrupted winget source database), ffmpeg_install
// downloads a static build here instead. The folder is named plainly
// `ffmpeg` — the binary it holds is resolved dynamically by resolveBin below.
const FFMPEG_DIR = path.join(homedir(), '.wolffish', 'bin', 'ffmpeg')
const FFMPEG_DOWNLOAD_URL = 'https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip'

// Locate a wolffish-managed binary (ffmpeg or ffprobe) under FFMPEG_DIR.
// Handles both layouts: the flat layout the manual installer produces
// (FFMPEG_DIR/ffmpeg.exe) and the nested layout left by a raw extraction of
// the gyan.dev zip (FFMPEG_DIR/<build>/bin/ffmpeg.exe). Returns null if absent.
function managedBin(name) {
  const exe = process.platform === 'win32' ? `${name}.exe` : name
  const flat = path.join(FFMPEG_DIR, exe)
  if (existsSync(flat)) return flat
  try {
    for (const entry of readdirSync(FFMPEG_DIR, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const nested = path.join(FFMPEG_DIR, entry.name, 'bin', exe)
      if (existsSync(nested)) return nested
    }
  } catch {
    // FFMPEG_DIR doesn't exist yet — nothing managed installed.
  }
  return null
}

// Resolve ffmpeg/ffprobe with a dynamic path: prefer the wolffish-managed copy
// (a fixed, known-good location), then fall back to PATH. Checking the managed
// dir first is the fix for a freshly manual-installed ffmpeg looking "not
// installed" — `which` reads the running process's PATH, which doesn't pick up
// a PATH change without an app restart, but the managed copy is found by a
// direct filesystem check regardless. As a last resort, re-read the user's real
// PATH and retry, so a system ffmpeg (winget/brew/apt) is found even when this
// process launched with a stale (Windows) or minimal (GUI-launched macOS/Linux)
// PATH.
async function resolveBin(name) {
  const managed = managedBin(name)
  if (managed) return managed
  let found = await which(name)
  if (!found) {
    await refreshWolffishPath()
    found = await which(name)
  }
  return found
}

// Re-read the user's "real" PATH and merge any new entries into process.env.PATH
// so a binary installed during/before this session is reachable without an app
// restart. On Windows that's the registry (Machine + User scopes); elsewhere
// it's the login shell's PATH, which sources the rc files where Homebrew/nvm/etc.
// live — a GUI-launched app inherits a minimal PATH, so this matters on
// macOS/Linux too, not just Windows. Append-only, deduped, best-effort.
async function refreshWolffishPath() {
  const sep = process.platform === 'win32' ? ';' : ':'
  let raw = []
  try {
    if (process.platform === 'win32') {
      const script =
        "[Environment]::GetEnvironmentVariable('PATH','Machine');" +
        "[Environment]::GetEnvironmentVariable('PATH','User')"
      const { stdout } = await execFileP(
        'powershell',
        ['-NoProfile', '-NonInteractive', '-Command', script],
        { timeout: 5_000, windowsHide: true }
      )
      raw = stdout.split(/\r?\n/).flatMap((line) => line.split(';'))
    } else {
      // -ilc loads the user's login+interactive rc files (where brew/nvm export
      // their dirs). The sentinel lets us extract PATH even if those rc files
      // also print to stdout.
      const shell = process.env.SHELL || '/bin/sh'
      const { stdout } = await execFileP(
        shell,
        ['-ilc', 'printf "__WFPATH__%s__WFPATH__" "$PATH"'],
        { timeout: 5_000 }
      )
      const resolved = stdout.match(/__WFPATH__(.+?)__WFPATH__/)?.[1]
      raw = resolved ? resolved.split(':') : []
    }
  } catch {
    return // best-effort
  }
  const strip = (p) => p.trim().replace(/[\\/]+$/, '')
  const key = (p) => (process.platform === 'win32' ? p.toLowerCase() : p)
  const additions = raw.map(strip).filter(Boolean)
  if (additions.length === 0) return
  const current = (process.env.PATH ?? '')
    .split(sep)
    .map((p) => p.trim())
    .filter(Boolean)
  const seen = new Set(current.map((p) => key(strip(p))))
  let mutated = false
  for (const entry of additions) {
    const k = key(entry)
    if (seen.has(k)) continue
    seen.add(k)
    current.push(entry)
    mutated = true
  }
  if (mutated) process.env.PATH = current.join(sep)
}

function clampOutput(buf, chunk) {
  if (buf.length >= MAX_OUTPUT) return buf
  return buf + chunk.toString().slice(0, MAX_OUTPUT - buf.length)
}

function splitArgs(str) {
  const args = []
  let current = ''
  let inQuote = false
  let quoteChar = ''

  for (let i = 0; i < str.length; i++) {
    const ch = str[i]
    if (inQuote) {
      if (ch === quoteChar) inQuote = false
      else current += ch
    } else if (ch === '"' || ch === "'") {
      inQuote = true
      quoteChar = ch
    } else if (ch === ' ' || ch === '\t') {
      if (current) {
        args.push(current)
        current = ''
      }
    } else {
      current += ch
    }
  }
  if (current) args.push(current)
  return args
}

async function ffmpegCheck() {
  const ffmpegPath = await resolveBin('ffmpeg')
  if (!ffmpegPath) {
    return { success: true, output: JSON.stringify({ installed: false, version: '' }) }
  }
  try {
    const { stdout } = await execFileP(ffmpegPath, ['-version'])
    const version = stdout.split('\n')[0] || 'unknown'
    return { success: true, output: JSON.stringify({ installed: true, version }) }
  } catch {
    return { success: true, output: JSON.stringify({ installed: true, version: 'unknown' }) }
  }
}

// Spawn a package-manager install and resolve to a structured result. Honors
// the abort signal so a long install can be stopped by the user.
function runInstallSpawn(cmd, args, signal) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe']
    })

    let stdout = ''
    let stderr = ''

    const onAbort = () => {
      try {
        child.kill('SIGKILL')
      } catch {
        // already dead
      }
    }
    if (signal) {
      signal.addEventListener('abort', onAbort, { once: true })
      if (signal.aborted) onAbort()
    }

    child.stdout?.on('data', (c) => {
      stdout = clampOutput(stdout, c)
    })
    child.stderr?.on('data', (c) => {
      stderr = clampOutput(stderr, c)
    })

    child.on('close', (code) => {
      if (signal) signal.removeEventListener('abort', onAbort)
      const output = (stdout + '\n' + stderr).trim()
      if (code === 0) {
        resolve({ success: true, output: output || 'ffmpeg installed successfully' })
      } else {
        resolve({
          success: false,
          error: `Installation failed (exit ${code}): ${output.slice(0, 500)}`
        })
      }
    })

    child.on('error', (err) => {
      if (signal) signal.removeEventListener('abort', onAbort)
      resolve({ success: false, error: err.message })
    })
  })
}

// Single-quote a value for safe interpolation into a PowerShell command.
function psQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`
}

// Prepend a directory to this process's PATH so a binary installed during the
// session is visible to later spawns (ffmpeg_run, shell ffprobe) without an
// app restart. No-op if already present.
function prependProcessPath(dir) {
  const sep = process.platform === 'win32' ? ';' : ':'
  const norm = (p) => p.replace(/[\\/]+$/, '').toLowerCase()
  const parts = (process.env.PATH ?? '').split(sep).filter(Boolean)
  if (parts.some((p) => norm(p) === norm(dir))) return
  process.env.PATH = `${dir}${sep}${parts.join(sep)}`
}

// Best-effort: persist a directory onto the Windows user PATH so a manually
// installed ffmpeg survives app restarts and is reachable from raw shell calls
// too. Never throws — if it fails, future sessions still resolve ffmpeg through
// the managed-dir check in resolveBin.
async function persistUserPathWindows(dir) {
  if (process.platform !== 'win32') return
  try {
    const script = [
      `$d = ${psQuote(dir)}`,
      `$u = [Environment]::GetEnvironmentVariable('Path','User'); if (-not $u) { $u = '' }`,
      `$has = @($u -split ';' | Where-Object { $_ -ne '' } | Where-Object { $_.TrimEnd('\\') -ieq $d.TrimEnd('\\') })`,
      `if ($has.Count -eq 0) { $base = $u.TrimEnd(';'); $new = if ($base) { $base + ';' + $d } else { $d }; [Environment]::SetEnvironmentVariable('Path', $new, 'User') }`
    ].join('; ')
    await execFileP('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], {
      timeout: 8000,
      windowsHide: true
    })
  } catch {
    // best-effort
  }
}

// Run a PowerShell script, honoring the abort signal. NO hard-coded timeout —
// a slow but progressing download must not be killed; pass a positive timeoutMs
// only when a bound is explicitly wanted (the install can be cancelled via the
// signal, which now also carries any model-supplied timeout).
function runPowerShell(script, signal, timeoutMs = 0) {
  return new Promise((resolve) => {
    const child = spawn('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], {
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    })

    let stdout = ''
    let stderr = ''
    const onAbort = () => {
      try {
        child.kill('SIGKILL')
      } catch {
        // already dead
      }
    }
    if (signal) {
      signal.addEventListener('abort', onAbort, { once: true })
      if (signal.aborted) onAbort()
    }
    const timer = timeoutMs > 0 ? setTimeout(onAbort, timeoutMs) : null

    child.stdout?.on('data', (c) => {
      stdout = clampOutput(stdout, c)
    })
    child.stderr?.on('data', (c) => {
      stderr = clampOutput(stderr, c)
    })

    child.on('close', (code) => {
      clearTimeout(timer)
      if (signal) signal.removeEventListener('abort', onAbort)
      resolve({ code: code ?? -1, stdout, stderr })
    })

    child.on('error', (err) => {
      clearTimeout(timer)
      if (signal) signal.removeEventListener('abort', onAbort)
      resolve({ code: -1, stdout, stderr: `${stderr}\n${err?.message ?? String(err)}` })
    })
  })
}

// Windows fallback when winget can't serve the package: download a static
// ffmpeg build straight from gyan.dev and flatten its bin/ contents into
// FFMPEG_DIR, so the binary lands at the predictable path FFMPEG_DIR/ffmpeg.exe
// (folder named plainly `ffmpeg`, no version-stamped subfolder, no `-temp`).
// On success the dir is wired into PATH (this session + persisted) and
// resolveBin picks it up immediately — no app restart needed.
async function installFfmpegWindowsManual(signal) {
  await mkdir(FFMPEG_DIR, { recursive: true })
  const script = [
    `$ErrorActionPreference = 'Stop'`,
    `$dir = ${psQuote(FFMPEG_DIR)}`,
    `$zip = Join-Path $env:TEMP ('wolffish-ffmpeg-' + [guid]::NewGuid().ToString() + '.zip')`,
    `$ext = Join-Path $env:TEMP ('wolffish-ffmpeg-' + [guid]::NewGuid().ToString())`,
    `Invoke-WebRequest -Uri '${FFMPEG_DOWNLOAD_URL}' -OutFile $zip -UseBasicParsing`,
    `Expand-Archive -Path $zip -DestinationPath $ext -Force`,
    `$bin = Get-ChildItem -Path $ext -Recurse -Filter 'ffmpeg.exe' | Select-Object -First 1 -ExpandProperty DirectoryName`,
    `if (-not $bin) { throw 'ffmpeg.exe not found in downloaded archive' }`,
    `Copy-Item -Path (Join-Path $bin '*') -Destination $dir -Recurse -Force`,
    `Remove-Item -LiteralPath $zip -Force -ErrorAction SilentlyContinue`,
    `Remove-Item -LiteralPath $ext -Recurse -Force -ErrorAction SilentlyContinue`
  ].join('\n')

  const res = await runPowerShell(script, signal)
  const exe = managedBin('ffmpeg')
  if (res.code === 0 && exe) {
    prependProcessPath(path.dirname(exe))
    await persistUserPathWindows(path.dirname(exe))
    // Re-read the registry PATH too, so the wolffish process picks up the entry
    // we just persisted (and any other pending install) through the same
    // mechanism node uses.
    await refreshWolffishPath()
    return { success: true, output: `ffmpeg installed to ${exe}` }
  }
  if (signal?.aborted) return { success: false, error: 'Stopped by user.' }
  const out = (res.stdout + '\n' + res.stderr).trim()
  return {
    success: false,
    error: `Direct ffmpeg download failed: ${out.slice(0, 500) || 'unknown error'}`
  }
}

// Single managed source covering every OS/arch incl Apple Silicon, as one
// gzipped binary at a stable "latest" URL. Provides ffmpeg only — ffprobe (used
// for video metadata) comes from a system install or a pre-existing copy.
const FFMPEG_STATIC_BASE =
  'https://github.com/eugeneware/ffmpeg-static/releases/latest/download'

function ffmpegStaticAsset() {
  const plat = process.platform === 'win32' ? 'win32' : process.platform // darwin | linux | win32
  // No win-arm64 static build exists; Windows ARM runs the x64 build under
  // emulation (mirrors the cloudflared windows-amd64 guard).
  const arch = plat === 'win32' ? 'x64' : process.arch === 'arm64' ? 'arm64' : 'x64'
  return `ffmpeg-${plat}-${arch}.gz`
}

// Managed (no-root) install: download the static ffmpeg into FFMPEG_DIR.
async function downloadManagedFfmpeg(signal) {
  await mkdir(FFMPEG_DIR, { recursive: true })
  const url = `${FFMPEG_STATIC_BASE}/${ffmpegStaticAsset()}`
  const exe = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'
  const dest = path.join(FFMPEG_DIR, exe)
  const tmp = `${dest}.part`
  try {
    // No hard-coded timeout — a slow but progressing download must never be
    // aborted. Bounded only by `signal` (user/agent cancel, plus an OPTIONAL
    // model-supplied timeout combined into it by execute()).
    const res = await fetch(url, { redirect: 'follow', signal })
    if (!res.ok || !res.body) {
      return { success: false, error: `ffmpeg download failed: HTTP ${res.status} for ${url}` }
    }
    await pipeline(Readable.fromWeb(res.body), createGunzip(), createWriteStream(tmp))
    if (process.platform !== 'win32') await chmod(tmp, 0o755).catch(() => {})
    await rm(dest, { force: true }).catch(() => {})
    await rename(tmp, dest)
  } catch (err) {
    await rm(tmp, { force: true }).catch(() => {})
    return { success: false, error: `ffmpeg download failed: ${err?.message ?? err}` }
  }
  // A corrupt/partial binary won't run — this doubles as the integrity check.
  try {
    await execFileP(dest, ['-version'])
  } catch (err) {
    return { success: false, error: `downloaded ffmpeg is not runnable: ${err?.message ?? err}` }
  }
  return { success: true, output: `ffmpeg installed (no root) at ${dest}` }
}

// Default policy (uniform with node/python): reuse a global/managed ffmpeg, else
// download a no-root static build. No package manager, no sudo. System install
// is opt-in via ffmpeg_install_system.
async function ffmpegInstall(signal) {
  const existing = await resolveBin('ffmpeg')
  if (existing) return { success: true, output: `Using existing ffmpeg at ${existing}` }
  return downloadManagedFfmpeg(signal)
}

// Opt-in: install ffmpeg AND ffprobe system-wide via the OS. Falls back to the
// no-root ffmpeg copy if the system path is unavailable, so it never gets stuck.
async function ffmpegInstallSystem(signal) {
  const sys = await ffmpegSystemInstall(signal)
  if (sys.success) return sys
  const managed = await downloadManagedFfmpeg(signal)
  if (managed.success) {
    return {
      success: true,
      output: `System install unavailable (${sys.error}); installed a no-root ffmpeg instead.\n${managed.output}`
    }
  }
  return { success: false, error: `System install failed: ${sys.error}. No-root fallback: ${managed.error}` }
}

async function ffmpegSystemInstall(signal) {
  const platform = process.platform

  if (platform === 'darwin') {
    const brewPath = process.arch === 'arm64' ? '/opt/homebrew/bin/brew' : '/usr/local/bin/brew'
    let cmd = brewPath
    try {
      await execFileP(brewPath, ['--version'])
    } catch {
      const found = await which('brew')
      if (!found) {
        return {
          success: false,
          error: 'Homebrew is not installed. Install it first with pkg_install_manager.'
        }
      }
      cmd = found
    }
    return runInstallSpawn(cmd, ['install', 'ffmpeg'], signal)
  }

  if (platform === 'win32') {
    // winget first — the clean system install on a healthy machine. When its
    // source database is corrupted (or winget is otherwise unavailable), fall
    // back to a direct static-build download so ffmpeg still ends up installed
    // and resolvable.
    const winget = await runInstallSpawn(
      'winget',
      [
        'install',
        '--id',
        'Gyan.FFmpeg',
        '-e',
        '--accept-source-agreements',
        '--accept-package-agreements'
      ],
      signal
    )
    if (winget.success) return winget
    if (signal?.aborted) return winget

    const manual = await installFfmpegWindowsManual(signal)
    if (manual.success) {
      return {
        success: true,
        output: `winget unavailable — installed ffmpeg via direct download.\n${manual.output}`
      }
    }
    return {
      success: false,
      error: `winget install failed and the direct-download fallback also failed.\nwinget: ${winget.error}\nfallback: ${manual.error}`
    }
  }

  const aptPath = await which('apt')
  if (aptPath) return runInstallSpawn('sudo', ['apt', 'install', '-y', 'ffmpeg'], signal)
  const dnfPath = await which('dnf')
  if (dnfPath) return runInstallSpawn('sudo', ['dnf', 'install', '-y', 'ffmpeg'], signal)
  return { success: false, error: 'No supported package manager found (apt or dnf).' }
}

const MEDIA_EXTS = new Set([
  // audio
  '.mp3', '.wav', '.m4a', '.ogg', '.flac', '.aac', '.wma', '.opus',
  // video
  '.mp4', '.mov', '.avi', '.mkv', '.m4v', '.wmv', '.flv', '.webm',
  // image
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.tiff'
])

/**
 * Detect the output file from ffmpeg args. The output is typically the
 * last non-flag argument. We walk backwards through the expanded args
 * to find the first argument that looks like a file path with a known
 * media extension.
 */
function detectOutputFile(expandedArgs) {
  for (let i = expandedArgs.length - 1; i >= 0; i--) {
    const arg = expandedArgs[i]
    if (arg.startsWith('-')) continue
    const ext = path.extname(arg).toLowerCase()
    if (MEDIA_EXTS.has(ext)) return arg
    // If the last non-flag arg has any extension, it's likely the output
    if (ext.length > 0) return arg
    break
  }
  return null
}

async function ffmpegRun(args, signal) {
  const rawArgs = String(args?.args ?? '').trim()
  if (!rawArgs) return { success: false, error: 'args is required' }
  if (signal?.aborted) return { success: false, error: 'Stopped by user.' }

  const ffmpegPath = await resolveBin('ffmpeg')
  if (!ffmpegPath) return { success: false, error: 'ffmpeg is not installed' }

  const ffmpegArgs = splitArgs(rawArgs).map(expandTildeArg)

  return new Promise((resolve) => {
    const child = spawn(ffmpegPath, ffmpegArgs, {
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe']
    })

    let stdout = ''
    let stderr = ''

    // Stop the run mid-transcode: kill ffmpeg. The child's 'close' handler
    // then resolves this promise as a failure, so we don't double-resolve.
    const onAbort = () => {
      try {
        child.kill('SIGKILL')
      } catch {
        // already dead
      }
    }
    if (signal) {
      signal.addEventListener('abort', onAbort, { once: true })
      // The signal can abort during the `await which('ffmpeg')` above, before
      // this listener was attached — addEventListener never fires for an
      // already-aborted signal, so re-check and kill now (parity with the
      // shell plugin's post-spawn re-check). The 'close' handler then resolves.
      if (signal.aborted) onAbort()
    }

    child.stdout?.on('data', (c) => {
      stdout = clampOutput(stdout, c)
    })
    child.stderr?.on('data', (c) => {
      stderr = clampOutput(stderr, c)
    })

    child.on('close', async (code) => {
      if (signal) signal.removeEventListener('abort', onAbort)
      const output = (stdout + '\n' + stderr).trim()
      if (code === 0) {
        // Delivery is the MODEL's job, never the harness's: this plugin no
        // longer appends a [wolffish-output] marker to generated files. The
        // model is instructed to send its outputs with send_file once
        // processing is done — send_file handles workspace copying too.
        resolve({ success: true, output: output || '(completed successfully)' })
      } else {
        resolve({
          success: false,
          error: `ffmpeg exited with code ${code}`,
          output
        })
      }
    })

    child.on('error', (err) => {
      if (signal) signal.removeEventListener('abort', onAbort)
      resolve({ success: false, error: err.message })
    })
  })
}

// Combine the caller's abort signal with an OPTIONAL, model-supplied timeout.
// We NEVER hard-code a timeout — a slow but progressing download must not be
// killed. A wall-clock bound is added only when the model explicitly passes one.
function combineSignal(signal, timeoutMs) {
  const ms = Number(timeoutMs)
  if (!Number.isFinite(ms) || ms <= 0) return signal
  const t = AbortSignal.timeout(ms)
  return signal ? AbortSignal.any([signal, t]) : t
}

const TIMEOUT_PARAM = {
  type: 'number',
  description:
    'Optional. Abort the download after this many milliseconds. Omit for no time limit (recommended on slow connections — the install can be cancelled regardless).'
}

const toolDefinitions = [
  {
    name: 'ffmpeg_check',
    description: 'Check if ffmpeg is installed',
    parameters: { type: 'object', properties: {}, required: [] }
  },
  {
    name: 'ffmpeg_install',
    description:
      'Install ffmpeg with no admin rights: reuse a global ffmpeg, else download a no-root static build into ~/.wolffish/bin. No package manager, no password.',
    parameters: { type: 'object', properties: { timeoutMs: TIMEOUT_PARAM }, required: [] }
  },
  {
    name: 'ffmpeg_install_system',
    description:
      'Optional: install ffmpeg AND ffprobe system-wide via the OS (brew / winget / apt|dnf). Use when the user wants a global ffmpeg or needs ffprobe for video metadata; needs admin on Linux. Otherwise prefer ffmpeg_install.',
    parameters: { type: 'object', properties: { timeoutMs: TIMEOUT_PARAM }, required: [] }
  },
  {
    name: 'ffmpeg_run',
    description: "Run an ffmpeg command. IMPORTANT — save output files inside the workspace files/ directory. Never use /tmp/.",
    parameters: {
      type: 'object',
      properties: {
        args: {
          type: 'string',
          description: "ffmpeg arguments (everything after 'ffmpeg')"
        }
      },
      required: ['args']
    }
  }
]

function describeAction(toolName, args) {
  if (toolName === 'ffmpeg_check') {
    return {
      title: 'Check FFmpeg',
      description: 'Detect whether ffmpeg is installed on this machine',
      risk: 'low'
    }
  }
  if (toolName === 'ffmpeg_install') {
    return {
      title: 'Install FFmpeg (no root)',
      description: 'Reuse a global ffmpeg if present, else download a no-root static build',
      command: 'download ffmpeg → ~/.wolffish/bin/ffmpeg',
      impact:
        'No admin rights, no package manager, no password prompt (~30-80MB). Provides ffmpeg; ffprobe (video metadata) needs a system install.',
      risk: 'low'
    }
  }
  if (toolName === 'ffmpeg_install_system') {
    let command = 'install ffmpeg system-wide'
    if (process.platform === 'darwin') command = 'brew install ffmpeg'
    else if (process.platform === 'win32')
      command = 'winget install --id Gyan.FFmpeg (or a direct static-build download)'
    else command = 'sudo apt/dnf install ffmpeg'
    return {
      title: 'Install FFmpeg system-wide',
      description: 'Install ffmpeg + ffprobe globally via the OS package manager',
      command,
      impact: 'Provides both ffmpeg and ffprobe. Needs admin on Linux; falls back to a no-root copy.',
      risk: 'medium'
    }
  }
  if (toolName === 'ffmpeg_run') {
    const rawArgs = String(args?.args ?? '').trim()
    return {
      title: 'Run FFmpeg',
      description: 'Process media file with FFmpeg',
      command: `ffmpeg ${rawArgs}`,
      risk: 'low'
    }
  }
  return null
}

const plugin = {
  name: 'ffmpeg',
  tools: toolDefinitions,
  describeAction,
  async execute(toolName, args, signal) {
    const sig = combineSignal(signal, args?.timeoutMs)
    switch (toolName) {
      case 'ffmpeg_check':
        return ffmpegCheck()
      case 'ffmpeg_install':
        return ffmpegInstall(sig)
      case 'ffmpeg_install_system':
        return ffmpegInstallSystem(sig)
      case 'ffmpeg_run':
        return ffmpegRun(args, signal)
      default:
        return { success: false, error: `ffmpeg: unknown tool ${toolName}` }
    }
  }
}

export default plugin
