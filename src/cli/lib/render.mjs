/**
 * Turn the agent's segment stream into terminal output.
 *
 * This is the CLI's answer to the chat feed. Every card the desktop renders
 * has a line-shaped equivalent here, and the SAME visibility rule applies:
 * with `verbose` off (the default on every channel) the feed is agent prose,
 * delivered files and errors — nothing else. Verbose adds the model chip and
 * every tool call, result, and activity line.
 *
 * The card ↔ line mapping, so it stays honest as either side changes:
 *
 *   chat card              CLI equivalent
 *   ─────────────────────  ────────────────────────────────────────────────
 *   assistant markdown     prose, streamed, lightly styled
 *   tool call/result       ⏺ name  args  → outcome            (verbose)
 *   active model chip      ⏺ provider/model                    (verbose)
 *   file card (send_file)  ◆ name  size  path
 *   chart card             ◆ name  spec + a note that it renders in the app
 *   path card (show_path)  ▸ path  (folder|file)
 *   approval card          ▲ blocking prompt: approve / deny / always
 *   ask-user card          ? numbered questions, one prompt each
 *   task card              a live status line, replaced in place by taskId
 *   workflow card          agent roster + phase, replaced in place
 *   compaction card        one line: N results, tokens saved, duration
 *   reasoning card         dim, collapsed to a count unless verbose
 *   turn footer            model · tokens · duration            (verbose)
 */
import { c, g, icon, out, safe, shortPath, wrapText, bytes, width } from './ui.mjs'
import { stdoutIsTty } from './tty.mjs'
import { createMarkdownStream, renderMarkdown } from './markdown.mjs'

// Line-anchored: a real marker stands on its own line (send_file emits it as
// the whole output); output that merely QUOTES the marker template mid-line —
// a grep/cat over code or docs — must never render as a delivered file.
const OUTPUT_MARKER =
  /^[ \t]*\[wolffish-output:[ \t]*([^\]\n]+?)[ \t]+\((image|audio|video|document|file|chart)\)\][ \t]*$/gm
const PATH_MARKER = /^[ \t]*\[wolffish-path:[ \t]*([^\]\n]+?)[ \t]+\((folder|file)\)\][ \t]*$/gm

/**
 * Tool results that are purely a delivery marker carry no other information,
 * so the file line replaces the result line rather than following it — the
 * same rule the chat feed uses to avoid showing a card and its raw text.
 */
function extractDeliveries(output) {
  const files = []
  const paths = []
  if (typeof output !== 'string' || output.length === 0) return { files, paths, rest: '' }
  let rest = output
  OUTPUT_MARKER.lastIndex = 0
  for (const match of output.matchAll(OUTPUT_MARKER)) {
    files.push({ path: match[1].trim(), kind: match[2] })
    rest = rest.replace(match[0], '')
  }
  PATH_MARKER.lastIndex = 0
  for (const match of output.matchAll(PATH_MARKER)) {
    paths.push({ path: match[1].trim(), kind: match[2] })
    rest = rest.replace(match[0], '')
  }
  return { files, paths, rest: rest.trim() }
}

/** Compact one-line summary of tool arguments — never the whole payload. */
function summarizeArgs(args) {
  if (!args || typeof args !== 'object') return ''
  const parts = []
  for (const [key, value] of Object.entries(args)) {
    if (value === undefined || value === null) continue
    let text
    if (typeof value === 'string') text = value
    else if (typeof value === 'number' || typeof value === 'boolean') text = String(value)
    else if (Array.isArray(value)) text = `[${value.length}]`
    else text = '{…}'
    text = text.replace(/\s+/g, ' ').trim()
    const room = Math.max(24, Math.floor(width() / 2))
    if (text.length > room) text = text.slice(0, room - 1) + '…'
    parts.push(parts.length === 0 && Object.keys(args).length === 1 ? text : `${key}=${text}`)
    if (parts.length >= 3) break
  }
  return parts.join(' ')
}

