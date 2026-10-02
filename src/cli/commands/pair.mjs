/**
 * `wolffish pair` — phone, WhatsApp, Telegram.
 *
 * Pairing is the one flow where the terminal has to draw a picture, and the
 * picture has a hard size. Measured against the payloads these channels
 * actually emit:
 *
 *   WhatsApp link code  ~215 chars  →  49×49 modules at ECC L  →  27 rows × 55 cols
 *   phone pairing URL   ~162 chars  →  49×49 modules at ECC L  →  27 rows × 55 cols
 *
 * A default SSH window is 80×24. Twenty-four rows cannot hold twenty-seven,
 * and a QR that scrolls is a QR that will not scan — the finder pattern in the
 * top-left goes off screen and no decoder recovers from that. So the rule here
 * is: measure first, draw only if it fits, and when it does not, say exactly
 * what is missing and route to the fallback that has no picture at all. The
 * phone has one built in (`offerCode`), and WhatsApp has one too — linking by
 * phone number, which is the route this file added to the channel because
 * without it a headless box simply cannot join WhatsApp.
 *
 * Colour is not decoration either. Drawn as plain glyphs the dark modules take
 * the terminal's foreground colour, which on a dark theme is LIGHT — the code
 * comes out inverted and most scanners refuse it. Every module is therefore
 * painted explicitly, black on white, and only falls back to bare glyphs when
 * colour is off, with a warning attached.
 */
import {
  c,
  colorOn,
  g,
  err,
  heading,
  icon,
  interactive,
  out,
  question,
  terminalSize,
  unicodeOk,
  wrapText
} from '../lib/ui.mjs'

/** Modules of white space around the code. Two is the least any scanner takes. */
const QUIET = 2

/**
 * A QR as text, two module rows per printed line.
 *
 * `▀` with an explicit foreground and background gives independent control of
 * the upper and lower half of each cell, so the whole code is half as tall as
 * its module count without losing a row. Black and white are written out as
 * ANSI colours rather than left to the theme, because "dark module" has to
 * mean dark on the screen and not merely "the default text colour".
 */
function renderQr(matrix, { color = true } = {}) {
  const size = matrix.length
  const lines = []
  const BLACK_FG = '\x1b[38;5;16m'
  const WHITE_FG = '\x1b[38;5;231m'
  const BLACK_BG = '\x1b[48;5;16m'
  const WHITE_BG = '\x1b[48;5;231m'
  const RESET = '\x1b[0m'

  for (let y = -QUIET; y < size + QUIET; y += 2) {
    let line = ''
    if (color) {
      for (let x = -QUIET; x < size + QUIET; x++) {
        const top = matrix[y]?.[x] ? 1 : 0
        const bottom = matrix[y + 1]?.[x] ? 1 : 0
        line += (top ? BLACK_FG : WHITE_FG) + (bottom ? BLACK_BG : WHITE_BG) + '▀'
      }
      line += RESET
    } else {
      for (let x = -QUIET; x < size + QUIET; x++) {
        const top = matrix[y]?.[x] ? 1 : 0
        const bottom = matrix[y + 1]?.[x] ? 1 : 0
        if (top && bottom) line += '█'
        else if (top) line += '▀'
        else if (bottom) line += '▄'
        else line += ' '
      }
    }
    lines.push('  ' + line)
  }
  return lines.join('\n')
}

/**
 * The smallest matrix that can carry this text.
 *
 * Error correction level L rather than M: measured on a real WhatsApp payload
 * that is 49 modules instead of 53, which is two printed rows and four columns
 * saved. A QR on a screen is not being read off a crumpled receipt — the extra
 * redundancy buys nothing here and costs the fit.
 *
 * Two routes, in order. In dev the CLI sits inside the repo, where `qrcode`
 * resolves from the project's node_modules. A packaged install is different:
 * the CLI ships as loose source NEXT TO app.asar while the dependency lives
 * inside it, and ESM resolution only walks real directories — so the local
 * import fails there every time, on every platform. The daemon runs from
 * inside the archive and can always reach it, so it answers `cli:qrMatrix`
 * and this side only draws. A daemon from before that channel existed says
 * "unknown channel", which lands in the same catch — and every caller has a
 * text fallback, never a dead end.
 */
