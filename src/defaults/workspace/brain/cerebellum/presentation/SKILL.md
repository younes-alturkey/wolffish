---
name: presentation
description: "Read, create, edit and verify PowerPoint decks (.pptx/.potx) — a layout engine that owns the design so slides come out presentable, plus structural validation and a render-and-look verify pass."
triggers:
  - presentation
  - powerpoint
  - pptx
  - potx
  - deck
  - slides
  - slide deck
  - pitch deck
  - board deck
  - keynote
  - present
  - speaker notes
  - slide
  - talk
  - conference talk
  - template deck
tools:
  - name: deck_design
    readOnly: true
    description: "Load the full deck design manual into context. Call this BEFORE writing the spec for any deck — it carries the slide-map planning step, the theme table, every layout and its fields, the writing rules for slides, chart guidance, the template-editing order, and the mandatory verify loop. Skip only when the user or an automation prompt fully specifies the deck (explicit instructions always win over the manual)."
    parameters:
      deck:
        type: string
        required: false
        description: "One line naming the deck you are about to build — stating it commits you to following the manual."
  - name: presentation_read
    readOnly: true
    description: "Read a .pptx or .potx — every slide's shape text, its title, and its speaker notes, in presentation order. Always call this before editing a deck you did not create; replace_text matches exact strings and you cannot guess them."
    parameters:
      path:
        type: string
        description: Absolute path to the .pptx or .potx file
      format:
        type: string
        required: false
        description: "'json' (default, structured per slide) or 'text' (a readable dump)"
      from_slide:
        type: number
        required: false
        description: First slide to read, 1-based. Defaults to 1.
      to_slide:
        type: number
        required: false
        description: Last slide to read, 1-based. Defaults to the final slide.
  - name: presentation_create
    description: "Create a designed .pptx from a deck spec. You choose a layout per slide and supply content; the engine owns geometry, type scale and colour, so margins, alignment and palette cannot come out wrong. Layouts are title, section, bullets, two-column, cards, stats, steps, table, chart, image, quote, closing. Returns text-fit warnings naming any box that is close to overflowing. Call deck_design FIRST for the spec format and the planning step."
    parameters:
      output_path:
        type: string
        description: Absolute path for the output file, ending in .pptx
      deck:
        type: string
        description: "JSON deck spec — {theme, aspect, title, footer, font_display, font_body, slides:[{layout, ...fields, notes}]}. See deck_design for every layout's fields."
  - name: presentation_modify
    description: "Edit an existing .pptx — duplicate_slide, delete_slide, reorder, replace_text, set_notes. Structural operations are applied before content edits whichever order you pass them in, because duplicating after an edit clones the edited text. replace_text rewrites visible runs and leaves formatting untouched, which is how you fill a template without flattening its styling."
    parameters:
      path:
        type: string
        description: Absolute path to the source .pptx
      output_path:
        type: string
        required: false
        description: Absolute path for the result. Defaults to overwriting the source.
      operations:
        type: string
        description: "JSON array. [{type:'duplicate_slide', slide, after?}, {type:'delete_slide', slide}, {type:'reorder', order:[...]}, {type:'replace_text', find, replace, slide?, case_sensitive?}, {type:'set_notes', slide, notes}]"
  - name: presentation_validate
    readOnly: true
    description: "Check a .pptx for the faults that make PowerPoint declare a file corrupt while every other tool opens it happily — unresolvable relationships, missing content-type overrides, slides referenced but absent, the two chart shapes PowerPoint refuses (an undeclared secondary axis, outEnd labels on a stacked series) — plus leftover placeholder text and empty slides. Run it on every deck before sending. Structure passing is not the same as the deck looking right."
    parameters:
      path:
        type: string
        description: Absolute path to the .pptx to check
  - name: presentation_render
    description: "Render a .pptx to PDF so you can actually look at the slides — then call pdf_render_pages on that PDF and image_view on each image. Needs LibreOffice; when it is absent the tool says so and tells you to declare the visual check skipped rather than imply it happened."
    parameters:
      path:
        type: string
        description: Absolute path to the .pptx to render
      output_dir:
        type: string
        required: false
        description: Where to write the PDF. Defaults to the deck's own folder.
      timeout_ms:
        type: number
        required: false
        description: Conversion timeout in ms. Default 120000.
requires:
  - node
danger_patterns:
  - pattern: '/(System|Windows|Program Files)/'
    level: destructive
    reason: Writing to system directory
confirm_patterns:
  - pattern: 'presentation_(create|modify)'
    reason: Writing a presentation file
---

# Presentation

## Interface

- Tools: `deck_design`, `presentation_read`, `presentation_create`, `presentation_modify`,
  `presentation_validate`, `presentation_render`.
- Formats: `.pptx` and `.potx` for reading and editing; `.pptx` for output.
- All complex parameters are passed as JSON strings. All paths absolute.

## The shape of this capability

Two halves that meet in the middle.

**The layout engine** (`presentation_create`) inverts the usual arrangement. Most pptx
tooling hands the model a canvas and lets it place shapes, which is how decks end up
with drifting margins, ten greys and text running off the slide — none of which the
model can see. Here the model picks a **layout** per slide and supplies **content**;
geometry, type scale and palette belong to the engine. The guardrails that matter live
in code, not in prose: colour is normalised (a leading `#` or an alpha channel corrupts
a pptx rather than erroring), the canvas is defined explicitly (the library's stock
16:9 is 10 inches wide and silently drops anything past the edge), and every option
object is rebuilt per call because the library mutates them in place.

**The OOXML path** (`read`/`modify`/`validate`) works on decks the engine did not make
— client decks, templates, anything already on disk. It edits the package as text and
touches nothing it did not mean to; round-tripping OOXML through a generic XML parser
rewrites namespace prefixes and produces a file PowerPoint refuses.

Palettes are the eight contrast-tested themes from `pdf-design/themes.md`, so a deck
and its companion report come out of one colour system.

## Rules

- Call `deck_design` before writing a spec. The manual is the difference between a deck
  and a bulleted dump.
- `presentation_validate` on every deck before it is sent — including ones the engine
  made.
- Render and look before claiming a deck is done. If LibreOffice is missing, say in
  your reply that you verified structure and content but could not see the slides.
- Read a deck before editing it. `replace_text` is exact-match and reports zero hits
  rather than guessing.
- A deck the user will read alone, not present, is usually a document — offer
  `pdf_design` instead.
