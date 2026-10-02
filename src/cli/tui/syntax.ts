/**
 * Syntax styles for markdown, code and diffs, derived from the theme.
 * Created once per theme; the previous one is destroyed only after the
 * renderer goes idle, so a frame still drawing with it is never torn.
 */
import { SyntaxStyle, type CliRenderer } from '@opentui/core'
import { createMemo } from 'solid-js'
import { theme, type Palette } from './theme'

function build(p: Palette): SyntaxStyle {
  const hexOf = (c: Palette[keyof Palette]) => c as unknown as string
  const accent = hexOf(p.accent)
  return SyntaxStyle.fromStyles({
    default: { fg: p.text },
    'markup.heading': { fg: p.accent, bold: true },
    'markup.heading.1': { fg: p.accent, bold: true },
    'markup.heading.2': { fg: p.accent, bold: true },
    'markup.heading.3': { fg: p.text, bold: true },
    'markup.strong': { fg: p.text, bold: true },
    'markup.italic': { fg: p.text, italic: true },
    'markup.strikethrough': { fg: p.muted },
    'markup.raw': { fg: p.warn },
    'markup.raw.block': { fg: p.text },
    'markup.link': { fg: p.accent, underline: true },
    'markup.link.url': { fg: p.accent, underline: true },
    'markup.link.label': { fg: p.accent },
    'markup.list': { fg: p.accent },
    'markup.list.checked': { fg: p.good },
    'markup.list.unchecked': { fg: p.muted },
    'markup.quote': { fg: p.muted, italic: true },
    'punctuation.special': { fg: p.dim },
    'punctuation.delimiter': { fg: p.muted },
    'punctuation.bracket': { fg: p.muted },
    conceal: { fg: p.dim },
    keyword: { fg: p.accent },
    'keyword.function': { fg: p.accent },
    'keyword.return': { fg: p.accent },
    'keyword.import': { fg: p.accent },
    'keyword.operator': { fg: p.muted },
    string: { fg: p.good },
    'string.escape': { fg: p.warn },
    number: { fg: p.warn },
    constant: { fg: p.warn },
    'constant.builtin': { fg: p.warn },
    boolean: { fg: p.warn },
    comment: { fg: p.dim, italic: true },
    'comment.documentation': { fg: p.dim, italic: true },
    function: { fg: p.text, bold: true },
    'function.call': { fg: p.text },
    'function.method': { fg: p.text, bold: true },
    'function.builtin': { fg: p.accent },
    type: { fg: p.warn },
    'type.builtin': { fg: p.warn },
    variable: { fg: p.text },
    'variable.builtin': { fg: p.accent },
    'variable.parameter': { fg: p.text, italic: true },
    'variable.member': { fg: p.text },
    property: { fg: p.text },
    operator: { fg: p.muted },
    attribute: { fg: p.warn },
    module: { fg: p.text },
    label: { fg: p.accent },
    constructor: { fg: p.warn },
    diff_add: { fg: p.good },
    diff_remove: { fg: p.bad }
  })
  void accent
}

/** A memo of the live syntax style; old styles are retired after idle. */
export function createSyntaxStyle(renderer: CliRenderer) {
  let previous: SyntaxStyle | null = null
  return createMemo(() => {
    const next = build(theme())
    const old = previous
    previous = next
    if (old) void renderer.idle().then(() => old.destroy())
    return next
  })
}