export class TurnRenderer {
  /**
   * `raw` writes the model's markdown through untouched. It is the default off
   * a TTY for the same reason colour is: `wolffish -p … | pbcopy` must give the
   * real markdown, and someone redirecting to a file wants the source, not
   * ANSI. Interactive terminals get it rendered.
   */
  /**
   * `fileOffset` is how many files the SESSION has already been handed.
   *
   * The numbers printed next to a delivered file are what `/open` and `/save`
   * take, and those index the session's list, not this turn's. Numbering from
   * one every turn meant the second turn's first file said "/open 1" and
   * `/open 1` opened a file from the first turn — the more files a session
   * produced, the further the hint drifted from the truth.
   */
  constructor({
    verbose = false,
    raw = !stdoutIsTty(),
    fileOffset = 0,
    replay = false,
    showTools = '--tools'
  } = {}) {
    this.verbose = verbose
    this.raw = raw
    this.fileOffset = fileOffset
    /**
     * True when re-rendering a STORED message rather than a live stream.
     *
     * The difference matters for anything measured against the clock: a
     * replayed turn's "elapsed" is the age of this object, not of the turn.
     */
    this.replay = replay
    /** What to type to see the hidden detail — `/show tools` inside a session. */
    this.showTools = showTools
    // Rendered prose is line-buffered (markdown cannot be rendered a character
    // at a time), so it goes through its own writer rather than #prose.
    this.markdown = raw
      ? null
      : createMarkdownStream({
          write: (chunk) => {
            // safe() here, not in out(): this writer bypasses out() so the
            // stream can place newlines itself, which also bypasses the
            // transliteration every other line gets.
            process.stdout.write(safe(chunk))
            this.atLineStart = chunk.endsWith('\n')
          }
        })
    this.toolNames = new Map()
    this.toolStartedAt = new Map()
    // Task and workflow segments are SNAPSHOTS keyed by id — the app replaces
    // the card in place. A terminal can't repaint scrollback, so the id is
    // tracked and only meaningful transitions print, instead of one line per
    // tick (a video task alone emits dozens).
    this.taskState = new Map()
    this.countdownState = new Map()
    this.waitState = new Map()
    this.workflowState = new Map()
    this.deliveredThisTurn = new Set()
    this.startedAt = Date.now()
    this.atLineStart = true
    this.sawProse = false
    this.files = []
  }

  setVerbose(verbose) {
    this.verbose = verbose
  }

  /** Files delivered this turn, so the REPL can offer /open and /save by index. */
  deliveries() {
    return this.files
  }

