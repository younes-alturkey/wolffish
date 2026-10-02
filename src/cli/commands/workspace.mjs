/**
 * Everything the app's non-chat screens do: conversations, projects,
 * automations, procedures, and the three hand-written customizations that
 * shape the agent (Soul, User, Agents).
 *
 * All of it rides the app's own IPC handlers — the same calls the pages make —
 * so there is no second implementation of a create, an update or a delete.
 * The CLI's contribution is the verbs and the editor handoff.
 */
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  bytes,
  c,
  cmd,
  confirm,
  err,
  g,
  heading,
  icon,
  interactive,
  keyValue,
  multilineHint,
  out,
  pad,
  question,
  questionMultiline,
  captureOutput,
  relativeTime,
  shortPath,
  table,
  visibleLength,
  wrapText
} from '../lib/ui.mjs'
import { editText } from '../lib/editor.mjs'
import { copyToClipboard } from '../lib/clipboard.mjs'
import { basename, renderStoredMessage } from '../lib/render.mjs'
import { renderMarkdown } from '../lib/markdown.mjs'
import { runTurn } from '../lib/turn.mjs'
import { filterConversationsByTitle, matchesKeywords } from '../lib/search.mjs'

// ─── Conversations ──────────────────────────────────────────────────────────

/** Same page size as the REPL's /list, so the two never disagree. */
const PAGE_SIZE = 25

/** Every `conversations` verb that acts on ONE conversation rather than listing. */
const CONVERSATION_SUBCOMMANDS = new Set([
  'show',
  'print',
  'read',
  'rm',
  'delete',
  'diagnose',
  'diagnostics',
  'resume',
  'open',
  'continue'
])

/**
 * `wolffish conversations` — the app's History screen.
 *
 * Bare lists; a subcommand acts on one. A bare id is treated as `show <id>`,
 * because that is what someone who just read the listing and typed the id
 * meant, and refusing it teaches nothing.
 */
export async function conversations(client, args, flags = {}, resume = null) {
  const [sub, ...rest] = args

  // `--search` takes ONE argv word, so an unquoted `-s release notes` leaves
  // "notes" behind as a positional — which then reads as a conversation id,
  // matches a title, and opens a transcript nobody asked for. With a search in
  // hand, loose words are more of the search; only a real subcommand is not.
  if (flags.search != null && !CONVERSATION_SUBCOMMANDS.has(sub)) {
    const loose = !sub ? [] : sub === 'list' || sub === 'ls' ? rest : [sub, ...rest]
    return listConversations(client, {
      json: flags.json,
      limit: flags.limit,
      all: flags.all,
      search: [flags.search, ...loose].join(' '),
      resume
    })
  }

  if (!sub || sub === 'list' || sub === 'ls') {
    return listConversations(client, {
      json: flags.json,
      limit: flags.limit,
      all: flags.all,
      search: flags.search,
      resume
    })
  }
  if (sub === 'show' || sub === 'print' || sub === 'read') {
    if (!rest[0]) return usageLine('wolffish conversations show <id> [--tools] [--last <n>]')
    return showConversation(client, rest[0], {
      verbose: flags.verbose,
      json: flags.json,
      last: flags.last,
      // Piped or redirected, paging would stall on a prompt nobody can answer.
      paged: !flags.json
    })
  }
  if (sub === 'rm' || sub === 'delete') {
    if (!rest[0]) return usageLine('wolffish conversations rm <id>')
    return deleteConversation(client, rest[0])
  }
  if (sub === 'diagnose' || sub === 'diagnostics') {
    if (!rest[0]) return usageLine('wolffish conversations diagnose <id>')
    return exportDiagnostics(client, rest[0])
  }
  if (sub === 'resume' || sub === 'open' || sub === 'continue') {
    if (!resume) return usageLine('wolffish resume <id>')
    const id = rest[0] ? await resolveConversationId(client, rest[0]) : null
    if (rest[0] && !id) {
      out(c.red(`no conversation matching "${rest[0]}"`))
      return 1
    }
    return resume(id)
  }

  const asId = await resolveConversationId(client, sub)
  if (asId) return showConversation(client, asId, { verbose: flags.verbose, json: flags.json })

  out(c.red(`unknown: ${cmd(`conversations ${sub}`)}`))
  out(c.gray('  list · show · resume · diagnose · rm'))
  return 2
}

function usageLine(line) {
  out(c.red(`usage: ${line}`))
  return 2
}

/**
 * A conversation id short enough to LABEL something, when there is no title.
 *
 * The tail, not the head: these ids lead with a timestamp, so the front is the
 * part every conversation shares and the back is the part that tells them
 * apart. Only ever used where the text is decoration — anything the reader is
 * expected to type gets the whole id, because a label that is nearly unique is
 * a command that nearly works.
 */
export function shortConversationId(id) {
  const text = String(id ?? '')
  return text.length <= 12 ? text : `…${text.slice(-10)}`
}

/**
 * `wolffish conversations` — navigable, like every other list here.
 *
 * It was the one screen that printed a table and a footer naming commands to
 * retype. That is bearable for five rows and absurd for a thousand: the id
 * column is truncated to eight characters precisely so you can copy it, and
 * copying an id out of a table to paste into the next command is the work a
 * menu exists to remove. Numbers open, a typed word searches titles, `m` loads
 * the next page.
 *
 * Piped or scripted it prints the table and returns, exactly as before, so
 * `wolffish conversations --json` and `| grep` are untouched.
 */
export async function listConversations(
  client,
  { json, limit, all = false, search = '', resume = null } = {}
) {
  // `--search` narrows by TITLE, on the same keywords the app's conversations
  // search takes, and applies to all three shapes this command has: the JSON,
  // the piped table, and the menu — where it arrives as the filter already
  // typed, so `wolffish conversations --search invoice` opens on the answer.
  const query = String(search ?? '').trim()
  const conversations = filterConversationsByTitle(await client.invoke('conversation:list'), query)
  const size = Number.isFinite(limit) && limit > 0 ? limit : PAGE_SIZE

  if (json) {
    out(JSON.stringify(all ? conversations : conversations.slice(0, size), null, 2))
    return 0
  }

  if (!interactive()) {
    const rows = all ? conversations : conversations.slice(0, size)
    heading(
      `Conversations ${c.gray(query ? `"${query}" (${conversations.length})` : `(${conversations.length})`)}`
    )
    if (rows.length === 0) {
      out(c.gray(query ? '  nothing matches' : '  none yet'))
      return 0
    }
    table(
      ['id', 'title', 'channel', 'updated'],
      rows.map((conv) => [
        // The WHOLE id. It used to be `slice(0, 8)`, which for a
        // `2026-08-09_00-02-58_325-c4a32a` id is the year and month — a
        // thousand conversations share three of those between them, so the one
        // column whose entire job is to identify a row identified nothing, and
        // the `resume <id>` the footer suggested could not resolve it.
        c.gray(conv.id),
        String(conv.title ?? 'Untitled').slice(0, 44),
        conv.channel ?? 'electron',
        relativeTime(conv.updatedAt)
      ])
    )
    out()
    if (!all && conversations.length > rows.length) {
      out(
        c.gray(
          `  showing ${rows.length} of ${conversations.length} · --all, or --limit <n>, for more`
        )
      )
    }
    out(c.gray(`  ${cmd('conversations show <id>')}   print a transcript`))
    out(c.gray(`  ${cmd('resume <id>')}   continue it`))
    return 0
  }

  let shown = all ? conversations.length : size
  let filter = query
  for (;;) {
    const list = await client.invoke('conversation:list')
    // Keywords in any order, so `telegram invoice` finds the one conversation
    // that is both. The haystack keeps the channel and the id this prompt has
    // always reached as well as the title — the app searches titles alone, but
    // narrowing a menu that already finds more would take something away.
    const matched = filter
      ? list.filter((conv) =>
          matchesKeywords(`${conv.title ?? ''} ${conv.channel ?? ''} ${conv.id}`, filter)
        )
      : list
    const rows = matched.slice(0, shown)

    heading(
      `Conversations ${c.gray(filter ? `"${filter}" (${matched.length})` : `(${matched.length})`)}`
    )
    if (rows.length === 0) {
      out(c.gray(filter ? '  nothing matches' : '  none yet'))
      out()
      if (!filter) return 0
      filter = ''
      continue
    }
    rows.forEach((conv, index) => {
      const badge = conv.channel && conv.channel !== 'electron' ? c.gray(` ${conv.channel}`) : ''
      out(
        `  ${c.cyan(String(index + 1).padStart(3))}. ` +
          pad(String(conv.title ?? 'Untitled').slice(0, 52), 54) +
          c.gray(relativeTime(conv.updatedAt)) +
          badge
      )
    })
    out()
    const more = matched.length - rows.length
    out(
      c.gray(
        `  ${rows.length} of ${matched.length}` +
          (more > 0 ? ` · m for ${Math.min(more, size)} more` : '') +
          ' · type to search · blank exits'
      )
    )

    const answer = (await question(`  ${c.dim('number, or type to search')}: `)).trim()
    if (!answer) return 0
    if (isQuit(answer)) return 0
    if (answer === 'm' || answer === 'more') {
      if (more <= 0) out(c.gray(`  that's all ${matched.length}`))
      else shown += size
      continue
    }
    if (/^\d+$/.test(answer)) {
      const chosen = rows[Number.parseInt(answer, 10) - 1]
      if (!chosen) {
        outOfRange(rows.length)
        continue
      }
      out()
      await openConversation(client, chosen, { resume })
      out()
      continue
    }
    filter = answer
    shown = size
  }
}

/** One conversation, and everything the terminal can do with it. */
async function openConversation(client, conv, { resume = null } = {}) {
  return browseOne({
    reload: async () =>
      (await client.invoke('conversation:list')).find((entry) => entry.id === conv.id) ?? null,
    show: (current) => {
      heading(current.title ?? 'Untitled')
      keyValue([
        ['id', c.gray(current.id)],
        ['channel', current.channel ?? 'electron'],
        ['updated', relativeTime(current.updatedAt)]
      ])
    },
    actions: [
      {
        label: 'Read the transcript',
        run: (current) => showConversation(client, current.id, { verbose: false })
      },
      {
        label: 'Read it with every tool call',
        run: (current) => showConversation(client, current.id, { verbose: true })
      },
      // Only where there is a session to continue INTO. From a one-shot shell
      // command there is nothing to hand the conversation to, and an entry that
      // silently does nothing is the thing this pass exists to remove.
      ...(resume
        ? [{ label: 'Continue it here', run: (current) => resume(current.id) ?? 'gone' }]
        : [{ label: `Continue it — ${cmd(`resume ${conv.id}`)}`, run: () => 0 }]),
      {
        label: 'Save the transcript to a file',
        run: (current) => exportConversation(client, current)
      },
      {
        label: 'Export a diagnostic bundle',
        run: (current) => exportDiagnostics(client, current.id)
      },
      {
        label: c.red('Delete'),
        run: async (current) => {
          if (!(await confirm(`  delete ${c.bold(current.title ?? 'Untitled')}?`, false))) return
          const result = await client
            .invoke('conversation:delete', current.id)
            .catch(() => ({ ok: false }))
          if (result?.ok === false) {
            out(`${icon.fail()} ${c.red('it is still running — stop it first')}`)
            return
          }
          out(`${icon.ok()} deleted ${c.gray(current.id)}`)
          return 'gone'
        }
      }
    ]
  })
}

/**
 * The diagnostic bundle — everything relevant to one conversation, zipped.
 *
 * This is the button on the desktop's conversation overlay and on the phone,
 * and it had no terminal route at all. It matters most exactly where there is
 * no window: something went wrong on a server and the only way to hand over
 * what happened is a file. The collector takes tens of seconds and streams
 * `diagnostics:progress`, so the wait is narrated rather than silent.
 *
 * The archive is written inside the workspace either way, so `wolffish view`
 * and `scp` both reach it; the absolute path is printed for the second.
 */
export async function exportDiagnostics(client, conversationId) {
  const id = await resolveConversationId(client, conversationId)
  if (!id) {
    err(c.red(`no conversation matching "${conversationId}"`))
    return 1
  }
  heading('Diagnostic bundle')
  out(c.gray(`  ${id}`))
  out()

  let lastStep = null
  const off = client.onEvent((channel, payload) => {
    if (channel !== 'diagnostics:progress') return
    const step = payload?.label ?? payload?.step
    if (!step || step === lastStep) return
    lastStep = step
    out(`  ${icon.dot()} ${c.gray(String(step))}`)
  })

  const result = await client
    .invoke('diagnostics:export', { conversationId: id })
    .catch((error) => ({ ok: false, error: error?.message }))
  off()

  if (!result?.ok) {
    err(`${icon.fail()} ${c.red(result?.error ?? 'the export failed')}`)
    return 1
  }
  out()
  keyValue([
    ['file', c.bold(String(result.fileName))],
    ['path', c.gray(String(result.zipPath))],
    ['size', bytes(result.sizeBytes)],
    ['files', String(result.fileCount)],
    ['took', `${Math.round((result.durationMs ?? 0) / 1000)}s`],
    ...(result.modelOpinion ? [['notes', c.gray('includes a model read of the failure')]] : [])
  ])
  out()
  out(c.gray(`  copy it off this machine with:`))
  out(`    scp ${result.zipPath} you@laptop:~/`)
  return 0
}

