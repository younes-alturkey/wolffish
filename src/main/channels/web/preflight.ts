/**
 * Everything that can be checked before asking Let's Encrypt for anything,
 * each step reported as it runs and each failure paired with the exact fix
 * for the OS it was found on.
 *
 * All the environment goes through `PreflightDeps` — the network, the
 * interfaces, port binding, process identity, the few optional shell-outs
 * (port owner, firewall) — so the steps run identically under test with
 * every answer scripted. Nothing here shells out except those helpers, and
 * each of them has a "could not tell" answer rather than a throw.
 */
import { classifyIdentifier, type SanIdentifier } from '@main/channels/web/x509'
import { isPrivateAddress } from '@main/channels/web/tls'
import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import net from 'node:net'
import os from 'node:os'

export type PreflightStepId =
  | 'public-ip'
  | 'interface'
  | 'ports'
  | 'privileged'
  | 'firewall'
  | 'reachable'
  | 'account'
  | 'order'
  | 'certificate'

export type StepStatus = 'pending' | 'running' | 'ok' | 'warn' | 'fail' | 'skip'

export type PreflightFix = {
  text: string
  commands: string[]
}

export type PreflightStep = {
  id: PreflightStepId
  status: StepStatus
  detail: string
  fix: PreflightFix | null
}

export type ExecResult = { stdout: string; stderr: string; code: number }

export type PreflightDeps = {
  platform: NodeJS.Platform
  /** GET a small text body; rejects on timeout or a non-2xx answer. */
  fetchText: (url: string, timeoutMs: number) => Promise<string>
  /** Every non-internal address this machine has. */
  interfaces: () => string[]
  /** Bind and release; null when it worked, the error code otherwise. */
  probeBind: (port: number, host: string) => Promise<string | null>
  /** Ports this server itself already holds — not conflicts. */
  heldPorts: () => number[]
  uid: () => number | null
  readFile: (file: string) => Promise<string | null>
  /** Shell out to an optional helper; rejects when the binary is missing. */
  exec: (bin: string, args: string[]) => Promise<ExecResult>
  execPath: string
}

export function defaultPreflightDeps(heldPorts: () => number[]): PreflightDeps {
  return {
    platform: process.platform,
    fetchText: async (url, timeoutMs) => {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), timeoutMs)
      try {
        const res = await fetch(url, { signal: controller.signal, redirect: 'manual' })
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        return (await res.text()).trim()
      } finally {
        clearTimeout(timer)
      }
    },
    interfaces: () =>
      Object.values(os.networkInterfaces())
        .flat()
        .filter((i): i is os.NetworkInterfaceInfo => Boolean(i) && !i!.internal)
        .map((i) => i.address),
    probeBind: (port, host) =>
      new Promise((resolve) => {
        const server = net.createServer()
        server.once('error', (err: NodeJS.ErrnoException) => resolve(err.code ?? 'ERROR'))
        server.listen(port, host, () => server.close(() => resolve(null)))
      }),
    heldPorts,
    uid: () => (typeof process.getuid === 'function' ? process.getuid() : null),
    readFile: async (file) => {
      try {
        return await fs.readFile(file, 'utf8')
      } catch {
        return null
      }
    },
    exec: (bin, args) =>
      new Promise((resolve, reject) => {
        execFile(
          bin,
          args,
          { timeout: 8000, windowsHide: true, maxBuffer: 1024 * 1024 },
          (err, stdout, stderr) => {
            const code = (err as NodeJS.ErrnoException & { code?: unknown })?.code
            if (err && (code === 'ENOENT' || code === 'EACCES')) return reject(err)
            resolve({
              stdout: String(stdout ?? ''),
              stderr: String(stderr ?? ''),
              code: typeof code === 'number' ? code : err ? 1 : 0
            })
          }
        )
      }),
    execPath: process.execPath
  }
}

// ─── public address ───────────────────────────────────────────────────────────

const IPV4_SOURCES = ['https://api.ipify.org', 'https://ipv4.icanhazip.com']
const IPV6_SOURCES = ['https://api6.ipify.org', 'https://ipv6.icanhazip.com']

export type DetectedIp = { ipv4: string | null; ipv6: string | null; source: string | null }

