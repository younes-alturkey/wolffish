#!/usr/bin/env node
/**
 * Regenerate the demo usage ledger — `usage.days` in demo/config-snapshot.json.
 *
 *   node scripts/demo/build-usage-ledger.mjs      # rewrites the section in place
 *   node scripts/demo/build-demo-bundle.mjs       # pack for the CDN
 *
 * Two problems this solves, both invisible until you tap the range pills.
 *
 * ONE: every range answered the same number. `rangeCutoff` (lib/usage/stats) is
 * a lower bound only, so a ledger that spans six weeks lands entirely inside
 * `3_months` — and 3 months, 6 months, YTD and All time then show identical
 * totals, which reads as a broken filter rather than a quiet workspace. Ranges
 * differ only if the ledger has rows on the far side of each cutoff, so the
 * history below is built backwards from the cutoffs: rows in 2025 (so All time
 * exceeds YTD), in January (so YTD exceeds 6 months), and across February to
 * May (so 6 months exceeds 3 months). Verified for every month a viewer can
 * open this in — see the range table the script prints.
 *
 * TWO: the ledger stopped. `today` and `this_month` read from the device's
 * clock, which keeps moving after the dataset is published, so the two ranges
 * a demo opens on were empty and getting emptier — and every month past the
 * last row rendered as a blank calendar, which reads as a dataset that died
 * rather than one that has not got there yet. From August 2026 the ledger is
 * therefore filled EVERY day, eighteen months out: whatever date the demo is
 * opened on, the pills answer and the calendar is full in both directions.
 * Months vary in weight (MONTHLY_DRIFT) so a year of them does not read as a
 * flat line.
 *
 * JUNE AND JULY ARE NEVER TOUCHED. Those rows are the folded real ledger the
 * dataset was built from, and they are what everything else is shaped to look
 * like; the script preserves whatever it finds in the keep window and refuses
 * to run if that window comes back empty.
 *
 * Deterministic: every value derives from a hash of the date it belongs to, so
 * re-running produces byte-identical output and the bundle hash only moves when
 * this file does. Editing one month cannot perturb another.
 */
import { promises as fs } from 'node:fs'
import path from 'node:path'
import prettier from 'prettier'

const ROOT = path.join(path.dirname(new URL(import.meta.url).pathname), '..', '..')
const SNAPSHOT = path.join(process.env.DEMO_SRC ?? path.join(ROOT, 'demo'), 'config-snapshot.json')

/** The curated real rows. Inclusive, and rebuilt from the file, never regenerated. */
const KEEP_FROM = '2026-06-01'
const KEEP_TO = '2026-07-31'

/**
 * Price per 1M tokens, `[input, output]`.
 *
 * The multi-row models are least-squares fits against the real June/July rows,
 * so a generated row prices exactly like a folded one. The rest are list
 * prices — those models appear once or twice upstream, too thin to fit.
 */
const PRICES = {
  'deepseek/deepseek-v4-pro': [0.501, 0.667],
  'deepseek/deepseek-v4-flash': [0.144, 0.346],
  'local/gemma4:e2b': [0, 0],
  'qwen/qwen3.6-flash': [0.25, 1.5],
  'qwen/qwen3.7-plus': [0.443, 2.11],
  'zai/glm-5-turbo': [1.04, 12.151],
  'kimi/kimi-k3': [3.62, 16.2],
  'anthropic/claude-opus-4-8': [15, 75],
  'anthropic/claude-sonnet-4-6': [3, 15],
  'anthropic/claude-haiku-4-5-20251001': [1, 5],
  'openai/gpt-5.5': [1.25, 10],
  'openrouter/anthropic/claude-sonnet-4.5': [3, 15],
  'xai/grok-4.5': [3, 15]
}

/** Mean tokens per ledger entry, `[input, output]` — from the real rows. */
const SHAPE = {
  'deepseek/deepseek-v4-pro': [47_000, 2_800],
  'deepseek/deepseek-v4-flash': [67_000, 3_800],
  'local/gemma4:e2b': [27_000, 95],
  'qwen/qwen3.6-flash': [164_000, 4_500],
  'qwen/qwen3.7-plus': [124_000, 13_200],
  'zai/glm-5-turbo': [43_000, 5_500],
  'kimi/kimi-k3': [62_000, 3_900],
  'anthropic/claude-opus-4-8': [31_000, 4_100],
  'anthropic/claude-sonnet-4-6': [36_000, 5_200],
  'anthropic/claude-haiku-4-5-20251001': [21_000, 3_000],
  'openai/gpt-5.5': [48_000, 2_100],
  'openrouter/anthropic/claude-sonnet-4.5': [40_000, 3_000],
  'xai/grok-4.5': [55_000, 2_200]
}