  #line(text = '') {
    this.#flushProse()
    if (!this.atLineStart) {
      out()
      this.atLineStart = true
    }
    out(text)
  }

  #prose(delta) {
    this.sawProse = true
    if (this.markdown) {
      this.markdown.push(delta)
      return
    }
    process.stdout.write(safe(delta))
    this.atLineStart = delta.endsWith('\n')
  }

  /**
   * Render whatever prose is still held before anything else writes. Every
   * non-text segment calls this: a tool line printed while a half-finished
   * sentence sits in the buffer would appear ABOVE it, reordering the turn.
   */
  #flushProse() {
    if (!this.markdown || !this.markdown.pending) return
    this.markdown.flush()
  }

  segment(segment) {
    switch (segment.kind) {
      case 'text':
        this.#prose(segment.delta)
        return
      case 'active_model':
        if (!this.verbose) return
        this.#line(`${icon.dot()} ${c.gray(`${segment.provider}/${segment.model}`)}`)
        return
      case 'tool_call':
        this.toolNames.set(segment.toolCallId, segment.name)
        this.toolStartedAt.set(segment.toolCallId, Date.now())
        if (!this.verbose) return
        this.#line(
          `${icon.tool()} ${c.bold(segment.name)} ${c.gray(summarizeArgs(segment.args))}`.trimEnd()
        )
        return
      case 'tool_result':
        this.#toolResult(segment)
        return
      case 'task':
        this.#task(segment.snapshot)
        return
      case 'countdown':
        this.#countdown(segment.snapshot)
        return
      case 'wait':
        this.#wait(segment.snapshot)
        return
      case 'workflow':
        this.#workflow(segment.snapshot)
        return
      case 'compaction_started':
        if (!this.verbose) return
        this.#line(
          c.gray(
            `  compacting ${segment.targetsCount} tool results (${segment.tokenCount} tokens in context)`
          )
        )
        return
      case 'compaction':
        if (!this.verbose) return
        this.#line(
          c.gray(
            `  compacted ${segment.targetsCount} results · saved ${segment.tokensSaved} tokens · ${Math.round(segment.durationMs)}ms`
          )
        )
        return
      case 'turn_end':
        this.#turnEnd(segment)
        return
      case 'separator':
        if (this.verbose) this.#line(c.gray('  ─'))
        return
      default:
        return
    }
  }

  #toolResult(segment) {
    const name = this.toolNames.get(segment.toolCallId) ?? 'tool'
    const { files, paths, rest } = extractDeliveries(segment.output)

    // File and location deliveries print in EVERY mode. They are the model's
    // deliberate act of handing something over, which is exactly the thing a
    // clean feed must never swallow.
    for (const file of files) {
      if (this.deliveredThisTurn.has(file.path)) continue
      this.deliveredThisTurn.add(file.path)
      this.files.push(file)
      const index = this.fileOffset + this.files.length
      this.#line(
        `${icon.file()} ${c.bold(basename(file.path))}  ${c.gray(shortPath(file.path))}` +
          (file.kind === 'chart' ? c.gray('  (chart — renders in the app and on the phone)') : '')
      )
      this.#line(
        c.gray(`   ${index}. open with /open ${index}   copy out with /save ${index} <dest>`)
      )
    }
    for (const entry of paths) {
      this.#line(`${icon.arrow()} ${c.bold(shortPath(entry.path))} ${c.gray(`(${entry.kind})`)}`)
    }

    if (segment.status === 'stopped') {
      // Stopped on purpose — a warning, not a failure, and never hidden.
      const by = segment.meta?.stoppedBy === 'user' ? 'stopped by you' : 'stopped'
      this.#line(`${icon.warn()} ${c.bold(name)} ${c.yellow(by)}`)
      return
    }

    const failed = segment.status === 'failed'
    if (failed) {
      // Errors are never hidden. A clean feed still has to say when something
      // went wrong, or the turn reads as a success that produced nothing.
      const detail = (segment.error || rest || '').split('\n')[0].slice(0, 240)
      this.#line(`${icon.fail()} ${c.bold(name)} ${c.red(detail || 'failed')}`)
      return
    }

    if (!this.verbose) return
    if (files.length > 0 || paths.length > 0) return

    const started = this.toolStartedAt.get(segment.toolCallId)
    const took = started ? `${Date.now() - started}ms` : ''
    const preview = (rest || '').split('\n')[0].slice(0, Math.max(30, width() - 24))
    const suffix = rest && rest.length > preview.length ? '…' : ''
    this.#line(
      `  ${icon.ok()} ${c.gray(`${preview}${suffix}`)}${took ? c.gray(`  ${took}`) : ''}`.trimEnd()
    )
  }

  #task(snapshot) {
    if (!snapshot || typeof snapshot !== 'object') return
    const id = snapshot.taskId ?? snapshot.id ?? 'task'
    const status = snapshot.status ?? 'running'
    if (this.taskState.get(id) === status) return
    this.taskState.set(id, status)
    const label = snapshot.title ?? snapshot.kind ?? 'task'
    const mark =
      status === 'succeeded' ? icon.ok() : status === 'failed' ? icon.fail() : icon.tool()
    // Task cards are one of the two things a clean feed keeps beyond prose and
    // files: they represent minutes of background work, and silence for that
    // long reads as a hang.
    this.#line(`${mark} ${c.bold(label)} ${c.gray(status)}`)
  }

  // A turn-end countdown: armed while the turn runs, then counting once it
  // ends, then fired/aborted. The terminal's card has no Abort button, so the
  // line says where the one that does lives — silence here would mean a
  // machine going down with nothing on screen having announced it.
  #countdown(snapshot) {
    if (!snapshot || typeof snapshot !== 'object') return
    const id = snapshot.countdownId ?? 'countdown'
    const status = snapshot.status ?? 'armed'
    if (this.countdownState.get(id) === status) return
    this.countdownState.set(id, status)
    const label = snapshot.label ?? 'action'
    const mark = status === 'fired' ? icon.ok() : status === 'failed' ? icon.fail() : icon.tool()
    const detail =
      status === 'armed' || status === 'counting'
        ? `in ${snapshot.seconds ?? 0}s — abort it in the app`
        : status === 'aborted'
          ? `aborted (${snapshot.abortedBy ?? 'user'})`
          : status
    this.#line(`${mark} ${c.bold(label)} ${c.gray(detail)}`)
  }

  // A blocking wait. Never hidden, verbose or not: minutes of deliberate
  // silence with nothing on screen is the definition of a hang. Typing in the
  // composer is already a mid-turn message, which is what ends a wait — so
  // the line says that rather than pointing at a control the terminal lacks.
  #wait(snapshot) {
    if (!snapshot || typeof snapshot !== 'object') return
    const id = snapshot.waitId ?? 'wait'
    const status = snapshot.status ?? 'waiting'
    if (this.waitState.get(id) === status) return
    this.waitState.set(id, status)
    const reason = snapshot.reason ?? 'waiting'
    const mark =
      status === 'waiting' ? icon.tool() : status === 'canceled' ? icon.fail() : icon.ok()
    const seconds = Number(snapshot.seconds ?? 0)
    const pretty =
      seconds < 60
        ? `${Math.round(seconds)}s`
        : seconds < 3600
          ? `${Math.round(seconds / 60)}m`
          : `${Math.round((seconds / 3600) * 10) / 10}h`
    const detail =
      status === 'waiting'
        ? `waiting ${pretty} — send a message to continue now`
        : status === 'elapsed'
          ? `waited ${pretty}`
          : status === 'interrupted'
            ? 'woken early by your message'
            : 'stopped'
    this.#line(`${mark} ${c.bold(reason)} ${c.gray(detail)}`)
  }

  #workflow(snapshot) {
    if (!snapshot || typeof snapshot !== 'object') return
    const id = snapshot.workflowId ?? 'workflow'
    const agents = Array.isArray(snapshot.agents) ? snapshot.agents : []
    const done = agents.filter((a) => a.status === 'succeeded' || a.status === 'failed').length
    const key = `${snapshot.phase ?? ''}:${done}/${agents.length}`
    if (this.workflowState.get(id) === key) return
    this.workflowState.set(id, key)
    const phase = snapshot.phase ? ` ${c.gray(snapshot.phase)}` : ''
    this.#line(`${icon.tool()} ${c.bold('workflow')}${phase} ${c.gray(`${done}/${agents.length}`)}`)
  }

  #turnEnd(segment) {
    const reasoning = String(segment.reasoningContent ?? '').trim()
    if (reasoning) {
      if (this.verbose) {
        /**
         * Labelled, and set apart from the answer.
         *
         * Dumped as a bare grey paragraph it read as part of the reply — the
         * model's private working and its actual answer ran together with
         * nothing between them saying which was which. The desktop draws a
         * titled card for exactly this reason; a rule and a heading are the
         * terminal's version of the same boundary.
         */
        this.#line()
        this.#line(c.gray(`  ${g.hline.repeat(3)} reasoning ${g.hline.repeat(3)}`))
        this.#line(c.gray(wrapText(reasoning, 2)))
        this.#line(c.gray(`  ${g.hline.repeat(3 + 11 + 3)}`))
      } else {
        /**
         * A clean feed still SAYS there was reasoning, and how to read it.
         *
         * It used to print `thought for ${Date.now() - this.startedAt}` — the
         * age of this renderer object, which for a live turn is the turn's
         * wall time (fair) and for a REPLAYED one is however long the loop
         * took to reach that message. Every stored transcript therefore
         * claimed "thought for 0ms", which is not a rounding error, it is a
         * different quantity. Replay reports the size it can actually measure
         * and points at the switch that shows it.
         */
        const words = reasoning.split(/\s+/).filter(Boolean).length
        this.#line(
          c.gray(
            this.replay
              ? `  ${icon.dot()} reasoned ${words} word${words === 1 ? '' : 's'} — ${this.showTools} to read it`
              : `  ${icon.dot()} thought for ${formatDuration(Date.now() - this.startedAt)}`
          )
        )
      }
    }
    if (segment.stopReason === 'canceled') {
      this.#line(c.yellow('  stopped'))
    }
    this.#flushProse()
    if (!this.atLineStart) out()
    this.atLineStart = true
  }

  /** Turn-level events (token counts, errors) — verbose only, except errors. */
  turnEvent(type, payload) {
    if (type === 'turn.usage' && this.verbose) {
      const inTok = payload?.inputTokens ?? payload?.promptTokens
      const outTok = payload?.outputTokens ?? payload?.completionTokens
      if (inTok || outTok) {
        this.#line(c.gray(`  ${inTok ?? '?'} in · ${outTok ?? '?'} out`))
      }
      return
    }
    if (type === 'safety.blocked') {
      this.#line(`${icon.gate()} ${c.yellow(`blocked: ${payload?.tool ?? 'tool'}`)}`)
    }
  }

  error(message) {
    this.#line(`${icon.fail()} ${c.red(message)}`)
  }

  /** Reset per-turn state; delivered files persist for /open in the session. */
  endTurn() {
    this.#flushProse()
    this.startedAt = Date.now()
    this.toolNames.clear()
    this.toolStartedAt.clear()
    this.taskState.clear()
    this.countdownState.clear()
    this.waitState.clear()
    this.workflowState.clear()
    this.deliveredThisTurn.clear()
    this.sawProse = false
  }
}

