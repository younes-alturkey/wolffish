/**
 * The two things the terminal's file surface can get wrong SILENTLY.
 *
 * 1. Splicing one automation out of heartbeat.md. `wolffish automations edit`
 *    and `… rm` rewrite the scheduler's own file by character offset. Get the
 *    boundaries wrong and you eat a neighbouring job, or the commented examples
 *    block at the bottom, and nothing complains until a schedule stops firing.
 *    The rules mirror `stripHeartbeatHeading` in brainstem.ts — a block runs
 *    from its `## label` to the next heading, the next comment, or EOF, and a
 *    heading inside a comment is not a heading.
 *
 * 2. Masking credentials before a file is printed. Every other surface in the
 *    CLI masks (`manageKeys`, the daemon's own secret cards) for the reason
 *    stated there: a terminal is scrollback, tmux buffers and screen shares.
 *    `wolffish view config.json` reads the file straight off disk, so the
 *    masking has to happen here — and it has to leave ordinary prose alone,
 *    because a viewer that corrupts markdown is worse than one that leaks.
 *
 * Run: TSX_TSCONFIG_PATH=tsconfig.node.json npx tsx \
 *        src/main/channels/__tests__/cli-viewer.test.ts
 */
import path from 'node:path'

const APP = path.resolve(__dirname, '../../../..')

let passed = 0
let failed = 0
function check(label: string, condition: boolean, detail?: string): void {
  if (condition) {
    passed++
    console.log(`PASS  ${label}`)
  } else {
    failed++
    console.log(`FAIL  ${label}${detail ? `\n      ${detail}` : ''}`)
  }
}

/** Active `## ` headings — what the scheduler itself would pick up. */
function activeLabels(text: string): string[] {
  const ranges: Array<[number, number]> = []
  const re = /<!--[\s\S]*?-->/g
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) ranges.push([m.index, m.index + m[0].length])
  const inComment = (pos: number): boolean => ranges.some(([s, e]) => pos >= s && pos < e)
  const labels: string[] = []
  let offset = 0
  for (const line of text.split('\n')) {
    const h = /^##\s+(.+?)\s*$/.exec(line)
    if (h && !inComment(offset)) labels.push(h[1])
    offset += line.length + 1
  }
  return labels
}

const HEARTBEAT = [
  '# Heartbeat',
  '',
  '## Daily (09:00)',
  '',
  'mode: single',
  'icon: 📮',
  '',
  'Summarize my inbox.',
  '',
  '## Every (6h)',
  '',
  'dir: /tmp',
  '',
  'Check the disks.',
  '',
  '## Once (2026-09-01 10:00)',
  '',
  'One and done.',
  '',
  '<!--',
  '## Daily (23:00)',
  'This one is an EXAMPLE, not a job.',
  '-->',
  ''
].join('\n')