/** The transcript as plain markdown, somewhere outside the workspace. */
async function exportConversation(client, conv) {
  const full = await client.invoke('conversation:load', conv.id).catch(() => null)
  if (!full) {
    out(c.red('  could not read it'))
    return 1
  }
  const answer = (
    await question(`  ${c.dim('destination path or folder, blank cancels')}: `)
  ).trim()
  if (!answer) return 0
  const resolved = answer.startsWith('~') ? path.join(os.homedir(), answer.slice(1)) : answer
  const stat = await fs.stat(resolved).catch(() => null)
  const name = `${
    String(full.title ?? 'conversation')
      .replace(/[^\w -]+/g, '')
      .trim() || 'conversation'
  }.md`
  const target = stat?.isDirectory() ? path.join(resolved, name) : resolved

  const body = [`# ${full.title ?? 'Untitled'}`, '', `_${full.id}_`, '']
  for (const message of full.messages ?? []) {
    const who = message.role === 'user' ? 'You' : 'Wolffish'
    const text = String(message.content ?? '')
      .replace(/\[wolffish-output:[^\]]*\]/g, '')
      .trim()
    if (!text) continue
    body.push(`## ${who}`, '', text, '')
  }
  await fs.writeFile(target, body.join('\n'), 'utf8')
  out(`${icon.ok()} ${shortPath(target)}`)
  return 0
}

/**
 * Any fragment that names exactly one conversation.
 *
 * Prefix matching alone was wrong for this id shape. A conversation id is
 * `2026-08-09_00-02-58_325-c4a32a` — a timestamp with a random tail — so every
 * id in a month shares its first eight characters and most of its first
 * nineteen. The DISTINCTIVE end is the tail, which a prefix match can never
 * reach: `resume c4a32a` found nothing while `resume 2026-08-` found 118.
 *
 * So the strategies run narrowest-first and the first one that names exactly
 * one wins. Ambiguity is only reported when NO strategy is decisive — a prefix
 * that hits 118 rows is not an error if the same text is a unique suffix.
 * Titles are the last resort, because "show me the security audit one" is what
 * someone reading the listing actually has to hand.
 */
export async function resolveConversationId(client, partial) {
  if (!partial) return null
  const needle = String(partial)
  const lower = needle.toLowerCase()
  const conversations = await client.invoke('conversation:list')

  const exact = conversations.find((conv) => conv.id === needle)
  if (exact) return exact.id

  const strategies = [
    (conv) => conv.id.endsWith(needle),
    (conv) => conv.id.startsWith(needle),
    (conv) => conv.id.includes(needle),
    (conv) => String(conv.title ?? '').toLowerCase() === lower,
    (conv) =>
      String(conv.title ?? '')
        .toLowerCase()
        .includes(lower)
  ]

  let narrowest = null
  for (const test of strategies) {
    const hits = conversations.filter(test)
    if (hits.length === 1) return hits[0].id
    if (hits.length > 1 && (narrowest === null || hits.length < narrowest.length)) narrowest = hits
  }

  if (narrowest) {
    out(c.yellow(`  "${needle}" matches ${narrowest.length} conversations:`))
    for (const conv of narrowest.slice(0, 5)) {
      out(c.gray(`    ${conv.id}  ${String(conv.title ?? 'Untitled').slice(0, 44)}`))
    }
    if (narrowest.length > 5) out(c.gray(`    …and ${narrowest.length - 5} more`))
    // Naming the id specifically would be wrong half the time — this set may
    // have come from a title match. Copying a whole id off the lines above
    // always works, whichever way the fragment matched.
    out(c.gray('  copy one of the ids above'))
  }
  return null
}

/**
 * A whole conversation, read back.
 *
 * Three things it has to get right, and did not.
 *
 * WITH OR WITHOUT TOOL CALLS is a per-READING choice, not only a stored
 * preference. `verbose` still defaults to the `channels.cli.verbose` setting —
 * that is what makes a terminal behave the same however it was launched — but
 * wanting the tool calls for ONE transcript is the common case, and the only
 * way to get them used to be flipping a global setting, reading, and flipping
 * it back. `--tools` / `--clean` override for this command alone.
 *
 * IT HAS TO FIT. The renderers write as they go, so this dumped an unbounded
 * wall of text past the top of the window with no way to stop it. Paged now,
 * a screenful at a time, exactly like `wolffish view`.
 *
 * AND MOSTLY YOU WANT THE END. `--last <n>` takes the most recent n turns,
 * because on a conversation with two hundred messages the useful question is
 * almost always "what just happened".
 */
export async function showConversation(
  client,
  id,
  { verbose = false, json = false, paged = true, last = null, showTools = '--tools' } = {}
) {
  const resolved = await resolveConversationId(client, id)
  if (!resolved) {
    err(c.red(`no conversation matching "${id}"`))
    return 1
  }
  const conversation = await client.invoke('conversation:load', resolved)
  if (!conversation) {
    err(c.red('conversation not found'))
    return 1
  }
  if (json) {
    out(JSON.stringify(conversation, null, 2))
    return 0
  }

  const all = conversation.messages ?? []
  // A "turn" is a user message and everything that answered it, so the tail is
  // counted in user messages rather than in raw records — `--last 3` meaning
  // "one and a half exchanges" would be a number nobody can use.
  let messages = all
  if (Number.isFinite(last) && last > 0) {
    let seen = 0
    let from = 0
    for (let i = all.length - 1; i >= 0; i--) {
      if (all[i].role === 'user') {
        seen++
        if (seen === last) {
          from = i
          break
        }
      }
    }
    messages = all.slice(from)
  }

  heading(conversation.title ?? 'Untitled')
  const shown =
    messages.length === all.length
      ? `${all.length} messages`
      : `${messages.length} of ${all.length} messages`
  out(
    c.gray(`  ${conversation.id} · ${shown}${verbose ? '' : ` · ${showTools} for every tool call`}`)
  )

  const lines = captureOutput(() => {
    for (const message of messages) {
      renderStoredMessage(message, { verbose, showTools })
    }
  })

  if (!paged) {
    for (const line of lines) out(line)
    return 0
  }
  await page(lines)
  return 0
}

/**
 * A project by id, id-prefix or title — the same forgiving match every other
 * `<thing> <id>` argument in this CLI takes.
 */
export async function resolveProjectId(client, needle) {
  const found = await findIn(client, 'projects:list', needle)
  return found?.id ?? null
}

/**
 * Delete one conversation, and say what actually happened.
 *
 * `conversation:delete` returns `{ ok: false }` when it REFUSES — a turn is
 * still running in that conversation, and removing it would race the
 * end-of-turn persist. The result was discarded, so a refused delete printed a
 * tick and exit 0; the conversation was still there afterwards and nothing had
 * said so. Measured while cleaning up after this session's own tests.
 */
export async function deleteConversation(client, id) {
  const resolved = await resolveConversationId(client, id)
  if (!resolved) {
    err(c.red(`no conversation matching "${id}"`))
    return 1
  }
  const result = await client
    .invoke('conversation:delete', resolved)
    .catch((error) => ({ ok: false, error: error?.message }))
  if (result?.ok === false) {
    err(`${icon.fail()} ${c.red(result.error ?? 'that conversation is still running')}`)
    err(c.gray(`  stop it first: ${cmd(`cancel ${resolved}`)}`))
    return 1
  }
  out(`${icon.ok()} deleted ${c.gray(resolved)}`)
  return 0
}

// ─── Files and working folders, for all three owners ────────────────────────

/**
 * A project, a procedure and an automation each carry attached files and
 * working folders, and they carry them the same way — so the terminal says it
 * the same way for all three. One implementation, three callers.
 *
 * Attaching COPIES into the workspace (the owner can never dangle on a moved
 * original); a folder is a REFERENCE, checked to exist now rather than failing
 * inside a run later. Both rules live in main — `cli:ownerFiles` and
 * `cli:ownerFolders` — because both are the desktop pickers' second half, and
 * a terminal that reimplemented them would be a second way to attach.
 */
async function ownedFiles(client, owner, id, args, label) {
  const [action, ...paths] = args
  if (!action || action === 'list') return showAttachments(client, owner, id, label)
  if (action !== 'add' && action !== 'rm' && action !== 'remove') {
    out(c.red(`unknown: files ${action}`))
    out(c.gray('  files · files add <path…> · files rm <name…>'))
    return 2
  }
  if (paths.length === 0) {
    out(c.red(`usage: files ${action} <${action === 'add' ? 'path' : 'name'}…>`))
    return 2
  }
  const result = await client.invoke('cli:ownerFiles', {
    owner,
    id,
    ...(action === 'add' ? { attach: paths } : { detach: paths })
  })
  return reportAttachments(result, label, action === 'add' ? 'attached' : 'removed')
}

async function ownedFolders(client, owner, id, args, label) {
  const [action, ...paths] = args
  if (!action || action === 'list') return showAttachments(client, owner, id, label)
  if (action !== 'add' && action !== 'rm' && action !== 'remove') {
    out(c.red(`unknown: dirs ${action}`))
    out(c.gray('  dirs · dirs add <path…> · dirs rm <path…>'))
    return 2
  }
  if (paths.length === 0) {
    out(c.red(`usage: dirs ${action} <path…>`))
    return 2
  }
  const result = await client.invoke('cli:ownerFolders', {
    owner,
    id,
    ...(action === 'add' ? { add: paths } : { remove: paths })
  })
  return reportAttachments(result, label, action === 'add' ? 'added' : 'removed')
}

/** Read-only: what this thing carries right now. */
async function showAttachments(client, owner, id, label) {
  const result = await client.invoke('cli:ownerFiles', { owner, id })
  return reportAttachments(result, label, null)
}

function reportAttachments(result, label, verb) {
  if (!result?.ok) {
    out(`${icon.fail()} ${c.red(result?.error ?? 'failed')}`)
    return 1
  }
  heading(label)
  if (result.files.length === 0) out(c.gray('  no files'))
  else {
    table(
      ['file', 'stored at'],
      result.files.map((file) => [file.name, c.gray(shortPath(file.path))])
    )
  }
  out()
  if (result.directories.length === 0) out(c.gray('  no working folders'))
  else keyValue(result.directories.map((dir) => ['folder', c.gray(shortPath(dir))]))

  // Say what did NOT happen. A silent skip reads as success and is only
  // noticed when a run cannot find the file someone believes they attached.
  for (const name of result.skipped ?? []) {
    out(`  ${icon.warn()} ${c.yellow(`already attached: ${name}`)}`)
  }
  for (const name of result.missing ?? []) {
    out(`  ${icon.fail()} ${c.red(`not found: ${shortPath(name)}`)}`)
  }
  if (verb) out(`${icon.ok()} ${verb}`)
  return (result.missing ?? []).length > 0 ? 1 : 0
}

// ─── Projects ───────────────────────────────────────────────────────────────

/** Find by id, id prefix, or title — the three things a listing shows. */
async function findIn(client, channel, needle) {
  if (!needle) return null
  const list = await client.invoke(channel)
  const lower = String(needle).toLowerCase()
  return (
    list.find((entry) => entry.id === needle) ??
    list.find((entry) => String(entry.id).startsWith(needle)) ??
    list.find((entry) => String(entry.title ?? '').toLowerCase() === lower) ??
    list.find((entry) =>
      String(entry.title ?? '')
        .toLowerCase()
        .includes(lower)
    ) ??
    null
  )
}

// ─── Browsing a list of things ──────────────────────────────────────────────

/**
 * The listings are NAVIGABLE, not just printed.
 *
 * A printed table whose footer reads "show <id> · edit <id>" is a menu you
 * cannot use: at a chat prompt those words are a message to the agent, and
 * pressing enter does nothing, so the surface reads as a place you are inside
 * with no way back out. Either the footer is actionable or the list is — this
 * makes it the list, in the same idiom `wolffish settings` already uses:
 * numbers open, blank goes up, and up from the top leaves.
 *
 * Only when someone is there to answer. Piped or scripted, the table prints
 * and the command returns, exactly as before.
 */
/**
 * `--json` on every listing, not just conversations.
 *
 * The usage text promises "machine-readable output where it applies", and it
 * applied to one command. A script on a server that wanted the projects, the
 * procedures or the automations had to parse a padded table — which is exactly
 * the thing --json exists to make unnecessary.
 */
async function browseList({ title, load, columns, row, empty, open, json = false }) {
  if (json) {
    out(JSON.stringify(await load(), null, 2))
    return 0
  }
  for (;;) {
    const list = await load()
    heading(`${title} ${c.gray(`(${list.length})`)}`)
    if (list.length === 0) {
      out(c.gray(`  ${empty}`))
      return 0
    }

    // The number column IS the affordance — the ids stay visible because they
    // are what scripts and the shell form take.
    const widths = columns.map((header, i) =>
      Math.max(header.length, ...list.map((entry) => visibleLength(String(row(entry)[i] ?? ''))))
    )
    out('     ' + columns.map((header, i) => c.gray(pad(header, widths[i]))).join('  '))
    list.forEach((entry, index) => {
      const cells = row(entry).map((cell, i) => pad(String(cell ?? ''), widths[i]))
      out(`  ${c.cyan(String(index + 1).padStart(2))}. ${cells.join('  ')}`)
    })
    out()

    if (!interactive()) {
      out(c.gray(`  ${cmd(`${title.toLowerCase()} show <id>`)}   and edit · files · dirs · rm`))
      return 0
    }
    out(c.gray(`  ${list.length} ${list.length === 1 ? 'item' : 'items'} · blank goes back`))
    const answer = (await question(`  ${c.dim('number to open')}: `)).trim()
    if (!answer || isQuit(answer)) return 0
    const chosen = list[Number.parseInt(answer, 10) - 1]
    if (!chosen) {
      outOfRange(list.length)
      continue
    }
    out()
    await open(chosen)
    out()
  }
}

