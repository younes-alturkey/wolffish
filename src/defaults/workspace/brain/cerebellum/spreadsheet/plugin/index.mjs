import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import ExcelJS from 'exceljs'
import Papa from 'papaparse'
import FormulaParserModule from 'fast-formula-parser'
import AdmZip from 'adm-zip'

const FormulaParser = FormulaParserModule.default ?? FormulaParserModule


const toolDefinitions = [
  {
    name: 'spreadsheet_read',
    description: 'Read any spreadsheet file (xlsx, csv, tsv) and return structured JSON data.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute path to the spreadsheet file' },
        sheet: { type: 'string', description: 'Sheet name or 1-based index (for xlsx)' },
        range: { type: 'string', description: 'Excel-style range like "A1:D50"' },
        headers: { type: 'string', description: '"true" or "false" for first row as headers' }
      },
      required: ['path']
    }
  },
  {
    name: 'spreadsheet_create',
    description: 'Create a new spreadsheet file with columns, rows, and styles.',
    parameters: {
      type: 'object',
      properties: {
        output_path: { type: 'string', description: 'Absolute path for output (extension sets format)' },
        sheets: { type: 'string', description: 'JSON array of sheet definitions' }
      },
      required: ['output_path', 'sheets']
    }
  },
  {
    name: 'spreadsheet_modify',
    description: 'Edit an existing spreadsheet — add/remove sheets, insert/delete rows/columns, update cells.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute path to source spreadsheet' },
        output_path: { type: 'string', description: 'Absolute path for output' },
        operations: { type: 'string', description: 'JSON array of operations' }
      },
      required: ['path', 'output_path', 'operations']
    }
  },
  {
    name: 'spreadsheet_formula',
    description: 'Add or set formulas in spreadsheet cells.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute path to source spreadsheet' },
        output_path: { type: 'string', description: 'Absolute path for output' },
        formulas: { type: 'string', description: 'JSON array of formula operations' }
      },
      required: ['path', 'output_path', 'formulas']
    }
  },
  {
    name: 'spreadsheet_chart',
    description: 'Add a chart to a spreadsheet.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute path to source spreadsheet' },
        output_path: { type: 'string', description: 'Absolute path for output' },
        chart: { type: 'string', description: 'JSON chart definition' }
      },
      required: ['path', 'output_path', 'chart']
    }
  },
  {
    name: 'spreadsheet_style',
    description: 'Apply formatting — borders, colors, fonts, merge cells, freeze panes.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute path to source spreadsheet' },
        output_path: { type: 'string', description: 'Absolute path for output' },
        styles: { type: 'string', description: 'JSON array of style operations' }
      },
      required: ['path', 'output_path', 'styles']
    }
  },
  {
    name: 'spreadsheet_convert',
    description: 'Convert between spreadsheet formats (xlsx, csv, tsv).',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute path to source file' },
        output_path: { type: 'string', description: 'Absolute path for output (extension sets format)' },
        options: { type: 'string', description: 'Optional JSON: {delimiter?, encoding?, sheet?}' }
      },
      required: ['path', 'output_path']
    }
  },
  {
    name: 'spreadsheet_analyze',
    description: 'Quick data analysis — summary stats, types, duplicates, blanks.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute path to spreadsheet' },
        sheet: { type: 'string', description: 'Sheet name or index' },
        columns: { type: 'string', description: 'Optional JSON array of column names to analyze' }
      },
      required: ['path']
    }
  },
  {
    name: 'spreadsheet_filter',
    description: 'Filter and sort rows by criteria.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute path to spreadsheet' },
        output_path: { type: 'string', description: 'Optional output file path' },
        filters: { type: 'string', description: 'JSON array of filter operations' },
        sort: { type: 'string', description: 'Optional JSON array of sort operations' },
        limit: { type: 'number', description: 'Maximum rows to return' }
      },
      required: ['path', 'filters']
    }
  },
  {
    name: 'spreadsheet_pivot',
    description: 'Create a pivot table from spreadsheet data.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute path to source spreadsheet' },
        output_path: { type: 'string', description: 'Absolute path for output' },
        rows: { type: 'string', description: 'JSON array of row grouping columns' },
        columns: { type: 'string', description: 'JSON array of column grouping columns' },
        values: { type: 'string', description: 'JSON array of value aggregations' }
      },
      required: ['path', 'output_path', 'rows', 'columns', 'values']
    }
  }
]

// ── Formulas ──────────────────────────────────────────────────────────────
// ExcelJS writes a formula as <f>SUM(B2:B3)</f> with no <v> cached value.
// Excel recalculates on open, but nothing else does: this tool's own reader,
// pandas, Numbers, Quick Look and every previewer see an empty cell — which
// means a formula we wrote cannot be read back, checked, or aggregated over.
// So every write path recalculates first and stores the value alongside the
// formula. A formula we cannot evaluate is still written (Excel will compute
// it) but reported by name, never silently left blank.

// ── Reading a workbook that contains charts ───────────────────────────────
// ExcelJS cannot parse the drawing parts other tools write: reading an
// openpyxl- or Excel-authored workbook with a chart in it throws
// "Cannot read properties of undefined (reading 'anchors')" — an error that
// names neither the cause nor a way forward, on a file that is perfectly
// valid. Found by a real run against a delivered model.
//
// Reading is recoverable: strip the drawing parts into a scratch copy and read
// that, so the user still gets their data. Writing is not — saving the stripped
// copy would drop the charts for real — so a write refuses and says why.

const CHART_PART = /^xl\/(charts|drawings)\//

async function readWorkbookFile(filePath, options = {}) {
  const workbook = new ExcelJS.Workbook()
  try {
    await workbook.xlsx.readFile(filePath)
    return { workbook, chartsIgnored: false }
  } catch (err) {
    const isDrawingFault = /anchors|drawing/i.test(String(err?.message ?? ''))
    if (!isDrawingFault) throw err

    const { default: AdmZipLib } = await import('adm-zip')
    const zip = new AdmZipLib(filePath)
    const chartParts = zip.getEntries().filter((e) => CHART_PART.test(e.entryName))
    if (!chartParts.length) throw err

    if (options.forWriting) {
      throw new Error(
        `this workbook contains ${chartParts.length} chart/drawing part(s) that the spreadsheet engine cannot parse, ` +
        'and writing it here would drop them. Read it with spreadsheet_read (which works), or do the edit with ' +
        'your python/shell tools so the charts survive.'
      )
    }

    // Scratch copy with the drawing parts and their references removed.
    for (const entry of chartParts) zip.deleteFile(entry.entryName)
    for (const entry of zip.getEntries()) {
      if (/^xl\/worksheets\/_rels\/.+\.rels$/.test(entry.entryName)) {
        const cleaned = zip.readAsText(entry).replace(/<Relationship\b[^>]*Type="[^"]*\/drawing"[^>]*\/>/g, '')
        zip.updateFile(entry, Buffer.from(cleaned, 'utf8'))
      } else if (/^xl\/worksheets\/sheet\d+\.xml$/.test(entry.entryName)) {
        const cleaned = zip.readAsText(entry).replace(/<drawing\b[^>]*\/>/g, '')
        zip.updateFile(entry, Buffer.from(cleaned, 'utf8'))
      }
    }
    const scratch = path.join(os.tmpdir(), `wolffish-nochart-${process.pid}-${Date.now()}.xlsx`)
    zip.writeZip(scratch)
    try {
      const stripped = new ExcelJS.Workbook()
      await stripped.xlsx.readFile(scratch)
      return { workbook: stripped, chartsIgnored: chartParts.length }
    } finally {
      await fs.rm(scratch, { force: true }).catch(() => {})
    }
  }
}

