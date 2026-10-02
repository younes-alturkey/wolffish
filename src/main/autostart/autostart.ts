/**
 * Cross-platform "start Wolffish when the machine comes up".
 *
 * Electron's own `app.setLoginItemSettings` is `@platform darwin,win32` — it
 * has never been implemented on Linux (electron/electron#15198), so the app
 * shipped a toggle that silently did nothing there and a status reader that
 * could only ever answer "inactive". This module owns the whole question
 * instead, and reports what is ACTUALLY registered rather than what was asked
 * for, so the UI (and `wolffish service status`) can show the difference.
 *
 * Two axes decide the mechanism: the platform, and whether this install runs
 * with a desktop (`gui`) or as a service (`headless`).
 *
 *   macOS   gui       login item (Electron)
 *   macOS   headless  launchd LaunchAgent, RunAtLoad + KeepAlive
 *   Windows gui       login item (Electron)
 *   Windows headless  Task Scheduler, ONLOGON
 *   Linux   gui       XDG autostart .desktop — what every other Electron app
 *                     hand-rolls, because Electron won't
 *   Linux   headless  systemd USER unit + lingering
 *
 * The Linux headless case is the one with a trap in it. A systemd *user* unit
 * only runs while that user has a session, so without `loginctl enable-linger`
 * the agent starts on SSH login and dies on SSH logout — precisely the
 * always-on promise a VPS install is making. `enable-linger` is therefore not
 * an optimization here; a unit installed without it is reported as a WARNING
 * state, not a healthy one.
 */
import { appImageLaunchEnv, stableExecPath } from '@main/autostart/appimage'
import { wlog } from '@main/workspace/logger'
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)

const TAG = '[autostart]'

/**
 * Write the unit/plist/entry but never talk to the live service manager.
 *
 * This exists because a test that fakes `os.homedir()` does NOT fake
 * `launchctl`, `systemctl` or `schtasks` — those address the real user domain
 * whatever path you hand them. A platform test wrote a plist into a temp HOME
 * and then bootstrapped it for real, leaving a `KeepAlive: true` agent that
 * relaunched the installed app every time it was quit, and outlived the temp
 * file so nothing on disk explained it. Faking the filesystem is not enough;
 * the shell-outs need their own gate.
 */
const DRY_RUN = process.env.WOLFFISH_AUTOSTART_DRY_RUN === '1'

/** Run a service-manager command, unless this process is in dry-run. */
async function serviceCall(bin: string, args: string[]): Promise<void> {
  if (DRY_RUN) return
  await run(bin, args)
}

/** Whether this install is driven by a window or by a service manager. */
export type AutostartMode = 'gui' | 'headless'

export type AutostartMechanism =
  | 'loginItem'
  | 'launchd'
  | 'schtasks'
  | 'xdg'
  | 'systemd'
  | 'unsupported'

export type AutostartStatus = {
  /** Registered and expected to actually fire. */
  active: boolean
  mechanism: AutostartMechanism
  /** Where the registration lives, for the panel + `wolffish service status`. */
  location: string | null
  /**
   * Registered but NOT going to behave as promised — today only one case:
   * a systemd user unit without lingering, which dies with the SSH session.
   * Rendered as a warning rather than a silent success.
   */
  warning: string | null
}

const IDENTIFIER = 'sh.wolffi.app'
const UNIT_NAME = 'wolffish.service'
const TASK_NAME = 'Wolffish'
const DESKTOP_FILE = 'wolffish.desktop'

/**
 * True when this Linux box has no graphical session to autostart INTO. XDG
 * autostart files are read by a desktop session manager; on a server there
 * isn't one, so a .desktop file there is a file nobody will ever open.
 */
export function isHeadlessHost(): boolean {
  if (process.platform !== 'linux') return false
  return !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY
}