/**
 * One thing, and everything you can do to it. Blank returns to the list, so
 * the two levels behave like the settings browser's card and page.
 *
 * Each entry delegates to the verb that already implements it — the menu is a
 * way IN, never a second implementation of the work.
 */
async function browseOne({ show, actions, reload }) {
  // The full record is printed when you arrive and after anything CHANGES it —
  // not on every pass. A project's instructions or a procedure's prompt runs to
  // dozens of lines, and repainting all of it between every keystroke pushed
  // the menu you were aiming at off the top of the screen.
  let redraw = true
  for (;;) {
    const current = (await reload?.()) ?? null
    if (reload && !current) return 0
    if (redraw) show(current)
    else compactHeading(current)
    redraw = false
    out()
    const usable = actions.filter((action) => !action.when || action.when(current))
    usable.forEach((action, index) => {
      out(`  ${c.cyan(String(index + 1).padStart(2))}. ${action.label} ${c.gray(g.chevron)}`)
    })
    out()
    if (!interactive()) return 0
    const answer = (await question(`  ${c.dim('number, blank goes back')}: `)).trim()
    if (!answer || isQuit(answer)) return 0
    if (answer === '?' || answer === 'v') {
      redraw = true
      continue
    }
    const chosen = usable[Number.parseInt(answer, 10) - 1]
    if (!chosen) {
      outOfRange(usable.length)
      continue
    }
    out()
    // A flow that throws costs the flow, not the menu — the same guard the
    // settings browser puts around its actions.
    try {
      const done = await chosen.run(current)
      if (done === 'gone') return 0
      // Anything that ran may have changed what `show` would print.
      redraw = true
    } catch (error) {
      out(`${icon.fail()} ${c.red(error?.message ?? String(error))}`)
    }
    out()
  }
}

/** The one line that says which record the menu below belongs to. */
function compactHeading(entry) {
  const name = entry?.title ?? entry?.label ?? ''
  heading(`${entry?.icon ? entry.icon + ' ' : ''}${name}`)
  out(c.gray('  ? shows the details again'))
}

export async function projects(client, args, { json = false } = {}) {
  const [sub, ...rest] = args

  if (!sub || sub === 'list') {
    return browseList({
      title: 'Projects',
      empty: `none - ${cmd('projects new "<title>"')}`,
      load: () => client.invoke('projects:list'),
      columns: ['id', 'title', 'files', 'folders', 'edited'],
      row: (p) => [
        c.gray(String(p.id).slice(0, 8)),
        `${p.icon ? p.icon + ' ' : ''}${p.title}`,
        String(p.files?.length ?? 0),
        String(p.directories?.length ?? 0),
        relativeTime(p.editedAt ?? p.updatedAt ?? p.createdAt)
      ],
      open: (project) => openProject(client, project.id),
      json
    })
  }

  if (sub === 'new' || sub === 'create') {
    const title = rest.join(' ').trim()
    if (!title) {
      out(c.red(`usage: ${cmd('projects new "<title>"')}`))
      return 2
    }
    const created = await client.invoke('projects:create', { title })
    out(`${icon.ok()} ${created.title} ${c.gray(String(created.id).slice(0, 8))}`)
    return 0
  }

  // Everything below acts on ONE project, named by id, prefix or title.
  const [needle, ...tail] = sub === 'show' || KNOWN_PROJECT_VERBS.has(sub) ? rest : [sub, ...rest]
  const verb = sub === 'show' || KNOWN_PROJECT_VERBS.has(sub) ? sub : 'show'
  const project = await findIn(client, 'projects:list', needle)
  if (!project) {
    out(c.red(`no project matching "${needle ?? ''}"`))
    out(c.gray(`  ${cmd('projects')}   to list them`))
    return 1
  }

  switch (verb) {
    case 'show':
      return showProject(project)
    case 'edit': {
      const edited = await editInEditor(project.instructions ?? '', `project-${project.id}.md`)
      if (edited === null) return 1
      if (edited === project.instructions) {
        out(c.gray('  unchanged'))
        return 0
      }
      await client.invoke('projects:update', { id: project.id, instructions: edited })
      out(`${icon.ok()} updated ${project.title}`)
      return 0
    }
    case 'copy':
      return copyOwnedText('instructions', project.instructions)
    case 'paste': {
      const text = await pasteOwnedText('instructions', project.instructions)
      if (text === null) return 0
      await client.invoke('projects:update', { id: project.id, instructions: text })
      out(`${icon.ok()} replaced the instructions of ${project.title}`)
      return 0
    }
    case 'rename': {
      const title = tail.join(' ').trim()
      if (!title) return usageLine('wolffish projects rename <id> "<title>"')
      await client.invoke('projects:update', { id: project.id, title })
      out(`${icon.ok()} ${title}`)
      return 0
    }
    case 'icon': {
      const emoji = tail.join(' ').trim()
      if (!emoji) return usageLine('wolffish projects icon <id> <emoji>')
      await client.invoke('projects:update', { id: project.id, icon: emoji })
      out(`${icon.ok()} ${emoji} ${project.title}`)
      return 0
    }
    case 'files':
      return ownedFiles(client, 'project', project.id, tail, project.title)
    case 'dirs':
    case 'folders':
      return ownedFolders(client, 'project', project.id, tail, project.title)
    case 'rm':
    case 'delete':
      // Automations ask before deleting and these did not, which made the two
      // most similar screens in the app behave differently at the one moment
      // where being wrong is not recoverable. A script that wants the old
      // behaviour pipes nothing: confirm() answers with its default off a
      // non-TTY, and the default here is no.
      if (!(await confirm(`  delete ${c.bold(project.title)}?`, false))) return 0
      await client.invoke('projects:delete', project.id)
      out(`${icon.ok()} deleted ${project.title}`)
      return 0
    default:
      out(c.red(`unknown: ${cmd(`projects ${verb}`)}`))
      out(c.gray('  list · new · show · edit · copy · paste · rename · icon · files · dirs · rm'))
      return 2
  }
}

/**
 * Attaching a FILE and adding a WORKING FOLDER are two different intentions, so
 * they are two menu entries.
 *
 * They were one — a single prompt that stat'd each path and routed it — on the
 * theory that "what should this work with?" is one question and the file/folder
 * split is a property of the path rather than a decision to put on the typist.
 * That reads well and browses badly. A menu is a list of things you can DO, and
 * "attach a file" and "work in a folder" are not the same act: one copies a
 * document in so the model can read it, the other points the model at a
 * directory it may write to. Merging them hid that difference behind a prompt
 * you only saw after committing, and made the menu unable to answer the
 * question people actually arrive with — "how do I add a folder?"
 *
 * The shell verbs were always separate (`files add`, `dirs add`); this makes the
 * menu agree with them.
 */
const ATTACH = {
  file: {
    title: 'Attach files',
    hint: 'copied into the workspace, so moving the original cannot break it',
    wants: (stat) => !stat.isDirectory(),
    wrong: 'that is a folder',
    other: 'the "Add working folders" entry',
    apply: (client, owner, id, paths) => ownedFiles(client, owner, id, ['add', ...paths], 'Files')
  },
  folder: {
    title: 'Add working folders',
    hint: 'referenced, not copied — the agent works in place',
    wants: (stat) => stat.isDirectory(),
    wrong: 'that is a file',
    other: 'the "Attach files" entry',
    apply: (client, owner, id, paths) =>
      ownedFolders(client, owner, id, ['add', ...paths], 'Folders')
  }
}

/**
 * One kind of attachment, several paths at a time.
 *
 * A path of the WRONG kind is reported and skipped rather than quietly routed
 * to the other list — quiet routing is exactly what splitting these apart was
 * meant to end, and a menu that does something you did not pick is worse than
 * one that tells you where to go.
 *
 * The CLI and the daemon are always the same machine (the socket is local by
 * construction), so the stat here is the same stat main would do.
 */
async function attachOf(kind, client, owner, id) {
  const spec = ATTACH[kind]
  out(`  ${c.bold(spec.title)} ${c.gray(`— ${spec.hint}`)}`)
  const answer = (
    await question(
      `  ${c.dim(`${kind === 'file' ? 'file' : 'folder'} paths, space-separated ("quote" ones with spaces), blank cancels`)}: `
    )
  ).trim()
  if (!answer || isQuit(answer)) return
  const paths = splitPaths(answer)
  if (paths.length === 0) return

  const wanted = []
  const mismatched = []
  const missing = []
  for (const entry of paths) {
    const resolved = entry.startsWith('~') ? path.join(os.homedir(), entry.slice(1)) : entry
    const stat = await fs.stat(resolved).catch(() => null)
    if (!stat) missing.push(entry)
    else if (spec.wants(stat)) wanted.push(resolved)
    else mismatched.push(entry)
  }
  for (const entry of missing) out(`  ${icon.fail()} ${c.red(`not found: ${entry}`)}`)
  for (const entry of mismatched) {
    out(`  ${icon.warn()} ${c.yellow(`${spec.wrong}: ${shortPath(entry)}`)}`)
    out(c.gray(`     use ${spec.other}`))
  }
  if (wanted.length > 0) return spec.apply(client, owner, id, wanted)
  if (missing.length === 0 && mismatched.length === 0) out(c.gray('  nothing to attach'))
}

export const attachFilesInteractive = (client, owner, id) => attachOf('file', client, owner, id)
export const attachFoldersInteractive = (client, owner, id) => attachOf('folder', client, owner, id)

/** Split a typed line into paths, respecting quotes — paths have spaces in them. */
function splitPaths(line) {
  const found = []
  const pattern = /"([^"]+)"|'([^']+)'|(\S+)/g
  let match
  while ((match = pattern.exec(line)) !== null) {
    found.push(match[1] ?? match[2] ?? match[3])
  }
  return found
}

/**
 * Removing one, kept split the same way — a menu whose adds are separate and
 * whose removes are fused is a menu that has to be read twice.
 */
async function detachOf(kind, client, owner, id) {
  const current = await client.invoke('cli:ownerFiles', { owner, id })
  if (!current?.ok) {
    out(`${icon.fail()} ${c.red(current?.error ?? 'failed')}`)
    return
  }
  const entries =
    kind === 'file'
      ? current.files.map((file) => ({
          label: file.name,
          detail: shortPath(file.path),
          value: file.name
        }))
      : current.directories.map((dir) => ({ label: shortPath(dir), detail: '', value: dir }))

  if (entries.length === 0) {
    out(c.gray(kind === 'file' ? '  no files attached' : '  no working folders'))
    return
  }
  out(`  ${c.bold(kind === 'file' ? 'Remove a file' : 'Remove a working folder')}`)
  for (;;) {
    entries.forEach((entry, index) => {
      out(
        `   ${c.cyan(String(index + 1).padStart(2))}. ${entry.label}` +
          (entry.detail ? `  ${c.gray(entry.detail)}` : '')
      )
    })
    out()
    const answer = (await question(`  ${c.dim(`1-${entries.length}, blank cancels`)}: `)).trim()
    if (!answer || isQuit(answer)) return
    const chosen = entries[Number.parseInt(answer, 10) - 1]
    if (!chosen) {
      outOfRange(entries.length)
      out()
      continue
    }
    return kind === 'file'
      ? ownedFiles(client, owner, id, ['rm', chosen.value], 'Files')
      : ownedFolders(client, owner, id, ['rm', chosen.value], 'Folders')
  }
}

export const detachFileInteractive = (client, owner, id) => detachOf('file', client, owner, id)
export const detachFolderInteractive = (client, owner, id) => detachOf('folder', client, owner, id)

async function renameInteractive(client, channel, entry) {
  const answer = (await question(`  ${c.dim(`new title, blank keeps "${entry.title}"`)}: `)).trim()
  if (!answer) return
  await client.invoke(`${channel}:update`, { id: entry.id, title: answer })
  out(`${icon.ok()} ${answer}`)
}

async function iconInteractive(client, channel, entry) {
  const answer = (await question(`  ${c.dim('emoji, blank keeps the current one')}: `)).trim()
  if (!answer) return
  await client.invoke(`${channel}:update`, { id: entry.id, icon: answer })
  out(`${icon.ok()} ${answer} ${entry.title}`)
}

// ─── Copying and pasting the text a thing runs on ───────────────────────────

/**
 * `copy` and `paste`, the same pair on every surface that carries an editable
 * prompt: a project's instructions, a procedure's prompt, an automation's
 * body, the three customization documents.
 *
 * They exist because an editor round-trip is the WRONG shape for the two
 * commonest moves: getting the text OUT (into the app, a doc, another
 * machine), and dropping a rewritten version IN. Copy lands on the system
 * clipboard; paste opens a multi-line prompt that takes the entire replacement
 * in one go — pasted or typed, every line visible — and overwrites the whole
 * field, which is exactly what it says it does.
 */