async function toMatrix(client, text) {
  try {
    const { default: QRCode } = await import('qrcode')
    const qr = QRCode.create(text, { errorCorrectionLevel: 'L' })
    const size = qr.modules.size
    const data = qr.modules.data
    const matrix = []
    for (let y = 0; y < size; y++) {
      const row = []
      for (let x = 0; x < size; x++) row.push(Boolean(data[y * size + x]))
      matrix.push(row)
    }
    return matrix
  } catch {
    // fall through to the daemon
  }
  try {
    const result = await client.invoke('cli:qrMatrix', text)
    if (result?.ok && Array.isArray(result.rows) && result.rows.length > 0) {
      return result.rows.map((row) => Array.from(row, (cell) => cell === '1'))
    }
  } catch {
    // older daemon, or none — the caller's text fallback takes it from here
  }
  return null
}

/** What drawing this matrix would cost, in printed rows and columns. */
function footprint(matrix) {
  const size = matrix.length + QUIET * 2
  return { rows: Math.ceil(size / 2), columns: size + 2 }
}

/**
 * Draw the code, or explain precisely why not.
 *
 * Returns 'drawn' | 'too-big' | 'no-renderer'. Callers use that to decide
 * whether to offer the other route, rather than printing a fallback hint
 * underneath a code that came out fine.
 */
async function printQr(client, text, { reserveRows = 6 } = {}) {
  // A console that cannot print the half-block glyph turns every module into
  // "?" — a square of punctuation that looks like a QR from a distance and is
  // not one. Legacy Windows consoles are the case; refusing is the only honest
  // answer, and every caller has a route that needs no picture.
  if (!unicodeOk()) {
    out(c.yellow('  this console cannot draw a QR — use the code instead'))
    return 'too-big'
  }
  const matrix = await toMatrix(client, text)
  if (!matrix) {
    out(c.yellow('  no QR renderer available — here is the raw payload instead'))
    out(`  ${text}`)
    return 'no-renderer'
  }

  const { rows, columns } = footprint(matrix)
  const term = terminalSize()
  // `reserveRows` is the caption, the prompt and the shell line that follow.
  // Without it the code technically fits and then scrolls off the top the
  // instant anything else prints, which looks identical to not fitting.
  const haveRows = term.rows - reserveRows
  if (columns > term.columns || rows > haveRows) {
    out()
    out(`  ${icon.warn()} ${c.yellow('this code does not fit the window')}`)
    out(
      wrapText(
        c.gray(
          `it needs ${columns} columns × ${rows} rows and this terminal gives ${term.columns} × ${haveRows} usable. A code that scrolls cannot be scanned — its corner marker goes off screen.`
        ),
        4
      )
    )
    return 'too-big'
  }

  out()
  out(renderQr(matrix, { color: colorOn() }))
  if (!colorOn()) {
    out()
    out(
      wrapText(
        c.gray(
          'drawn without colour — if your terminal has a dark background the code is inverted and may not scan. Drop --no-color, or use the code route below.'
        ),
        2
      )
    )
  }
  return 'drawn'
}

/**
 * One SIGINT listener, and it always comes off again.
 *
 * `process.once('SIGINT', …)` looks equivalent and is not: these flows also run
 * inside `wolffish settings`, in a process that lives for the whole session, so
 * a listener left behind by a cancelled attempt is still armed when the next
 * one starts. Two attempts, one Ctrl-C, both resolve — and the second one
 * resolves a promise nobody is waiting on any more.
 */