async function main(): Promise<void> {
  const cli = await import(path.join(APP, 'src/cli/commands/workspace.mjs'))
  const { findJobBlock, redact, looksBinary } = cli

  // ── The splice ────────────────────────────────────────────────────────────
  check(
    'the commented example is not treated as a job',
    activeLabels(HEARTBEAT).length === 3,
    `saw ${JSON.stringify(activeLabels(HEARTBEAT))}`
  )

  for (const label of activeLabels(HEARTBEAT)) {
    const range = findJobBlock(HEARTBEAT, label)
    const block: string = HEARTBEAT.slice(range.start, range.end)
    check(`${label}: block starts at its own heading`, block.startsWith(`## ${label}`))
    check(
      `${label}: block holds exactly one job`,
      activeLabels(block).length === 1 && activeLabels(block)[0] === label,
      `saw ${JSON.stringify(activeLabels(block))}`
    )

    const deleted = (HEARTBEAT.slice(0, range.start) + HEARTBEAT.slice(range.end)).replace(
      /\n{3,}/g,
      '\n\n'
    )
    check(
      `${label}: deleting it removes only it`,
      JSON.stringify(activeLabels(deleted)) ===
        JSON.stringify(activeLabels(HEARTBEAT).filter((l) => l !== label)),
      `left ${JSON.stringify(activeLabels(deleted))}`
    )
    check(
      `${label}: deleting it leaves the examples comment intact`,
      deleted.includes('## Daily (23:00)') && deleted.includes('-->')
    )
    check(`${label}: deleting it keeps the file's own title`, deleted.startsWith('# Heartbeat'))
  }

  // The last job in the file must stop at the comment, not swallow it.
  const last = findJobBlock(HEARTBEAT, 'Once (2026-09-01 10:00)')
  check(
    'the final job stops before the comment block',
    !HEARTBEAT.slice(last.start, last.end).includes('<!--')
  )

  // Rescheduling: the heading IS the schedule, so editing it must move the job.
  const target = findJobBlock(HEARTBEAT, 'Every (6h)')
  const moved =
    HEARTBEAT.slice(0, target.start) +
    HEARTBEAT.slice(target.start, target.end).replace('## Every (6h)', '## Every (30m)') +
    HEARTBEAT.slice(target.end)
  check(
    'changing the heading reschedules that job and no other',
    JSON.stringify(activeLabels(moved)) ===
      JSON.stringify(['Daily (09:00)', 'Every (30m)', 'Once (2026-09-01 10:00)']),
    `saw ${JSON.stringify(activeLabels(moved))}`
  )

  check('a label that is not there returns null', findJobBlock(HEARTBEAT, 'Daily (23:00)') === null)

  // ── The masking ───────────────────────────────────────────────────────────
  const config = JSON.stringify(
    {
      providers: [{ id: 'openai', apiKey: 'sk-abcdefghijklmnopqrstuvwxyz012345', model: 'gpt' }],
      telegram: { botToken: '8012345678:AAH-lorem-ipsum-dolor-sit-amet-xyz' },
      notion: { token: 'ntn_1234567890abcdefghijklmnopqrstuvwxyz' },
      port: 23151,
      enabled: true
    },
    null,
    2
  )
  const masked = redact(config)
  check('a provider key is masked', !masked.text.includes('sk-abcdefghijklmnopqrstuvwxyz012345'))
  check(
    'a bot token is masked',
    !masked.text.includes('8012345678:AAH-lorem-ipsum-dolor-sit-amet-xyz')
  )
  check(
    'a notion token is masked',
    !masked.text.includes('ntn_1234567890abcdefghijklmnopqrstuvwxyz')
  )
  check('the count is reported', masked.count >= 3, `count was ${masked.count}`)
  check('a port number survives', masked.text.includes('23151'))
  check('a model name survives', masked.text.includes('"gpt"'))
  check('a boolean survives', masked.text.includes('true'))

  const env = ['OPENAI_API_KEY=sk-livekeyvalue1234567890', 'LOG_LEVEL=debug', 'PORT=3000'].join(
    '\n'
  )
  const maskedEnv = redact(env)
  check('an env-style secret is masked', !maskedEnv.text.includes('sk-livekeyvalue1234567890'))
  check('an env-style non-secret survives', maskedEnv.text.includes('LOG_LEVEL=debug'))

  // The failure that would be worse than the leak: mangling ordinary writing.
  const prose = [
    '# Soul',
    '',
    '- Name: Younes Alturkey',
    '- Timezone: AST (UTC+3)',
    '',
    'Summary: one sentence',
    'Reference: chapter + page number(s)',
    'Format every answer as:',
    'You keep it real. No corporate speak.'
  ].join('\n')
  const maskedProse = redact(prose)
  check('ordinary markdown is untouched', maskedProse.text === prose, 'the viewer rewrote prose')
  check('and nothing is counted', maskedProse.count === 0)

  // ── Binary guard ──────────────────────────────────────────────────────────
  check('a NUL byte marks a file binary', looksBinary('abc' + String.fromCharCode(0) + 'def'))
  check('plain text is not binary', !looksBinary(prose))

  console.log(`\n${passed} passed, ${failed} failed`)
  process.exit(failed === 0 ? 0 : 1)
}

void main()
