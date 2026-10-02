/**
 * Spreadsheet style-reader tests.
 *
 * Two layers:
 *   1. Unit checks on the colour landmines — the ARGB alpha lie, the swapped
 *      SpreadsheetML theme indices, tint, the indexed palette, and the dark-mode
 *      contrast guard. These need no fixtures.
 *   2. A differential pass over real .xlsx files, comparing every styled cell
 *      against ExcelJS. This is the check that matters: the first version of
 *      this reader used regex over styles.xml, produced entirely plausible
 *      output, and was silently off by one. Only a second implementation caught
 *      it.
 *
 * Standalone — no vitest/jest in this repo. Run:
 *   TSX_TSCONFIG_PATH=tsconfig.node.json npx tsx \
 *     src/renderer/src/lib/spreadsheet/__tests__/styles.test.ts [fixture-dir]
 *
 * The differential layer is skipped unless BOTH are available:
 *   - `exceljs` and `@xmldom/xmldom` resolvable (dev-only, not shipped)
 *   - a directory of .xlsx fixtures (argv[2], or ./fixtures next to this file)
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  applyTint,
  contrastRatio,
  resolveColor,
  resolveInk,
  stripAlpha,
  DEFAULT_INDEXED_COLORS,
  type Palette
} from '../colors'
import { formatColor, overflowsAsHashes } from '../format'
import { colWidthToPx, fontStack, colCharCapacity } from '../metrics'
import { parseStyleTable, parseThemePalette, type XmlParser } from '../styles'

let failures = 0
let checks = 0

function ok(name: string, cond: boolean, extra?: unknown): void {
  checks++
  if (!cond) failures++
  if (!cond || process.env.VERBOSE) {
    console.log(
      `${cond ? 'PASS' : 'FAIL'}: ${name}${extra !== undefined ? ` — ${String(extra)}` : ''}`
    )
  }
}

function eq(name: string, actual: unknown, expected: unknown): void {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  ok(name, a === e, a === e ? undefined : `got ${a}, want ${e}`)
}

// ---------------------------------------------------------------------------
// 1. Colour resolution — the silent failures
// ---------------------------------------------------------------------------

const THEME_XML = `<?xml version="1.0"?>
<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
  <a:themeElements><a:clrScheme name="Office">
    <a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1>
    <a:lt1><a:sysClr val="window" lastClr="FFFFFF"/></a:lt1>
    <a:dk2><a:srgbClr val="1F497D"/></a:dk2>
    <a:lt2><a:srgbClr val="EEECE1"/></a:lt2>
    <a:accent1><a:srgbClr val="4F81BD"/></a:accent1>
    <a:accent2><a:srgbClr val="C0504D"/></a:accent2>
    <a:accent3><a:srgbClr val="9BBB59"/></a:accent3>
    <a:accent4><a:srgbClr val="8064A2"/></a:accent4>
    <a:accent5><a:srgbClr val="4BACC6"/></a:accent5>
    <a:accent6><a:srgbClr val="F79646"/></a:accent6>
    <a:hlink><a:srgbClr val="0000FF"/></a:hlink>
    <a:folHlink><a:srgbClr val="800080"/></a:folHlink>
  </a:clrScheme></a:themeElements>
</a:theme>`

async function makeParser(): Promise<XmlParser | null> {
  if (typeof DOMParser !== 'undefined') {
    return (xml) => new DOMParser().parseFromString(xml, 'application/xml')
  }
  try {
    const mod = (await import('@xmldom/xmldom')) as {
      DOMParser: new () => { parseFromString: (x: string, t: string) => unknown }
    }
    return (xml) => new mod.DOMParser().parseFromString(xml, 'text/xml') as Document
  } catch {
    return null
  }
}

let parseXml: XmlParser | null = null

function runColorTests(): void {
  console.log('\n── colour resolution ──')

  eq('stripAlpha drops the 8-digit alpha byte', stripAlpha('001F2A44'), '1F2A44')
  eq('stripAlpha leaves 6-digit values alone', stripAlpha('1f2a44'), '1F2A44')

  if (!parseXml) {
    console.log('SKIP: no XML parser available (install @xmldom/xmldom to run these)')
    return
  }

  const theme = parseThemePalette(THEME_XML, parseXml)
  // SpreadsheetML swaps the first two pairs relative to clrScheme document order.
  eq('theme[0] is lt1 (white)', theme[0], 'FFFFFF')
  eq('theme[1] is dk1 (black)', theme[1], '000000')
  eq('theme[2] is lt2', theme[2], 'EEECE1')
  eq('theme[3] is dk2', theme[3], '1F497D')
  eq('theme[4] is accent1', theme[4], '4F81BD')

  const palette: Palette = { theme, indexed: DEFAULT_INDEXED_COLORS }

  // The single most consequential mapping: body text is theme="1" in every
  // Excel-authored file. Resolve it to lt1 and the sheet renders white on white.
  eq('theme="1" resolves dark, not light', resolveColor({ theme: '1' }, palette), '#000000')
  eq(
    'openpyxl 00RRGGBB is opaque, not transparent',
    resolveColor({ rgb: '001F2A44' }, palette),
    '#1F2A44'
  )
  eq('indexed 2 is red', resolveColor({ indexed: '2' }, palette), '#FF0000')
  eq('indexed 64 (system fg) defers to the reader', resolveColor({ indexed: '64' }, palette), null)
  eq('auto="1" defers to the reader', resolveColor({ rgb: 'FF0000', auto: '1' }, palette), null)
  eq('no attributes resolves to nothing', resolveColor({}, palette), null)

  // Tint: positive blends toward white, negative scales toward black.
  eq('tint 0 is identity', applyTint('4F81BD', 0), '4F81BD')
  eq('tint +1 is white', applyTint('4F81BD', 1), 'FFFFFF')
  eq('tint -1 is black', applyTint('4F81BD', -1), '000000')
  ok('tint +0.4 lightens', Number.parseInt(applyTint('1F497D', 0.4).slice(0, 2), 16) > 0x1f)
  eq(
    'theme+tint compose',
    resolveColor({ theme: '3', tint: '0.4' }, palette),
    '#' + applyTint('1F497D', 0.4)
  )
}

// ---------------------------------------------------------------------------
// 2. The cellXfs off-by-one that regex caused
// ---------------------------------------------------------------------------

const STYLES_XML = `<?xml version="1.0"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <numFmts count="1"><numFmt numFmtId="164" formatCode="#,##0.00;[Red](#,##0.00)"/></numFmts>
  <fonts count="3">
    <font><name val="Calibri"/><color theme="1"/><sz val="11"/></font>
    <font><name val="Arial"/><b val="1"/><color rgb="001F2A44"/><sz val="11"/></font>
    <font><name val="Arial"/><i val="1"/><color rgb="00555555"/><sz val="9"/><u/></font>
  </fonts>
  <fills count="3">
    <fill><patternFill patternType="none"/></fill>
    <fill><patternFill patternType="gray125"/></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="00F2C14E"/></patternFill></fill>
  </fills>
  <borders count="2">
    <border><left/><right/><top/><bottom/></border>
    <border><left style="thin"><color rgb="00BFC7D5"/></left><right style="thin"><color rgb="00BFC7D5"/></right><top/><bottom style="medium"><color rgb="00000000"/></bottom></border>
  </borders>
  <cellXfs count="4">
    <xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
    <xf numFmtId="0" fontId="1" fillId="2" borderId="0" applyAlignment="1" xfId="0"><alignment vertical="top" wrapText="1"/></xf>
    <xf numFmtId="164" fontId="2" fillId="0" borderId="1" applyAlignment="1" xfId="0"><alignment horizontal="right" indent="2"/></xf>
    <xf numFmtId="9" fontId="1" fillId="0" borderId="0" xfId="0"/>
  </cellXfs>
</styleSheet>`

function runStyleTableTests(): void {
  console.log('\n── style table ──')
  if (!parseXml) {
    console.log('SKIP: no XML parser available')
    return
  }

  const table = parseStyleTable(STYLES_XML, THEME_XML, parseXml)

  // The regression: a self-closing <xf …/> followed by an <xf>…</xf> must stay
  // two entries. Merged, every index after it shifts and the output still looks
  // completely plausible.
  eq('cellXfs entries are not merged', table.size, 4)

  const s0 = table.resolve(0)
  eq('xf0 font is the normal font', s0?.font?.name, 'Calibri')
  eq('xf0 resolves theme="1" to black', s0?.font?.color, '#000000')
  eq('xf0 has no fill', s0?.fill?.pattern, 'none')
  eq('xf0 numFmt General is normalised to null', s0?.numFmt, null)

  const s1 = table.resolve(1)
  eq('xf1 is bold', s1?.font?.bold, true)
  eq('xf1 font colour drops the alpha byte', s1?.font?.color, '#1F2A44')
  eq('xf1 fill is the solid amber', s1?.fill?.fg, '#F2C14E')
  eq('xf1 wrap', s1?.align?.wrap, true)
  eq('xf1 vertical alignment', s1?.align?.v, 'top')

  const s2 = table.resolve(2)
  eq('xf2 is italic', s2?.font?.italic, true)
  eq('xf2 is underlined', s2?.font?.underline, 'single')
  eq('xf2 size', s2?.font?.size, 9)
  eq('xf2 custom numFmt', s2?.numFmt, '#,##0.00;[Red](#,##0.00)')
  eq('xf2 left border', s2?.border?.left?.style, 'thin')
  eq('xf2 bottom border', s2?.border?.bottom?.style, 'medium')
  eq('xf2 border colour', s2?.border?.left?.color, '#BFC7D5')
  eq('xf2 empty top border is null, not a style', s2?.border?.top, null)
  eq('xf2 indent', s2?.align?.indent, 2)

  eq('xf3 resolves a builtin numFmt by id', table.resolve(3)?.numFmt, '0%')
  eq('out-of-range index falls back to xf0', table.resolve(99)?.font?.name, 'Calibri')
}

// ---------------------------------------------------------------------------
// 3. Presentation rules
// ---------------------------------------------------------------------------

function runPresentationTests(): void {
  console.log('\n── presentation ──')

  eq(
    '[Red] applies to the negative section',
    formatColor('#,##0.00;[Red](#,##0.00)', -5),
    '#FF0000'
  )
  eq('[Red] does not apply to positives', formatColor('#,##0.00;[Red](#,##0.00)', 5), null)
  eq('a single section applies to everything', formatColor('[Blue]0.00', 5), '#0000FF')
  eq('zero falls back to the positive section', formatColor('[Green]0;[Red]0', 0), '#008000')
  eq('a literal semicolon in quotes is not a separator', formatColor('"a;b"[Red]0', 1), '#FF0000')
  eq('no colour directive', formatColor('#,##0.00', -5), null)
  eq('no format code', formatColor(null, -5), null)

  // Excel's documented conversion. MDW 7 is Calibri 11 at 96 DPI; SheetJS
  // hardcodes 6, which is where the ~14% narrowing comes from.
  eq('width 44 at MDW 7', colWidthToPx(44, 7), 308)
  eq('width 44 at MDW 6 (the SheetJS bug)', colWidthToPx(44, 6), 264)
  eq('width 8.43 default at MDW 7', colWidthToPx(8.43, 7), 59)

  ok('numbers too wide become hashes', overflowsAsHashes('n', '1234567890', 5))
  ok('numbers that fit do not', !overflowsAsHashes('n', '123', 5))
  ok('text never becomes hashes — it spills', !overflowsAsHashes('s', 'a very long label', 5))
  eq('capacity accounts for cell padding', colCharCapacity(68, 7), 9)

  ok('Calibri substitutes through Carlito', fontStack('Calibri').includes('Carlito'))
  ok('Cambria substitutes through Caladea', fontStack('Cambria').includes('Caladea'))
  ok('Arial substitutes through Liberation Sans', fontStack('Arial').includes('Liberation Sans'))
  ok(
    'unknown faces are quoted and kept',
    fontStack('Wolffish Display').includes("'Wolffish Display'")
  )
  ok('a missing face still yields a stack', fontStack(null).length > 0)
}

// ---------------------------------------------------------------------------
// 4. Dark-mode ink guard
// ---------------------------------------------------------------------------

function runInkTests(): void {
  console.log('\n── dark-mode ink ──')

  const darkSurface = '#161B22'
  const darkFg = '#FFFFFF'
  const lightSurface = '#FFFFFF'
  const lightFg = '#0D1117'

  // A document that hard-codes black body text and paints no background would be
  // invisible on the app's dark surface, so that case defers to the theme.
  eq(
    'unfilled black text is lifted on a dark surface',
    resolveInk('#000000', null, darkSurface, darkFg),
    darkFg
  )
  eq(
    'unfilled black text is untouched on a light surface',
    resolveInk('#000000', null, lightSurface, lightFg),
    '#000000'
  )
  // When the file paints its own background it owns the contrast decision.
  eq(
    'black text on the document own fill is honoured verbatim',
    resolveInk('#000000', '#1F4E79', darkSurface, darkFg),
    '#000000'
  )
  eq(
    'a cell with no colour at all uses the theme foreground',
    resolveInk(null, null, darkSurface, darkFg),
    darkFg
  )
  eq(
    'legible unfilled colour is kept in dark mode',
    resolveInk('#F2C14E', null, darkSurface, darkFg),
    '#F2C14E'
  )
  // A banded row the file painted pale but left the ink to the reader must stay
  // dark in BOTH themes — the theme foreground would put white on pale blue.
  eq(
    'uncoloured text on a pale fill is black in dark mode',
    resolveInk(null, '#EDF3F9', darkSurface, darkFg),
    '#000000'
  )
  eq(
    'uncoloured text on a pale fill is black in light mode',
    resolveInk(null, '#EDF3F9', lightSurface, lightFg),
    '#000000'
  )
  eq(
    'uncoloured text on a dark fill is white in light mode',
    resolveInk(null, '#1F4E79', lightSurface, lightFg),
    '#FFFFFF'
  )
  ok(
    'contrast of black on white is maximal',
    Math.round(contrastRatio('#000000', '#FFFFFF')) === 21
  )
}

// ---------------------------------------------------------------------------
// 5. Differential pass against ExcelJS
// ---------------------------------------------------------------------------

type AnyRec = Record<string, unknown>

function normalizeColor(c: AnyRec | undefined | null): string | null {
  if (!c) return null
  const argb = (c.argb ?? c.rgb) as string | undefined
  if (!argb) return c.theme != null ? `theme:${c.theme}` : null
  return '#' + (argb.length === 8 ? argb.slice(2) : argb).toUpperCase()
}

/** ExcelJS renames the OOXML value; the parser keeps the spec spelling. */
function normalizeVAlign(v: unknown): unknown {
  return v === 'middle' ? 'center' : v
}

