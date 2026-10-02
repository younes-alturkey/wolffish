import { execFile, spawn } from 'node:child_process'
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

const execFileP = promisify(execFile)

const UNSAFE_CHARS = /[;|&$`\n\r]/
const MAX_OUTPUT = 50_000

const HOMEBREW_INSTALL_CMD =
  '/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"'

// Injected at plugin init by the main process. When present (macOS), the
// Homebrew install routes through the shared, app-lifetime password session so
// the user reuses the one password they already entered for shell commands.
let sudoCtx = null

function validatePackageName(name) {
  if (!name || typeof name !== 'string') return false
  return !UNSAFE_CHARS.test(name)
}

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

    child.on('close', (code) => {
      resolve({ code: code ?? -1, stdout, stderr })
    })

    child.on('error', (err) => {
      resolve({ code: -1, stdout, stderr: stderr + '\n' + (err?.message ?? String(err)) })
    })
  })
}

/**
 * Prime sudo's credential cache on macOS using a SUDO_ASKPASS helper that
 * pops the native macOS password dialog via osascript.
 *
 * Why this dance instead of `osascript ... with administrator privileges`?
 * That AppleScript flag runs the entire command as root (uid 0). Homebrew
 * detects euid=0 and refuses with "Don't run this as root!" — by design,
 * brew's prefix is meant to be owned by the regular user.
 *
 * The fix: we authenticate the user's sudo session ONCE (via `sudo -A -v`),
 * which writes to /var/db/sudo/{user} for the next ~5 minutes. Then we
 * spawn the brew installer as the regular user. When brew's installer
 * calls `sudo` internally for the privileged steps (creating /opt/homebrew,
 * chowning), sudo finds the cached timestamp and runs without re-prompting.
 *
 * The askpass helper script writes the password directly from osascript's
 * stdout to sudo's stdin via subprocess pipes — the password never enters
 * Node's heap.
 *
 * Returns { ok: boolean, askpassPath?: string, error?: string, cancelled?: boolean }.
 * On success, the caller MUST keep `askpassPath` set in env (SUDO_ASKPASS)
 * for any subsequent sudo invocations and clean it up when done.
 */
async function primeSudoMacOS(dialogMessage) {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'wolffish-askpass-'))
  const askpassPath = path.join(tmpDir, 'askpass.sh')
  const message = (dialogMessage || 'Wolffish needs admin access to install Homebrew.').replace(
    /"/g,
    '\\"'
  )
  // Strict-mode bash; if osascript fails (user clicked Cancel → exit 1),
  // exit 1 ourselves. sudo treats a non-zero askpass as user cancellation
  // and bails immediately without retrying — which is exactly what we want.
  const script = `#!/bin/bash
set -e
osascript \\
  -e 'tell application "System Events" to activate' \\
  -e 'display dialog "${message}" default answer "" with hidden answer with title "Wolffish" buttons {"Cancel", "Authorize"} default button "Authorize"' \\
  -e 'text returned of result' 2>/dev/null
`

  try {
    await writeFile(askpassPath, script, 'utf8')
    await chmod(askpassPath, 0o700)
  } catch (err) {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {})
    return { ok: false, error: `failed to create askpass helper: ${err?.message ?? String(err)}` }
  }

  const env = { ...process.env, SUDO_ASKPASS: askpassPath }
  // `sudo -A -v` validates and refreshes the timestamp without running any
  // command. -A forces askpass even when a TTY is technically available,
  // so we always get the GUI dialog.
  const auth = await runSpawn('sudo', ['-A', '-v'], env)

  if (auth.code !== 0) {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {})
    // Empty output + non-zero exit = user clicked Cancel. Sudo also
    // returns non-zero when the password is wrong, but askpass exits 1
    // on Cancel before sudo can retry, so non-zero here always means
    // either cancellation or genuinely failed auth.
    return { ok: false, cancelled: true, askpassPath: null, tmpDir }
  }

  return { ok: true, askpassPath, tmpDir, env }
}

async function cleanupAskpass(tmpDir) {
  if (!tmpDir) return
  await rm(tmpDir, { recursive: true, force: true }).catch(() => {})
}

async function pkgCheck() {
  const platform = process.platform

  if (platform === 'darwin') {
    const brewPaths = ['/opt/homebrew/bin/brew', '/usr/local/bin/brew']
    for (const p of brewPaths) {
      try {
        await execFileP(p, ['--version'])
        return {
          success: true,
          output: JSON.stringify({ installed: true, manager: 'brew', platform, path: p })
        }
      } catch {
        /* try next */
      }
    }
    const found = await which('brew')
    if (found) {
      return {
        success: true,
        output: JSON.stringify({ installed: true, manager: 'brew', platform, path: found })
      }
    }
    return {
      success: true,
      output: JSON.stringify({ installed: false, manager: 'none', platform, path: '' })
    }
  }

  if (platform === 'win32') {
    const found = await which('winget')
    if (found) {
      return {
        success: true,
        output: JSON.stringify({ installed: true, manager: 'winget', platform, path: found })
      }
    }
    return {
      success: true,
      output: JSON.stringify({ installed: false, manager: 'none', platform, path: '' })
    }
  }

  if (platform === 'linux') {
    for (const mgr of ['apt', 'dnf']) {
      const found = await which(mgr)
      if (found) {
        return {
          success: true,
          output: JSON.stringify({ installed: true, manager: mgr, platform, path: found })
        }
      }
    }
    return {
      success: true,
      output: JSON.stringify({ installed: false, manager: 'none', platform, path: '' })
    }
  }

  return {
    success: true,
    output: JSON.stringify({ installed: false, manager: 'none', platform, path: '' })
  }
}

async function pkgInstallManager() {
  const platform = process.platform

  if (platform === 'win32') {
    return {
      success: true,
      output: JSON.stringify({
        success: true,
        message: 'winget is pre-installed on Windows',
        manager: 'winget'
      })
    }
  }

  if (platform === 'linux') {
    return {
      success: true,
      output: JSON.stringify({
        success: true,
        message: 'apt/dnf is pre-installed on this Linux distribution',
        manager: 'apt'
      })
    }
  }

  if (platform !== 'darwin') {
    return { success: false, error: `Unsupported platform: ${platform}` }
  }

  // macOS: install Homebrew. We need sudo primed so brew's internal sudo
  // calls (mkdir /opt/homebrew, chown, etc.) succeed without a TTY. The brew
  // installer itself runs as the normal user — running it as root via
  // `osascript ... with administrator privileges` makes brew refuse with
  // "Don't run this as root!".
  let elevatedEnv
  let cleanup = async () => {}

  // Preferred: shared in-memory password session. Prompts once per app run,
  // reuses the password already entered for shell commands, and holds it in
  // main-process memory (never on disk). Its helper is session-scoped, so
  // there's nothing to clean up. Falls through to the legacy primeSudoMacOS
  // helper when the session is absent OR reports it couldn't attempt
  // (auth.unsupported) — same defensive contract as the shell plugin.
  if (sudoCtx) {
    const auth = await sudoCtx.ensurePassword('installHomebrew')
    if (auth.ok) {
      elevatedEnv = { ...process.env, ...sudoCtx.getElevatedEnv() }
    } else if (auth.cancelled) {
      return {
        success: false,
        error:
          'Homebrew installation requires admin access. You cancelled the password prompt. To install manually, open Terminal and run: ' +
          HOMEBREW_INSTALL_CMD
      }
    } else if (!auth.unsupported) {
      return { success: false, error: auth.error ?? 'sudo authentication failed' }
    }
    // auth.unsupported → fall through to primeSudoMacOS below
  }

  if (!elevatedEnv) {
    // Fallback: legacy per-install askpass helper whose password is piped
    // straight from osascript to sudo and never cached.
    const prime = await primeSudoMacOS(
      'Wolffish needs admin access to install Homebrew on your Mac.'
    )
    if (!prime.ok) {
      await cleanupAskpass(prime.tmpDir)
      if (prime.cancelled) {
        return {
          success: false,
          error:
            'Homebrew installation requires admin access. You cancelled the password prompt. To install manually, open Terminal and run: ' +
            HOMEBREW_INSTALL_CMD
        }
      }
      return {
        success: false,
        error: prime.error ?? 'sudo authentication failed'
      }
    }
    elevatedEnv = prime.env
    cleanup = () => cleanupAskpass(prime.tmpDir)
  }

  try {
    // Run the official Homebrew installer as the normal user.
    // NONINTERACTIVE=1 skips brew's TTY check; SUDO_ASKPASS is set so any
    // additional sudo prompts use the helper instead of the missing tty. The
    // primed credential (cached password or timestamp) keeps it silent.
    const env = {
      ...elevatedEnv,
      NONINTERACTIVE: '1'
    }
    const install = await runSpawn(
      '/bin/bash',
      [
        '-c',
        'curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh | /bin/bash'
      ],
      env
    )
    const combined = (install.stdout + '\n' + install.stderr).trim()
    if (install.code !== 0) {
      return {
        success: false,
        error: `Homebrew installation failed (exit ${install.code}): ${combined.slice(0, 500)}`
      }
    }

    const brewPath = process.arch === 'arm64' ? '/opt/homebrew/bin/brew' : '/usr/local/bin/brew'
    try {
      const { stdout: version } = await execFileP(brewPath, ['--version'])
      return {
        success: true,
        output: JSON.stringify({
          success: true,
          message: `Homebrew installed: ${version.trim().split('\n')[0]}`,
          manager: 'brew',
          path: brewPath
        })
      }
    } catch {
      return {
        success: false,
        error: `Homebrew install completed but brew not found at ${brewPath}`
      }
    }
  } finally {
    await cleanup()
  }
}

async function detectManager() {
  const raw = (await pkgCheck()).output
  return JSON.parse(raw)
}

function formatInstallResult(success, output, command, error) {
  const summary = JSON.stringify({ success, output: output.slice(0, MAX_OUTPUT), command })
  if (success) return { success: true, output: summary }
  if (error) return { success: false, error, output: summary }
  return {
    success: false,
    error: `Installation failed: ${output.slice(0, 500)}`,
    output: summary
  }
}

async function installViaBrew(name, brewPath) {
  // brew install runs entirely as the normal user. The brew prefix
  // (/opt/homebrew or /usr/local) is owned by whoever installed brew, so
  // no sudo is needed. Running brew as root is explicitly forbidden by
  // the installer and would fail.
  const cmd = brewPath || 'brew'
  const result = await runSpawn(cmd, ['install', name])
  const output = (result.stdout + '\n' + result.stderr).trim()
  const command = `${cmd} install ${name}`
  if (result.code === 0) return formatInstallResult(true, output, command)
  return formatInstallResult(false, output, command)
}

async function installViaWinget(id) {
  // winget install handles its own UAC prompt when needed. If the package
  // requires elevation, Windows pops the UAC dialog automatically.
  const result = await runSpawn('winget', [
    'install',
    '--id',
    id,
    '-e',
    '--accept-source-agreements',
    '--accept-package-agreements'
  ])
  const output = (result.stdout + '\n' + result.stderr).trim()
  const command = `winget install --id ${id} -e --accept-source-agreements --accept-package-agreements`
  if (result.code === 0) {
    // Newly-installed CLIs land in directories that winget appends to the
    // *persistent* PATH (registry: HKLM\...\Environment and HKCU\Environment),
    // but the currently-running Electron process keeps its launch-time PATH.
    // Without a refresh, the very next call to the freshly installed binary
    // (e.g. cloudflared after `winget install Cloudflare.cloudflared`) fails
    // with "not recognized" — invisible to us until the user restarts the app.
    // Refreshing here makes the install effectively atomic from the model's
    // perspective. Best-effort: a refresh failure never blocks the success.
    await refreshWindowsPath()
    return formatInstallResult(true, output, command)
  }
  return formatInstallResult(false, output, command)
}

/**
 * Re-read the persistent PATH from the Windows registry (machine + user
 * scopes) and update process.env.PATH so subsequent spawns see binaries
 * installed during this session. No-op on non-Windows.
 *
 * Uses PowerShell's [Environment]::GetEnvironmentVariable rather than
 * shelling out to reg.exe because PowerShell returns the unexpanded form
 * pre-joined and is universally available since Windows 7. Falls back
 * silently if PowerShell isn't on PATH (extremely rare) — the worst case
 * is the original stale-PATH behavior we already had.
 */
async function refreshWindowsPath() {
  if (process.platform !== 'win32') return
  try {
    // Read both scopes and emit them on separate lines so we don't have
    // to depend on PS-version-specific join cmdlets (`Join-String` is
    // PowerShell 7+ only — Windows PowerShell 5.1 lacks it). Node joins
    // the two halves itself. Empty / unset scopes show up as blank
    // lines, which we filter below.
    const script =
      "[Environment]::GetEnvironmentVariable('PATH','Machine');" +
      "[Environment]::GetEnvironmentVariable('PATH','User')"
    const { stdout } = await execFileP(
      'powershell',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      { timeout: 5_000, windowsHide: true }
    )
    // Merge, don't replace. The current process.env.PATH may contain
    // session-only entries that aren't in the registry (Electron startup
    // additions, things Wolffish or its plugins set at boot, prior
    // in-session installs). Overwriting wipes them. Instead we treat the
    // registry read as a source of *additional* entries to append.
    //
    // Comparison is case-insensitive (Windows filesystem semantics) and
    // ignores trailing slashes so "C:\Foo" and "C:\Foo\" don't get added
    // as two distinct entries.
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
      const key = entry.toLowerCase()
      if (seen.has(key)) continue
      seen.add(key)
      current.push(entry)
      mutated = true
    }
    if (mutated) process.env.PATH = current.join(';')
  } catch {
    // Best-effort. If the refresh fails the install still succeeded;
    // worst case the user restarts the app to pick up the new binary.
  }
}

async function installViaLinuxRoot(manager, name) {
  // apt/dnf install must run as root. Use pkexec for the GUI Polkit
  // prompt; fall back to a clear error if pkexec isn't installed.
  const pkexecPath = await which('pkexec')
  const command = `sudo ${manager} install -y ${name}`
  if (!pkexecPath) {
    return {
      success: false,
      error: `Installation requires admin access but pkexec is not installed. Run manually: ${command}`
    }
  }
  const result = await runSpawn(pkexecPath, [manager, 'install', '-y', name])
  const output = (result.stdout + '\n' + result.stderr).trim()
  if (result.code === 0) return formatInstallResult(true, output, command)
  // pkexec exit 126 = user dismissed prompt, 127 = auth failed
  if (result.code === 126 || result.code === 127) {
    return {
      success: false,
      error: `Installation cancelled — you dismissed the password prompt. Re-run when ready, or install manually: ${command}`
    }
  }
  return formatInstallResult(false, output, command)
}

async function pkgInstall(args) {
  const packageName = String(args?.package_name ?? '').trim()
  if (!packageName) return { success: false, error: 'package_name is required' }

  const mgr = await detectManager()
  if (!mgr.installed) {
    return {
      success: false,
      error: 'No package manager available. Install one first with pkg_install_manager.'
    }
  }

  let resolvedName = packageName
  switch (mgr.manager) {
    case 'brew':
      resolvedName = String(args?.brew_name ?? packageName)
      break
    case 'winget':
      resolvedName = String(args?.winget_id ?? packageName)
      break
    case 'apt':
      resolvedName = String(args?.apt_name ?? packageName)
      break
    case 'dnf':
      resolvedName = String(args?.dnf_name ?? packageName)
      break
    default:
      return { success: false, error: `Unsupported package manager: ${mgr.manager}` }
  }

  if (!validatePackageName(resolvedName)) {
    return { success: false, error: `Invalid package name: "${resolvedName}"` }
  }

  switch (mgr.manager) {
    case 'brew':
      return installViaBrew(resolvedName, mgr.path)
    case 'winget':
      return installViaWinget(resolvedName)
    case 'apt':
    case 'dnf':
      return installViaLinuxRoot(mgr.manager, resolvedName)
    default:
      return { success: false, error: `Unsupported package manager: ${mgr.manager}` }
  }
}

const toolDefinitions = [
  {
    name: 'pkg_check',
    description: 'Check if a system package manager is available and which one',
    parameters: { type: 'object', properties: {}, required: [] }
  },
  {
    name: 'pkg_install_manager',
    description:
      'Install the system package manager if missing (Homebrew on macOS). No-op on Windows and Linux.',
    parameters: { type: 'object', properties: {}, required: [] }
  },
  {
    name: 'pkg_install',
    description: 'Install a package using the system package manager',
    parameters: {
      type: 'object',
      properties: {
        package_name: { type: 'string', description: 'Generic package name' },
        brew_name: { type: 'string', description: 'Override for Homebrew' },
        winget_id: { type: 'string', description: 'Override for winget (e.g. Gyan.FFmpeg)' },
        apt_name: { type: 'string', description: 'Override for apt' },
        dnf_name: { type: 'string', description: 'Override for dnf' }
      },
      required: ['package_name']
    }
  }
]

function describeAction(toolName, args) {
  if (toolName === 'pkg_check') {
    return {
      title: 'Detect package manager',
      description: 'Check which system package manager is available on this machine',
      risk: 'low'
    }
  }

  if (toolName === 'pkg_install_manager') {
    if (process.platform === 'darwin') {
      return {
        title: 'Install Homebrew',
        description: 'Download and install the Homebrew package manager for macOS',
        command: HOMEBREW_INSTALL_CMD,
        impact:
          'Installs Homebrew to /opt/homebrew (Apple Silicon) or /usr/local (Intel). One-time setup, requires admin password.',
        risk: 'medium'
      }
    }
    return {
      title: 'Verify package manager',
      description: 'Confirm the system package manager is available (no-op on this platform)',
      risk: 'low'
    }
  }

  if (toolName === 'pkg_install') {
    const platform = process.platform
    const packageName = String(args?.package_name ?? 'package')
    const brewName = String(args?.brew_name ?? packageName)
    const wingetId = String(args?.winget_id ?? packageName)
    const aptName = String(args?.apt_name ?? packageName)
    const dnfName = String(args?.dnf_name ?? packageName)

    let command
    if (platform === 'darwin') command = `brew install ${brewName}`
    else if (platform === 'win32')
      command = `winget install --id ${wingetId} -e --accept-source-agreements --accept-package-agreements`
    else if (platform === 'linux')
      command = `apt install -y ${aptName} (or dnf install -y ${dnfName})`
    else command = `install ${packageName}`

    return {
      title: `Install ${packageName}`,
      description: `Install ${packageName} using the system package manager`,
      command,
      impact: 'Downloads and installs the package. May require admin access on some systems.',
      risk: 'low'
    }
  }

  return null
}

const plugin = {
  name: 'package-manager',
  tools: toolDefinitions,
  async init(context) {
    sudoCtx = context?.sudo ?? null
  },
  describeAction,
  async execute(toolName, args) {
    switch (toolName) {
      case 'pkg_check':
        return pkgCheck()
      case 'pkg_install_manager':
        return pkgInstallManager()
      case 'pkg_install':
        return pkgInstall(args)
      default:
        return { success: false, error: `package-manager: unknown tool ${toolName}` }
    }
  }
}

export default plugin
