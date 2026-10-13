/**
 * Minimal RFC 4180 delimited-text parser for the spreadsheet card — the
 * mobile stand-in for the desktop SpreadsheetViewer's SheetJS render of
 * .csv/.tsv. Pure and total: malformed input yields the best rows it can
 * rather than throwing (a half-quoted export must still render).
 */

export type SheetTable = {
  rows: string[][]
  /** Widest row — every row is padded to this so the table stays rectangular. */
  columns: number
  /** True when parsing stopped at maxRows (the card shows a "truncated" note). */
  truncated: boolean
  totalRows: number
}

export function delimiterFor(ext: string): string {
  return ext === 'tsv' ? '\t' : ','
}

/**
 * Parse delimited text into rows. `maxRows` caps what is materialized — a
 * 200k-row CSV must not become 200k RN views.
 */
export function parseDelimited(
  text: string,
  delimiter: string = ',',
  maxRows: number = 500
): SheetTable {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let quoted = false
  let sawAny = false
  let totalRows = 0

  const endField = (): void => {
    row.push(field)
    field = ''
    sawAny = true
  }
  const endRow = (): void => {
    endField()
    totalRows += 1
    if (rows.length < maxRows) rows.push(row)
    row = []
    sawAny = false
  }

  for (let i = 0; i < text.length; i++) {
    const char = text[i]

    if (quoted) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          field += '"'
          i += 1
        } else {
          quoted = false
        }
      } else {
        field += char
      }
      continue
    }

    if (char === '"' && field === '') {
      quoted = true
      sawAny = true
      continue
    }
    if (char === delimiter) {
      endField()
      continue
    }
    if (char === '\r') continue
    if (char === '\n') {
      endRow()
      continue
    }
    field += char
  }

  // Trailing partial row — a file that doesn't end in a newline still has data.
  if (field !== '' || sawAny || row.length > 0) endRow()

  const columns = rows.reduce((max, r) => Math.max(max, r.length), 0)
  for (const r of rows) {
    while (r.length < columns) r.push('')
  }

  return { rows, columns, truncated: totalRows > rows.length, totalRows }
}