async function copyOwnedText(label, text) {
  const value = String(text ?? '')
  if (!value.trim()) {
    out(c.gray(`  nothing to copy — the ${label} is empty`))
    return 0
  }
  const result = await copyToClipboard(value)
  if (!result.ok) {
    out(`${icon.fail()} ${c.red(result.error)}`)
    return 1
  }
  const lines = value.split('\n').length
  out(
    `${icon.ok()} copied the ${label} ` +
      c.gray(`— ${lines} ${lines === 1 ? 'line' : 'lines'}, via ${result.how}`)
  )
  if (result.note) out(c.gray(`  ${result.note}`))
  return 0
}

/**
 * Ask for the replacement text. Returns it, or null when the user backed out —
 * and null MUST mean "change nothing", never "save empty": wiping a prompt is
 * spelled Delete, not a cancelled paste.
 */
async function pasteOwnedText(label, current) {
  out(`  ${c.bold(`Paste new ${label}`)} ${c.gray('— replaces the whole thing')}`)
  const existing = String(current ?? '').trim()
  if (existing) {
    const lines = existing.split('\n').length
    out(
      c.gray(
        `  replacing the current ${lines} ${lines === 1 ? 'line' : 'lines'} — copy first if you want them back`
      )
    )
  }
  out(c.gray(`  ${multilineHint()}`))
  const answer = await questionMultiline(`  ${c.dim(`new ${label}`)}: `)
  if (answer == null || answer.trim().length === 0) {
    out(c.gray('  cancelled — nothing changed'))
    return null
  }
  return answer.replace(/\s+$/, '')
}

/** One project, with everything the Projects page offers for it. */
function openProject(client, id) {
  return browseOne({
    reload: async () => (await client.invoke('projects:list')).find((p) => p.id === id) ?? null,
    show: showProject,
    actions: [
      { label: 'Edit the instructions', run: () => projects(client, ['edit', id]) },
      { label: 'Copy the instructions', run: () => projects(client, ['copy', id]) },
      {
        label: 'Paste new instructions (replaces them)',
        run: () => projects(client, ['paste', id])
      },
      { label: 'Attach files', run: () => attachFilesInteractive(client, 'project', id) },
      { label: 'Add working folders', run: () => attachFoldersInteractive(client, 'project', id) },
      { label: 'Remove a file', run: () => detachFileInteractive(client, 'project', id) },
      {
        label: 'Remove a working folder',
        run: () => detachFolderInteractive(client, 'project', id)
      },
      { label: 'Rename', run: (p) => renameInteractive(client, 'projects', p) },
      { label: 'Change the icon', run: (p) => iconInteractive(client, 'projects', p) },
      {
        label: c.red('Delete'),
        run: async (p) => {
          if (!(await confirm(`  delete ${c.bold(p.title)}?`, false))) return
          await client.invoke('projects:delete', id)
          out(`${icon.ok()} deleted ${p.title}`)
          return 'gone'
        }
      }
    ]
  })
}

const KNOWN_PROJECT_VERBS = new Set([
  'edit',
  'copy',
  'paste',
  'rename',
  'icon',
  'files',
  'dirs',
  'folders',
  'rm',
  'delete'
])

function showProject(project) {
  heading(`${project.icon ? project.icon + ' ' : ''}${project.title}`)
  keyValue([
    ['id', c.gray(project.id)],
    ['files', String(project.files?.length ?? 0)],
    ['folders', String(project.directories?.length ?? 0)],
    ['edited', relativeTime(project.editedAt ?? project.updatedAt ?? project.createdAt)]
  ])
  if (project.instructions?.trim()) {
    out()
    out('  ' + c.gray('INSTRUCTIONS'))
    out(wrapText(project.instructions.trim(), 2))
  }
  if (project.files?.length) {
    out()
    out('  ' + c.gray('FILES'))
    table(
      ['file', 'stored at'],
      project.files.map((file) => [file.name, c.gray(shortPath(file.path))])
    )
  }
  if (project.directories?.length) {
    out()
    out('  ' + c.gray('WORKING FOLDERS'))
    for (const dir of project.directories) out(`    ${c.gray(shortPath(dir))}`)
  }
  return 0
}

// ─── Procedures ─────────────────────────────────────────────────────────────

/** One procedure, with everything the Procedures page offers for it. */
function openProcedure(client, id, { verbose = false, onRun = null } = {}) {
  return browseOne({
    reload: async () => (await client.invoke('procedures:list')).find((p) => p.id === id) ?? null,
    show: showProcedure,
    actions: [
      { label: 'Run it now', run: () => procedures(client, ['run', id], { verbose, onRun }) },
      { label: 'Edit the prompt', run: () => procedures(client, ['edit', id]) },
      { label: 'Copy the prompt', run: () => procedures(client, ['copy', id]) },
      { label: 'Paste a new prompt (replaces it)', run: () => procedures(client, ['paste', id]) },
      { label: 'Attach files', run: () => attachFilesInteractive(client, 'procedure', id) },
      {
        label: 'Add working folders',
        run: () => attachFoldersInteractive(client, 'procedure', id)
      },
      { label: 'Remove a file', run: () => detachFileInteractive(client, 'procedure', id) },
      {
        label: 'Remove a working folder',
        run: () => detachFolderInteractive(client, 'procedure', id)
      },
      {
        label: 'Switch mode',
        run: (p) => procedures(client, ['mode', id, p.mode === 'workflow' ? 'single' : 'workflow'])
      },
      {
        label: 'Set the thinking level',
        run: () => thinkingInteractive(client, 'procedures', id)
      },
      { label: 'Bind to a project', run: () => bindProjectInteractive(client, id) },
      { label: 'Rename', run: (p) => renameInteractive(client, 'procedures', p) },
      { label: 'Change the icon', run: (p) => iconInteractive(client, 'procedures', p) },
      {
        label: c.red('Delete'),
        run: async (p) => {
          if (!(await confirm(`  delete ${c.bold(p.title)}?`, false))) return
          await client.invoke('procedures:delete', id)
          out(`${icon.ok()} deleted ${p.title}`)
          return 'gone'
        }
      }
    ]
  })
}

/** Pick the project a procedure runs under, or clear the binding. */
async function bindProjectInteractive(client, id) {
  const list = await client.invoke('projects:list')
  if (list.length === 0) {
    out(c.gray('  no projects yet'))
    return
  }
  for (;;) {
    list.forEach((project, index) => {
      out(`   ${c.cyan(String(index + 1).padStart(2))}. ${project.icon ?? ''} ${project.title}`)
    })
    out(`   ${c.cyan(String(list.length + 1).padStart(2))}. ${c.gray('none')}`)
    out()
    const answer = (await question(`  ${c.dim(`1-${list.length + 1}, blank cancels`)}: `)).trim()
    if (!answer || isQuit(answer)) return
    const index = Number.parseInt(answer, 10) - 1
    if (index === list.length) return procedures(client, ['project', id, 'none'])
    if (!list[index]) {
      outOfRange(list.length + 1)
      out()
      continue
    }
    return procedures(client, ['project', id, list[index].id])
  }
}

const KNOWN_PROCEDURE_VERBS = new Set([
  'edit',
  'copy',
  'paste',
  'rename',
  'icon',
  'mode',
  'thinking',
  'project',
  'files',
  'dirs',
  'folders',
  'run',
  'play',
  'rm',
  'delete'
])

/**
 * `onRun` lets a caller adopt the conversation a run creates. The one-shot CLI
 * has nothing to adopt it into; a session does — without it, `/procedures run`
 * would stream a turn into a conversation the prompt above the input still
 * claims you are not in.
 */
export async function procedures(
  client,
  args,
  { verbose = false, onRun = null, json = false } = {}
) {
  const [sub, ...rest] = args

  if (!sub || sub === 'list') {
    return browseList({
      title: 'Procedures',
      empty: `none - ${cmd('procedures new "<title>" "<prompt>"')}`,
      load: () => client.invoke('procedures:list'),
      columns: ['id', 'title', 'mode', 'thinking', 'files', 'folders'],
      row: (p) => [
        c.gray(String(p.id).slice(0, 8)),
        `${p.icon ? p.icon + ' ' : ''}${p.title}`,
        p.mode ?? 'single',
        thinkingLabel(p.thinking),
        String(p.files?.length ?? 0),
        String(p.directories?.length ?? 0)
      ],
      open: (procedure) => openProcedure(client, procedure.id, { verbose, onRun }),
      json
    })
  }

  if (sub === 'new' || sub === 'create') {
    const [title, ...promptParts] = rest
    const prompt = promptParts.join(' ')
    if (!title || !prompt) {
      out(c.red(`usage: ${cmd('procedures new "<title>" "<prompt>"')}`))
      return 2
    }
    const created = await client.invoke('procedures:create', { title, prompt })
    out(`${icon.ok()} ${created.title} ${c.gray(String(created.id).slice(0, 8))}`)
    return 0
  }

  const named = KNOWN_PROCEDURE_VERBS.has(sub) || sub === 'show'
  const [needle, ...tail] = named ? rest : [sub, ...rest]
  const verb = named ? sub : 'show'
  const procedure = await findIn(client, 'procedures:list', needle)
  if (!procedure) {
    out(c.red(`no procedure matching "${needle ?? ''}"`))
    out(c.gray(`  ${cmd('procedures')}   to list them`))
    return 1
  }

  switch (verb) {
    case 'show':
      return showProcedure(procedure)

    /**
     * Run one, here, now — the procedure's own prompt sent as a turn with
     * everything it carries: its mode, its project binding, its working
     * folders and its attached files. That is what the Play button does; the
     * desktop just assembles it in the renderer, where a terminal cannot reach.
     */
    case 'run':
    case 'play': {
      out(c.gray(`  ${procedure.icon ? procedure.icon + ' ' : ''}${procedure.title}`))
      const result = await runTurn(
        client,
        {
          text: procedure.prompt,
          conversationId: null,
          projectId: procedure.projectId ?? null,
          modeOverride: procedure.mode,
          attachmentPaths: procedure.files?.length
            ? procedure.files.map((file) => file.path)
            : undefined,
          workingFolders: procedure.directories?.length ? procedure.directories : undefined
        },
        { verbose }
      )
      if (result.conversationId) await onRun?.(result.conversationId)
      return result.error ? 1 : 0
    }

    case 'edit': {
      const edited = await editInEditor(procedure.prompt ?? '', `procedure-${procedure.id}.md`)
      if (edited === null) return 1
      if (edited === procedure.prompt) {
        out(c.gray('  unchanged'))
        return 0
      }
      await client.invoke('procedures:update', { id: procedure.id, prompt: edited })
      out(`${icon.ok()} updated ${procedure.title}`)
      return 0
    }
    case 'copy':
      return copyOwnedText('prompt', procedure.prompt)
    case 'paste': {
      const text = await pasteOwnedText('prompt', procedure.prompt)
      if (text === null) return 0
      await client.invoke('procedures:update', { id: procedure.id, prompt: text })
      out(`${icon.ok()} replaced the prompt of ${procedure.title}`)
      return 0
    }
    case 'rename': {
      const title = tail.join(' ').trim()
      if (!title) return usageLine('wolffish procedures rename <id> "<title>"')
      await client.invoke('procedures:update', { id: procedure.id, title })
      out(`${icon.ok()} ${title}`)
      return 0
    }
    case 'icon': {
      const emoji = tail.join(' ').trim()
      if (!emoji) return usageLine('wolffish procedures icon <id> <emoji>')
      await client.invoke('procedures:update', { id: procedure.id, icon: emoji })
      out(`${icon.ok()} ${emoji} ${procedure.title}`)
      return 0
    }
    case 'mode': {
      const mode = (tail[0] ?? '').toLowerCase()
      if (mode !== 'single' && mode !== 'workflow') {
        return usageLine('wolffish procedures mode <id> single|workflow')
      }
      await client.invoke('procedures:update', { id: procedure.id, mode })
      out(`${icon.ok()} ${procedure.title} runs in ${mode}`)
      return 0
    }
    /**
     * The procedure's own reasoning effort — the card switch on the desktop
     * and the phone, from a terminal. Stamping it means this procedure's runs
     * use it whatever the chat's own thinking mode is set to; `default` hands
     * the decision back to the chat by clearing the stamp.
     */
    case 'thinking':
    case 'reasoning': {
      const wanted = (tail[0] ?? '').toLowerCase()
      if (wanted === 'default' || wanted === 'none' || wanted === 'clear') {
        await client.invoke('procedures:update', { id: procedure.id, thinking: null })
        out(`${icon.ok()} ${procedure.title} follows the chat's thinking mode again`)
        return 0
      }
      if (!THINKING_LEVELS.includes(wanted)) {
        return usageLine(`wolffish procedures thinking <id> ${THINKING_LEVELS.join('|')}|default`)
      }
      await client.invoke('procedures:update', { id: procedure.id, thinking: wanted })
      out(`${icon.ok()} ${procedure.title} runs at thinking: ${wanted}`)
      return 0
    }
    case 'project': {
      const wanted = tail.join(' ').trim()
      if (!wanted) return usageLine('wolffish procedures project <id> <project|none>')
      if (wanted === 'none' || wanted === 'off') {
        await client.invoke('procedures:update', { id: procedure.id, projectId: '' })
        out(`${icon.ok()} ${procedure.title} is no longer bound to a project`)
        return 0
      }
      const bound = await findIn(client, 'projects:list', wanted)
      if (!bound) {
        out(c.red(`no project matching "${wanted}"`))
        return 1
      }
      await client.invoke('procedures:update', { id: procedure.id, projectId: bound.id })
      out(`${icon.ok()} ${procedure.title} runs under ${bound.title}`)
      return 0
    }
    case 'files':
      return ownedFiles(client, 'procedure', procedure.id, tail, procedure.title)
    case 'dirs':
    case 'folders':
      return ownedFolders(client, 'procedure', procedure.id, tail, procedure.title)
    case 'rm':
    case 'delete':
      if (!(await confirm(`  delete ${c.bold(procedure.title)}?`, false))) return 0
      await client.invoke('procedures:delete', procedure.id)
      out(`${icon.ok()} deleted ${procedure.title}`)
      return 0
    default:
      out(c.red(`unknown: ${cmd(`procedures ${verb}`)}`))
      out(
        c.gray(
          '  list · new · show · run · edit · copy · paste · rename · icon · mode · thinking · project · files · dirs · rm'
        )
      )
      return 2
  }
}

