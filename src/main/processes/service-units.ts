import { wlog } from '@main/workspace/logger'
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { signalTree } from './platform'
import type { ProcessRecord, RestartPolicy } from './types'

const run = promisify(execFile)
const TAG = '[processes:units]'

/**
 * Per-process login units — `autostart: system`.
 *
 * The same three writers autostart.ts uses for the app itself (LaunchAgent,
 * systemd user unit, a per-user Task Scheduler logon task), parametrised by
 * a process definition. Two rules carried over from that module because
 * both were learned from incidents:
 *
 *  - `WOLFFISH_AUTOSTART_DRY_RUN=1` writes the unit file and never talks to
 *    the live service manager. A test that fakes the home directory does
 *    NOT fake launchctl/systemctl/schtasks — a KeepAlive agent bootstrapped
 *    from a temp HOME once relaunched the installed app on every quit.
 *  - Status is what the service manager REPORTS, never what was asked for.
 *
 * And one rule of this module's own: a unit with KeepAlive / Restart=always
 * resurrects a process the manager kills with a plain signal, so stop and
 * restart go THROUGH the unit (unitStop / unitRestart) whenever one is set.
 */

export const DRY_RUN = process.env.WOLFFISH_AUTOSTART_DRY_RUN === '1'

export type UnitPlatform = 'darwin' | 'linux' | 'win32'

export type UnitState = {
  installed: boolean
  /** The manager says the job is loaded / enabled. */
  active: boolean
  running: boolean
  pid: number | null
  location: string
  warning: string | null
}

export function unitLabel(
  name: string,
  platform: UnitPlatform = process.platform as UnitPlatform
): string {
  if (platform === 'darwin') return `sh.wolffi.process.${name}`
  if (platform === 'linux') return `wolffish-process-${name}.service`
  return `Wolffish\\process-${name}`
}

export function unitPath(
  name: string,
  platform: UnitPlatform = process.platform as UnitPlatform
): string {
  if (platform === 'darwin')
    return path.join(os.homedir(), 'Library', 'LaunchAgents', `${unitLabel(name, 'darwin')}.plist`)
  if (platform === 'linux')
    return path.join(os.homedir(), '.config', 'systemd', 'user', unitLabel(name, 'linux'))
  return `Task Scheduler ${unitLabel(name, 'win32')}`
}

async function serviceCall(bin: string, args: string[]): Promise<string> {
  if (DRY_RUN) return ''
  const { stdout } = await run(bin, args, { windowsHide: true })
  return String(stdout ?? '')
}

function xml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/** The environment a unit carries: PORT when allocated, the log-friendly flags, the definition's own. */
export function unitEnv(record: ProcessRecord): Record<string, string> {
  const env: Record<string, string> = { NO_COLOR: '1', FORCE_COLOR: '0', ...record.env }
  if (record.run.port) env.PORT = String(record.run.port)
  return env
}

export function resolvedCommand(record: ProcessRecord): string {
  return record.run.port
    ? record.command.replace(/\{port\}/gi, String(record.run.port))
    : record.command
}

export function launchdPlist(record: ProcessRecord, logPath: string): string {
  const env = unitEnv(record)
  const keepAlive: string =
    record.restart === 'always'
      ? '  <true/>'
      : record.restart === 'on-failure'
        ? '  <dict>\n    <key>SuccessfulExit</key>\n    <false/>\n  </dict>'
        : '  <false/>'
  const envXml = Object.entries(env)
    .map(([k, v]) => `    <key>${xml(k)}</key>\n    <string>${xml(v)}</string>`)
    .join('\n')
  // A login shell (-l) so the unit sees the PATH the user's terminal has —
  // launchd starts jobs with almost no environment, and a dev server that
  // needs nvm's node is otherwise "command not found" at every boot.
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xml(unitLabel(record.name, 'darwin'))}</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/sh</string>
    <string>-lc</string>
    <string>${xml(resolvedCommand(record))}</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${xml(record.cwd)}</string>
  <key>EnvironmentVariables</key>
  <dict>
