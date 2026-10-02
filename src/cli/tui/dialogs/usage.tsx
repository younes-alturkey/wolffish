/**
 * Usage: the app's usage panel as one dialog — totals, providers, models,
 * and a daily strip for the year — with a range picker.
 */
import { TextAttributes } from '@opentui/core'
import { createSignal, For, onMount, Show, type JSX } from 'solid-js'
import { useApp } from '../context'
import { money, tokens } from '../format'
import { theme } from '../theme'
import { DialogHeader } from '../ui/Dialog'

const RANGES: Array<{ value: string; label: string }> = [
  { value: 'today', label: 'Today' },
  { value: 'this_month', label: 'This month' },
  { value: '3_months', label: '3 months' },
  { value: '6_months', label: '6 months' },
  { value: 'ytd', label: 'Year to date' },
  { value: 'all_time', label: 'All time' }
]
const ALIASES: Record<string, string> = {
  day: 'today',
  month: 'this_month',
  week: 'this_month',
  year: 'ytd',
  all: 'all_time'
}

type Summary = {
  providers?: Array<{
    provider: string
    totalInputTokens: number
    totalOutputTokens: number
    totalCost: number
    models?: Array<{ model: string; inputTokens: number; outputTokens: number; cost: number }>
  }>
  brave?: { totalQueries: number; totalCost: number }
}
type Stats = {
  totalCost: number
  topSpendDay?: { date: string; cost: number } | null
  conversations: number
  messages: number
  totalTokens: number
  activeDays: number
  longestStreak: number
  favouriteModel?: string | null
}

