/**
 * `wolffish web` — the Web UI from a terminal, and the flows behind the
 * Settings → Channels → Web UI card.
 *
 * The one thing a box with no screen must be able to do is read the master
 * password. It is generated at first launch, so nobody has typed it anywhere,
 * and the phone's browser needs it exactly once. Everything else here — on
 * and off, the addresses, who is signed in, a test notification, a restart —
 * is the panel's buttons, reachable without a window.
 */
import {
  c,
  confirm,
  err,
  heading,
  icon,
  interactive,
  keyValue,
  out,
  question,
  table
} from '../lib/ui.mjs'

const USAGE = `usage: wolffish web [command]
  wolffish web                           status and addresses
  wolffish web password                  show the master password
  wolffish web password regenerate       a new 12-word passphrase — signs every browser out
  wolffish web password set              type your own — stored hashed, cannot be shown later
  wolffish web on | off                  serve, or stop serving
  wolffish web sessions                  signed-in browsers
  wolffish web sessions revoke <id|all>  sign one out, or all of them
  wolffish web public                    public links — files, sites and ports served without sign-in
  wolffish web public revoke <id|all>    take one down, or all of them
  wolffish web notify                    send a test notification
  wolffish web restart                   apply the configuration again
  wolffish web renew                     renew the Let's Encrypt certificate now
  wolffish web https                     the certificate: state, expiry, history
  wolffish web https enable [--ip A | --domain D] [--staging]
                                         checks, Let's Encrypt, HTTPS on 443 — the one button
  wolffish web https disable             back to plain HTTP on the app port
  wolffish web https renew               renew now (once a minute at most)`

export async function webCommand(client, args, flags = {}) {
  const [verb, ...rest] = args
  switch (verb) {
    case undefined:
    case 'status':
      return webStatus(client, flags)
    case 'password':
    case 'passphrase':
      return webPassword(client, rest, flags)
    case 'on':
    case 'enable':
      return webToggle(client, true)
    case 'off':
    case 'disable':
      return webToggle(client, false)
    case 'sessions':
    case 'browsers':
      return webSessions(client, rest, flags)
    case 'public':
    case 'links':
      return webPublic(client, rest, flags)
    case 'notify':
    case 'test':
      return webNotify(client)
    case 'restart':
      return webRestart(client)
    case 'renew':
      return webRenew(client)
    case 'https':
    case 'tls':
      return webHttps(client, rest, flags)
    case 'help':
      out(USAGE)
      return 0
    default:
      err(c.red(`unknown: wolffish web ${verb}`))
      err(c.gray(USAGE))
      return 2
  }
}

export async function webStatus(client, { json = false } = {}) {
  const [status, config] = await Promise.all([
    client.invoke('web:status'),
    client.invoke('web:getConfig')
  ])
  if (json) {
    out(JSON.stringify({ status, config }, null, 2))
    return 0
  }
  heading('Web UI')
  const state = !status.enabled
    ? c.gray('off')
    : status.listening
      ? c.green('listening')
      : c.red('not listening')
  const urls = Array.isArray(status.urls) ? status.urls : []
  const password = config.passwordGenerated
    ? `generated ${c.gray('· wolffish web password')}`
    : config.passwordSet
      ? 'your own'
      : c.red('none')
  keyValue([
    [
      'state',
      state +
        (status.listening && status.clients > 0 ? c.gray(` · ${status.clients} connected`) : '')
    ],
    ...(status.enabled && status.error ? [['why', c.yellow(String(status.error))]] : []),
    ...(urls.length > 0
      ? urls.map((url, i) => [i === 0 ? 'address' : '', url])
      : [['listen', c.gray(`${status.bind}:${status.port}`)]]),
    ['https', describeHttps(status, config)],
    ['password', password],
    ['browsers', `${status.sessions} signed in`],
    ['notifications', status.notificationsEnabled ? 'on' : 'off'],
    [
      'public links',
      status.publicLinks > 0
        ? `${status.publicLinks} live ${c.gray('· wolffish web public')}`
        : c.gray('none')
    ]
  ])
  if (!status.enabled) out(c.gray('  turn on with: wolffish web on'))
  return 0
}

function describeHttps(status, config) {
  if (status.scheme !== 'https')
    return c.gray('off — plain HTTP, so no notifications or microphone')
  const source = status.tls?.source ?? config.https?.mode ?? 'on'
  const until = status.tls?.notAfter
    ? c.gray(` · expires ${new Date(status.tls.notAfter).toLocaleDateString()}`)
    : ''
  return `${source}${until}`
}

