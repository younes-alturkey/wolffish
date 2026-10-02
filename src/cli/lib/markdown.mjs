/**
 * Markdown → ANSI, for a stream that arrives one token at a time.
 *
 * The model writes the SAME markdown for every surface — there is no `cli`
 * entry in CHANNEL_PROMPTS, deliberately — so a conversation reads identically
 * whether it started in the app, on the phone or here. This module is the
 * terminal's `react-markdown`: same source bytes, a different renderer. It
 * changes nothing about what is stored, sent, or seen anywhere else.
 *
 * ── Why line-buffered ──────────────────────────────────────────────────────
 * Markdown cannot be rendered a character at a time. `**` is ambiguous until
 * its partner arrives; a fence opens hundreds of tokens before it closes; a
 * table's column widths are unknown until its last row. So deltas accumulate
 * and a LINE is the unit of output — the natural one, since every block
 * construct in markdown is line-shaped and inline spans virtually always close
 * within the line that opened them.
 *
 * Text therefore lands per line rather than per token. That is the one
 * behavioural cost, and it is confined to this client.
 *
 * ── What is deliberately not rendered ──────────────────────────────────────
 * Images print their alt text and path rather than trying to draw (send_file
 * is how a file actually reaches the user). Raw HTML passes through unchanged
 * — the model rarely emits it outside a fence, and guessing at it is worse
 * than showing it. Setext headings (`===` under text) are treated as a rule
 * instead, because distinguishing them needs a line of lookahead that would
 * delay every line by one; models write ATX (`#`) essentially always.
 */
import { c, colorOn, g, visibleLength, width } from './ui.mjs'

/**
 * Marks a line that wants a blank line above it. Emitted as one only when the
 * previous line was not already blank — markdown puts a blank line before a
 * heading anyway, and prefixing unconditionally produced two.
 */
const HEADING = '\u0001'

/**
 * A streaming renderer. Feed it deltas; it writes complete rendered lines.
 * `flush()` at end of turn renders whatever partial line is left and closes
 * any block still open.
 */
export function createMarkdownStream({ write, columns } = {}) {
  const emit = write ?? ((text) => process.stdout.write(text))
  const cols = () => columns ?? width()

  let buffer = '' // the not-yet-newline-terminated tail
  let inFence = false
  let fenceMarker = ''
  let fenceLang = ''
  let tableRows = [] // buffered until the table ends — widths need every row
  let lastWasBlank = false

  const flushTable = () => {
    if (tableRows.length === 0) return
    for (const line of renderTable(tableRows, cols())) emit(line + '\n')
    tableRows = []
  }

  const line = (text) => {
    // A table is the one multi-line construct that cannot render row by row:
    // column widths depend on rows not yet seen.
    //
    // `!inFence` is load-bearing. Pipe-delimited lines are ordinary inside a
    // code block — a markdown table quoted as an example, an ASCII diagram,
    // `printf '| %s |'` — and without this they were pulled out of the fence
    // and re-drawn as a real table, so the code the agent was showing you was
    // not the code you saw.
    if (!inFence && (isTableRow(text) || (tableRows.length > 0 && isTableDivider(text)))) {
      tableRows.push(text)
      return
    }
    flushTable()

    const rendered = renderLine(text, {
      inFence,
      fenceMarker,
      fenceLang,
      cols: cols(),
      onFenceOpen: (marker, lang) => {
        inFence = true
        fenceMarker = marker
        fenceLang = lang
      },
      onFenceClose: () => {
        inFence = false
        fenceMarker = ''
        fenceLang = ''
      }
    })
    if (rendered === null) return // consumed (a fence delimiter)
    // Collapse runs of blank lines — a terminal has no margins, so markdown's
    // double newlines between blocks read as holes.
    if (rendered.startsWith(HEADING)) {
      const body = rendered.slice(HEADING.length)
      if (!lastWasBlank) emit('\n')
      emit(body + '\n')
      lastWasBlank = false
      return
    }
    const blank = rendered.trim().length === 0
    if (blank && lastWasBlank) return
    lastWasBlank = blank
    emit(rendered + '\n')
  }

  return {
    push(delta) {
      if (typeof delta !== 'string' || delta.length === 0) return
      buffer += delta
      let index = buffer.indexOf('\n')
      while (index >= 0) {
        line(buffer.slice(0, index))
        buffer = buffer.slice(index + 1)
        index = buffer.indexOf('\n')
      }
    },
    /** True while a partial line is held — the caller uses it to place newlines. */
    get pending() {
      return buffer.length > 0 || tableRows.length > 0
    },
    flush() {
      if (buffer.length > 0) {
        const tail = buffer
        buffer = ''
        line(tail)
      }
      flushTable()
      inFence = false
      lastWasBlank = false
    }
  }
}