async function runDifferential(dir: string): Promise<void> {
  console.log('\n── differential vs ExcelJS ──')

  if (!parseXml) {
    console.log('SKIP: no XML parser available')
    return
  }

  let ExcelJS: AnyRec
  try {
    const mod = (await import('exceljs')) as AnyRec
    ExcelJS = (mod.default as AnyRec) ?? mod
  } catch {
    console.log('SKIP: exceljs not installed (npm i -D exceljs @xmldom/xmldom to enable)')
    return
  }

  if (!fs.existsSync(dir)) {
    console.log(`SKIP: no fixture directory at ${dir}`)
    return
  }
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.toLowerCase().endsWith('.xlsx') && !f.startsWith('~'))
    .map((f) => path.join(dir, f))
  if (!files.length) {
    console.log(`SKIP: no .xlsx fixtures in ${dir}`)
    return
  }

  // Imported lazily so the unit layer still runs where jszip/xlsx cannot load.
  const { readWorkbook } = await import('../workbook')

  let compared = 0
  let mismatched = 0
  const kinds: Record<string, number> = {}

  for (const file of files) {
    const buf = fs.readFileSync(file)
    const model = await readWorkbook(
      buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer,
      path.basename(file),
      { parseXml }
    )

    const Workbook = (ExcelJS as AnyRec).Workbook as new () => AnyRec
    const wb = new Workbook()
    await (wb.xlsx as AnyRec & { load: (b: Buffer) => Promise<void> }).load(buf)

    for (const sheet of model.sheets) {
      const ws = (wb as AnyRec & { getWorksheet: (n: string) => AnyRec | undefined }).getWorksheet(
        sheet.name
      )
      if (!ws) continue

      for (const cell of sheet.cells.values()) {
        if (!cell.style) continue
        const ref = (ws as AnyRec & { getCell: (a: string) => AnyRec }).getCell(cell.a)
        compared++

        const bad: string[] = []
        const font = (ref.font ?? {}) as AnyRec
        const fill = (ref.fill ?? {}) as AnyRec
        const border = (ref.border ?? {}) as AnyRec
        const align = (ref.alignment ?? {}) as AnyRec

        if (!!cell.style.font?.bold !== !!font.bold) bad.push('bold')
        if (!!cell.style.font?.italic !== !!font.italic) bad.push('italic')
        if ((cell.style.font?.size ?? 11) !== ((font.size as number) ?? 11)) bad.push('size')
        if ((cell.style.font?.name ?? null) !== ((font.name as string) ?? null)) bad.push('name')

        const refFontColor = normalizeColor(font.color as AnyRec)
        if (
          refFontColor &&
          !refFontColor.startsWith('theme:') &&
          cell.style.font?.color !== refFontColor
        ) {
          bad.push(`fontColor(${cell.style.font?.color} vs ${refFontColor})`)
        }

        const refFill = fill.pattern === 'solid' ? normalizeColor(fill.fgColor as AnyRec) : null
        const ourFill = cell.style.fill?.pattern === 'solid' ? cell.style.fill.fg : null
        if (refFill && !refFill.startsWith('theme:') && ourFill !== refFill) {
          bad.push(`fill(${ourFill} vs ${refFill})`)
        }

        for (const side of ['top', 'right', 'bottom', 'left'] as const) {
          const refSide = ((border[side] ?? {}) as AnyRec).style ?? null
          const ourSide = cell.style.border?.[side]?.style ?? null
          if (refSide !== ourSide) bad.push(`border.${side}(${ourSide} vs ${refSide})`)
        }

        if ((align.horizontal ?? null) !== (cell.style.align?.h ?? null)) bad.push('alignH')
        if (normalizeVAlign(align.vertical ?? null) !== (cell.style.align?.v ?? null))
          bad.push('alignV')
        if (!!align.wrapText !== !!cell.style.align?.wrap) bad.push('wrap')

        const refFmt = (ref.numFmt as string | undefined) ?? null
        if (refFmt && refFmt !== 'General' && refFmt !== (cell.style.numFmt ?? null)) {
          bad.push(`numFmt(${cell.style.numFmt} vs ${refFmt})`)
        }

        if (bad.length) {
          mismatched++
          for (const b of bad) {
            const k = b.split('(')[0]
            kinds[k] = (kinds[k] ?? 0) + 1
          }
          if (mismatched <= 10) {
            console.log(
              `  MISMATCH ${path.basename(file)} ${sheet.name}!${cell.a}: ${bad.join(', ')}`
            )
          }
        }
      }
    }
  }

  console.log(`  ${files.length} workbooks · ${compared} styled cells · ${mismatched} mismatched`)
  if (mismatched) console.log(`  by kind: ${JSON.stringify(kinds)}`)
  ok(`differential: every styled cell matches ExcelJS (${compared} compared)`, mismatched === 0)
  ok('differential corpus is non-empty', compared > 0, compared)
}

// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  parseXml = await makeParser()

  runColorTests()
  runStyleTableTests()
  runPresentationTests()
  runInkTests()

  const here = path.dirname(fileURLToPath(import.meta.url))
  await runDifferential(process.argv[2] ?? path.join(here, 'fixtures'))

  console.log(`\n${failures ? 'FAILED' : 'OK'} — ${checks - failures}/${checks} checks passed`)
  if (failures) process.exit(1)
}

void main()