/** A string starting with "=" is a formula, not text. */
function coerceCellValue(value) {
  if (typeof value === 'string' && value.length > 1 && value.startsWith('=')) {
    return { formula: value.slice(1) }
  }
  return value
}

function isFormulaCell(cell) {
  const v = cell?.value
  return Boolean(v && typeof v === 'object' && typeof v.formula === 'string')
}

/** The plain value of a cell as a formula argument sees it. */
function rawCellValue(cell) {
  const v = cell?.value
  if (v == null) return null
  if (v instanceof Date) return v
  if (typeof v === 'object') {
    if (v.result !== undefined) return v.result
    if (v.richText) return v.richText.map((r) => r.text).join('')
    if (v.text !== undefined) return v.text
    return null
  }
  return v
}

/**
 * Compute and cache a value for every formula in the workbook. Runs a few
 * passes so a formula that depends on another formula resolves; stops as soon
 * as a pass changes nothing.
 */
function recalculate(workbook, options = {}) {
  const onlyMissing = Boolean(options.onlyMissing)
  const cells = []
  for (const ws of workbook.worksheets) {
    ws.eachRow({ includeEmpty: false }, (row, rowNumber) => {
      row.eachCell({ includeEmpty: false }, (cell, colNumber) => {
        if (!isFormulaCell(cell)) return
        // On a read, only fill cells the file left blank. A value already in
        // the file was computed by Excel or openpyxl and outranks this engine;
        // overwriting it turned a correct number into #VALUE! in a live run.
        if (onlyMissing && cell.value.result !== undefined) return
        cells.push({ ws, cell, row: rowNumber, col: colNumber, had: cell.value.result })
      })
    })
  }
  if (!cells.length) return { formulas: 0, evaluated: 0, unevaluated: [], errors: [] }

  const sheetByName = new Map(workbook.worksheets.map((ws) => [ws.name, ws]))
  const at = (sheetName, row, col) => {
    const ws = sheetByName.get(sheetName) ?? workbook.worksheets[0]
    if (!ws || row < 1 || col < 1) return null
    return rawCellValue(ws.getCell(row, col))
  }
  const parser = new FormulaParser({
    onCell: ({ sheet, row, col }) => at(sheet, row, col),
    onRange: (ref) => {
      const out = []
      for (let r = ref.from.row; r <= ref.to.row; r += 1) {
        const line = []
        for (let c = ref.from.col; c <= ref.to.col; c += 1) line.push(at(ref.sheet, r, c))
        out.push(line)
      }
      return out
    }
  })

  const unevaluated = []
  const errors = []
  const disagreements = []
  let pending = cells
  for (let pass = 0; pass < 5 && pending.length; pass += 1) {
    const stillPending = []
    let progressed = false
    for (const item of pending) {
      const formula = item.cell.value.formula
      let value
      try {
        value = parser.parse(formula, { sheet: item.ws.name, row: item.row, col: item.col })
      } catch (err) {
        // Unimplemented function, or a reference we cannot resolve. Keep it
        // for a later pass; if it never resolves it is reported by address.
        stillPending.push({ ...item, reason: err?.details?.message || err?.message || String(err) })
        continue
      }
      if (value && typeof value === 'object' && typeof value.error === 'string') {
        // Never downgrade a value the file already carried into an error: the
        // disagreement is more likely this engine's gap than a real fault.
        if (item.had !== undefined) {
          disagreements.push(`${item.ws.name}!${item.cell.address} (kept the file's own value)`)
          progressed = true
          continue
        }
        errors.push(`${item.ws.name}!${item.cell.address} = ${value.error}`)
        item.cell.value = { formula, result: { error: value.error } }
        progressed = true
        continue
      }
      if (value === null || value === undefined) {
        stillPending.push({ ...item, reason: 'evaluated to nothing' })
        continue
      }
      item.cell.value = { formula, result: value }
      progressed = true
    }
    pending = stillPending
    if (!progressed) break
  }
  for (const item of pending) {
    // A cell this engine cannot do but the file already answered is fine —
    // it keeps its value and is not worth reporting as a hole.
    if (item.had !== undefined) continue
    unevaluated.push(`${item.ws.name}!${item.cell.address} (${String(item.reason || 'could not evaluate').slice(0, 90)})`)
  }
  return { formulas: cells.length, evaluated: cells.length - pending.length, unevaluated, errors, disagreements }
}

/** The single write chokepoint: nothing reaches disk without recalculating. */
async function writeWorkbook(workbook, outputPath) {
  const report = recalculate(workbook)
  await workbook.xlsx.writeFile(outputPath)
  return report
}

/** A human line for a recalc report, or '' when there is nothing to say. */
function recalcNote(report) {
  if (!report || !report.formulas) return ''
  const lines = [`Recalculated ${report.evaluated}/${report.formulas} formulas and cached their values.`]
  if (report.errors.length) {
    lines.push(`${report.errors.length} formula error${report.errors.length === 1 ? '' : 's'} — fix these before sending the file:`)
    for (const e of report.errors.slice(0, 20)) lines.push(`  ${e}`)
    if (report.errors.length > 20) lines.push(`  ...and ${report.errors.length - 20} more`)
  }
  if (report.unevaluated.length) {
    lines.push(`${report.unevaluated.length} formula${report.unevaluated.length === 1 ? '' : 's'} could not be evaluated here, so ${report.unevaluated.length === 1 ? 'it has' : 'they have'} no cached value and will read back empty until Excel opens the file:`)
    for (const u of report.unevaluated.slice(0, 20)) lines.push(`  ${u}`)
    if (report.unevaluated.length > 20) lines.push(`  ...and ${report.unevaluated.length - 20} more`)
  }
  lines.push('A clean recalculation proves the formulas evaluate, not that they are right — read a few back and check the numbers are what you expect.')
  return lines.join('\n')
}

function parseJsonParam(value, name) {
  if (value == null) return undefined
  if (typeof value === 'object') return value
  if (typeof value === 'string') {
    try { return JSON.parse(value) } catch {
      throw new Error(`Invalid JSON in ${name} parameter`)
    }
  }
  throw new Error(`Expected object or JSON string for ${name}, got ${typeof value}`)
}

function resolvePath(input) {
  if (!input || typeof input !== 'string') throw new Error('path is required')
  if (input === '~') return os.homedir()
  if (input.startsWith('~/') || input.startsWith('~\\')) {
    return path.join(os.homedir(), input.slice(2))
  }
  return path.resolve(input)
}

/** Existence probe (throws ENOENT early with a clean message); never a size gate. */
async function checkFileSize(filePath) {
  const stat = await fs.stat(filePath)
  return stat.size
}

function getExt(filePath) {
  return path.extname(filePath).toLowerCase()
}

function colLetterToIndex(letter) {
  let idx = 0
  for (let i = 0; i < letter.length; i++) {
    idx = idx * 26 + (letter.charCodeAt(i) - 64)
  }
  return idx
}

function parseRange(rangeStr) {
  if (!rangeStr) return null
  const match = rangeStr.match(/^([A-Z]+)(\d+):([A-Z]+)(\d+)$/i)
  if (!match) return null
  return {
    startCol: colLetterToIndex(match[1].toUpperCase()),
    startRow: parseInt(match[2], 10),
    endCol: colLetterToIndex(match[3].toUpperCase()),
    endRow: parseInt(match[4], 10)
  }
}