/** The address the internet sees this box at — ipify first, icanhazip when it is down. */
export async function detectPublicIp(deps: PreflightDeps): Promise<DetectedIp> {
  const ask = async (
    sources: string[],
    family: 'ip4' | 'ip6'
  ): Promise<[string, string] | null> => {
    for (const url of sources) {
      try {
        const text = (await deps.fetchText(url, 6000)).trim()
        const id = classifyIdentifier(text)
        if (!id || id.type !== 'ip') continue
        if ((family === 'ip6') !== id.value.includes(':')) continue
        return [id.value, url]
      } catch {
        // try the next source
      }
    }
    return null
  }
  const [v4, v6] = await Promise.all([ask(IPV4_SOURCES, 'ip4'), ask(IPV6_SOURCES, 'ip6')])
  return { ipv4: v4?.[0] ?? null, ipv6: v6?.[0] ?? null, source: v4?.[1] ?? v6?.[1] ?? null }
}

/**
 * Is this something a public CA can certify? Private, loopback and link-local
 * addresses are refused with the reason — unless the CA is a private or test
 * one, which may well certify a LAN address.
 */
export function checkIdentifier(
  value: string,
  publicCa: boolean
): { ok: true; identifier: SanIdentifier } | { ok: false; detail: string } {
  const id = classifyIdentifier(value.trim())
  if (!id) return { ok: false, detail: `"${value}" is not an IP address or a hostname` }
  if (!publicCa) return { ok: true, identifier: id }
  if (id.type === 'ip' && isPrivateAddress(id.value)) {
    return {
      ok: false,
      detail: `${id.value} is a private, loopback or link-local address — Let's Encrypt can only certify an address it can reach from the internet. Use the machine's public IP, or a hostname that points at it.`
    }
  }
  if (id.type === 'dns' && (id.value === 'localhost' || id.value.endsWith('.local'))) {
    return { ok: false, detail: `${id.value} is not a public hostname` }
  }
  return { ok: true, identifier: id }
}

// ─── privileged ports ─────────────────────────────────────────────────────────

const CAP_NET_BIND_SERVICE = 10

/** The fix for a Linux box that may not bind ports below 1024, in the order to try. */
export function privilegedPortFix(execPath: string, lowestPort: number): PreflightFix {
  return {
    text: `Ports below 1024 need a capability on Linux. Any one of these works; the first survives updates, the second has to be repeated after one. Then restart Wolffish.`,
    commands: [
      `sudo sysctl -w net.ipv4.ip_unprivileged_port_start=${lowestPort} && echo 'net.ipv4.ip_unprivileged_port_start=${lowestPort}' | sudo tee /etc/sysctl.d/60-wolffish-ports.conf`,
      `sudo setcap 'cap_net_bind_service=+ep' "${execPath}"`,
      `# for a system-wide unit (not the per-user one the installer writes): add under [Service]\nAmbientCapabilities=CAP_NET_BIND_SERVICE`
    ]
  }
}

/**
 * macOS refuses ports below 1024 to a normal user (measured, not assumed:
 * the bind probe says so on the box this runs on). The usual answer there
 * is pf forwarding the public 80 and 443 to high ports Wolffish can bind.
 */
export function macosPortForwardFix(httpPort: number, httpsPort: number): PreflightFix {
  const high = {
    http: httpPort < 1024 ? 8080 : httpPort,
    https: httpsPort < 1024 ? 8443 : httpsPort
  }
  return {
    text: `macOS let only root bind ports 80 and 443 here. Forward them with pf to high ports and point Wolffish at those (HTTPS port ${high.https}, HTTP port ${high.http}); the forward survives reboots once it is in /etc/pf.conf. Or run Wolffish as root from a LaunchDaemon.`,
    commands: [
      `printf 'rdr pass inet proto tcp from any to any port 80 -> 127.0.0.1 port ${high.http}\\nrdr pass inet proto tcp from any to any port 443 -> 127.0.0.1 port ${high.https}\\n' | sudo tee /etc/pf.anchors/wolffish`,
      `printf 'rdr-anchor "wolffish"\\nload anchor "wolffish" from "/etc/pf.anchors/wolffish"\\n' | sudo tee -a /etc/pf.conf && sudo pfctl -ef /etc/pf.conf`,
      `wolffish settings set channels.web.httpsPort ${high.https} && wolffish settings set channels.web.httpPort ${high.http}`
    ]
  }
}

async function linuxMayBindLowPorts(
  deps: PreflightDeps,
  lowestPort: number
): Promise<{ ok: boolean; why: string }> {
  if (deps.uid() === 0) return { ok: true, why: 'running as root' }
  const start = await deps.readFile('/proc/sys/net/ipv4/ip_unprivileged_port_start')
  if (start !== null && Number(start.trim()) <= lowestPort) {
    return { ok: true, why: `net.ipv4.ip_unprivileged_port_start is ${start.trim()}` }
  }
  const status = await deps.readFile('/proc/self/status')
  const capEff = /^CapEff:\s*([0-9a-fA-F]+)/m.exec(status ?? '')?.[1]
  if (capEff && (BigInt(`0x${capEff}`) >> BigInt(CAP_NET_BIND_SERVICE)) % 2n === 1n) {
    return { ok: true, why: 'the process holds CAP_NET_BIND_SERVICE' }
  }
  return {
    ok: false,
    why: 'not root, no CAP_NET_BIND_SERVICE, and the unprivileged port range starts above it'
  }
}

