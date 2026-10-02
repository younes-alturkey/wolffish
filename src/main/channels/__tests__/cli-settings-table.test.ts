/**
 * The settings table's silent failure modes.
 *
 * A row whose `channel` names a handler that does not exist looks fine in the
 * listing and does nothing when written. A row whose `read` path is not in the
 * config snapshot renders "—" forever and reads as "not configured" when it
 * may well be set. A row whose LABEL collides with another on the same card is
 * indistinguishable from it — which is exactly what shipped: four rows reading
 * "Show all tool activity" in one flat list, one per channel, with nothing to
 * say which was WhatsApp's. None of the three throws, none is visible without
 * checking, and all are one edit away at all times — so all three are checked
 * against the real sources rather than trusted.
 *
 * Run: TSX_TSCONFIG_PATH=tsconfig.node.json npx tsx \
 *        src/main/channels/__tests__/cli-settings-table.test.ts
 */
/* eslint-disable @typescript-eslint/no-require-imports */
// The snapshot builder reaches electron for app.getVersion(); under tsx that
// import resolves to the binary path string. Stub it BEFORE anything loads,
// the same way the live e2e harnesses do.
const Module = require('node:module')
const origLoad = Module._load
Module._load = function (request: string, ...rest: unknown[]) {
  if (request === 'electron') return { app: { getVersion: () => '0.0.0-test' } }
  return origLoad.call(this, request, ...rest)
}

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  CLI_SETTINGS,
  CLI_SETTING_GROUPS,
  CLI_SETTING_SECTIONS,
  coerceSettingValue,
  settingArgs
} from '@main/channels/cli/settings'

let passed = 0
let failed = 0
function check(name: string, fn: () => void): void {
  try {
    fn()
    passed++
    console.log(`PASS  ${name}`)
  } catch (err) {
    failed++
    console.log(`FAIL  ${name}\n      ${err instanceof Error ? err.message : String(err)}`)
  }
}

const ROOT = path.resolve(__dirname, '../../../..')

/** Every channel registered anywhere in main, however the call is formatted. */
function registeredChannels(): Set<string> {
  const found = new Set<string>()
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules') continue
        walk(full)
      } else if (entry.name.endsWith('.ts')) {
        const body = fs.readFileSync(full, 'utf8')
        for (const m of body.matchAll(/\bhandle\(\s*'([^']+)'/g)) found.add(m[1])
      }
    }
  }
  walk(path.join(ROOT, 'src', 'main'))
  return found
}

/**
 * Key paths the config snapshot ACTUALLY produces — by building one, not by
 * parsing its source. An earlier version read the file and reported two false
 * failures: an object written inline on one line, and a field added by a
 * conditional spread. Neither is visible to a line-based parser, and both are
 * perfectly real at runtime. Asserting against the genuine article is both
 * stricter and honest.
 */
async function snapshotPaths(): Promise<Set<string>> {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'wolffish-settings-'))
  const workspace = path.join(home, '.wolffish', 'workspace')
  fs.mkdirSync(workspace, { recursive: true })
  // A config with every optional section present, so nothing is missing merely
  // because this machine has not configured it.
  fs.writeFileSync(
    path.join(workspace, 'config.json'),
    JSON.stringify({
      version: 1,
      launchAtStartup: true,
      llm: { local: {}, providers: [], brain: {}, restrictPowerfulModels: true },
      safety: {},
      updates: {},
      inapp: {},
      cli: {},
      mobile: {},
      telegram: {},
      whatsapp: {},
      brave: {},
      video: {},
      memes: { imgflip: {}, giphy: {} },
      stt: {},
      tts: {},
      computerUse: {},
      browserExtension: {},
      reflection: {},
      compaction: {},
      mcp: { servers: [] },
      notion: { connections: [] },
      github: { connections: [] },
      google: {}
    })
  )
  const realHome = os.homedir
  ;(os as { homedir: () => string }).homedir = () => home

  const { buildConfigSnapshot } = await import('@main/channels/mobile/snapshot')
  const snapshot = await buildConfigSnapshot({
    serializeCapabilities: async () => [],
    launchAtStartupActive: async () => true
  } as never)

  ;(os as { homedir: () => string }).homedir = realHome
  fs.rmSync(home, { recursive: true, force: true })

  const paths = new Set<string>()
  const walk = (node: unknown, prefix: string): void => {
    if (node === null || typeof node !== 'object' || Array.isArray(node)) return
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      const full = prefix ? `${prefix}.${key}` : key
      paths.add(full)
      walk(value, full)
    }
  }
  walk(snapshot, '')
  return paths
}

