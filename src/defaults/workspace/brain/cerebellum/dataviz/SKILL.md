---
name: dataviz
description: "The data visualization manual. Call dataviz BEFORE creating any chart, graph, or data display — interactive chart cards in the app (.chart.json), SVG charts inside PDFs, or channel fallbacks."
triggers:
  - chart
  - graph
  - plot
  - visualization
  - visualize
  - data viz
  - dashboard
  - bar chart
  - line chart
  - pie chart
tools:
  - name: dataviz
    readOnly: true
    description: "Load the full data visualization manual into context. Call this BEFORE creating any chart, graph, plot, or data display on any surface — the interactive .chart.json chart card in the app chat, hand-authored SVG charts inside PDF/HTML documents, or table fallbacks on channels. Returns the form-choice heuristic, the fixed validated palette, the chart-card spec, SVG print recipes, and the failure catalog. Skip only when the user fully specifies the chart's design."
    parameters:
      data:
        type: string
        required: false
        description: "One line naming the data you are about to visualize — stating it commits you to following the manual."
---

# Dataviz

A core capability. Its one tool, `dataviz`, returns the data visualization manual:
choose the form by the data's job (and when NOT to chart), assign series colors from
the fixed validated palette slots in order, author interactive chart cards for the
in-app chat by writing a `.chart.json` spec and delivering it with `send_file`,
hand-author inline-SVG charts for documents rendered to PDF (exact geometry recipes),
and fall back to aligned tables on WhatsApp/Telegram.

The manual itself lives in `manual.md` beside this file; the plugin reads and returns
it. The core contract (`agents.core.md`) tells you to call `dataviz` before any chart
work — this capability is what delivers it. The interactive card renders in-app from
any delivered file whose name ends in `.chart.json`.
