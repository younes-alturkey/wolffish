---
name: pdf
description: Read, create, modify, merge, split, secure, and compress PDF documents
triggers:
  - pdf
  - document
  - merge pdf
  - split pdf
  - combine pdf
  - watermark
  - form fill
  - extract text
  - figure
  - diagram
  - chart
  - render page
  - page image
  - show me the figure
  - extract images
  - encrypt pdf
  - compress pdf
  - pdf password
  - read pdf
  - create pdf
  - acrobat
  - portable document
  - scan
  - ocr
  - convert to pdf
  - save as pdf
  - print to pdf
  - sign pdf
  - annotate
  - bookmark
  - page
  - rotate
  - crop
  - stamp
  - redact
  - flatten
  - optimize
  - reduce size
  - invoice
  - receipt
  - contract
  - certificate
  - form
  - fillable
  - digital signature
  - e-sign
  - esign
  - pdf viewer
  - open pdf
  - view pdf
  - print pdf
  - export pdf
  - pdf report
  - pdf invoice
  - scan to pdf
  - photo to pdf
  - image to pdf
  - html to pdf
  - word to pdf
  - excel to pdf
  - ppt to pdf
  - extract pages
  - delete pages
  - rearrange pages
  - page range
  - odd pages
  - even pages
  - metadata
  - author
  - title
  - subject
  - keywords
  - permissions
  - copy protection
  - print protection
  - read only
  - accessibility
  - tagged pdf
