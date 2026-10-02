/**
 * `wolffish settings` — the settings browser.
 *
 * It is the window's own shape, walked in a terminal: PAGE → CARD → SETTING.
 *
 *   wolffish settings                     the pages
 *   wolffish settings channels            that page's cards
 *   wolffish settings channels telegram   that card's settings and flows
 *   wolffish settings telegram            the same card, named directly
 *   wolffish settings verbose             everything matching, wherever it lives
 *
 * The hierarchy is not decoration. Labels in this app are CARD-SCOPED — inside
 * a Telegram card, a row called "Status" or "Show all tool activity" is
 * unambiguous, and four channels legitimately carry the same two words. Print
 * them as one flat list and the result is what this replaced: fifty-six rows
 * with "Show all tool activity" appearing four times and no way to tell which
 * one is WhatsApp's. Grouping is the disambiguation, and it is also how
 * someone who knows where a setting lives on screen finds it here.
 *
 * Blank always goes UP one level (and out at the top), so there is one key to
 * learn rather than a different escape at each depth.
 */
import {
  c,
  g,
  heading,
  icon,
  interactive,
  out,
  question,
  table,
  visibleLength,
  wrapText
} from '../lib/ui.mjs'
import { actionsFor } from './settings-actions.mjs'

/**
 * Everything the browser renders.
 *
 * Cached, and deliberately so. This is two IPC round-trips — a group tree and
 * a full describe over every setting in the app — and it used to run on
 * entry, AGAIN immediately after, and then once more per keystroke. On this
 * machine that is about a second each: opening the browser cost two seconds
 * before it drew anything, and every number you pressed cost another one,
 * which reads as a menu that has hung rather than a menu that is thinking.
 *
 * The cache is invalidated the moment anything could have changed it — a
 * setting written, a flow run — because the ONE property this listing must keep
 * is showing what holds rather than what was asked for. `stale()` is called
 * from exactly those two places, so a cached read can never outlive a write.
 */
let cache = null

function stale() {
  cache = null
}

async function load(client) {
  if (cache) return cache
  const [groups, cards] = await Promise.all([
    client.invoke('cli:settingGroups'),
    client.invoke('cli:describeSettings')
  ])
  cache = { groups, cards }
  return cache
}

const sectionsOf = (groups) => groups.flatMap((group) => group.sections ?? [])

const rowsIn = (cards, sectionId) => cards.filter((card) => card.section === sectionId)

/** A card is worth entering when it holds rows or flows. */
const cardSize = (cards, sectionId) =>
  rowsIn(cards, sectionId).length + actionsFor(sectionId).length

/**
 * What the user typed, as a place to start.
 *
 * Page name, card name, `page card`, or anything else — which becomes a
 * search. Matching is on ids and labels, and a single hit wins outright: a
 * user who types `notion` means the Notion card, not a menu that leads to it.
 */
function resolveTarget({ groups, cards }, words) {
  if (words.length === 0) return { kind: 'pages' }
  const needle = words.join(' ').toLowerCase()
  const sections = sectionsOf(groups)

  const page = groups.find(
    (group) => group.id.toLowerCase() === needle || group.label.toLowerCase() === needle
  )
  if (page) return { kind: 'page', id: page.id }

  const fullId = sections.find((section) => section.id.toLowerCase() === needle)
  if (fullId) return { kind: 'card', id: fullId.id }

  // `channels telegram` — a page and a card, the way the breadcrumb reads.
  if (words.length > 1) {
    const twoPart = sections.find(
      (section) => section.id.toLowerCase() === words.join('.').toLowerCase()
    )
    if (twoPart) return { kind: 'card', id: twoPart.id }
  }

  // A bare card name or id suffix, but ONLY when it names one card. Two pages
  // end in `.general`; picking whichever came first would send someone to
  // Preferences when they typed a word that also means Appearance, and they
  // would have no way to tell they had been sent somewhere else.
  const named = sections.filter(
    (section) =>
      section.id.split('.').pop().toLowerCase() === needle || section.label.toLowerCase() === needle
  )
  if (named.length === 1) return { kind: 'card', id: named[0].id }

  const partialCards = sections.filter((section) =>
    `${section.id} ${section.label}`.toLowerCase().includes(needle)
  )
  const matchingRows = cards.filter((card) =>
    `${card.id} ${card.label}`.toLowerCase().includes(needle)
  )
  if (partialCards.length === 1 && matchingRows.length === 0) {
    return { kind: 'card', id: partialCards[0].id }
  }
  return { kind: 'search', needle }
}