/** One-shot render of a complete markdown string. Used by `wolffish show`. */
export function renderMarkdown(text, { columns } = {}) {
  const parts = []
  const stream = createMarkdownStream({ write: (chunk) => parts.push(chunk), columns })
  stream.push(String(text ?? ''))
  stream.flush()
  return parts.join('').replace(/\n$/, '')
}

// ─── block level ────────────────────────────────────────────────────────────

function renderLine(raw, ctx) {
  const fence = /^(\s*)(`{3,}|~{3,})(.*)$/.exec(raw)

  if (ctx.inFence) {
    // Inside a fence only the matching marker closes it, and everything else
    // is literal — no inline parsing, or code containing `*` would be mangled.
    if (fence && fence[2].startsWith(ctx.fenceMarker[0]) && fence[2].length >= 3) {
      ctx.onFenceClose()
      return c.gray('  ' + g.boxBottom + g.hline.repeat(Math.min(40, Math.max(4, ctx.cols - 6))))
    }
    return c.gray('  ' + g.boxSide + ' ') + raw
  }

  if (fence) {
    const lang = fence[3].trim().split(/\s+/)[0] ?? ''
    ctx.onFenceOpen(fence[2], lang)
    const label = lang ? ` ${lang} ` : ''
    const rule = g.hline.repeat(Math.max(4, Math.min(40, ctx.cols - 6) - visibleLength(label)))
    return c.gray('  ' + g.boxTop + rule + label)
  }

  const text = raw.replace(/\s+$/, '')
  if (text.trim().length === 0) return ''

  // Horizontal rule — checked before lists so `***` is not read as a bullet.
  if (/^\s{0,3}([-*_])\s*(\1\s*){2,}$/.test(text)) {
    return c.gray('  ' + g.hline.repeat(Math.max(8, Math.min(48, ctx.cols - 4))))
  }

  // Blockquote, possibly nested. Rendered as a coloured bar rather than `>`,
  // and recursive so a quoted list or heading still formats.
  const quote = /^(\s*)((?:>\s?)+)(.*)$/.exec(text)
  if (quote) {
    const depth = (quote[2].match(/>/g) ?? []).length
    // The recursive render indents its own output; a quote supplies the
    // indent itself via the bar, so the inner copy is stripped.
    const inner = (renderLine(quote[3], { ...ctx, cols: ctx.cols - depth * 2 }) ?? '').replace(
      /^\n? {2}/,
      ''
    )
    return c.gray('  ' + g.quote.repeat(depth) + ' ') + c.dim(inner)
  }

  // ATX heading.
  const heading = /^(\s{0,3})(#{1,6})\s+(.*?)\s*#*\s*$/.exec(text)
  if (heading) {
    const level = heading[2].length
    const body = inline(heading[3])
    if (level === 1) return HEADING + '  ' + c.bold(c.cyan(body.toUpperCase()))
    if (level === 2) return HEADING + '  ' + c.bold(c.cyan(body))
    return HEADING + '  ' + c.bold(body)
  }

  // Task list — checked before the plain bullet so the box replaces the dot.
  const task = /^(\s*)([-*+])\s+\[([ xX])\]\s+(.*)$/.exec(text)
  if (task) {
    const indent = Math.floor(task[1].length / 2)
    const done = task[3].toLowerCase() === 'x'
    const box = done ? c.green('[x]') : c.gray('[ ]')
    const body = inline(task[4])
    return '  ' + '  '.repeat(indent) + box + ' ' + (done ? c.dim(body) : body)
  }

  // Unordered list. Nesting depth comes from leading whitespace, two spaces
  // per level (markdown's own convention and what every model emits).
  const bullet = /^(\s*)([-*+])\s+(.*)$/.exec(text)
  if (bullet) {
    const depth = Math.floor(bullet[1].length / 2)
    const glyph = g.bullet[Math.min(depth, g.bullet.length - 1)]
    return wrapBody('  ' + '  '.repeat(depth) + c.cyan(glyph) + ' ', inline(bullet[3]), ctx.cols)
  }

  // Ordered list — the author's own numbering is kept, not renumbered.
  const ordered = /^(\s*)(\d{1,9})[.)]\s+(.*)$/.exec(text)
  if (ordered) {
    const depth = Math.floor(ordered[1].length / 2)
    return wrapBody(
      '  ' + '  '.repeat(depth) + c.cyan(`${ordered[2]}.`) + ' ',
      inline(ordered[3]),
      ctx.cols
    )
  }

  // Indented code (4 spaces), only when it is not a list continuation.
  if (/^ {4,}\S/.test(raw) && !/^\s*([-*+]|\d+[.)])\s/.test(raw.trim())) {
    return c.gray('  ' + g.boxSide + ' ') + raw.replace(/^ {4}/, '')
  }

  return wrapBody('  ', inline(text.replace(/^\s+/, '')), ctx.cols)
}

/** Hanging-indent wrap: continuation lines align under the first character. */
function wrapBody(prefix, body, cols) {
  const limit = Math.max(24, cols - visibleLength(prefix) - 2)
  if (visibleLength(body) <= limit) return prefix + body
  const pad = ' '.repeat(visibleLength(prefix))
  const lines = []
  let current = ''
  // Split on spaces OUTSIDE escape sequences — visibleLength already ignores
  // them, and words never contain one.
  for (const word of body.split(' ')) {
    if (current.length === 0) current = word
    else if (visibleLength(current) + 1 + visibleLength(word) <= limit) current += ' ' + word
    else {
      lines.push(current)
      current = word
    }
  }
  if (current) lines.push(current)
  return lines.map((l, i) => (i === 0 ? prefix + l : pad + l)).join('\n')
}

// ─── tables ─────────────────────────────────────────────────────────────────

function isTableRow(text) {
  return /^\s*\|.*\|\s*$/.test(text)
}

function isTableDivider(text) {
  return /^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(text) && text.includes('-')
}

function splitRow(text) {
  return text
    .trim()
    .replace(/^\||\|$/g, '')
    .split('|')
    .map((cell) => cell.trim())
}

/**
 * Align on the widest cell per column, and honour the alignment row's colons.
 * Overflowing columns are truncated rather than wrapped: a wrapped table cell
 * loses the grid, which is the only reason to use a table.
 */
function renderTable(rows, cols) {
  const dividerIndex = rows.findIndex(isTableDivider)
  const align = dividerIndex >= 0 ? splitRow(rows[dividerIndex]).map(alignOf) : []
  const body = rows.filter((_, i) => i !== dividerIndex).map(splitRow)
  if (body.length === 0) return []

  const count = Math.max(...body.map((r) => r.length))
  const widths = []
  for (let col = 0; col < count; col++) {
    widths.push(Math.max(...body.map((r) => visibleLength(inline(r[col] ?? '')))))
  }
  // Shrink to fit: 2 leading + 3 between columns.
  const budget = cols - 2 - (count - 1) * 3
  let total = widths.reduce((a, b) => a + b, 0)
  while (total > budget) {
    const widest = widths.indexOf(Math.max(...widths))
    if (widths[widest] <= 6) break
    widths[widest] -= 1
    total -= 1
  }

  const out = []
  body.forEach((row, index) => {
    const cells = widths.map((w, col) => {
      const rendered = clip(inline(row[col] ?? ''), w)
      const gap = w - visibleLength(rendered)
      if (gap <= 0) return rendered
      if (align[col] === 'right') return ' '.repeat(gap) + rendered
      if (align[col] === 'center') {
        const left = Math.floor(gap / 2)
        return ' '.repeat(left) + rendered + ' '.repeat(gap - left)
      }
      return rendered + ' '.repeat(gap)
    })
    // The header gets a rule under it; without one a table is just columns.
    const text = '  ' + cells.join(c.gray('   '))
    out.push(index === 0 && dividerIndex >= 0 ? c.bold(text) : text)
    if (index === 0 && dividerIndex >= 0) {
      out.push('  ' + c.gray(widths.map((w) => g.hline.repeat(w)).join(g.hline.repeat(3))))
    }
  })
  return out
}

function alignOf(cell) {
  const left = cell.startsWith(':')
  const right = cell.endsWith(':')
  if (left && right) return 'center'
  if (right) return 'right'
  return 'left'
}

function clip(text, max) {
  if (visibleLength(text) <= max) return text
  // Walk the string keeping escapes intact so a truncation never severs one.
  let visible = 0
  let out = ''
  let i = 0
  while (i < text.length && visible < max - 1) {
    if (text[i] === '\x1b') {
      const end = text.indexOf('m', i)
      if (end === -1) break
      out += text.slice(i, end + 1)
      i = end + 1
      continue
    }
    out += text[i]
    visible++
    i++
  }
  // The reset closes any colour this clipped through. With colour OFF there is
  // nothing open and the escape is not styling — it is four literal bytes in a
  // piped file, which is exactly what --no-color exists to prevent.
  return out + (g.hline === '-' ? '..' : '\u2026') + (colorOn() ? '\x1b[0m' : '')
}

// ─── inline ─────────────────────────────────────────────────────────────────

/**
 * Inline spans, in precedence order. Code spans come FIRST and their contents
 * are never re-parsed — `` `**not bold**` `` has to survive verbatim, which is
 * the whole point of a code span.
 */
export function inline(text) {
  if (typeof text !== 'string' || text.length === 0) return ''

  // Split on code spans (double backticks first, so `` ` `` can be quoted).
  const parts = []
  const codeRe = /(``[^`]+``|`[^`]+`)/g
  let last = 0
  let match
  while ((match = codeRe.exec(text)) !== null) {
    if (match.index > last) parts.push({ code: false, text: text.slice(last, match.index) })
    const body = match[0].replace(/^``?|``?$/g, '')
    parts.push({ code: true, text: body })
    last = match.index + match[0].length
  }
  if (last < text.length) parts.push({ code: false, text: text.slice(last) })

  return parts.map((part) => (part.code ? c.cyan(part.text) : emphasis(part.text))).join('')
}

/** Placeholder for an escaped character, held while the emphasis rules run. */
const ESC = '\u0000'

function emphasis(text) {
  // Escapes are masked BEFORE any rule sees them, not unescaped after. Doing
  // it last let `\*not italic\*` match the italic rule — a backslash is a
  // valid non-word neighbour — and the marker was consumed before the escape
  // could say it should not have been.
  const escaped = []
  let out = text.replace(/\\([\\`*_{}[\]()#+\-.!>~|])/g, (_m, char) => {
    escaped.push(char)
    return ESC
  })

  // Images before links — the syntaxes differ only by the leading `!`.
  out = out.replace(/!\[([^\]]*)\]\(([^)\s]+)[^)]*\)/g, (_m, alt, src) =>
    alt ? `${c.magenta(g.image + ' ' + alt)} ${c.gray(src)}` : c.gray(`${g.image} ${src}`)
  )
  out = out.replace(/\[([^\]]+)\]\(([^)\s]+)[^)]*\)/g, (_m, label, href) =>
    label === href ? c.blue(href) : `${c.blue(label)} ${c.gray(href)}`
  )
  // Autolinks and bare URLs.
  out = out.replace(/<((?:https?|mailto):[^>\s]+)>/g, (_m, url) => c.blue(url))
  out = out.replace(/(^|[\s(])((?:https?:\/\/)[^\s)<>]+)/g, (_m, pre, url) => pre + c.blue(url))

  // Bold-italic, then bold, then italic — longest marker first, or `***x***`
  // would be eaten as bold followed by a stray asterisk.
  out = out.replace(/\*\*\*([^*]+)\*\*\*/g, (_m, body) => c.bold(c.italic(body)))
  out = out.replace(/___([^_]+)___/g, (_m, body) => c.bold(c.italic(body)))
  out = out.replace(/\*\*([^*]+)\*\*/g, (_m, body) => c.bold(body))
  out = out.replace(/__([^_]+)__/g, (_m, body) => c.bold(body))
  // Single-marker italics require a non-word neighbour so snake_case names and
  // multiplication survive: `foo_bar_baz` and `2 * 3 * 4` are not emphasis.
  out = out.replace(
    /(^|[^\w*])\*([^*\s][^*]*)\*(?=[^\w*]|$)/g,
    (_m, pre, body) => pre + c.italic(body)
  )
  out = out.replace(
    /(^|[^\w_])_([^_\s][^_]*)_(?=[^\w_]|$)/g,
    (_m, pre, body) => pre + c.italic(body)
  )

  out = out.replace(/~~([^~]+)~~/g, (_m, body) => c.dim(body))

  let index = 0
  return out.replace(new RegExp(ESC, 'g'), () => escaped[index++] ?? '')
}
