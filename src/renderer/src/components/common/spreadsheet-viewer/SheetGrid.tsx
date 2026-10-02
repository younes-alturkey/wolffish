/**
 * Spreadsheet grid — the shared renderer behind the chat card and the workspace
 * viewer.
 *
 * Renders the document's own formatting (fills, fonts, borders, number formats)
 * inside app-themed chrome (row/column gutters, sheet tabs, value bar). Two rules
 * keep light and dark both honest:
 *
 *   - A cell the file painted keeps exactly the colours the file chose. The
 *     document owns that contrast decision, in either theme.
 *   - A cell with no fill sits on the app's surface — dark in dark mode — so ink
 *     that would be illegible there falls back to the theme foreground. That is
 *     the difference between a readable dark-mode sheet and a black-on-black one.
 *
 * Direction comes from the sheet (`rightToLeft`), not the UI locale: an Arabic UI
 * must not flip a Western workbook's columns.
 */

import { cn } from '@lib/utils/cn'
import { resolveInk } from '@lib/spreadsheet/colors'
import { hashes, overflowsAsHashes } from '@lib/spreadsheet/format'
import { colCharCapacity, fontStack, maxDigitWidth } from '@lib/spreadsheet/metrics'
import {
  cellKey,
  type CellStyle,
  type SheetCell,
  type SheetModel,
  type WorkbookModel
} from '@lib/spreadsheet/types'
import { useTheme } from '@providers/theme/useTheme'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

const HEADER_H = 22
const GUTTER_W = 46
/**
 * Sticky layers, from the back forward. Every pair that can slide over another
 * has a strict order here — a tie lets DOM order decide, which puts ordinary
 * rows on top of the frozen ones they scroll beneath.
 *   10 frozen column cells and ordinary row numbers
 *   20 frozen row cells
 *   30 the corner where a frozen row meets a frozen column, and frozen row numbers
 *   40 the column-letter header, which is above everything
 */
const Z_FROZEN_COL = 10
const Z_FROZEN_ROW = 20
const Z_FROZEN_BOTH = 30
const Z_HEADER = 40
const MIN_ROW_H = 18
/** Above this many body rows the grid windows instead of rendering everything. */
const WINDOW_THRESHOLD = 240
const OVERSCAN = 12
/** How far a long label may spill, in columns. Excel is unbounded; this is sane. */
const MAX_SPILL = 12

/** App surface colours the ink guard measures against — mirrors main.css tokens. */
const SURFACE = { light: '#FFFFFF', dark: '#161B22' }
const THEME_FG = { light: '#0D1117', dark: '#FFFFFF' }

function columnLabel(index: number): string {
  let n = index
  let label = ''
  do {
    label = String.fromCharCode(65 + (n % 26)) + label
    n = Math.floor(n / 26) - 1
  } while (n >= 0)
  return label
}

/** OOXML border style → CSS shorthand. */
function borderCss(style: string, color: string | null, fallback: string): string {
  const c = color || fallback
  switch (style) {
    case 'hair':
    case 'thin':
      return `1px solid ${c}`
    case 'dotted':
    case 'mediumDotted':
      return `1px dotted ${c}`
    case 'dashed':
    case 'dashDot':
    case 'dashDotDot':
    case 'slantDashDot':
      return `1px dashed ${c}`
    case 'mediumDashed':
    case 'mediumDashDot':
    case 'mediumDashDotDot':
      return `2px dashed ${c}`
    case 'medium':
      return `2px solid ${c}`
    case 'thick':
      return `3px solid ${c}`
    case 'double':
      return `3px double ${c}`
    default:
      return `1px solid ${c}`
  }
}

/** Excel's implicit alignment when the file says nothing: text left, numbers right. */
function defaultAlign(type: SheetCell['type']): 'left' | 'right' | 'center' {
  if (type === 'n' || type === 'd') return 'right'
  if (type === 'b' || type === 'e') return 'center'
  return 'left'
}

function verticalAlign(v: string | null | undefined): 'top' | 'middle' | 'bottom' {
  // OOXML spells the middle one 'center'.
  if (v === 'top') return 'top'
  if (v === 'center' || v === 'middle' || v === 'justify' || v === 'distributed') return 'middle'
  return 'bottom'
}

