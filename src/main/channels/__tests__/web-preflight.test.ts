/**
 * The HTTPS preflight with every environmental answer scripted: address
 * detection with its fallback, the refusal of private addresses, the NAT
 * warning, busy ports with their owners on each OS, the Linux low-port
 * rules and their fixes, the firewall helpers, and the self-reachability
 * probe.
 *
 * Standalone — run:
 *   npx tsx --tsconfig tsconfig.node.json src/main/channels/__tests__/web-preflight.test.ts
 */
import Module from 'node:module'
import os from 'node:os'

const loader = Module as unknown as { _load: (...a: unknown[]) => unknown }
const origLoad = loader._load
loader._load = function (this: unknown, ...args: unknown[]): unknown {
  if (args[0] === 'electron') {
    return {
      app: {
        isPackaged: false,
        getAppPath: () => process.cwd(),
        getPath: () => os.tmpdir(),
        getVersion: () => '0.0.0'
      },
      ipcMain: { handle: () => undefined, on: () => undefined }
    }
  }
  return origLoad.apply(this, args)
}

let passed = 0
let failed = 0
function ok(label: string, cond: boolean, detail?: string): void {
  if (cond) {
    passed++
    return
  }
  failed++
  console.error(`FAIL ${label}${detail ? `: ${detail}` : ''}`)
}

type Deps = import('@main/channels/web/preflight').PreflightDeps
type Step = import('@main/channels/web/preflight').PreflightStep

function deps(over: Partial<Deps> = {}): Deps {
  return {
    platform: 'linux',
    fetchText: async () => {
      throw new Error('offline')
    },
    interfaces: () => ['203.0.113.9', '10.0.0.5'],
    probeBind: async () => null,
    heldPorts: () => [],
    uid: () => 1000,
    readFile: async () => null,
    exec: async () => {
      throw new Error('ENOENT')
    },
    execPath: '/opt/Wolffish/wolffish',
    ...over
  }
}