/**
 * The generated passphrase is the one credential the CLI prints in clear:
 * on a VPS it exists nowhere else. A password the user typed is stored
 * hashed only and is reported as such, never guessed at.
 */
export async function webPassword(client, args = [], flags = {}) {
  const [sub] = args
  if (sub === 'regenerate' || sub === 'new' || sub === 'reset') {
    if (!flags.yes) {
      if (!interactive()) {
        err(c.red('regenerating signs every browser out — add --yes to confirm'))
        return 1
      }
      const go = await confirm(
        '  generate a new master password? every signed-in browser is signed out',
        false
      )
      if (!go) return 0
    }
    const result = await client.invoke('web:regeneratePassword')
    showPassword(result.password, result.status, flags)
    return 0
  }
  if (sub === 'set') {
    if (!interactive()) {
      err(c.red('run this in a terminal — the password is typed, never passed as an argument'))
      return 1
    }
    const first = await question('  new master password: ', { hidden: true })
    if (!first) return 1
    const second = await question('  repeat it: ', { hidden: true })
    if (first !== second) {
      err(c.red('  the two entries differ'))
      return 1
    }
    try {
      await client.invoke('web:setPassword', first)
    } catch (error) {
      err(`${icon.fail()} ${c.red(error?.message ?? 'refused')}`)
      return 1
    }
    out(`${icon.ok()} master password set — every browser was signed out`)
    out(
      c.gray('  stored hashed, so wolffish web password cannot show it; regenerate for one it can')
    )
    return 0
  }
  if (sub !== undefined && sub !== 'show') {
    err(c.red(`unknown: wolffish web password ${sub}`))
    err(c.gray(USAGE))
    return 2
  }
  const [{ password }, status] = await Promise.all([
    client.invoke('web:revealPassword'),
    client.invoke('web:status').catch(() => null)
  ])
  if (!password) {
    if (flags.json) {
      out(JSON.stringify({ password: null, generated: false }))
      return 1
    }
    out(
      c.yellow('  the master password is one you set yourself — stored hashed, it cannot be shown')
    )
    out(c.gray('  for a new generated one: wolffish web password regenerate'))
    return 1
  }
  showPassword(password, status, flags)
  return 0
}

function showPassword(password, status, { json = false } = {}) {
  const urls = Array.isArray(status?.urls) ? status.urls : []
  if (json) {
    out(JSON.stringify({ password, generated: true, urls }))
    return
  }
  heading('Master password')
  out(`  ${c.bold(password)}`)
  out()
  if (urls.length > 0) {
    out(c.gray('  sign in at'))
    for (const url of urls) out(`  ${url}`)
    out()
  }
  out(c.gray('  typed once per browser — the browser stays signed in until you sign it out'))
}

export async function webToggle(client, enabled) {
  let result
  try {
    result = await client.invoke('web:setConfig', { enabled })
  } catch (error) {
    err(`${icon.fail()} ${c.red(error?.message ?? 'refused')}`)
    return 1
  }
  const status = result?.status
  if (!enabled) {
    out(`${icon.ok()} Web UI off`)
    return 0
  }
  if (status?.listening) {
    out(`${icon.ok()} Web UI on`)
    for (const url of status.urls ?? []) out(`  ${url}`)
    out(c.gray('  the master password: wolffish web password'))
    return 0
  }
  out(`${icon.warn()} ${c.yellow(status?.error ?? 'not listening')}`)
  return 1
}

export async function webSessions(client, args = [], flags = {}) {
  const [sub, target] = args
  const sessions = await client.invoke('web:listSessions')
  if (sub === 'revoke' || sub === 'signout' || sub === 'sign-out') {
    if (target === 'all') {
      if (sessions.length === 0) {
        out(c.gray('  no browser is signed in'))
        return 0
      }
      if (
        !flags.yes &&
        interactive() &&
        !(await confirm(`  sign out all ${sessions.length} browsers?`, false))
      )
        return 0
      await client.invoke('web:revokeAllSessions')
      out(`${icon.ok()} signed out ${sessions.length}`)
      return 0
    }
    let id = target
    if (!id) {
      if (!interactive() || sessions.length === 0) {
        if (sessions.length === 0) out(c.gray('  no browser is signed in'))
        else err(c.red('usage: wolffish web sessions revoke <id|all>'))
        return sessions.length === 0 ? 0 : 2
      }
      printSessions(sessions, true)
      const answer = (await question('  which one? ')).trim()
      if (!answer) return 0
      const n = Number(answer)
      id = Number.isInteger(n) && n >= 1 && n <= sessions.length ? sessions[n - 1].id : answer
    }
    const match = sessions.find((s) => s.id === id || s.id.startsWith(id))
    if (!match) {
      err(c.red(`no signed-in browser matching "${id}"`))
      return 1
    }
    await client.invoke('web:revokeSession', match.id)
    out(
      `${icon.ok()} signed out ${c.gray(match.id)} ${c.gray(describeAgent(match.userAgent ?? ''))}`
    )
    return 0
  }
  if (sub !== undefined && sub !== 'list') {
    err(c.red(`unknown: wolffish web sessions ${sub}`))
    err(c.gray(USAGE))
    return 2
  }
  if (flags.json) {
    out(JSON.stringify(sessions, null, 2))
    return 0
  }
  heading(`Signed-in browsers ${c.gray(`(${sessions.length})`)}`)
  if (sessions.length === 0) {
    out(c.gray('  none — a browser appears here once it signs in'))
    return 0
  }
  printSessions(sessions)
  out()
  out(c.gray('  wolffish web sessions revoke <id>   ·   wolffish web sessions revoke all'))
  return 0
}