${envXml}
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
${keepAlive}
  <key>StandardOutPath</key>
  <string>${xml(logPath)}</string>
  <key>StandardErrorPath</key>
  <string>${xml(logPath)}</string>
</dict>
</plist>
`
}

function systemdRestart(policy: RestartPolicy): string {
  return policy === 'always' ? 'always' : policy === 'on-failure' ? 'on-failure' : 'no'
}

export function systemdUnit(record: ProcessRecord, logPath: string): string {
  const env = unitEnv(record)
  const envLines = Object.entries(env)
    .map(([k, v]) => `Environment="${k}=${v.replace(/"/g, '\\"')}"`)
    .join('\n')
  const cmd = resolvedCommand(record).replace(/'/g, `'\\''`)
  return `[Unit]
Description=Wolffish process ${record.name}
After=network-online.target

[Service]
Type=simple
ExecStart=/bin/sh -lc '${cmd}'
WorkingDirectory=${record.cwd}
${envLines}
Restart=${systemdRestart(record.restart)}
RestartSec=2
StandardOutput=append:${logPath}
StandardError=inherit

[Install]
WantedBy=default.target
`
}

/** The single cmd.exe line a Windows unit runs: cd, set env, run, append the log. */
export function windowsUnitCommand(record: ProcessRecord, logPath: string): string {
  const env = unitEnv(record)
  const sets = Object.entries(env)
    .map(([k, v]) => `set "${k}=${v}"`)
    .join(' && ')
  return `cd /d "${record.cwd}" && ${sets ? `${sets} && ` : ''}${resolvedCommand(record)} >> "${logPath}" 2>&1`
}

/**
 * The launcher a Windows unit actually executes. Task Scheduler runs an
 * interactive user's action visibly, so a bare cmd.exe would open a console
 * window at every logon; wscript.exe is windowless and `Run(…, 0, True)`
 * starts cmd hidden and stays alive until it ends — so the task reads
 * "Running" while the server runs and its wscript pid is the tree root.
 */
export function windowsLauncherScript(record: ProcessRecord, logPath: string): string {
  const vb = (s: string): string => s.replace(/"/g, '""')
  return [
    `' Wolffish process "${record.name}" — started at logon by Task Scheduler (${unitLabel(record.name, 'win32')}).`,
    'Set sh = CreateObject("WScript.Shell")',
    `sh.CurrentDirectory = "${vb(record.cwd)}"`,
    `sh.Run "cmd.exe /d /s /c ""${vb(windowsUnitCommand(record, logPath))}""", 0, True`,
    ''
  ].join('\r\n')
}

/**
 * The manager's `files/processes` directory. Set once by ProcessManager from
 * the workspace root it was built with, so a Windows unit's launcher lands
 * beside the process's log wherever the workspace lives; the default only
 * covers a call made before any manager exists.
 */
let processFilesRoot = path.join(os.homedir(), '.wolffish', 'workspace', 'files', 'processes')

export function setProcessFilesRoot(dir: string): void {
  processFilesRoot = dir
}

/** Where a Windows unit's launcher lives: beside the process's log. */
export function unitScriptPath(name: string): string {
  return path.join(processFilesRoot, name, 'unit.vbs')
}

const WIN_TASK_PATH = '\\Wolffish\\'

function winTaskName(name: string): string {
  return `process-${name}`
}

/** A PowerShell single-quoted literal. */
function psq(text: string): string {
  return `'${text.replace(/'/g, "''")}'`
}

function encodePs(script: string): string {
  return Buffer.from(script, 'utf16le').toString('base64')
}

/** Run a PowerShell script; a thrown error carries the script's own message. */
async function ps(script: string): Promise<string> {
  const wrapped = `$ErrorActionPreference = 'Stop'\r\ntry {\r\n${script}\r\n} catch { [Console]::Error.WriteLine($_.Exception.Message); exit 1 }`
  return serviceCall('powershell', [
    '-NoProfile',
    '-NonInteractive',
    '-EncodedCommand',
    encodePs(wrapped)
  ])
}

