---
name: document
description: "Read, create, modify, validate, render, convert and merge Word documents (docx, html, markdown, plain text) — a style engine that puts formatting in named Word styles so the document stays editable, plus structural validation and a render-and-look verify pass."
triggers:
  - document
  - word
  - docx
  - report
  - letter
  - memo
  - template
  - write document
  - create report
  - fill template
  - convert document
  - markdown to word
  - word to pdf
  - table of contents
  - merge documents
  - compare documents
  - extract text
  - doc
  - rtf
  - html
  - txt
  - plain text
  - rich text
  - formatting
  - heading
  - paragraph
  - header
  - footer
  - page number
  - margin
  - font
  - style
  - image
  - figure
  - contract
  - proposal
  - invoice
  - resume
  - cv
  - cover letter
  - manuscript
  - essay
  - thesis
  - paper
  - article
  - newsletter
  - brochure
  - flyer
  - write a letter
  - write a report
  - write a memo
  - draft a document
  - type up
  - proofread
  - spell check
  - grammar
  - outline
  - summary
  - abstract
  - bibliography
  - citation
  - footnote
  - endnote
  - appendix
  - glossary
  - index
  - watermark
  - track changes
  - revision
  - version history
  - export document
  - print document
  - page layout
  - landscape
  - portrait
  - a4
  - letter size
  - docx to pdf
  - sop
  - handbook
  - policy
  - agreement
  - nda
  - terms
tools:
  - name: document_read
    readOnly: true
    description: Read any document file and extract content as text, HTML, or Markdown. Supports docx, html, md, txt, rtf.
    parameters:
      path:
        type: string
        description: Absolute path to the document file
      format:
        type: string
        description: Output format for the extracted content
        enum:
          - text
          - html
          - markdown
        required: false
  - name: doc_design
    readOnly: true
    description: "Load the full Word document design manual into context. Call this BEFORE building any .docx — it settles the fork that decides the whole job (a document nobody will EDIT should be a PDF via pdf_design), then the section-map planning step, the theme table, every block and its fields, the writing rules, how to edit someone else's document, and the mandatory verify loop. Skip only when the user or an automation prompt fully specifies the document."
    parameters:
      document:
        type: string
        required: false
        description: "One line naming the document you are about to build — stating it commits you to following the manual."
  - name: document_create
    description: "Create a designed, EDITABLE .docx. You choose a block type per element and supply content; the engine owns a real Word style sheet (Wf Title/Subtitle/Body/Lead/Quote/Caption plus Heading 1-3), so the reader can restyle the whole document from the Styles pane, the headings reach the navigation pane, and a table of contents actually fills. Blocks: cover, toc, heading, lead, paragraph, bullets, numbered, table, callout, quote, caption, image, divider, page_break. The cover page carries no page number, figures right-align themselves in tables, and heading levels 1-3 are three voices (ruled claim, accent heading, caps label) — doc_design has the rules. Call doc_design FIRST — it also tells you when the answer is a PDF instead."
    parameters:
      output_path:
        type: string
        description: Absolute path for the output .docx file
      content:
        type: string
        description: "JSON array of blocks — [{type:'cover',eyebrow,title,subtitle,meta:[{label,value}],top_space}, {type:'heading',level,text}, {type:'lead',text}, {type:'paragraph',text}, {type:'bullets',items:[]}, {type:'numbered',items:[]}, {type:'table',headers:[],rows:[[]],column_widths:[],caption}, {type:'callout',tone:'info|good|warn|bad',title,text}, {type:'quote',text,attribution}, {type:'image',path,width,height,caption}, {type:'toc',page_break}, {type:'divider'}, {type:'page_break'}]. See doc_design for every field."
      options:
        type: string
        description: "Optional JSON object: {theme (steel|teal|forest|indigo|plum|claret|rust|graphite), tokens, page: 'a4'|'letter'|'legal', orientation, margin_inches, font_display, font_body, base_size, title, author, header, footer, page_numbers}"
        required: false
  - name: document_modify
    description: "Edit an existing .docx — find_replace, append, insert. find_replace works on the TEXT, not the markup: it first coalesces the split runs Word leaves behind (revision ids, spell-check state) so a phrase you can see is actually findable, edits only inside text nodes so it can never rewrite a tag or a style reference, and escapes what it writes so an ampersand cannot corrupt the file. Zero matches is reported as a WARNING, not a success — read the document with document_read again rather than assuming it worked."
    parameters:
      path:
        type: string
        description: Absolute path to the source .docx file
      output_path:
        type: string
        description: Absolute path for the modified output file
      operations:
        type: string
        description: 'JSON array of operations. Types: find_replace {find, replace, regex?}, insert {position, content}, append {content}, format {target, style}'
  - name: document_template
    description: 'Fill a .docx template with data using {{placeholder}} syntax. Supports repeating sections for arrays.'
    parameters:
      template_path:
        type: string
        description: Absolute path to the .docx template file
      output_path:
        type: string
        description: Absolute path for the filled output file
      data:
        type: string
        description: 'JSON object mapping placeholder names to values. Use arrays for repeating sections.'
      options:
        type: string
        description: 'Optional JSON object: {list_separator?: string}'
        required: false
  - name: document_validate
    readOnly: true
    description: "Check a .docx for the faults that make Word refuse it or offer to repair it — unbalanced paragraph/run elements, an unescaped ampersand (what a naive find/replace leaves behind), relationship targets that resolve to nothing, and a paragraph style referenced but never defined. It also warns when a document carries NO named styles at all (the direct-formatting failure — nothing can be restyled and the navigation pane is empty) and when a table-of-contents field will open blank. Run it on every document before sending."
    parameters:
      path:
        type: string
        description: Absolute path to the .docx to check
  - name: document_render
    description: "Render a .docx to PDF so you can actually look at the pages — then pdf_render_pages on that PDF and image_view on each page. Needs LibreOffice; when it is absent the tool says so and tells you to declare the visual check skipped rather than imply it happened. A table of contents renders blank in LibreOffice — that is expected, Word fills it on open."
    parameters:
      path:
        type: string
        description: Absolute path to the .docx to render
      output_dir:
        type: string
        required: false
        description: Where to write the PDF. Defaults to the document's own folder.
      timeout_ms:
        type: number
        required: false
        description: Conversion timeout in ms. Default 120000.
  - name: document_convert
    description: 'Convert between document formats. Supported: docx->html, docx->markdown, docx->text, html->docx, markdown->docx, html->markdown, markdown->html, docx->pdf (requires pdf capability).'
    parameters:
      path:
        type: string
        description: Absolute path to the source document
      output_path:
        type: string
        description: Absolute path for the converted output file (extension determines target format)
  - name: document_merge
    description: Merge multiple documents into a single .docx file with optional page breaks between them.
    parameters:
      paths:
        type: string
        description: 'JSON array of absolute paths to document files to merge'
      output_path:
        type: string
        description: Absolute path for the merged output .docx file
      page_break_between:
        type: string
        description: '"true" to insert page breaks between merged documents (default true)'
        required: false
  - name: document_toc
    description: Generate or update a table of contents for a .docx document based on heading styles.
    parameters:
      path:
        type: string
        description: Absolute path to the source .docx file
      output_path:
        type: string
        description: Absolute path for the output file with TOC
      depth:
        type: number
        description: Maximum heading depth to include (1-6, default 3)
        required: false
      title:
        type: string
        description: Title for the table of contents section (default "Table of Contents")
        required: false
  - name: document_metadata
    description: Read or set document metadata (author, title, subject, keywords, dates).
    parameters:
      path:
        type: string
        description: Absolute path to the .docx file
      action:
        type: string
        description: '"read" to get metadata, "set" to update metadata'
        enum:
          - read
          - set
      output_path:
        type: string
        description: Absolute path for the output file (required for set action)
        required: false
      metadata:
        type: string
        description: 'JSON object with metadata fields to set: {author?, title?, subject?, keywords?, description?}'
        required: false
  - name: document_compare
    description: Compare two documents and return a structured diff with additions, deletions, and modifications.
    parameters:
      path_a:
        type: string
        description: Absolute path to the first document
      path_b:
        type: string
        description: Absolute path to the second document
      format:
        type: string
        description: Output format for the diff
        enum:
          - text
          - html
        required: false
  - name: document_extract_images
    readOnly: true
    description: Extract all images embedded in a .docx file and save them to a directory.
    parameters:
      path:
        type: string
        description: Absolute path to the .docx file
      output_dir:
        type: string
        description: Absolute path to the directory where images will be saved