/**
 * `--no-sandbox` on the COMMAND LINE, not just the `app.commandLine` switch main
 * already appends.
 *
 * Chromium refuses to start as root with the sandbox enabled — it aborts with
 * `FATAL: Running as root without --no-sandbox is not supported` from
 * PreSandboxStartup, which runs long before a line of the app's JavaScript is
 * evaluated. So appending the switch from main is too late to be seen by the
 * one check that most needs it, and the app is unlaunchable for the user a VPS
 * hands you by default: root. It changes nothing else — this app already runs
 * fully unsandboxed on purpose (see the `no-sandbox` block in main), so putting
 * the same decision in argv only moves it early enough to count.
 */
const NO_SANDBOX = '--no-sandbox'

/** The command a service manager should run. Quoted by each writer as needed. */
function serviceCommand(execPath: string): { bin: string; args: string[] } {
  return { bin: execPath, args: ['--headless', NO_SANDBOX] }
}

// ─── Linux: systemd user unit ───────────────────────────────────────────────

function systemdUnitPath(): string {
  return path.join(os.homedir(), '.config', 'systemd', 'user', UNIT_NAME)
}

function systemdUnitBody(execPath: string): string {
  const { bin, args } = serviceCommand(execPath)
  // An AppImage that can only run by unpacking itself has to say so here too.
  // systemd reads this file at boot with none of the environment the install
  // ran in, so without the line the unit enables cleanly, reports healthy, and
  // fails to mount on every single start — the exact shape of failure this
  // whole module exists to stop.
  const launchEnv = appImageLaunchEnv()
  return `[Unit]
Description=Wolffish
Documentation=https://wolffi.sh
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=${bin} ${args.join(' ')}
Restart=always
RestartSec=5
# The agent shells out constantly; give it the user's real environment.
Environment=WOLFFISH_HEADLESS=1
# Electron is Chromium, and Chromium wants a display at startup even when
# nothing is ever drawn. A systemd user unit has no session and no DISPLAY, so
# this is what keeps the boot from aborting on a server. Main reads the same
# signal and switches Ozone to its headless platform; this is the belt to that
# braces, for a build that predates it or an ELECTRON_OZONE override in the
# environment.
Environment=ELECTRON_OZONE_PLATFORM_HINT=headless
${launchEnv ? `Environment=${launchEnv}\n` : ''}
[Install]
WantedBy=default.target
`
}

/**
 * True when this user lingers — i.e. their systemd user manager is started at
 * boot and kept alive after logout. Without it a user unit is session-scoped.
 */
async function hasLinger(): Promise<boolean> {
  // The state file is the authoritative record and needs no loginctl at all,
  // which matters on minimal images where systemd is present but loginctl
  // is not on PATH for a non-root user.
  if (existsSync(path.join('/var/lib/systemd/linger', os.userInfo().username))) return true
  if (DRY_RUN) return false
  try {
    const { stdout } = await run('loginctl', ['show-user', os.userInfo().username, '-p', 'Linger'])
    return /Linger=yes/i.test(stdout)
  } catch {
    return false
  }
}

async function systemctlUser(...args: string[]): Promise<void> {
  await serviceCall('systemctl', ['--user', ...args])
}

async function installSystemd(execPath: string): Promise<AutostartStatus> {
  const unitPath = systemdUnitPath()
  await fs.mkdir(path.dirname(unitPath), { recursive: true })
  await fs.writeFile(unitPath, systemdUnitBody(execPath), 'utf8')
  await systemctlUser('daemon-reload')
  await systemctlUser('enable', UNIT_NAME)
  // Lingering is best-effort: on most distros a user may enable their own,
  // and where policy refuses, the unit still works for the session and the
  // status below says plainly that it won't survive logout.
  try {
    await serviceCall('loginctl', ['enable-linger', os.userInfo().username])
  } catch (err) {
    wlog.warn(TAG, `enable-linger failed: ${err instanceof Error ? err.message : String(err)}`)
  }
  return systemdStatus()
}

