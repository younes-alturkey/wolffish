/**
 * Tests for the shared /model command helpers (channels/model-picker.ts) that
 * back the WhatsApp + Telegram `/model` command: flattening connected
 * providers into a deduped, ordered list of selectable cloud models, and the
 * substring filter behind `/model <query>`.
 *
 * The module imports only a TYPE from workspace, so it runs standalone.
 * Run: TSX_TSCONFIG_PATH=tsconfig.node.json npx tsx src/main/channels/__tests__/model-picker.test.ts
 */

import {
  collectModelOptions,
  filterModelOptions,
  MODEL_LIST_CAP,
  type ModelOption
} from '../model-picker'
import type { CloudProviderConfig } from '@main/workspace/workspace'

let passed = 0
let failed = 0

function ok(label: string, cond: boolean): void {
  if (cond) {
    passed++
    return
  }
  failed++
  console.error(`FAIL: ${label}`)
}

function eqList(label: string, actual: ModelOption[], expected: string[]): void {
  const got = actual.map((o) => `${o.providerId}/${o.model}`)
  ok(
    `${label} → [${got.join(', ')}] (expected [${expected.join(', ')}])`,
    got.join('|') === expected.join('|')
  )
}

// A minimal provider factory — only the fields collectModelOptions reads.
function prov(
  id: CloudProviderConfig['id'],
  model: string,
  models?: string[]
): CloudProviderConfig {
  return { id, model, apiKey: 'k', ...(models ? { models } : {}) } as CloudProviderConfig
}

// --- collectModelOptions ---------------------------------------------------

// Expands each provider's fetched catalog; dedupes within a provider.
eqList(
  'dedup within provider',
  collectModelOptions([
    prov('anthropic', 'claude-opus-4-8', ['claude-opus-4-8', 'claude-sonnet-5', 'claude-opus-4-8'])
  ]),
  ['anthropic/claude-opus-4-8', 'anthropic/claude-sonnet-5']
)

// Falls back to the single configured model when no catalog was fetched.
eqList(
  'fallback to .model when no models[]',
  collectModelOptions([prov('deepseek', 'deepseek-chat')]),
  ['deepseek/deepseek-chat']
)

// Empty catalog + empty model contributes nothing (no blank entries).
eqList(
  'empty provider yields nothing',
  collectModelOptions([
    { id: 'openai', model: '', apiKey: 'k', models: [] } as CloudProviderConfig
  ]),
  []
)

// Preserves provider order (config arrangement) and concatenates across providers.
eqList(
  'multi-provider order preserved',
  collectModelOptions([
    prov('anthropic', 'claude-opus-4-8', ['claude-opus-4-8']),
    prov('openai', 'gpt-5', ['gpt-5', 'gpt-5-mini']),
    prov('deepseek', 'deepseek-chat')
  ]),
  ['anthropic/claude-opus-4-8', 'openai/gpt-5', 'openai/gpt-5-mini', 'deepseek/deepseek-chat']
)

// Same model id under two providers is NOT deduped (provider disambiguates).
eqList(
  'same model id across providers kept',
  collectModelOptions([prov('openai', 'gpt-5', ['gpt-5']), prov('openrouter', 'gpt-5', ['gpt-5'])]),
  ['openai/gpt-5', 'openrouter/gpt-5']
)

ok('empty providers → empty options', collectModelOptions([]).length === 0)

// --- filterModelOptions ----------------------------------------------------

const catalog = collectModelOptions([
  prov('anthropic', 'claude-opus-4-8', ['claude-opus-4-8', 'claude-sonnet-5']),
  prov('openai', 'gpt-5', ['gpt-5', 'gpt-5-mini']),
  prov('deepseek', 'deepseek-chat')
])

eqList(
  'empty query returns all',
  filterModelOptions(catalog, ''),
  catalog.map((o) => `${o.providerId}/${o.model}`)
)
eqList(
  'whitespace query returns all',
  filterModelOptions(catalog, '   '),
  catalog.map((o) => `${o.providerId}/${o.model}`)
)

eqList('filter by model substring (opus)', filterModelOptions(catalog, 'opus'), [
  'anthropic/claude-opus-4-8'
])

// Case-insensitive.
eqList('filter is case-insensitive (OPUS)', filterModelOptions(catalog, 'OPUS'), [
  'anthropic/claude-opus-4-8'
])

// Matches on provider id, not just model id.
eqList('filter by provider id (openai)', filterModelOptions(catalog, 'openai'), [
  'openai/gpt-5',
  'openai/gpt-5-mini'
])

// Substring that spans multiple models.
eqList('filter substring (gpt-5)', filterModelOptions(catalog, 'gpt-5'), [
  'openai/gpt-5',
  'openai/gpt-5-mini'
])

ok('no match → empty', filterModelOptions(catalog, 'zzz-nope').length === 0)

// A query pinning exactly one option is what the channel treats as a direct switch.
ok('unique match count is 1 (opus)', filterModelOptions(catalog, 'opus').length === 1)

// --- constant --------------------------------------------------------------

ok('MODEL_LIST_CAP is a positive integer', Number.isInteger(MODEL_LIST_CAP) && MODEL_LIST_CAP > 0)

// --- report ----------------------------------------------------------------

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