export async function settingsBrowser(client, args, { json = false } = {}) {
  const words = args.filter((arg) => !arg.startsWith('-'))
  // Fresh on every entry. Inside a session the same process may have opened
  // this an hour ago, and the desktop window, a channel or `/set` can all have
  // moved a value since — the cache is for the walk, never across walks.
  stale()

  if (json) {
    const { groups, cards } = await load(client)
    out(JSON.stringify({ pages: groups, settings: cards }, null, 2))
    return 0
  }

  const first = await load(client)
  // A stack, so blank walks back out the way it came in — and a card reached
  // by name has the page above it, not nothing.
  const stack = [{ kind: 'pages' }]
  const target = resolveTarget(first, words)
  if (target.kind === 'page') stack.push(target)
  if (target.kind === 'card') {
    const owner = sectionsOf(first.groups).find((section) => section.id === target.id)
    // The page goes on the stack so blank steps up to its siblings — unless it
    // has no siblings, in which case that step would be a level the walk-out
    // immediately walks through again, showing the same card twice.
    if (owner && pageCardItems(first, owner.group).length > 1) {
      stack.push({ kind: 'page', id: owner.group })
    }
    stack.push(target)
  }
  if (target.kind === 'search') stack.push(target)

  // Re-read between edits rather than mutating a cached copy: a handler may
  // normalise, and one setting can move another (turning a channel off, a
  // capability refusing). The listing has to show what HOLDS.
  for (;;) {
    const model = await load(client)

    /**
     * A page whose only content is one card is a menu with one door in it.
     * Walk straight through — Appearance, Updates, Preferences, Usage and the
     * flow pages are all single cards, and pressing 1 to see two rows is
     * friction for its own sake.
     *
     * REPLACING the page on the stack rather than pushing the card onto it is
     * the whole of the correctness here. Pushing made blank pop the card, land
     * back on the page, and walk straight through again — a level you could
     * enter and never leave, on eight of the twelve pages.
     */
    if (stack[stack.length - 1].kind === 'page') {
      const only = pageCardItems(model, stack[stack.length - 1].id)
      if (only.length === 1) {
        stack[stack.length - 1] = { kind: 'card', id: only[0].id }
        continue
      }
    }

    const view = stack[stack.length - 1]
    const chosen = await renderAndAsk(client, model, view, stack.length > 1)
    if (chosen === null) {
      stack.pop()
      if (stack.length === 0) return 0
      continue
    }
    if (chosen === 'quit') return 0
    if (chosen.kind === 'search') {
      stack.push(chosen)
      continue
    }
    if (chosen.kind === 'page' || chosen.kind === 'card') {
      stack.push(chosen)
      continue
    }
    if (chosen.kind === 'action') {
      out()
      // A flow can change anything — a key, a capability, a channel, the whole
      // workspace. Nothing here knows WHAT it touched, so the honest move is to
      // drop the cache and re-read before drawing the listing again.
      await guard(() => chosen.action.run(client))
      stale()
      out()
      continue
    }
    if (chosen.kind === 'setting') {
      out()
      await guard(() => editSetting(client, chosen.card))
      stale()
      out()
    }
  }
}

/**
 * Run one flow. A flow that throws must not end the session.
 *
 * Every one of these reaches a live service — a rejected IPC, a provider that
 * is down, a token the API refuses. Unguarded, any of those unwound the whole
 * browser and, when it was opened from the REPL with `/settings`, took the
 * prompt with it: the readline had been paused and the `resume` never ran, so
 * the terminal sat there accepting nothing. One failed lookup should cost the
 * lookup, not the session.
 */
async function guard(run) {
  try {
    return await run()
  } catch (error) {
    out(`${icon.fail()} ${c.red(error?.message ?? String(error))}`)
    return 1
  }
}

/**
 * Draw one level and take one answer. Returns the chosen item, null to go up,
 * or 'quit'.
 */