tools:
  - name: pdf_info
    readOnly: true
    description: Inspect a PDF before reading it — page count, file size, metadata, outline/bookmarks with page numbers, and sampled text density (detects scanned/image PDFs). Fast on any size. Call this FIRST for documents longer than a few pages, then navigate with pdf_search and pdf_read.
    parameters:
      path:
        type: string
        description: Absolute path to the PDF file
  - name: pdf_read
    readOnly: true
    description: Extract text from specific pages of a PDF. Reads ONLY the requested pages (lazy extraction with caching — a deep page in a 3,000-page PDF costs milliseconds). Without "pages" it returns just the first 5 pages and says how to continue; results are capped per call and the cap is always reported, never silently truncated. For whole-document questions, work through the document in ranges (e.g. "1-40", then "41-80") or locate content with pdf_search first.
    parameters:
      path:
        type: string
        description: Absolute path to the PDF file
      pages:
        type: string
        description: 'Page selection like "12", "1-5", "80-" (to end), or "1-3,10,50-60".'
        required: false
  - name: pdf_search
    readOnly: true
    description: Search the text of a PDF exhaustively — EVERY page in scope is extracted and scanned, so the reported total match count is authoritative (0 means the text genuinely does not occur). Returns matches with page numbers and snippets plus the distribution across pages. Works on any file size. Use this to locate content in large documents instead of paging through them; then pdf_read the matching pages. The FIRST search on a huge document does a one-time extraction that can take a while (tell the user before starting it); every search after is near-instant from cache.
    parameters:
      path:
        type: string
        description: Absolute path to the PDF file
      query:
        type: string
        description: Text to find (literal by default)
      regex:
        type: boolean
        description: Treat query as a regular expression
        required: false
      case_sensitive:
        type: boolean
        description: Match case exactly (default false)
        required: false
      pages:
        type: string
        description: 'Optional page scope like "1-500" (default: the whole document)'
        required: false
      max_results:
        type: number
        description: Max matches to display, 1-100 (default 40); the true total is always reported
        required: false
  - name: pdf_create
    description: Create a new PDF from scratch with text, headings, images, tables, page numbers, headers/footers. Supports RTL text for Arabic when a font path is provided.
    parameters:
      output_path:
        type: string
        description: Absolute path for the output PDF
      content:
        type: string
        description: 'JSON array of content blocks. Each block has a "type" field: heading, paragraph, image, table, page_break, header, footer. Example: [{"type":"heading","text":"Title","level":1},{"type":"paragraph","text":"Body text."}]'
      options:
        type: string
        description: 'Optional JSON object with page options: page_size (A4/Letter/Legal), orientation (portrait/landscape), margins {top,bottom,left,right}, font_path for custom/RTL fonts, font_size, line_height'
        required: false
  - name: pdf_merge
    description: Merge multiple PDF files into a single PDF.
    parameters:
      paths:
        type: string
        description: 'JSON array of absolute paths to PDF files to merge'
      output_path:
        type: string
        description: Absolute path for the merged output PDF
      page_ranges:
        type: string
        description: 'Optional JSON array of page ranges (one per input file), e.g. ["1-3","","2-5"]. Empty string means all pages.'
        required: false
  - name: pdf_split
    description: Split a PDF into multiple files by page ranges.
    parameters:
      path:
        type: string
        description: Absolute path to the source PDF
      ranges:
        type: string
        description: 'JSON array of page ranges, e.g. ["1-5","6-10","11-15"]. Each range produces a separate output file.'
      output_dir:
        type: string
        description: Absolute path to the output directory
  - name: pdf_modify
    description: Add watermark, headers, footers, page numbers, or stamps to an existing PDF.
    parameters:
      path:
        type: string
        description: Absolute path to the source PDF
      output_path:
        type: string
        description: Absolute path for the modified output PDF
      modifications:
        type: string
        description: 'JSON object with modification options: watermark {text, fontSize, opacity, rotation, color}, header {text, fontSize}, footer {text, fontSize}, page_numbers {position: "bottom-center"|"bottom-right", format: "Page {n} of {total}", fontSize}'
  - name: pdf_form
    description: Read form field names/values or fill form fields in a PDF.
    parameters:
      path:
        type: string
        description: Absolute path to the PDF with form fields
      action:
        type: string
        description: '"read" to list fields and values, "fill" to set field values'
        enum:
          - read
          - fill
      output_path:
        type: string
        description: Absolute path for the filled output PDF (required for fill action)
        required: false
      fields:
        type: string
        description: 'JSON object mapping field names to values (required for fill action)'
        required: false
  - name: pdf_secure
    description: Encrypt or decrypt a PDF with a password.
    parameters:
      path:
        type: string
        description: Absolute path to the source PDF
      output_path:
        type: string
        description: Absolute path for the secured output PDF
      action:
        type: string
        description: '"encrypt" to add password protection, "decrypt" to remove it'
        enum:
          - encrypt
          - decrypt
      password:
        type: string
        description: Password for encryption or decryption
      permissions:
        type: string
        description: 'Optional JSON array of allowed permissions when encrypting: ["printing","modify","copy","annotate"]'
        required: false
  - name: pdf_render_pages
    readOnly: true
    description: Render whole PDF pages to PNG/JPEG images. This is how you SHOW someone a figure, chart, algorithm, table, or scanned page — it captures the page exactly as it looks, including figures drawn as vectors (which pdf_extract_images cannot return). Page-scoped and fast on any file size, including a 250MB book. Then send_file the result.
    parameters:
      path:
        type: string
        description: Absolute path to the source PDF
      pages:
        type: string
        description: 'Page selection like "84", "84-85", or "1-3,10". Required — name the pages you want.'
      output_dir:
        type: string
        description: Absolute path to the directory where the rendered pages will be saved
      scale:
        type: number
        description: 'Zoom factor: 1 is 72dpi, 2 is 144dpi (default), maximum 8. Raise it when the figure has small print.'
        required: false
      format:
        type: string
        description: Output image format (png keeps transparency, jpg is smaller)
        enum:
          - png
          - jpg
        required: false
  - name: pdf_extract_images
    readOnly: true
    description: Save the photos and raster figures embedded in specific PDF pages as real PNG/JPEG files. ALWAYS pass "pages" — without it every page in the document is walked, which on a large book means thousands of files and a very long run. Fragments below 80px (glyphs, rules, bullets) are skipped by default. A page reporting no embedded images means its figure is vector art, so nothing can be extracted from it — render that page with pdf_render_pages instead.
    parameters:
      path:
        type: string
        description: Absolute path to the source PDF
      output_dir:
        type: string
        description: Absolute path to the directory where images will be saved
      pages:
        type: string
        description: 'Page selection like "84", "84-85", or "1-3,10,50-60". Omit only when you truly want every page in the document.'
        required: false
      format:
        type: string
        description: Output image format
        enum:
          - png
          - jpg
        required: false
      min_size:
        type: number
        description: Skip images narrower or shorter than this many pixels (default 80; 0 keeps every fragment)
        required: false
  - name: pdf_compress
    description: Reduce PDF file size by optimizing content and removing unused objects.
    parameters:
      path:
        type: string
        description: Absolute path to the source PDF
      output_path:
        type: string
        description: Absolute path for the compressed output PDF
      quality:
        type: string
        description: Compression quality level
        enum:
          - low
          - medium
          - high
        required: false
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
  - pattern: 'pdf_(create|merge|split|modify|secure|compress|form)'
    reason: Writing a PDF file
