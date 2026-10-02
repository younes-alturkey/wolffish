/**
 * The QR a PACKAGED install draws — through the daemon, not a local import.
 *
 * In a packaged app the CLI is loose source next to app.asar while `qrcode`
 * lives inside the archive, so the CLI's own `import('qrcode')` fails on
 * every platform and `wolffish pair` printed "no QR renderer available"
 * forever. The fix routes the matrix through `cli:qrMatrix`, answered by the
 * daemon from inside the archive. What this file guards:
 *
 *  - the handler's matrix is EXACTLY the one a local import builds — same
 *    size, same modules — so the two routes can never draw different codes;
 *  - the real pair flow, run from a copy of src/cli with no node_modules
 *    above it (the packaged layout), draws through the daemon route;
 *  - against a daemon without the channel it degrades to the old text
 *    fallback instead of dying — the mid-upgrade window, where a fresh CLI
 *    talks to a daemon started before the update landed;
 *  - the in-repo (dev) flow still draws with no daemon help at all.
 *
 * Run: TSX_TSCONFIG_PATH=tsconfig.node.json npx tsx \
 *        src/main/channels/__tests__/cli-qr.test.ts
 */
/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any */
const Module = require('node:module')
const origLoad = Module._load
const APP = require('node:path').resolve(__dirname, '../../../..')
Module._load = function (request: string, ...rest: unknown[]) {
  if (request === 'electron') {
    return {
      app: { getVersion: () => '0.0.0-test', getAppPath: () => APP, getPath: () => home },
      ipcMain: { handle: () => undefined },
      BrowserWindow: { getAllWindows: () => [], getFocusedWindow: () => null },
      dialog: {}
    }
  }
  if (request === '@electron-toolkit/utils') return { is: { dev: true } }
  return origLoad.call(this, request, ...rest)
}

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'wolffish-qr-'))
const ws = path.join(home, '.wolffish', 'workspace')
fs.mkdirSync(ws, { recursive: true })
fs.writeFileSync(
  path.join(ws, 'config.json'),
  JSON.stringify({
    version: 1,
    llm: { mode: 'single', local: {}, providers: [], brain: {} },
    safety: {}
  })
)
;(os as { homedir: () => string }).homedir = () => home

// The packaged layout, faithfully: the CLI as loose files with NO node_modules
// in any ancestor directory — os.tmpdir() guarantees that on every platform.
const cliCopy = path.join(home, 'cli-copy')
fs.cpSync(path.join(APP, 'src/cli'), cliCopy, { recursive: true })

// A WhatsApp-shaped payload: ref plus base64 keys, byte-mode dense.
const PAYLOAD =
  '2@' +
  Array.from({ length: 178 }, (_, i) => {
    const cs = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
    return cs[(i * 7 + 3) % 64]
  }).join('')

let failures = 0
const check = (name: string, condition: boolean, detail = ''): void => {
  if (condition) console.log(`PASS  ${name}`)
  else {
    failures++
    console.log(`FAIL  ${name}${detail ? `\n      ${detail}` : ''}`)
  }
}

/** The size gate must not be what a headless test run trips over. */
function fakeTerminal(): void {
  for (const [name, value] of [
    ['columns', 120],
    ['rows', 60]
  ] as const) {
    try {
      Object.defineProperty(process.stdout, name, { value, configurable: true })
    } catch {
      // a real TTY that refuses the override — the run stays honest, just
      // window-sized; keep the window large when running this by hand
    }
  }
  try {
    Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true })
  } catch {
    // as above
  }
}

type Handler = (...args: any[]) => any

/**
 * A client the way pair.mjs sees one: invoke + onEvent. `whatsapp:requestQr`
 * schedules the QR event, and the terminal event decides how the flow ends —
 * 'connected' for the drawn paths, 'disconnected' for the fallback path,
 * which must finish WITHOUT a prompt (stdin is forced non-interactive above).
 */
type FakeClient = {
  onEvent: (listener: (channel: string, payload: unknown) => void) => () => void
  invoke: (channel: string, ...args: unknown[]) => Promise<unknown>
}

function makeClient(
  handlers: Map<string, Handler>,
  { qrChannel, endWith }: { qrChannel: 'real' | 'missing'; endWith: 'connected' | 'disconnected' }
): FakeClient {
  const listeners = new Set<(channel: string, payload: unknown) => void>()
  const emit = (channel: string, payload: unknown): void => {
    for (const listener of listeners) void listener(channel, payload)
  }
  return {
    onEvent(listener: (channel: string, payload: unknown) => void) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    async invoke(channel: string, ...args: unknown[]) {
      if (channel === 'whatsapp:status') return { status: 'disconnected' }
      if (channel === 'whatsapp:getConfig') return { enabled: false }
      if (channel === 'whatsapp:setConfig') return { ok: true }
      if (channel === 'whatsapp:requestQr') {
        setTimeout(() => emit('whatsapp:statusChange', { status: 'pending', qr: PAYLOAD }), 20)
        setTimeout(
          () =>
            emit(
              'whatsapp:statusChange',
              endWith === 'connected'
                ? { status: 'connected' }
                : { status: 'disconnected', error: 'test: code expired' }
            ),
          400
        )
        return undefined
      }
      if (channel === 'cli:qrMatrix') {
        if (qrChannel === 'missing') throw new Error(`unknown channel: ${channel}`)
        return handlers.get('cli:qrMatrix')!(null, ...args)
      }
      return null
    }
  }
}