async function renderAndAsk(client, model, view, canGoBack) {
  const items =
    view.kind === 'pages'
      ? pageItems(model)
      : view.kind === 'page'
        ? pageCardItems(model, view.id)
        : view.kind === 'card'
          ? cardItems(model, view.id)
          : searchItems(model, view.needle)

  heading(breadcrumb(model, view))

  if (items.length === 0) {
    out(c.yellow(view.kind === 'search' ? `  nothing matches "${view.needle}"` : '  nothing here'))
    out()
    if (!interactive()) return null
    await question(`  ${c.dim('enter to go back')}: `)
    return null
  }

  render(items)
  out()
  out(c.gray(`  ${hint(view, items)}${canGoBack ? ' · blank goes back' : ' · blank exits'}`))

  if (!interactive()) return null
  const answer = (await question(`  ${c.dim('number, or type to search')}: `)).trim()
  if (!answer) return null
  if (answer === 'q' || answer === 'quit' || answer === 'exit') return 'quit'

  if (/^\d+$/.test(answer)) {
    // Against the SELECTABLE items, not the printed ones: a spacer occupies a
    // line and no number, which is how the printed numbers stay contiguous.
    const selectable = items.filter((item) => item.kind !== 'spacer')
    const chosen = selectable[Number.parseInt(answer, 10) - 1]
    if (!chosen) {
      out(
        c.red(
          `  no such item — pick 1${selectable.length > 1 ? `-${selectable.length}` : ''}, or leave it blank to go back`
        )
      )
      return await renderAndAsk(client, model, view, canGoBack)
    }
    return chosen
  }
  return { kind: 'search', needle: answer.toLowerCase() }
}

function breadcrumb(model, view) {
  const sections = sectionsOf(model.groups)
  if (view.kind === 'pages') return 'Settings'
  if (view.kind === 'search') return `Settings ${g.chevron} "${view.needle}"`
  if (view.kind === 'page') {
    const page = model.groups.find((group) => group.id === view.id)
    return `Settings ${g.chevron} ${page?.label ?? view.id}`
  }
  const section = sections.find((entry) => entry.id === view.id)
  const page = model.groups.find((group) => group.id === section?.group)
  const card = section?.label ?? view.id
  // "Settings › Appearance › Appearance" tells the reader nothing twice.
  if (!page?.label || page.label === card) return `Settings ${g.chevron} ${card}`
  return `Settings ${g.chevron} ${page.label} ${g.chevron} ${card}`
}

function hint(view, items) {
  const count = items.filter((item) => item.kind !== 'spacer').length
  if (view.kind === 'pages') return `${count} ${count === 1 ? 'page' : 'pages'}`
  if (view.kind === 'page') return `${count} ${count === 1 ? 'card' : 'cards'}`
  if (view.kind === 'card') {
    return countLabel(
      items.filter((item) => item.kind === 'setting').length,
      items.filter((item) => item.kind === 'action' && item.action.view).length,
      items.filter((item) => item.kind === 'action' && !item.action.view).length,
      1
    )
  }
  return `${count} ${count === 1 ? 'result' : 'results'}`
}

// ─── The four levels, as item lists ─────────────────────────────────────────

function pageItems(model) {
  return model.groups
    .filter((group) =>
      (group.sections ?? []).some((section) => cardSize(model.cards, section.id) > 0)
    )
    .map((group) => {
      const sections = (group.sections ?? []).filter(
        (section) => cardSize(model.cards, section.id) > 0
      )
      return {
        kind: 'page',
        id: group.id,
        label: group.label,
        detail: countLabel(
          sections.reduce((sum, section) => sum + rowsIn(model.cards, section.id).length, 0),
          sections.reduce((sum, section) => sum + viewsIn(section.id), 0),
          sections.reduce((sum, section) => sum + actionsIn(section.id), 0),
          sections.length
        )
      }
    })
}

function pageCardItems(model, groupId) {
  const page = model.groups.find((group) => group.id === groupId)
  return (page?.sections ?? [])
    .filter((section) => cardSize(model.cards, section.id) > 0)
    .map((section) => ({
      kind: 'card',
      id: section.id,
      label: section.label,
      detail: countLabel(
        rowsIn(model.cards, section.id).length,
        viewsIn(section.id),
        actionsIn(section.id),
        1
      )
    }))
}

/**
 * A card's contents, in the order you would want to meet them: what it is set
 * to, what you can look at, and only then what you can change.
 *
 * The spacer between the two groups is why views and actions are separated at
 * all: "Disk usage" and "Factory reset" are one keystroke apart, and a menu
 * that does not visibly distinguish reading from erasing is a menu that will
 * eventually be misread.
 */