// ─── port owners ──────────────────────────────────────────────────────────────

export function portOwnerCommand(
  platform: NodeJS.Platform,
  port: number
): { bin: string; args: string[] } | null {
  if (platform === 'darwin') return { bin: 'lsof', args: ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN'] }
  if (platform === 'linux') return { bin: 'ss', args: ['-ltnp', `sport = :${port}`] }
  if (platform === 'win32') return { bin: 'netstat', args: ['-ano', '-p', 'tcp'] }
  return null
}

/** "nginx (pid 1234)" when a helper can say, otherwise null. */
export async function describePortOwner(deps: PreflightDeps, port: number): Promise<string | null> {
  const cmd = portOwnerCommand(deps.platform, port)
  if (!cmd) return null
  try {
    const { stdout } = await deps.exec(cmd.bin, cmd.args)
    if (deps.platform === 'darwin') {
      const line = stdout.split('\n').find((l) => /LISTEN/.test(l))
      const [name, pid] = line?.trim().split(/\s+/) ?? []
      return name && pid ? `${name} (pid ${pid})` : null
    }
    if (deps.platform === 'linux') {
      const m = /users:\(\("([^"]+)",pid=(\d+)/.exec(stdout)
      return m ? `${m[1]} (pid ${m[2]})` : null
    }
    const line = stdout.split('\n').find((l) => new RegExp(`:${port}\\s+\\S+\\s+LISTENING`).test(l))
    const pid = line?.trim().split(/\s+/).pop()
    if (!pid) return null
    try {
      const { stdout: tasks } = await deps.exec('tasklist', [
        '/FI',
        `PID eq ${pid}`,
        '/NH',
        '/FO',
        'CSV'
      ])
      const name = /^"([^"]+)"/.exec(tasks.trim())?.[1]
      return name ? `${name} (pid ${pid})` : `pid ${pid}`
    } catch {
      return `pid ${pid}`
    }
  } catch {
    return null
  }
}

// ─── firewall ─────────────────────────────────────────────────────────────────

export const PROVIDER_FIREWALL_NOTE =
  "A cloud provider's own firewall (Hetzner, DigitalOcean, AWS security groups) is outside this machine — open 80 and 443 there too."

export function firewallCommands(platform: NodeJS.Platform, ports: number[]): string[] {
  const list = ports.join(',')
  if (platform === 'linux')
    return [
      `sudo ufw allow ${list}/tcp`,
      `sudo firewall-cmd --permanent --add-service=http --add-service=https && sudo firewall-cmd --reload`
    ]
  if (platform === 'win32')
    return [
      `New-NetFirewallRule -DisplayName 'Wolffish HTTPS' -Direction Inbound -Protocol TCP -LocalPort ${list} -Action Allow`
    ]
  return []
}