/**
 * Start-ScheduledTask returns before the launcher exists; a state read taken
 * at once says "stopped" about a server that answers a second later. Wait
 * for the wscript pid, briefly.
 */
async function waitForWindowsUnitPid(name: string, timeoutMs = 6000): Promise<number | null> {
  if (DRY_RUN) return null
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const pid = await windowsUnitPid(name)
    if (pid || Date.now() >= deadline) return pid
    await new Promise((r) => setTimeout(r, 300))
  }
}

/** The wscript.exe hosting a unit's launcher — the root of its process tree — or null. */
async function windowsUnitPid(name: string): Promise<number | null> {
  if (DRY_RUN) return null
  const marker = unitScriptPath(name).toLowerCase()
  const out = await ps(
    `Get-CimInstance Win32_Process -Filter "Name = 'wscript.exe'" | Where-Object { $_.CommandLine -and $_.CommandLine.ToLower().Contains(${psq(marker)}) } | ForEach-Object { $_.ProcessId }`
  ).catch(() => '')
  const pid = Number(out.trim().split(/\r?\n/)[0])
  return Number.isInteger(pid) && pid > 0 ? pid : null
}

function windowsRegisterScript(record: ProcessRecord): string {
  const tn = winTaskName(record.name)
  return [
    '$who = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name',
    `$a = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument ('//B //Nologo "' + ${psq(unitScriptPath(record.name))} + '"') -WorkingDirectory ${psq(record.cwd)}`,
    '$t = New-ScheduledTaskTrigger -AtLogOn -User $who',
    '$p = New-ScheduledTaskPrincipal -UserId $who -LogonType Interactive -RunLevel Limited',
    '$s = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew',
    `Register-ScheduledTask -TaskPath ${psq(WIN_TASK_PATH)} -TaskName ${psq(tn)} -Action $a -Trigger $t -Principal $p -Settings $s -Force | Out-Null`
  ].join('\r\n')
}

export async function installUnit(
  record: ProcessRecord,
  logPath: string,
  platform: UnitPlatform = process.platform as UnitPlatform
): Promise<UnitState> {
  if (platform === 'darwin') {
    const file = unitPath(record.name, 'darwin')
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.mkdir(path.dirname(logPath), { recursive: true })
    await fs.writeFile(file, launchdPlist(record, logPath), 'utf8')
    const uid = String(process.getuid?.() ?? 501)
    // A stale copy of the same label must go first or bootstrap reports
    // "already loaded" and the new file is never read.
    await serviceCall('launchctl', [
      'bootout',
      `gui/${uid}/${unitLabel(record.name, 'darwin')}`
    ]).catch(() => undefined)
    await serviceCall('launchctl', ['bootstrap', `gui/${uid}`, file]).catch(() =>
      serviceCall('launchctl', ['load', '-w', file]).catch(() => undefined)
    )
    return unitState(record.name, 'darwin')
  }
  if (platform === 'linux') {
    const file = unitPath(record.name, 'linux')
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.mkdir(path.dirname(logPath), { recursive: true })
    await fs.writeFile(file, systemdUnit(record, logPath), 'utf8')
    await serviceCall('systemctl', ['--user', 'daemon-reload']).catch(() => undefined)
    await serviceCall('systemctl', ['--user', 'enable', '--now', unitLabel(record.name, 'linux')])
    try {
      await serviceCall('loginctl', ['enable-linger', os.userInfo().username])
    } catch (err) {
      wlog.warn(TAG, `enable-linger failed: ${err instanceof Error ? err.message : String(err)}`)
    }
    return unitState(record.name, 'linux')
  }
  // Windows: a per-user "at logon" task through the Task Scheduler cmdlets.
  // schtasks.exe's ONLOGON form is refused without elevation ("Access is
  // denied", even at /rl limited); Register-ScheduledTask with the user's
  // own AtLogOn trigger and an Interactive, Limited principal needs none.
  await fs.mkdir(path.dirname(logPath), { recursive: true })
  const script = unitScriptPath(record.name)
  await fs.mkdir(path.dirname(script), { recursive: true })
  await fs.writeFile(script, windowsLauncherScript(record, logPath), 'utf8')
  await ps(windowsRegisterScript(record))
  // Start it now, as launchd (RunAtLoad) and systemd (--now) do; the state
  // read below waits a beat for wscript to appear.
  await ps(
    `Start-ScheduledTask -TaskPath ${psq(WIN_TASK_PATH)} -TaskName ${psq(winTaskName(record.name))}`
  ).catch((err) =>
    wlog.warn(TAG, `unit start failed: ${err instanceof Error ? err.message : String(err)}`)
  )
  await waitForWindowsUnitPid(record.name)
  return unitState(record.name, 'win32')
}