function cardItems(model, sectionId) {
  const flows = actionsFor(sectionId)
  const views = flows.filter((flow) => flow.view)
  const actions = flows.filter((flow) => !flow.view)
  return [
    ...rowsIn(model.cards, sectionId).map((card) => ({ kind: 'setting', card })),
    ...views.map((action) => ({ kind: 'action', action })),
    ...(views.length > 0 && actions.length > 0 ? [{ kind: 'spacer' }] : []),
    ...actions.map((action) => ({ kind: 'action', action }))
  ]
}

/**
 * Search spans every card, every row and every flow, and each hit says where
 * it lives. A result without its card is the original problem in miniature:
 * "Show all tool activity" four times over, indistinguishable.
 *
 * Cards are results too, not just containers — a word that names two cards
 * ("general" is both Preferences and Appearance) has to be answerable with
 * "here are both", and an ambiguous name that returned nothing would be worse
 * than one that guessed.
 */
function searchItems(model, needle) {
  const sections = sectionsOf(model.groups)
  const pageOf = (sectionId) => {
    const section = sections.find((entry) => entry.id === sectionId)
    return model.groups.find((group) => group.id === section?.group)?.label ?? ''
  }
  const where = (sectionId) => {
    const section = sections.find((entry) => entry.id === sectionId)
    return `${pageOf(sectionId)} ${g.chevron} ${section?.label ?? sectionId}`
  }
  const matches = (text) => String(text).toLowerCase().includes(needle)
  return [
    ...sections
      .filter(
        (section) =>
          cardSize(model.cards, section.id) > 0 &&
          (matches(section.id) || matches(section.label) || matches(pageOf(section.id)))
      )
      .map((section) => ({
        kind: 'card',
        id: section.id,
        label: section.label,
        // Four parameters, not three. Passing (rows, actions, 1) shifted every
        // count one slot left: flows were reported as "views", the action count
        // was always the literal 1, and a card with three flows read "1 action".
        detail: countLabel(
          rowsIn(model.cards, section.id).length,
          viewsIn(section.id),
          actionsIn(section.id),
          1
        ),
        // A single-card page names its card after itself; saying it twice on
        // one line tells the reader nothing they cannot already see.
        where: pageOf(section.id) === section.label ? null : pageOf(section.id)
      })),
    ...model.cards
      .filter((card) => matches(card.id) || matches(card.label) || matches(where(card.section)))
      .map((card) => ({ kind: 'setting', card, where: where(card.section) })),
    ...sections
      .flatMap((section) => actionsFor(section.id))
      .filter((action) => matches(action.label) || matches(where(action.section)))
      .map((action) => ({ kind: 'action', action, where: where(action.section) }))
  ]
}

/**
 * What is behind a door, in the words for what it actually is. A flow is not a
 * setting — "1 setting" on the MCP page, when the page is one server manager,
 * is the kind of small lie that makes a menu untrustworthy.
 */
function countLabel(rows, views, actions, cards) {
  const parts = []
  if (rows > 0) parts.push(`${rows} ${rows === 1 ? 'setting' : 'settings'}`)
  if (views > 0) parts.push(`${views} ${views === 1 ? 'view' : 'views'}`)
  if (actions > 0) parts.push(`${actions} ${actions === 1 ? 'action' : 'actions'}`)
  if (cards > 1) parts.push(`${cards} cards`)
  return parts.join(` ${g.dot} `)
}

const viewsIn = (sectionId) => actionsFor(sectionId).filter((flow) => flow.view).length
const actionsIn = (sectionId) => actionsFor(sectionId).filter((flow) => !flow.view).length

// ─── Drawing ────────────────────────────────────────────────────────────────

const VALUE_COLUMN = 46