/**
 * `wolffish web public` — what the agent has put past the sign-in. The
 * agent makes these links (public_link); from here they can only be seen
 * and taken down, which is the one thing a person checking a box over SSH
 * needs to be able to do.
 */
export async function webPublic(client, args = [], flags = {}) {
  const [sub, target] = args
  const links = await client.invoke('web:listPublic')
  if (sub === 'revoke' || sub === 'remove' || sub === 'rm' || sub === 'unlink') {
    if (target === 'all') {
      if (links.length === 0) {
        out(c.gray('  no public link is live'))
        return 0
      }
      if (
        !flags.yes &&
        interactive() &&
        !(await confirm(`  take down all ${links.length} public links?`, false))
      )
        return 0
      const r = await client.invoke('web:revokeAllPublic')
      out(`${icon.ok()} revoked ${r.revoked ?? links.length}`)
      return 0
    }
    if (!target) {
      err(c.red('usage: wolffish web public revoke <id|all>'))
      return 2
    }
    const match = links.find((l) => l.id === target || l.id.startsWith(target) || l.url === target)
    if (!match) {
      err(c.red(`no public link matching "${target}"`))
      return 1
    }
    await client.invoke('web:revokePublic', match.id)
    out(`${icon.ok()} revoked ${c.gray(match.id)} ${match.name}`)
    return 0
  }
  if (sub !== undefined && sub !== 'list') {
    err(c.red(`unknown: wolffish web public ${sub}`))
    err(c.gray(USAGE))
    return 2
  }
  if (flags.json) {
    out(JSON.stringify(links, null, 2))
    return 0
  }
  heading(`Public links ${c.gray(`(${links.length})`)}`)
  if (links.length === 0) {
    out(c.gray('  none — the agent makes one with public_link when something has to be shared'))
    return 0
  }
  table(
    ['id', 'name', 'serves', 'opens', 'expires', 'url'],
    links.map((l) => [
      c.gray(l.id),
      l.name,
      l.kind === 'proxy' ? `port ${l.port}` : `${l.kind} ${c.gray(l.path ?? '')}`,
      String(l.hits ?? 0),
      l.expiresAt ? new Date(l.expiresAt).toLocaleString() : c.gray('never'),
      l.url
    ])
  )
  out()
  out(c.gray('  wolffish web public revoke <id>   ·   wolffish web public revoke all'))
  return 0
}

function printSessions(sessions, numbered = false) {
  table(
    [...(numbered ? ['#'] : []), 'id', 'browser', 'address', 'last seen'],
    sessions.map((s, i) => [
      ...(numbered ? [String(i + 1)] : []),
      c.gray(s.id),
      describeAgent(s.userAgent ?? ''),
      s.address ?? '—',
      s.lastSeenAt ? new Date(s.lastSeenAt).toLocaleString() : c.gray('—')
    ])
  )
}

export async function webNotify(client) {
  const r = await client
    .invoke('web:testNotification')
    .catch((error) => ({ error: error?.message ?? 'failed' }))
  if (!r || r.error) {
    out(`${icon.fail()} ${c.red(r?.error ?? 'failed')}`)
    return 1
  }
  const reached = (r.inband ?? 0) + (r.pushed ?? 0)
  const parts = [
    `${r.inband ?? 0} open ${r.inband === 1 ? 'tab' : 'tabs'}`,
    `${r.pushed ?? 0} push`
  ]
  if (r.failed) parts.push(c.red(`${r.failed} failed`))
  if (r.gone) parts.push(c.gray(`${r.gone} expired`))
  out(`${reached > 0 ? icon.ok() : icon.warn()} delivered to ${parts.join(', ')}`)
  for (const line of r.errors ?? []) out(c.gray(`  ${line}`))
  if (reached === 0) out(c.gray('  no browser is signed in, or none has allowed notifications yet'))
  return reached > 0 ? 0 : 1
}