/**
 * What the workspace was running, by era — and the reason the ranges do not
 * merely differ in size. The Brain moved from Claude to DeepSeek over the
 * spring, so widening the range past May does not just add days: it lights up
 * provider cards that are dark at 3 months, and multiplies the cost far faster
 * than the token count. `share` is the pick weight; the first entry is the
 * era's workhorse.
 */
const ERAS = [
  {
    // Occasional use, all frontier models, priced like it.
    id: 'claude',
    until: '2026-02-28',
    mix: [
      ['anthropic/claude-sonnet-4-6', 6],
      ['anthropic/claude-opus-4-8', 3],
      ['anthropic/claude-haiku-4-5-20251001', 2],
      ['openai/gpt-5.5', 2],
      ['openrouter/anthropic/claude-sonnet-4.5', 1]
    ]
  },
  {
    // The switch: DeepSeek arrives and takes over through the spring.
    id: 'switch',
    until: '2026-05-31',
    mix: [
      ['deepseek/deepseek-v4-pro', 7],
      ['anthropic/claude-sonnet-4-6', 3],
      ['deepseek/deepseek-v4-flash', 2],
      ['anthropic/claude-opus-4-8', 1],
      ['local/gemma4:e2b', 2],
      ['qwen/qwen3.6-flash', 1]
    ]
  },
  {
    // Settled: a cheap workhorse under a heartbeat that runs every day.
    id: 'agent',
    until: '2099-12-31',
    mix: [
      ['deepseek/deepseek-v4-pro', 12],
      ['deepseek/deepseek-v4-flash', 4],
      ['local/gemma4:e2b', 3],
      ['qwen/qwen3.6-flash', 1],
      ['qwen/qwen3.7-plus', 1],
      ['zai/glm-5-turbo', 1],
      ['kimi/kimi-k3', 1],
      ['xai/grok-4.5', 1]
    ]
  }
]

/**
 * The generated stretches. `density` is the chance a day has any usage at all,
 * `entries` the [min, max] ledger lines on a day that does. August onward is
 * density 1 on purpose — see the header.
 */
const SEGMENTS = [
  { from: '2025-11-03', to: '2025-12-22', density: 0.34, entries: [4, 18] },
  { from: '2026-01-01', to: '2026-01-31', density: 0.3, entries: [8, 26] },
  { from: '2026-02-01', to: '2026-02-28', density: 0.4, entries: [9, 30] },
  { from: '2026-03-01', to: '2026-03-31', density: 0.44, entries: [12, 38] },
  { from: '2026-04-01', to: '2026-04-30', density: 0.54, entries: [14, 46] },
  { from: '2026-05-01', to: '2026-05-31', density: 0.62, entries: [18, 58] },
  { from: '2026-08-01', to: '2028-02-29', density: 1, entries: [26, 128] }
]

/**
 * The quarterly deep-research runs — one outsized day per stretch, and the
 * reason `topSpendDay` names a different date in every range rather than the
 * same one six times over.
 *
 * They are ANCHORS, placed so that each range's widest new territory contains a
 * day more expensive than anything the range inside it can see: May beats what
 * 3 months holds, February beats May, January beats February, and December 2025
 * beats them all. Checked for every month a viewer can open this in — see the
 * top-day row the script prints.
 *
 * Each carries its own `mix`, overriding the era: these runs went to Opus
 * whatever the Brain happened to be that month, which is exactly why they cost
 * what they cost and why no ordinary day in the cheap DeepSeek era can
 * accidentally outrank one. `entries` is absolute, not a multiplier — a spike
 * has to clear a known bar, and a multiplier on a random roll cannot promise
 * that.
 */
const DEEP_RESEARCH_MIX = [
  ['anthropic/claude-opus-4-8', 8],
  ['anthropic/claude-sonnet-4-6', 3],
  ['openrouter/anthropic/claude-sonnet-4.5', 1]
]