export function UsageDialog(props: { range?: string }): JSX.Element {
  const app = useApp()
  const p = theme
  const initial = ALIASES[props.range ?? ''] ?? props.range ?? 'this_month'
  const [range, setRange] = createSignal(
    RANGES.some((r) => r.value === initial) ? initial : 'this_month'
  )
  const [summary, setSummary] = createSignal<Summary | null>(null)
  const [stats, setStats] = createSignal<Stats | null>(null)
  const [daily, setDaily] = createSignal<Array<{ date: string; cost: number }>>([])
  const [loading, setLoading] = createSignal(true)

  const load = async () => {
    setLoading(true)
    const [s, st] = await Promise.all([
      app.client.invoke<Summary>('usage:getSummary', range()).catch(() => null),
      app.client.invoke<Stats>('usage:getStats', range()).catch(() => null)
    ])
    setSummary(s)
    setStats(st)
    const d = await app.client
      .invoke<unknown>('usage:getDaily', new Date().getFullYear())
      .catch(() => null)
    setDaily(normalizeDaily(d))
    setLoading(false)
  }
  onMount(() => {
    app.dialog.setSize('xlarge')
    void load()
  })
  app.dialog.setKeyHandler((key) => {
    if (key.name === 'escape' || key.name === 'q') return app.dialog.clear()
    if (key.name === 'left' || key.name === 'h' || (key.name === 'tab' && key.shift)) {
      const i = RANGES.findIndex((r) => r.value === range())
      setRange(RANGES[(i + RANGES.length - 1) % RANGES.length].value)
      void load()
    } else if (key.name === 'right' || key.name === 'l' || key.name === 'tab') {
      const i = RANGES.findIndex((r) => r.value === range())
      setRange(RANGES[(i + 1) % RANGES.length].value)
      void load()
    } else if (key.name === 'r') {
      void app.client
        .invoke('usage:sync')
        .then(load)
        .catch((e) => app.toast.error(e))
    }
  })

  const used = () =>
    (summary()?.providers ?? []).filter((x) => x.totalInputTokens + x.totalOutputTokens > 0)
  const Row = (r: { k: string; v: JSX.Element }) => (
    <box flexDirection="row" paddingLeft={3}>
      <text fg={p().muted}>{r.k.padEnd(16)}</text>
      <text fg={p().text}>{r.v}</text>
    </box>
  )
  const strip = () => {
    const days = daily().slice(-30)
    if (days.length === 0) return null
    const max = Math.max(...days.map((d) => d.cost), 0.0001)
    const blocks = ' ▁▂▃▄▅▆▇█'
    return days.map((d) => blocks[Math.min(8, Math.round((d.cost / max) * 8))]).join('')
  }
  return (
    <box flexDirection="column">
      <DialogHeader title="Usage" right="← → range · r resync · esc" />
      <box flexDirection="row" gap={2} paddingLeft={3} marginTop={1}>
        <For each={RANGES}>
          {(r) => (
            <text
              fg={range() === r.value ? p().accent : p().muted}
              attributes={range() === r.value ? TextAttributes.BOLD : TextAttributes.NONE}
              onMouseUp={() => {
                setRange(r.value)
                void load()
              }}
            >
              {r.label}
            </text>
          )}
        </For>
      </box>
      <Show
        when={!loading()}
        fallback={
          <box paddingLeft={3} marginTop={1}>
            <text fg={p().muted}>Loading…</text>
          </box>
        }
      >
        <Show when={stats()}>
          {(s) => (
            <box flexDirection="column" marginTop={1}>
              <Row k="total spend" v={<span style={{ bold: true }}>{money(s().totalCost)}</span>} />
              <Row
                k="top day"
                v={
                  s().topSpendDay
                    ? `${money(s().topSpendDay?.cost)}  ${s().topSpendDay?.date}`
                    : '—'
                }
              />
              <Row
                k="daily average"
                v={money(s().activeDays > 0 ? s().totalCost / s().activeDays : 0)}
              />
              <Row k="conversations" v={String(s().conversations ?? 0)} />
              <Row k="messages" v={String(s().messages ?? 0)} />
              <Row k="tokens" v={tokens(s().totalTokens)} />
              <Row k="active days" v={`${s().activeDays} · longest streak ${s().longestStreak}`} />
              <Row k="favourite model" v={s().favouriteModel ?? '—'} />
            </box>
          )}
        </Show>
        <Show when={strip()}>
          <box flexDirection="column" marginTop={1} paddingLeft={3}>
            <text fg={p().muted}>last 30 days</text>
            <text fg={p().accent}>{strip()}</text>
          </box>
        </Show>
        <box flexDirection="column" marginTop={1} paddingLeft={3}>
          <Show
            when={used().length > 0}
            fallback={<text fg={p().muted}>no model usage in this range</text>}
          >
            <text fg={p().muted}>
              {'provider'.padEnd(14) + 'in'.padStart(9) + 'out'.padStart(9) + 'cost'.padStart(10)}
            </text>
            <For each={used()}>
              {(pr) => (
                <box flexDirection="column">
                  <text fg={p().text}>
                    {pr.provider.padEnd(14)}
                    {tokens(pr.totalInputTokens).padStart(9)}
                    {tokens(pr.totalOutputTokens).padStart(9)}
                    {money(pr.totalCost).padStart(10)}
                  </text>
                  <For each={pr.models ?? []}>
                    {(m) => (
                      <text fg={p().muted}>
                        {('  ' + m.model).slice(0, 14).padEnd(14)}
                        {tokens(m.inputTokens).padStart(9)}
                        {tokens(m.outputTokens).padStart(9)}
                        {money(m.cost).padStart(10)}
                      </text>
                    )}
                  </For>
                </box>
              )}
            </For>
          </Show>
          <Show when={summary()?.brave && (summary()?.brave?.totalQueries ?? 0) > 0}>
            <text
              fg={p().muted}
            >{`brave search   ${summary()?.brave?.totalQueries} queries  ${money(summary()?.brave?.totalCost)}`}</text>
          </Show>
        </box>
      </Show>
    </box>
  )
}

function normalizeDaily(input: unknown): Array<{ date: string; cost: number }> {
  if (!input) return []
  const rows: Array<{ date: string; cost: number }> = []
  const push = (date: unknown, value: unknown) => {
    const cost =
      typeof value === 'number'
        ? value
        : typeof (value as { cost?: number })?.cost === 'number'
          ? (value as { cost: number }).cost
          : 0
    if (typeof date === 'string') rows.push({ date, cost })
  }
  if (Array.isArray(input))
    for (const row of input)
      push((row as { date?: string }).date ?? (row as { day?: string }).day, row)
  else if (typeof input === 'object')
    for (const [date, value] of Object.entries(input as Record<string, unknown>)) push(date, value)
  return rows.sort((a, b) => a.date.localeCompare(b.date))
}