function cellValue(cell) {
  if (!cell || cell.value === null || cell.value === undefined) return null
  const v = cell.value
  if (v instanceof Date) return v.toISOString()
  if (typeof v === 'object') {
    // An error result reads back as its Excel error string, and a formula we
    // could not evaluate reads back as the formula — both are far more use to
    // the reader than the JSON shape ExcelJS stores them in.
    if (v.result !== undefined) {
      return v.result && typeof v.result === 'object' && v.result.error ? v.result.error : v.result
    }
    if (v.error) return v.error
    if (typeof v.formula === 'string') return `=${v.formula}`
    if (typeof v.sharedFormula === 'string') return `=${v.sharedFormula}`
    if (v.text) return v.text
    if (v.richText) return v.richText.map((r) => r.text).join('')
    return JSON.stringify(v)
  }
  return v
}

async function readXlsx(filePath, sheetId, range, useHeaders) {
  await checkFileSize(filePath)
  const __wb = await readWorkbookFile(filePath, { forWriting: false })
  const workbook = __wb.workbook
  // A workbook written by another tool usually has no cached values. Compute
  // them in memory so read/analyze/filter/pivot see numbers; the file on disk
  // is never modified by a read.
  recalculate(workbook, { onlyMissing: true })

  let worksheet
  if (sheetId) {
    const idx = parseInt(sheetId, 10)
    if (!isNaN(idx)) {
      worksheet = workbook.worksheets[idx - 1]
    } else {
      worksheet = workbook.getWorksheet(sheetId)
    }
  }
  if (!worksheet) worksheet = workbook.worksheets[0]
  if (!worksheet) throw new Error('No worksheets found')

  const rangeSpec = parseRange(range)
  const rows = []
  worksheet.eachRow({ includeEmpty: false }, (row, rowNum) => {
    if (rangeSpec) {
      if (rowNum < rangeSpec.startRow || rowNum > rangeSpec.endRow) return
    }
    const values = []
    row.eachCell({ includeEmpty: true }, (cell, colNum) => {
      if (rangeSpec) {
        if (colNum < rangeSpec.startCol || colNum > rangeSpec.endCol) return
      }
      values[colNum - (rangeSpec ? rangeSpec.startCol : 1)] = cellValue(cell)
    })
    rows.push(values)
  })

  const headers = useHeaders !== false && rows.length > 0 ? rows[0] : null
  const data = headers ? rows.slice(1) : rows

  return {
    sheetName: worksheet.name,
    sheetCount: workbook.worksheets.length,
    sheets: workbook.worksheets.map((ws) => ws.name),
    headers,
    rows: data,
    rowCount: data.length,
    columnCount: headers ? headers.length : (data[0] ? data[0].length : 0)
  }
}

async function readCsvTsv(filePath, useHeaders, delimiter) {
  const buffer = await fs.readFile(filePath)
  let content = buffer.toString('utf8')

  // BOM detection
  if (content.charCodeAt(0) === 0xfeff) {
    content = content.slice(1)
  } else if (buffer[0] === 0xff && buffer[1] === 0xfe) {
    content = buffer.toString('utf16le').slice(1)
  }

  const ext = getExt(filePath)
  if (!delimiter) {
    delimiter = ext === '.tsv' ? '\t' : ','
  }

  const result = Papa.parse(content, {
    delimiter,
    header: useHeaders !== false,
    skipEmptyLines: true,
    dynamicTyping: true
  })

  if (result.errors.length > 0 && result.data.length === 0) {
    throw new Error(`Parse error: ${result.errors[0].message}`)
  }

  if (useHeaders !== false) {
    return {
      headers: result.meta.fields,
      rows: result.data,
      rowCount: result.data.length,
      columnCount: result.meta.fields?.length || 0
    }
  }

  return {
    headers: null,
    rows: result.data,
    rowCount: result.data.length,
    columnCount: result.data[0] ? result.data[0].length : 0
  }
}

async function spreadsheetRead(args) {
  const filePath = resolvePath(args.path)
  try {
    await checkFileSize(filePath)
  } catch (err) {
    return { success: false, error: err.message }
  }

  const ext = getExt(filePath)
  const useHeaders = args.headers === 'false' ? false : true

  try {
    let result
    if (ext === '.xlsx' || ext === '.xls') {
      result = await readXlsx(filePath, args.sheet, args.range, useHeaders)
    } else if (ext === '.csv' || ext === '.tsv') {
      result = await readCsvTsv(filePath, useHeaders)
    } else {
      return { success: false, error: `Unsupported format: ${ext}. Supported: .xlsx, .xls, .csv, .tsv` }
    }
    return { success: true, output: JSON.stringify(result, null, 2) }
  } catch (err) {
    if (err.code === 'ENOENT') return { success: false, error: `File not found: ${filePath}` }
    if (err.code === 'EBUSY' || err.code === 'EPERM') return { success: false, error: 'File is open in another application' }
    return { success: false, error: err.message }
  }
}

async function spreadsheetCreate(args) {
  const outputPath = resolvePath(args.output_path)
  let sheets
  try {
    sheets = parseJsonParam(args.sheets, 'sheets')
  } catch (err) {
    return { success: false, error: err.message }
  }

  const ext = getExt(outputPath)

  try {
    if (ext === '.csv' || ext === '.tsv') {
      const delimiter = ext === '.tsv' ? '\t' : ','
      const sheet = sheets[0]
      const headerRow = sheet.columns ? sheet.columns.map((c) => c.header || '') : []
      const allRows = headerRow.length > 0 ? [headerRow, ...sheet.rows] : sheet.rows
      const csv = Papa.unparse(allRows, { delimiter })
      await fs.mkdir(path.dirname(outputPath), { recursive: true })
      await fs.writeFile(outputPath, csv, 'utf8')
      return {
        success: true,
        output: JSON.stringify({ path: outputPath, rows: sheet.rows.length, format: ext.slice(1) })
      }
    }

    const workbook = new ExcelJS.Workbook()
    for (const sheetDef of sheets) {
      const ws = workbook.addWorksheet(sheetDef.name || 'Sheet1')

      if (sheetDef.columns) {
        ws.columns = sheetDef.columns.map((col) => ({
          header: col.header || '',
          key: col.header || '',
          width: col.width || 15
        }))
      }

      if (sheetDef.rows) {
        for (const row of sheetDef.rows) {
          ws.addRow(Array.isArray(row) ? row.map(coerceCellValue) : row)
        }
      }

      if (sheetDef.styles) {
        if (sheetDef.styles.headerBold !== false) {
          const headerRow = ws.getRow(1)
          headerRow.font = { bold: true }
        }
      }
    }

    await fs.mkdir(path.dirname(outputPath), { recursive: true })
    const recalc = await writeWorkbook(workbook, outputPath)

    const note = recalcNote(recalc)
    return {
      success: true,
      output: `${JSON.stringify({
        path: outputPath,
        sheets: sheets.map((s) => ({ name: s.name, rows: s.rows?.length || 0 })),
        format: 'xlsx'
      })}${note ? `\n\n${note}` : ''}`
    }
  } catch (err) {
    return { success: false, error: `Failed to create spreadsheet: ${err.message}` }
  }
}

