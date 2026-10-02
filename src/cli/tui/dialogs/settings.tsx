/**
 * Settings: page → card → row, the desktop's own nav, as three levels of
 * one select dialog — plus a flat search across every row. Scalar rows
 * (boolean, enum, number, string, secret) edit natively; the flows the app
 * runs as actions (pairing, key tests, MCP servers…) hand off to the classic
 * line-mode implementation under a suspended renderer, so nothing is missing.
 */
import { createSignal, onMount, type JSX } from 'solid-js'
import { useApp } from '../context'
import { truncate } from '../format'
import { ask, DialogSelect, type SelectOption } from '../ui/Dialog'
import { pressEnter } from '../legacy'

type Group = {
  id: string
  label: string
  count: number
  sections: Array<{ id: string; group: string; label: string; count: number }>
  interactive: boolean
}
type Card = {
  id: string
  group: string
  section: string
  kind: 'boolean' | 'enum' | 'number' | 'string' | 'secret'
  label: string
  description: string
  value: unknown
  display: string
  actual?: string | null
  actualOk?: boolean | null
  options?: Array<{ value: string; label: string }>
  hint?: string | null
}
type Action = {
  section: string
  label: string
  view?: boolean
  run: (client: unknown) => Promise<unknown>
}

let cache: { groups: Group[]; cards: Card[]; actions: Action[] } | null = null

async function load(app: ReturnType<typeof useApp>, force = false) {
  if (cache && !force) return cache
  const [groups, cards, mod] = await Promise.all([
    app.client.invoke<Group[]>('cli:settingGroups'),
    app.client.invoke<Card[]>('cli:describeSettings'),
    import('../../commands/settings-actions.mjs') as Promise<{ ACTIONS: Action[] }>
  ])
  cache = { groups, cards, actions: mod.ACTIONS }
  return cache
}

export function invalidateSettings(): void {
  cache = null
}

/* ───────────────────────── pages ───────────────────────── */

export function SettingsDialog(props: {
  page?: string
  card?: string
  query?: string
}): JSX.Element {
  const app = useApp()
  const [data, setData] = createSignal<Awaited<ReturnType<typeof load>> | null>(null)
  onMount(() => {
    app.dialog.setSize('large')
    void load(app)
      .then(setData)
      .catch((e) => app.toast.error(e))
  })
  const page = () =>
    data()?.groups.find(
      (g) => g.id === props.page || g.label.toLowerCase() === props.page?.toLowerCase()
    )
  const options = (): SelectOption<{
    kind: 'page' | 'card' | 'row' | 'action'
    id: string
    group?: string
  }>[] => {
    const d = data()
    if (!d) return []
    if (props.query) {
      // Flat search across every row and action.
      return [
        ...d.cards.map((c) => ({
          title: c.label,
          value: { kind: 'row' as const, id: c.id },
          description: truncate(c.description, 40),
          category: `${d.groups.find((g) => g.id === c.group)?.label ?? c.group} › ${c.section}`,
          footer: c.display
        })),
        ...d.actions.map((a, i) => ({
          title: a.label,
          value: { kind: 'action' as const, id: String(i) },
          category: a.section,
          footer: a.view ? 'view' : 'action'
        }))
      ]
    }
    const current = page()
    if (!current) {
      return d.groups.map((g) => ({
        title: g.label,
        value: { kind: 'page' as const, id: g.id },
        footer: g.count > 0 ? `${g.count} setting${g.count === 1 ? '' : 's'}` : 'actions'
      }))
    }
    if (!props.card) {
      return current.sections.map((s) => ({
        title: s.label,
        value: { kind: 'card' as const, id: s.id, group: current.id },
        footer: s.count > 0 ? `${s.count} setting${s.count === 1 ? '' : 's'}` : 'actions'
      }))
    }
    const rows = d.cards.filter((c) => c.group === current.id && c.section === props.card)
    const acts = d.actions
      .map((a, i) => ({ a, i }))
      .filter(({ a }) => a.section === `${current.id}.${props.card}` || a.section === props.card)
    return [
      ...rows.map((c) => ({
        title: c.label,
        value: { kind: 'row' as const, id: c.id },
        description: c.actualOk === false ? '⚠ differs from the OS' : undefined,
        footer: c.display,
        details: c.description ? [truncate(c.description, 84)] : undefined,
        category: 'Settings'
      })),
      ...acts.map(({ a, i }) => ({
        title: a.label,
        value: { kind: 'action' as const, id: String(i) },
        footer: a.view ? 'view' : '→',
        category: 'Actions'
      }))
    ]
  }
  const title = () => {
    if (props.query) return `Settings · search "${props.query}"`
    const p = page()
    if (!p) return 'Settings'
    if (!props.card) return `Settings › ${p.label}`
    const s = p.sections.find((x) => x.id === props.card)
    return `Settings › ${p.label} › ${s?.label ?? props.card}`
  }
  const back = () => {
    if (props.query) return app.dialog.replace(() => <SettingsDialog />)
    if (props.card) return app.dialog.replace(() => <SettingsDialog page={props.page} />)
    if (props.page) return app.dialog.replace(() => <SettingsDialog />)
    app.dialog.clear()
  }
  return (
    <DialogSelect
      title={title()}
      options={options()}
      loading={data() === null}
      placeholder={props.query ? props.query : 'Search this level, or type to filter'}
      onSelect={(o) => {
        const v = o.value
        if (v.kind === 'page') return app.dialog.replace(() => <SettingsDialog page={v.id} />)
        if (v.kind === 'card')
          return app.dialog.replace(() => <SettingsDialog page={v.group} card={v.id} />)
        if (v.kind === 'row') {
          const card = data()?.cards.find((c) => c.id === v.id)
          if (card)
            void editRow(app, card, () =>
              app.dialog.replace(() => (
                <SettingsDialog page={props.page} card={props.card} query={props.query} />
              ))
            )
          return
        }
        const action = data()?.actions[Number(v.id)]
        if (action) void runAction(app, action)
      }}
      actions={[{ key: 'card_left', title: 'back', onTrigger: back }]}
      hints={[props.query ? 'enter open' : 'enter open · ← back']}
    />
  )
}