export async function webRestart(client) {
  const status = await client.invoke('web:restart')
  if (!status.enabled) {
    out(c.gray('  the Web UI is off — wolffish web on'))
    return 0
  }
  if (status.listening) {
    out(`${icon.ok()} listening`)
    for (const url of status.urls ?? []) out(`  ${url}`)
    return 0
  }
  out(`${icon.fail()} ${c.red(status.error ?? 'not listening')}`)
  return 1
}

export async function webRenew(client) {
  let status
  try {
    status = await client.invoke('web:renewCertificate')
  } catch (error) {
    out(`${icon.fail()} ${c.red(error?.message ?? 'failed')}`)
    return 1
  }
  const tls = status.tls ?? {}
  const acme = status.acme ?? {}
  if (tls.notAfter) {
    out(`${icon.ok()} certificate from ${tls.issuer ?? 'the CA'}`)
    out(c.gray(`  valid until ${new Date(tls.notAfter).toLocaleString()}`))
  }
  if (acme.lastError) out(`${icon.warn()} ${c.yellow(String(acme.lastError))}`)
  if (!tls.notAfter && !acme.lastError)
    out(c.gray('  no certificate — HTTPS is off, or the request is still pending'))
  return tls.notAfter ? 0 : 1
}

/**
 * `wolffish web https` — the Let's Encrypt feature from a terminal: the one
 * button, its result step by step with the fix for whatever stopped it, and
 * what is being served. The panel streams the steps live; here they are
 * printed when the run settles, which on a VPS over SSH reads just as well.
 */
export async function webHttps(client, args = [], flags = {}) {
  const [sub, ...rest] = args
  if (sub === undefined || sub === 'status') return httpsStatus(client, flags)
  if (sub === 'enable' || sub === 'on') return httpsEnable(client, rest, flags)
  if (sub === 'disable' || sub === 'off') {
    try {
      const status = await client.invoke('web:httpsDisable')
      out(`${icon.ok()} HTTPS off — plain HTTP on port ${status.port}`)
      return 0
    } catch (error) {
      err(`${icon.fail()} ${c.red(error?.message ?? 'failed')}`)
      return 1
    }
  }
  if (sub === 'renew') {
    try {
      const status = await client.invoke('web:renewCertificate')
      printHttps(status, flags)
      return status.https?.state === 'active' ? 0 : 1
    } catch (error) {
      err(`${icon.fail()} ${c.red(error?.message ?? 'failed')}`)
      return 1
    }
  }
  err(c.red(`unknown: wolffish web https ${sub}`))
  err(c.gray(USAGE))
  return 2
}

function takeOption(rest, name) {
  const i = rest.indexOf(name)
  if (i < 0) return null
  const value = rest[i + 1] ?? null
  rest.splice(i, value === null ? 1 : 2)
  return value
}

async function httpsEnable(client, rest, flags) {
  const words = [...rest]
  const ip = takeOption(words, '--ip')
  const domain = takeOption(words, '--domain')
  const staging = words.includes('--staging')
  out(c.gray("  checking the box, then asking Let's Encrypt — up to a minute…"))
  let result
  try {
    result = await client.invoke('web:httpsEnable', { ip, domain, staging })
  } catch (error) {
    err(`${icon.fail()} ${c.red(error?.message ?? 'failed')}`)
    return 1
  }
  const status = await client.invoke('web:status').catch(() => null)
  const steps = status?.https?.flow?.steps ?? (result.step ? [result.step] : [])
  if (flags.json) {
    out(JSON.stringify({ ...result, steps }, null, 2))
    return result.ok ? 0 : 1
  }
  printSteps(steps)
  out()
  if (result.ok) {
    out(`${icon.ok()} HTTPS is on at ${c.bold(result.url)}`)
    out(c.gray('  renews itself; see it any time with: wolffish web https'))
    return 0
  }
  out(`${icon.fail()} ${c.red(result.step?.detail ?? 'stopped')}`)
  if (result.step?.fix) printFix(result.step.fix)
  out(c.gray('  fix it, then: wolffish web https enable'))
  return 1
}

