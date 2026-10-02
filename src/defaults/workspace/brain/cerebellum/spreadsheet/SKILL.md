---
name: spreadsheet
description: Read, create, modify, analyze, and convert spreadsheet files (xlsx, csv, tsv)
triggers:
  - spreadsheet
  - excel
  - xlsx
  - csv
  - tsv
  - table
  - data
  - workbook
  - cells
  - formula
  - chart
  - pivot
  - analyze data
  - import csv
  - export csv
  - columns
  - rows
  - filter data
  - xls
  - worksheet
  - cell
  - range
  - sum
  - average
  - count
  - sort
  - vlookup
  - calculate
  - computation
  - statistics
  - graph
  - plot
  - bar chart
  - line chart
  - pie chart
  - data analysis
  - report
  - tabular
  - matrix
  - grid
  - merge cells
  - split cells
  - conditional formatting
  - budget
  - financial
  - accounting
  - invoice
  - inventory
  - metrics
  - dashboard
  - revenue
  - expense
  - profit
  - loss
  - sales
  - forecast
  - projection
  - trend
  - growth
  - percentage
  - ratio
  - margin
  - kpi
  - roi
  - total
  - subtotal
  - grand total
  - lookup
  - hlookup
  - index match
  - countif
  - sumif
  - min
  - max
  - median
  - variance
  - std deviation
  - histogram
  - scatter plot
  - heatmap
  - sparkline
  - data validation
  - dropdown list
  - freeze panes
  - hide column
  - hide row
  - number format
  - currency
  - date format
  - open spreadsheet
  - read spreadsheet
  - edit spreadsheet
  - create spreadsheet
  - parse csv
  - load csv
  - export excel