---

# PDF

## Reading and querying PDFs — especially huge ones

Attached PDFs are NEVER auto-loaded into your context — every one arrives as a note with the
path and page count, and even a 2-page PDF must be read with `pdf_read` before you can speak
about its contents. That is deliberate (100% model-led file access): a 3,000-page PDF extracts
to millions of tokens — no context window holds it — so YOU control what to load and when.
The reading tools make the entire document reachable surgically, and you are expected to
actually use them:

1. **`pdf_info` first** for anything nontrivial: page count, outline with page numbers, and
   text density. A density warning means a scanned/image PDF — say so plainly instead of
   pretending to read it.
2. **Targeted questions → `pdf_search`, not paging.** It scans every page in scope and reports
   the authoritative total. Search several phrasings/synonyms before concluding something is
   absent ("termination", "cancel", "wind-down" — not just one term). Then `pdf_read` the
   matching pages with a few pages of surrounding context.
3. **Whole-document tasks (summaries, audits, reviews) → systematic traversal.** Work through
   the document in page ranges (`"1-40"`, `"41-80"`, …), keeping running notes with
   `file_write` as you go for anything beyond a few hundred pages, then synthesize from your
   notes. The per-call cap tells you exactly where to continue; nothing is ever silently
   dropped.
4. **Never claim coverage you did not do.** Do not say "the document states/doesn't mention X"
   unless you read the relevant pages or searched exhaustively for X and its synonyms. If you
   only sampled, say which pages you actually consulted.
