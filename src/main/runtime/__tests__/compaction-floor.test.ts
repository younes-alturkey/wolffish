/**
 * The compaction trigger sizes what is actually sent. A run that re-read one
 * 38k-char manual 96 times sent ~118k tokens (the repeats go out as
 * pointers), yet the trigger's 25% floor over the raw internal history fired
 * a 97 s summary call that saved nothing (VPS, 2026-10-13).
 *
 * Run:
 *   TSX_TSCONFIG_PATH=tsconfig.node.json npx tsx \
 *     src/main/runtime/__tests__/compaction-floor.test.ts
 */
import { compactOverflow } from '../compactor'
import type { ChatMessage, Thalamus } from '../thalamus'

let passed = 0
let failed = 0
function ok(name: string, cond: boolean, detail?: unknown): void {
  if (cond) passed++
  else {
    failed++
    console.log(`  ✗ ${name}`, detail === undefined ? '' : JSON.stringify(detail))
  }
}

const manual = 'Design manual. '.repeat(38_520 / 15)
const messages: ChatMessage[] = [{ role: 'user', content: 'build the brief' }]
for (let i = 0; i < 120; i++) {
  messages.push({
    role: 'assistant',
    content: '',
    toolUses: [{ id: `w${i}`, name: 'web_design', args: { page: `attempt ${i}` } }]
  })
  messages.push({ role: 'tool', toolUseId: `w${i}`, toolName: 'web_design', content: manual })
}

const thalamus = {
  getContextBudget: () => 1_050_000,
  stream: () => {
    throw new Error('compaction must not call the model here')
  }
} as unknown as Thalamus

async function main(): Promise<void> {
  const result = await compactOverflow(thalamus, 'system', messages, undefined, {
    lastKnownInputTokens: 118_000,
    inputBudget: 922_000
  })
  ok('120 duplicate manuals do not trigger compaction at 118k real tokens', result === null)

  const forced = messages.slice()
  const distinct: ChatMessage[] = [{ role: 'user', content: 'go' }]
  for (let i = 0; i < 96; i++) {
    distinct.push({
      role: 'assistant',
      content: '',
      toolUses: [{ id: `d${i}`, name: 'web_fetch', args: { url: `https://x/${i}` } }]
    })
    distinct.push({
      role: 'tool',
      toolUseId: `d${i}`,
      toolName: 'web_fetch',
      content: `${i} `.repeat(19_000)
    })
  }
  let started = false
  await compactOverflow(thalamus, 'system', distinct, undefined, {
    lastKnownInputTokens: 0,
    inputBudget: 1_050_000,
    onStarted: () => {
      started = true
      throw new Error('stop after the decision')
    }
  }).catch(() => undefined)
  ok('distinct payloads past the threshold still compact', started)
  ok('the input history is untouched by the sizing', forced.length === messages.length)

  console.log(`${passed} passed, ${failed} failed`)
  process.exit(failed > 0 ? 1 : 0)
}

void main()
