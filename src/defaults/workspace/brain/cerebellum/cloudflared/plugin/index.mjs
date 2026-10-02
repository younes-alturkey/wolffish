import { execFile, spawn } from 'node:child_process'
import { createWriteStream, existsSync } from 'node:fs'
import { chmod, mkdir, rename, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { promisify } from 'node:util'

const execFileP = promisify(execFile)

const MAX_OUTPUT = 50_000
// No-root managed location, sibling of node/ffmpeg/python under ~/.wolffish/bin.
const CLOUDFLARED_DIR = path.join(homedir(), '.wolffish', 'bin', 'cloudflared')
const CLOUDFLARED_RELEASE =
  'https://github.com/cloudflare/cloudflared/releases/latest/download'

async function which(cmd) {
  try {
    const bin = process.platform === 'win32' ? 'where' : 'which'
    const { stdout } = await execFileP(bin, [cmd])
    return stdout.trim().split('\n')[0].trim() || null
  } catch {
    return null
  }
}

function clampOutput(buf, chunk) {
  if (buf.length >= MAX_OUTPUT) return buf
  return buf + chunk.toString().slice(0, MAX_OUTPUT - buf.length)
}

function runProc(cmd, args) {
  return new Promise((resolve) => {
    let child
    try {
      child = spawn(cmd, args, { env: process.env, stdio: ['ignore', 'pipe', 'pipe'] })
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
    child.on('error', (err) => resolve({ code: -1, stdout, stderr: err?.message ?? String(err) }))
    child.on('close', (code) => resolve({ code: code ?? -1, stdout, stderr }))
  })
}

function managedBin() {
  return path.join(CLOUDFLARED_DIR, process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared')
}

// Reuse a global cloudflared, then the managed copy. Returns a path or null.
async function resolveCloudflared() {
  const fromPath = await which('cloudflared')
  if (fromPath) return fromPath
  const managed = managedBin()
  return existsSync(managed) ? managed : null
}

// cloudflared ships a single official binary per OS/arch on GitHub releases.
// macOS is a .tgz (contains the binary); Linux/Windows are raw. There is no
// win-arm64 build, so Windows ARM uses the amd64 .exe under x64 emulation.
function cloudflaredAsset() {
  const arch = process.arch === 'arm64' ? 'arm64' : 'amd64'
  if (process.platform === 'darwin') return { name: `cloudflared-darwin-${arch}.tgz`, archive: 'tgz' }
  if (process.platform === 'win32') return { name: 'cloudflared-windows-amd64.exe', archive: 'raw' }
  return { name: `cloudflared-linux-${arch}`, archive: 'raw' }
}

// Managed (no-root) install: download the official binary into CLOUDFLARED_DIR.
async function downloadManagedCloudflared(signal) {
  await mkdir(CLOUDFLARED_DIR, { recursive: true })
  const { name, archive } = cloudflaredAsset()
  const url = `${CLOUDFLARED_RELEASE}/${name}`
  const dest = managedBin()
  try {
    const res = await fetch(url, { redirect: 'follow', signal })
    if (!res.ok || !res.body) {
      return { success: false, error: `cloudflared download failed: HTTP ${res.status} for ${url}` }
    }
    if (archive === 'tgz') {
      const tmp = path.join(CLOUDFLARED_DIR, 'cloudflared.tgz.part')
      await pipeline(Readable.fromWeb(res.body), createWriteStream(tmp))
      const ex = await runProc('tar', ['-xzf', tmp, '-C', CLOUDFLARED_DIR])
      await rm(tmp, { force: true }).catch(() => {})
      if (ex.code !== 0) {
        return { success: false, error: `cloudflared extract failed: ${ex.stderr.slice(-300)}` }
      }
      await chmod(dest, 0o755).catch(() => {})
    } else {
      const tmp = `${dest}.part`
      await pipeline(Readable.fromWeb(res.body), createWriteStream(tmp))
      if (process.platform !== 'win32') await chmod(tmp, 0o755).catch(() => {})
      await rm(dest, { force: true }).catch(() => {})
      await rename(tmp, dest)
    }
  } catch (err) {
    return { success: false, error: `cloudflared download failed: ${err?.message ?? err}` }
  }
  // A corrupt/partial binary won't run — doubles as the integrity check.
  try {
    await execFileP(dest, ['--version'])
  } catch (err) {
    return { success: false, error: `downloaded cloudflared is not runnable: ${err?.message ?? err}` }
  }
  return { success: true, output: `cloudflared installed (no root) at ${dest}` }
}

async function cloudflaredCheck() {
  const cfPath = await resolveCloudflared()
  if (!cfPath) {
    return { success: true, output: JSON.stringify({ installed: false, version: '' }) }
  }
  try {
    const { stdout } = await execFileP(cfPath, ['--version'])
    const version = stdout.trim().split('\n')[0] || 'unknown'
    return { success: true, output: JSON.stringify({ installed: true, version }) }
  } catch {
    return { success: true, output: JSON.stringify({ installed: true, version: 'unknown' }) }
  }
}

// Default policy (uniform with node/python/ffmpeg): reuse a global/managed
// cloudflared, else download the official no-root binary. No package manager,
// no sudo. System install is opt-in via cloudflared_install_system.
async function cloudflaredInstall(signal) {
  const existing = await resolveCloudflared()
  if (existing) return { success: true, output: `Using existing cloudflared at ${existing}` }
  return downloadManagedCloudflared(signal)
}

// Opt-in: install cloudflared system-wide via the OS. Falls back to the no-root
// copy if the system path is unavailable.
async function cloudflaredInstallSystem(signal) {
  const sys = await cloudflaredSystemInstall()
  if (sys.success) return sys
  const managed = await downloadManagedCloudflared(signal)
  if (managed.success) {
    return {
      success: true,
      output: `System install unavailable (${sys.error}); installed a no-root copy instead.\n${managed.output}`
    }
  }
  return { success: false, error: `System install failed: ${sys.error}. No-root fallback: ${managed.error}` }
}

async function cloudflaredSystemInstall() {
  const platform = process.platform
  let cmd, args

  if (platform === 'darwin') {
    const brewPath = process.arch === 'arm64' ? '/opt/homebrew/bin/brew' : '/usr/local/bin/brew'
    cmd = (await which('brew')) || (existsSync(brewPath) ? brewPath : null)
    if (!cmd) {
      return {
        success: false,
        error: 'Homebrew is not installed. Install it first with pkg_install_manager.'
      }
    }
    args = ['install', 'cloudflared']
  } else if (platform === 'win32') {
    cmd = 'winget'
    args = [
      'install',
      '--id',
      'Cloudflare.cloudflared',
      '-e',
      '--accept-source-agreements',
      '--accept-package-agreements'
    ]
  } else {
    if (await which('apt')) {
      cmd = 'sudo'
      args = ['apt', 'install', '-y', 'cloudflared']
    } else if (await which('dnf')) {
      cmd = 'sudo'
      args = ['dnf', 'install', '-y', 'cloudflared']
    } else {
      return { success: false, error: 'No supported package manager found (apt or dnf).' }
    }
  }

  const r = await runProc(cmd, args)
  const output = (r.stdout + '\n' + r.stderr).trim()
  if (r.code === 0) return { success: true, output: output || 'cloudflared installed successfully' }
  return { success: false, error: `Installation failed (exit ${r.code}): ${output.slice(0, 500)}` }
}

async function cloudflaredTunnel(args) {
  const port = args?.port
  if (!port || typeof port !== 'number') {
    return { success: false, error: 'port is required and must be a number' }
  }

  const cfPath = await resolveCloudflared()
  if (!cfPath) return { success: false, error: 'cloudflared is not installed' }

  return new Promise((resolve) => {
    const child = spawn(cfPath, ['tunnel', '--url', `http://localhost:${port}`], {
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe']
    })

    let stderr = ''
    let resolved = false
    const urlRegex = /https:\/\/[a-zA-Z0-9-]+\.trycloudflare\.com/

    const finish = (result) => {
      if (resolved) return
      resolved = true
      resolve(result)
    }

    child.stderr?.on('data', (chunk) => {
      const text = chunk.toString()
      if (stderr.length < MAX_OUTPUT) {
        stderr += text.slice(0, MAX_OUTPUT - stderr.length)
      }

      const match = urlRegex.exec(text)
      if (match) {
        finish({
          success: true,
          output: JSON.stringify({
            url: match[0],
            port,
            pid: child.pid,
            message: `Tunnel active: ${match[0]} -> http://localhost:${port}`
          })
        })
      }
    })

    child.on('close', (code) => {
      finish({
        success: false,
        error: `cloudflared exited with code ${code}: ${stderr.slice(0, 500)}`
      })
    })

    child.on('error', (err) => {
      finish({ success: false, error: err.message })
    })

    child.unref()
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
    name: 'cloudflared_check',
    description: 'Check if cloudflared is installed',
    parameters: { type: 'object', properties: {}, required: [] }
  },
  {
    name: 'cloudflared_install',
    description:
      'Install cloudflared with no admin rights: reuse a global cloudflared, else download the official no-root binary into ~/.wolffish/bin. No package manager, no password.',
    parameters: { type: 'object', properties: { timeoutMs: TIMEOUT_PARAM }, required: [] }
  },
  {
    name: 'cloudflared_install_system',
    description:
      'Optional: install cloudflared system-wide via the OS (brew / winget / apt|dnf; admin on Linux). Use only when a global install is wanted; otherwise prefer cloudflared_install.',
    parameters: { type: 'object', properties: { timeoutMs: TIMEOUT_PARAM }, required: [] }
  },
  {
    name: 'cloudflared_tunnel',
    description: 'Create a quick tunnel to expose a local port',
    parameters: {
      type: 'object',
      properties: {
        port: { type: 'number', description: 'Local port to expose' }
      },
      required: ['port']
    }
  }
]

function describeAction(toolName, args) {
  if (toolName === 'cloudflared_check') {
    return {
      title: 'Check Cloudflared',
      description: 'Detect whether cloudflared is installed on this machine',
      risk: 'low'
    }
  }
  if (toolName === 'cloudflared_install') {
    return {
      title: 'Install Cloudflared (no root)',
      description: 'Reuse a global cloudflared if present, else download the official no-root binary',
      command: 'download cloudflared → ~/.wolffish/bin/cloudflared',
      impact: 'No admin rights, no package manager, no password prompt.',
      risk: 'low'
    }
  }
  if (toolName === 'cloudflared_install_system') {
    let command = 'install cloudflared system-wide'
    if (process.platform === 'darwin') command = 'brew install cloudflared'
    else if (process.platform === 'win32')
      command = 'winget install --id Cloudflare.cloudflared'
    else command = 'sudo apt/dnf install cloudflared'
    return {
      title: 'Install Cloudflared system-wide',
      description: 'Install the Cloudflare Tunnel CLI globally via the OS package manager',
      command,
      impact: 'Needs admin on Linux. Falls back to a no-root copy if unavailable.',
      risk: 'medium'
    }
  }
  if (toolName === 'cloudflared_tunnel') {
    const port = args?.port
    return {
      title: 'Create Cloudflare Tunnel',
      description: `Expose local port ${port} to the internet via Cloudflare`,
      command: `cloudflared tunnel --url http://localhost:${port}`,
      impact: `Creates a public URL pointing to your local port ${port}. Anyone with the URL can access it.`,
      risk: 'medium'
    }
  }
  return null
}

const plugin = {
  name: 'cloudflared',
  tools: toolDefinitions,
  describeAction,
  async execute(toolName, args, signal) {
    const sig = combineSignal(signal, args?.timeoutMs)
    switch (toolName) {
      case 'cloudflared_check':
        return cloudflaredCheck()
      case 'cloudflared_install':
        return cloudflaredInstall(sig)
      case 'cloudflared_install_system':
        return cloudflaredInstallSystem(sig)
      case 'cloudflared_tunnel':
        return cloudflaredTunnel(args)
      default:
        return { success: false, error: `cloudflared: unknown tool ${toolName}` }
    }
  }
}

export default plugin
