/**
 * outbound.ts truncateSuperseded — the file_read pass: a newer successful
 * read of the same file window supersedes an older one (the older copy is
 * stubbed on the outbound clone), different windows and other files are
 * untouched, errors never supersede, and the newest read is always kept.
 *
 * Run:
 *   TSX_TSCONFIG_PATH=tsconfig.node.json npx tsx src/main/runtime/__tests__/outbound-superseded-read.test.ts
 */
import { truncateSuperseded } from '../outbound'
import type { ChatMessage } from '../thalamus'

let passed = 0
let failed = 0
function ok(name: string, cond: unknown, detail?: unknown): void {
  if (cond) {
    passed++
    console.log(`  ✓ ${name}`)
  } else {
    failed++
    console.log(`  ✗ ${name}`)
    if (detail !== undefined)
      console.log('    ', typeof detail === 'string' ? detail : JSON.stringify(detail))
  }
}

const big = (tag: string): string => `${tag}\n` + 'x'.repeat(2500)

function read(
  id: string,
  args: Record<string, unknown>,
  content: string,
  isError = false
): ChatMessage[] {
  return [
    { role: 'assistant', content: '', toolUses: [{ id, name: 'file_read', args }] },
    { role: 'tool', toolUseId: id, toolName: 'file_read', content, isError }
  ]
}

function main(): void {
  const msgs: ChatMessage[] = [
    { role: 'user', content: 'go' },
    ...read('r1', { path: 'src/a.ts' }, big('first read')),
    ...read('r2', { path: 'src/b.ts' }, big('other file')),
    ...read('r3', { path: 'src/a.ts', offset: 100, limit: 50 }, big('window read')),
    ...read('r4', { path: 'src/a.ts' }, big('second read after edit')),
    ...read('r5', { path: 'src/a.ts' }, 'short', true)
  ]
  const out = truncateSuperseded(msgs)
  type ToolMsg = Extract<ChatMessage, { role: 'tool' }>
  const tool = (id: string): ToolMsg =>
    out.find((m) => m.role === 'tool' && m.toolUseId === id) as Extract<
      ChatMessage,
      { role: 'tool' }
    >
  ok(
    'the older read of the same window is stubbed',
    tool('r1').content.startsWith('[superseded file read') &&
      tool('r1').content.includes('src/a.ts'),
    tool('r1').content.slice(0, 120)
  )
  ok(
    'the newest read of that window is kept in full',
    tool('r4').content.startsWith('second read after edit')
  )
  ok(
    'a different window of the same file is untouched',
    tool('r3').content.startsWith('window read')
  )
  ok('another file is untouched', tool('r2').content.startsWith('other file'))
  ok('an error result never supersedes and is left alone', tool('r5').content === 'short')
  ok(
    'internal messages are not mutated',
    (msgs[2] as Extract<ChatMessage, { role: 'tool' }>).content.startsWith('first read')
  )

  const same = truncateSuperseded([
    { role: 'user', content: 'go' },
    ...read('s1', { path: 'x' }, big('only'))
  ])
  ok(
    'a single read is returned unchanged (same array)',
    same.length === 3 &&
      (same[2] as Extract<ChatMessage, { role: 'tool' }>).content.startsWith('only')
  )

  console.log(`\n${passed} passed, ${failed} failed`)
  process.exit(failed ? 1 : 0)
}

main()
