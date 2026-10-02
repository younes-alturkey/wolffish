/**
 * Cross-surface parity for the `offer_options` card.
 *
 * The card's whole content lives in the tool CALL's args, and SIX independent
 * places re-read those args to draw it: the plugin (which letters the options
 * in the output the model reads back), the main-process helpers the text
 * channels use, the desktop card, the mobile card, the CLI store, and the PDF
 * export. They can only stay honest if they agree — if the desktop drops an
 * option the plugin counted, the model's "option C" points at the user's D,
 * and nothing anywhere fails loudly. So this pins:
 *
 *   1. The letter scheme (A…Z, AA, AB …) — every implementation must produce
 *      the same letter for the same position.
 *   2. The parser's tolerance — a bare string option, the `label`/`code`/
 *      `text`/`value` synonyms, and the entries that must be DROPPED (no
 *      content) — identical across every surface, since a dropped entry
 *      shifts every letter after it.
 *   3. The fencing rule — a `language` fences the content here, not in the
 *      model's text, with a fence long enough to survive content that carries
 *      its own fences.
 *   4. The desktop card's duplicate-copy-button rule — it drops its own copy
 *      button exactly when the body is one code block (whose `pre` already
 *      has one). Hiding it wrongly leaves an option uncopyable.
 *   5. The plugin's own contract: 2+ options required, a short output that
 *      never echoes the contents back into the model's context.
 *
 * The real implementations are imported wherever they are importable from
 * node (the plugin, cerebellum); the renderer copies (desktop / mobile / CLI /
 * PDF) are TSX or live in the other repo, so their functions are re-derived
 * from source text here — a drifted copy fails this test rather than shipping.
 *
 * Run: TSX_TSCONFIG_PATH=tsconfig.node.json npx tsx src/main/channels/__tests__/options-card.test.ts
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { optionLetter, parseOfferedOptions } from '../../runtime/cerebellum'
import { renderOptionsForChannel } from '../options-render'
// The real options capability plugin (ES module, same file the runtime loads).
import optionsPlugin from '../../../defaults/workspace/brain/cerebellum/options/plugin/index.mjs'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..')
const MOBILE = path.resolve(REPO, '../wolffish-mobile')

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

/** One function's source text, sliced out by balancing braces from its
 *  declaration to its closing brace. */
function sliceFunction(src: string, name: string, file: string): string {
  const start = src.search(new RegExp(`function ${name}\\(`))
  if (start < 0) throw new Error(`${name} not found in ${file}`)
  const open = src.indexOf('{', start)
  let depth = 0
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++
    else if (src[i] === '}') {
      depth--
      if (depth === 0) return src.slice(start, i + 1)
    }
  }
  throw new Error(`unbalanced ${name} in ${file}`)
}

/**
 * Pull functions' SOURCE out of a renderer file and evaluate them together in
 * one scope, so each copy is tested AS WRITTEN rather than as re-typed here —
 * a drifted copy fails this test instead of shipping. `want` is the function
 * to return; `deps` are the helpers it calls, evaluated alongside it.
 *
 * Returns null when the file is missing (the mobile repo is not checked out in
 * CI), so the suite degrades to "one surface unverified" rather than failing
 * for the wrong reason.
 */
function extractFunction<T>(file: string, want: string, deps: string[] = []): T | null {
  if (!fs.existsSync(file)) return null
  const src = fs.readFileSync(file, 'utf8')
  const bodies = [...deps, want].map((name) => sliceFunction(src, name, file)).join('\n')
  // Strip the TypeScript annotations plain eval can't parse. The bodies under
  // test are deliberately simple enough for this to be exact.
  const js = bodies
    .replace(/: OptionItem\[\] = \[\]/g, ' = []')
    .replace(/: OptionItem\[\]/g, '')
    .replace(/: OptionItem\b/g, '')
    .replace(/: Record<string, unknown>/g, '')
    .replace(/ as Record<string, unknown>/g, '')
    .replace(/\(v: unknown\)/g, '(v)')
    .replace(/: string\b/g, '')
    .replace(/: number\b/g, '')
    .replace(/: unknown\b/g, '')
    .replace(/: boolean\b/g, '')

  return new Function(`${js}; return ${want}`)() as T
}