function onCancel(handler) {
  process.on('SIGINT', handler)
  return () => process.removeListener('SIGINT', handler)
}

export async function pair(client, args) {
  const [target, ...rest] = args
  if (!target) {
    heading('Pairing')
    out('  wolffish pair phone [--code]        pair the mobile app')
    out('  wolffish pair whatsapp [--number]   link a WhatsApp account')
    out('  wolffish pair telegram              set the bot token')
    out()
    out(
      wrapText(
        c.gray(
          'On a machine with no screen, or any terminal shorter than about 32 rows, use --code for the phone and --number for WhatsApp: neither draws a QR.'
        ),
        2
      )
    )
    out()
    // Unlinking lives on the settings cards and was reachable only by
    // browsing to it — this is the page someone reads when they want the
    // opposite of what it does.
    out(c.gray('  to UNLINK:'))
    out(c.gray('    wolffish settings whatsapp   ' + g.chevron + '  Disconnect'))
    out(c.gray('    wolffish settings telegram   ' + g.chevron + '  Disconnect the bot'))
    out(c.gray('    wolffish settings mobile     ' + g.chevron + '  Unpair'))
    out()
    return 2
  }
  if (target === 'phone') return pairPhone(client, rest)
  if (target === 'whatsapp') return pairWhatsApp(client, rest)
  if (target === 'telegram') return pairTelegram(client)
  err(c.red(`unknown pairing target: ${target}`))
  err(c.gray('  phone · whatsapp · telegram'))
  return 2
}

// ── Phone ───────────────────────────────────────────────────────────────────

/**
 * Pairing a phone REPLACES whatever phone is paired now — the offer overwrites
 * the stored keys, and an offer nobody claims expires into a full unpair. On a
 * box that already has a phone on it that is a destructive act, so it is asked
 * about first. The desktop panel has the same shape as two separate buttons;
 * here the only signal available is the question.
 */
async function pairPhone(client, rest) {
  let preferCode = rest.includes('--code')
  heading('Pair your phone')

  const before = await client.invoke('mobile:status').catch(() => null)
  if (before?.paired) {
    const name = before.pairing?.deviceName ?? 'a phone'
    out(wrapText(c.yellow(`  ${name} is already paired.`), 0))
    out(
      wrapText(
        c.gray(
          'Pairing again replaces it — the current phone loses its link and has to be paired back.'
        ),
        2
      )
    )
    if (!interactive()) {
      out(c.gray('  refusing to replace it without a confirmation. Run this from a terminal.'))
      return 1
    }
    const answer = (await question(`  replace it? ${c.dim('[y/N]')} `)).trim().toLowerCase()
    if (answer !== 'y' && answer !== 'yes') {
      out(c.gray('  unchanged'))
      return 0
    }
  }

  for (;;) {
    const status = preferCode
      ? await client.invoke('mobile:offerCode')
      : await client.invoke('mobile:offerQr')

    const offer = status?.offer
    if (!offer) {
      err(`${icon.fail()} ${c.red('the daemon did not produce a pairing offer')}`)
      return 1
    }

    let drew = 'drawn'
    if (offer.code) {
      out()
      out(`  ${c.bold(c.cyan(offer.code))}`)
      out()
      out(wrapText(c.gray('Enter this code in the Wolffish app on your phone.'), 2))
    } else if (offer.payload) {
      drew = await printQr(client, offer.payload)
      if (drew === 'drawn') {
        out()
        out(wrapText(c.gray('Scan this with the Wolffish app on your phone.'), 2))
      }
    }

    if (drew !== 'drawn' && !preferCode) {
      // The typed code needs no screen at all, so a window too small for the
      // square is not a dead end — switch and go round again.
      out()
      out(c.gray('  switching to the typed code, which needs no picture'))
      preferCode = true
      continue
    }

    if (offer.expiresAt) {
      const seconds = Math.max(0, Math.round((offer.expiresAt - Date.now()) / 1000))
      out(c.gray(`  expires in ${seconds}s`))
    }

    const result = await waitForPairing(client, offer.expiresAt)
    if (result === 'paired') {
      out(`${icon.ok()} ${c.green('phone paired')}`)
      return 0
    }
    if (result === 'cancelled') {
      out()
      out(c.gray('  cancelled — nothing was changed'))
      return 1
    }
    // Expired. Offering a fresh one beats making the user retype the command,
    // and it is the difference between "it timed out" and "it is broken".
    out()
    out(c.yellow('  that code expired'))
    if (!interactive()) return 1
    const again = (await question(`  make a new one? ${c.dim('[Y/n]')} `)).trim().toLowerCase()
    if (again === 'n' || again === 'no') return 1
  }
}

