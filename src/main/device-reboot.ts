import { execFile } from 'node:child_process'
import path from 'node:path'

/**
 * Rebooting the machine Wolffish runs on — the Settings rail's "Reboot
 * device", not the app restart beside it.
 *
 * Split in two because the second half runs after the app has drained and is
 * past the point of no return: `prepareDeviceReboot` answers "may this
 * process reboot this machine at all?" while everything is still up, so a
 * refusal reaches the dialog as an error instead of a half-stopped app, and
 * hands back the command that `run` fires once the drain is done.
 */

export type DeviceRebootRefusal = 'permission' | 'unsupported'

export type DeviceRebootPlan =
  | { ok: true; run: () => Promise<{ ok: true } | { ok: false; error: string }> }
  | { ok: false; error: DeviceRebootRefusal; detail?: string }

type Cmd = { cmd: string; args: string[] }

function exec(
  cmd: string,
  args: string[],
  timeout: number
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout, windowsHide: true }, (err, stdout, stderr) => {
      const code = err ? (typeof err.code === 'number' ? err.code : -1) : 0
      resolve({ code, stdout: String(stdout), stderr: String(stderr || err?.message || '') })
    })
  })
}

/** First command that exits 0 wins; a reboot that was accepted never returns anything else. */
function runFirst(cmds: Cmd[]): () => Promise<{ ok: true } | { ok: false; error: string }> {
  return async () => {
    let last = ''
    for (const { cmd, args } of cmds) {
      const res = await exec(cmd, args, 30_000)
      if (res.code === 0) return { ok: true }
      last = `${cmd} ${args.join(' ')}: ${res.stderr.trim() || `exit ${res.code}`}`
    }
    return { ok: false, error: last }
  }
}

async function prepareMac(): Promise<DeviceRebootPlan> {
  // Restarting goes through System Events, which macOS gates behind an
  // Automation grant. Asking it something harmless first raises the consent
  // prompt now, while the dialog is still up, and turns a refusal (-1743)
  // into an answer rather than a stopped app that cannot reboot.
  const probe = await exec(
    'osascript',
    ['-e', 'tell application "System Events" to return name'],
    120_000
  )
  if (probe.code !== 0) return { ok: false, error: 'permission', detail: probe.stderr.trim() }
  return {
    ok: true,
    run: runFirst([
      { cmd: 'osascript', args: ['-e', 'tell application "System Events" to restart'] }
    ])
  }
}

function prepareWindows(): DeviceRebootPlan {
  const shutdown = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'shutdown.exe')
  // /t 0 without /f: an app holding unsaved work may still ask, as it would
  // for a restart from the Start menu.
  return { ok: true, run: runFirst([{ cmd: shutdown, args: ['/r', '/t', '0'] }]) }
}

async function prepareLinux(): Promise<DeviceRebootPlan> {
  if (process.getuid?.() === 0) {
    // `reboot` covers the boxes with no systemd (containers, OpenRC).
    return {
      ok: true,
      run: runFirst([
        { cmd: 'systemctl', args: ['reboot'] },
        { cmd: 'reboot', args: [] }
      ])
    }
  }
  // logind answers "yes" only when polkit lets this user reboot with no
  // password; "challenge" needs an agent to type one into, and a daemon or a
  // VPS service has none.
  const can = await exec(
    'busctl',
    [
      'call',
      'org.freedesktop.login1',
      '/org/freedesktop/login1',
      'org.freedesktop.login1.Manager',
      'CanReboot'
    ],
    5_000
  )
  if (can.code === 0 && /"yes"/.test(can.stdout)) {
    return { ok: true, run: runFirst([{ cmd: 'systemctl', args: ['reboot'] }]) }
  }
  const sudo = await exec('sudo', ['-n', 'true'], 5_000)
  if (sudo.code === 0) {
    return {
      ok: true,
      run: runFirst([
        { cmd: 'sudo', args: ['-n', 'systemctl', 'reboot'] },
        { cmd: 'sudo', args: ['-n', 'reboot'] }
      ])
    }
  }
  return { ok: false, error: 'permission' }
}

export async function prepareDeviceReboot(): Promise<DeviceRebootPlan> {
  if (process.platform === 'darwin') return prepareMac()
  if (process.platform === 'win32') return prepareWindows()
  if (process.platform === 'linux') return prepareLinux()
  return { ok: false, error: 'unsupported' }
}

/**
 * How long a reboot the OS accepted may leave this process alive. Every path
 * that really goes down ends it well inside this: macOS asks each app to quit
 * at once, Windows force-ends apps seconds into its "apps are preventing
 * shutdown" screen, and systemd sends SIGTERM at once and SIGKILL at its
 * default 90 s stop timeout. Still here after that means it was cancelled — an
 * app with unsaved work on macOS, `shutdown /a` on Windows — and a drained
 * Wolffish would otherwise sit behind the reboot overlay forever.
 */
export const REBOOT_WATCHDOG_MS = 90_000

/** Calls `recover` once if not disarmed within `ms`. Unref'd: it never holds the process up. */
export function armRebootWatchdog(
  recover: () => void,
  ms = REBOOT_WATCHDOG_MS
): { disarm: () => void } {
  let done = false
  const timer = setTimeout(() => {
    if (done) return
    done = true
    recover()
  }, ms)
  timer.unref?.()
  return {
    disarm: () => {
      done = true
      clearTimeout(timer)
    }
  }
}