/** The canonical reasoning scale, mirroring ReasoningMode on both ends. */
const THINKING_LEVELS = ['off', 'on', 'high', 'max']

/**
 * How a stored thinking stamp reads in a table or a card. `null` is not "off"
 * — it means the item has no stamp of its own and follows the chat's current
 * mode, which is the promise the desktop and phone cards make too.
 */
function thinkingLabel(thinking) {
  return thinking ?? c.gray('chat')
}

/**
 * The same fact as a sentence, for a `show` card — where a bare token beside
 * a label reads better than a word that needs decoding.
 */
function describeThinking(thinking) {
  return thinking ? thinking : c.gray("chat's current mode")
}

/** Pick a thinking level interactively, from whatever the item now carries. */
async function thinkingInteractive(client, feature, id) {
  for (;;) {
    const list = await client.invoke(`${feature}:list`)
    const row = list.find((entry) => entry.id === id)
    if (!row) {
      out(c.red('  that item is gone'))
      return
    }
    const current = row.thinking ?? null
    THINKING_LEVELS.forEach((level, index) => {
      const mark = level === current ? icon.ok() + ' ' : '  '
      out(`   ${mark}${c.cyan(String(index + 1).padStart(2))}. ${level}`)
    })
    out(
      `     ${current === null ? icon.ok() + ' ' : '  '}${c.cyan(
        String(THINKING_LEVELS.length + 1).padStart(2)
      )}. ${c.gray("follow the chat's mode")}`
    )
    out()
    const answer = (
      await question(`  ${c.dim(`1-${THINKING_LEVELS.length + 1}, blank cancels`)}: `)
    ).trim()
    if (!answer || isQuit(answer)) return
    const index = Number.parseInt(answer, 10) - 1
    if (index === THINKING_LEVELS.length) {
      await client.invoke(`${feature}:update`, { id, thinking: null })
      out(`${icon.ok()} now follows the chat's thinking mode`)
      return
    }
    if (!THINKING_LEVELS[index]) {
      outOfRange(THINKING_LEVELS.length + 1)
      out()
      continue
    }
    await client.invoke(`${feature}:update`, { id, thinking: THINKING_LEVELS[index] })
    out(`${icon.ok()} thinking: ${THINKING_LEVELS[index]}`)
    return
  }
}

function showProcedure(procedure) {
  heading(`${procedure.icon ? procedure.icon + ' ' : ''}${procedure.title}`)
  keyValue([
    ['id', c.gray(procedure.id)],
    ['mode', procedure.mode ?? 'single'],
    ['thinking', describeThinking(procedure.thinking)],
    ['project', procedure.projectId ? c.gray(procedure.projectId) : c.gray('none')],
    ['files', String(procedure.files?.length ?? 0)],
    ['folders', String(procedure.directories?.length ?? 0)]
  ])
  if (procedure.prompt?.trim()) {
    out()
    out('  ' + c.gray('PROMPT'))
    out(wrapText(procedure.prompt.trim(), 2))
  }
  if (procedure.files?.length) {
    out()
    out('  ' + c.gray('FILES'))
    table(
      ['file', 'stored at'],
      procedure.files.map((file) => [file.name, c.gray(shortPath(file.path))])
    )
  }
  if (procedure.directories?.length) {
    out()
    out('  ' + c.gray('WORKING FOLDERS'))
    for (const dir of procedure.directories) out(`    ${c.gray(shortPath(dir))}`)
  }
  return 0
}

// ─── Automations ────────────────────────────────────────────────────────────

/**
 * One automation. Its identity is its heading — kept in a MUTABLE binding,
 * because "edit" hands the heading over with the body (renaming it IS
 * rescheduling), and a menu that kept looking the job up under the old name
 * concluded it was gone and dumped the user back at the list on every
 * successful rename.
 */
async function openAutomation(client, initialLabel) {
  let label = initialLabel
  // Fetched once for the card's project row — the menu's own actions cannot
  // rebind the project, so a session-stale title is the worst case.
  const projects = await client.invoke('projects:list').catch(() => [])
  return browseOne({
    reload: async () => {
      // The save this menu just made told the daemon to re-parse the schedule
      // file; a read fired straight after can catch the registry mid-swap and
      // come back without the job. Settle briefly before concluding it is
      // gone — "gone" here means being thrown out to the list.
      for (let attempt = 0; ; attempt++) {
        const jobs = await client.invoke('heartbeat:getJobs')
        const found = jobs.find((job) => job.label === label) ?? null
        if (found || attempt >= 3) return found
        await new Promise((resolve) => setTimeout(resolve, 250))
      }
    },
    show: (current) =>
      showAutomation(current, { projectLabel: projectLabelFrom(projects, current?.project) }),
    actions: [
      { label: 'Run it now', run: () => automations(client, ['run', label]) },
      // Editing ONE job, rather than the whole file. The heading is the
      // schedule, so it is handed over WITH the body — changing it reschedules
      // the job, which is the intended way to move one, and the block is
      // spliced back at exactly the offsets it came from so nothing else in the
      // file can drift. `onRelabel` keeps this menu pointed at the job when
      // the heading changes.
      {
        label: 'Edit this automation',
        run: () =>
          editAutomation(client, label, {
            onRelabel: (next) => {
              label = next
            }
          })
      },
      { label: 'Copy the prompt', run: () => automations(client, ['copy', label]) },
      {
        label: 'Paste a new prompt (replaces it)',
        run: () => automations(client, ['paste', label])
      },
      {
        label: 'Attach files',
        run: () => attachFilesInteractive(client, 'automation', label)
      },
      {
        label: 'Add working folders',
        run: () => attachFoldersInteractive(client, 'automation', label)
      },
      {
        label: 'Remove a file',
        run: () => detachFileInteractive(client, 'automation', label)
      },
      {
        label: 'Remove a working folder',
        run: () => detachFolderInteractive(client, 'automation', label)
      },
      { label: 'Edit every automation (heartbeat.md)', run: () => automations(client, ['edit']) },
      {
        label: 'Set the thinking level',
        run: () => thinkingInteractive(client, 'automations', label)
      },
      {
        label: c.red('Delete'),
        run: async () => {
          if (!(await confirm(`  delete ${c.bold(label)}?`, false))) return
          return (await deleteAutomation(client, label)) ? 'gone' : undefined
        }
      }
    ]
  })
}

const HEARTBEAT_PATH = 'brain/brainstem/heartbeat.md'

/**
 * The job list, with two honesty guards a plain `heartbeat:getJobs` lacks.
 *
 * A save tells the daemon to re-parse the schedule file, and a list read
 * fired straight after can catch the registry mid-swap — which painted
 * "Automations (0)" over a file holding two live jobs. So an empty answer is
 * only believed once the FILE agrees it should be empty; while the file
 * plainly holds `## ` headings, the read is retried briefly, and if none of
 * them ever parse, that is said out loud instead of shrugging "none yet" —
 * the difference between "you have no automations" and "your automations are
 * there but broken" is the whole diagnosis.
 */
async function loadJobsSettled(client) {
  const jobs = await client.invoke('heartbeat:getJobs')
  if (jobs.length > 0) return jobs
  const raw = await client.invoke('viewer:readFile', HEARTBEAT_PATH).catch(() => '')
  const headings = (raw.replace(/<!--[\s\S]*?-->/g, '').match(/^##\s/gm) ?? []).length
  if (headings === 0) return jobs
  for (let attempt = 0; attempt < 3; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 250))
    const again = await client.invoke('heartbeat:getJobs')
    if (again.length > 0) return again
  }
  out(
    c.yellow(
      `  heartbeat.md holds ${headings} "## " heading${headings === 1 ? '' : 's'} but none parse as schedules — check the forms with ${cmd('automations edit')}`
    )
  )
  return []
}

/**
 * Where one job's block lives in heartbeat.md, as a character range.
 *
 * The boundary rules are the scheduler's own (`stripHeartbeatHeading` in
 * brainstem.ts): a block starts at its `## <label>` line and runs to the next
 * heading, the next HTML comment, or EOF — whichever comes first — and headings
 * inside comments are not headings at all, which is what keeps the commented
 * examples block at the bottom of the file from being mistaken for jobs. Keep
 * in step with that function; a CLI that guessed different boundaries would
 * eat the file's prose.
 */
export function findJobBlock(raw, label) {
  const ranges = []
  const commentRe = /<!--[\s\S]*?-->/g
  let match
  while ((match = commentRe.exec(raw)) !== null) {
    ranges.push([match.index, match.index + match[0].length])
  }
  const inComment = (pos) => ranges.some(([start, end]) => pos >= start && pos < end)

  const heads = []
  let offset = 0
  for (const line of raw.split('\n')) {
    const heading = /^##\s+(.+?)\s*$/.exec(line)
    if (heading && !inComment(offset)) {
      heads.push({ start: offset, lineEnd: offset + line.length + 1, label: heading[1] })
    }
    offset += line.length + 1
  }
  for (let i = 0; i < heads.length; i++) {
    if (heads[i].label !== label) continue
    let end = i + 1 < heads.length ? heads[i + 1].start : raw.length
    for (const [start] of ranges) if (start >= heads[i].lineEnd && start < end) end = start
    return { start: heads[i].start, end }
  }
  return null
}

