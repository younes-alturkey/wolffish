#!/usr/bin/env node
/**
 * Bring the committed dataset up to the code-activity contract — a one-shot
 * migration over demo/conversations, idempotent so a re-run changes nothing.
 *
 * The feed now shows two things on every conversation whatever the verbose
 * preference says, and the dataset predates both:
 *
 *  1. A COMPACT ROW for every code tool (file_edit / file_write / file_patch /
 *     shell_exec — desktop CODE_ACTIVITY_TOOLS). The row's exit code, elapsed
 *     time, label and +N −M all come from the tool_result's `meta` (desktop
 *     ToolResultMeta), which the real tools attach and these transcripts never
 *     carried. Every shell_exec result gains `{ label, cwd, durationMs,
 *     exitCode, truncated }` the way the shell plugin's finalize() writes it;
 *     every successful file_write / file_patch gains a `diff` produced by the
 *     desktop's own unified-diff module (vendored) from the call's arguments.
 *
 *  2. The model's TASK LIST (todo_write). The desktop's todo capability tells
 *     the model to keep a checklist whenever the work takes 3+ distinct steps,
 *     so every turn here with three or more distinct steps gets the list a
 *     model following that rule would have kept: a todo_write at the start of
 *     the turn (first step in progress), one at the end in the turn's final
 *     state, each as the tool_call / tool_result pair the desktop persists
 *     plus the `todo` segment the card renders from. Items are derived from
 *     the turn's own tool calls — the searches it ran, the pages it read, the
 *     files it delivered — merged into steps, in the order they happened.
 *
 * Shell labels are the ones the desktop's describeCommand gives each command.
 * That function lives in the desktop's shell plugin (tokenize.mjs, ~2k lines,
 * not vendored); pass it once with --tokenize and the labels are computed and
 * COMMITTED, so the workflow never depends on the desktop checkout again.
 * Without it every run is labelled the plugin's fallback, "Run shell command".
 *
 *   node scripts/demo/enrich-code-activity.mjs \
 *     --tokenize ../wolffish-app/src/defaults/workspace/brain/cerebellum/shell/plugin/tokenize.mjs
 *   node scripts/demo/enrich-code-activity.mjs --dry-run   # report only
 *
 * Skips the generated showcases (conv-*.json): those come from their own
 * generators and already carry what they need.
 */
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { countChanges, createUnifiedDiff } from './vendor/unified-diff.mjs'

const ROOT = path.join(path.dirname(new URL(import.meta.url).pathname), '..', '..')
const DEMO = process.env.DEMO_OUT ?? path.join(ROOT, 'demo')
const HOME = '/Users/younes'
const DRY_RUN = process.argv.includes('--dry-run')

function argValue(flag) {
  const index = process.argv.indexOf(flag)
  return index >= 0 ? process.argv[index + 1] : null
}

// ---------------------------------------------------------------------------
// Deterministic helpers — hashes off ids, so a re-run is byte-identical.
// ---------------------------------------------------------------------------

function fnv(text) {
  let hash = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash
}

/** A number in [min, max] hashed off `seed`. */
function pick(seed, min, max) {
  return min + (fnv(seed) % (max - min + 1))
}

function expandHome(p) {
  if (typeof p !== 'string') return p
  if (p === '~') return HOME
  return p.startsWith('~/') ? HOME + p.slice(1) : p
}

/** The `--- a/` header path: absolute, leading slashes stripped (desktop displayPath). */
function shownPath(absolute) {
  return absolute.replace(/^\/+/, '')
}

/** Shift every hunk header by `offset` lines — a diff of a region, placed inside its file. */
function shiftHunks(patch, offset) {
  return patch.replace(
    /^@@ -(\d+),(\d+) \+(\d+),(\d+) @@$/gm,
    (_, a, b, c, d) => `@@ -${Number(a) + offset},${b} +${Number(c) + offset},${d} @@`
  )
}

function basename(p) {
  return typeof p === 'string' ? p.replace(/\/+$/, '').split('/').pop() || p : ''
}