async function uninstallSystemd(): Promise<AutostartStatus> {
  const unitPath = systemdUnitPath()
  try {
    await systemctlUser('disable', '--now', UNIT_NAME)
  } catch {
    // not enabled / no systemd — the file removal below is what matters
  }
  await fs.rm(unitPath, { force: true })
  try {
    await systemctlUser('daemon-reload')
  } catch {
    // nothing to reload
  }
  return systemdStatus()
}

async function systemdStatus(): Promise<AutostartStatus> {
  const unitPath = systemdUnitPath()
  const present = existsSync(unitPath)
  if (!present) {
    return { active: false, mechanism: 'systemd', location: unitPath, warning: null }
  }
  let enabled = false
  try {
    await systemctlUser('is-enabled', UNIT_NAME)
    enabled = true
  } catch {
    enabled = false
  }
  const linger = await hasLinger()
  return {
    active: enabled && linger,
    mechanism: 'systemd',
    location: unitPath,
    warning: !enabled
      ? 'The unit is installed but not enabled — run: systemctl --user enable wolffish.service'
      : linger
        ? null
        : `Lingering is off, so Wolffish stops when this user logs out and does not start at boot. Run: loginctl enable-linger ${os.userInfo().username}`
  }
}

// ─── Linux: XDG autostart .desktop ──────────────────────────────────────────

function xdgPath(): string {
  const base = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config')
  return path.join(base, 'autostart', DESKTOP_FILE)
}

async function installXdg(execPath: string): Promise<AutostartStatus> {
  const file = xdgPath()
  await fs.mkdir(path.dirname(file), { recursive: true })
  // `Exec=` is a command line, not a shell line, so a NAME=VALUE prefix would be
  // read as the program to run. `env` is the portable way to say the same thing
  // to a session manager. Absent unless this app is itself running unpacked.
  const launchEnv = appImageLaunchEnv()
  const prefix = launchEnv ? `env ${launchEnv} ` : ''
  const body = `[Desktop Entry]
Type=Application
Version=1.0
Name=Wolffish
Comment=Personal AI agent that runs locally with full system access
Exec=${prefix}"${execPath}" ${NO_SANDBOX}
Icon=wolffish
Terminal=false
X-GNOME-Autostart-enabled=true
`
  await fs.writeFile(file, body, 'utf8')
  // Some session managers skip entries without the exec bit; the spec doesn't
  // require it but honoring it costs nothing and fixes those.
  await fs.chmod(file, 0o755).catch(() => undefined)
  return xdgStatus()
}

async function uninstallXdg(): Promise<AutostartStatus> {
  await fs.rm(xdgPath(), { force: true })
  return xdgStatus()
}

async function xdgStatus(): Promise<AutostartStatus> {
  const file = xdgPath()
  return {
    active: existsSync(file),
    mechanism: 'xdg',
    location: file,
    warning: null
  }
}

// ─── macOS: launchd LaunchAgent ─────────────────────────────────────────────

function launchAgentPath(): string {
  return path.join(os.homedir(), 'Library', 'LaunchAgents', `${IDENTIFIER}.plist`)
}