async function run(): Promise<void> {
  const {
    detectPublicIp,
    checkIdentifier,
    runPreflight,
    selfTestReachability,
    describePortOwner,
    privilegedPortFix,
    firewallCommands,
    openFirewallPorts,
    PROVIDER_FIREWALL_NOTE
  } = await import('@main/channels/web/preflight')

  const ip = { type: 'ip' as const, value: '203.0.113.9' }
  const base = { identifier: ip, httpsPort: 443, httpPort: 80, bind: '0.0.0.0', publicCa: true }

  // ── detection ──────────────────────────────────────────────────────────────
  const asked: string[] = []
  const found = await detectPublicIp(
    deps({
      fetchText: async (url) => {
        asked.push(url)
        if (url.includes('api.ipify.org')) throw new Error('down')
        if (url.includes('ipv4.icanhazip')) return '203.0.113.9\n'
        throw new Error('no v6')
      }
    })
  )
  ok('falls back to icanhazip when ipify is down', found.ipv4 === '203.0.113.9')
  ok('names the source that answered', found.source?.includes('icanhazip') === true)
  ok('no v6 is null, not an error', found.ipv6 === null)
  const junk = await detectPublicIp(deps({ fetchText: async () => '<html>captive portal</html>' }))
  ok('garbage answers are ignored', junk.ipv4 === null && junk.ipv6 === null)
  const v6only = await detectPublicIp(
    deps({ fetchText: async (url) => (url.includes('api6') ? '2001:db8::1' : '203.0.113.9') })
  )
  ok('v6 answers land in ipv6', v6only.ipv6 === '2001:db8::1' && v6only.ipv4 === '203.0.113.9')

  // ── identifier rules ───────────────────────────────────────────────────────
  ok('public v4 accepted', checkIdentifier('203.0.113.9', true).ok)
  ok('rfc1918 refused for a public CA', !checkIdentifier('192.168.1.5', true).ok)
  ok('loopback refused', !checkIdentifier('127.0.0.1', true).ok)
  ok('link-local refused', !checkIdentifier('169.254.3.3', true).ok)
  ok('cgnat refused', !checkIdentifier('100.64.0.9', true).ok)
  ok('ula v6 refused', !checkIdentifier('fd00::1', true).ok)
  ok(
    'refusal says why',
    /private|loopback|link-local/.test(
      (checkIdentifier('10.1.1.1', true) as { detail: string }).detail
    )
  )
  ok('private address fine for a test CA', checkIdentifier('192.168.1.5', false).ok)
  ok('hostname accepted', checkIdentifier('box.example.com', true).ok)
  ok('.local hostname refused', !checkIdentifier('box.local', true).ok)
  ok('garbage refused', !checkIdentifier('not a host!', true).ok)

  // ── the happy path ─────────────────────────────────────────────────────────
  const seen: Step[] = []
  const happy = await runPreflight(base, deps({ platform: 'darwin' }), (s) => seen.push(s))
  ok('happy path passes', happy.ok)
  ok(
    'steps in order',
    JSON.stringify(happy.steps.map((s) => s.id)) ===
      JSON.stringify(['public-ip', 'interface', 'ports', 'privileged', 'firewall'])
  )
  ok(
    'every step was reported running first',
    seen.filter((s) => s.status === 'running').length === 5
  )
  ok('bound interface is ok', happy.steps[1].status === 'ok')
  ok('macOS low ports ok when the bind test passes', happy.steps[3].status === 'ok')
  ok(
    'macOS firewall step is a skip with the provider note',
    happy.steps[4].status === 'skip' && happy.steps[4].detail.includes(PROVIDER_FIREWALL_NOTE)
  )

  // ── NAT ────────────────────────────────────────────────────────────────────
  const nat = await runPreflight(
    base,
    deps({ platform: 'darwin', interfaces: () => ['192.168.1.20'] })
  )
  ok(
    'unbound public address warns, does not stop',
    nat.ok && nat.steps[1].status === 'warn' && /NAT/.test(nat.steps[1].detail)
  )
  const dns = await runPreflight(
    { ...base, identifier: { type: 'dns', value: 'box.example.com' } },
    deps({ platform: 'darwin' })
  )
  ok('hostname skips the interface check', dns.steps[1].status === 'skip')

  // ── busy ports, with owners ────────────────────────────────────────────────
  const busyMac = await runPreflight(
    base,
    deps({
      platform: 'darwin',
      probeBind: async (port) => (port === 80 ? 'EADDRINUSE' : null),
      exec: async (bin) =>
        bin === 'lsof'
          ? {
              code: 0,
              stderr: '',
              stdout: 'COMMAND PID USER\nnginx 4242 root 6u IPv4 TCP *:80 (LISTEN)\n'
            }
          : { code: 1, stderr: '', stdout: '' }
    })
  )
  ok('busy port fails the run', !busyMac.ok)
  const portsStep = busyMac.steps.find((s) => s.id === 'ports')!
  ok('names the owner from lsof', /nginx \(pid 4242\)/.test(portsStep.detail), portsStep.detail)
  ok('fix shows the lsof command', portsStep.fix?.commands[0]?.startsWith('lsof') === true)
  ok('stops before the privileged step', !busyMac.steps.some((s) => s.id === 'privileged'))

  ok(
    'linux owner from ss',
    (await describePortOwner(
      deps({
        exec: async () => ({
          code: 0,
          stderr: '',
          stdout: 'LISTEN 0 511 0.0.0.0:80 0.0.0.0:* users:(("caddy",pid=777,fd=3))\n'
        })
      }),
      80
    )) === 'caddy (pid 777)'
  )
  ok(
    'windows owner from netstat + tasklist',
    (await describePortOwner(
      deps({
        platform: 'win32',
        exec: async (bin) =>
          bin === 'netstat'
            ? {
                code: 0,
                stderr: '',
                stdout: '  TCP    0.0.0.0:443    0.0.0.0:0    LISTENING    1234\n'
              }
            : { code: 0, stderr: '', stdout: '"httpd.exe","1234","Services","0","10,000 K"\n' }
      }),
      443
    )) === 'httpd.exe (pid 1234)'
  )
  ok('unknown owner is null, not a throw', (await describePortOwner(deps(), 80)) === null)
  const held = await runPreflight(
    base,
    deps({ platform: 'darwin', probeBind: async () => 'EADDRINUSE', heldPorts: () => [80, 443] })
  )
  ok('ports this server already holds are not conflicts', held.ok)

  // ── linux low ports ────────────────────────────────────────────────────────
  const asRoot = await runPreflight(base, deps({ uid: () => 0 }))
  ok('root may bind', asRoot.steps[3].status === 'ok' && /root/.test(asRoot.steps[3].detail))
  const sysctl = await runPreflight(
    base,
    deps({ readFile: async (f) => (f.endsWith('ip_unprivileged_port_start') ? '80\n' : null) })
  )
  ok('sysctl at 80 may bind', sysctl.steps[3].status === 'ok')
  const capped = await runPreflight(
    base,
    deps({
      readFile: async (f) =>
        f.endsWith('/status') ? 'Name:\tnode\nCapEff:\t0000000000000400\n' : null
    })
  )
  ok('CAP_NET_BIND_SERVICE in CapEff may bind', capped.steps[3].status === 'ok')
  const plainUser = await runPreflight(base, deps())
  ok('plain user fails the privileged step', !plainUser.ok && plainUser.steps[3].status === 'fail')
  const fix = plainUser.steps[3].fix!
  ok(
    'fix has the sysctl line',
    fix.commands.some((c) => c.includes('ip_unprivileged_port_start=80'))
  )
  ok(
    'fix has setcap on the binary',
    fix.commands.some((c) =>
      c.includes('setcap \'cap_net_bind_service=+ep\' "/opt/Wolffish/wolffish"')
    )
  )
  ok(
    'fix mentions AmbientCapabilities for a system unit',
    fix.commands.some((c) => c.includes('AmbientCapabilities=CAP_NET_BIND_SERVICE'))
  )
  ok(
    'privilegedPortFix uses the lowest port',
    privilegedPortFix('/x', 443).commands[0].includes('=443')
  )
  const eacces = await runPreflight(
    base,
    deps({ platform: 'darwin', probeBind: async (p) => (p === 443 ? 'EACCES' : null) })
  )
  const eaccesStep = eacces.steps.find((s) => s.id === 'privileged')!
  ok('EACCES on macOS fails with the port named', !eacces.ok && /443/.test(eaccesStep.detail))
  ok(
    'macOS fix is the pf forward to high ports plus the matching settings',
    eaccesStep.fix!.commands.some((c) => c.includes('pfctl')) &&
      eaccesStep.fix!.commands.some((c) => c.includes('channels.web.httpsPort 8443'))
  )

  // ── firewall ───────────────────────────────────────────────────────────────
  const ufwOk = await runPreflight(
    base,
    deps({
      uid: () => 0,
      exec: async (bin, args) => {
        if (bin === 'ufw' && args[0] === 'status')
          return { code: 0, stderr: '', stdout: 'Status: active\n' }
        if (bin === 'ufw') return { code: 0, stderr: '', stdout: 'Rule added\n' }
        throw new Error('ENOENT')
      }
    })
  )
  ok(
    'ufw active and writable → ok',
    ufwOk.steps[4].status === 'ok' && /ufw/.test(ufwOk.steps[4].detail)
  )
  const ufwDenied = await runPreflight(
    base,
    deps({
      uid: () => 0,
      exec: async (bin, args) => {
        if (bin === 'ufw' && args[0] === 'status')
          return { code: 0, stderr: '', stdout: 'Status: active\n' }
        if (bin === 'ufw') return { code: 1, stderr: 'permission denied', stdout: '' }
        throw new Error('ENOENT')
      }
    })
  )
  ok(
    'ufw active but refused → warn with the sudo command',
    ufwDenied.ok &&
      ufwDenied.steps[4].status === 'warn' &&
      ufwDenied.steps[4].fix?.commands[0] === 'sudo ufw allow 80,443/tcp'
  )
  const firewalld = await runPreflight(
    base,
    deps({
      uid: () => 0,
      exec: async (bin, args) => {
        if (bin === 'ufw') throw new Error('ENOENT')
        if (bin === 'firewall-cmd' && args[0] === '--state')
          return { code: 0, stderr: '', stdout: 'running\n' }
        if (bin === 'firewall-cmd') return { code: 0, stderr: '', stdout: 'success\n' }
        throw new Error('ENOENT')
      }
    })
  )
  ok(
    'firewalld running and writable → ok',
    firewalld.steps[4].status === 'ok' && /firewalld/.test(firewalld.steps[4].detail)
  )
  // The app port goes through the same opener, by number rather than service.
  const appPortCalls: string[][] = []
  const appPort = await openFirewallPorts(
    deps({
      uid: () => 0,
      exec: async (bin, args) => {
        if (bin === 'ufw') throw new Error('ENOENT')
        appPortCalls.push([bin, ...args])
        if (bin === 'firewall-cmd' && args[0] === '--state')
          return { code: 0, stderr: '', stdout: 'running\n' }
        return { code: 0, stderr: '', stdout: 'success\n' }
      }
    }),
    [8787]
  )
  ok(
    'app port on firewalld → --add-port, not a service',
    appPort.status === 'ok' &&
      appPortCalls.some((c) => c.includes('--add-port=8787/tcp')) &&
      !appPortCalls.some((c) => c.includes('--add-service=http'))
  )
  ok(
    'firewall commands name the app port',
    firewallCommands('linux', [8787])[0] === 'sudo ufw allow 8787/tcp' &&
      /--add-port=8787\/tcp/.test(firewallCommands('linux', [8787])[1]) &&
      /Wolffish 8787/.test(firewallCommands('win32', [8787])[0]) &&
      /Wolffish HTTPS/.test(firewallCommands('win32', [80, 443])[0])
  )
  const noFw = await runPreflight(base, deps({ uid: () => 0 }))
  ok(
    'no host firewall → ok',
    noFw.steps[4].status === 'ok' && /No host firewall/.test(noFw.steps[4].detail)
  )
  const win = await runPreflight(
    base,
    deps({
      platform: 'win32',
      exec: async () => ({ code: 1, stderr: 'Access denied', stdout: '' })
    })
  )
  ok(
    'windows rule refused → warn with the PowerShell line',
    win.ok &&
      win.steps[4].status === 'warn' &&
      /New-NetFirewallRule/.test(win.steps[4].fix?.commands[0] ?? '')
  )
  ok('windows low ports are ok', win.steps[3].status === 'ok')
  ok(
    'firewall commands per OS',
    firewallCommands('linux', [80, 443])[0] === 'sudo ufw allow 80,443/tcp' &&
      firewallCommands('darwin', [80]).length === 0
  )

  // ── reachability ───────────────────────────────────────────────────────────
  const reach = await selfTestReachability(
    deps({
      fetchText: async (url) =>
        url === 'http://203.0.113.9/.well-known/acme-challenge/tok' ? 'tok.answer' : 'nope'
    }),
    ip,
    'tok',
    'tok.answer'
  )
  ok('own challenge answered → ok', reach.status === 'ok')
  const other = await selfTestReachability(
    deps({ fetchText: async () => 'nginx default page' }),
    ip,
    'tok',
    'tok.answer'
  )
  ok(
    'a different answer warns about another server',
    other.status === 'warn' && /another web server/.test(other.detail)
  )
  const unreachable = await selfTestReachability(deps(), ip, 'tok', 'tok.answer')
  ok(
    'unreachable warns, mentions NAT',
    unreachable.status === 'warn' && /NAT/.test(unreachable.detail)
  )
  const v6 = await selfTestReachability(
    deps({
      fetchText: async (url) => (url.startsWith('http://[2001:db8::1]/') ? 'tok.answer' : 'x')
    }),
    { type: 'ip', value: '2001:db8::1' },
    'tok',
    'tok.answer'
  )
  ok('v6 address is bracketed and port 80 is always the one probed', v6.status === 'ok')

  console.log(`web-preflight: ${passed} passed, ${failed} failed`)
  process.exit(failed > 0 ? 1 : 0)
}

void run().catch((err) => {
  console.error(err)
  process.exit(1)
})