const DESKTOP_CARD = path.join(
  REPO,
  'src/renderer/src/components/common/options-card/OptionsCard.tsx'
)
const MOBILE_CARD = path.join(MOBILE, 'src/components/chat/OptionsCard.tsx')
const CLI_STORE = path.join(REPO, 'src/cli/tui/store.ts')
const PDF_EXPORT = path.join(REPO, 'src/renderer/src/lib/chat-export/buildChatPdfHtml.tsx')

async function run(): Promise<void> {
  /* ── 1. the letter scheme, in every implementation ────────────────── */
  const EXPECTED = ['A', 'B', 'Z', 'AA', 'AB', 'AZ', 'BA', 'ZZ', 'AAA']
  const POSITIONS = [0, 1, 25, 26, 27, 51, 52, 701, 702]

  ok(
    'letters: cerebellum',
    POSITIONS.map(optionLetter).join(' ') === EXPECTED.join(' '),
    POSITIONS.map(optionLetter).join(' ')
  )

  const letterCopies: Array<[string, string]> = [
    ['desktop card', DESKTOP_CARD],
    ['mobile card', MOBILE_CARD],
    ['cli store', CLI_STORE],
    ['pdf export', PDF_EXPORT],
    ['plugin', path.join(REPO, 'src/defaults/workspace/brain/cerebellum/options/plugin/index.mjs')]
  ]
  for (const [label, file] of letterCopies) {
    const fn = extractFunction<(i: number) => string>(file, 'optionLetter')
    if (!fn) {
      console.warn(`SKIP letters: ${label} (file not present)`)
      continue
    }
    const got = POSITIONS.map(fn).join(' ')
    ok(`letters: ${label}`, got === EXPECTED.join(' '), got)
  }

  /* ── 2. parser tolerance, identical on every surface ──────────────── */
  // Deliberately mixed: the documented shape, a bare string, each synonym,
  // and three entries that MUST be dropped — a dropped entry shifts every
  // letter after it, which is exactly the silent failure this guards.
  const ARGS = {
    title: 'mixed',
    options: [
      { title: 'Documented', description: 'the real shape', language: 'ts', content: 'a' },
      'bare string',
      { label: 'Label synonym', code: 'b' },
      { title: 'Text synonym', text: 'c' },
      { title: 'Value synonym', value: 'd', lang: 'sql' },
      { title: 'No content at all' },
      { title: 'Blank content', content: '   ' },
      null,
      42,
      { title: 'Last', content: 'e' }
    ]
  }
  const EXPECT_TITLES = [
    'Documented',
    'Option B',
    'Label synonym',
    'Text synonym',
    'Value synonym',
    'Last'
  ]
  const EXPECT_CONTENT = ['a', 'bare string', 'b', 'c', 'd', 'e']
  const EXPECT_LANG = ['ts', undefined, undefined, undefined, 'sql', undefined]

  const shared = parseOfferedOptions(ARGS)
  ok(
    'parse: cerebellum titles',
    shared.map((o) => o.title).join('|') === EXPECT_TITLES.join('|'),
    shared.map((o) => o.title).join('|')
  )
  ok(
    'parse: cerebellum content',
    shared.map((o) => o.content).join('|') === EXPECT_CONTENT.join('|'),
    shared.map((o) => o.content).join('|')
  )
  ok(
    'parse: cerebellum language',
    shared.map((o) => o.language).join('|') === EXPECT_LANG.join('|'),
    shared.map((o) => o.language).join('|')
  )

  type Parsed = { title: string; content: string; language?: string }
  // Each copy names the helpers its parser calls: the two cards share an
  // `asString`, the CLI store inlines a `str` arrow instead.
  const parserCopies: Array<[string, string, string, string[]]> = [
    ['desktop card', DESKTOP_CARD, 'parseOptions', ['asString', 'optionLetter']],
    ['mobile card', MOBILE_CARD, 'parseOptionItems', ['asString', 'optionLetter']],
    ['cli store', CLI_STORE, 'parseOptionItems', ['optionLetter']]
  ]
  for (const [label, file, name, deps] of parserCopies) {
    const fn = extractFunction<(raw: unknown) => Parsed[]>(file, name, deps)
    if (!fn) {
      console.warn(`SKIP parse: ${label} (file not present)`)
      continue
    }
    const got = fn(ARGS.options)
    ok(
      `parse: ${label} titles`,
      got.map((o) => o.title).join('|') === EXPECT_TITLES.join('|'),
      got.map((o) => o.title).join('|')
    )
    ok(
      `parse: ${label} content`,
      got.map((o) => o.content).join('|') === EXPECT_CONTENT.join('|'),
      got.map((o) => o.content).join('|')
    )
    ok(
      `parse: ${label} language`,
      got.map((o) => o.language).join('|') === EXPECT_LANG.join('|'),
      got.map((o) => o.language).join('|')
    )
  }

  /* ── 3. the fencing rule ──────────────────────────────────────────── */
  type Option = { title: string; language?: string; content: string }
  const FENCE_CASES: Array<[Option, string]> = [
    [{ title: 'plain md', content: '# hello' }, '# hello'],
    [{ title: 'code', language: 'ts', content: 'const a = 1' }, '```ts\nconst a = 1\n```'],
    // Content carrying its own triple fence needs a LONGER outer fence, or the
    // inner one closes the block early and the rest leaks as prose.
    [
      { title: 'nested fence', language: 'md', content: 'see:\n```js\nx\n```' },
      '````md\nsee:\n```js\nx\n```\n````'
    ],
    [
      { title: 'quad fence', language: 'md', content: '````\ny\n````' },
      '`````md\n````\ny\n````\n`````'
    ]
  ]
  const fenceCopies: Array<[string, string]> = [
    ['desktop card', DESKTOP_CARD],
    ['mobile card', MOBILE_CARD]
  ]
  for (const [label, file] of fenceCopies) {
    const fn = extractFunction<(o: Option) => string>(file, 'bodyMarkdown')
    if (!fn) {
      console.warn(`SKIP fence: ${label} (file not present)`)
      continue
    }
    for (const [option, want] of FENCE_CASES) {
      const got = fn(option)
      ok(`fence: ${label} — ${option.title}`, got === want, JSON.stringify(got))
    }
  }

  /* ── 3b. the desktop card's duplicate-copy-button rule ────────────── */
  // The Markdown renderer hovers a copy button over every `pre`, so the card
  // adds one of its own ONLY for bodies that have none. Getting this wrong in
  // the hiding direction leaves an option with no way to copy it at all, so
  // the predicate is pinned here rather than left to the eye.
  type LoneCase = { title: string; language?: string; content: string }
  const loneFn = extractFunction<(o: LoneCase) => boolean>(DESKTOP_CARD, 'bodyIsLoneCodeBlock')
  if (!loneFn) {
    console.warn('SKIP lone-code-block: desktop card not present')
  } else {
    const LONE_CASES: Array<[string, LoneCase, boolean]> = [
      // `language` set — bodyMarkdown fences the whole content, so the pre IS
      // the body and its button copies byte-identical content.
      ['language set', { title: 't', language: 'ts', content: 'const a = 1' }, true],
      // Plain markdown: prose, a list, a table — no whole-body button exists.
      ['prose', { title: 't', content: 'Some **prose**.\n\n- one\n- two' }, false],
      ['table', { title: 't', content: '| a | b |\n|---|---|\n| 1 | 2 |' }, false],
      // The model fenced it itself instead of setting `language`.
      ['self-fenced', { title: 't', content: '```json\n{"a": 1}\n```' }, true],
      ['self-fenced, padded', { title: 't', content: '\n```\nx\n```\n' }, true],
      // TWO blocks, or a block plus prose: no single button covers the body,
      // so the card must still supply one.
      ['two blocks', { title: 't', content: '```js\na()\n```\n\n```js\nb()\n```' }, false],
      ['block then prose', { title: 't', content: '```js\na()\n```\n\nthen do the thing' }, false],
      ['prose then block', { title: 't', content: 'first:\n\n```js\na()\n```' }, false],
      // A longer outer fence wrapping an inner one is still ONE block.
      ['nested fence', { title: 't', content: '````md\nsee:\n```js\nx\n```\n````' }, true],
      // ...but a SHORTER closing fence does not close the opener.
      ['unbalanced fence', { title: 't', content: '````md\nx\n```' }, false]
    ]
    for (const [label, option, want] of LONE_CASES) {
      ok(`lone code block: ${label}`, loneFn(option) === want, `got ${loneFn(option)}`)
    }
  }

  /* ── 4. the plugin's own contract ─────────────────────────────────── */
  const tooFew = await optionsPlugin.execute('offer_options', {
    options: [{ title: 'only one', content: 'x' }]
  })
  ok('plugin: one option is refused', tooFew.success === false, JSON.stringify(tooFew))

  const empty = await optionsPlugin.execute('offer_options', { options: [] })
  ok('plugin: empty list is refused', empty.success === false, JSON.stringify(empty))

  const noneUsable = await optionsPlugin.execute('offer_options', {
    options: [{ title: 'a' }, { title: 'b' }]
  })
  ok(
    'plugin: contentless options are refused',
    noneUsable.success === false,
    JSON.stringify(noneUsable)
  )

  // Caps are LOUD. An option the model believes it showed but the user never
  // sees — dropped past a limit, or quietly cut in half — is the one failure
  // a copy-and-paste card must never produce.
  const oversized = await optionsPlugin.execute('offer_options', {
    options: [
      { title: 'fine', content: 'a' },
      { title: 'Huge one', content: 'x'.repeat(12001) }
    ]
  })
  ok(
    'plugin: an oversized option is refused, not truncated',
    oversized.success === false && /Option B \("Huge one"\)/.test(oversized.error),
    JSON.stringify(oversized)
  )

  const atCap = await optionsPlugin.execute('offer_options', {
    options: [
      { title: 'right at it', content: 'x'.repeat(12000) },
      { title: 'small', content: 'y' }
    ]
  })
  ok(
    'plugin: exactly at the cap is allowed',
    atCap.success === true,
    JSON.stringify(atCap).slice(0, 120)
  )

  const tooMany = await optionsPlugin.execute('offer_options', {
    options: Array.from({ length: 11 }, (_, i) => ({ title: `t${i}`, content: 'c' }))
  })
  ok(
    'plugin: too many options is refused, not silently trimmed',
    tooMany.success === false && /at most 10/.test(tooMany.error),
    JSON.stringify(tooMany)
  )

  const unknown = await optionsPlugin.execute('nope', { options: [] })
  ok('plugin: unknown tool name errors', unknown.success === false, JSON.stringify(unknown))

  const good = await optionsPlugin.execute('offer_options', ARGS)
  ok('plugin: mixed args succeed', good.success === true, JSON.stringify(good))
  // The letters in the output ARE the contract the model reasons with.
  ok(
    'plugin: output letters match the parsed order',
    EXPECT_TITLES.every((title, i) => good.output.includes(`${optionLetter(i)}. ${title}`)),
    good.output
  )
  // The output must NOT carry the contents — the card holds those, and echoing
  // them doubles every snippet in the model's own context.
  ok(
    'plugin: output omits the option contents',
    !good.output.includes('bare string') && !good.output.includes('const a'),
    good.output
  )

  /* ── 5. the text-channel rendering ────────────────────────────────── */
  const card = renderOptionsForChannel(ARGS)
  ok('channel: card built', !!card)
  ok(
    'channel: letters and titles line up',
    card!.options.map((o) => `${o.letter}=${o.title}`).join(' ') ===
      EXPECT_TITLES.map((t, i) => `${optionLetter(i)}=${t}`).join(' '),
    card!.options.map((o) => `${o.letter}=${o.title}`).join(' ')
  )
  ok('channel: title carried', card!.title === 'mixed')
  ok(
    'channel: nothing truncated for short content',
    card!.options.every((o) => !o.truncated)
  )

  const long = renderOptionsForChannel({
    options: [
      { title: 'huge', content: 'x'.repeat(9000) },
      { title: 'small', content: 'y' }
    ]
  })
  ok('channel: oversize body is clamped', long!.options[0].content.length === 3200)
  ok('channel: clamp is flagged', long!.options[0].truncated === true)
  ok('channel: short body untouched', long!.options[1].truncated === false)
  ok('channel: unusable args render nothing', renderOptionsForChannel({ options: [] }) === null)
  ok('channel: missing args render nothing', renderOptionsForChannel(undefined) === null)

  console.log(`\n${passed} passed, ${failed} failed`)
  process.exit(failed ? 1 : 0)
}

void run()