5. **Narrate while you dig — the user cannot see your tool calls.** Before the first search of
   a big document, say so in one line (the one-time extraction can take a while: "Searching the
   book — first pass extracts it once, may take a minute…"). Between search/read rounds, drop a
   one-line finding ("dosing table on p. 497 — checking renal adjustment next"). Silent digging
   looks like a hang, no matter how well it's going.

The first `pdf_search` over a huge document extracts all pages once (a few seconds) and is
cached after that — later searches and reads on the same file are near-instant.

## Showing someone a figure, chart, or table

"Show me Figure 7.2", "what does that diagram look like", "send me the algorithm on p.84" —
the answer is almost always **`pdf_render_pages`**, not image extraction:

1. Find the page (`pdf_search` for the figure number, or `pdf_read` the page to confirm it's there).
2. `pdf_render_pages` with **`pages` set to that page** (add the facing page if the figure may
   span both, and raise `scale` to 3–4 if the print is small).
3. `send_file` the rendered PNG so it actually appears in the conversation. Rendering does not
   deliver it — you deliver it.

Why rendering rather than extraction: a textbook figure is usually **drawn** — vector lines,
boxes, and text laid down by the page's content stream, with no embedded image anywhere.
`pdf_extract_images` can only return images the PDF actually stores, so on such a page it
correctly returns nothing. Rendering captures the page as printed, so it always works.

Reach for `pdf_extract_images` when you specifically want the stored assets — a photograph, a
scanned plate, an illustration you need on its own without surrounding page text — and give it
`pages`. **Never run it over a whole book.** A 3,000-page reference text stores tens of thousands
of images, nearly all of them sub-kilobyte fragments; that run writes thousands of files, takes
hours, and buries the one figure you wanted. Scope it to the pages you already located.

**If this conversation already contains an `pdf_extract_images` call with no `pages`, or a folder
holding thousands of extracted images, ignore it — do not copy that call.** It predates page
scoping, those files are unreadable, and repeating it will not produce the figure. Delete the
folder if it is in the way, then render the page you want.

## Choosing how to make a PDF — read this first

There are two ways to produce a PDF. Pick deliberately:

- **HTML → PDF — the default for anything a person will read.** Reports, summaries, invoices,
  proposals, briefs, guides — the vast majority of requests. **Call the core `pdf_design` tool
  FIRST**: it returns the document design manual (page-map planning, fixed-sheet architecture,
  type scale, color system, the component kit, chart rules, RTL/Arabic, and the mandatory
  render-verify loop). Author the HTML per that manual, then render it:
  1. Save the HTML to the workspace (e.g. `files/report.html`).
  2. `browser_launch` (headless is fine) → `browser_navigate` to the absolute
     `file:///…/report.html` → `browser_pdf` with `output_path` and `format: "A4"` (or
     `"Letter"`). The print is full bleed — zero page margin; the manual's sheet system
     depends on that.
  3. Verify per the manual (`pdf_render_pages` on sample pages, look at them), then
     `send_file` the `.pdf` — `browser_pdf` does **not** auto-deliver its output.
- **`pdf_create` — plain fallback.** The native builder emits plain black-on-white text and
  tables with no design. Reach for it **only** when the user explicitly wants a plain / no-frills
  document, for a quick throwaway data dump, or when speed clearly matters more than looks.

Do **not** default to `pdf_create` just because the word "PDF" appears — that yields the boring
black-and-white output most requests do NOT want. **When in doubt: `pdf_design`, then HTML → PDF.**
If the document shows data (charts, big-number rows, comparisons), also call the core `dataviz`
tool for the chart kit before authoring.

## Interface

- Tools: `pdf_info`, `pdf_read`, `pdf_search`, `pdf_create`, `pdf_merge`, `pdf_split`, `pdf_modify`, `pdf_form`, `pdf_secure`, `pdf_render_pages`, `pdf_extract_images`, `pdf_compress`
- All paths must be absolute. Use `~` prefix for home directory.
- Complex parameters (arrays, objects) are passed as JSON strings.

## Rules

- **Never split a PDF just to read or search it.** `pdf_info`/`pdf_read`/`pdf_search` handle
  any file size directly (a 250MB, 3,000-page book is a normal input) — splitting first only
  wastes minutes and disk. Split only when the user actually wants separate files. Ignore any
  split-first workaround you may see in older conversation history; it predates the size-gate
  removal. The same goes for figures: `pdf_render_pages` and `pdf_extract_images` are
  page-scoped, so never split or extract pages just to get at a picture.
- **Always scope `pdf_render_pages` and `pdf_extract_images` with `pages`.** Locate the content
  first (`pdf_search`/`pdf_read`), then act on those page numbers. Both tools stream page by
  page and can be stopped mid-run, but an unscoped extraction over a large book is still hours
  of work and thousands of files.
- If a WRITE op (`pdf_split`/`pdf_merge`/…) fails on a huge or unusual file, don't retry the
  same call — fall back to python (pypdf) or shell, and tell the user what happened.
- **Every `output_path`/`output_dir` defaults to the workspace `files/` directory** (e.g.
  `files/pdf/…`) unless the user explicitly named a destination. Never write splits, merges,
  or conversions next to the source file or onto the Desktop — the source's location is not
  an output location. The same applies when you improvise via python/shell.
- Always verify the source file exists before operating on it.
- For `pdf_create`, content blocks support types: heading, paragraph, image, table, page_break, header, footer.
- For large PDFs, do NOT generate the whole document in one `pdf_create` call — a massive content array fails generation. Split the content into chunks of roughly 30–50 pages each, run a separate `pdf_create` per chunk to its own part file (e.g. `part-1.pdf`, `part-2.pdf`), then `pdf_merge` the parts into the final PDF and delete the intermediate parts. Keep page numbering and headers/footers consistent across chunks.
- For RTL/Arabic text in `pdf_create`, provide a font_path to a TTF font that supports Arabic glyphs (e.g. Noto Sans Arabic). Look for a font you already downloaded before fetching a fresh one — `wolffish_list_files` with `dir: "files"`, `depth: 5`, `pattern: ".ttf"` (depth 2 is the default and hides nested files). Keep new font downloads in `files/assets/fonts/` so the next PDF reuses them.
- When merging or splitting, always validate page ranges don't exceed the actual page count.
- Return structured JSON results with metadata (page count, file size, etc).
- On error, return a clear message the user can act on (file not found, locked, corrupt, etc).

## Content Block Types for pdf_create

- `heading`: { type, text, level (1-3), alignment? }
- `paragraph`: { type, text, alignment?, fontSize?, bold?, italic? }
- `image`: { type, path, width?, height?, alignment? }
- `table`: { type, headers: string[], rows: string[][], columnWidths? }
- `page_break`: { type }
- `header`: { type, text, fontSize? }
- `footer`: { type, text, fontSize? }