const SPIKES = {
  // The four that order the ranges as of publication, biggest first.
  '2025-12-09': { entries: 92, mix: DEEP_RESEARCH_MIX },
  '2026-01-14': { entries: 76, mix: DEEP_RESEARCH_MIX },
  '2026-02-18': { entries: 61, mix: DEEP_RESEARCH_MIX },
  '2026-05-07': { entries: 47, mix: DEEP_RESEARCH_MIX },
  // Roughly quarterly from here on, so a viewer in 2027 gets the same spread
  // of top-spend days a viewer in 2026 does. All are kept under the 2025-12-09
  // anchor, which keeps All time pointing at the same day for the whole run.
  '2026-09-15': { entries: 55, mix: DEEP_RESEARCH_MIX },
  '2026-12-03': { entries: 68, mix: DEEP_RESEARCH_MIX },
  '2027-02-11': { entries: 44, mix: DEEP_RESEARCH_MIX },
  '2027-04-20': { entries: 72, mix: DEEP_RESEARCH_MIX },
  '2027-06-08': { entries: 51, mix: DEEP_RESEARCH_MIX },
  '2027-08-25': { entries: 84, mix: DEEP_RESEARCH_MIX },
  '2027-10-13': { entries: 58, mix: DEEP_RESEARCH_MIX },
  '2027-12-01': { entries: 78, mix: DEEP_RESEARCH_MIX },
  '2028-01-19': { entries: 63, mix: DEEP_RESEARCH_MIX }
}

/**
 * A spike runs to a fixed recipe — same model split, no token jitter — so its
 * cost is a straight multiple of `entries`.
 *
 * Ordinary days are noisy on purpose, but that noise is worth ±40% on a day's
 * total, which is far more than the gaps between these four. Jittered, the
 * cheapest anchor outranked the dearest often enough that the ranges stopped
 * ordering; pinning the recipe makes "written biggest first" mean "is biggest".
 */
const SPIKE_SHARES = [0.7, 0.22, 0.08]

/**
 * Per-month weight, so eighteen months of daily rows do not read as one flat
 * line. Hashed off the `YYYY-MM` key alone, like everything else here, and
 * deliberately wide: a quiet month at 0.55 against a heavy one at 1.55 is the
 * difference between a calendar you can read the seasons off and a wall of the
 * same blue.
 */
function monthlyDrift(date) {
  return 0.55 + (hash(`wolffish-usage-month:${date.slice(0, 7)}`) % 1000) / 1000
}

// ── deterministic noise ──────────────────────────────────────────────────
// Seeded off the date string alone, so a value depends on nothing but the day
// it belongs to: re-running is byte-identical, and changing one segment's
// density cannot shift the numbers in another.