/** Run one pair flow with stdout captured; returns its output and exit code. */
async function captured(fn: () => Promise<unknown>): Promise<{ text: string; code: unknown }> {
  const real = process.stdout.write.bind(process.stdout)
  let text = ''
  ;(process.stdout as any).write = (chunk: unknown): boolean => {
    text += String(chunk)
    return true
  }
  try {
    const code = await fn()
    return { text, code }
  } finally {
    ;(process.stdout as any).write = real
  }
}

async function main(): Promise<void> {
  const { registerCliIpc } = await import('@main/channels/cli/ipc')
  const { default: QRCode } = await import('qrcode')

  const handlers = new Map<string, Handler>()
  registerCliIpc({
    handle: (channel: string, listener: any) => handlers.set(channel, listener),
    handlers: new Map(),
    channel: {} as any,
    server: {} as any,
    snapshot: async () => ({}),
    broadcast: () => undefined,
    status: async () => ({}),
    execPath: '',
    cliEntry: '',
    autostart: {
      enable: async () => ({ active: true, mechanism: 'x', warning: null, location: null }),
      disable: async () => ({ active: false, mechanism: 'x', warning: null, location: null }),
      read: async () => ({ active: true, mechanism: 'x', warning: null, location: null })
    }
  } as never)

  // ── The handler's matrix is the local import's matrix ────────────────────
  const result = handlers.get('cli:qrMatrix')!(null, PAYLOAD)
  const direct = QRCode.create(PAYLOAD, { errorCorrectionLevel: 'L' })
  const size = direct.modules.size
  check('handler answers ok', result?.ok === true, JSON.stringify(result)?.slice(0, 200))
  check('same module count', result?.size === size, `handler ${result?.size} vs qrcode ${size}`)
  const identical =
    result?.ok === true &&
    result.rows.length === size &&
    result.rows.every(
      (row: string, y: number) =>
        row.length === size &&
        row
          .split('')
          .every((cell, x) => (cell === '1') === Boolean(direct.modules.data[y * size + x]))
    )
  check('identical modules', identical)
  const empty = handlers.get('cli:qrMatrix')!(null, '')
  check('empty text is a refusal, not a throw', empty?.ok === false, JSON.stringify(empty))

  // ── The packaged flow draws through the daemon ───────────────────────────
  fakeTerminal()
  const packaged = await import(path.join(cliCopy, 'commands', 'pair.mjs'))

  const drawn = await captured(() =>
    packaged.pair(makeClient(handlers, { qrChannel: 'real', endWith: 'connected' }), ['whatsapp'])
  )
  check('packaged: exits linked', drawn.code === 0, `code ${String(drawn.code)}`)
  check('packaged: drew the QR', /[█▀▄]/.test(drawn.text), drawn.text.slice(0, 400))
  check('packaged: shows the scan caption', /Linked devices/.test(drawn.text), drawn.text)
  check('packaged: no renderer complaint', !/no QR renderer/.test(drawn.text), drawn.text)

  // ── An old daemon degrades to the text fallback ──────────────────────────
  const fallback = await captured(() =>
    packaged.pair(makeClient(handlers, { qrChannel: 'missing', endWith: 'disconnected' }), [
      'whatsapp'
    ])
  )
  check('old daemon: exits without linking', fallback.code === 1, `code ${String(fallback.code)}`)
  check('old daemon: falls back to text', /no QR renderer/.test(fallback.text), fallback.text)
  check('old daemon: payload still shown', fallback.text.includes(PAYLOAD), fallback.text)

  // ── Dev still draws with no daemon at all ────────────────────────────────
  const dev = await import(path.join(APP, 'src/cli/commands/pair.mjs'))
  const local = await captured(() =>
    dev.pair(makeClient(handlers, { qrChannel: 'missing', endWith: 'connected' }), ['whatsapp'])
  )
  check('dev: exits linked', local.code === 0, `code ${String(local.code)}`)
  check('dev: drew the QR locally', /[█▀▄]/.test(local.text), local.text.slice(0, 400))
  check('dev: no renderer complaint', !/no QR renderer/.test(local.text), local.text)

  console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILED`}`)
  fs.rmSync(home, { recursive: true, force: true })
  process.exit(failures === 0 ? 0 : 1)
}

void main().catch((error) => {
  console.error(error)
  process.exit(1)
})