async function editAutomation(client, label, { onRelabel = null } = {}) {
  const raw = await client.invoke('viewer:readFile', HEARTBEAT_PATH)
  const range = findJobBlock(raw, label)
  if (!range) {
    out(c.red(`  "${label}" is not in heartbeat.md any more`))
    return 1
  }
  const block = raw.slice(range.start, range.end)
  out(c.gray('  the ## heading IS the schedule — change it to reschedule this job'))
  const edited = await editInEditor(block, 'automation.md', { label })
  if (edited === null) return 1
  if (edited.trim() === block.trim()) {
    out(c.gray('  unchanged'))
    return 0
  }
  if (!edited.trim()) {
    out(c.yellow('  that would empty the job — use Delete instead'))
    return 1
  }

  /**
   * A prompt pasted INTO the editor often carries its own `## ` section
   * headings — and in this file every `## ` row is a job boundary, so saving
   * them as-is shatters the automation: the body ends at the first one and
   * the sections become orphan pseudo-jobs that don't even parse as
   * schedules (measured — this is exactly how a pasted brief "lost"
   * everything after its first section). The first `## ` row is the
   * schedule; extras are demoted to `### ` unless the split is confirmed as
   * deliberate.
   */
  let final = edited
  const headingRows = (final.match(/^##(?=\s)/gm) ?? []).length
  if (headingRows > 1) {
    out(
      c.yellow(
        `  the edited block holds ${headingRows} "## " rows — only the first is this job's schedule; the others would split off as separate jobs`
      )
    )
    const pick = interactive()
      ? (
          await question(
            `  ${c.dim('Enter demotes them to "### " · k keeps the split · c cancels')}: `
          )
        )
          .trim()
          .toLowerCase()
      : ''
    if (pick === 'c' || pick === 'cancel') {
      out(c.gray('  cancelled — nothing saved'))
      return 0
    }
    if (pick !== 'k' && pick !== 'keep') {
      let seenSchedule = false
      final = final
        .split('\n')
        .map((row) => {
          if (!/^##\s/.test(row)) return row
          if (!seenSchedule) {
            seenSchedule = true
            return row
          }
          return '#' + row
        })
        .join('\n')
      out(
        c.gray(
          `  demoted ${headingRows - 1} to "### " — the text reads the same, the job stays whole`
        )
      )
    }
  }

  const next = raw.slice(0, range.start) + final.trimEnd() + '\n\n' + raw.slice(range.end)
  await client.invoke('viewer:writeFile', HEARTBEAT_PATH, next)
  out(`${icon.ok()} saved — the scheduler reloads on the file change`)

  // A changed heading is a rename: tell the caller, so an open menu keeps
  // following the job instead of losing it.
  const newLabel = /^##\s+(.+?)\s*$/m.exec(final)?.[1] ?? null
  if (newLabel && newLabel !== label) {
    out(c.gray(`  now scheduled as "${newLabel}"`))
    onRelabel?.(newLabel)
  }
  return 0
}

/**
 * A job block split into its HEAD — the `## heading` line plus the leading
 * marker lines (`mode:`, `project:`, `icon:`, and the repeatable `file:` /
 * `dir:`) — and its BODY, the prompt the model actually receives.
 *
 * The boundary rules are `splitMarkers` in brainstem.ts, verbatim: markers are
 * LEADING lines only, blank lines may sit between them, and the body begins at
 * the first non-blank line that is not a marker. That function names the
 * renderer, the phone and the automations plugin as its mirrors — this is the
 * CLI's mirror of the same rule; keep all of them in sync. Exported for the
 * test.
 */
export function splitAutomationBlock(block) {
  const lines = String(block).split('\n')
  const head = [lines[0] ?? '']
  let pendingBlanks = []
  let i = 1
  for (; i < lines.length; i++) {
    const line = lines[i].trim()
    if (line === '') {
      pendingBlanks.push(lines[i])
      continue
    }
    if (
      /^mode:\s*(single|workflow)\s*$/i.test(line) ||
      /^project:\s*\S+\s*$/i.test(line) ||
      /^icon:\s*\S+\s*$/i.test(line) ||
      /^file:\s*.+$/i.test(line) ||
      /^dir:\s*.+$/i.test(line)
    ) {
      head.push(...pendingBlanks, lines[i])
      pendingBlanks = []
      continue
    }
    break
  }
  return { head: head.join('\n'), body: lines.slice(i).join('\n').trim() }
}

/**
 * A prompt made safe to live inside one heartbeat.md job.
 *
 * In this file a `## ` row IS a job boundary and `<!--` opens a disable
 * comment — so a pasted prompt whose own outline uses `## ` headings
 * shattered its automation on save: the body ended at the first section
 * heading and the remaining sections sat in the file as orphan pseudo-jobs
 * (measured on a real paste). Headings are demoted one level — `### ` reads
 * as the same outline and the parser leaves it alone. A comment opener has no
 * safe form at all (it can swallow every job to the next `-->`), so that one
 * refuses instead. Exported for the test.
 */
export function sanitizeAutomationBody(text) {
  const value = String(text)
  return {
    text: value.replace(/^##(?=\s)/gm, '###'),
    demoted: (value.match(/^##(?=\s)/gm) ?? []).length,
    commentMarker: value.includes('<!--')
  }
}

/**
 * Replace ONE job's prompt with pasted text, and nothing else: the heading
 * (which IS the schedule) and every marker line stay exactly where they were.
 * Editing the whole block is what `edit` is for; paste is the safe fast path.
 */
async function pasteAutomationPrompt(client, label) {
  const raw = await client.invoke('viewer:readFile', HEARTBEAT_PATH)
  const range = findJobBlock(raw, label)
  if (!range) {
    out(c.red(`  "${label}" is not in heartbeat.md any more`))
    return 1
  }
  const { head, body } = splitAutomationBlock(raw.slice(range.start, range.end))
  out(
    c.gray('  the schedule heading and the file:/dir: markers are kept — only the prompt changes')
  )
  const text = await pasteOwnedText('prompt', body)
  if (text === null) return 0
  const safe = sanitizeAutomationBody(text)
  if (safe.commentMarker) {
    out(
      `${icon.fail()} ${c.red('the prompt contains "<!--" — heartbeat.md uses HTML comments to switch blocks off, so it cannot ride inside a job body')}`
    )
    out(c.gray('  remove the comment marker and paste again — nothing was changed'))
    return 1
  }
  if (safe.demoted > 0) {
    out(
      c.yellow(
        `  demoted ${safe.demoted} "## " heading${safe.demoted === 1 ? '' : 's'} to "### " — a "## " row is a job boundary in heartbeat.md and would have split this automation apart`
      )
    )
  }
  const next =
    raw.slice(0, range.start) + head.trimEnd() + '\n\n' + safe.text + '\n\n' + raw.slice(range.end)
  await client.invoke('viewer:writeFile', HEARTBEAT_PATH, next)
  out(`${icon.ok()} saved — the scheduler reloads on the file change`)
  return 0
}

async function deleteAutomation(client, label) {
  const raw = await client.invoke('viewer:readFile', HEARTBEAT_PATH)
  const range = findJobBlock(raw, label)
  if (!range) {
    out(c.red(`  "${label}" is not in heartbeat.md any more`))
    return false
  }
  const next = (raw.slice(0, range.start) + raw.slice(range.end)).replace(/\n{3,}/g, '\n\n')
  await client.invoke('viewer:writeFile', HEARTBEAT_PATH, next)
  out(`${icon.ok()} deleted ${label}`)
  return true
}

const KNOWN_AUTOMATION_VERBS = new Set([
  'edit',
  'copy',
  'paste',
  'run',
  'files',
  'dirs',
  'folders',
  'show',
  'rm',
  'delete'
])

/**
 * Automations live in one markdown file the scheduler parses, so editing the
 * WHOLE store is `$EDITOR` on heartbeat.md — exactly what the desktop's cards
 * editor does underneath.
 *
 * Files and folders are the exception: they are `file:`/`dir:` marker lines
 * inside a job's block, and the copy into the workspace has to land with the
 * marker. Both halves happen in main (`cli:ownerFiles`), so the terminal never
 * does surgery on the schedule file.
 */
export async function automations(client, args, { json = false } = {}) {
  const [sub, ...rest] = args

  if (!sub || sub === 'list') {
    return browseList({
      title: 'Automations',
      empty: `none - ${cmd('automations edit')}`,
      load: () => loadJobsSettled(client),
      columns: ['label', 'schedule', 'thinking', 'files', 'folders', 'next run'],
      row: (job) => [
        `${job.icon ? job.icon + ' ' : ''}${job.label ?? '—'}`,
        job.cron ?? job.schedule ?? '—',
        thinkingLabel(job.thinking),
        String(job.files?.length ?? 0),
        String(job.dirs?.length ?? 0),
        job.nextRunMs ? new Date(job.nextRunMs).toLocaleString() : c.gray('—')
      ],
      open: (job) => openAutomation(client, job.label),
      json
    })
  }

  if (sub === 'edit' && rest.length === 0) {
    const markdown = await client.invoke('viewer:readFile', 'brain/brainstem/heartbeat.md')
    const edited = await editInEditor(markdown, 'heartbeat.md')
    if (edited === null) return 1
    if (edited === markdown) {
      out(c.gray('  unchanged'))
      return 0
    }
    await client.invoke('viewer:writeFile', 'brain/brainstem/heartbeat.md', edited)
    out(`${icon.ok()} saved — the scheduler reloads on the file change`)
    return 0
  }

  const named = KNOWN_AUTOMATION_VERBS.has(sub)
  const [needle, ...tail] = named ? rest : [sub, ...rest]
  const verb = named ? sub : 'show'
  if (!needle) return usageLine(`wolffish automations ${verb} "<label>"`)

  // An automation is named by its heading — the schedule itself — so a label
  // is the identity here, not an id.
  const jobs = await client.invoke('heartbeat:getJobs')
  const lower = String(needle).toLowerCase()
  const job =
    jobs.find((entry) => String(entry.label ?? '').toLowerCase() === lower) ??
    jobs.find((entry) =>
      String(entry.label ?? '')
        .toLowerCase()
        .includes(lower)
    ) ??
    null
  if (!job) {
    out(c.red(`no automation matching "${needle}"`))
    out(c.gray(`  ${cmd('automations')}   to list them`))
    return 1
  }

  switch (verb) {
    case 'show': {
      const projects = await client.invoke('projects:list').catch(() => [])
      return showAutomation(job, { projectLabel: projectLabelFrom(projects, job.project) })
    }
    case 'run': {
      const result = await client.invoke('heartbeat:runJob', job.label)
      if (result?.ok === false) {
        out(`${icon.fail()} ${c.red(result.error ?? 'failed to start')}`)
        return 1
      }
      out(`${icon.ok()} started ${job.label}`)
      return 0
    }
    case 'edit':
      // Just this job's block, spliced back where it came from. The heading is
      // handed over with it because the heading IS the schedule — editing it is
      // how you move a job, and the splice is by offset, so a renamed heading
      // lands correctly instead of being written back under the old name.
      return editAutomation(client, job.label)
    case 'copy':
      // `body` is the prompt with the markers already split off — the same
      // text the PROMPT section prints.
      return copyOwnedText('prompt', job.body)
    case 'paste':
      return pasteAutomationPrompt(client, job.label)
    case 'rm':
    case 'delete':
      if (!(await confirm(`  delete ${c.bold(job.label)}?`, false))) return 0
      return (await deleteAutomation(client, job.label)) ? 0 : 1
    case 'files':
      return ownedFiles(client, 'automation', job.label, tail, job.label)
    case 'dirs':
    case 'folders':
      return ownedFolders(client, 'automation', job.label, tail, job.label)
    default:
      out(c.red(`unknown: ${cmd(`automations ${verb}`)}`))
      out(
        c.gray(
          '  list · show <label> · run <label> · edit [label] · copy <label> · paste <label> · files · dirs · rm <label>'
        )
      )
      return 2
  }
}

/**
 * The human name for a project id, from an already-fetched projects list.
 * A card whose whole job is answering "which project does this run under?"
 * should say the project's name, not print a UUID.
 */
function projectLabelFrom(projects, id) {
  if (!id) return null
  const found = (projects ?? []).find((project) => project.id === id)
  return found ? `${found.icon ? found.icon + ' ' : ''}${found.title}` : null
}

function showAutomation(job, { projectLabel = null } = {}) {
  heading(`${job.icon ? job.icon + ' ' : ''}${job.label ?? 'Automation'}`)
  keyValue([
    ['schedule', job.cron ?? job.schedule ?? '—'],
    ['next run', job.nextRunMs ? new Date(job.nextRunMs).toLocaleString() : c.gray('—')],
    ['mode', job.mode ?? c.gray('follows the global mode')],
    ['thinking', describeThinking(job.thinking)],
    [
      'project',
      job.project
        ? projectLabel
          ? `${projectLabel} ${c.gray(String(job.project).slice(0, 8))}`
          : c.gray(job.project)
        : c.gray('none')
    ]
  ])
  // `body`, not `prompt` — an automation's instruction is `ParsedSchedule.body`
  // and reading a field the type does not have renders nothing, silently.
  const prompt = String(job.body ?? '').trim()
  if (prompt) {
    out()
    out('  ' + c.gray('PROMPT'))
    out(wrapText(prompt, 2))
  }
  if (job.files?.length) {
    out()
    out('  ' + c.gray('FILES'))
    for (const file of job.files) out(`    ${basename(file)}  ${c.gray(shortPath(file))}`)
  }
  if (job.dirs?.length) {
    out()
    out('  ' + c.gray('WORKING FOLDERS'))
    for (const dir of job.dirs) out(`    ${c.gray(shortPath(dir))}`)
  }
  return 0
}

// ─── The three shaping documents ────────────────────────────────────────────

/**
 * Soul, User and Agents are one markdown editor over one workspace file each —
 * the pages in the app do nothing more than that, so `$EDITOR` is a complete
 * equivalent rather than a reduced one.
 *
 * The paths are the ones the runtime actually reads (prefrontal.ts's
 * ALWAYS_INCLUDED, and the desktop pages' own `filePath`). Two of these were
 * wrong — `identity/self.md` and `prefrontal/AGENTS.md` — which on a
 * case-insensitive Mac quietly edited the right file for Agents and an
 * unread one for Soul, and on Linux missed both.
 */
const DOCS = {
  soul: { path: 'brain/identity/soul.md', title: 'Soul' },
  user: { path: 'brain/identity/user.md', title: 'User' },
  agents: { path: 'brain/prefrontal/agents.md', title: 'Agents' }
}

/**
 * `wolffish customizations` — the three files that shape the agent.
 *
 * The name is the app's own: the config snapshot calls these
 * `CUSTOMIZATION_DOCS` and the phone's screen for them is Customization, so
 * the terminal says customizations too.
 *
 * Viewing is the default. These are documents you consult far more often than
 * you rewrite, and a bare name that opened `$EDITOR` made "what does my Soul
 * say?" a question you could only answer by entering an editor and leaving it
 * again.
 */
export async function customizations(client, args, { json = false } = {}) {
  const [first, ...rest] = args
  const verb =
    first === 'show' ||
    first === 'view' ||
    first === 'edit' ||
    first === 'copy' ||
    first === 'paste'
      ? first
      : null
  const name = verb ? rest[0] : first

  if (!name) {
    if (!interactive()) {
      heading('Customizations')
      table(
        ['name', 'file', 'what it is'],
        [
          ['soul', c.gray(DOCS.soul.path), 'who the agent is'],
          ['user', c.gray(DOCS.user.path), 'who you are'],
          ['agents', c.gray(DOCS.agents.path), 'standing instructions']
        ]
      )
      out()
      out(c.gray(`  ${cmd('customizations <name>')}        print it`))
      out(c.gray(`  ${cmd('customizations edit <name>')}   change it`))
      out(c.gray(`  ${cmd('customizations copy <name>')}   copy it to the clipboard`))
      out(c.gray(`  ${cmd('customizations paste <name>')}  replace it with pasted text`))
      return 0
    }
    // Numbered, like every other list here — these are three documents you
    // read and rewrite constantly, and making that a second command to type
    // was the only thing standing between the list and the thing it lists.
    return browseList({
      title: 'Customizations',
      empty: 'no documents',
      load: async () =>
        Object.entries(DOCS).map(([key, doc]) => ({ key, ...doc, id: key, title: doc.title })),
      columns: ['name', 'file', 'what it is'],
      row: (doc) => [
        doc.key,
        c.gray(doc.path),
        { soul: 'who the agent is', user: 'who you are', agents: 'standing instructions' }[doc.key]
      ],
      open: (doc) => openDoc(client, doc.key),
      json
    })
  }
  if (verb === 'edit') return editDoc(client, name)
  if (verb === 'copy') return copyDoc(client, name)
  if (verb === 'paste') return pasteDoc(client, name)
  return showDoc(client, name)
}

/** One shaping document: read it, change it, move its text in or out. */
function openDoc(client, name) {
  const doc = DOCS[name]
  return browseOne({
    reload: async () => ({ title: doc.title, id: name }),
    show: () => {
      heading(doc.title)
      out(c.gray(`  ${doc.path}`))
    },
    actions: [
      { label: 'Read it', run: () => showDoc(client, name) },
      { label: 'Edit it', run: () => editDoc(client, name) },
      { label: 'Copy it', run: () => copyDoc(client, name) },
      { label: 'Paste a replacement (overwrites it)', run: () => pasteDoc(client, name) }
    ]
  })
}

async function showDoc(client, name) {
  const doc = DOCS[name]
  if (!doc) {
    out(c.red(`unknown document: ${name}`))
    out(c.gray(`  one of: ${Object.keys(DOCS).join(', ')}`))
    return 2
  }
  const text = await client.invoke('viewer:readFile', doc.path).catch(() => null)
  if (text === null) {
    out(c.red(`cannot read ${doc.path}`))
    return 1
  }
  heading(doc.title)
  out(c.gray(`  ${doc.path}`))
  if (!text.trim()) {
    out()
    out(c.gray('  empty'))
    return 0
  }
  out()
  // Rendered, not dumped: these are markdown documents and the terminal has a
  // markdown renderer — the same one a turn's prose goes through.
  out(renderMarkdown(text))
  out()
  out(c.gray(`  ${cmd(`customizations edit ${name}`)}`))
  return 0
}

export async function editDoc(client, name) {
  const doc = DOCS[name]
  if (!doc) {
    out(c.red(`unknown document: ${name}`))
    out(c.gray(`  one of: ${Object.keys(DOCS).join(', ')}`))
    return 2
  }
  const current = await client.invoke('viewer:readFile', doc.path).catch(() => '')
  const edited = await editInEditor(current, path.basename(doc.path))
  if (edited === null) return 1
  if (edited === current) {
    out(c.gray('  unchanged'))
    return 0
  }
  await client.invoke('viewer:writeFile', doc.path, edited)
  out(`${icon.ok()} saved ${doc.title} ${c.gray(doc.path)}`)
  return 0
}

async function copyDoc(client, name) {
  const doc = DOCS[name]
  if (!doc) {
    out(c.red(`unknown document: ${name}`))
    out(c.gray(`  one of: ${Object.keys(DOCS).join(', ')}`))
    return 2
  }
  const text = await client.invoke('viewer:readFile', doc.path).catch(() => null)
  if (text === null) {
    out(c.red(`cannot read ${doc.path}`))
    return 1
  }
  return copyOwnedText(`${doc.title} document`, text)
}

async function pasteDoc(client, name) {
  const doc = DOCS[name]
  if (!doc) {
    out(c.red(`unknown document: ${name}`))
    out(c.gray(`  one of: ${Object.keys(DOCS).join(', ')}`))
    return 2
  }
  const current = await client.invoke('viewer:readFile', doc.path).catch(() => '')
  const text = await pasteOwnedText(`${doc.title} document`, current)
  if (text === null) return 0
  // Text files end in a newline; the composer's answer does not carry one.
  await client.invoke('viewer:writeFile', doc.path, text + '\n')
  out(`${icon.ok()} saved ${doc.title} ${c.gray(doc.path)}`)
  return 0
}

// ─── The workspace, as a place you can walk ─────────────────────────────────

/**
 * `viewer:readTree` nodes are `{ type: 'dir' | 'file', name, relativePath }`.
 *
 * The old walker tested `node.kind === 'directory'` — a field that does not
 * exist on this shape — and only worked at all because of the `|| node.children`
 * fallback beside it. Read the field the type actually has.
 */
const isDir = (node) => node?.type === 'dir' || Array.isArray(node?.children)

/** Depth-first, directories before files, each sorted by name — `ls` order. */
function sortNodes(nodes) {
  return [...(nodes ?? [])].sort((a, b) => {
    if (isDir(a) !== isDir(b)) return isDir(a) ? -1 : 1
    return String(a.name).localeCompare(String(b.name))
  })
}

/** Walk to a relative path inside an already-read tree. Null if it is a file or missing. */
function descend(tree, relativePath) {
  if (!relativePath) return { nodes: tree, path: '' }
  let nodes = tree
  const parts = String(relativePath).split('/').filter(Boolean)
  for (let i = 0; i < parts.length; i++) {
    const found = (nodes ?? []).find((node) => node.name === parts[i])
    if (!found) return null
    if (!isDir(found)) return i === parts.length - 1 ? { file: found } : null
    nodes = found.children ?? []
  }
  return { nodes, path: parts.join('/') }
}

/** Every file in the tree, flat — what a search walks. */
function flatten(nodes, into = []) {
  for (const node of nodes ?? []) {
    if (isDir(node)) flatten(node.children ?? [], into)
    else into.push(node)
  }
  return into
}

/**
 * `wolffish files` — the workspace, walked rather than dumped.
 *
 * It used to print a two-level tree with a footer suggesting `edit <path>`, and
 * that was the whole of it: no way to look INSIDE a file, no way to reach
 * anything deeper than the second level, and the one follow-up it named needed
 * an `$EDITOR` most machines do not have. A workspace you can list but never
 * open is not a workspace you can inspect.
 *
 * So: numbers walk in, blank walks out, a file opens the viewer. A typed word
 * searches every file in the tree by path, which is the only sane way to find
 * one thing among the several thousand under `brain/`.
 *
 * Piped or scripted, it prints the tree and returns, exactly as before.
 */
export async function browseFiles(client, target) {
  const tree = await client.invoke('viewer:readTree')

  // A path argument jumps straight there — a folder to browse, a file to read.
  let cursor = ''
  if (target) {
    const found = descend(tree, target)
    if (found?.file) return viewFile(client, found.file.relativePath)
    if (found) cursor = found.path
    else {
      // Not a path: treat it as a filter, which is what it meant before.
      const matches = flatten(tree).filter((node) =>
        String(node.relativePath).toLowerCase().includes(String(target).toLowerCase())
      )
      heading(`Workspace ${c.gray(`"${target}"`)}`)
      if (matches.length === 0) {
        out(c.gray('  nothing matches'))
        return 1
      }
      if (!interactive()) {
        for (const node of matches.slice(0, 200)) out(`  ${node.relativePath}`)
        if (matches.length > 200) out(c.gray(`  …and ${matches.length - 200} more`))
        return 0
      }
      return pickFrom(client, matches)
    }
  }

  if (!interactive()) {
    // A named folder prints THAT folder, in full. Printing the whole workspace
    // when you asked for one directory is the same non-answer the old prefix
    // filter gave: it applied to files and not to folders, so `files brain/`
    // returned every directory in the tree and none of what you asked for.
    const at = cursor ? descend(tree, cursor) : { nodes: tree }
    heading(cursor ? `Workspace ${c.gray(`${g.chevron} ${cursor}`)}` : 'Workspace')
    // Two levels from the root — deeper is thousands of lines of `files/` and
    // `logs/`, which is a dump, not a listing. A NAMED folder prints in full,
    // because naming it is the request.
    printTree(at?.nodes ?? [], 0, cursor ? 99 : 1)
    out()
    out(c.gray(`  ${cmd('files <path>')}   a folder, a file, or a word to search for`))
    out(c.gray(`  ${cmd('view <path>')}    print a file`))
    return 0
  }

  for (;;) {
    const here = descend(tree, cursor)
    if (!here || here.file) return 0
    const entries = sortNodes(here.nodes)

    heading(cursor ? `Workspace ${c.gray(`${g.chevron} ${cursor}`)}` : 'Workspace')
    if (entries.length === 0) out(c.gray('  empty'))
    entries.forEach((node, index) => {
      const name = isDir(node) ? c.blue(node.name + '/') : node.name
      const detail = isDir(node)
        ? c.gray(
            `${(node.children ?? []).length} ${(node.children ?? []).length === 1 ? 'entry' : 'entries'}`
          )
        : ''
      out(`  ${c.cyan(String(index + 1).padStart(3))}. ${pad(name, 44)}${detail}`)
    })
    out()
    out(
      c.gray(
        `  ${entries.length} ${entries.length === 1 ? 'entry' : 'entries'} · ` +
          `${cursor ? 'blank goes up' : 'blank exits'} · type a word to search`
      )
    )

    const answer = (await question(`  ${c.dim('number, or type to search')}: `)).trim()
    if (!answer) {
      if (!cursor) return 0
      cursor = cursor.split('/').slice(0, -1).join('/')
      continue
    }
    if (isQuit(answer)) return 0
    if (/^\d+$/.test(answer)) {
      const chosen = entries[Number.parseInt(answer, 10) - 1]
      if (!chosen) {
        outOfRange(entries.length)
        continue
      }
      if (isDir(chosen)) cursor = chosen.relativePath
      else await viewFile(client, chosen.relativePath)
      continue
    }
    const matches = flatten(tree).filter((node) =>
      String(node.relativePath).toLowerCase().includes(answer.toLowerCase())
    )
    if (matches.length === 0) {
      out(c.yellow(`  nothing matches "${answer}"`))
      continue
    }
    await pickFrom(client, matches)
  }
}

/** Search results: pick one and read it. */
async function pickFrom(client, matches) {
  for (;;) {
    heading(`Matches ${c.gray(`(${matches.length})`)}`)
    const shown = matches.slice(0, 60)
    shown.forEach((node, index) => {
      out(`  ${c.cyan(String(index + 1).padStart(3))}. ${node.relativePath}`)
    })
    if (matches.length > shown.length) {
      out(c.gray(`  …and ${matches.length - shown.length} more — narrow the word`))
    }
    out()
    const answer = (await question(`  ${c.dim('number, blank goes back')}: `)).trim()
    if (!answer || isQuit(answer)) return 0
    const chosen = shown[Number.parseInt(answer, 10) - 1]
    if (!chosen) {
      outOfRange(shown.length)
      continue
    }
    await viewFile(client, chosen.relativePath)
  }
}

function printTree(nodes, depth, maxDepth) {
  for (const node of sortNodes(nodes)) {
    const indent = '  '.repeat(depth + 1)
    if (isDir(node)) {
      out(`${indent}${c.blue(node.name)}/`)
      if (depth < maxDepth) printTree(node.children ?? [], depth + 1, maxDepth)
    } else {
      out(`${indent}${node.name}`)
    }
  }
}

/**
 * Files a terminal should not try to print.
 *
 * `viewer:readFile` decodes as UTF-8 whatever the bytes were, so a PNG arrives
 * as a wall of U+FFFD and a sqlite database arrives with embedded NULs — both
 * of which, printed raw, scramble the terminal badly enough to need a `reset`.
 * Deciding from the DECODED text rather than the extension means an unknown
 * extension is judged on what it actually contains.
 */
export function looksBinary(text) {
  const sample = text.slice(0, 4096)
  if (sample.includes('\u0000')) return true
  const replacements = (sample.match(/�/g) ?? []).length
  return sample.length > 0 && replacements / sample.length > 0.02
}

const MARKDOWN = /\.(md|markdown|mdx)$/i

/**
 * Field names whose VALUE is a credential, in every syntax the workspace
 * actually holds them in — JSON (`"apiKey": "…"`), YAML/TOML (`token: …`) and
 * env files (`API_KEY=…`).
 */
const SECRET_KEY =
  /(api[_-]?key|token|secret|password|passwd|credential|private[_-]?key|client[_-]?secret|refresh[_-]?token|access[_-]?key|session[_-]?id)/i

/** Credentials that are recognisable on sight, wherever they appear. */
const SECRET_SHAPE =
  /\b(sk-[A-Za-z0-9_-]{12,}|ghp_[A-Za-z0-9]{20,}|gho_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|AIza[A-Za-z0-9_-]{20,}|ntn_[A-Za-z0-9]{20,}|secret_[A-Za-z0-9]{20,}|eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})/g

const maskValue = (value) => {
  const text = String(value)
  if (text.length === 0) return text
  if (text.length <= 10) return '•'.repeat(6)
  return `${text.slice(0, 4)}${'•'.repeat(10)}${text.slice(-2)}`
}

/**
 * Credentials, masked, before a file is printed.
 *
 * The rest of this CLI is careful about this on purpose — `manageKeys` masks
 * provider keys, the daemon masks secret cards before they cross the socket,
 * and both say why: a terminal is scrollback, tmux buffers and screen shares.
 * A file viewer that reads `config.json` straight off disk walks around all of
 * it, and `wolffish files` now puts that two keystrokes from the top level.
 *
 * So displaying a file masks; EDITING one does not, because an edit has to
 * round-trip byte-for-byte or it would write the mask back over the key. The
 * escape hatch is explicit: `wolffish view <path> --raw`.
 */
export function redact(text) {
  let count = 0
  const bump = (value) => {
    count++
    return maskValue(value)
  }
  const masked = text
    // "apiKey": "value"  ·  'token': 'value'
    .replace(
      /(["']?[A-Za-z0-9_.-]*?)(["']?\s*[:=]\s*)(["'])([^"'\n]{4,})(["'])/g,
      (whole, key, sep, open, value, close) =>
        SECRET_KEY.test(key) ? `${key}${sep}${open}${bump(value)}${close}` : whole
    )
    // API_KEY=value  ·  token: value   (no quotes)
    .replace(
      /^(\s*[A-Za-z0-9_.-]*?)(\s*[:=]\s*)([^\s"'#][^\n]{3,})$/gm,
      (whole, key, sep, value) =>
        SECRET_KEY.test(key) ? `${key}${sep}${bump(value.trim())}` : whole
    )
    // Anything shaped like a credential, wherever it sits.
    .replace(SECRET_SHAPE, (value) => bump(value))
  return { text: masked, count }
}

/**
 * One workspace file, on screen — and everything you can do to it.
 *
 * Markdown is rendered (the same renderer a turn's prose goes through), source
 * is numbered, and anything binary says what it is instead of vomiting bytes
 * into the scrollback. Long files page rather than scroll away, because a
 * 4,000-line conversation log printed in one burst is indistinguishable from
 * having printed nothing.
 */
export async function viewFile(
  client,
  relativePath,
  { paged = true, secrets = false, json = false } = {}
) {
  const source = await client.invoke('viewer:readFile', relativePath).catch(() => null)
  if (source === null) {
    err(c.red(`cannot read ${relativePath}`))
    return 1
  }

  if (json) {
    // redact() returns { text, count } — the count is what tells a reader that
    // what they are holding is not the whole file.
    const masked = looksBinary(source) ? null : secrets ? null : redact(source)
    out(
      JSON.stringify(
        {
          path: relativePath,
          bytes: Buffer.byteLength(source, 'utf8'),
          binary: looksBinary(source),
          redacted: masked ? masked.count : 0,
          content: looksBinary(source) ? null : secrets ? source : masked.text
        },
        null,
        2
      )
    )
    return 0
  }

  if (looksBinary(source)) {
    heading(basename(relativePath))
    keyValue([
      ['path', c.gray(relativePath)],
      ['type', c.yellow('binary — not shown')],
      ['size', bytes(Buffer.byteLength(source, 'utf8'))]
    ])
    // A binary file in the workspace is usually something the agent produced —
    // an image, a PDF, an archive — and "not shown" with no next step made it
    // unreachable from a terminal. The absolute path is what `scp` takes.
    const root = await client
      .invoke('cli:status')
      .then((snapshot) => snapshot?.workspace?.rootPath ?? null)
      .catch(() => null)
    if (root) out(c.gray(`  copy it out with:  scp ${root}/${relativePath} you@laptop:~/`))
    return 0
  }

  const { text, count: masked } = secrets ? { text: source, count: 0 } : redact(source)
  const lines = text.split('\n')

  if (!paged || !interactive()) {
    out(text.endsWith('\n') ? text.slice(0, -1) : text)
    if (masked > 0) {
      err(
        c.gray(
          `  ${masked} ${masked === 1 ? 'credential' : 'credentials'} masked · --raw to print them`
        )
      )
    }
    return 0
  }

  heading(basename(relativePath))
  out(
    c.gray(`  ${relativePath} · ${lines.length} ${lines.length === 1 ? 'line' : 'lines'}`) +
      (masked > 0
        ? c.yellow(` · ${masked} ${masked === 1 ? 'credential' : 'credentials'} masked`)
        : '')
  )
  out()
  const stopped = await page(
    MARKDOWN.test(relativePath) ? renderMarkdown(text).split('\n') : numbered(lines)
  )
  out()
  if (stopped) out(c.gray('  stopped'))

  const actions = [
    // Editing gets the ORIGINAL. Handing the masked copy to an editor would
    // write the bullets back over the real key on the first save.
    { label: 'Edit it', run: () => editWorkspaceFile(client, relativePath) },
    {
      label: 'Print it whole (no paging)',
      run: () => viewFile(client, relativePath, { paged: false, secrets })
    },
    ...(masked > 0
      ? [
          {
            label: c.yellow('Show the masked credentials'),
            run: () => viewFile(client, relativePath, { secrets: true })
          }
        ]
      : []),
    { label: 'Save a copy somewhere', run: () => saveCopy(source, relativePath) }
  ]

  // Only the MENU repeats on a bad number. Re-running the outer body would
  // re-page the whole file to tell you that 9 is not one of four options.
  for (;;) {
    actions.forEach((action, index) => {
      out(`  ${c.cyan(String(index + 1).padStart(3))}. ${action.label}`)
    })
    out()
    const answer = (await question(`  ${c.dim('number, blank goes back')}: `)).trim()
    if (!answer || isQuit(answer)) return 0
    const chosen = actions[Number.parseInt(answer, 10) - 1]
    if (!chosen) {
      outOfRange(actions.length)
      out()
      continue
    }
    out()
    try {
      await chosen.run()
    } catch (error) {
      out(`${icon.fail()} ${c.red(error?.message ?? String(error))}`)
    }
    return 0
  }
}

function numbered(lines) {
  const width = String(lines.length).length
  return lines.map((line, index) => `  ${c.gray(String(index + 1).padStart(width))}  ${line}`)
}

/** A screenful at a time. Returns true if the reader stopped early. */
async function page(lines) {
  const height = Math.max(10, (process.stdout.rows || 30) - 8)
  if (lines.length <= height || !interactive()) {
    for (const line of lines) out(line)
    return false
  }
  for (let i = 0; i < lines.length; i += height) {
    for (const line of lines.slice(i, i + height)) out(line)
    if (i + height >= lines.length) break
    const answer = (
      await question(
        `  ${c.dim(`${Math.min(i + height, lines.length)}/${lines.length} — enter for more, q to stop`)}: `
      )
    ).trim()
    if (isQuit(answer)) return true
  }
  return false
}

/** Copy what is on screen to somewhere outside the workspace. */
async function saveCopy(text, relativePath) {
  const answer = (await question(`  ${c.dim('destination path, blank cancels')}: `)).trim()
  if (!answer) return 0
  const resolved = answer.startsWith('~') ? path.join(os.homedir(), answer.slice(1)) : answer
  const stat = await fs.stat(resolved).catch(() => null)
  const target = stat?.isDirectory() ? path.join(resolved, basename(relativePath)) : resolved
  await fs.writeFile(target, text, 'utf8')
  out(`${icon.ok()} ${shortPath(target)}`)
  return 0
}

/** One word for "get me out of here", accepted by every menu in the CLI. */
export function isQuit(answer) {
  const value = String(answer ?? '')
    .trim()
    .toLowerCase()
  return value === 'q' || value === 'quit' || value === 'exit' || value === ':q'
}

/** Say what the valid answers were. "no such item" alone teaches nothing. */
export function outOfRange(count) {
  out(c.red(`  no such item — pick 1${count > 1 ? `-${count}` : ''}, or leave it blank to go back`))
}

export async function editWorkspaceFile(client, relativePath) {
  const current = await client.invoke('viewer:readFile', relativePath).catch(() => null)
  if (current === null) {
    out(c.red(`cannot read ${relativePath}`))
    return 1
  }
  const edited = await editInEditor(current, path.basename(relativePath))
  if (edited === null) return 1
  if (edited === current) {
    out(c.gray('  unchanged'))
    return 0
  }
  await client.invoke('viewer:writeFile', relativePath, edited)
  out(`${icon.ok()} saved ${relativePath}`)
  return 0
}

/**
 * Hand content to an editor and read back what came out. Returns null when the
 * user bailed — callers treat that as "changed nothing", never as "save an
 * empty file".
 *
 * The editor itself is resolved in lib/editor.mjs, which falls back to a
 * built-in line editor when the machine has no `$EDITOR` and nothing installed.
 * It used to stop at `no $EDITOR set`, which is the default state of a fresh
 * macOS shell — so on a normal machine every "Edit …" entry in every menu here
 * printed an error and returned.
 */
export async function editInEditor(content, fileName, options = {}) {
  return editText(content, fileName, options)
}

/**
 * The ranges `usage:getSummary` accepts — `UsageTimeRange`, verbatim, with the
 * Usage panel's own words for each.
 *
 * Verbatim matters: the handler does date arithmetic on a range it recognises
 * and reads `.getFullYear()` off `undefined` for one it does not. "month" is
 * an obvious-looking value that is not in the set, and passing it crashed the
 * caller rather than returning an error.
 */
export const USAGE_RANGES = [
  { value: 'today', label: 'Today' },
  { value: 'this_month', label: 'This month' },
  { value: '3_months', label: '3 months' },
  { value: '6_months', label: '6 months' },
  { value: 'ytd', label: 'Year to date' },
  { value: 'all_time', label: 'All time' }
]

/** What people type, as what the handler takes. */
const RANGE_ALIASES = {
  month: 'this_month',
  this_month: 'this_month',
  day: 'today',
  today: 'today',
  week: '3_months',
  year: 'ytd',
  ytd: 'ytd',
  all: 'all_time',
  all_time: 'all_time',
  '3_months': '3_months',
  '6_months': '6_months'
}

/** 1_234_567 → "1.2m", the way the Usage panel's tiles read. */
function compact(n) {
  const value = Number(n) || 0
  const fmt = (v) => new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(v)
  if (value >= 1_000_000_000) return `${fmt(value / 1_000_000_000)}b`
  if (value >= 1_000_000) return `${fmt(value / 1_000_000)}m`
  if (value >= 1_000) return `${fmt(value / 1_000)}k`
  return fmt(value)
}

const money = (n) => `$${(Number(n) || 0).toFixed(2)}`

/**
 * `wolffish usage` — the Usage panel's numbers, from the Usage panel's calls.
 *
 * Both of them: `getSummary` is per provider and per model, `getStats` is the
 * spend and activity tiles, and the panel renders them together. An earlier
 * version fetched only the summary AND read fields that do not exist on it
 * (`inputTokens` instead of `totalInputTokens`), so every provider printed
 * zeros — a report that looked like a machine with no usage rather than like a
 * bug. The names here are `ProviderUsageSummary` and `UsageStatsTotals`,
 * verbatim.
 *
 * Derived values are derived the same way too: daily average is
 * `totalCost / activeDays` and a provider's tokens are input + output, exactly
 * as the cards compute them — not a second opinion about what those mean.
 */
export async function usage(client, range = 'this_month', { json } = {}) {
  const resolved = RANGE_ALIASES[String(range).toLowerCase()]
  if (!resolved) {
    out(c.red(`unknown range: ${range}`))
    out(c.gray(`  one of: ${USAGE_RANGES.map((entry) => entry.value).join(', ')}`))
    return 2
  }
  const [summary, stats] = await Promise.all([
    client.invoke('usage:getSummary', resolved),
    client.invoke('usage:getStats', resolved).catch(() => null)
  ])
  if (json) {
    out(JSON.stringify({ range: resolved, summary, stats }, null, 2))
    return 0
  }

  const label = USAGE_RANGES.find((entry) => entry.value === resolved)?.label ?? resolved
  heading(`Usage ${c.gray(label)}`)

  if (stats) {
    const dailyAverage = stats.activeDays > 0 ? stats.totalCost / stats.activeDays : 0
    keyValue([
      ['total spend', c.bold(money(stats.totalCost))],
      [
        'top day',
        stats.topSpendDay
          ? `${money(stats.topSpendDay.cost)} ${c.gray(stats.topSpendDay.date)}`
          : c.gray('—')
      ],
      ['daily average', money(dailyAverage)],
      ['conversations', compact(stats.conversations)],
      ['messages', compact(stats.messages)],
      ['tokens', compact(stats.totalTokens)],
      ['active days', compact(stats.activeDays)],
      ['longest streak', `${stats.longestStreak} ${stats.longestStreak === 1 ? 'day' : 'days'}`],
      ['favourite model', stats.favouriteModel ?? c.gray('none yet')]
    ])
  }

  // Providers with nothing on the ledger are dimmed in the app rather than
  // hidden. A terminal has no dimming worth the twelve lines it would cost, so
  // they are counted on one line instead — same information, one twelfth of
  // the screen.
  const providers = Array.isArray(summary?.providers) ? summary.providers : []
  const used = providers.filter((p) => p.totalInputTokens + p.totalOutputTokens > 0)
  const idle = providers.length - used.length

  if (used.length > 0) {
    out()
    table(
      ['provider', 'in', 'out', 'tokens', 'cost'],
      used.map((p) => [
        p.provider,
        compact(p.totalInputTokens),
        compact(p.totalOutputTokens),
        compact(p.totalInputTokens + p.totalOutputTokens),
        money(p.totalCost)
      ])
    )
    for (const provider of used) {
      if (!provider.models?.length) continue
      out()
      out(`  ${c.gray(provider.provider)}`)
      table(
        ['model', 'tokens', 'cost'],
        provider.models.map((model) => [
          model.model,
          compact(model.inputTokens + model.outputTokens),
          money(model.cost)
        ]),
        { indent: 4 }
      )
    }
  } else {
    out()
    out(c.gray('  no model usage in this range'))
  }

  const brave = summary?.brave
  if (brave && brave.totalQueries > 0) {
    out()
    keyValue([
      ['brave search', `${compact(brave.totalQueries)} queries ${c.gray(money(brave.totalCost))}`]
    ])
  }
  if (idle > 0) {
    out()
    out(c.gray(`  ${idle} other ${idle === 1 ? 'provider has' : 'providers have'} no usage`))
  }
  return 0
}