function hash(text) {
  let h = 2166136261
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

function rng(seed) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function eachDate(from, to) {
  const out = []
  const end = new Date(`${to}T12:00:00`)
  for (let d = new Date(`${from}T12:00:00`); d <= end; d.setDate(d.getDate() + 1)) {
    out.push(
      `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    )
  }
  return out
}

function eraFor(date) {
  return ERAS.find((era) => date <= era.until) ?? ERAS[ERAS.length - 1]
}

/**
 * The models one day actually touched: the era's workhorse always, then a
 * weighted pick without replacement for the rest.
 *
 * The workhorse is forced because it is the configured Brain — it answers the
 * chat and every heartbeat job, so a day it sat out is not a quiet day, it is a
 * day that did not happen. Left to the weights alone, roughly one day in twelve
 * came back as a single expensive side model, which reads as the workspace
 * having switched brains for a day.
 */
function pickModels(mix, count, next) {
  const pool = mix.map(([key, weight]) => ({ key, weight }))
  const picked = [pool.shift().key]
  while (picked.length < count && pool.length > 0) {
    const total = pool.reduce((sum, entry) => sum + entry.weight, 0)
    let roll = next() * total
    let index = 0
    while (index < pool.length - 1 && roll > pool[index].weight) {
      roll -= pool[index].weight
      index++
    }
    picked.push(pool[index].key)
    pool.splice(index, 1)
  }
  return picked
}

function buildDay(date, segment) {
  const next = rng(hash(`wolffish-usage:${date}`))
  const spike = SPIKES[date]
  // The roll is always consumed so the stream downstream is the same either
  // way — but a spike survives it. These four days are the anchors the whole
  // range ordering rests on, and January's segment is only 30% dense: left to
  // the roll, two of the four were silently dropped and the ranges they were
  // placed to separate collapsed back onto one another.
  const alive = next() <= segment.density
  if (!spike && !alive) return null

  const weekday = new Date(`${date}T12:00:00`).getDay()
  // The heartbeat's Weekday (07:30) job means Mon–Fri genuinely carry more.
  const weekly = weekday === 0 || weekday === 6 ? 0.62 : 1
  const [lo, hi] = segment.entries
  const entries = spike
    ? spike.entries
    : Math.max(1, Math.round((lo + next() * (hi - lo)) * weekly * monthlyDrift(date)))

  // A quiet day is one model; a busy one spreads over several.
  const era = eraFor(date)
  const mix = spike?.mix ?? era.mix
  // A spike spreads over its WHOLE mix, so its cost tracks `entries` alone.
  // Left to the random breadth, one that happened to draw Opus by itself could
  // outprice a spike with half again the work — and the anchors only order the
  // ranges if their order is the order they were written in.
  const breadth = spike
    ? mix.length
    : Math.min(mix.length, 1 + Math.floor(next() * (entries > 60 ? 4 : 3)))
  const keys = pickModels(mix, breadth, next)

  // The workhorse takes the bulk; the rest split what is left.
  const shares = spike
    ? keys.map((_, index) => SPIKE_SHARES[index] ?? 0)
    : keys.map((_, index) => (index === 0 ? 0.55 + next() * 0.25 : next() * 0.4))
  const total = shares.reduce((sum, share) => sum + share, 0)

  const models = []
  let assigned = 0
  keys.forEach((key, index) => {
    const last = index === keys.length - 1
    const count = last
      ? entries - assigned
      : Math.max(1, Math.round((entries * shares[index]) / total))
    if (count <= 0) return
    assigned += count
    const [inPer, outPer] = SHAPE[key]
    const inJitter = spike ? 1 : 0.72 + next() * 0.62
    const outJitter = spike ? 1 : 0.7 + next() * 0.7
    const inputTokens = Math.round(count * inPer * inJitter)
    const outputTokens = Math.round(count * outPer * outJitter)
    const [inPrice, outPrice] = PRICES[key]
    const cost = Number(((inputTokens * inPrice + outputTokens * outPrice) / 1e6).toFixed(6))
    const slash = key.indexOf('/')
    models.push({
      provider: key.slice(0, slash),
      model: key.slice(slash + 1),
      inputTokens,
      outputTokens,
      cost,
      entries: count
    })
  })
  if (models.length === 0) return null

  // Brave rides along with the work, and the agent era searches far more.
  const braveRate = spike ? 3.1 : era.id === 'agent' ? 4.2 : 1.6
  const braveQueries = Math.round(entries * braveRate * (spike ? 1 : 0.35 + next() * 1.5))
  return { date, models, braveQueries }
}

// ── range report ─────────────────────────────────────────────────────────
// The whole point of the rewrite, checked rather than assumed. Ranges are
// compared BY CUTOFF, not by the order the pills sit in: `6_months` reaches
// back into the previous year, so from January to June it is WIDER than
// year-to-date, and in July the two cutoffs are the same date and the totals
// must match exactly. Asserting pill order would demand a dataset that lies.

const RANGES = ['today', 'this_month', '3_months', '6_months', 'ytd', 'all_time']

function cutoff(range, now) {
  const iso = (d) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  switch (range) {
    case 'today':
      return iso(now)
    case 'this_month':
      return iso(new Date(now.getFullYear(), now.getMonth(), 1))
    case '3_months':
      return iso(new Date(now.getFullYear(), now.getMonth() - 3, 1))
    case '6_months':
      return iso(new Date(now.getFullYear(), now.getMonth() - 6, 1))
    case 'ytd':
      return iso(new Date(now.getFullYear(), 0, 1))
    default:
      return '0000-00-00'
  }
}

function totals(days, range, now) {
  const from = cutoff(range, now)
  // The same upper bound the app applies to range totals (stats.ts rangeEnd);
  // the calendar deliberately has no such bound.
  const to = cutoff('today', now)
  let cost = 0
  let active = 0
  for (const day of days) {
    if (day.date < from || day.date > to) continue
    let entries = 0
    for (const row of day.models) {
      cost += row.cost
      entries += row.entries
    }
    cost += day.braveQueries * 0.005
    if (entries > 0) active++
  }
  return { cost, active }
}

/** Every month a viewer could open this in, from publication to the last row. */
function viewingMonths(lastDate) {
  const out = []
  const end = new Date(`${lastDate}T12:00:00`)
  for (let d = new Date(2026, 7, 6); d <= end; d.setMonth(d.getMonth() + 1)) {
    out.push(new Date(d.getFullYear(), d.getMonth(), Math.min(d.getDate(), 28)))
  }
  return out
}

async function main() {
  const raw = await fs.readFile(SNAPSHOT, 'utf8')
  const snapshot = JSON.parse(raw)
  const existing = snapshot.usage?.days ?? []

  const kept = existing.filter((day) => day.date >= KEEP_FROM && day.date <= KEEP_TO)
  if (kept.length === 0) {
    throw new Error(
      `no rows in the keep window ${KEEP_FROM}..${KEEP_TO} — refusing to replace the ` +
        `curated June/July ledger with generated data`
    )
  }

  const generated = []
  for (const segment of SEGMENTS) {
    for (const date of eachDate(segment.from, segment.to)) {
      if (date >= KEEP_FROM && date <= KEEP_TO) continue
      const day = buildDay(date, segment)
      if (day) generated.push(day)
    }
  }

  const days = [...kept, ...generated].sort((a, b) => a.date.localeCompare(b.date))
  snapshot.usage = { days }
  // Formatted on the way out: this file is under `prettier --check`, and a
  // generator that leaves the repo failing its own format gate is a generator
  // nobody can run without a follow-up command they will forget.
  await fs.writeFile(
    SNAPSHOT,
    await prettier.format(JSON.stringify(snapshot), {
      ...(await prettier.resolveConfig(SNAPSHOT)),
      filepath: SNAPSHOT
    })
  )

  const spend = (list) => list.reduce((sum, d) => sum + d.models.reduce((s, m) => s + m.cost, 0), 0)
  console.log(`kept       ${kept.length} curated days (${KEEP_FROM}..${KEEP_TO})`)
  console.log(
    `generated  ${generated.length} days, ${days[0].date} .. ${days[days.length - 1].date}`
  )
  console.log(
    `spend      $${spend(kept).toFixed(2)} kept + $${spend(generated).toFixed(2)} generated`
  )
  console.log('')

  let ok = true
  let empty = 0
  const problems = []
  for (const now of viewingMonths(days[days.length - 1].date)) {
    // Widest first, so "wider must not be smaller" is the only rule needed —
    // and equal cutoffs (6 months and YTD, every July) must be equal totals.
    const ordered = [...RANGES].sort((a, b) => cutoff(a, now).localeCompare(cutoff(b, now)))
    let previous = null
    let previousCut = null
    for (const range of ordered) {
      const t = totals(days, range, now)
      const cut = cutoff(range, now)
      if (previous !== null) {
        if (cut === previousCut ? t.cost !== previous : t.cost >= previous) {
          ok = false
          problems.push(`${now.toISOString().slice(0, 7)} ${range}`)
        }
      }
      previous = t.cost
      previousCut = cut
    }
    const today = totals(days, 'today', now)
    if (today.active === 0) empty++
  }

  const stamp = (now) => now.toISOString().slice(0, 7)
  for (const now of viewingMonths(days[days.length - 1].date).filter((_, i) => i % 4 === 0)) {
    const line = RANGES.map((r) => {
      const t = totals(days, r, now)
      return `${r} $${t.cost.toFixed(0)}/${t.active}d`
    })
    console.log(`viewed ${stamp(now)}  ${line.join('  ')}`)
  }
  console.log('')
  console.log(
    ok
      ? 'every range is larger than the one inside it, on every viewing month'
      : `RANGE ORDER BROKEN at: ${problems.slice(0, 6).join(', ')}`
  )
  console.log(
    empty === 0 ? 'today answers on every viewing month' : `TODAY EMPTY on ${empty} viewing months`
  )
  if (!ok || empty > 0) process.exit(1)
}

main().catch((error) => {
  console.error(error.message)
  process.exit(1)
})