function render(items) {
  let number = 0
  items.forEach((item) => {
    if (item.kind === 'spacer') {
      out()
      return
    }
    const n = c.cyan(String(++number).padStart(3))
    if (item.kind === 'page' || item.kind === 'card') {
      const gap = Math.max(1, VALUE_COLUMN - visibleLength(item.label))
      out(
        `  ${n}. ${item.label}${' '.repeat(gap)}${c.gray(item.detail)} ${c.gray(g.chevron)}` +
          // Only in search results, where a card called "Preferences" is
          // otherwise indistinguishable from a card called "Appearance".
          (item.where ? c.gray(`   ${item.where}`) : '')
      )
      return
    }
    if (item.kind === 'action') {
      // The chevron means "this goes somewhere and may change something". A
      // view prints and comes straight back, so it does not get one.
      const gap = Math.max(1, VALUE_COLUMN - visibleLength(item.action.label))
      out(
        `  ${n}. ${item.action.label}` +
          (item.action.view ? `${' '.repeat(gap)}${c.gray('view')}` : ` ${c.gray(g.chevron)}`) +
          (item.where ? c.gray(`   ${item.where}`) : '')
      )
      return
    }
    const { card } = item
    const value =
      card.kind === 'boolean'
        ? card.value === true
          ? c.green(card.display)
          : c.gray(card.display)
        : c.cyan(card.display)
    // A setting whose OS registration disagrees with its stored intent gets a
    // marker — the honest rendering of "you asked for this and the machine did
    // not do it".
    const flag = card.value === true && card.actualOk === false
    const gap = Math.max(1, VALUE_COLUMN - visibleLength(card.label))
    out(
      `  ${n}. ${card.label}${' '.repeat(gap)}${value}` +
        (flag ? ' ' + icon.warn() : '') +
        (item.where ? c.gray(`   ${item.where}`) : '')
    )
  })
}

/**
 * One setting's flow: show what it is and what it is set to, take a new value
 * in whatever shape it actually has, then READ BACK what holds.
 *
 * Reading back rather than echoing the input is the whole discipline here. A
 * handler may normalise, a locked capability may refuse, an OS registration
 * may fail — and reporting the request as though it were the result is how a
 * settings screen ends up lying.
 */
export async function editSetting(client, card) {
  out()
  out('  ' + c.bold(card.label))
  if (card.description) out(wrapText(c.gray(card.description), 2))
  out()
  out(
    `  ${c.gray('now')}  ${c.cyan(card.display)}${card.actual ? c.gray(` · ${card.actual}`) : ''}`
  )
  out(`  ${c.gray('id ')}  ${c.gray(card.id)}`)
  out()

  if (!interactive()) {
    out(c.gray(`  wolffish settings set ${card.id} <value>`))
    return 0
  }

  const next = await promptForValue(card)
  if (next === null) {
    out(c.gray('  unchanged'))
    return 0
  }

  const result = await client.invoke('cli:setSetting', { id: card.id, value: next })
  if (!result?.ok) {
    out(`${icon.fail()} ${c.red(result?.error ?? 'failed')}`)
    return 1
  }

  const after = (await client.invoke('cli:describeSettings')).find((entry) => entry.id === card.id)
  out(`${icon.ok()} ${c.bold(card.label)} ${c.gray('→')} ${c.cyan(after?.display ?? next)}`)
  if (after?.actual) out(c.gray(`  registered: ${after.actual}`))
  return 0
}

/** Returns the new value as a string, or null to leave it alone. */
async function promptForValue(card) {
  switch (card.kind) {
    case 'boolean': {
      // Enter toggles. The old prompt offered "[Enter] to turn off" and then
      // treated blank as a cancel — it read as a toggle and behaved as a
      // no-op, which is the worst of both. A switch should take one keystroke.
      const target = card.value === true ? 'off' : 'on'
      const answer = (
        await question(`  ${c.dim(`[Enter] turns it ${target} · on/off · c cancels`)}: `)
      )
        .trim()
        .toLowerCase()
      if (answer === '') return target
      if (answer === 'on' || answer === 'off') return answer
      if (answer === 'c' || answer === 'cancel') return null
      out(c.red('  expected on or off'))
      return null
    }

    case 'enum': {
      const options = card.options ?? []
      for (;;) {
        options.forEach((option, i) => {
          const current = String(card.value) === option.value ? c.green(' ' + g.current) : ''
          out(`   ${c.cyan(String(i + 1).padStart(2))}. ${option.label}${current}`)
        })
        out()
        const answer = (await question(`  ${c.dim(`1-${options.length}, blank cancels`)}: `)).trim()
        if (!answer) return null
        const index = Number.parseInt(answer, 10) - 1
        // Re-ask. A fat-fingered "12" on a nine-option list used to cancel the
        // edit outright, which looks exactly like the menu ignoring you.
        if (!options[index]) {
          out(c.red(`  no such option — pick 1-${options.length}, or leave it blank to cancel`))
          out()
          continue
        }
        return options[index].value
      }
    }

    case 'secret': {
      // Hidden, and never an argv token — a key typed as `settings set … sk-…`
      // lands in the shell history file.
      const answer = await question(
        `  ${c.dim(card.value ? 'new value (hidden), blank keeps the current one' : 'value (hidden)')}: `,
        { hidden: true }
      )
      return answer.trim() ? answer.trim() : null
    }

    case 'number': {
      const hint = card.hint ? ` ${card.hint}` : ''
      const answer = (await question(`  ${c.dim(`number${hint}, blank cancels`)}: `)).trim()
      if (!answer) return null
      if (!Number.isFinite(Number(answer))) {
        out(c.red('  not a number'))
        return null
      }
      return answer
    }

    default: {
      const hint = card.hint ? ` ${card.hint}` : ''
      const answer = (await question(`  ${c.dim(`value${hint}, blank cancels`)}: `)).trim()
      return answer || null
    }
  }
}