tools:
  - name: spreadsheet_read
    readOnly: true
    description: Read any spreadsheet file (xlsx, csv, tsv) and return structured JSON data. Auto-detects format from extension.
    parameters:
      path:
        type: string
        description: Absolute path to the spreadsheet file
      sheet:
        type: string
        description: Sheet name or 1-based index number (for xlsx). Defaults to first sheet.
        required: false
      range:
        type: string
        description: 'Excel-style range like "A1:D50". Omit to read all data.'
        required: false
      headers:
        type: string
        description: '"true" to treat first row as headers (default true for csv/tsv), "false" to return raw rows'
        required: false
  - name: spreadsheet_create
    description: Create a new spreadsheet file from scratch with multiple sheets, columns, rows, and styles.
    parameters:
      output_path:
        type: string
        description: 'Absolute path for the output file. Extension determines format: .xlsx, .csv, .tsv'
      sheets:
        type: string
        description: 'JSON array of sheet definitions. Each: {name, columns: [{header, width?, type?, format?}], rows: [[values...]], styles?: {}}'
  - name: spreadsheet_modify
    description: Edit an existing spreadsheet — add/remove/rename sheets, insert/delete rows/columns, update cells, apply formatting.
    parameters:
      path:
        type: string
        description: Absolute path to the source spreadsheet
      output_path:
        type: string
        description: Absolute path for the modified output file
      operations:
        type: string
        description: 'JSON array of operations. Types: add_sheet, remove_sheet, rename_sheet, insert_rows, delete_rows, insert_columns, delete_columns, set_cell, set_range'
  - name: spreadsheet_formula
    description: "Add or set formulas in spreadsheet cells. Every write recalculates the whole workbook and stores each formula's computed value alongside it, so the file reads back as numbers rather than as empty cells — and the result names any formula that evaluated to an error (#DIV/0!, #REF!, #VALUE!) or could not be evaluated at all. Fix what it names before sending the file. Write formulas, never Python-computed constants, so the sheet recalculates when its inputs change."
    parameters:
      path:
        type: string
        description: Absolute path to the source spreadsheet
      output_path:
        type: string
        description: Absolute path for the output file
      formulas:
        type: string
        description: 'JSON array of formula operations: [{cell: "A1", sheet?: "Sheet1", formula: "=SUM(B1:B10)"}]. A cell value that starts with "=" is also treated as a formula by spreadsheet_create and by modify''s set_cell/set_range/insert_rows, so a whole model can be built in one create call.'
  - name: spreadsheet_chart
    description: "Add a real, native chart to a sheet (bar, hbar, line, area, pie, doughnut, scatter) — one Excel, Numbers and LibreOffice all render and the user can restyle. data_range reads its first column as the categories, every other column as a series, and the first row as their names. DO THIS LAST: the chart lives in package parts the other spreadsheet tools do not know about, so any later spreadsheet_style, _modify, _formula, _filter or _pivot call on the same file silently drops it."
    parameters:
      path:
        type: string
        description: Absolute path to the source spreadsheet
      output_path:
        type: string
        description: Absolute path for the output file
      chart:
        type: string
        description: 'JSON chart definition: {type: "bar"|"hbar"|"line"|"area"|"pie"|"doughnut"|"scatter", data_range: "A1:D10" (first column = categories, first row = series names), title?, x_axis?, y_axis?, sheet?, anchor? (top-left cell, e.g. "F2"), stacked?}'
  - name: spreadsheet_style
    description: Apply formatting — conditional formatting, borders, colors, fonts, merge cells, freeze panes.
    parameters:
      path:
        type: string
        description: Absolute path to the source spreadsheet
      output_path:
        type: string
        description: Absolute path for the output file
      styles:
        type: string
        description: 'JSON array of style operations: [{type: "format_cells"|"merge"|"freeze"|"border"|"conditional", range, sheet?, ...options}]'
  - name: spreadsheet_convert
    description: 'Convert between spreadsheet formats: xlsx to csv, csv to xlsx, tsv to xlsx, etc.'
    parameters:
      path:
        type: string
        description: Absolute path to the source file
      output_path:
        type: string
        description: Absolute path for the output file (extension determines target format)
      options:
        type: string
        description: 'Optional JSON object: {delimiter?, encoding?, sheet? (which sheet to export for xlsx->csv)}'
        required: false
  - name: spreadsheet_analyze
    description: Quick data analysis — summary statistics per column (min, max, avg, median, count, sum), detect types, find duplicates, identify blanks.
    parameters:
      path:
        type: string
        description: Absolute path to the spreadsheet file
      sheet:
        type: string
        description: Sheet name or index (for xlsx)
        required: false
      columns:
        type: string
        description: 'Optional JSON array of column names/letters to analyze. Omit for all columns.'
        required: false
  - name: spreadsheet_filter
    description: Filter and sort rows by criteria. Output to a new file or return JSON.
    parameters:
      path:
        type: string
        description: Absolute path to the spreadsheet file
      output_path:
        type: string
        description: Optional output file path. If omitted, returns filtered data as JSON.
        required: false
      filters:
        type: string
        description: 'JSON array of filter operations: [{column, operator: "eq"|"neq"|"gt"|"lt"|"gte"|"lte"|"contains"|"startsWith"|"endsWith"|"empty"|"notEmpty", value?}]'
      sort:
        type: string
        description: 'Optional JSON array of sort operations: [{column, direction: "asc"|"desc"}]'
        required: false
      limit:
        type: number
        description: Maximum number of rows to return
        required: false
  - name: spreadsheet_pivot
    description: Create a pivot table from spreadsheet data.
    parameters:
      path:
        type: string
        description: Absolute path to the source spreadsheet
      output_path:
        type: string
        description: Absolute path for the output file with the pivot table
      rows:
        type: string
        description: 'JSON array of column names to use as row groupings'
      columns:
        type: string
        description: 'JSON array of column names to use as column groupings'
      values:
        type: string
        description: 'JSON array of value aggregations: [{column, aggregation: "sum"|"count"|"avg"|"min"|"max"}]'
requires:
  - node
danger_patterns:
  - pattern: '/(System|Windows|Program Files)/'
    level: destructive
    reason: Writing to system directory
  - pattern: '/usr/(bin|lib|local)/'
    level: destructive
    reason: Writing to system directory
confirm_patterns:
  - pattern: 'spreadsheet_(create|modify|formula|chart|style|convert|filter|pivot)'
    reason: Writing a spreadsheet file
---

# Spreadsheet

## Interface

