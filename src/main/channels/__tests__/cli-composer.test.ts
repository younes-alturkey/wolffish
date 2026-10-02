/**
 * The CLI's multi-line composer, driven through a real terminal-mode readline.
 *
 * The contracts worth guarding are the ones whose failure modes are silent and
 * ugly in a live session:
 *  - a pasted block must land as ONE message — the pre-composer behaviour was
 *    "send the first line to the agent mid-paste", which is unrecoverable;
 *  - Shift+Enter (kitty \x1b[13;2u), Alt+Enter (\x1b\r) and Ctrl+J (\n) must
 *    all break the line, and plain Enter alone may submit;
 *  - pasted control bytes and escape sequences must never reach the terminal
 *    or the message (a hostile paste is a real input);
 *  - an automation block split for `paste` must keep the schedule heading and
 *    every marker line byte-identical — that file is parsed by the scheduler.
 *
 * Run: TSX_TSCONFIG_PATH=tsconfig.node.json npx tsx \
 *        src/main/channels/__tests__/cli-composer.test.ts
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { PassThrough } from 'node:stream'
import readline from 'node:readline'
import path from 'node:path'

const APP = path.resolve(__dirname, '../../../..')

let failures = 0
function check(label: string, ok: boolean, detail?: unknown): void {
  if (ok) {
    console.log(`  ok  ${label}`)
    return
  }
  failures++
  console.log(`FAIL  ${label}`)
  if (detail !== undefined) console.log(`      ${JSON.stringify(detail)}`)
}

/** A terminal readline over pipes, with the composer attached — one per case. */
function harness(attachComposer: any, { busy = false }: { busy?: boolean } = {}): any {
  const input = new PassThrough() as any
  const output = new PassThrough() as any
  output.columns = 80
  output.rows = 24
  const painted: string[] = []
  output.on('data', (chunk: Buffer) => painted.push(chunk.toString('utf8')))
  const rl = readline.createInterface({ input, output, terminal: true, prompt: '> ' })
  const composer = attachComposer(rl, {
    contPrompt: () => '. ',
    isBusy: () => busy,
    onRestorePrompt: () => undefined
  })
  const submitted: string[] = []
  rl.on('line', (line: string) => {
    submitted.push(composer.isActive() ? composer.finish(line) : line)
  })
  return { input, output, rl, composer, submitted, painted }
}