async function firewallStep(deps: PreflightDeps, ports: number[]): Promise<PreflightStep> {
  const id = 'firewall' as const
  const note = ` ${PROVIDER_FIREWALL_NOTE}`
  if (deps.platform === 'darwin') {
    return {
      id,
      status: 'skip',
      detail: `macOS keeps pf off by default; its application firewall asks once when Wolffish first listens.${note}`,
      fix: null
    }
  }
  if (deps.platform === 'win32') {
    const [command] = firewallCommands('win32', ports)
    try {
      const r = await deps.exec('powershell', [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        command
      ])
      if (r.code === 0)
        return {
          id,
          status: 'ok',
          detail: `Windows Firewall rule added for ${ports.join(' and ')}.${note}`,
          fix: null
        }
      return {
        id,
        status: 'warn',
        detail: `Could not add the Windows Firewall rule (needs an Administrator PowerShell).${note}`,
        fix: { text: 'Run in an Administrator PowerShell:', commands: [command] }
      }
    } catch {
      return {
        id,
        status: 'warn',
        detail: `PowerShell was not available to add a firewall rule.${note}`,
        fix: { text: 'Run in an Administrator PowerShell:', commands: [command] }
      }
    }
  }
  if (deps.platform === 'linux') {
    const [ufwCmd, firewalldCmd] = firewallCommands('linux', ports)
    try {
      const status = await deps.exec('ufw', ['status'])
      if (/Status:\s*active/i.test(status.stdout)) {
        const results = await Promise.all(
          ports.map((p) =>
            deps
              .exec('ufw', ['allow', `${p}/tcp`])
              .catch(() => ({ code: 1, stdout: '', stderr: '' }))
          )
        )
        if (results.every((r) => r.code === 0))
          return {
            id,
            status: 'ok',
            detail: `ufw now allows ${ports.join(' and ')}.${note}`,
            fix: null
          }
        return {
          id,
          status: 'warn',
          detail: `ufw is active and Wolffish may not change it from here.${note}`,
          fix: { text: 'Open the ports:', commands: [ufwCmd] }
        }
      }
      return { id, status: 'ok', detail: `ufw is installed but inactive.${note}`, fix: null }
    } catch {
      // no ufw — try firewalld
    }
    try {
      const state = await deps.exec('firewall-cmd', ['--state'])
      if (/running/i.test(state.stdout + state.stderr)) {
        const add = await deps
          .exec('firewall-cmd', ['--permanent', '--add-service=http', '--add-service=https'])
          .catch(() => ({ code: 1, stdout: '', stderr: '' }))
        const reload =
          add.code === 0
            ? await deps
                .exec('firewall-cmd', ['--reload'])
                .catch(() => ({ code: 1, stdout: '', stderr: '' }))
            : add
        if (add.code === 0 && reload.code === 0)
          return {
            id,
            status: 'ok',
            detail: `firewalld now allows http and https.${note}`,
            fix: null
          }
        return {
          id,
          status: 'warn',
          detail: `firewalld is running and Wolffish may not change it from here.${note}`,
          fix: { text: 'Open the services:', commands: [firewalldCmd] }
        }
      }
    } catch {
      // no firewalld either
    }
    return {
      id,
      status: 'ok',
      detail: `No host firewall found (ufw, firewalld).${note}`,
      fix: null
    }
  }
  return {
    id,
    status: 'skip',
    detail: `No firewall helper for ${deps.platform}.${note}`,
    fix: null
  }
}

// ─── the run ──────────────────────────────────────────────────────────────────

export type PreflightInput = {
  identifier: SanIdentifier
  httpsPort: number
  httpPort: number
  bind: string
  /** Let's Encrypt (production or staging) — false for a private or test CA. */
  publicCa: boolean
}

export type PreflightResult = { ok: boolean; steps: PreflightStep[] }

/**
 * The checks, in order, each reported the moment it settles. A `fail` stops
 * the run; a `warn` is reported and the run continues, because the warning
 * cases (behind NAT, firewall not changeable from here) are ones the user may
 * already have handled outside this machine.
 */
