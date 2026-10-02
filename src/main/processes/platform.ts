import { execFile, spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import net from 'node:net'
import { promisify } from 'node:util'
import type { ListeningPort } from './types'

const execFileP = promisify(execFile)

/**
 * Everything the process manager needs from the operating system, behind one
 * interface, so the tools and the supervisor never branch on
 * `process.platform`. macOS and Linux share the POSIX half (process groups,
 * `ps`, `/proc`); Windows goes through PowerShell's CIM classes the way the
 * mobile-simulators helpers already do (helpers.mjs commandLineOf), and
 * `taskkill /t` for trees the way the shell plugin already does.
 *
 * Each primitive is cheap to call alone and never throws: a probe that
 * cannot answer returns null / an empty list, and the caller decides.
 */

export type ProcessInfo = {
  /** The OS's own start stamp for the pid, as a string we compare by equality. */
  startedAt: string | null
  commandLine: string | null
}

export type ShellSpec = { bin: string; args: string[]; powershell?: boolean }

let shellPromise: Promise<ShellSpec> | null = null

async function probeWindowsShell(): Promise<ShellSpec> {
  for (const c of [
    { bin: 'pwsh', args: ['-NoProfile', '-NonInteractive', '-Command'], powershell: true },
    { bin: 'powershell', args: ['-NoProfile', '-NonInteractive', '-Command'], powershell: true }
  ]) {
    try {
      await execFileP('where', [c.bin], { windowsHide: true })
      return c
    } catch {
      // not on PATH
    }
  }
  return { bin: 'cmd.exe', args: ['/c'] }
}

/**
 * The shell a command runs through — the shell plugin's choice, byte for
 * byte, on POSIX. On Windows a managed process runs under cmd.exe whatever
 * this says (see spawnDetachedWindows); the probe still answers who else
 * asks.
 */
export function detectShell(): Promise<ShellSpec> {
  if (shellPromise) return shellPromise
  shellPromise =
    process.platform === 'win32'
      ? probeWindowsShell().catch(() => ({ bin: 'cmd.exe', args: ['/c'] }))
      : Promise.resolve({ bin: '/bin/sh', args: ['-c'] })
  return shellPromise
}

export type Spawned = { pid: number; child: ReturnType<typeof spawn> } | { error: string }

/**
 * Start a command detached from this process: its own process group (POSIX)
 * or its own console (Windows), stdout+stderr on the log file, and unref'd so
 * it outlives the tool call, the turn and Wolffish itself. The returned
 * `child` is the handle whose `exit` event means the command itself ended.
 */
export function spawnDetached(
  shell: ShellSpec,
  command: string,
  opts: {
    cwd: string
    env: NodeJS.ProcessEnv
    logFd: number | null
    logPath: string | null
    /** The record's command signature (see manager signatureOf), for the Windows wrapper. */
    signature?: string
  }
): Promise<Spawned> {
  if (process.platform === 'win32') return spawnDetachedWindows(command, opts)
  try {
    const child = spawn(shell.bin, [...shell.args, command], {
      cwd: opts.cwd,
      env: opts.env,
      detached: true,
      stdio: ['ignore', opts.logFd ?? 'ignore', opts.logFd ?? 'ignore'],
      windowsHide: true
    })
    child.on('error', () => {})
    const pid = child.pid
    if (!pid) return Promise.resolve({ error: 'failed to start process (no PID returned)' })
    child.unref()
    return Promise.resolve({ pid, child })
  } catch (err) {
    return Promise.resolve({ error: err instanceof Error ? err.message : String(err) })
  }
}

const PID_LINE_RE = /^WOLFFISH_PID=(\d+)\s*$/m
const ERROR_LINE_RE = /^WOLFFISH_ERROR=(.*)$/m
const LAUNCH_TIMEOUT_MS = 20_000

/** A PowerShell single-quoted literal: only the quote itself needs doubling. */
function psQuote(text: string): string {
  return `'${text.replace(/'/g, "''")}'`
}

/**
 * Windows cannot take the POSIX shortcut. Node's `detached: true` maps to
 * DETACHED_PROCESS, and a console-less process does not host console
 * programs: powershell.exe exits 0 at once without running anything, and
 * under a detached cmd.exe every external program (node, npm, …) runs with
 * its output lost — even `> file` redirections come out empty. Measured on
 * Windows 11 / Node 22–24; it is what made every process_start on Windows
 * look like a finished one-shot. Without `detached`, the child sits in
 * libuv's kill-on-close job and dies with Wolffish, so "keep on quit" is
 * impossible that way.
 *
 * So the command gets a console of its own, hidden: a short-lived PowerShell
 * launcher (in the job, like every other helper here) calls Start-Process
 * -WindowStyle Hidden on a cmd.exe that runs the command and appends its
 * stdout+stderr to the log. Start-Process children are outside the job, so
 * the tree survives Wolffish quitting; cmd.exe is the pid we track (taskkill
 * /t reaches the whole tree, and the port scan already walks descendants).
 * The launcher prints that pid, then waits on the process and exits with its
 * exit code — that is the `exit` event the manager listens for.
 *
 * The command itself runs under cmd.exe, not the PowerShell that shell_exec
 * uses: with its stderr on a file, Windows PowerShell serialises every
 * stderr line of a native command as CLIXML (`#< CLIXML`, `<S S="Error">…`),
 * which would fill a server's log with XML and hide it from the readiness
 * scan. cmd writes the bytes as they come. Server commands (`npm run dev`,
 * `node server.js`, `manage.py runserver`) read the same in both.
 */
function spawnDetachedWindows(
  command: string,
  opts: { cwd: string; env: NodeJS.ProcessEnv; logPath: string | null; signature?: string }
): Promise<Spawned> {
  const redirect = opts.logPath ? ` >> "${opts.logPath}" 2>&1` : ''
  // The tracked pid is cmd.exe, whose command line would otherwise show only
  // the encoded script: a leading `title` (an internal command that leaves
  // the exit code to what follows) puts the command's signature in it, so the
  // liveness fallback that matches the signature against the command line
  // still has something to match, and so does anyone reading a task list.
  const signature = (opts.signature ?? '').replace(/[^A-Za-z0-9._-]/g, '').slice(0, 40)
  const marker = signature ? `title wolffish:${signature} & ` : ''
  const inner = `${marker}${command}${redirect}`
  const launcher = [
    '$ErrorActionPreference = "Stop"',
    'try {',
    `  $p = Start-Process -FilePath "cmd.exe" -ArgumentList ${psQuote(`/d /s /c "${inner}"`)} -WorkingDirectory ${psQuote(opts.cwd)} -WindowStyle Hidden -PassThru`,
    '  [Console]::Out.WriteLine("WOLFFISH_PID=" + $p.Id)',
    '  [Console]::Out.Flush()',
    '  $p.WaitForExit()',
    '  exit $p.ExitCode',
    '} catch {',
    '  [Console]::Out.WriteLine("WOLFFISH_ERROR=" + $_.Exception.Message)',
    '  exit 1',
    '}'
  ].join('\r\n')
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(
        'powershell',
        [
          '-NoProfile',
          '-NonInteractive',
          '-EncodedCommand',
          Buffer.from(launcher, 'utf16le').toString('base64')
        ],
        { cwd: opts.cwd, env: opts.env, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true }
      )
    } catch (err) {
      resolve({ error: err instanceof Error ? err.message : String(err) })
      return
    }
    let out = ''
    let settled = false
    const settle = (result: Spawned): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      child.stdout?.removeAllListeners('data')
      // The pipe stays open (the launcher lives as long as the command) but
      // must not keep the event loop alive.
      ;(child.stdout as unknown as { unref?: () => void } | null)?.unref?.()
      child.unref()
      resolve(result)
    }
    const timer = setTimeout(() => {
      try {
        child.kill()
      } catch {
        // already gone
      }
      settle({ error: 'the process launcher did not report a pid in time' })
    }, LAUNCH_TIMEOUT_MS)
    child.on('error', (err) => settle({ error: err.message }))
    child.on('exit', (code) => {
      const failure = ERROR_LINE_RE.exec(out)?.[1]?.trim()
      settle({ error: failure || `failed to start process (launcher exited ${code ?? '?'})` })
    })
    child.stdout?.on('data', (chunk: Buffer | string) => {
      out += String(chunk)
      const pid = PID_LINE_RE.exec(out)?.[1]
      if (pid) settle({ pid: Number(pid), child })
      const failure = ERROR_LINE_RE.exec(out)?.[1]?.trim()
      if (failure) settle({ error: failure })
    })
  })
}