async function main(): Promise<void> {
  const { attachComposer, sanitizePaste } = await import(path.join(APP, 'src/cli/lib/composer.mjs'))
  const { splitAutomationBlock, sanitizeAutomationBody } = await import(
    path.join(APP, 'src/cli/commands/workspace.mjs')
  )

  // ── Shift+Enter and friends compose instead of sending ────────────────────
  {
    const h = harness(attachComposer)
    h.input.write('hello\x1b[13;2uworld\r')
    check('kitty Shift+Enter breaks the line', h.submitted[0] === 'hello\nworld', h.submitted)
    h.rl.close()
  }
  {
    const h = harness(attachComposer)
    h.input.write('a\x1b\rb\nc\r')
    check('Alt+Enter and Ctrl+J both break the line', h.submitted[0] === 'a\nb\nc', h.submitted)
    h.rl.close()
  }
  {
    const h = harness(attachComposer)
    h.input.write('x\x1b[13;5uy\r')
    check('Ctrl+Enter (kitty) breaks the line too', h.submitted[0] === 'x\ny', h.submitted)
    h.rl.close()
  }

  // ── Bracketed paste: everything lands, nothing sends ──────────────────────
  {
    const h = harness(attachComposer)
    h.input.write('\x1b[200~one\rtwo\nthree\x1b[201~')
    check('a pasted block does not submit anything', h.submitted.length === 0, h.submitted)
    check('the whole paste is composing', h.composer.isActive() === true)
    h.input.write('\r')
    check(
      'Enter after the paste sends it as ONE message',
      h.submitted.length === 1 && h.submitted[0] === 'one\ntwo\nthree',
      h.submitted
    )
    h.rl.close()
  }
  {
    const h = harness(attachComposer)
    // Type AB, step the cursor left once, paste a two-line block into the middle.
    h.input.write('AB\x1b[D\x1b[200~x\ny\x1b[201~\r')
    check('a mid-line paste splits at the cursor', h.submitted[0] === 'Ax\nyB', h.submitted)
    h.rl.close()
  }
  {
    const h = harness(attachComposer)
    h.input.write('\x1b[200~safe\x1b[31m\x07\x00 text\x1b[201~\r')
    check(
      'pasted escapes and control bytes are stripped',
      h.submitted[0] === 'safe text',
      h.submitted
    )
    check(
      'no raw escape from the paste reached the screen',
      !h.painted.join('').includes('\x1b[31m')
    )
    h.rl.close()
  }

  // ── Busy turns: nothing may draw, nothing may break ───────────────────────
  {
    const h = harness(attachComposer, { busy: true })
    h.input.write('\x1b[200~two\nlines\x1b[201~')
    h.input.write('\x1b[13;2u') // Shift+Enter mid-turn: inert
    h.input.write('\r')
    check(
      'mid-turn paste flattens into the buffer instead of drawing rows',
      h.submitted[0] === 'two lines',
      h.submitted
    )
    h.rl.close()
  }

  // ── Abandon and history ───────────────────────────────────────────────────
  {
    const h = harness(attachComposer)
    // Frozen row AND text on the live row — the live row is the one that
    // leaked: it stayed in readline's buffer and spliced itself into the next
    // command typed after a Ctrl-C discard (measured live: "/help" submitted
    // as "/helpBBBROW").
    h.input.write('dead\x1b[13;2ualive')
    h.composer.abandon()
    check('abandon clears the frozen rows', h.composer.isActive() === false)
    check('…and the live row', (h.rl as any).line === '', (h.rl as any).line)
    h.input.write('z\r')
    check('the next submit carries none of the draft', h.submitted[0] === 'z', h.submitted)
    h.rl.close()
  }
  {
    const h = harness(attachComposer)
    h.input.write('first\x1b[13;2usecond\r')
    check(
      'history holds the whole message, flattened for recall',
      (h.rl as any).history[0] === 'first second',
      (h.rl as any).history
    )
    h.rl.close()
  }

  // ── detach restores readline untouched ────────────────────────────────────
  {
    const h = harness(attachComposer)
    h.composer.detach()
    h.input.write('\x1b[200~a\rb\x1b[201~')
    check(
      'after detach readline is stock again (paste CR submits)',
      h.submitted.length === 1 && h.submitted[0] === 'a',
      h.submitted
    )
    h.rl.close()
  }

  // ── sanitizePaste directly ────────────────────────────────────────────────
  check('CRLF and CR become LF', sanitizePaste('a\r\nb\rc') === 'a\nb\nc')
  check('tabs become spaces (cursor math cannot place a tab)', sanitizePaste('\ta') === '    a')
  check('OSC sequences are stripped', sanitizePaste('x\x1b]0;title\x07y') === 'xy')

  // ── splitAutomationBlock mirrors the scheduler's marker rules ─────────────
  {
    const block = [
      '## Daily (08:00)',
      'mode: single',
      '',
      'file: /tmp/a b.txt',
      'dir: /tmp/work',
      '',
      'Summarise the inbox.',
      'Then file: it under notes.'
    ].join('\n')
    const { head, body } = splitAutomationBlock(block)
    check(
      'head keeps the heading and every marker, blanks included',
      head === '## Daily (08:00)\nmode: single\n\nfile: /tmp/a b.txt\ndir: /tmp/work',
      head
    )
    check(
      'body starts at the first non-marker line and keeps marker-looking prose',
      body === 'Summarise the inbox.\nThen file: it under notes.',
      body
    )
  }
  {
    const { head, body } = splitAutomationBlock('## Hourly\nJust do the thing.')
    check(
      'a markerless block splits cleanly',
      head === '## Hourly' && body === 'Just do the thing.'
    )
  }
  {
    const { head, body } = splitAutomationBlock('## Empty (09:00)\nfile: /x/y.md')
    check(
      'a body-less block keeps its marker in the head',
      head === '## Empty (09:00)\nfile: /x/y.md' && body === ''
    )
  }

  // ── sanitizeAutomationBody: a pasted prompt's own outline must not shatter
  //    the job — `## ` rows are job boundaries in heartbeat.md ───────────────
  {
    const body =
      '# Title\n\n## 0. Preconditions\ntext\n\n## 7. Cursor format\n### already deep\n#### deeper\nnot ## a heading'
    const safe = sanitizeAutomationBody(body)
    check(
      '## rows demoted to ### and counted',
      safe.demoted === 2 &&
        safe.text.includes('### 0. Preconditions') &&
        safe.text.includes('### 7. Cursor format'),
      safe
    )
    check(
      '# title, ###+, and mid-line ## left alone',
      safe.text.includes('# Title') &&
        safe.text.includes('### already deep') &&
        safe.text.includes('#### deeper') &&
        safe.text.includes('not ## a heading')
    )
    check('no job-boundary rows survive in the safe body', !/^##\s/m.test(safe.text))
    check('a clean body reports zero demotions', sanitizeAutomationBody('plain text').demoted === 0)
    check(
      'a "<!--" marker is flagged as unsafe',
      sanitizeAutomationBody('a <!-- b').commentMarker === true
    )
  }

  console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILED`}`)
  process.exit(failures === 0 ? 0 : 1)
}

void main().catch((error) => {
  console.error(error)
  process.exit(1)
})
