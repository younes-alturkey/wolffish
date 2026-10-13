/**
 * Synthetic API keys for the demo dataset.
 *
 * Every key in demo/config-snapshot.json came from demoApiKey(id): fake,
 * shaped like that provider's public key format. The only input is the
 * provider id — a public string — so no real secret is ever an ingredient, and
 * re-minting produces byte-identical keys instead of churning the snapshot.
 * When hand-adding a provider to the snapshot, mint its key with:
 *
 *   node scripts/demo/provider-keys.mjs <provider-id>
 *
 * Formats are modelled on each vendor's documented prefix/length. They are
 * cosmetic: nothing validates them, they authenticate nothing, and the demo
 * never sends them anywhere.
 */

import { pathToFileURL } from 'node:url'

const HEX = '0123456789abcdef'
const LOWER36 = 'abcdefghijklmnopqrstuvwxyz0123456789'
const B62 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
const B64URL = `${B62}-_`

/** FNV-1a over the provider id — a stable 32-bit seed, nothing cryptographic. */
function seedOf(text) {
  let hash = 0x811c9dc5
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash || 0x9e3779b9
}

/** xorshift32 → a `pick(alphabet, length)` that draws a deterministic run. */
function drawer(seed) {
  let state = seed
  const next = () => {
    state ^= state << 13
    state >>>= 0
    state ^= state >>> 17
    state ^= state << 5
    state >>>= 0
    return state
  }
  return (alphabet, length) => {
    let out = ''
    // Draw from the high bits: the low ones carry xorshift's short cycles and
    // print as visible little repeats (…lvlvlv…) that read as fake at a glance.
    for (let i = 0; i < length; i += 1) out += alphabet[(next() >>> 9) % alphabet.length]
    return out
  }
}

/**
 * Key shape per provider id, keyed exactly as config.json spells them. Ids the
 * table doesn't know fall back to the `sk-` convention most vendors copied.
 *
 * Bodies are trimmed to ~30 characters, shorter than several vendors' real
 * keys. That is deliberate: iOS renders a revealed single-line TextInput by
 * dropping everything past the prefix once the run after the last `-` is wider
 * than the field, so an 80-character key shows as a bare "xai-". At this length
 * every key survives the reveal toggle, and the field clips at its own edge
 * like any other long value.
 */
const FORMATS = {
  anthropic: (pick) => `sk-ant-api03-${pick(B64URL, 20)}`,
  openai: (pick) => `sk-proj-${pick(B64URL, 26)}`,
  openrouter: (pick) => `sk-or-v1-${pick(HEX, 24)}`,
  xai: (pick) => `xai-${pick(B62, 30)}`,
  // 30, not DeepSeek's real 32: the 32-char lowercase shape is exactly what
  // GitHub push protection flags as a live DeepSeek key, and it blocks the push.
  deepseek: (pick) => `sk-${pick(LOWER36, 30)}`,
  qwen: (pick) => `sk-${pick(HEX, 32)}`,
  kimi: (pick) => `sk-${pick(B62, 30)}`,
  moonshot: (pick) => `sk-${pick(B62, 30)}`,
  stepfun: (pick) => `sk-${pick(B62, 30)}`,
  mimo: (pick) => `sk-${pick(B62, 32)}`,
  // Z.AI / Zhipu issue a two-part `<id>.<secret>` key.
  zai: (pick) => `${pick(HEX, 20)}.${pick(B62, 12)}`,
  minimax: (pick) => `sk-${pick(B62, 30)}`,
  google: (pick) => `AIzaSy${pick(B64URL, 27)}`,
  gemini: (pick) => `AIzaSy${pick(B64URL, 27)}`,
  groq: (pick) => `gsk_${pick(B62, 30)}`,
  mistral: (pick) => pick(B62, 32),
  cohere: (pick) => pick(B62, 32),
  perplexity: (pick) => `pplx-${pick(B62, 28)}`,
  together: (pick) => pick(HEX, 32),
  fireworks: (pick) => `fw_${pick(B62, 24)}`
}

/** A stable fake key for a provider id, shaped like the real thing. */
export function demoApiKey(providerId) {
  const id = String(providerId ?? '').toLowerCase()
  const pick = drawer(seedOf(`wolffish-demo-key:${id}`))
  const format = FORMATS[id] ?? ((draw) => `sk-${draw(B62, 40)}`)
  return format(pick)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const id = process.argv[2]
  if (!id) {
    console.error('usage: node scripts/demo/provider-keys.mjs <provider-id>')
    process.exit(1)
  }
  console.log(demoApiKey(id))
}