/** Resolves 'paired' | 'cancelled' | 'expired'. Always tidies its listeners. */
function waitForPairing(client, expiresAt) {
  out()
  out(c.gray('  waiting… (Ctrl-C to stop)'))
  return new Promise((resolve) => {
    let done = false
    const finish = (value) => {
      if (done) return
      done = true
      off()
      offCancel()
      if (timer) clearTimeout(timer)
      resolve(value)
    }
    const off = client.onEvent((channel, payload) => {
      if (channel !== 'mobile:statusChange') return
      // `paired` alone is true the moment the OFFER is stored, before any
      // phone has answered — claiming success there would be a lie. A real
      // handshake is what fills in the peer key.
      if (payload?.pairing?.peerPublicKey || payload?.tunnel?.peerPresent) finish('paired')
    })
    const offCancel = onCancel(() => finish('cancelled'))
    const remaining = expiresAt ? expiresAt - Date.now() : 0
    const timer = remaining > 0 ? setTimeout(() => finish('expired'), remaining + 500) : null
  })
}

// ── WhatsApp ────────────────────────────────────────────────────────────────

/**
 * Link WhatsApp — by phone number when asked, by QR otherwise, and by phone
 * number anyway when the QR will not fit.
 *
 * Refuses outright while an account is linked. `whatsapp:requestQr` is
 * harmless in that state (it only arms a flag) but it also does nothing, so
 * the old behaviour was to sit at "waiting for a code…" forever on a machine
 * that was already working perfectly.
 */
async function pairWhatsApp(client, rest) {
  heading('Link WhatsApp')

  const status = await client.invoke('whatsapp:status').catch(() => null)
  if (status?.status === 'connected') {
    out(
      `  ${icon.ok()} already linked${status.connectedName ? c.gray(` — ${status.connectedName}`) : ''}`
    )
    out(c.gray('  to link a different account, disconnect first:'))
    out(c.gray('    wolffish settings whatsapp   →   Disconnect'))
    return 0
  }

  const numberFlag = rest.findIndex((arg) => arg === '--number' || arg === '--code')
  let number = numberFlag >= 0 ? (rest[numberFlag + 1] ?? '') : null
  if (numberFlag >= 0 && !number) {
    if (!interactive()) return usage('wolffish pair whatsapp --number +15551234567')
    number = await question(
      `  ${c.bold('your WhatsApp number')} ${c.gray('(with country code)')}: `
    )
  }

  /**
   * The channel is enabled only once something is LINKED.
   *
   * Enabling up front left a cancelled attempt with `whatsapp.enabled = true`
   * and no session — a channel the app then keeps trying to start, and a
   * settings row that says On for something that was never connected. The
   * daemon needs it enabled to open a socket at all, so it is turned on for
   * the attempt and turned back off if the attempt does not finish.
   */
  const before = await client.invoke('whatsapp:getConfig').catch(() => null)
  const wasEnabled = before?.enabled === true
  await client.invoke('whatsapp:setConfig', { enabled: true }).catch(() => undefined)
  const restoreIfAbandoned = async () => {
    if (wasEnabled) return
    await client.invoke('whatsapp:setConfig', { enabled: false }).catch(() => undefined)
  }

  for (;;) {
    const outcome = number
      ? await linkByNumber(client, number)
      : await linkByQr(client, { allowFallback: interactive() })

    if (outcome === 'linked') {
      out(`${icon.ok()} ${c.green('WhatsApp linked')}`)
      return 0
    }
    if (outcome === 'cancelled') {
      await restoreIfAbandoned()
      out()
      out(c.gray('  cancelled — WhatsApp was left as it was'))
      return 1
    }
    if (outcome === 'needs-number') {
      out()
      out(wrapText(c.gray('Linking by phone number instead — it needs no picture.'), 2))
      number = await question(
        `  ${c.bold('your WhatsApp number')} ${c.gray('(with country code)')}: `
      )
      if (!number.trim()) return 1
      continue
    }
    // failed / expired
    if (!interactive()) {
      await restoreIfAbandoned()
      return 1
    }
    const again = (await question(`  try again? ${c.dim('[Y/n]')} `)).trim().toLowerCase()
    if (again === 'n' || again === 'no') {
      await restoreIfAbandoned()
      return 1
    }
    // A retry has to start from a clean socket, which is what a fresh request
    // does; nothing else is carried over.
  }
}