// ---------------------------------------------------------------------------

export type SheetGridProps = {
  workbook: WorkbookModel
  /** `card` is a bounded preview in the chat feed; `page` fills the workspace viewer. */
  variant: 'card' | 'page'
  className?: string
}

export function SheetGrid({ workbook, variant, className }: SheetGridProps): React.JSX.Element {
  const { t } = useTranslation()
  const { isDark } = useTheme()
  const [active, setActive] = useState(0)
  const [selected, setSelected] = useState<string | null>(null)

  const index = Math.min(active, Math.max(0, workbook.sheets.length - 1))
  const sheet = workbook.sheets[index]

  // An address from another sheet means nothing in the value bar, so switching
  // tabs clears it — in the handler rather than an effect, so there is no
  // second render pass.
  const selectSheet = useCallback((i: number) => {
    setActive(i)
    setSelected(null)
  }, [])

  const surface = isDark ? SURFACE.dark : SURFACE.light
  const themeFg = isDark ? THEME_FG.dark : THEME_FG.light
  const selectedCell = selected && sheet ? (sheet.cells.get(selected) ?? null) : null

  if (!sheet || sheet.rows === 0) {
    return (
      <div
        className={cn('text-muted flex h-40 items-center justify-center text-xs italic', className)}
      >
        {t('chat.spreadsheetViewer.empty')}
      </div>
    )
  }

  const showStatus = !!selectedCell || sheet.clipped || workbook.tier !== 'full'

  return (
    // The page variant fills its parent; the card variant sizes to its content
    // and caps out at `max-h-90` inside GridBody. Owning that here keeps callers
    // from having to know the difference.
    <div className={cn('flex min-h-0 flex-col', variant === 'page' && 'flex-1', className)}>
      <GridBody
        sheet={sheet}
        variant={variant}
        surface={surface}
        themeFg={themeFg}
        selected={selected}
        onSelect={setSelected}
      />
      {showStatus && (
        <StatusBar
          cell={selectedCell}
          sheet={sheet}
          tier={workbook.tier}
          showValue={variant === 'page'}
        />
      )}
      {workbook.sheets.length > 1 && (
        <SheetTabs sheets={workbook.sheets} active={index} onSelect={selectSheet} />
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Grid body
// ---------------------------------------------------------------------------

type RenderCtx = {
  sheet: SheetModel
  surface: string
  themeFg: string
  selected: string | null
  onSelect: (key: string | null) => void
  freezeX: number
  frozenColLefts: number[]
  covered: Set<string>
  gridline: string
}

function GridBody({
  sheet,
  variant,
  surface,
  themeFg,
  selected,
  onSelect
}: {
  sheet: SheetModel
  variant: 'card' | 'page'
  surface: string
  themeFg: string
  selected: string | null
  onSelect: (key: string | null) => void
}): React.JSX.Element {
  const scrollRef = useRef<HTMLDivElement>(null)
  const [scrollTop, setScrollTop] = useState(0)
  const [viewportH, setViewportH] = useState(variant === 'card' ? 360 : 640)

  const freezeY = Math.min(sheet.freeze?.y ?? 0, sheet.rows)
  const freezeX = Math.min(sheet.freeze?.x ?? 0, sheet.cols)

  const rowHeights = useMemo(
    () => sheet.rowHeightsPx.map((h) => (h === 0 ? 0 : Math.max(h, MIN_ROW_H))),
    [sheet.rowHeightsPx]
  )

  /** Prefix sums over the scrolling (non-frozen) rows, for windowing. */
  const offsets = useMemo(() => {
    const out = new Array<number>(Math.max(1, sheet.rows - freezeY + 1))
    out[0] = 0
    for (let i = freezeY; i < sheet.rows; i++) {
      out[i - freezeY + 1] = out[i - freezeY] + (rowHeights[i] ?? 0)
    }
    return out
  }, [sheet.rows, freezeY, rowHeights])

  const bodyRows = Math.max(0, sheet.rows - freezeY)
  const windowed = bodyRows > WINDOW_THRESHOLD

  const { first, last } = useMemo(() => {
    if (!windowed) return { first: 0, last: bodyRows }
    const find = (target: number): number => {
      let lo = 0
      let hi = bodyRows
      while (lo < hi) {
        const mid = (lo + hi) >> 1
        if ((offsets[mid] ?? 0) < target) lo = mid + 1
        else hi = mid
      }
      return lo
    }
    return {
      first: Math.max(0, find(scrollTop) - OVERSCAN),
      last: Math.min(bodyRows, find(scrollTop + viewportH) + OVERSCAN)
    }
  }, [windowed, scrollTop, viewportH, offsets, bodyRows])

  const onScroll = useCallback(() => {
    const el = scrollRef.current
    if (el) setScrollTop(el.scrollTop)
  }, [])

  useEffect(() => {
    const el = scrollRef.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => setViewportH(el.clientHeight || 360))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  /** Inline-start inset of each frozen column, so sticky offsets stack. */
  const frozenColLefts = useMemo(() => {
    const out: number[] = []
    let x = GUTTER_W
    for (let c = 0; c < freezeX; c++) {
      out.push(x)
      x += sheet.colWidthsPx[c] ?? 0
    }
    return out
  }, [freezeX, sheet.colWidthsPx])

  const covered = useMemo(() => coveredCells(sheet), [sheet])

  const ctx: RenderCtx = {
    sheet,
    surface,
    themeFg,
    selected,
    onSelect,
    freezeX,
    frozenColLefts,
    covered,
    gridline: sheet.gridlines ? 'var(--color-border)' : 'transparent'
  }

  const frozenTops = useMemo(() => {
    const out: number[] = []
    let y = HEADER_H
    for (let r = 0; r < freezeY; r++) {
      out.push(y)
      y += rowHeights[r] ?? 0
    }
    return out
  }, [freezeY, rowHeights])

  const padTop = windowed ? (offsets[first] ?? 0) : 0
  const padBottom = windowed ? (offsets[bodyRows] ?? 0) - (offsets[last] ?? 0) : 0

  // The table must be exactly as wide as its declared columns. With
  // `width: max-content`, a single long unwrapped cell makes the table wider
  // than the sum of the colgroup, and `table-layout: fixed` then hands the
  // surplus to one column — a 238px column rendered 1227px wide.
  const totalWidth = useMemo(
    () => GUTTER_W + sheet.colWidthsPx.reduce((a, w) => a + w, 0),
    [sheet.colWidthsPx]
  )

  return (
    <div
      ref={scrollRef}
      onScroll={windowed ? onScroll : undefined}
      dir={sheet.rtl ? 'rtl' : 'ltr'}
      className={cn(
        'bg-surface relative min-h-0 overflow-auto',
        variant === 'card' ? 'max-h-90' : 'flex-1'
      )}
      style={{ scrollbarGutter: 'stable' }}
    >
      <table
        className="text-fg border-separate"
        style={{
          borderSpacing: 0,
          tableLayout: 'fixed',
          width: totalWidth,
          fontVariantNumeric: 'tabular-nums'
        }}
      >
        <colgroup>
          <col style={{ width: GUTTER_W }} />
          {sheet.colWidthsPx.map((w, i) => (
            <col key={i} style={{ width: w }} />
          ))}
        </colgroup>

        <thead>
          <ColumnHeader sheet={sheet} freezeX={freezeX} frozenColLefts={frozenColLefts} />
          {Array.from({ length: freezeY }, (_, r) => (
            <Row key={`frozen-${r}`} r={r} ctx={ctx} stickyTop={frozenTops[r]} />
          ))}
        </thead>

        <tbody>
          {padTop > 0 && (
            <tr aria-hidden="true">
              <td colSpan={sheet.cols + 1} style={{ height: padTop, padding: 0, border: 0 }} />
            </tr>
          )}
          {Array.from({ length: Math.max(0, last - first) }, (_, i) => (
            <Row key={freezeY + first + i} r={freezeY + first + i} ctx={ctx} />
          ))}
          {padBottom > 0 && (
            <tr aria-hidden="true">
              <td colSpan={sheet.cols + 1} style={{ height: padBottom, padding: 0, border: 0 }} />
            </tr>
          )}
        </tbody>
      </table>
    </div>
  )
}

/** Cells hidden underneath a merge anchor. */
function coveredCells(sheet: SheetModel): Set<string> {
  const out = new Set<string>()
  for (const m of sheet.merges) {
    for (let r = m.r1; r <= m.r2; r++) {
      for (let c = m.c1; c <= m.c2; c++) {
        if (r !== m.r1 || c !== m.c1) out.add(cellKey(r, c))
      }
    }
  }
  return out
}

function ColumnHeader({
  sheet,
  freezeX,
  frozenColLefts
}: {
  sheet: SheetModel
  freezeX: number
  frozenColLefts: number[]
}): React.JSX.Element {
  return (
    <tr>
      <th
        className="bg-bg border-border text-muted sticky border-b border-e"
        style={{
          top: 0,
          insetInlineStart: 0,
          height: HEADER_H,
          width: GUTTER_W,
          zIndex: Z_HEADER + 1
        }}
      />
      {Array.from({ length: sheet.cols }, (_, c) => (
        <th
          key={c}
          className="bg-bg border-border text-muted sticky border-b border-e text-[10px] font-medium"
          style={{
            top: 0,
            height: HEADER_H,
            zIndex: Z_HEADER,
            ...(c < freezeX ? { insetInlineStart: frozenColLefts[c] } : null)
          }}
        >
          {columnLabel(c)}
        </th>
      ))}
    </tr>
  )
}

function Row({
  r,
  ctx,
  stickyTop
}: {
  r: number
  ctx: RenderCtx
  stickyTop?: number
}): React.JSX.Element | null {
  const { sheet } = ctx
  const height = sheet.rowHeightsPx[r]
  if (height === 0) return null

  const cells: React.JSX.Element[] = []
  for (let c = 0; c < sheet.cols; c++) {
    if (ctx.covered.has(cellKey(r, c))) continue
    const { node, span } = renderCell(r, c, ctx, stickyTop)
    cells.push(node)
    if (span > 1) c += span - 1
  }

  return (
    <tr style={{ height: Math.max(height, MIN_ROW_H) }}>
      <th
        className="bg-bg border-border text-muted sticky border-b border-e text-center text-[10px] font-normal"
        style={{
          insetInlineStart: 0,
          width: GUTTER_W,
          zIndex: stickyTop != null ? Z_FROZEN_BOTH : Z_FROZEN_COL,
          ...(stickyTop != null ? { top: stickyTop } : null)
        }}
      >
        {r + 1}
      </th>
      {cells}
    </tr>
  )
}

/** The style in effect at a position: the cell's own, else its row's, else its column's. */
function styleAt(sheet: SheetModel, r: number, c: number): CellStyle | null {
  const cell = sheet.cells.get(cellKey(r, c))
  return cell?.style ?? sheet.rowStyles.get(r) ?? sheet.colStyles.get(c) ?? null
}

/**
 * Excel spills a long unwrapped label into the empty cells beside it. We use the
 * table's own `colSpan` rather than overflow tricks, so the spilled run has one
 * background — which matches Excel, because we only spill into neighbours that
 * are both empty and unfilled.
 */
function spillSpan(
  r: number,
  c: number,
  ctx: RenderCtx,
  capacity: number,
  textLength: number,
  mdw: number,
  ownFill: string | null
): number {
  const { sheet } = ctx
  let span = 1
  let room = capacity
  const limit = Math.min(sheet.cols, c + MAX_SPILL)
  for (let n = c + 1; n < limit && room < textLength; n++) {
    const key = cellKey(r, n)
    if (ctx.covered.has(key)) break
    // Excel stops a spill at the first neighbour that holds anything.
    const neighbour = sheet.cells.get(key)
    if (neighbour && neighbour.text !== '') break
    // A spill rendered with colSpan paints one background across the run, so it
    // is only faithful while the neighbour's background matches. Same fill (or
    // no fill on either side) spills; a different fill clips, as Excel would
    // when the neighbour is not empty.
    const nStyle = styleAt(sheet, r, n)
    const nFill = nStyle?.fill && nStyle.fill.pattern !== 'none' ? nStyle.fill.fg : null
    if (nFill !== ownFill) break
    // Never spill across the frozen-pane boundary — the two panes scroll apart.
    if (ctx.freezeX > 0 && c < ctx.freezeX && n >= ctx.freezeX) break
    room += colCharCapacity(sheet.colWidthsPx[n] ?? 0, mdw)
    span++
  }
  return span
}

function renderCell(
  r: number,
  c: number,
  ctx: RenderCtx,
  stickyTop?: number
): { node: React.JSX.Element; span: number } {
  const { sheet, surface, themeFg, gridline } = ctx
  const key = cellKey(r, c)
  const cell = sheet.cells.get(key)
  const style = styleAt(sheet, r, c)

  const merge = sheet.merges.find((m) => m.r1 === r && m.c1 === c)

  const fill = style?.fill && style.fill.pattern !== 'none' ? style.fill.fg : null
  const font = style?.font
  const ink = resolveInk(cell?.negRed ? '#FF0000' : (font?.color ?? null), fill, surface, themeFg)

  const align = style?.align
  const horizontal = align?.h && align.h !== 'general' ? align.h : defaultAlign(cell?.type ?? 'z')
  const wrap = !!align?.wrap

  const mdw = maxDigitWidth(font?.name ?? null, font?.size ?? 11)
  let width = sheet.colWidthsPx[c] ?? 0
  if (merge) for (let n = merge.c1 + 1; n <= merge.c2; n++) width += sheet.colWidthsPx[n] ?? 0
  const capacity = colCharCapacity(width, mdw)

  let text = cell?.text ?? ''
  let span = merge ? merge.c2 - merge.c1 + 1 : 1

  if (text && !wrap && !merge) {
    if (overflowsAsHashes(cell?.type ?? 'z', text, capacity)) {
      text = hashes(capacity)
    } else if (text.length > capacity && horizontal === 'left') {
      span = spillSpan(r, c, ctx, capacity, text.length, mdw, fill)
    }
  }

  // Manual border collapse. `border-separate` is required for sticky panes to
  // keep their borders while scrolling, so we suppress one side of every shared
  // edge ourselves: a cell owns its inline-end and bottom edges, and only draws
  // an inline-start/top edge when the file asked for one that the neighbour did
  // not already draw. Without this every internal gridline renders 2px.
  const nextStyle = styleAt(sheet, r, c + span)
  const belowStyle = styleAt(sheet, r + (merge ? merge.r2 - merge.r1 + 1 : 1), c)
  const prevStyle = c > 0 ? styleAt(sheet, r, c - 1) : null
  const aboveStyle = r > 0 ? styleAt(sheet, r - 1, c) : null

  const b = style?.border
  const edge = {
    top: b?.top
      ? borderCss(b.top.style, b.top.color, ink)
      : aboveStyle?.border?.bottom
        ? '0'
        : undefined,
    bottom: b?.bottom
      ? borderCss(b.bottom.style, b.bottom.color, ink)
      : belowStyle?.border?.top
        ? '0'
        : `1px solid ${gridline}`,
    start:
      b?.left && !prevStyle?.border?.right ? borderCss(b.left.style, b.left.color, ink) : undefined,
    end: b?.right
      ? borderCss(b.right.style, b.right.color, ink)
      : nextStyle?.border?.left
        ? '0'
        : `1px solid ${gridline}`
  }

  const isSelected = ctx.selected === key
  const isFrozenCol = c < ctx.freezeX
  const isFrozenRow = stickyTop != null
  // A frozen row pins on `top` alone, with no frozen column involved, so
  // stickiness has to follow either axis — not just the column.
  const isSticky = isFrozenCol || isFrozenRow
  const zIndex =
    isFrozenCol && isFrozenRow
      ? Z_FROZEN_BOTH
      : isFrozenRow
        ? Z_FROZEN_ROW
        : isFrozenCol
          ? Z_FROZEN_COL
          : undefined

  const node = (
    <td
      key={c}
      colSpan={span > 1 ? span : undefined}
      rowSpan={merge && merge.r2 > merge.r1 ? merge.r2 - merge.r1 + 1 : undefined}
      onClick={() => ctx.onSelect(isSelected ? null : key)}
      className={cn('overflow-hidden text-[11px] leading-tight', isSticky && 'sticky')}
      style={{
        // The document's colours where it set them; the app's surface shows
        // through where it did not, so dark mode stays dark.
        // A sticky cell has to be opaque or the rows sliding beneath it show
        // through; an ordinary cell stays transparent so the sheet surface reads
        // through in whichever theme is active.
        backgroundColor: fill ?? (isSticky ? surface : undefined),
        zIndex,
        color: ink,
        fontFamily: font?.name ? fontStack(font.name) : undefined,
        fontSize: font?.size ? `${font.size}pt` : undefined,
        fontWeight: font?.bold ? 600 : undefined,
        fontStyle: font?.italic ? 'italic' : undefined,
        textDecoration:
          [font?.underline ? 'underline' : '', font?.strike ? 'line-through' : '']
            .filter(Boolean)
            .join(' ') || undefined,
        textAlign: horizontal as React.CSSProperties['textAlign'],
        verticalAlign: verticalAlign(align?.v),
        whiteSpace: wrap ? 'pre-wrap' : 'nowrap',
        wordBreak: wrap ? 'break-word' : undefined,
        paddingInlineStart: 3 + (align?.indent ?? 0) * 8,
        paddingInlineEnd: 3,
        borderTop: edge.top,
        borderBottom: edge.bottom,
        borderInlineStart: edge.start,
        borderInlineEnd: edge.end,
        ...(isFrozenCol ? { insetInlineStart: ctx.frozenColLefts[c] } : null),
        ...(isFrozenRow ? { top: stickyTop } : null),
        ...(isSelected ? { outline: '2px solid var(--color-accent)', outlineOffset: -2 } : null)
      }}
      title={cell && cell.text !== text ? cell.text : undefined}
    >
      {cell?.link ? (
        <a
          href={cell.link}
          target="_blank"
          rel="noreferrer"
          className="underline decoration-1 underline-offset-2"
          style={{ color: 'inherit' }}
        >
          {text}
        </a>
      ) : (
        text
      )}
    </td>
  )

  return { node, span }
}

// ---------------------------------------------------------------------------
// Status bar + sheet tabs
// ---------------------------------------------------------------------------

function StatusBar({
  cell,
  sheet,
  tier,
  showValue
}: {
  cell: SheetCell | null
  sheet: SheetModel
  tier: WorkbookModel['tier']
  showValue: boolean
}): React.JSX.Element {
  const { t } = useTranslation()
  const value = cell?.formula ? `=${cell.formula}` : cell?.raw != null ? String(cell.raw) : ''

  return (
    <div className="border-border text-muted flex items-center gap-2 border-t px-3 py-1 text-[10px]">
      {cell && <span className="text-fg shrink-0 font-medium tabular-nums">{cell.a}</span>}
      {cell && showValue && value !== '' && (
        <span className="min-w-0 flex-1 truncate font-mono" title={value}>
          {value}
        </span>
      )}
      <span className="ms-auto flex shrink-0 items-center gap-3">
        {sheet.clipped && <span>{t('chat.spreadsheetViewer.clipped', { rows: sheet.rows })}</span>}
        {tier === 'values' && <span>{t('chat.spreadsheetViewer.tierValues')}</span>}
        {tier === 'plain' && <span>{t('chat.spreadsheetViewer.tierPlain')}</span>}
      </span>
    </div>
  )
}

function SheetTabs({
  sheets,
  active,
  onSelect
}: {
  sheets: SheetModel[]
  active: number
  onSelect: (i: number) => void
}): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <div
      className="border-border flex gap-1 overflow-x-auto border-t px-2 py-1"
      role="tablist"
      aria-label={t('chat.spreadsheetViewer.sheets')}
    >
      {sheets.map((s, i) => (
        <button
          key={`${s.name}-${i}`}
          type="button"
          role="tab"
          aria-selected={i === active}
          onClick={() => onSelect(i)}
          className={cn(
            'focus-visible:ring-accent shrink-0 rounded px-2 py-0.5 text-[11px] focus-visible:ring-2',
            i === active
              ? 'bg-primary/10 text-primary font-medium'
              : 'text-muted hover:text-fg cursor-pointer'
          )}
          // A tab colour picked for a white sheet can disappear on a dark strip,
          // so it reads as an underline rather than a fill.
          style={s.tabColor ? { boxShadow: `inset 0 -2px 0 ${s.tabColor}` } : undefined}
          title={s.name}
        >
          {s.name}
        </button>
      ))}
    </div>
  )
}