export function pidExists(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException)?.code === 'EPERM'
  }
}

function runQuiet(bin: string, args: string[], timeout = 8000): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(bin, args, { timeout, windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) =>
      resolve(err ? null : String(stdout ?? ''))
    )
  })
}

function powershell(script: string, timeout = 10000): Promise<string | null> {
  return runQuiet('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], timeout)
}

/** Start stamp + command line for one pid, or null when there is no such process. */
export async function processInfo(pid: number): Promise<ProcessInfo | null> {
  if (!pid || !pidExists(pid)) return null
  if (process.platform === 'win32') {
    // Explicit strings: a bare DateTime goes through the formatter, which
    // pads it with a blank line first — the start stamp then read as empty
    // and every relaunch judged its processes dead.
    const out = await powershell(
      `$p = Get-CimInstance Win32_Process -Filter "ProcessId = ${Number(pid)}"; if ($p) { Write-Output ('START=' + $p.CreationDate.ToString('o')); Write-Output ([string]$p.CommandLine) }`
    )
    if (!out?.trim()) return null
    const lines = out.split(/\r?\n/)
    const startLine = lines.findIndex((l) => l.startsWith('START='))
    if (startLine < 0) return null
    const startedAt = lines[startLine].slice('START='.length).trim()
    const commandLine = lines
      .slice(startLine + 1)
      .join('\n')
      .trim()
    return { startedAt: startedAt || null, commandLine: commandLine || null }
  }
  if (process.platform === 'linux') {
    try {
      const [stat, cmdline] = await Promise.all([
        fs.readFile(`/proc/${pid}/stat`, 'utf8'),
        fs.readFile(`/proc/${pid}/cmdline`, 'utf8')
      ])
      // Field 22 (1-based) is starttime in clock ticks since boot; the comm
      // field can contain spaces so split after the closing paren.
      const afterComm = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
      const startedAt = afterComm[19] ?? null
      return { startedAt, commandLine: cmdline.replace(/\0/g, ' ').trim() || null }
    } catch {
      // Fall through to ps: a container without /proc permissions.
    }
  }
  const out = await runQuiet('ps', ['-p', String(pid), '-o', 'lstart=,command='])
  const line = out?.trim()
  if (!line) return null
  // lstart is a fixed 24-char "Sun Sep 20 10:00:00 2026" prefix.
  const startedAt = line.slice(0, 24).trim()
  const commandLine = line.slice(24).trim()
  return { startedAt: startedAt || null, commandLine: commandLine || null }
}

/** Every descendant pid of `root` (not including root), breadth-first. */
export async function treeOf(root: number): Promise<number[]> {
  const parents = new Map<number, number>() // pid -> ppid
  if (process.platform === 'win32') {
    const out = await powershell(
      'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId) $($_.ParentProcessId)" }'
    )
    for (const line of (out ?? '').split(/\r?\n/)) {
      const [pid, ppid] = line.trim().split(/\s+/).map(Number)
      if (pid && Number.isFinite(ppid)) parents.set(pid, ppid)
    }
  } else {
    const out = await runQuiet('ps', ['-axo', 'pid=,ppid='])
    for (const line of (out ?? '').split(/\r?\n/)) {
      const [pid, ppid] = line.trim().split(/\s+/).map(Number)
      if (pid && Number.isFinite(ppid)) parents.set(pid, ppid)
    }
  }
  const children = new Map<number, number[]>()
  for (const [pid, ppid] of parents) {
    const list = children.get(ppid) ?? []
    list.push(pid)
    children.set(ppid, list)
  }
  const out: number[] = []
  const queue = [root]
  const seen = new Set<number>([root])
  while (queue.length) {
    const cur = queue.shift() as number
    for (const kid of children.get(cur) ?? []) {
      if (seen.has(kid)) continue
      seen.add(kid)
      out.push(kid)
      queue.push(kid)
    }
  }
  return out
}

/** Every ancestor pid of `pid` (parent first), so Wolffish's own dev launcher counts as "us". */
export async function ancestorsOf(pid: number): Promise<number[]> {
  const parents = new Map<number, number>()
  if (process.platform === 'win32') {
    const out = await powershell(
      'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId) $($_.ParentProcessId)" }'
    )
    for (const line of (out ?? '').split(/\r?\n/)) {
      const [p, pp] = line.trim().split(/\s+/).map(Number)
      if (p && Number.isFinite(pp)) parents.set(p, pp)
    }
  } else {
    const out = await runQuiet('ps', ['-axo', 'pid=,ppid='])
    for (const line of (out ?? '').split(/\r?\n/)) {
      const [p, pp] = line.trim().split(/\s+/).map(Number)
      if (p && Number.isFinite(pp)) parents.set(p, pp)
    }
  }
  const chain: number[] = []
  let cur = parents.get(pid)
  while (cur && cur > 1 && !chain.includes(cur)) {
    chain.push(cur)
    cur = parents.get(cur)
  }
  return chain
}

/**
 * This app's own process family: itself and its launchers (a dev runner such
 * as electron-vite that owns the app's dev server port). Children are NOT
 * included — a detached child of Wolffish is exactly what a managed process
 * is, and must stay adoptable.
 */
export async function ownProcessTree(): Promise<Set<number>> {
  const parents = await ancestorsOf(process.pid).catch(() => [] as number[])
  return new Set([process.pid, ...parents])
}

export type StopSignal = 'SIGTERM' | 'SIGINT' | 'SIGKILL'

/**
 * Deliver a signal to a whole tree. POSIX: the detached child leads its own
 * process group, so `-pid` reaches every descendant at once; the per-pid
 * fallback covers a process that changed groups. Windows: `taskkill /t`
 * (a close request, which console programs ignore) for the graceful pass
 * and `/t /f` for the hard one — the shell plugin's killTree, unchanged.
 */
export async function signalTree(pid: number, signal: StopSignal): Promise<void> {
  if (process.platform === 'win32') {
    // taskkill /t walks parent links as they are when it runs; a grandchild
    // whose parent has already gone is reparented and missed. The hard pass
    // therefore also names every descendant from a snapshot taken before
    // anything dies.
    const descendants = signal === 'SIGKILL' ? await treeOf(pid).catch(() => [] as number[]) : []
    const args = ['/pid', String(pid), '/t']
    if (signal === 'SIGKILL') args.push('/f')
    await runQuiet('taskkill', args, 15000)
    const left = descendants.filter((kid) => pidExists(kid))
    if (left.length) {
      await runQuiet('taskkill', ['/f', ...left.flatMap((kid) => ['/pid', String(kid)])], 15000)
    }
    return
  }
  const descendants = await treeOf(pid).catch(() => [] as number[])
  try {
    process.kill(-pid, signal)
  } catch {
    try {
      process.kill(pid, signal)
    } catch {
      // already gone
    }
  }
  for (const kid of descendants) {
    try {
      process.kill(kid, signal)
    } catch {
      // gone
    }
  }
}

/** Every TCP listener on the machine, with owner pid and command where the OS tells us. */
export async function listeningPorts(): Promise<ListeningPort[]> {
  const out: ListeningPort[] = []
  const seen = new Set<string>()
  const push = (port: number, pid: number | null, command: string | null): void => {
    if (!Number.isInteger(port) || port <= 0) return
    const key = `${port}:${pid ?? 0}`
    if (seen.has(key)) return
    seen.add(key)
    out.push({ port, pid, command })
  }
  if (process.platform === 'win32') {
    const text = await powershell(
      'Get-NetTCPConnection -State Listen | ForEach-Object { $p = Get-Process -Id $_.OwningProcess -ErrorAction SilentlyContinue; "$($_.LocalPort) $($_.OwningProcess) $($p.ProcessName)" }',
      15000
    )
    for (const line of (text ?? '').split(/\r?\n/)) {
      const [port, pid, ...cmd] = line.trim().split(/\s+/)
      if (port) push(Number(port), pid ? Number(pid) : null, cmd.join(' ') || null)
    }
    return out
  }
  if (process.platform === 'darwin') {
    const text = await runQuiet('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN', '-F', 'pcn'])
    if (text) {
      let pid: number | null = null
      let cmd: string | null = null
      for (const line of text.split('\n')) {
        const tag = line[0]
        const value = line.slice(1)
        if (tag === 'p') {
          pid = Number(value) || null
          cmd = null
        } else if (tag === 'c') cmd = value
        else if (tag === 'n') {
          const m = /:(\d+)$/.exec(value)
          if (m) push(Number(m[1]), pid, cmd)
        }
      }
      return out
    }
  }
  // Linux (and a mac without lsof): ss, then the /proc tables.
  const ss = await runQuiet('ss', ['-ltnpH'])
  if (ss) {
    for (const line of ss.split('\n')) {
      const cols = line.trim().split(/\s+/)
      if (cols.length < 4) continue
      const local = cols[3]
      const m = /:(\d+)$/.exec(local)
      if (!m) continue
      const pidMatch = /pid=(\d+)/.exec(line)
      const cmdMatch = /users:\(\("([^"]+)"/.exec(line)
      push(Number(m[1]), pidMatch ? Number(pidMatch[1]) : null, cmdMatch ? cmdMatch[1] : null)
    }
    return out
  }
  try {
    for (const table of ['/proc/net/tcp', '/proc/net/tcp6']) {
      const text = await fs.readFile(table, 'utf8').catch(() => '')
      for (const line of text.split('\n').slice(1)) {
        const cols = line.trim().split(/\s+/)
        if (cols.length < 4 || cols[3] !== '0A') continue
        const port = parseInt(cols[1].split(':').pop() ?? '', 16)
        push(port, null, null)
      }
    }
  } catch {
    // no /proc — nothing more to try
  }
  return out
}

function bindProbe(port: number, host: string): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer()
    server.unref()
    server.once('error', (err: NodeJS.ErrnoException) =>
      // No IPv6 on this machine is not "busy".
      resolve(err.code === 'EAFNOSUPPORT' || err.code === 'EADDRNOTAVAIL')
    )
    server.listen({ port, host, exclusive: true }, () => {
      server.close(() => resolve(true))
    })
  })
}

/**
 * The one authoritative "free" test: a real bind, released at once. POSIX
 * answers on the loopback alone. Windows does not: a server on the IPv6
 * wildcard (`::`, what Node's listen() takes by default) leaves 127.0.0.1,
 * 0.0.0.0 and ::1 all bindable, so every address family is tried and the
 * port is free only when all of them are.
 */
export async function isPortFree(port: number): Promise<boolean> {
  if (process.platform !== 'win32') return bindProbe(port, '127.0.0.1')
  for (const host of ['127.0.0.1', '0.0.0.0', '::1', '::']) {
    if (!(await bindProbe(port, host))) return false
  }
  return true
}