export async function runPreflight(
  input: PreflightInput,
  deps: PreflightDeps,
  report: (step: PreflightStep) => void = () => undefined
): Promise<PreflightResult> {
  const steps: PreflightStep[] = []
  const emit = (step: PreflightStep): PreflightStep => {
    steps.push(step)
    report(step)
    return step
  }
  const running = (id: PreflightStepId): void =>
    report({ id, status: 'running', detail: '', fix: null })

  // 1. the address itself
  running('public-ip')
  const label = input.identifier.type === 'ip' ? 'public IP address' : 'hostname'
  emit({
    id: 'public-ip',
    status: 'ok',
    detail: `Certifying the ${label} ${input.identifier.value}.`,
    fix: null
  })

  // 2. is it one of ours?
  running('interface')
  if (input.identifier.type === 'ip') {
    const local = deps.interfaces()
    const bound = local.some((a) => a.toLowerCase() === input.identifier.value.toLowerCase())
    emit(
      bound
        ? {
            id: 'interface',
            status: 'ok',
            detail: `${input.identifier.value} is bound to a local interface.`,
            fix: null
          }
        : {
            id: 'interface',
            status: 'warn',
            detail: `${input.identifier.value} is not bound to any local interface, so this machine is probably behind NAT. Let's Encrypt must still reach ports 80 and 443 at that address: forward both to this machine, or run Wolffish on a VPS with the address on its own interface.`,
            fix: null
          }
    )
  } else {
    emit({
      id: 'interface',
      status: 'skip',
      detail: 'A hostname resolves wherever DNS says; make sure it points at this machine.',
      fix: null
    })
  }

  // 3. the two ports
  running('ports')
  const held = new Set(deps.heldPorts())
  const ports = [...new Set([input.httpPort, input.httpsPort])]
  const busy: string[] = []
  let eacces: number | null = null
  for (const port of ports) {
    if (held.has(port)) continue
    const code = await deps.probeBind(port, input.bind)
    if (code === null) continue
    if (code === 'EACCES') {
      eacces = port
      continue
    }
    const owner = code === 'EADDRINUSE' ? await describePortOwner(deps, port) : null
    busy.push(`${port}${owner ? ` (${owner})` : code === 'EADDRINUSE' ? '' : ` (${code})`}`)
  }
  if (busy.length > 0) {
    const cmd = portOwnerCommand(deps.platform, Number(busy[0].split(' ')[0]))
    emit({
      id: 'ports',
      status: 'fail',
      detail: `Port ${busy.join(' and ')} is already in use. Let's Encrypt validates on 80 and browsers expect 443, so whatever holds them has to move or stop.`,
      fix: {
        text: 'See what is listening, then stop it or point it elsewhere:',
        commands: cmd ? [`${cmd.bin} ${cmd.args.join(' ')}`] : []
      }
    })
    return { ok: false, steps }
  }
  emit(
    eacces === null
      ? {
          id: 'ports',
          status: 'ok',
          detail: `Ports ${ports.join(' and ')} are free${held.size ? ' or already ours' : ''}.`,
          fix: null
        }
      : {
          id: 'ports',
          status: 'warn',
          detail: `Port ${eacces} is not in use, but binding it was refused — see the next step.`,
          fix: null
        }
  )

  // 4. may we bind below 1024?
  running('privileged')
  const lowest = Math.min(...ports)
  if (deps.platform === 'linux') {
    const may = await linuxMayBindLowPorts(deps, lowest)
    if (!may.ok || eacces !== null) {
      emit({
        id: 'privileged',
        status: 'fail',
        detail: `This process may not bind port ${eacces ?? lowest}: ${may.why}.`,
        fix: privilegedPortFix(deps.execPath, lowest)
      })
      return { ok: false, steps }
    }
    emit({ id: 'privileged', status: 'ok', detail: `Low ports allowed — ${may.why}.`, fix: null })
  } else if (eacces !== null) {
    emit({
      id: 'privileged',
      status: 'fail',
      detail: `Binding port ${eacces} was refused (EACCES)${deps.platform === 'darwin' ? ' — this macOS reserves ports below 1024 for root' : ''}.`,
      fix:
        deps.platform === 'darwin'
          ? macosPortForwardFix(input.httpPort, input.httpsPort)
          : {
              text:
                deps.platform === 'win32'
                  ? 'Another service may have reserved the port. Check reserved ranges and the HTTP.sys listener:'
                  : 'Check what reserved the port:',
              commands:
                deps.platform === 'win32'
                  ? [
                      'netsh int ipv4 show excludedportrange protocol=tcp',
                      'netsh http show servicestate'
                    ]
                  : []
            }
    })
    return { ok: false, steps }
  } else {
    emit({
      id: 'privileged',
      status: 'ok',
      detail:
        deps.platform === 'win32'
          ? 'Windows has no privileged-port rule, and the bind test passed.'
          : `The bind test passed for ${ports.join(' and ')}.`,
      fix: null
    })
  }

  // 5. firewall
  running('firewall')
  emit(await firewallStep(deps, ports))

  return { ok: true, steps }
}

/**
 * Once the challenge listener is up: can this machine fetch its own
 * challenge path at the public address, on port 80 — the only port the CA
 * will use, whatever port the listener behind a forward sits on? A miss is
 * a warning, not a stop — a box behind NAT without hairpinning fails this
 * and still validates fine from outside.
 */
export async function selfTestReachability(
  deps: PreflightDeps,
  identifier: SanIdentifier,
  token: string,
  expected: string
): Promise<PreflightStep> {
  const host = identifier.value.includes(':') ? `[${identifier.value}]` : identifier.value
  const url = `http://${host}/.well-known/acme-challenge/${token}`
  try {
    const body = await deps.fetchText(url, 5000)
    if (body.trim() === expected) {
      return {
        id: 'reachable',
        status: 'ok',
        detail: `This machine answered its own challenge at ${url}.`,
        fix: null
      }
    }
    return {
      id: 'reachable',
      status: 'warn',
      detail: `${url} answered, but with something else — another web server may be in front of Wolffish on port 80.`,
      fix: null
    }
  } catch (err) {
    return {
      id: 'reachable',
      status: 'warn',
      detail: `Could not reach ${url} from this machine (${err instanceof Error ? err.message : String(err)}). Behind NAT this is normal; Let's Encrypt validates from the outside regardless.`,
      fix: null
    }
  }
}