/* ───────────────────────── editing ───────────────────────── */

async function editRow(
  app: ReturnType<typeof useApp>,
  card: Card,
  after: () => void
): Promise<void> {
  const save = async (value: unknown) => {
    try {
      await app.client.invoke('cli:setSetting', { id: card.id, value })
      app.toast.success(`${card.label}: saved`)
      invalidateSettings()
    } catch (error) {
      app.toast.error(error)
    }
    after()
  }
  if (card.kind === 'boolean') {
    await save(card.value !== true)
    return
  }
  if (card.kind === 'enum' && card.options?.length) {
    app.dialog.replace(() => (
      <DialogSelect
        title={card.label}
        options={card.options!.map((o) => ({ title: o.label, value: o.value }))}
        current={String(card.value ?? '')}
        onSelect={(o) => void save(o.value)}
        hints={[truncate(card.description, 70)]}
      />
    ))
    return
  }
  const value = await ask(app, {
    title: card.label,
    value: card.kind === 'secret' ? '' : String(card.value ?? ''),
    hidden: card.kind === 'secret',
    placeholder: card.hint ?? (card.kind === 'secret' ? 'paste the secret' : 'value'),
    hint: `${card.hint ? card.hint + ' · ' : ''}enter save · esc cancel`
  })
  if (value === null) return after()
  if (card.kind === 'number') {
    const n = Number(value)
    if (!Number.isFinite(n)) {
      app.toast.error('not a number')
      return after()
    }
    await save(n)
    return
  }
  await save(value)
}

async function runAction(app: ReturnType<typeof useApp>, action: Action): Promise<void> {
  app.dialog.clear()
  await app.suspend(async () => {
    process.stdout.write(`\n  ${action.label}\n\n`)
    try {
      await action.run(app.client)
    } catch (error) {
      process.stderr.write(`\n${(error as Error)?.message ?? String(error)}\n`)
    }
    await pressEnter()
  })
  invalidateSettings()
  await app.actions.refreshSnapshot()
}

/** Jump straight to a page or card by name, as `/settings telegram` does. */
export async function openSettings(app: ReturnType<typeof useApp>, target: string): Promise<void> {
  const word = target.trim().toLowerCase()
  if (!word) return app.dialog.replace(() => <SettingsDialog />)
  const d = await load(app)
  const page = d.groups.find((g) => g.id.toLowerCase() === word || g.label.toLowerCase() === word)
  if (page) return app.dialog.replace(() => <SettingsDialog page={page.id} />)
  for (const g of d.groups) {
    const card = g.sections.find(
      (s) =>
        s.id.toLowerCase() === word ||
        s.label.toLowerCase() === word ||
        s.label.toLowerCase().includes(word)
    )
    if (card) return app.dialog.replace(() => <SettingsDialog page={g.id} card={card.id} />)
  }
  app.dialog.replace(() => <SettingsDialog query={target.trim()} />)
}