async function linkByNumber(client, number) {
  const result = await client
    .invoke('whatsapp:requestPairingCode', number.trim())
    .catch((error) => ({ ok: false, error: error?.message }))
  if (result?.ok === false) {
    err(`${icon.fail()} ${c.red(result.error ?? 'WhatsApp refused the request')}`)
    return 'failed'
  }
  out()
  out(c.gray('  asking WhatsApp for a code…'))
  return watchWhatsApp(client, {
    onCode: (code) => {
      out()
      out(`  ${c.bold(c.cyan(formatPairingCode(code)))}`)
      out()
      out(wrapText(c.gray('On your phone: WhatsApp → Settings → Linked devices →'), 2))
      out(wrapText(c.gray('Link a device → Link with phone number instead.'), 2))
      out(wrapText(c.gray('Type the code above. It is valid for about a minute.'), 2))
    }
  })
}

async function linkByQr(client, { allowFallback }) {
  await client.invoke('whatsapp:requestQr').catch(() => undefined)
  out(c.gray('  asking WhatsApp for a code…'))
  let fits = true
  const outcome = await watchWhatsApp(client, {
    onQr: async (qr) => {
      const drew = await printQr(client, qr)
      if (drew === 'drawn') {
        out()
        out(wrapText(c.gray('WhatsApp → Settings → Linked devices → Link a device'), 2))
      } else {
        fits = false
      }
    }
  })
  if (!fits && allowFallback && outcome !== 'linked') return 'needs-number'
  return outcome
}

/** WhatsApp codes are shown in two groups of four. */
function formatPairingCode(code) {
  const clean = String(code).replace(/\s+/g, '')
  return clean.length === 8 ? `${clean.slice(0, 4)}-${clean.slice(4)}` : clean
}

/**
 * Follow the channel until it links, fails, or the user gives up.
 *
 * Every branch resolves. The old version listened only for `connected` and for
 * a QR, which meant the two ways this actually ends on a server — the code
 * expiring, and WhatsApp rejecting the request — both left the terminal
 * printing "waiting" until it was killed.
 */