export async function removeUnit(
  name: string,
  platform: UnitPlatform = process.platform as UnitPlatform
): Promise<void> {
  if (platform === 'darwin') {
    const file = unitPath(name, 'darwin')
    const uid = String(process.getuid?.() ?? 501)
    await serviceCall('launchctl', ['bootout', `gui/${uid}/${unitLabel(name, 'darwin')}`]).catch(
      () => serviceCall('launchctl', ['unload', '-w', file]).catch(() => undefined)
    )
    await fs.rm(file, { force: true })
    return
  }
  if (platform === 'linux') {
    await serviceCall('systemctl', ['--user', 'disable', '--now', unitLabel(name, 'linux')]).catch(
      () => undefined
    )
    await fs.rm(unitPath(name, 'linux'), { force: true })
    await serviceCall('systemctl', ['--user', 'daemon-reload']).catch(() => undefined)
    return
  }
  await unitStop(name, 'win32').catch(() => undefined)
  await ps(
    `Unregister-ScheduledTask -TaskPath ${psq(WIN_TASK_PATH)} -TaskName ${psq(winTaskName(name))} -Confirm:$false`
  ).catch(() => undefined)
  await fs.rm(unitScriptPath(name), { force: true })
}

export async function unitState(
  name: string,
  platform: UnitPlatform = process.platform as UnitPlatform
): Promise<UnitState> {
  const location = unitPath(name, platform)
  if (platform === 'darwin') {
    const installed = existsSync(location)
    if (DRY_RUN)
      return { installed, active: installed, running: false, pid: null, location, warning: null }
    const uid = String(process.getuid?.() ?? 501)
    try {
      const out = await serviceCall('launchctl', [
        'print',
        `gui/${uid}/${unitLabel(name, 'darwin')}`
      ])
      const pidMatch = /^\s*pid = (\d+)/m.exec(out)
      const pid = pidMatch ? Number(pidMatch[1]) : null
      return {
        installed,
        active: true,
        running: pid !== null,
        pid,
        location,
        warning: installed ? null : 'launchd runs this job but its plist is gone.'
      }
    } catch {
      return {
        installed,
        active: false,
        running: false,
        pid: null,
        location,
        warning: installed
          ? 'The agent is written but not loaded — it starts at the next login.'
          : null
      }
    }
  }
  if (platform === 'linux') {
    const installed = existsSync(location)
    if (DRY_RUN)
      return { installed, active: installed, running: false, pid: null, location, warning: null }
    try {
      const out = await serviceCall('systemctl', [
        '--user',
        'show',
        unitLabel(name, 'linux'),
        '-p',
        'MainPID',
        '-p',
        'ActiveState',
        '-p',
        'UnitFileState'
      ])
      const pid = Number(/MainPID=(\d+)/.exec(out)?.[1] ?? 0) || null
      const active = /ActiveState=active/.test(out)
      const enabled = /UnitFileState=enabled/.test(out)
      let warning: string | null = null
      if (installed && !enabled)
        warning = `Installed but not enabled — run: systemctl --user enable ${unitLabel(name, 'linux')}`
      else if (!existsSync(path.join('/var/lib/systemd/linger', os.userInfo().username)))
        warning = `Lingering is off, so this stops at logout. Run: loginctl enable-linger ${os.userInfo().username}`
      return { installed, active: enabled, running: active && pid !== null, pid, location, warning }
    } catch {
      return { installed, active: false, running: false, pid: null, location, warning: null }
    }
  }
  const scriptPresent = existsSync(unitScriptPath(name))
  if (DRY_RUN)
    return {
      installed: scriptPresent,
      active: scriptPresent,
      running: false,
      pid: null,
      location,
      warning: null
    }
  let state = ''
  try {
    state = (
      await ps(
        `(Get-ScheduledTask -TaskPath ${psq(WIN_TASK_PATH)} -TaskName ${psq(winTaskName(name))}).State`
      )
    ).trim()
  } catch {
    return {
      installed: false,
      active: false,
      running: false,
      pid: null,
      location,
      warning: scriptPresent
        ? 'The launcher is written but Task Scheduler has no such task — install the unit again.'
        : null
    }
  }
  const pid = await windowsUnitPid(name)
  return {
    installed: true,
    active: !/disabled/i.test(state),
    running: pid !== null || /running/i.test(state),
    pid,
    location,
    warning: /disabled/i.test(state)
      ? 'The task is disabled in Task Scheduler, so it will not start at logon.'
      : scriptPresent
        ? null
        : 'The task exists but its launcher file is gone — install the unit again.'
  }
}