async function spreadsheetModify(args) {
  const filePath = resolvePath(args.path)
  const outputPath = resolvePath(args.output_path)
  let operations
  try {
    operations = parseJsonParam(args.operations, 'operations')
  } catch (err) {
    return { success: false, error: err.message }
  }

  try {
    await checkFileSize(filePath)
    const __wb = await readWorkbookFile(filePath, { forWriting: true })
    const workbook = __wb.workbook

    for (const op of operations) {
      const ws = op.sheet ? workbook.getWorksheet(op.sheet) : workbook.worksheets[0]
      if (!ws && op.type !== 'add_sheet') {
        throw new Error(`Sheet not found: ${op.sheet || 'default'}`)
      }

      switch (op.type) {
        case 'add_sheet': {
          workbook.addWorksheet(op.name || 'New Sheet')
          break
        }
        case 'remove_sheet': {
          const target = workbook.getWorksheet(op.name || op.sheet)
          if (target) workbook.removeWorksheet(target.id)
          break
        }
        case 'rename_sheet': {
          if (ws) ws.name = op.new_name || op.name
          break
        }
        case 'insert_rows': {
          const rowNum = op.row || ws.rowCount + 1
          const rows = (op.rows || [[]]).map((r) => (Array.isArray(r) ? r.map(coerceCellValue) : r))
          ws.insertRows(rowNum, rows)
          break
        }
        case 'delete_rows': {
          const start = op.start || 1
          const count = op.count || 1
          ws.spliceRows(start, count)
          break
        }
        case 'insert_columns': {
          const colNum = op.column || ws.columnCount + 1
          ws.spliceColumns(colNum, 0, ...(op.values || [[]]))
          break
        }
        case 'delete_columns': {
          const colStart = op.column || 1
          const colCount = op.count || 1
          ws.spliceColumns(colStart, colCount)
          break
        }
        case 'set_cell': {
          const cell = ws.getCell(op.cell)
          cell.value = coerceCellValue(op.value)
          break
        }
        case 'set_range': {
          const startRow = op.start_row || 1
          const startCol = op.start_col || 1
          const values = op.values || []
          for (let r = 0; r < values.length; r++) {
            for (let c = 0; c < values[r].length; c++) {
              ws.getCell(startRow + r, startCol + c).value = coerceCellValue(values[r][c])
            }
          }
          break
        }
      }
    }

    await fs.mkdir(path.dirname(outputPath), { recursive: true })
    const recalc = await writeWorkbook(workbook, outputPath)

    const note = recalcNote(recalc)
    return {
      success: true,
      output: `${JSON.stringify({
        path: outputPath,
        operationsApplied: operations.length,
        sheets: workbook.worksheets.map((ws) => ws.name)
      })}${note ? `\n\n${note}` : ''}`
    }
  } catch (err) {
    if (err.code === 'ENOENT') return { success: false, error: `File not found: ${filePath}` }
    if (err.code === 'EBUSY' || err.code === 'EPERM') return { success: false, error: 'File is open in another application' }
    return { success: false, error: `Modify failed: ${err.message}` }
  }
}

async function spreadsheetFormula(args) {
  const filePath = resolvePath(args.path)
  const outputPath = resolvePath(args.output_path)
  let formulas
  try {
    formulas = parseJsonParam(args.formulas, 'formulas')
  } catch (err) {
    return { success: false, error: err.message }
  }

  try {
    await checkFileSize(filePath)
    const __wb = await readWorkbookFile(filePath, { forWriting: true })
    const workbook = __wb.workbook

    for (const f of formulas) {
      const ws = f.sheet ? workbook.getWorksheet(f.sheet) : workbook.worksheets[0]
      if (!ws) throw new Error(`Sheet not found: ${f.sheet || 'default'}`)
      const cell = ws.getCell(f.cell)
      cell.value = { formula: f.formula.startsWith('=') ? f.formula.slice(1) : f.formula }
    }

    await fs.mkdir(path.dirname(outputPath), { recursive: true })
    const recalc = await writeWorkbook(workbook, outputPath)

    const note = recalcNote(recalc)
    return {
      success: true,
      output: `${JSON.stringify({ path: outputPath, formulasSet: formulas.length })}${note ? `\n\n${note}` : ''}`
    }
  } catch (err) {
    return { success: false, error: `Formula operation failed: ${err.message}` }
  }
}

// ── Native charts ─────────────────────────────────────────────────────────
// ExcelJS has no chart API, so the chart parts are written into the packed
// file afterwards: a DrawingML chart, a drawing that anchors it to the sheet,
// the three relationship edges, and the content-type overrides. This is the
// same schema PowerPoint uses, so Excel, Numbers and LibreOffice all render it.
//
// The catch is worth stating loudly in the tool result: ExcelJS does not know
// about these parts, so ANY later call that round-trips the workbook through
// it — style, modify, formula, filter, pivot — rewrites the package and drops
// every chart. Charting is therefore the last step, never the middle one.

const CHART_KINDS = {
  bar: { tag: 'barChart', dir: 'col' },
  column: { tag: 'barChart', dir: 'col' },
  hbar: { tag: 'barChart', dir: 'bar' },
  line: { tag: 'lineChart' },
  area: { tag: 'areaChart' },
  pie: { tag: 'pieChart' },
  doughnut: { tag: 'doughnutChart' },
  scatter: { tag: 'scatterChart' }
}

const CHART_SERIES_COLORS = ['1D4ED8', '0F766E', 'B45309', '7E22CE', '15803D', '86174A']

function colIndexToLetter(index) {
  let n = index
  let out = ''
  while (n > 0) {
    const rem = (n - 1) % 26
    out = String.fromCharCode(65 + rem) + out
    n = Math.floor((n - 1) / 26)
  }
  return out
}