async function main(): Promise<void> {
  const channels = registeredChannels()
  const paths = await snapshotPaths()

  check('every setting writes to a channel that is actually registered', () => {
    const missing = CLI_SETTINGS.filter((s) => !channels.has(s.channel)).map(
      (s) => `${s.id} → ${s.channel}`
    )
    assert.deepEqual(
      missing,
      [],
      `these would silently do nothing:\n      ${missing.join('\n      ')}`
    )
  })

  check('every setting reads a path the config snapshot produces', () => {
    const missing = CLI_SETTINGS.filter((s) => !paths.has(s.read)).map((s) => `${s.id} ← ${s.read}`)
    assert.deepEqual(
      missing,
      [],
      `these would read "—" forever:\n      ${missing.join('\n      ')}`
    )
  })

  check('the launchAtStartup mismatch probe reads a real path too', () => {
    for (const setting of CLI_SETTINGS) {
      if (!setting.actualRead) continue
      assert.ok(paths.has(setting.actualRead), `${setting.id} → ${setting.actualRead}`)
    }
  })

  check('ids are unique', () => {
    const seen = new Set<string>()
    const dupes: string[] = []
    for (const s of CLI_SETTINGS) {
      if (seen.has(s.id)) dupes.push(s.id)
      seen.add(s.id)
    }
    assert.deepEqual(dupes, [])
  })

  check('every setting belongs to a declared page', () => {
    const known = new Set(CLI_SETTING_GROUPS.map((g) => g.id))
    const orphans = CLI_SETTINGS.filter((s) => !known.has(s.group)).map((s) => s.id)
    assert.deepEqual(orphans, [])
  })

  check('every setting belongs to a declared card, on its own page', () => {
    const sections = new Map(CLI_SETTING_SECTIONS.map((s) => [s.id, s]))
    const wrong = CLI_SETTINGS.filter((s) => sections.get(s.section)?.group !== s.group).map(
      (s) => `${s.id} → ${s.section}`
    )
    assert.deepEqual(wrong, [], `orphaned or cross-page:\n      ${wrong.join('\n      ')}`)
  })

  check('every card belongs to a declared page', () => {
    const known = new Set(CLI_SETTING_GROUPS.map((g) => g.id))
    const orphans = CLI_SETTING_SECTIONS.filter((s) => !known.has(s.group)).map((s) => s.id)
    assert.deepEqual(orphans, [])
  })

  check('every page has rows, or is declared interactive', () => {
    const dead = CLI_SETTING_GROUPS.filter(
      (g) => !g.interactive && !CLI_SETTINGS.some((s) => s.group === g.id)
    ).map((g) => g.id)
    assert.deepEqual(dead, [], 'a page with nothing on it is a dead menu entry')
  })

  /**
   * The CLI's flows are pinned to these card ids from the other side of the
   * repo. A typo there does not throw and does not warn — the flow simply
   * never appears on any card, and the only way to notice is to go looking
   * for a button that is missing. Both halves are checked together because
   * neither half can check it alone.
   */
  const { ACTIONS } = (await import('../../../cli/commands/settings-actions.mjs')) as {
    ACTIONS: Array<{ section: string; label: string; run: unknown }>
  }

  check('every CLI flow is pinned to a card that exists', () => {
    const known = new Set(CLI_SETTING_SECTIONS.map((s) => s.id))
    const orphans = ACTIONS.filter((a) => !known.has(a.section)).map(
      (a) => `${a.section} — "${a.label}"`
    )
    assert.deepEqual(orphans, [], `these would never render:\n      ${orphans.join('\n      ')}`)
  })

  check('every card holds something — a row or a flow', () => {
    const withFlows = new Set(ACTIONS.map((a) => a.section))
    const empty = CLI_SETTING_SECTIONS.filter(
      (section) => !withFlows.has(section.id) && !CLI_SETTINGS.some((s) => s.section === section.id)
    ).map((s) => s.id)
    assert.deepEqual(empty, [], 'an empty card is a dead menu entry')
  })

  check('every flow has a label and something to run', () => {
    const broken = ACTIONS.filter((a) => !a.label || typeof a.run !== 'function').map(
      (a) => a.section
    )
    assert.deepEqual(broken, [])
  })

  /**
   * The rows' channels are checked above; the FLOWS invoke channels too, by
   * string literal, and a typo there fails exactly as quietly — the flow runs,
   * the daemon rejects an unknown channel, and the catch turns it into an empty
   * list or a shrug. Scanned from the source rather than the module because the
   * strings live inside closures that only run when a user opens that card.
   *
   * Literals only: a handful are composed (`${kind}:install`), and those two
   * prefixes are covered by their siblings in the same file.
   */
  check('every channel the CLI flows name is actually registered', () => {
    const source = fs.readFileSync(
      path.join(ROOT, 'src', 'cli', 'commands', 'settings-actions.mjs'),
      'utf8'
    )
    const named = new Set<string>()
    for (const match of source.matchAll(/'([a-z][a-zA-Z]*:[a-zA-Z][a-zA-Z0-9]*)'/g)) {
      // `node:crypto` is the same shape as a channel and is an import.
      if (!match[1].startsWith('node:')) named.add(match[1])
    }
    /**
     * Names a flow only LISTENS for are not handlers and must not be required
     * to be one. `google:authUrl` is the case: the consent URL arrives as a
     * broadcast while `google:authAdd` is still pending, so the flow compares
     * it inside an onEvent listener. Recognised by that comparison rather than
     * by an allowlist, so a genuine typo in an invoke is still caught.
     */
    for (const match of source.matchAll(
      /channel\s*(?:!==|===)\s*'([a-z][a-zA-Z]*:[a-zA-Z][a-zA-Z0-9]*)'/g
    )) {
      named.delete(match[1])
    }
    const missing = [...named].filter((channel) => !channels.has(channel)).sort()
    assert.deepEqual(missing, [], `no handler for:\n      ${missing.join('\n      ')}`)
  })

  /**
   * The reported bug, as an assertion.
   *
   * Labels are CARD-SCOPED in this app: "Status" and "Show all tool activity"
   * are unambiguous inside a Telegram card and meaningless in a flat list of
   * every setting. Two rows on ONE card that render identically cannot be told
   * apart at all.
   */
  check('no two rows on the same card render the same label', () => {
    const seen = new Map<string, string>()
    const collisions: string[] = []
    for (const setting of CLI_SETTINGS) {
      const key = `${setting.section} ${setting.label.toLowerCase()}`
      const previous = seen.get(key)
      if (previous)
        collisions.push(`${setting.section} · "${setting.label}" — ${previous} and ${setting.id}`)
      else seen.set(key, setting.id)
    }
    assert.deepEqual(
      collisions,
      [],
      `indistinguishable rows:\n      ${collisions.join('\n      ')}`
    )
  })

  /**
   * A label that prefixes its own card ("Telegram · Status" inside the
   * Telegram card) is the flat-list habit surviving the move to cards. It is
   * not wrong, only redundant, and redundancy in a 46-column label costs the
   * value its room.
   *
   * Matched on the SEPARATOR, not on the bare prefix: "Chat mode" on the Chat
   * card is a real label that happens to start with the card's name, and a
   * check that flags it is a check nobody will keep.
   */
  check('no label re-states the card it sits on', () => {
    const sections = new Map(CLI_SETTING_SECTIONS.map((s) => [s.id, s]))
    const repeats = CLI_SETTINGS.filter((setting) => {
      const card = sections.get(setting.section)?.label ?? ''
      if (card.length < 2) return false
      return new RegExp(`^${card.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*[·:\\-]\\s`, 'i').test(
        setting.label
      )
    }).map((s) => `${s.id} → "${s.label}"`)
    assert.deepEqual(
      repeats,
      [],
      `the card heading already says it:\n      ${repeats.join('\n      ')}`
    )
  })

  check('enum settings declare their options', () => {
    const bare = CLI_SETTINGS.filter((s) => s.kind === 'enum' && !s.options?.length).map(
      (s) => s.id
    )
    assert.deepEqual(bare, [])
  })

  check('every setting has a label, and no label is a dotted id', () => {
    const bare = CLI_SETTINGS.filter(
      (s) => !s.label || s.label.length === 0 || /^[a-z]+(\.[a-zA-Z]+)+$/.test(s.label)
    ).map((s) => s.id)
    assert.deepEqual(bare, [], 'a row must read as words, never as a key')
  })

  // A dotted wrap is how a nested partial (`{ giphy: { apiKey: 'k' } }`)
  // reaches a handler. Getting it wrong writes a top-level key the handler
  // ignores — a save that reports success and changes nothing.
  check('a dotted wrap builds the nested partial the handler expects', () => {
    const giphy = CLI_SETTINGS.find((s) => s.id === 'services.memes.giphyApiKey')
    assert.ok(giphy)
    assert.deepEqual(settingArgs(giphy, 'k'), [{ giphy: { apiKey: 'k' } }])
    const bare = CLI_SETTINGS.find((s) => s.id === 'wolffish.blockCredentials')
    assert.ok(bare)
    assert.deepEqual(settingArgs(bare, true), [true])
  })

  check('booleans refuse anything that is not clearly a yes or a no', () => {
    const setting = CLI_SETTINGS.find((s) => s.id === 'wolffish.bypassPermissions')
    assert.ok(setting)
    for (const yes of ['on', 'true', 'YES', '1']) {
      assert.deepEqual(coerceSettingValue(setting, yes), { ok: true, value: true }, yes)
    }
    for (const no of ['off', 'false', 'NO', '0']) {
      assert.deepEqual(coerceSettingValue(setting, no), { ok: true, value: false }, no)
    }
    assert.equal(coerceSettingValue(setting, 'maybe').ok, false)
  })

  check('numeric enums travel as numbers, text enums as text', () => {
    const hour = CLI_SETTINGS.find((s) => s.id === 'knowledge.reflection.hour')
    assert.ok(hour)
    assert.deepEqual(coerceSettingValue(hour, '3'), { ok: true, value: 3 })
    const theme = CLI_SETTINGS.find((s) => s.id === 'appearance.theme')
    assert.ok(theme)
    assert.deepEqual(coerceSettingValue(theme, 'dark'), { ok: true, value: 'dark' })
    assert.equal(coerceSettingValue(theme, 'neon').ok, false)
  })

  console.log(
    `\n${CLI_SETTINGS.length} settings across ${CLI_SETTING_GROUPS.length} pages, ` +
      `${CLI_SETTING_SECTIONS.length} cards`
  )
  for (const group of CLI_SETTING_GROUPS) {
    const n = CLI_SETTINGS.filter((s) => s.group === group.id).length
    const cards = CLI_SETTING_SECTIONS.filter((s) => s.group === group.id).length
    console.log(
      `  ${group.id.padEnd(12)} ${String(n).padStart(2)} in ${cards} ${cards === 1 ? 'card ' : 'cards'}` +
        (group.interactive ? '  (flows)' : '')
    )
  }
  console.log(`\n${passed} passed, ${failed} failed`)
  if (failed > 0) process.exitCode = 1
}

void main()
