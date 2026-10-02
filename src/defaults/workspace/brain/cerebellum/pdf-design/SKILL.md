---
name: pdf-design
description: "The document design manual. Call pdf_design BEFORE authoring any PDF, report, brief, proposal, or styled document — it is what makes documents come out designed instead of dumped."
triggers:
  - pdf design
  - document design
  - report
  - proposal
  - brief
  - whitepaper
  - one-pager
  - styled document
tools:
  - name: pdf_design
    readOnly: true
    description: "Load the full document design manual into context. Call this BEFORE writing the HTML for any PDF or styled document a person will read — reports, briefs, proposals, guides, summaries, one-pagers. Returns the complete system — pipeline, page architecture, type scale, color rules, the component kit, chart rules, RTL/Arabic, density planning, and the mandatory render-verify loop. Skip only when the user or an automation prompt fully specifies the design (explicit instructions always win over the manual)."
    parameters:
      document:
        type: string
        required: false
        description: "One line naming the document you are about to design — stating it commits you to following the manual."
---

# PDF Design

A core capability. Its one tool, `pdf_design`, returns the document design manual: the
page-map planning step, fixed-sheet page architecture, the type scale, the color
system (one accent, light body pages, semantic-only status colors), the component kit
(cover, TOC, section openers, running footers, stat tiles, hairline tables, callouts,
provenance pills, steps), chart rules (inline SVG via the `dataviz` kit), RTL/Arabic
rules, the density/length calibration, the mandatory `pdf_render_pages` verify loop,
and the failure catalog.

The manual itself lives in `manual.md` beside this file; the plugin reads and returns
it. The core contract (`agents.core.md`) tells you to call `pdf_design` before
authoring any document — this capability is what delivers it. Explicit user or
automation design instructions always take precedence over the manual.