const STEP_LABEL = {
  'public-ip': 'public address',
  interface: 'bound to this machine',
  ports: 'ports 80 and 443 free',
  privileged: 'allowed to bind low ports',
  firewall: 'firewall',
  reachable: 'reachable on port 80',
  account: "Let's Encrypt account",
  order: 'order and challenge',
  certificate: 'certificate issued'
}

function printSteps(steps) {
  for (const step of steps) {
    const mark =
      step.status === 'ok'
        ? icon.ok()
        : step.status === 'warn'
          ? icon.warn()
          : step.status === 'fail'
            ? icon.fail()
            : c.gray('·')
    out(
      `  ${mark} ${STEP_LABEL[step.id] ?? step.id}${step.detail ? c.gray(` — ${step.detail}`) : ''}`
    )
    if (step.fix && step.status !== 'ok') printFix(step.fix)
  }
}

function printFix(fix) {
  out(c.gray(`    ${fix.text}`))
  for (const command of fix.commands) {
    for (const line of command.split('\n')) out(`      ${c.bold(line)}`)
  }
}

async function httpsStatus(client, flags) {
  const status = await client.invoke('web:status')
  if (flags.json) {
    out(JSON.stringify(status.https, null, 2))
    return 0
  }
  printHttps(status, flags)
  return 0
}

function printHttps(status) {
  const h = status.https
  heading('HTTPS')
  if (!h || h.state === 'disabled') {
    out(
      c.gray(
        `  off — ${status.scheme === 'https' ? 'serving ' + (status.tls?.source ?? 'a') + ' certificate' : 'plain HTTP'}`
      )
    )
    out(c.gray('  turn on with: wolffish web https enable'))
    return
  }
  const STATE = {
    active: c.green('active'),
    renewing: c.yellow('renewing'),
    issuing: c.yellow('issuing'),
    preflight: c.yellow('checking'),
    error: c.red('error')
  }
  const cert = h.certificate
  keyValue([
    ['state', STATE[h.state] ?? h.state],
    ['address', h.identifier ?? c.gray('—')],
    [
      'ports',
      c.gray(
        `https ${h.listeners.https ?? '—'} · http ${h.listeners.http ?? '—'} · app ${h.listeners.app ?? '—'}`
      )
    ],
    ['issuer', cert?.issuer ?? c.gray('—')],
    ['serial', c.gray(cert?.serial ?? '—')],
    ['names', c.gray((cert?.sans ?? []).join(', ') || '—')],
    ['sha-256', c.gray(cert?.fingerprint256 ?? '—')],
    ['valid from', cert?.notBefore ? new Date(cert.notBefore).toLocaleString() : c.gray('—')],
    [
      'expires',
      cert?.notAfter
        ? `${new Date(cert.notAfter).toLocaleString()} ${c.gray(`· ${h.hoursRemaining ?? '?'} h left`)}`
        : c.gray('—')
    ],
    [
      'last renewal',
      h.lastRenewalAt ? new Date(h.lastRenewalAt).toLocaleString() : c.gray('never')
    ],
    ['next check', h.nextCheckAt ? new Date(h.nextCheckAt).toLocaleString() : c.gray('—')],
    ['directory', c.gray(h.staging ? 'staging' : (h.directory ?? '—'))]
  ])
  if (h.lastError) out(`  ${icon.warn()} ${c.yellow(h.lastError)}`)
  if (h.history.length > 0) {
    out()
    table(
      ['when', 'outcome', 'took', 'error'],
      [...h.history]
        .reverse()
        .slice(0, 5)
        .map((a) => [
          new Date(a.at).toLocaleString(),
          a.outcome === 'failed' ? c.red(a.outcome) : c.green(a.outcome),
          `${(a.durationMs / 1000).toFixed(1)}s`,
          c.gray(a.error ?? '')
        ])
    )
    if (h.history.length > 5)
      out(c.gray(`  ${h.history.length - 5} more — wolffish web https --json`))
  }
}

function describeAgent(ua) {
  const browser = /Edg\//.test(ua)
    ? 'Edge'
    : /OPR\//.test(ua)
      ? 'Opera'
      : /Firefox\//.test(ua)
        ? 'Firefox'
        : /Chrome\//.test(ua)
          ? 'Chrome'
          : /Safari\//.test(ua)
            ? 'Safari'
            : 'Browser'
  const os = /iPhone|iPad/.test(ua)
    ? 'iOS'
    : /Android/.test(ua)
      ? 'Android'
      : /Mac OS X/.test(ua)
        ? 'macOS'
        : /Windows/.test(ua)
          ? 'Windows'
          : /Linux/.test(ua)
            ? 'Linux'
            : ''
  return os ? `${browser} · ${os}` : browser
}