requires:
  - pdf
  - node
danger_patterns:
  - pattern: '/(System|Windows|Program Files)/'
    level: destructive
    reason: Writing to system directory
  - pattern: '/usr/(bin|lib|local)/'
    level: destructive
    reason: Writing to system directory
confirm_patterns:
  - pattern: 'document_(create|modify|template|convert|merge|toc|metadata)'
    reason: Writing a document file
---

# Document

## Interface

- Tools: `document_read`, `document_create`, `document_modify`, `document_template`, `document_convert`, `document_merge`, `document_toc`, `document_metadata`, `document_compare`, `document_extract_images`
- Supported input formats: .docx, .html, .md, .txt, .rtf
- Primary output format: .docx (create/modify/merge/template)
- All paths must be absolute. Complex parameters are JSON strings.

## The shape of this capability

Two halves, like `presentation`.

**The style engine** (`document_create`) owns a real Word style sheet and the blocks
only reference it. That inversion is the whole difference between a document a person
can work with and one they have to fight: direct formatting cannot be restyled, does
not reach the navigation pane, and is invisible to a table of contents. Palettes are
the eight contrast-tested themes from `pdf-design/themes.md`, so a report, its deck and
its PDF come out of one system.

**The OOXML path** (`read`/`modify`/`validate`) works on documents the engine did not
make. `find_replace` is the part worth knowing about: Word splits a visible phrase
across many runs, so a naive replace matches nothing and reports success; this one
coalesces same-format runs first, then edits only inside `<w:t>` nodes and escapes what
it writes, because an unescaped `&` makes the file unopenable.

**Word or PDF?** If nobody will edit it, `pdf_design` makes a better document. Call
`doc_design` and it settles this first.

## Rules

- Use `mammoth` for reading .docx files (extracts to HTML/text).
- Use `docx` npm package for creating new .docx files programmatically.
- For template filling (`document_template`), unzip the .docx, string-replace `{{placeholders}}` in the XML, and rezip. This preserves original formatting.
- For `document_convert` with docx->pdf output, this capability uses the pdf capability (declared in `requires`).
- Support BiDi/RTL text via the docx package's bidirectional paragraph options.
- Use `os.EOL` for line endings in plain text output.
- Handle EBUSY/EPERM errors gracefully (file open in another app).

## Content Block Types for document_create

- `heading`: { type, text, level (1-6), alignment? }
- `paragraph`: { type, text, alignment?, bold?, italic?, font?, size?, spacing?, indent? }
- `table`: { type, headers: string[], rows: string[][], columnWidths?, style? }
- `image`: { type, path, width?, height?, caption? }
- `list`: { type, items: string[], ordered?, nested? }
- `page_break`: { type }
- `table_of_contents`: { type, depth? }
- `header`: { type, text }
- `footer`: { type, text }
- `code_block`: { type, text, language? }
