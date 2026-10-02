---
name: web-design
description: "The web design manual. Call web_design BEFORE authoring any HTML page, info site, or web deliverable a person will open in a browser — it is what makes pages come out designed instead of dumped."
triggers:
  - web design
  - website
  - web page
  - webpage
  - html page
  - info site
  - docs site
  - microsite
  - landing page
  - interactive report
  - one-pager
tools:
  - name: web_design
    readOnly: true
    description: "Load the full web design manual into context. Call this BEFORE writing the HTML for any web page or site a person will open in a browser — guides, handbooks, field manuals, info sites, reports-as-pages, one-pagers. Returns the complete system — treatment calibration, section-map planning, the rail-and-column architecture, dual light/dark theme tokens, type voices, the component kit, SVG figure rules, the JS-as-enhancement doctrine, RTL/Arabic, and the mandatory screenshot verify loop. Skip only when the user or an automation prompt fully specifies the design (explicit instructions always win over the manual)."
    parameters:
      page:
        type: string
        required: false
        description: "One line naming the page you are about to design — stating it commits you to following the manual."
---

# Web Design

A core capability. Its one tool, `web_design`, returns the web design manual: the
treatment-calibration and section-map planning steps, the rail-and-column page
architecture, dual light/dark theme tokens (system preference plus toggle override),
type voices built from system font stacks, the component kit (cover plate, index
rail, notes, figure plates, hairline tables, pills, card grids, Q&A, steps,
checklists), hand-drawn SVG figure rules, the JS-as-enhancement doctrine (pages must
read complete with scripts off), RTL/Arabic rules, and the mandatory
`browser_screenshot` + `image_view` verify loop.

The manual itself lives in `manual.md` beside this file; the plugin reads and returns
it. The core contract (`agents.core.md`) tells you to call `web_design` before
authoring any web page — this capability is what delivers it. Explicit user or
automation design instructions always take precedence over the manual. Documents
meant to print or ship as a PDF are `pdf_design`'s job, not this capability's.