/**
 * `wolffish settings list` — every setting, page by page and card by card,
 * with credentials already masked by the daemon before they reach this
 * process. The read surface: it pipes, it takes a filter, it never prompts.
 */
export async function listAllSettings(client, { json = false, long = false, group } = {}) {
  stale()
  const { groups, cards } = await load(client)
  const target = group ? resolveTarget({ groups, cards }, [group]) : { kind: 'pages' }

  const wanted =
    target.kind === 'page'
      ? cards.filter((card) => card.group === target.id)
      : target.kind === 'card'
        ? cards.filter((card) => card.section === target.id)
        : target.kind === 'search'
          ? cards.filter((card) => `${card.id} ${card.label}`.toLowerCase().includes(target.needle))
          : cards

  if (json) {
    out(JSON.stringify(wanted, null, 2))
    return 0
  }
  if (wanted.length === 0) {
    out(c.yellow(`no settings match "${group}"`))
    out(c.gray('  pages: ' + groups.map((page) => page.id).join(', ')))
    return 1
  }

  for (const page of groups) {
    const onPage = wanted.filter((card) => card.group === page.id)
    if (onPage.length === 0) continue
    heading(page.label)
    for (const section of page.sections ?? []) {
      const rows = onPage.filter((card) => card.section === section.id)
      if (rows.length === 0) continue
      out()
      out('  ' + c.gray(section.label.toUpperCase()))
      for (const card of rows) {
        const value =
          card.kind === 'boolean'
            ? card.value === true
              ? c.green(card.display)
              : c.gray(card.display)
            : c.cyan(card.display)
        const mismatch = card.value === true && card.actualOk === false
        const gap = Math.max(1, 44 - visibleLength(card.label))
        out(
          `  ${mismatch ? icon.warn() : ' '} ${card.label}${' '.repeat(gap)}${value}` +
            (card.actual ? c.gray(` · ${card.actual}`) : '')
        )
        out(`    ${c.gray(card.id)}`)
        if (long && card.description) out(wrapText(c.gray(card.description), 4))
        if (long && card.options?.length) {
          const shown = card.options.slice(0, 8).map((option) => option.value)
          out(
            `    ${c.gray('options: ' + shown.join(', ') + (card.options.length > 8 ? ', …' : ''))}`
          )
        }
      }
    }
  }

  out()
  out(
    c.gray(
      `  ${wanted.length} settings` +
        (long ? '' : ' · --long for descriptions') +
        ' · wolffish settings to configure interactively'
    )
  )
  return 0
}

/** `wolffish settings pages` — the map, one line per card. */
export async function listPages(client) {
  stale()
  const { groups, cards } = await load(client)
  heading('Settings')
  table(
    ['page', 'card', 'entries'],
    groups.flatMap((page) => {
      const sections = (page.sections ?? []).filter((section) => cardSize(cards, section.id) > 0)
      if (sections.length === 0) return []
      return sections.map((section, index) => [
        index === 0 ? c.cyan(page.id) : '',
        section.id.split('.').slice(1).join('.') || section.id,
        String(cardSize(cards, section.id))
      ])
    })
  )
  out()
  out(c.gray('  wolffish settings <page>          the cards on a page'))
  out(c.gray('  wolffish settings <page> <card>   straight into one card'))
  return 0
}