export async function unitStart(
  name: string,
  platform: UnitPlatform = process.platform as UnitPlatform
): Promise<void> {
  if (platform === 'darwin') {
    const uid = String(process.getuid?.() ?? 501)
    await serviceCall('launchctl', ['kickstart', `gui/${uid}/${unitLabel(name, 'darwin')}`])
    return
  }
  if (platform === 'linux') {
    await serviceCall('systemctl', ['--user', 'start', unitLabel(name, 'linux')])
    return
  }
  await ps(
    `Start-ScheduledTask -TaskPath ${psq(WIN_TASK_PATH)} -TaskName ${psq(winTaskName(name))}`
  )
  await waitForWindowsUnitPid(name)
}

/** Stop through the manager, so KeepAlive / Restart= cannot bring it straight back. */
export async function unitStop(
  name: string,
  platform: UnitPlatform = process.platform as UnitPlatform
): Promise<void> {
  if (platform === 'darwin') {
    const uid = String(process.getuid?.() ?? 501)
    const file = unitPath(name, 'darwin')
    // bootout unloads the job (stopping it) without deleting the plist; the
    // next login — or unitStart — brings it back.
    await serviceCall('launchctl', ['bootout', `gui/${uid}/${unitLabel(name, 'darwin')}`]).catch(
      () => serviceCall('launchctl', ['unload', file]).catch(() => undefined)
    )
    return
  }
  if (platform === 'linux') {
    await serviceCall('systemctl', ['--user', 'stop', unitLabel(name, 'linux')])
    return
  }
  // Stop-ScheduledTask ends only the launcher (wscript); the server it
  // started keeps running, so the tree goes first.
  const pid = await windowsUnitPid(name)
  if (pid) await signalTree(pid, 'SIGKILL').catch(() => undefined)
  await ps(
    `Stop-ScheduledTask -TaskPath ${psq(WIN_TASK_PATH)} -TaskName ${psq(winTaskName(name))}`
  ).catch(() => undefined)
}

export async function unitRestart(
  name: string,
  platform: UnitPlatform = process.platform as UnitPlatform
): Promise<void> {
  if (platform === 'darwin') {
    const uid = String(process.getuid?.() ?? 501)
    const label = `gui/${uid}/${unitLabel(name, 'darwin')}`
    try {
      await serviceCall('launchctl', ['kickstart', '-k', label])
    } catch {
      // Not loaded (stopped through bootout): load it again.
      await serviceCall('launchctl', ['bootstrap', `gui/${uid}`, unitPath(name, 'darwin')]).catch(
        () => undefined
      )
    }
    return
  }
  if (platform === 'linux') {
    await serviceCall('systemctl', ['--user', 'restart', unitLabel(name, 'linux')])
    return
  }
  await unitStop(name, 'win32')
  await unitStart(name, 'win32')
}
