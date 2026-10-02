/**
 * Number-format presentation.
 *
 * SheetJS already renders the format code to text (its `w` field) and its `SSF`
 * module is exported by the bundled Community build, so the formatting itself is
 * not ours to reimplement. What SSF does *not* hand back is the colour a format
 * code asks for — `[Red]` in `#,##0.00;[Red](#,##0.00)` is stripped from the
 * output — so we read that off the format string ourselves.
 */

import * as XLSX from 'xlsx'
import { DEFAULT_INDEXED_COLORS } from './colors'
import type { CellType } from './types'

/** Excel's named format colours. */
const FORMAT_COLORS: Record<string, string> = {
  black: '#000000',
  blue: '#0000FF',
  cyan: '#00FFFF',
  green: '#008000',
  magenta: '#FF00FF',
  red: '#FF0000',
  white: '#FFFFFF',
  yellow: '#FFFF00'
}

/**
 * Split a format code on the section separator, ignoring `;` inside quoted
 * literals and square-bracket directives.
 */
function splitSections(code: string): string[] {
  const out: string[] = []
  let current = ''
  let inQuote = false
  let inBracket = false
  for (let i = 0; i < code.length; i++) {
    const ch = code[i]
    if (ch === '"') inQuote = !inQuote
    else if (!inQuote && ch === '[') inBracket = true
    else if (!inQuote && ch === ']') inBracket = false
    else if (ch === '\\') {
      current += ch + (code[++i] ?? '')
      continue
    }
    if (ch === ';' && !inQuote && !inBracket) {
      out.push(current)
      current = ''
      continue
    }
    current += ch
  }
  out.push(current)
  return out
}

/**
 * The colour a format code asks for, for a given value, or null.
 *
 * Sections are positive; negative; zero; text — with the usual Excel fallbacks
 * when fewer than four are present.
 */
export function formatColor(code: string | null, value: unknown): string | null {
  if (!code) return null
  const sections = splitSections(code)
  if (sections.length === 0) return null

  let section: string
  if (typeof value === 'number') {
    if (value < 0) section = sections[1] ?? sections[0]
    else if (value === 0) section = sections[2] ?? sections[0]
    else section = sections[0]
  } else {
    section = sections[3] ?? sections[0]
  }

  const match = section.match(/\[([A-Za-z]+)(?:\s*(\d+))?\]/g)
  if (!match) return null
  for (const raw of match) {
    const inner = raw.slice(1, -1).trim().toLowerCase()
    if (FORMAT_COLORS[inner]) return FORMAT_COLORS[inner]
    const indexed = inner.match(/^color\s*(\d+)$/)
    if (indexed) {
      // [Color n] indexes the legacy indexed palette, 1-based — NOT the eight
      // named colours above. [Color 3] is that palette's red, not whatever
      // happens to sit third in FORMAT_COLORS.
      const i = Number(indexed[1]) - 1
      const hex = i >= 0 ? DEFAULT_INDEXED_COLORS[i] : undefined
      if (hex) return '#' + hex
    }
  }
  return null
}

/**
 * Display text for a cell. Prefers SheetJS's already-formatted `w`; falls back
 * to formatting the raw value with the format code we read from styles.xml.
 */
export function displayText(
  formatted: string | undefined,
  raw: unknown,
  numFmt: string | null
): string {
  if (formatted != null && formatted !== '') return formatted
  if (raw == null) return ''
  if (numFmt && typeof raw === 'number') {
    try {
      return XLSX.SSF.format(numFmt, raw)
    } catch {
      // Malformed format code — show the underlying value rather than nothing.
    }
  }
  return String(raw)
}

/**
 * Excel renders a number that cannot fit its column as a run of `#`. Text does
 * not do this — it spills into empty neighbours or clips instead.
 */
export function overflowsAsHashes(type: CellType, text: string, capacityChars: number): boolean {
  if (type !== 'n' && type !== 'd') return false
  if (capacityChars <= 0) return false
  return text.length > capacityChars
}

export function hashes(capacityChars: number): string {
  return '#'.repeat(Math.max(1, Math.min(capacityChars, 40)))
}