/** Human durations: sub-second in ms, then seconds, then m/s. */
export function formatDuration(ms) {
  const value = Number(ms)
  if (!Number.isFinite(value) || value < 0) return '—'
  if (value < 1000) return `${Math.round(value)}ms`
  if (value < 60_000) return `${(value / 1000).toFixed(1)}s`
  const minutes = Math.floor(value / 60_000)
  const seconds = Math.round((value % 60_000) / 1000)
  return `${minutes}m ${seconds}s`
}

export function basename(p) {
  const cleaned = String(p).replace(/[/\\]+$/, '')
  const cut = Math.max(cleaned.lastIndexOf('/'), cleaned.lastIndexOf('\\'))
  return cut >= 0 ? cleaned.slice(cut + 1) : cleaned
}

/** Render a stored conversation message — used by `wolffish show`. */
export function renderStoredMessage(message, { verbose = false, showTools = '--tools' } = {}) {
  if (message.role === 'user') {
    out()
    out(c.blue('› ') + c.bold(message.content || ''))
    for (const attachment of message.attachments ?? []) {
      out(c.gray(`  ${icon.file()} ${attachment.originalName} ${bytes(attachment.sizeBytes)}`))
    }
    return
  }
  out()
  const renderer = new TurnRenderer({ verbose, replay: true, showTools })
  if (message.segments?.length) {
    for (const segment of message.segments) renderer.segment(segment)
    renderer.endTurn()
    if (!message.segments.some((s) => s.kind === 'text') && message.content) {
      out(renderMarkdown(message.content))
    }
  } else if (message.content) {
    out(renderMarkdown(message.content))
  }
  out()
}