function xmlEscape(value) {
  return String(value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;')
}

/** Cached string/number points for one column of the source range. */
function cachePoints(values, numeric) {
  const pts = values.map((v, i) => {
    if (v === null || v === undefined || v === '') return ''
    const text = numeric ? Number(v) : xmlEscape(v)
    if (numeric && !Number.isFinite(Number(v))) return ''
    return `<c:pt idx="${i}"><c:v>${text}</c:v></c:pt>`
  }).join('')
  return `<c:ptCount val="${values.length}"/>${pts}`
}

function buildChartXml(def, data) {
  const kind = CHART_KINDS[String(def.type || 'bar').toLowerCase()]
  const isPie = kind.tag === 'pieChart' || kind.tag === 'doughnutChart'
  const sheetRef = `'${String(data.sheetName).replace(/'/g, "''")}'`
  const catRef = `${sheetRef}!$${data.catCol}$${data.firstRow}:$${data.catCol}$${data.lastRow}`

  const series = data.series.map((ser, i) => {
    const valRef = `${sheetRef}!$${ser.col}$${data.firstRow}:$${ser.col}$${data.lastRow}`
    const nameRef = `${sheetRef}!$${ser.col}$${data.headerRow}`
    const color = CHART_SERIES_COLORS[i % CHART_SERIES_COLORS.length]
    const shape = isPie
      ? data.categories.map((_, ci) => `<c:dPt><c:idx val="${ci}"/><c:bubble3D val="0"/><c:spPr><a:solidFill><a:srgbClr val="${CHART_SERIES_COLORS[ci % CHART_SERIES_COLORS.length]}"/></a:solidFill><a:ln w="19050"><a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill></a:ln></c:spPr></c:dPt>`).join('')
      : ''
    const spPr = kind.tag === 'lineChart'
      ? `<c:spPr><a:ln w="28575" cap="rnd"><a:solidFill><a:srgbClr val="${color}"/></a:solidFill><a:round/></a:ln></c:spPr><c:marker><c:symbol val="none"/></c:marker>`
      : isPie ? '' : `<c:spPr><a:solidFill><a:srgbClr val="${color}"/></a:solidFill></c:spPr>`
    return `<c:ser><c:idx val="${i}"/><c:order val="${i}"/>` +
      `<c:tx><c:strRef><c:f>${xmlEscape(nameRef)}</c:f><c:strCache><c:ptCount val="1"/><c:pt idx="0"><c:v>${xmlEscape(ser.name)}</c:v></c:pt></c:strCache></c:strRef></c:tx>` +
      spPr + shape +
      `<c:cat><c:strRef><c:f>${xmlEscape(catRef)}</c:f><c:strCache>${cachePoints(data.categories, false)}</c:strCache></c:strRef></c:cat>` +
      `<c:val><c:numRef><c:f>${xmlEscape(valRef)}</c:f><c:numCache><c:formatCode>General</c:formatCode>${cachePoints(ser.values, true)}</c:numCache></c:numRef></c:val>` +
      (kind.tag === 'lineChart' ? '<c:smooth val="0"/>' : '') +
      '</c:ser>'
  }).join('')

  const axIds = '<c:axId val="111111111"/><c:axId val="222222222"/>'
  const plot = isPie
    ? `<c:${kind.tag}><c:varyColors val="1"/>${series}${kind.tag === 'doughnutChart' ? '<c:firstSliceAng val="0"/><c:holeSize val="55"/>' : '<c:firstSliceAng val="0"/>'}</c:${kind.tag}>`
    : `<c:${kind.tag}>${kind.dir ? `<c:barDir val="${kind.dir}"/><c:grouping val="${def.stacked ? 'stacked' : 'clustered'}"/>` : '<c:grouping val="standard"/>'}<c:varyColors val="0"/>${series}${kind.dir ? `<c:gapWidth val="${def.stacked ? 60 : 90}"/>${def.stacked ? '<c:overlap val="100"/>' : '<c:overlap val="-20"/>'}` : ''}${axIds}</c:${kind.tag}>`

  const axes = isPie ? '' :
    `<c:catAx><c:axId val="111111111"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:delete val="0"/><c:axPos val="${kind.dir === 'bar' ? 'l' : 'b'}"/>` +
    (def.x_axis ? `<c:title><c:tx><c:rich><a:bodyPr/><a:p><a:r><a:t>${xmlEscape(def.x_axis)}</a:t></a:r></a:p></c:rich></c:tx><c:overlay val="0"/></c:title>` : '') +
    `<c:majorTickMark val="none"/><c:minorTickMark val="none"/><c:tickLblPos val="nextTo"/><c:spPr><a:ln><a:solidFill><a:srgbClr val="D5DAE0"/></a:solidFill></a:ln></c:spPr><c:crossAx val="222222222"/></c:catAx>` +
    `<c:valAx><c:axId val="222222222"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:delete val="0"/><c:axPos val="${kind.dir === 'bar' ? 'b' : 'l'}"/>` +
    `<c:majorGridlines><c:spPr><a:ln><a:solidFill><a:srgbClr val="E8ECF0"/></a:solidFill></a:ln></c:spPr></c:majorGridlines>` +
    (def.y_axis ? `<c:title><c:tx><c:rich><a:bodyPr/><a:p><a:r><a:t>${xmlEscape(def.y_axis)}</a:t></a:r></a:p></c:rich></c:tx><c:overlay val="0"/></c:title>` : '') +
    `<c:numFmt formatCode="General" sourceLinked="1"/><c:majorTickMark val="none"/><c:minorTickMark val="none"/><c:tickLblPos val="nextTo"/><c:spPr><a:ln><a:noFill/></a:ln></c:spPr><c:crossAx val="111111111"/></c:valAx>`

  const title = def.title
    ? `<c:title><c:tx><c:rich><a:bodyPr/><a:lstStyle/><a:p><a:pPr><a:defRPr sz="1200" b="1"/></a:pPr><a:r><a:rPr lang="en-US" sz="1200" b="1"/><a:t>${xmlEscape(def.title)}</a:t></a:r></a:p></c:rich></c:tx><c:overlay val="0"/></c:title><c:autoTitleDeleted val="0"/>`
    : '<c:autoTitleDeleted val="1"/>'
  const legend = (data.series.length > 1 || isPie)
    ? '<c:legend><c:legendPos val="b"/><c:overlay val="0"/></c:legend>'
    : ''

  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<c:chartSpace xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
    `<c:chart>${title}<c:plotArea><c:layout/>${plot}${axes}<c:spPr><a:noFill/><a:ln><a:noFill/></a:ln></c:spPr></c:plotArea>${legend}<c:plotVisOnly val="1"/><c:dispBlanksAs val="gap"/></c:chart>` +
    '<c:spPr><a:noFill/><a:ln><a:noFill/></a:ln></c:spPr></c:chartSpace>'
}

function buildDrawingXml(anchorCol, anchorRow, cols, rows, title) {
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
    '<xdr:twoCellAnchor>' +
    `<xdr:from><xdr:col>${anchorCol}</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>${anchorRow}</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from>` +
    `<xdr:to><xdr:col>${anchorCol + cols}</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>${anchorRow + rows}</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:to>` +
    '<xdr:graphicFrame macro=""><xdr:nvGraphicFramePr>' +
    `<xdr:cNvPr id="2" name="${xmlEscape(title || 'Chart 1')}"/><xdr:cNvGraphicFramePr/></xdr:nvGraphicFramePr>` +
    '<xdr:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/></xdr:xfrm>' +
    '<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart"><c:chart xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" r:id="rId1"/></a:graphicData></a:graphic>' +
    '</xdr:graphicFrame><xdr:clientData/></xdr:twoCellAnchor></xdr:wsDr>'
}

/** Highest existing index for a numbered part family, e.g. xl/charts/chartN.xml */
function nextPartIndex(zip, pattern) {
  let max = 0
  for (const e of zip.getEntries()) {
    const m = pattern.exec(e.entryName)
    if (m) max = Math.max(max, Number(m[1]))
  }
  return max + 1
}

async function spreadsheetChart(args) {
  const filePath = resolvePath(args.path)
  const outputPath = resolvePath(args.output_path)
  let chartDef
  try {
    chartDef = parseJsonParam(args.chart, 'chart')
  } catch (err) {
    return { success: false, error: err.message }
  }
  const kind = CHART_KINDS[String(chartDef.type || 'bar').toLowerCase()]
  if (!kind) {
    return { success: false, error: `Unknown chart type "${chartDef.type}" — use one of ${Object.keys(CHART_KINDS).join(', ')}` }
  }

  try {
    await checkFileSize(filePath)
    const __wb = await readWorkbookFile(filePath, { forWriting: true })
    const workbook = __wb.workbook
    const ws = chartDef.sheet ? workbook.getWorksheet(chartDef.sheet) : workbook.worksheets[0]
    if (!ws) throw new Error(`Sheet not found: ${chartDef.sheet || 'default'}`)

    // First column of the range is the categories, the rest are series, and
    // the first row names them. Stated here because a data_range alone is
    // ambiguous and a chart built on the wrong axis is a silent wrong answer.
    const range = parseRange(chartDef.data_range || '')
    if (!range) throw new Error('chart.data_range is required, in A1:D10 form')
    const { startRow, endRow, startCol, endCol } = range
    if (endCol <= startCol || endRow <= startRow) {
      throw new Error('chart.data_range needs at least two columns (categories + one series) and two rows (header + one value)')
    }
    const headerRow = startRow
    const firstRow = startRow + 1
    const lastRow = endRow
    const catCol = colIndexToLetter(startCol)
    const categories = []
    for (let r = firstRow; r <= lastRow; r += 1) categories.push(cellValue(ws.getCell(r, startCol)))
    const series = []
    for (let c = startCol + 1; c <= endCol; c += 1) {
      const values = []
      for (let r = firstRow; r <= lastRow; r += 1) values.push(cellValue(ws.getCell(r, c)))
      series.push({ col: colIndexToLetter(c), name: cellValue(ws.getCell(headerRow, c)) ?? colIndexToLetter(c), values })
    }

    // Recalculate and write through ExcelJS first, then inject the chart
    // parts into the finished package.
    await fs.mkdir(path.dirname(outputPath), { recursive: true })
    const recalc = await writeWorkbook(workbook, outputPath)

    const zip = new AdmZip(outputPath)
    const sheetIndex = workbook.worksheets.indexOf(ws) + 1
    const sheetPart = `xl/worksheets/sheet${sheetIndex}.xml`
    if (!zip.getEntry(sheetPart)) throw new Error(`could not locate ${sheetPart} in the written workbook`)

    const chartN = nextPartIndex(zip, /^xl\/charts\/chart(\d+)\.xml$/)
    const drawingN = nextPartIndex(zip, /^xl\/drawings\/drawing(\d+)\.xml$/)
    const chartXml = buildChartXml(chartDef, { sheetName: ws.name, catCol, headerRow, firstRow, lastRow, categories, series })
    const anchorCell = /^([A-Z]+)(\d+)$/i.exec(String(chartDef.anchor || '').toUpperCase())
    const anchorCol = anchorCell ? colLetterToIndex(anchorCell[1]) - 1 : endCol
    const anchorRow = anchorCell ? Number(anchorCell[2]) - 1 : headerRow - 1
    const drawingXml = buildDrawingXml(anchorCol + 1, anchorRow, 8, 15, chartDef.title)

    zip.addFile(`xl/charts/chart${chartN}.xml`, Buffer.from(chartXml, 'utf8'))
    zip.addFile(`xl/drawings/drawing${drawingN}.xml`, Buffer.from(drawingXml, 'utf8'))
    zip.addFile(`xl/drawings/_rels/drawing${drawingN}.xml.rels`, Buffer.from(
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/chart" Target="../charts/chart${chartN}.xml"/></Relationships>`, 'utf8'))

    // sheet -> drawing
    const sheetRelsPart = `xl/worksheets/_rels/sheet${sheetIndex}.xml.rels`
    const sheetRelsEntry = zip.getEntry(sheetRelsPart)
    let sheetRels = sheetRelsEntry
      ? zip.readAsText(sheetRelsEntry)
      : '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>'
    let maxRel = 0
    for (const m of sheetRels.matchAll(/Id="rId(\d+)"/g)) maxRel = Math.max(maxRel, Number(m[1]))
    const drawingRelId = `rId${maxRel + 1}`
    sheetRels = sheetRels.replace('</Relationships>',
      `<Relationship Id="${drawingRelId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing" Target="../drawings/drawing${drawingN}.xml"/></Relationships>`)
    if (sheetRelsEntry) zip.updateFile(sheetRelsEntry, Buffer.from(sheetRels, 'utf8'))
    else zip.addFile(sheetRelsPart, Buffer.from(sheetRels, 'utf8'))

    // <drawing/> belongs at the end of CT_Worksheet's element sequence.
    const sheetEntry = zip.getEntry(sheetPart)
    let sheetXml = zip.readAsText(sheetEntry)
    if (!/<drawing r:id=/.test(sheetXml)) {
      sheetXml = sheetXml.replace('</worksheet>', `<drawing r:id="${drawingRelId}"/></worksheet>`)
      zip.updateFile(sheetEntry, Buffer.from(sheetXml, 'utf8'))
    }

    const ctEntry = zip.getEntry('[Content_Types].xml')
    let ct = zip.readAsText(ctEntry)
    const overrides =
      `<Override PartName="/xl/charts/chart${chartN}.xml" ContentType="application/vnd.openxmlformats-officedocument.drawingml.chart+xml"/>` +
      `<Override PartName="/xl/drawings/drawing${drawingN}.xml" ContentType="application/vnd.openxmlformats-officedocument.drawing+xml"/>`
    ct = ct.replace('</Types>', `${overrides}</Types>`)
    zip.updateFile(ctEntry, Buffer.from(ct, 'utf8'))
    zip.writeZip(outputPath)

    const note = recalcNote(recalc)
    return {
      success: true,
      output: `${JSON.stringify({
        path: outputPath,
        chart: { type: chartDef.type || 'bar', title: chartDef.title || null, series: series.length, points: categories.length },
        sheet: ws.name
      })}\n\nChart written natively — Excel, Numbers and LibreOffice all render it.\n` +
        'CHART LAST: the chart lives in package parts this capability\'s other tools do not know about, so calling spreadsheet_style, _modify, _formula, _filter or _pivot on this file afterwards will silently drop it. Do all other work first.' +
        (note ? `\n\n${note}` : '')
    }
  } catch (err) {
    return { success: false, error: `Chart operation failed: ${err.message}` }
  }
}

async function spreadsheetStyle(args) {
  const filePath = resolvePath(args.path)
  const outputPath = resolvePath(args.output_path)
  let styles
  try {
    styles = parseJsonParam(args.styles, 'styles')
  } catch (err) {
    return { success: false, error: err.message }
  }

  try {
    await checkFileSize(filePath)
    const __wb = await readWorkbookFile(filePath, { forWriting: true })
    const workbook = __wb.workbook

    for (const style of styles) {
      const ws = style.sheet ? workbook.getWorksheet(style.sheet) : workbook.worksheets[0]
      if (!ws) throw new Error(`Sheet not found: ${style.sheet || 'default'}`)

      switch (style.type) {
        case 'format_cells': {
          if (style.range) {
            const range = parseRange(style.range)
            if (range) {
              for (let r = range.startRow; r <= range.endRow; r++) {
                for (let c = range.startCol; c <= range.endCol; c++) {
                  const cell = ws.getCell(r, c)
                  if (style.font) cell.font = { ...cell.font, ...style.font }
                  if (style.fill) cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: style.fill.color || 'FFFFFF00' } }
                  if (style.alignment) cell.alignment = style.alignment
                  if (style.numFmt) cell.numFmt = style.numFmt
                }
              }
            }
          }
          break
        }
        case 'merge': {
          if (style.range) ws.mergeCells(style.range)
          break
        }
        case 'freeze': {
          const row = style.row || 1
          const col = style.column || 0
          ws.views = [{ state: 'frozen', xSplit: col, ySplit: row }]
          break
        }
        case 'border': {
          if (style.range) {
            const range = parseRange(style.range)
            if (range) {
              const borderStyle = style.style || 'thin'
              const border = {
                top: { style: borderStyle },
                left: { style: borderStyle },
                bottom: { style: borderStyle },
                right: { style: borderStyle }
              }
              for (let r = range.startRow; r <= range.endRow; r++) {
                for (let c = range.startCol; c <= range.endCol; c++) {
                  ws.getCell(r, c).border = border
                }
              }
            }
          }
          break
        }
        case 'conditional': {
          if (style.range && style.rules) {
            ws.addConditionalFormatting({
              ref: style.range,
              rules: style.rules
            })
          }
          break
        }
      }
    }

    await fs.mkdir(path.dirname(outputPath), { recursive: true })
    await writeWorkbook(workbook, outputPath)

    return {
      success: true,
      output: JSON.stringify({ path: outputPath, stylesApplied: styles.length })
    }
  } catch (err) {
    return { success: false, error: `Style operation failed: ${err.message}` }
  }
}

async function spreadsheetConvert(args) {
  const filePath = resolvePath(args.path)
  const outputPath = resolvePath(args.output_path)
  let options = {}
  try {
    if (args.options) options = parseJsonParam(args.options, 'options')
  } catch (err) {
    return { success: false, error: err.message }
  }

  const srcExt = getExt(filePath)
  const dstExt = getExt(outputPath)

  try {
    await checkFileSize(filePath)
    await fs.mkdir(path.dirname(outputPath), { recursive: true })

    if ((srcExt === '.csv' || srcExt === '.tsv') && dstExt === '.xlsx') {
      const data = await readCsvTsv(filePath, true, options.delimiter)
      const workbook = new ExcelJS.Workbook()
      const ws = workbook.addWorksheet('Sheet1')
      if (data.headers) {
        ws.addRow(data.headers)
        ws.getRow(1).font = { bold: true }
      }
      for (const row of data.rows) {
        if (Array.isArray(row)) {
          ws.addRow(row)
        } else {
          ws.addRow(Object.values(row))
        }
      }
      await writeWorkbook(workbook, outputPath)
    } else if (srcExt === '.xlsx' && (dstExt === '.csv' || dstExt === '.tsv')) {
      const __wb = await readWorkbookFile(filePath, { forWriting: false })
      const workbook = __wb.workbook
      // CSV has no formulas, so a formula with no cached value would convert to
      // an empty cell or the formula text. Recalculate in memory first — the
      // source file is not touched.
      recalculate(workbook, { onlyMissing: true })
      const ws = options.sheet ? workbook.getWorksheet(options.sheet) : workbook.worksheets[0]
      if (!ws) throw new Error('No worksheet found')

      const rows = []
      ws.eachRow({ includeEmpty: false }, (row) => {
        const values = []
        row.eachCell({ includeEmpty: true }, (cell, colNum) => {
          values[colNum - 1] = cellValue(cell)
        })
        rows.push(values)
      })

      const delimiter = options.delimiter || (dstExt === '.tsv' ? '\t' : ',')
      const csv = Papa.unparse(rows, { delimiter })
      await fs.writeFile(outputPath, csv, 'utf8')
    } else if (srcExt === '.csv' && dstExt === '.tsv') {
      const data = await readCsvTsv(filePath, false, ',')
      const tsv = Papa.unparse(data.rows, { delimiter: '\t' })
      await fs.writeFile(outputPath, tsv, 'utf8')
    } else if (srcExt === '.tsv' && dstExt === '.csv') {
      const data = await readCsvTsv(filePath, false, '\t')
      const csv = Papa.unparse(data.rows, { delimiter: ',' })
      await fs.writeFile(outputPath, csv, 'utf8')
    } else {
      return { success: false, error: `Unsupported conversion: ${srcExt} → ${dstExt}` }
    }

    const stat = await fs.stat(outputPath)
    return {
      success: true,
      output: JSON.stringify({
        path: outputPath,
        from: srcExt.slice(1),
        to: dstExt.slice(1),
        size: stat.size
      })
    }
  } catch (err) {
    if (err.code === 'ENOENT') return { success: false, error: `File not found: ${filePath}` }
    if (err.code === 'EBUSY' || err.code === 'EPERM') return { success: false, error: 'File is open in another application' }
    return { success: false, error: `Convert failed: ${err.message}` }
  }
}

async function spreadsheetAnalyze(args) {
  const filePath = resolvePath(args.path)
  let targetColumns
  try {
    if (args.columns) targetColumns = parseJsonParam(args.columns, 'columns')
  } catch (err) {
    return { success: false, error: err.message }
  }

  try {
    await checkFileSize(filePath)
    const ext = getExt(filePath)
    let headers, rows

    if (ext === '.xlsx' || ext === '.xls') {
      const result = await readXlsx(filePath, args.sheet, null, true)
      headers = result.headers
      rows = result.rows
    } else {
      const result = await readCsvTsv(filePath, true)
      headers = result.headers
      rows = result.rows
    }

    if (!headers || headers.length === 0) {
      return { success: false, error: 'No headers found in the file' }
    }

    const colIndices = targetColumns
      ? targetColumns.map((c) => headers.indexOf(c)).filter((i) => i >= 0)
      : headers.map((_, i) => i)

    const analysis = {}
    for (const idx of colIndices) {
      const colName = headers[idx]
      const values = rows.map((row) => {
        if (Array.isArray(row)) return row[idx]
        return row[colName]
      }).filter((v) => v !== null && v !== undefined && v !== '')

      const numericValues = values.filter((v) => typeof v === 'number' || !isNaN(Number(v))).map(Number)
      const blanks = rows.length - values.length
      const uniqueValues = new Set(values.map(String))

      const colAnalysis = {
        total: rows.length,
        nonEmpty: values.length,
        blanks,
        unique: uniqueValues.size,
        duplicates: values.length - uniqueValues.size,
        detectedType: numericValues.length > values.length * 0.8 ? 'numeric' : 'text'
      }

      if (numericValues.length > 0) {
        numericValues.sort((a, b) => a - b)
        colAnalysis.min = numericValues[0]
        colAnalysis.max = numericValues[numericValues.length - 1]
        colAnalysis.sum = numericValues.reduce((a, b) => a + b, 0)
        colAnalysis.avg = colAnalysis.sum / numericValues.length
        const mid = Math.floor(numericValues.length / 2)
        colAnalysis.median = numericValues.length % 2 === 0
          ? (numericValues[mid - 1] + numericValues[mid]) / 2
          : numericValues[mid]
      }

      analysis[colName] = colAnalysis
    }

    return {
      success: true,
      output: JSON.stringify({
        file: filePath,
        totalRows: rows.length,
        totalColumns: headers.length,
        analyzedColumns: colIndices.length,
        columns: analysis
      }, null, 2)
    }
  } catch (err) {
    if (err.code === 'ENOENT') return { success: false, error: `File not found: ${filePath}` }
    return { success: false, error: `Analysis failed: ${err.message}` }
  }
}

async function spreadsheetFilter(args) {
  const filePath = resolvePath(args.path)
  let filters, sort
  try {
    filters = parseJsonParam(args.filters, 'filters')
  } catch (err) {
    return { success: false, error: err.message }
  }
  try {
    sort = args.sort ? parseJsonParam(args.sort, 'sort') : null
  } catch (err) {
    return { success: false, error: err.message }
  }

  try {
    await checkFileSize(filePath)
    const ext = getExt(filePath)
    let headers, rows

    if (ext === '.xlsx' || ext === '.xls') {
      const result = await readXlsx(filePath, null, null, true)
      headers = result.headers
      rows = result.rows.map((row) => {
        if (Array.isArray(row)) {
          const obj = {}
          headers.forEach((h, i) => { obj[h] = row[i] })
          return obj
        }
        return row
      })
    } else {
      const result = await readCsvTsv(filePath, true)
      headers = result.headers
      rows = result.rows
    }

    let filtered = rows
    for (const f of filters) {
      filtered = filtered.filter((row) => {
        const val = row[f.column]
        switch (f.operator) {
          case 'eq': return val == f.value
          case 'neq': return val != f.value
          case 'gt': return Number(val) > Number(f.value)
          case 'lt': return Number(val) < Number(f.value)
          case 'gte': return Number(val) >= Number(f.value)
          case 'lte': return Number(val) <= Number(f.value)
          case 'contains': return String(val || '').toLowerCase().includes(String(f.value).toLowerCase())
          case 'startsWith': return String(val || '').toLowerCase().startsWith(String(f.value).toLowerCase())
          case 'endsWith': return String(val || '').toLowerCase().endsWith(String(f.value).toLowerCase())
          case 'empty': return val === null || val === undefined || val === ''
          case 'notEmpty': return val !== null && val !== undefined && val !== ''
          default: return true
        }
      })
    }

    if (sort) {
      filtered.sort((a, b) => {
        for (const s of sort) {
          const aVal = a[s.column]
          const bVal = b[s.column]
          const cmp = String(aVal || '').localeCompare(String(bVal || ''), undefined, { numeric: true })
          if (cmp !== 0) return s.direction === 'desc' ? -cmp : cmp
        }
        return 0
      })
    }

    if (args.limit) {
      filtered = filtered.slice(0, args.limit)
    }

    if (args.output_path) {
      const outputPath = resolvePath(args.output_path)
      const outExt = getExt(outputPath)
      await fs.mkdir(path.dirname(outputPath), { recursive: true })

      if (outExt === '.xlsx') {
        const workbook = new ExcelJS.Workbook()
        const ws = workbook.addWorksheet('Filtered')
        if (headers) ws.addRow(headers)
        for (const row of filtered) {
          ws.addRow(headers.map((h) => row[h]))
        }
        await writeWorkbook(workbook, outputPath)
      } else {
        const csv = Papa.unparse(filtered, { delimiter: outExt === '.tsv' ? '\t' : ',' })
        await fs.writeFile(outputPath, csv, 'utf8')
      }

      return {
        success: true,
        output: JSON.stringify({ path: outputPath, matchedRows: filtered.length })
      }
    }

    return {
      success: true,
      output: JSON.stringify({ matchedRows: filtered.length, rows: filtered }, null, 2)
    }
  } catch (err) {
    return { success: false, error: `Filter failed: ${err.message}` }
  }
}

async function spreadsheetPivot(args) {
  const filePath = resolvePath(args.path)
  const outputPath = resolvePath(args.output_path)
  let rowFields, colFields, valueAggs
  try {
    rowFields = parseJsonParam(args.rows, 'rows')
    colFields = parseJsonParam(args.columns, 'columns')
    valueAggs = parseJsonParam(args.values, 'values')
  } catch (err) {
    return { success: false, error: err.message }
  }

  try {
    await checkFileSize(filePath)
    const ext = getExt(filePath)
    let headers, rows

    if (ext === '.xlsx' || ext === '.xls') {
      const result = await readXlsx(filePath, null, null, true)
      headers = result.headers
      rows = result.rows.map((row) => {
        if (Array.isArray(row)) {
          const obj = {}
          headers.forEach((h, i) => { obj[h] = row[i] })
          return obj
        }
        return row
      })
    } else {
      const result = await readCsvTsv(filePath, true)
      headers = result.headers
      rows = result.rows
    }

    // Build pivot
    const pivot = new Map()
    for (const row of rows) {
      const rowKey = rowFields.map((f) => String(row[f] ?? '')).join('|')
      const colKey = colFields.map((f) => String(row[f] ?? '')).join('|')
      const key = `${rowKey}::${colKey}`

      if (!pivot.has(key)) {
        pivot.set(key, { rowKey, colKey, values: [] })
      }
      pivot.get(key).values.push(row)
    }

    // Aggregate
    const colKeys = [...new Set([...pivot.values()].map((p) => p.colKey))].sort()
    const rowKeys = [...new Set([...pivot.values()].map((p) => p.rowKey))].sort()

    const pivotRows = []
    const pivotHeaders = [...rowFields]
    for (const ck of colKeys) {
      for (const va of valueAggs) {
        pivotHeaders.push(ck ? `${ck}_${va.aggregation}(${va.column})` : `${va.aggregation}(${va.column})`)
      }
    }

    for (const rk of rowKeys) {
      const pivotRow = {}
      const rkParts = rk.split('|')
      rowFields.forEach((f, i) => { pivotRow[f] = rkParts[i] })

      for (const ck of colKeys) {
        const entry = pivot.get(`${rk}::${ck}`)
        const vals = entry ? entry.values : []
        for (const va of valueAggs) {
          const colHeader = ck ? `${ck}_${va.aggregation}(${va.column})` : `${va.aggregation}(${va.column})`
          const numVals = vals.map((v) => Number(v[va.column])).filter((n) => !isNaN(n))
          switch (va.aggregation) {
            case 'sum': pivotRow[colHeader] = numVals.reduce((a, b) => a + b, 0); break
            case 'count': pivotRow[colHeader] = vals.length; break
            case 'avg': pivotRow[colHeader] = numVals.length ? numVals.reduce((a, b) => a + b, 0) / numVals.length : 0; break
            case 'min': pivotRow[colHeader] = numVals.length ? Math.min(...numVals) : 0; break
            case 'max': pivotRow[colHeader] = numVals.length ? Math.max(...numVals) : 0; break
          }
        }
      }
      pivotRows.push(pivotRow)
    }

    await fs.mkdir(path.dirname(outputPath), { recursive: true })
    const outExt = getExt(outputPath)

    if (outExt === '.xlsx') {
      const workbook = new ExcelJS.Workbook()
      const ws = workbook.addWorksheet('Pivot')
      ws.addRow(pivotHeaders)
      ws.getRow(1).font = { bold: true }
      for (const row of pivotRows) {
        ws.addRow(pivotHeaders.map((h) => row[h] ?? ''))
      }
      await writeWorkbook(workbook, outputPath)
    } else {
      const csv = Papa.unparse(pivotRows, { columns: pivotHeaders, delimiter: outExt === '.tsv' ? '\t' : ',' })
      await fs.writeFile(outputPath, csv, 'utf8')
    }

    return {
      success: true,
      output: JSON.stringify({
        path: outputPath,
        pivotRows: pivotRows.length,
        pivotColumns: pivotHeaders.length
      })
    }
  } catch (err) {
    return { success: false, error: `Pivot failed: ${err.message}` }
  }
}

function describeAction(toolName, args) {
  const targetPath = String(args?.path || args?.output_path || '')
  const basename = path.basename(targetPath)
  switch (toolName) {
    case 'spreadsheet_read': return { title: 'Read Spreadsheet', description: `Read ${basename}`, risk: 'low' }
    case 'spreadsheet_create': return { title: 'Create Spreadsheet', description: `Create ${basename}`, command: targetPath, risk: 'medium' }
    case 'spreadsheet_modify': return { title: 'Modify Spreadsheet', description: `Edit ${basename}`, command: targetPath, risk: 'medium' }
    case 'spreadsheet_formula': return { title: 'Set Formulas', description: `Add formulas to ${basename}`, command: targetPath, risk: 'medium' }
    case 'spreadsheet_chart': return { title: 'Add Chart', description: `Add chart to ${basename}`, command: targetPath, risk: 'medium' }
    case 'spreadsheet_style': return { title: 'Apply Styles', description: `Style ${basename}`, command: targetPath, risk: 'medium' }
    case 'spreadsheet_convert': return { title: 'Convert Spreadsheet', description: `Convert ${basename}`, command: targetPath, risk: 'medium' }
    case 'spreadsheet_analyze': return { title: 'Analyze Data', description: `Analyze ${basename}`, risk: 'low' }
    case 'spreadsheet_filter': return { title: 'Filter Data', description: `Filter ${basename}`, risk: args?.output_path ? 'medium' : 'low' }
    case 'spreadsheet_pivot': return { title: 'Pivot Table', description: `Create pivot from ${basename}`, command: targetPath, risk: 'medium' }
    default: return null
  }
}

const plugin = {
  name: 'spreadsheet',
  tools: toolDefinitions,
  describeAction,
  async execute(toolName, args) {
    switch (toolName) {
      case 'spreadsheet_read': return spreadsheetRead(args)
      case 'spreadsheet_create': return spreadsheetCreate(args)
      case 'spreadsheet_modify': return spreadsheetModify(args)
      case 'spreadsheet_formula': return spreadsheetFormula(args)
      case 'spreadsheet_chart': return spreadsheetChart(args)
      case 'spreadsheet_style': return spreadsheetStyle(args)
      case 'spreadsheet_convert': return spreadsheetConvert(args)
      case 'spreadsheet_analyze': return spreadsheetAnalyze(args)
      case 'spreadsheet_filter': return spreadsheetFilter(args)
      case 'spreadsheet_pivot': return spreadsheetPivot(args)
      default: return { success: false, error: `spreadsheet: unknown tool ${toolName}` }
    }
  }
}

export default plugin
