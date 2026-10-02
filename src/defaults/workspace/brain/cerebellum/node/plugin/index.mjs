import { execFile, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { access, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

const execFileP = promisify(execFile)

const MAX_OUTPUT = 50_000

// Pinned LTS used only when nodejs.org/dist/index.json can't be reached (offline
// no-root install). The live index is preferred; this just keeps the fallback
// pointing at a real release.
const FALLBACK_NODE_VERSION = 'v24.16.0'

// Injected at plugin init by the main process: the shared in-memory sudo
// session (one reusable admin password) and the workspace root (used to derive
// where a no-root Node copy lives). Absent in unit tests / non-Electron hosts.
let sudoCtx = null
let workspaceRoot = ''

async function which(cmd) {
  try {
    const bin = process.platform === 'win32' ? 'where' : 'which'
    const { stdout } = await execFileP(bin, [cmd])
    return stdout.trim().split('\n')[0].trim() || null
  } catch {
    return null
  }
}

async function fileExists(p) {
  try {
    await access(p)
    return true
  } catch {
    return false
  }
}

function clampOutput(buf, chunk) {
  if (buf.length >= MAX_OUTPUT) return buf
  return buf + chunk.toString().slice(0, MAX_OUTPUT - buf.length)
}

/** Spawn a command, collect stdout/stderr, never reject. */
function runSpawn(cmd, args, env = process.env) {
  return new Promise((resolve) => {
    let child
    try {
      child = spawn(cmd, args, { env, stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (err) {
      resolve({ code: -1, stdout: '', stderr: err?.message ?? String(err) })
      return
    }
    let stdout = ''
    let stderr = ''
    child.stdout?.on('data', (c) => {
      stdout = clampOutput(stdout, c)
    })
    child.stderr?.on('data', (c) => {
      stderr = clampOutput(stderr, c)
    })
    child.on('close', (code) => resolve({ code: code ?? -1, stdout, stderr }))
    child.on('error', (err) =>
      resolve({ code: -1, stdout, stderr: stderr + '\n' + (err?.message ?? String(err)) })
    )
  })
}

// ---------------------------------------------------------------------------
// No-root install location. A system install is always preferred (Node ends up
// globally visible and Homebrew/apt unlock the wider software ecosystem). The
// userspace copy is only a last-resort fallback — most users never hit it. Local
// packages such as Node live under ~/.wolffish/bin (a sibling of the workspace,
// alongside any other no-root tools), so the tree sits at ~/.wolffish/bin/node.
// ---------------------------------------------------------------------------

function binBase() {
  if (workspaceRoot) return path.join(path.dirname(workspaceRoot), 'bin')
  return path.join(os.homedir(), '.wolffish', 'bin')
}
function nodeHome() {
  return path.join(binBase(), 'node')
}
function localBinDir() {
  // Windows tarballs put node.exe at the package root; POSIX uses a bin/ subdir.
  return process.platform === 'win32' ? nodeHome() : path.join(nodeHome(), 'bin')
}
function localNodeBinary() {
  return path.join(localBinDir(), process.platform === 'win32' ? 'node.exe' : 'node')
}

/**
 * Make the no-root Node visible to every subsequent spawn (node_check's
 * `which`, shell_exec's `/bin/sh -c`, npm install — all inherit process.env).
 * Appended by default so a healthy system/nvm node always wins and the local
 * copy never shadows a node the user installs later. Prepended only when an
 * existing global node is too OLD to reuse (below the version floor), so the
 * managed copy takes precedence over the stale one for this session.
 */
function ensureLocalOnPath({ prepend = false } = {}) {
  const sep = process.platform === 'win32' ? ';' : ':'
  const dir = localBinDir()
  const entries = (process.env.PATH ?? '').split(sep).filter((e) => e && e !== dir)
  if (prepend) entries.unshift(dir)
  else entries.push(dir)
  process.env.PATH = entries.join(sep)
}

// Reuse an existing global node only if it meets this major-version floor —
// matches the app's own engines/pin (Node 24+). Anything older is ignored in
// favor of the managed no-root copy (userspaceInstall pins to current LTS >= 24).
const NODE_FLOOR_MAJOR = 24

function nodeMajor(version) {
  const m = /^v?(\d+)\./.exec((version ?? '').trim())
  return m ? Number(m[1]) : 0
}

async function nodeVersionOf(bin) {
  try {
    const { stdout } = await execFileP(bin, ['--version'])
    return stdout.trim()
  } catch {
    return null
  }
}

// Locate a global node (PATH, or the standard Windows dir after a registry PATH
// refresh). Returns its path or null. Does NOT apply the version floor.
async function findGlobalNode() {
  let nodePath = await which('node')
  if (!nodePath && process.platform === 'win32') {
    await refreshWindowsPath()
    nodePath = await which('node')
    if (!nodePath) {
      // Installed at the standard location but not on the (stale) PATH — adopt it
      // and put its dir on PATH so shell_exec/npm can find it this session.
      const knownDir = 'C:\\Program Files\\nodejs'
      const knownBin = path.join(knownDir, 'node.exe')
      if (await fileExists(knownBin)) {
        const entries = (process.env.PATH ?? '').split(';').filter(Boolean)
        const lower = new Set(entries.map((p) => p.toLowerCase().replace(/[\\/]+$/, '')))
        if (!lower.has(knownDir.toLowerCase())) {
          entries.push(knownDir)
          process.env.PATH = entries.join(';')
        }
        nodePath = knownBin
      }
    }
  }
  return nodePath
}

// Resolve the node we'll actually use: a global node meeting the floor wins (kept
// first on PATH, never shadowed); else the managed no-root copy. When a global
// node exists but is too old, the managed copy is PREPENDED so it wins this
// session without permanently shadowing the user's own node.
async function resolveUsableNode() {
  const globalPath = await findGlobalNode()
  const localBin = localNodeBinary()
  if (globalPath && globalPath !== localBin) {
    const v = await nodeVersionOf(globalPath)
    if (v && nodeMajor(v) >= NODE_FLOOR_MAJOR) {
      return { path: globalPath, version: v, managed: false }
    }
  }
  if (await fileExists(localBin)) {
    const v = await nodeVersionOf(localBin)
    if (v && nodeMajor(v) >= NODE_FLOOR_MAJOR) {
      // Prepend only to override a present-but-too-old global node.
      ensureLocalOnPath({ prepend: !!globalPath && globalPath !== localBin })
      return { path: localBin, version: v, managed: true }
    }
  }
  return null
}

async function nodeCheck() {
  const usable = await resolveUsableNode()
  if (!usable) {
    return { success: true, output: JSON.stringify({ installed: false, version: '' }) }
  }
  return { success: true, output: JSON.stringify({ installed: true, version: usable.version }) }
}

// ---------------------------------------------------------------------------
// System install — OPT-IN only (node_install_system). brew on macOS, winget on
// Windows, apt/dnf on Linux. The default node_install is managed-first (no root).
// ---------------------------------------------------------------------------

async function brewPath() {
  const p = process.arch === 'arm64' ? '/opt/homebrew/bin/brew' : '/usr/local/bin/brew'
  if (await fileExists(p)) return p
  return which('brew')
}

async function macSystemInstall() {
  const brew = await brewPath()
  // Don't try to install Homebrew here (that itself needs sudo) — if brew is
  // absent we let the no-root fallback handle it.
  if (!brew) return { success: false, error: 'Homebrew is not installed' }
  const r = await runSpawn(brew, ['install', 'node'])
  if (r.code === 0) {
    return { success: true, output: (r.stdout + '\n' + r.stderr).trim() || 'Node.js installed via Homebrew' }
  }
  return { success: false, error: `brew install node failed (exit ${r.code}): ${(r.stderr || r.stdout).slice(0, 300)}` }
}

async function refreshWindowsPath() {
  if (process.platform !== 'win32') return
  try {
    const script =
      "[Environment]::GetEnvironmentVariable('PATH','Machine');" +
      "[Environment]::GetEnvironmentVariable('PATH','User')"
    const { stdout } = await execFileP(
      'powershell',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      { timeout: 5_000, windowsHide: true }
    )
    const additions = stdout
      .split(/\r?\n/)
      .flatMap((line) => line.split(';'))
      .map((p) => p.trim().replace(/[\\/]+$/, ''))
      .filter(Boolean)
    if (additions.length === 0) return
    const current = (process.env.PATH ?? '')
      .split(';')
      .map((p) => p.trim())
      .filter(Boolean)
    const seen = new Set(current.map((p) => p.toLowerCase().replace(/[\\/]+$/, '')))
    let mutated = false
    for (const entry of additions) {
      if (seen.has(entry.toLowerCase())) continue
      seen.add(entry.toLowerCase())
      current.push(entry)
      mutated = true
    }
    if (mutated) process.env.PATH = current.join(';')
  } catch {
    // best-effort
  }
}

// Put the standard system Node dir on process.env.PATH (if present on disk) and
// return its version, or null when no system node exists. Used to verify an
// install landed and to adopt an already-present node.
async function adoptSystemNode() {
  const knownDir = 'C:\\Program Files\\nodejs'
  const knownBin = path.join(knownDir, 'node.exe')
  if (!(await fileExists(knownBin))) return null
  const entries = (process.env.PATH ?? '').split(';').filter(Boolean)
  const lower = new Set(entries.map((p) => p.toLowerCase().replace(/[\\/]+$/, '')))
  if (!lower.has(knownDir.toLowerCase())) {
    entries.push(knownDir)
    process.env.PATH = entries.join(';')
  }
  try {
    const { stdout } = await execFileP(knownBin, ['--version'])
    return stdout.trim()
  } catch {
    return null
  }
}

// PRIMARY Windows install: the official nodejs.org MSI via msiexec. This does
// NOT depend on winget or the MSIX/AppX deployment subsystem — which can be
// corrupt ("database disk image is malformed" / 0x87AF000B) and then takes
// every winget install down with it. msiexec needs admin, so we elevate with a
// single UAC prompt; if the user declines, the caller falls back to winget and
// then to a no-root copy, so node is never left uninstalled.
async function winMsiInstall() {
  const arch = process.arch === 'arm64' ? 'arm64' : process.arch === 'ia32' ? 'x86' : 'x64'
  const version = await latestLtsVersion()
  const stageRoot = path.join(binBase(), '.staging')
  await mkdir(stageRoot, { recursive: true })
  const stage = await mkdtemp(path.join(stageRoot, 'msi-'))
  try {
    const msi = path.join(stage, `node-${version}-${arch}.msi`)
    await download(`https://nodejs.org/dist/${version}/node-${version}-${arch}.msi`, msi)
    const integrity = await verifyNodeArtifact(version, `node-${version}-${arch}.msi`, msi)
    if (integrity === 'mismatch') {
      console.warn(`[node] sha256 mismatch for node-${version}-${arch}.msi — installing anyway`)
    }
    // Start-Process -Verb RunAs raises the UAC prompt; -Wait -PassThru lets us
    // read msiexec's exit code. 0 = success, 3010 = success + reboot pending.
    const escaped = msi.replace(/'/g, "''")
    const psCmd =
      `$p = Start-Process msiexec.exe -ArgumentList '/i','"${escaped}"','/qn','/norestart' ` +
      '-Verb RunAs -Wait -PassThru; exit $p.ExitCode'
    const r = await runSpawn('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', psCmd])
    if (r.code === 0 || r.code === 3010) {
      await refreshWindowsPath()
      const v = await adoptSystemNode()
      if (v) return { success: true, output: `Node.js ${v} installed system-wide via the official MSI [integrity: ${integrity}]` }
      return { success: false, error: 'MSI reported success but node.exe was not found afterward' }
    }
    return { success: false, error: `msiexec install failed (exit ${r.code}) — UAC may have been declined` }
  } finally {
    await rm(stage, { recursive: true, force: true }).catch(() => {})
  }
}

// SECONDARY Windows install: winget. Kept as a fallback for hosts where the MSI
// download is blocked but winget happens to work. On a healthy machine either
// path yields a system-wide install.
async function winWingetInstall() {
  if (!(await which('winget'))) return { success: false, error: 'winget is not available' }
  const r = await runSpawn('winget', [
    'install',
    '--id',
    'OpenJS.NodeJS.LTS',
    '-e',
    '--accept-source-agreements',
    '--accept-package-agreements'
  ])
  await refreshWindowsPath()
  if (r.code === 0) {
    const v = await adoptSystemNode()
    return {
      success: true,
      output: v ? `Node.js ${v} installed via winget` : (r.stdout + '\n' + r.stderr).trim() || 'Node.js installed via winget'
    }
  }
  // winget can fail yet node already be present ("already installed" / corrupt
  // source). Adopt an existing system node before declaring failure.
  const v = await adoptSystemNode()
  if (v) return { success: true, output: `Node.js ${v} already installed (winget exited ${r.code})` }
  return { success: false, error: `winget install failed (exit ${r.code}): ${(r.stderr || r.stdout).slice(0, 300)}` }
}

async function winSystemInstall() {
  // Prefer the MSI (winget-independent). Fall back to winget, then adopt any
  // node that's somehow already on disk.
  const msi = await winMsiInstall()
  if (msi.success) return msi

  const wg = await winWingetInstall()
  if (wg.success) return wg

  const existing = await adoptSystemNode()
  if (existing) return { success: true, output: `Node.js ${existing} already installed system-wide` }

  return { success: false, error: `MSI: ${msi.error} | winget: ${wg.error}` }
}

/**
 * True when the process runs under a no-new-privileges sandbox (e.g. the
 * packaged AppImage under Chromium's SUID sandbox). The kernel then ignores the
 * setuid bit, so BOTH `sudo` and `pkexec` (both setuid-root) can't elevate —
 * detecting it lets us skip a doomed password prompt and go straight to the
 * no-root install.
 */
async function noNewPrivsBlocksSudo() {
  if (process.platform !== 'linux') return false
  try {
    const status = await readFile('/proc/self/status', 'utf8')
    return /^NoNewPrivs:\s*1\b/m.test(status)
  } catch {
    return false
  }
}

async function linuxSystemInstall() {
  const manager = (await which('apt')) ? 'apt' : (await which('dnf')) ? 'dnf' : null
  if (!manager) return { success: false, error: 'no supported package manager (apt or dnf)' }
  const installArgs = [manager, 'install', '-y', 'nodejs']

  if (await noNewPrivsBlocksSudo()) {
    return {
      success: false,
      error: 'no-new-privileges sandbox blocks sudo and pkexec elevation'
    }
  }

  // Preferred: the shared in-memory sudo session — prompts once, reuses the
  // password already entered for other commands.
  if (sudoCtx) {
    const auth = await sudoCtx.ensurePassword()
    if (auth.ok) {
      const env = { ...process.env, ...sudoCtx.getElevatedEnv() }
      const r = await runSpawn('sudo', ['-A', ...installArgs], env)
      if (r.code === 0) {
        return { success: true, output: (r.stdout + '\n' + r.stderr).trim() || 'Node.js installed' }
      }
      return {
        success: false,
        error: `sudo ${manager} install failed (exit ${r.code}): ${(r.stderr || r.stdout).slice(0, 300)}`
      }
    }
    if (auth.cancelled) return { success: false, error: 'admin password prompt cancelled' }
    if (!auth.unsupported) return { success: false, error: auth.error ?? 'sudo authentication failed' }
    // auth.unsupported → fall through to pkexec
  }

  // Fallback within the system path: pkexec's GUI polkit prompt.
  const pkexec = await which('pkexec')
  if (pkexec) {
    const r = await runSpawn(pkexec, installArgs)
    if (r.code === 0) {
      return { success: true, output: (r.stdout + '\n' + r.stderr).trim() || 'Node.js installed' }
    }
    return { success: false, error: `pkexec ${manager} install failed (exit ${r.code})` }
  }
  return { success: false, error: 'no usable elevation (sudo session unavailable, pkexec missing)' }
}

async function systemInstall() {
  if (process.platform === 'darwin') return macSystemInstall()
  if (process.platform === 'win32') return winSystemInstall()
  if (process.platform === 'linux') return linuxSystemInstall()
  return { success: false, error: `unsupported platform: ${process.platform}` }
}

// ---------------------------------------------------------------------------
// Userspace install — official prebuilt binary, no root. Works under the
// no_new_privs sandbox, without Homebrew, and when the user declines elevation.
// ---------------------------------------------------------------------------

/** Map process.arch/platform to a nodejs.org dist filename triplet, or null. */
function distTriplet() {
  const archMap = { x64: 'x64', arm64: 'arm64', arm: 'armv7l', ppc64: 'ppc64le', s390x: 's390x' }
  const arch = archMap[process.arch]
  if (!arch) return null
  if (process.platform === 'linux') return { os: 'linux', arch, ext: 'tar.gz', zip: false }
  if (process.platform === 'darwin') return { os: 'darwin', arch, ext: 'tar.gz', zip: false }
  if (process.platform === 'win32') return { os: 'win', arch, ext: 'zip', zip: true }
  return null
}

/** Newest LTS version string (e.g. "v24.16.0"); pinned fallback when offline. */
async function latestLtsVersion() {
  try {
    const res = await fetch('https://nodejs.org/dist/index.json', { signal: AbortSignal.timeout(20_000) })
    if (res.ok) {
      const list = await res.json()
      const lts = Array.isArray(list) ? list.find((e) => e && e.lts) : null
      if (lts?.version && /^v\d+\.\d+\.\d+$/.test(lts.version)) return lts.version
    }
  } catch {
    // offline → pinned fallback below
  }
  return FALLBACK_NODE_VERSION
}

async function download(url, dest) {
  // No wall-clock timeout — a slow but progressing tarball download must not be
  // aborted for being slow (only a genuinely failed connection rejects).
  const res = await fetch(url, { redirect: 'follow' })
  if (!res.ok) throw new Error(`download HTTP ${res.status} for ${url}`)
  const buf = Buffer.from(await res.arrayBuffer())
  // Guard against a silently-truncated body (matches the python runtime).
  const expected = Number(res.headers.get('content-length') || 0)
  if (expected && buf.length !== expected) {
    throw new Error(`incomplete download (${buf.length}/${expected} bytes) for ${url}`)
  }
  await writeFile(dest, buf)
}

// Passive integrity: compare a downloaded artifact's sha256 to nodejs.org's
// SHASUMS256.txt. Returns 'verified' | 'mismatch' | 'unverified'. Never throws,
// never blocks — purely informational for the agent.
async function verifyNodeArtifact(version, filename, filePath) {
  try {
    const res = await fetch(`https://nodejs.org/dist/${version}/SHASUMS256.txt`, {
      signal: AbortSignal.timeout(30_000)
    })
    if (!res.ok) return 'unverified'
    const text = await res.text()
    const row = text
      .split('\n')
      .map((l) => l.trim().split(/\s+/))
      .find((parts) => parts[1] === filename)
    if (!row) return 'unverified'
    const expected = row[0].toLowerCase()
    const actual = createHash('sha256').update(await readFile(filePath)).digest('hex').toLowerCase()
    return actual === expected ? 'verified' : 'mismatch'
  } catch {
    return 'unverified'
  }
}

async function userspaceInstall() {
  const triplet = distTriplet()
  if (!triplet) {
    return { success: false, error: `no prebuilt Node for ${process.platform}/${process.arch}` }
  }

  // Stage the download/extract UNDER binBase so the final rename into place
  // is same-filesystem (no EXDEV when /tmp is a separate tmpfs mount).
  let stage
  try {
    const stageRoot = path.join(binBase(), '.staging')
    await mkdir(stageRoot, { recursive: true })
    stage = await mkdtemp(path.join(stageRoot, 'dl-'))

    const version = await latestLtsVersion()
    const base = `node-${version}-${triplet.os}-${triplet.arch}`
    const archivePath = path.join(stage, `${base}.${triplet.ext}`)
    await download(`https://nodejs.org/dist/${version}/${base}.${triplet.ext}`, archivePath)
    const integrity = await verifyNodeArtifact(version, `${base}.${triplet.ext}`, archivePath)
    if (integrity === 'mismatch') {
      console.warn(`[node] sha256 mismatch for ${base}.${triplet.ext} — installing anyway`)
    }

    if (triplet.zip) {
      const ps = `Expand-Archive -LiteralPath '${archivePath.replace(/'/g, "''")}' -DestinationPath '${stage.replace(/'/g, "''")}' -Force`
      const r = await runSpawn('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps])
      if (r.code !== 0) throw new Error(`unzip failed (exit ${r.code}): ${r.stderr.slice(0, 200)}`)
    } else {
      const r = await runSpawn('tar', ['-xzf', archivePath, '-C', stage])
      if (r.code !== 0) throw new Error(`extract failed (exit ${r.code}): ${r.stderr.slice(0, 200)}`)
    }

    const extractedDir = path.join(stage, base)
    if (!(await fileExists(extractedDir))) throw new Error(`extracted directory missing: ${base}`)

    const home = nodeHome()
    await rm(home, { recursive: true, force: true })
    try {
      await rename(extractedDir, home)
    } catch (renameErr) {
      // On Windows, antivirus or leftover file handles from a prior run can
      // transiently lock the target. Wait briefly and retry once.
      if (renameErr?.code === 'EPERM' || renameErr?.code === 'EACCES') {
        await new Promise((r) => setTimeout(r, 1000))
        await rm(home, { recursive: true, force: true })
        await rename(extractedDir, home)
      } else {
        throw renameErr
      }
    }

    ensureLocalOnPath()
    const { stdout } = await execFileP(localNodeBinary(), ['--version'])
    return {
      success: true,
      output: `Node.js ${stdout.trim()} installed without root at ${home} [integrity: ${integrity}]`
    }
  } catch (err) {
    return { success: false, error: `no-root install failed: ${err?.message ?? String(err)}` }
  } finally {
    if (stage) await rm(stage, { recursive: true, force: true }).catch(() => {})
  }
}

async function nodeInstall() {
  // Default policy (uniform with the python capability): reuse a healthy global
  // node (>= floor), else download a no-root managed copy into ~/.wolffish/bin.
  // No package manager, no sudo/UAC. The system-wide install is opt-in below.
  const usable = await resolveUsableNode()
  if (usable) {
    return {
      success: true,
      output: usable.managed
        ? `Using managed Node.js ${usable.version} (no-root, in ~/.wolffish/bin)`
        : `Reusing existing Node.js ${usable.version}`
    }
  }

  const local = await userspaceInstall()
  if (local.success) return local

  return {
    success: false,
    error: `Could not provision Node.js without root: ${local.error}`
  }
}

// Opt-in: install Node.js system-wide via the OS (Homebrew / official MSI+UAC /
// apt|dnf+sudo) so it's visible in the user's own terminal. Only for users who
// explicitly want that. Falls back to the no-root copy if elevation is declined
// or unavailable, so it never leaves the user stuck.
async function nodeInstallSystem() {
  const sys = await systemInstall()
  if (sys.success) return sys

  const local = await userspaceInstall()
  if (local.success) {
    return {
      success: true,
      output: `System install unavailable (${sys.error}); installed a no-root copy instead.\n${local.output}`
    }
  }

  return {
    success: false,
    error: `System install failed: ${sys.error}. No-root fallback: ${local.error}`
  }
}

const toolDefinitions = [
  {
    name: 'node_check',
    description: 'Check if a usable Node.js (version 24+) is available',
    parameters: { type: 'object', properties: {}, required: [] }
  },
  {
    name: 'node_install',
    description:
      'Provision Node.js with no admin rights: reuse an existing Node 24+ if present, otherwise download an official no-root copy into ~/.wolffish/bin. No package manager, no password prompt.',
    parameters: { type: 'object', properties: {}, required: [] }
  },
  {
    name: 'node_install_system',
    description:
      'Optional: install Node.js system-wide via the OS (Homebrew / official MSI / apt|dnf), so it appears in your own terminal. Needs an admin password / UAC prompt. Use only when the user explicitly asks for a global Node; otherwise prefer node_install.',
    parameters: { type: 'object', properties: {}, required: [] }
  }
]

function describeAction(toolName) {
  if (toolName === 'node_check') {
    return {
      title: 'Check Node.js',
      description: 'Detect whether a usable Node.js (24+) is available',
      risk: 'low'
    }
  }
  if (toolName === 'node_install') {
    return {
      title: 'Install Node.js (no root)',
      description: 'Reuse Node 24+ if present, otherwise download an official no-root copy',
      command: 'download node-vXX-<os>-<arch> → ~/.wolffish/bin/node',
      impact:
        'No admin rights, no package manager, no password prompt. Nothing is installed system-wide.',
      risk: 'low'
    }
  }
  if (toolName === 'node_install_system') {
    let command = 'install node system-wide'
    if (process.platform === 'darwin') command = 'brew install node'
    else if (process.platform === 'win32')
      command = 'msiexec /i node-lts.msi  (official Node.js installer, UAC prompt)'
    else command = 'sudo apt/dnf install nodejs'
    return {
      title: 'Install Node.js system-wide',
      description: 'Install Node.js globally via the OS so it shows up in your own terminal',
      command,
      impact:
        'Requires an admin password / UAC prompt. Falls back to a no-root copy if you decline.',
      risk: 'medium'
    }
  }
  return null
}

const plugin = {
  name: 'node',
  tools: toolDefinitions,
  async init(context) {
    sudoCtx = context?.sudo ?? null
    workspaceRoot = context?.workspaceRoot ?? ''
  },
  describeAction,
  async execute(toolName) {
    switch (toolName) {
      case 'node_check':
        return nodeCheck()
      case 'node_install':
        return nodeInstall()
      case 'node_install_system':
        return nodeInstallSystem()
      default:
        return { success: false, error: `node: unknown tool ${toolName}` }
    }
  }
}

export default plugin