function plistBody(execPath: string): string {
  const { bin, args } = serviceCommand(execPath)
  const argXml = [bin, ...args].map((a) => `    <string>${a}</string>`).join('\n')
  const logDir = path.join(os.homedir(), '.wolffish', 'logs')
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${IDENTIFIER}</string>
  <key>ProgramArguments</key>
  <array>
${argXml}
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${path.join(logDir, 'launchd.out.log')}</string>
  <key>StandardErrorPath</key>
  <string>${path.join(logDir, 'launchd.err.log')}</string>
</dict>
</plist>
`
}

async function installLaunchd(execPath: string): Promise<AutostartStatus> {
  const file = launchAgentPath()
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.mkdir(path.join(os.homedir(), '.wolffish', 'logs'), { recursive: true })
  await fs.writeFile(file, plistBody(execPath), 'utf8')
  // bootstrap is the modern verb; `load` covers older systems. Either failing
  // is fine — the plist alone makes it load at the next login.
  const uid = String(process.getuid?.() ?? 501)
  await serviceCall('launchctl', ['bootstrap', `gui/${uid}`, file]).catch(() =>
    serviceCall('launchctl', ['load', '-w', file]).catch(() => undefined)
  )
  return launchdStatus()
}

async function uninstallLaunchd(): Promise<AutostartStatus> {
  const file = launchAgentPath()
  const uid = String(process.getuid?.() ?? 501)
  await serviceCall('launchctl', ['bootout', `gui/${uid}/${IDENTIFIER}`]).catch(() =>
    serviceCall('launchctl', ['unload', '-w', file]).catch(() => undefined)
  )
  await fs.rm(file, { force: true })
  return launchdStatus()
}

/**
 * Whether launchd has the job LOADED — not merely whether a plist exists.
 *
 * The two come apart in both directions, and each is a lie worth avoiding: a
 * plist written while `bootstrap` failed is a file that will do nothing until
 * the next login, and a job bootstrapped from a plist that was later deleted
 * stays loaded with nothing on disk to explain it. That second case is exactly
 * what a leaked test agent looked like — the app relaunching after every quit
 * while `~/Library/LaunchAgents` was empty.
 *
 * `launchctl print` is the authority. The file is the fallback for when
 * launchctl is unavailable, and under dry-run it is the only answer, since
 * asking launchctl there would report on the real machine rather than the
 * temporary one under test.
 */
async function launchdStatus(): Promise<AutostartStatus> {
  const file = launchAgentPath()
  const present = existsSync(file)
  if (DRY_RUN) {
    return { active: present, mechanism: 'launchd', location: file, warning: null }
  }

  const uid = String(process.getuid?.() ?? 501)
  let loaded: boolean | null = null
  try {
    await run('launchctl', ['print', `gui/${uid}/${IDENTIFIER}`])
    loaded = true
  } catch {
    // Non-zero exit means "no such service" for `print`. It can also mean
    // launchctl is missing entirely, which is indistinguishable here — hence
    // the file fallback below rather than a hard "inactive".
    loaded = false
  }

  if (loaded && !present) {
    return {
      active: true,
      mechanism: 'launchd',
      location: file,
      warning: `launchd is running ${IDENTIFIER} but its plist is gone, so nothing on disk explains it. Remove it with: launchctl bootout gui/${uid}/${IDENTIFIER}`
    }
  }
  if (present && !loaded) {
    return {
      active: false,
      mechanism: 'launchd',
      location: file,
      warning: 'The agent is written but not loaded — it will start at the next login.'
    }
  }
  return { active: loaded === true, mechanism: 'launchd', location: file, warning: null }
}

// ─── Windows: Task Scheduler ────────────────────────────────────────────────

async function installSchtasks(execPath: string): Promise<AutostartStatus> {
  const { bin, args } = serviceCommand(execPath)
  // ONLOGON needs no elevation. ONSTART (before login) does, and asking for
  // it silently would fail on a normal account — a headless Windows box is
  // rare enough that the documented `schtasks /sc onstart` upgrade is a
  // better answer than a UAC prompt nobody expected.
  await serviceCall('schtasks', [
    '/create',
    '/f',
    '/tn',
    TASK_NAME,
    '/tr',
    `"${bin}" ${args.join(' ')}`,
    '/sc',
    'onlogon',
    '/rl',
    'limited'
  ])
  return schtasksStatus()
}

async function uninstallSchtasks(): Promise<AutostartStatus> {
  await serviceCall('schtasks', ['/delete', '/f', '/tn', TASK_NAME]).catch(() => undefined)
  return schtasksStatus()
}

async function schtasksStatus(): Promise<AutostartStatus> {
  try {
    if (DRY_RUN) throw new Error('dry-run')
    await run('schtasks', ['/query', '/tn', TASK_NAME])
    return {
      active: true,
      mechanism: 'schtasks',
      location: `Task Scheduler \\${TASK_NAME}`,
      warning: null
    }
  } catch {
    return {
      active: false,
      mechanism: 'schtasks',
      location: `Task Scheduler \\${TASK_NAME}`,
      warning: null
    }
  }
}

// ─── Dispatch ───────────────────────────────────────────────────────────────

/**
 * Which mechanism THIS machine should use, decided by the user's DECLARED run
 * mode alone.
 *
 * The display probe is deliberately not consulted here. It looked like a
 * helpful override — a gui install on a box with no screen is headless in
 * practice — but DISPLAY is a property of the ENVIRONMENT THIS PROCESS
 * INHERITED, not of the machine: a desktop app relaunched by systemd, by a
 * cron job, or from a bare SSH shell has no DISPLAY and would have silently
 * switched mechanisms mid-life, uninstalling the registration it wrote last
 * time and installing a different one. `isHeadlessHost()` stays exported as
 * advice for the panel's "you probably want the service" hint, where being
 * wrong costs nothing.
 */
function mechanismFor(mode: AutostartMode): AutostartMechanism {
  if (process.platform === 'linux') {
    return mode === 'headless' ? 'systemd' : 'xdg'
  }
  if (mode === 'headless') {
    if (process.platform === 'darwin') return 'launchd'
    if (process.platform === 'win32') return 'schtasks'
    return 'unsupported'
  }
  if (process.platform === 'darwin' || process.platform === 'win32') return 'loginItem'
  return 'unsupported'
}

export function autostartMechanism(mode: AutostartMode): AutostartMechanism {
  return mechanismFor(mode)
}

/**
 * Register autostart. `execPath` is the binary a service manager should run —
 * `app.getPath('exe')` from the caller, so this module stays Electron-free and
 * testable under plain node.
 *
 * The loginItem mechanism is NOT handled here: it is Electron's own call and
 * stays at the call site, which keeps this module's shell-out surface honest.
 */
export async function installAutostart(
  mode: AutostartMode,
  execPath: string
): Promise<AutostartStatus> {
  const mechanism = mechanismFor(mode)
  // Every branch below writes execPath into a file a service manager reads at
  // NEXT boot. Under an AppImage the caller's path is a /tmp mount that will
  // not exist by then, so the registration would succeed, report itself
  // healthy, and quietly never start the app again.
  const exec = stableExecPath(execPath)
  try {
    switch (mechanism) {
      case 'systemd':
        return await installSystemd(exec)
      case 'xdg':
        return await installXdg(exec)
      case 'launchd':
        return await installLaunchd(exec)
      case 'schtasks':
        return await installSchtasks(exec)
      default:
        return { active: false, mechanism, location: null, warning: null }
    }
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err)
    wlog.warn(TAG, `install (${mechanism}) failed: ${detail}`)
    return { active: false, mechanism, location: null, warning: detail }
  }
}

export async function uninstallAutostart(mode: AutostartMode): Promise<AutostartStatus> {
  const mechanism = mechanismFor(mode)
  try {
    switch (mechanism) {
      case 'systemd':
        return await uninstallSystemd()
      case 'xdg':
        return await uninstallXdg()
      case 'launchd':
        return await uninstallLaunchd()
      case 'schtasks':
        return await uninstallSchtasks()
      default:
        return { active: false, mechanism, location: null, warning: null }
    }
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err)
    wlog.warn(TAG, `uninstall (${mechanism}) failed: ${detail}`)
    return { active: false, mechanism, location: null, warning: detail }
  }
}

/** What is registered right now — never what was asked for. */
export async function autostartStatus(mode: AutostartMode): Promise<AutostartStatus> {
  const mechanism = mechanismFor(mode)
  try {
    switch (mechanism) {
      case 'systemd':
        return await systemdStatus()
      case 'xdg':
        return await xdgStatus()
      case 'launchd':
        return await launchdStatus()
      case 'schtasks':
        return await schtasksStatus()
      default:
        return { active: false, mechanism, location: null, warning: null }
    }
  } catch {
    return { active: false, mechanism, location: null, warning: null }
  }
}