function watchWhatsApp(client, { onQr, onCode } = {}) {
  return new Promise((resolve) => {
    let done = false
    let shownQr = null
    let shownCode = null
    const finish = (value) => {
      if (done) return
      done = true
      off()
      offCancel()
      resolve(value)
    }
    const off = client.onEvent(async (channel, payload) => {
      if (channel === 'whatsapp:pairingCode' && onCode) {
        if (payload && payload !== shownCode) {
          shownCode = payload
          onCode(payload)
        }
        return
      }
      if (channel !== 'whatsapp:statusChange') return
      const state = payload?.status
      if (state === 'connected') return finish('linked')
      if (state === 'error') {
        err(`${icon.fail()} ${c.red(payload?.error ?? 'WhatsApp reported an error')}`)
        return finish('failed')
      }
      if (state === 'disconnected') {
        // Reached only after a code was shown: that is the expiry path.
        if (shownQr || shownCode) {
          out()
          out(c.yellow(`  ${payload?.error ?? 'the code expired'}`))
          return finish('expired')
        }
        return
      }
      if (payload?.pairingCode && onCode && payload.pairingCode !== shownCode) {
        shownCode = payload.pairingCode
        onCode(payload.pairingCode)
        return
      }
      if (payload?.qr && onQr && payload.qr !== shownQr) {
        shownQr = payload.qr
        await onQr(payload.qr)
      }
    })
    const offCancel = onCancel(() => finish('cancelled'))
    out(c.gray('  (Ctrl-C to stop)'))
  })
}

// ── Telegram ────────────────────────────────────────────────────────────────

async function pairTelegram(client) {
  heading('Telegram bot')
  out(wrapText(c.gray('Create a bot with @BotFather and paste its token below.'), 2))
  out()
  if (!interactive()) {
    err(c.red('  a token has to be typed — run this from a terminal'))
    err(c.gray('  or set it non-interactively: wolffish settings set channels.telegram.enabled on'))
    return 1
  }
  const token = await question(`  ${c.bold('bot token')} ${c.dim('(hidden)')}: `, { hidden: true })
  if (!token.trim()) {
    out(c.yellow('  nothing entered — unchanged'))
    return 1
  }
  // A token that is not shaped like one never reaches the network: BotFather
  // issues `<digits>:<35 or so of base64-ish>`, and pasting a truncated copy is
  // the common mistake. Failing here names the problem; failing at Telegram
  // returns "401 Unauthorized", which does not.
  if (!/^\d{6,}:[A-Za-z0-9_-]{30,}$/.test(token.trim())) {
    err(`${icon.fail()} ${c.red('that does not look like a bot token')}`)
    err(c.gray('  BotFather issues them as 123456789:AA... — check for a truncated paste'))
    return 1
  }
  const result = await client.invoke('telegram:setConfig', {
    botToken: token.trim(),
    enabled: true
  })
  if (result?.ok === false) {
    err(`${icon.fail()} ${c.red(result.error ?? 'failed')}`)
    return 1
  }
  out(`${icon.ok()} token saved — starting the bot`)
  return waitForTelegram(client)
}

/**
 * Say whether the bot actually came up. Saving a token that Telegram rejects
 * used to print a tick and exit 0, and the failure only surfaced later as
 * silence from a channel the user believed was connected.
 */
function waitForTelegram(client) {
  return new Promise((resolve) => {
    let done = false
    const finish = (code) => {
      if (done) return
      done = true
      off()
      offCancel()
      clearTimeout(timer)
      resolve(code)
    }
    const off = client.onEvent((channel, payload) => {
      if (channel !== 'telegram:statusChange') return
      if (payload?.status === 'connected' || payload?.connected === true) {
        out(
          `${icon.ok()} ${c.green(`connected${payload.username ? ` as @${payload.username}` : ''}`)}`
        )
        finish(0)
      } else if (payload?.status === 'error' || payload?.error) {
        err(`${icon.fail()} ${c.red(String(payload.error ?? 'Telegram rejected the token'))}`)
        finish(1)
      }
    })
    const offCancel = onCancel(() => finish(1))
    // Bounded: a bot that has not answered in fifteen seconds is a story for
    // `wolffish status`, not a reason to hold the terminal.
    const timer = setTimeout(() => {
      out(c.gray('  still starting — check it with: wolffish status'))
      finish(0)
    }, 15000)
  })
}

function usage(line) {
  err(c.red(`usage: ${line}`))
  return 2
}