/** The program a command runs: the first word past `sudo`/`env`/`cd …&&` and paths. */
function commandHead(command) {
  // The first line that is a command — a leading `# comment` names nothing.
  const first =
    String(command)
      .split('\n')
      .find((line) => line.trim() && !line.trim().startsWith('#')) ?? ''
  const tokens = first
    .split(/\s*(?:&&|\|\||;|\|)\s*/)
    .map((part) => part.trim())
    .filter(Boolean)
  for (const part of tokens) {
    const words = part.split(/\s+/).filter((w) => w && !/^[A-Z_]+=/.test(w))
    let head = words[0] ?? ''
    if ((head === 'sudo' || head === 'env' || head === 'nohup') && words[1]) head = words[1]
    if (head === 'cd') continue
    head = head.replace(/^["']|["']$/g, '')
    if (head.includes('/')) head = head.split('/').pop() ?? head
    if (head) return head
  }
  return 'shell'
}

function host(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return null
  }
}

function clip(text, max) {
  const one = String(text).replace(/\s+/g, ' ').trim()
  return one.length <= max ? one : `${one.slice(0, max - 1).trimEnd()}…`
}

// ---------------------------------------------------------------------------
// Shell results: the meta finalize() attaches to every run.
// ---------------------------------------------------------------------------

function exitCodeFor(result) {
  const text = `${result.output ?? ''}\n${result.error ?? ''}`
  if (result.status === 'success') {
    return /command exited 1 with no output/.test(text) ? 1 : 0
  }
  const coded = /exited with code (\d+)/.exec(text)
  if (coded) return Number(coded[1])
  // Killed on timeout — the plugin reports null, not a code.
  if (/timed out|timeout/i.test(text)) return null
  return 1
}

function shellMeta(call, result, timing, describe) {
  const command = typeof call.args?.command === 'string' ? call.args.command : ''
  const meta = {
    label: describe ? describe(command).label : 'Run shell command',
    cwd: expandHome(call.args?.cwd) || HOME,
    durationMs:
      timing && typeof timing.endedAt === 'number'
        ? Math.max(1, timing.endedAt - timing.startedAt)
        : pick(`dur:${call.toolCallId}`, 240, 3_800),
    exitCode: exitCodeFor(result),
    truncated: false
  }
  const output = result.output ?? ''
  if (output.startsWith('...output truncated')) {
    meta.truncated = true
    const spilled = /Full output saved to: (\S+)/.exec(output)
    if (spilled) meta.outputPath = spilled[1]
  }
  return meta
}

// ---------------------------------------------------------------------------
// File results: the diff the edit tools attach.
// ---------------------------------------------------------------------------

/** file_write with the whole content in hand: a create, all additions. */
function writeMeta(call) {
  const absolute = expandHome(call.args?.path)
  const content = typeof call.args?.content === 'string' ? call.args.content : ''
  if (typeof absolute !== 'string' || !content) return null
  const patch = createUnifiedDiff(shownPath(absolute), '', content)
  const { additions, deletions } = countChanges('', content)
  return {
    output: `Created ${absolute} (${Buffer.byteLength(content, 'utf8')} bytes, +${additions} −${deletions})`,
    meta: { diff: { file: absolute, patch, additions, deletions, kind: 'create' }, label: 'Create' }
  }
}

/** file_patch (find → replace): a diff of the replaced region, placed inside the file. */
function patchMeta(call) {
  const absolute = expandHome(call.args?.path)
  const find = typeof call.args?.find === 'string' ? call.args.find : ''
  const replace = typeof call.args?.replace === 'string' ? call.args.replace : ''
  if (typeof absolute !== 'string' || !find || find === replace) return null
  const region = createUnifiedDiff(shownPath(absolute), find, replace)
  const patch = shiftHunks(region, pick(`hunk:${call.toolCallId}`, 40, 400))
  const { additions, deletions } = countChanges(find, replace)
  return {
    meta: { diff: { file: absolute, patch, additions, deletions, kind: 'edit' }, label: 'Edit' }
  }
}

// ---------------------------------------------------------------------------
// Task lists: the steps a turn's tool calls amount to.
// ---------------------------------------------------------------------------

/**
 * One tool call as a step family + the phrase it earns alone. Families merge
 * when consecutive, so ten searches in a row are one step, not ten.
 */
function classify(call, describe) {
  const name = call.name
  const args = call.args ?? {}
  const family = (key, single, merged, priority) => ({ key, single, merged, priority })

  if (name === 'web_search') {
    const query = typeof args.query === 'string' ? clip(args.query, 44) : null
    return family('search', query ? `Search the web for “${query}”` : 'Search the web', (n) =>
      query ? `Search the web for “${query}” and ${n - 1} more` : 'Search the web'
    )
  }
  if (/^(browser_pdf|pdf_create|pdf_render|html_to_pdf)$/.test(name))
    return family('pdf', 'Render the PDF', () => 'Render the PDF')
  // Every browser and extension tool is one family: navigating, reading,
  // clicking and screenshotting a page are all "reading the sources".
  if (/^(web_fetch|ext_|browser_)/.test(name)) {
    const site = typeof args.url === 'string' ? host(args.url) : null
    return family(
      'browse',
      site ? `Read ${site}` : 'Read the page',
      (n) => `Read the top sources (${n} pages)`
    )
  }
  if (name === 'send_file') {
    const file = basename(args.path)
    return family(
      'deliver',
      file ? `Deliver ${file}` : 'Deliver the file',
      (n) => `Deliver the files (${n})`,
      'high'
    )
  }
  if (/^telegram_/.test(name))
    return family('telegram', 'Send it on Telegram', () => 'Send it on Telegram', 'high')
  if (/^whatsapp_(send|reply)/.test(name))
    return family('whatsapp', 'Send it on WhatsApp', () => 'Send it on WhatsApp', 'high')
  if (/^whatsapp_/.test(name))
    return family('whatsapp-read', 'Read the WhatsApp thread', () => 'Read the WhatsApp thread')
  if (name === 'shell_exec') {
    // The desktop's own verb for the command ("Kill process", "List files");
    // a run of same-verb commands is one step, a change of verb a new one.
    const command = typeof args.command === 'string' ? args.command : ''
    const label = describe ? describe(command).label : 'Run shell command'
    if (label !== 'Run shell command') {
      return family(`shell:${label}`, label, (n) => `${label} (${n} commands)`)
    }
    // The generic fallback names nothing, so the step names the programs the
    // commands run instead ("Run lsof, launchctl and 2 more"); consecutive
    // generic commands are one step, and its heads accumulate (deriveSteps).
    return { ...family('shell:generic', '', null), heads: [commandHead(command)] }
  }
  if (/^file_(write|edit|patch)$/.test(name)) {
    const file = basename(args.path)
    return family(
      'write',
      file ? `Write ${file}` : 'Write the file',
      (n) => `Write the files (${n})`
    )
  }
  if (name === 'file_delete')
    return family(
      'delete',
      `Delete ${basename(args.path) || 'the file'}`,
      (n) => `Delete the files (${n})`
    )
  if (/^(file_read|pdf_read|document_read|skill_read_source)$/.test(name)) {
    const file = basename(args.path)
    return family('read', file ? `Read ${file}` : 'Read the file', () => 'Read the source material')
  }
  if (name === 'conversation_read')
    return family(
      'history',
      'Review the earlier conversations',
      () => 'Review the earlier conversations'
    )
  if (/^(memory_|recall)/.test(name))
    return family('memory', 'Check memory for context', () => 'Check memory for context')
  if (name === 'ask_user') return family('ask', 'Ask the user', () => 'Ask the user')
  if (name === 'voice_respond')
    return family('voice', 'Reply with a voice note', () => 'Reply with a voice note', 'high')
  if (/^computer_/.test(name)) return family('screen', 'Drive the screen', () => 'Drive the screen')
  if (name === 'channel_status')
    return family('channels', 'Check the channels', () => 'Check the channels')
  if (name === 'google_accounts')
    return family(
      'accounts',
      'Check the connected Google accounts',
      () => 'Check the connected Google accounts'
    )
  if (name === 'google_gmail_labels')
    return family('mail-labels', 'Read the mailbox labels', () => 'Read the mailbox labels')
  if (name === 'gif_trending') return family('gif', 'Find the GIF', () => 'Find the GIF')
  if (name === 'pdf_info') return family('read', 'Inspect the PDF', () => 'Inspect the PDF')
  if (/^notion_(search|read)/.test(name))
    return family('notion-read', 'Look it up in Notion', () => 'Look it up in Notion')
  if (/^notion_/.test(name)) return family('notion', 'Update Notion', () => 'Update Notion', 'high')
  if (/^google_gmail_(search|read)$/.test(name))
    return family('mail', 'Read the unread emails', () => 'Read the unread emails')
  if (name === 'google_gmail_mark_read')
    return family('mail-done', 'Mark them read', () => 'Mark them read')
  if (name === 'gif_search') return family('gif', 'Find the GIF', () => 'Find the GIF')
  if (/^meme_/.test(name)) return family('meme', 'Make the meme', () => 'Make the meme')
  if (name === 'coinflip_do') return family('coin', 'Flip the coin', () => 'Flip the coin')
  if (name === 'browser_pdf') return family('pdf', 'Render the PDF', () => 'Render the PDF')
  if (name === 'ffmpeg_run')
    return family('ffmpeg', 'Convert the media with ffmpeg', () => 'Convert the media with ffmpeg')
  if (/^(agent_spawn|agents_await|spawn_worker|await_workers|close_worker)$/.test(name)) {
    return family(
      'agents',
      'Fan the work out to sub-agents',
      () => 'Fan the work out to sub-agents'
    )
  }
  if (name === 'workflow_plan')
    return family('plan', 'Plan the workflow', () => 'Plan the workflow')
  if (/^(tool_search|tool_activate)$/.test(name))
    return family('tools', 'Activate the right tools', () => 'Activate the right tools')
  if (/^automation_/.test(name))
    return family('automations', 'Check the automations', () => 'Check the automations')
  if (/^procedure_/.test(name))
    return family('procedures', 'Run the saved procedure', () => 'Run the saved procedure')
  if (name === 'wolffish_list_files')
    return family('ls', 'List the workspace files', () => 'List the workspace files')
  if (name === 'spreadsheet_create')
    return family('sheet', 'Build the spreadsheet', () => 'Build the spreadsheet')
  if (/^(image_view|vision)/.test(name))
    return family('look', 'Look at the image', () => 'Look at the image')
  // Reading the manual is preparation, not a step of the work.
  if (name === 'operating_manual') return null
  // Anything else reads off its own name: `tafsir_fetch_tafsir` → "Fetch the
  // tafsir", `ffmpeg_check` → "Check ffmpeg" — the verb the tool is named for,
  // then what it acts on (the trailing words, or the capability itself).
  const tokens = name
    .replace(/^wolffish_/, '')
    .split('_')
    .filter(Boolean)
  const verbAt = tokens.findIndex((t) => VERBS.has(t))
  let phrase
  if (verbAt < 0) {
    phrase = `Use ${tokens.join(' ')}`
  } else {
    const verb = tokens[verbAt][0].toUpperCase() + tokens[verbAt].slice(1)
    const object = tokens.slice(verbAt + 1)
    // "Search in tafsir", not "Search the in tafsir".
    const article = object.length && /^(in|for|by|on|to)$/.test(object[0]) ? '' : 'the '
    phrase = object.length
      ? `${verb} ${article}${object.join(' ')}`
      : `${verb} ${tokens.slice(0, verbAt).join(' ')}`
  }
  return family(name, phrase, () => phrase)
}

const VERBS = new Set([
  'fetch',
  'get',
  'read',
  'search',
  'list',
  'create',
  'send',
  'check',
  'run',
  'execute',
  'write',
  'update',
  'append',
  'convert',
  'generate',
  'render',
  'download',
  'upload',
  'query',
  'find',
  'open',
  'close',
  'start',
  'stop',
  'do',
  'reload',
  'install',
  'delete',
  'remove'
])

/**
 * The turn's tool calls as an ordered step list (3..6 items), or null when
 * the work does not amount to three distinct steps — the desktop's own rule
 * for when the model keeps a list at all.
 */
function deriveSteps(calls, resultById, describe) {
  const groups = []
  for (const call of calls) {
    const step = classify(call, describe)
    if (!step) continue
    const last = groups[groups.length - 1]
    const result = resultById.get(call.toolCallId)
    const failed = !!result && result.status !== 'success'
    if (last && last.key === step.key) {
      last.count++
      last.failed = last.failed && failed
      if (step.heads) for (const h of step.heads) if (!last.heads.includes(h)) last.heads.push(h)
      continue
    }
    groups.push({
      key: step.key,
      single: step.single,
      merged: step.merged,
      heads: step.heads ? [...step.heads] : null,
      priority: step.priority,
      count: 1,
      failed
    })
  }
  if (groups.length < 3) return null

  // Past six, the middle collapses: keep the first five and the last, which is
  // where the delivery usually is.
  const kept = groups.length > 6 ? [...groups.slice(0, 5), groups[groups.length - 1]] : groups
  return kept.map((group) => ({
    content: group.heads
      ? runPhrase(group.heads)
      : group.count > 1
        ? group.merged(group.count)
        : group.single,
    priority: group.priority,
    failed: group.failed
  }))
}

/** "Run lsof", "Run lsof and ps", "Run lsof, ps and 3 more". */
function runPhrase(heads) {
  const [a, b, ...rest] = heads
  if (!b) return `Run ${a}`
  if (rest.length === 0) return `Run ${a} and ${b}`
  return `Run ${a}, ${b} and ${rest.length} more`
}

function todoItem(step, status) {
  const item = { content: step.content, status }
  if (step.priority) item.priority = step.priority
  return item
}

function todoOutput(items) {
  const inProgress = items.filter((t) => t.status === 'in_progress').length
  const done = items.filter((t) => t.status === 'completed').length
  return `${items.length} todos (${done} completed, ${inProgress} in progress)\n${JSON.stringify(items, null, 2)}`
}

/**
 * The list at the start (first step in progress) and at the end. A turn that
 * finished cleanly completed every step; one that stopped early (a failed
 * last step, or a turn cut short) is left on that step. A step whose every
 * call failed and that the model then moved past is cancelled — it was
 * abandoned for another route.
 */
function finalStatuses(steps, turnEnd, lastResultFailed) {
  const cutShort = lastResultFailed || (turnEnd && turnEnd.stopReason !== 'end_turn')
  return steps.map((step, index) => {
    const isLast = index === steps.length - 1
    if (cutShort && isLast) return 'in_progress'
    if (step.failed && !isLast) return 'cancelled'
    return 'completed'
  })
}

// ---------------------------------------------------------------------------
// The pass over one message.
// ---------------------------------------------------------------------------

function enrichMessage(message, describe, counters) {
  const segments = message.segments
  if (!Array.isArray(segments)) return false
  let changed = false
  const timings = message.toolTimings ?? {}

  const callById = new Map()
  for (const s of segments) if (s.kind === 'tool_call' && !s.worker) callById.set(s.toolCallId, s)
  const resultById = new Map()
  for (const s of segments)
    if (s.kind === 'tool_result' && !s.worker) resultById.set(s.toolCallId, s)

  // 1. Result meta on the code tools.
  for (const result of segments) {
    if (result.kind !== 'tool_result' || result.worker || result.meta) continue
    const call = callById.get(result.toolCallId)
    if (!call) continue
    if (call.name === 'shell_exec') {
      result.meta = shellMeta(call, result, timings[call.toolCallId], describe)
      counters.shell++
      changed = true
    } else if (call.name === 'file_write' && result.status === 'success') {
      const built = writeMeta(call)
      if (!built) continue
      result.output = built.output
      result.meta = built.meta
      counters.diffs++
      changed = true
    } else if (call.name === 'file_patch' && result.status === 'success') {
      const built = patchMeta(call)
      if (!built) continue
      result.meta = built.meta
      counters.diffs++
      changed = true
    }
  }

  // 2. Task lists, one turn at a time.
  const turnIds = []
  for (const s of segments) if (!s.worker && !turnIds.includes(s.turnId)) turnIds.push(s.turnId)
  for (const turnId of turnIds) {
    const inTurn = (s) => s.turnId === turnId && !s.worker
    if (segments.some((s) => inTurn(s) && s.kind === 'todo')) continue
    const calls = segments.filter(
      (s) => inTurn(s) && s.kind === 'tool_call' && s.name !== 'todo_write'
    )
    if (calls.length < 3) continue
    const steps = deriveSteps(calls, resultById, describe)
    if (!steps) continue

    const turnEnd = segments.find((s) => inTurn(s) && s.kind === 'turn_end')
    const lastCall = calls[calls.length - 1]
    const lastResult = resultById.get(lastCall.toolCallId)
    const lastResultFailed = !!lastResult && lastResult.status !== 'success'
    const statuses = finalStatuses(steps, turnEnd, lastResultFailed)
    const first = steps.map((step, i) => todoItem(step, i === 0 ? 'in_progress' : 'pending'))
    const final = steps.map((step, i) => todoItem(step, statuses[i]))

    // Timings bracket the turn's own tool activity, when the transcript has any.
    const turnTimings = calls.map((c) => timings[c.toolCallId]).filter((t) => t && t.endedAt)
    const firstAt = turnTimings.length
      ? Math.min(...turnTimings.map((t) => t.startedAt)) - 1_400
      : null
    const lastAt = turnTimings.length ? Math.max(...turnTimings.map((t) => t.endedAt)) + 600 : null

    const stamp = fnv(`${message.id}:${turnId}`).toString(36)
    const write = (n, items, at) => {
      const toolCallId = `call_td_${stamp}_${n}`
      if (at !== null) {
        message.toolTimings = message.toolTimings ?? {}
        message.toolTimings[toolCallId] = { startedAt: at, endedAt: at + 40 }
      }
      return [
        {
          kind: 'tool_call',
          turnId,
          segmentId: `seg_td_${stamp}_${n}a`,
          toolCallId,
          name: 'todo_write',
          args: { todos: items }
        },
        {
          kind: 'tool_result',
          turnId,
          segmentId: `seg_td_${stamp}_${n}b`,
          toolCallId,
          status: 'success',
          output: todoOutput(items)
        },
        { kind: 'todo', turnId, segmentId: `seg_td_${stamp}_${n}c`, items }
      ]
    }

    // The opening write goes after the turn's first model chip (or at its
    // start), before any tool — except that a turn which opens by reading the
    // operating manual plans AFTER reading it, as the model would; the closing
    // one after the turn's last result, ahead of the reply that follows it.
    const startIndex = segments.findIndex(inTurn)
    let openAt = segments[startIndex].kind === 'active_model' ? startIndex + 1 : startIndex
    const opener = segments[openAt]
    if (opener?.kind === 'tool_call' && opener.name === 'operating_manual') {
      const manualResult = segments.findIndex(
        (s, i) =>
          i > openAt && inTurn(s) && s.kind === 'tool_result' && s.toolCallId === opener.toolCallId
      )
      if (manualResult > 0) {
        openAt = manualResult + 1
        if (segments[openAt]?.kind === 'active_model' && inTurn(segments[openAt])) openAt++
      }
    }
    let closeAt = -1
    for (let i = segments.length - 1; i >= 0; i--) {
      const s = segments[i]
      if (inTurn(s) && s.kind === 'tool_result' && s.toolCallId === lastCall.toolCallId) {
        closeAt = i + 1
        break
      }
    }
    if (closeAt < 0) continue
    segments.splice(closeAt, 0, ...write(2, final, lastAt))
    segments.splice(openAt, 0, ...write(1, first, firstAt))
    counters.lists++
    counters.addedCalls += 2
    if (turnId === turnIds[turnIds.length - 1]) counters.addedCallsLastTurn += 2
    changed = true
  }
  return changed
}

async function main() {
  const tokenizePath = argValue('--tokenize')
  let describe = null
  if (tokenizePath) {
    const mod = await import(path.resolve(tokenizePath))
    if (typeof mod.describeCommand !== 'function')
      throw new Error('--tokenize: no describeCommand export')
    describe = (command) => mod.describeCommand(command)
  } else {
    console.warn('no --tokenize given: shell labels fall back to "Run shell command"')
  }

  const dir = path.join(DEMO, 'conversations')
  const names = (await fs.readdir(dir))
    .filter((n) => n.endsWith('.json') && !n.startsWith('conv-'))
    .sort()
  const totals = { files: 0, shell: 0, diffs: 0, lists: 0, convsWithLists: 0 }

  for (const name of names) {
    const file = path.join(dir, name)
    const raw = await fs.readFile(file, 'utf8')
    const conversation = JSON.parse(raw)
    const counters = { shell: 0, diffs: 0, lists: 0, addedCalls: 0, addedCallsLastTurn: 0 }
    let changed = false
    for (const message of conversation.messages ?? []) {
      if (message.role !== 'assistant') continue
      if (enrichMessage(message, describe, counters)) changed = true
    }
    if (!changed) continue
    // Honest counters: the ledger counts the calls the transcript now holds.
    if (counters.addedCalls && conversation.stats?.allTime?.toolCalls !== undefined) {
      conversation.stats.allTime.toolCalls += counters.addedCalls
    }
    if (counters.addedCallsLastTurn && conversation.stats?.lastTurn?.toolCalls !== undefined) {
      conversation.stats.lastTurn.toolCalls += counters.addedCallsLastTurn
    }
    totals.files++
    totals.shell += counters.shell
    totals.diffs += counters.diffs
    totals.lists += counters.lists
    if (counters.lists) totals.convsWithLists++
    if (!DRY_RUN) {
      // Keep each file's own formatting: the dataset rows are pretty-printed
      // with a trailing newline; anything compact stays compact.
      const pretty = raw.startsWith('{\n')
      const text = pretty
        ? `${JSON.stringify(conversation, null, 2)}\n`
        : JSON.stringify(conversation)
      await fs.writeFile(file, text)
    }
  }

  console.log(
    `${DRY_RUN ? '[dry run] ' : ''}${totals.files} conversations changed: ` +
      `${totals.shell} shell results given meta, ${totals.diffs} file results given diffs, ` +
      `${totals.lists} task lists added across ${totals.convsWithLists} conversations`
  )
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