- Tools: `spreadsheet_read`, `spreadsheet_create`, `spreadsheet_modify`, `spreadsheet_formula`, `spreadsheet_chart`, `spreadsheet_style`, `spreadsheet_convert`, `spreadsheet_analyze`, `spreadsheet_filter`, `spreadsheet_pivot`
- Supported formats: .xlsx, .csv, .tsv
- All complex parameters are passed as JSON strings.
- All paths must be absolute.

## What makes a workbook good

These are the rules that decide whether a sheet is useful or merely produced. They
hold unless the user says otherwise, or the file you are editing already does
something else — an existing file's conventions beat every guideline here.

- **Formulas, never computed constants.** Write `=SUM(B2:B9)`, not the total you
  worked out yourself. A sheet whose numbers do not move when its inputs change is a
  screenshot, not a model. A cell value beginning with `=` is written as a formula by
  `spreadsheet_create` and by `set_cell`/`set_range`/`insert_rows`.
- **Ship zero formula errors.** Every write recalculates and reports `#DIV/0!`,
  `#REF!`, `#VALUE!` by address, plus anything that could not be evaluated. Fix what
  it names. If you think an error predates you, prove it by reading the original.
- **A clean recalculation proves the formulas evaluate, not that they are right.** An
  off-by-one range yields a clean file with wrong numbers. Write two or three
  formulas first, `spreadsheet_read` them back, check the values are what you expect,
  and only then build out the grid.
- **Every assumption in its own labelled cell**, referenced by the formulas that use
  it — `=B5*(1+$B$6)`, never `=B5*1.05`. A rate buried inside a formula is a number
  nobody can find and nobody can change.
- **Formulas consistent across a row.** One hand-edited cell in the middle of a
  projection is the commonest silent error in any model. Guard denominators that can
  be zero.
- **Say where a number came from.** A hardcoded figure gets a note in the adjacent
  cell or a real citation. When it came from the user, say so.
- **A workbook someone will fill in** needs a short legend naming the input cells and
  one example row in the expected format. Never add such a row to a file you were
  asked to edit.
- **Follow the spec literally** — exact sheet names, exact headers, the formula they
  spelled out. A redesign that computes something else fails however elegant it is.
- **Charts last.** See the `spreadsheet_chart` note: any other tool run afterwards
  rewrites the package and drops them.

### Financial models

Unless the user says otherwise, or the file already does something else:

**Colour** — blue text (`0000FF`) for hardcoded inputs and scenario levers, black for
formulas, green (`008000`) for links to another sheet, red (`FF0000`) for links to
another file, yellow fill (`FFFF00`) for key assumptions and cells the user should
fill in. This is the convention every analyst reads without being told.

**Numbers** — currency `$#,##0` with the unit named in the header (`Revenue ($mm)`);
zeros render as `-` (`$#,##0;($#,##0);-`); negatives in parentheses; percentages
`0.0%` and **stored as fractions** (`0.15` renders `15.0%`; storing `15` renders
`1500.0%`); multiples `0.0x`; years as text (`"2024"`, never `2,024`).

**Structure** — inputs, calculations and outputs in that order, freeze the header row,
and give every sheet one job.

## Rules

- Auto-detect file format from the extension.
- For CSV/TSV, handle BOM detection, quoted fields, escaped quotes, multiline values.
- Default encoding is UTF-8. Detect and handle UTF-16 and Windows-1252.
- For files > 10MB, use streaming where available.
- Hard limit: reject files > 100MB with a clear error.
- Normalize dates to ISO 8601 in output.
- Handle Excel serial date numbers correctly.
- Return structured JSON results.
- Handle EBUSY/EPERM errors gracefully (file open in another app).
- Formulas are recalculated on every write, so `spreadsheet_read`, `spreadsheet_analyze`
  and any previewer see values. A formula this runtime cannot evaluate keeps its
  formula and is reported — Excel computes it on open, but until then that cell reads
  back empty, so never rely on one you were told about.

## Column Reference

- Columns can be referenced by letter (A, B, C...) or by header name when headers=true.
- Ranges use Excel notation: "A1:D50", "B:B" (whole column), "3:5" (whole rows).
