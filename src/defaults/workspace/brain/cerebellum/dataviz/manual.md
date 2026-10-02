# The Data Visualization Manual

You are about to show data. This manual covers the three surfaces where you do it:
**interactive chart cards in the app chat** (a `.chart.json` file you deliver),
**static SVG charts inside documents/PDFs**, and **channels** (WhatsApp/Telegram,
where neither works and you fall back to tables). The choices — form, palette,
labels — are yours on every chart; this manual is the system you choose within.

**Precedence:** explicit user or automation instructions about a chart's look always
win. Everything unspecified follows this manual.

---

## 1. Choose the form first — sometimes it isn't a chart

The data's job picks the form. Decide this before anything else:

| The data is… | Use | Not |
|---|---|---|
| A single current value (maybe + trend) | A stat tile / big number | A one-bar chart |
| A handful of headline numbers | A stat-tile row | A grouped bar chart |
| A single ratio against a limit | A meter/gauge | A 2-slice pie |
| More than ~7 categories that all matter | A table (or table + chart) | More colors |

If a chart is right, pick the type by what the reader must DO:

| Reader's job | Form |
|---|---|
| Compare magnitudes across categories | column; **horizontal bar** when names are long or items > 6 |
| Trend over time | line; area for a single series |
| Tell distinct series apart | grouped column / multi-line (≤ 4 series comfortably) |
| One series is the story, rest are context | emphasis — the one in accent, the rest gray |
| Part-to-whole | stacked bar, or donut (≤ 6 segments, glance-level only) |
| Above/below a baseline, delta to target | diverging bar from a zero/target line |
| Before → after per item | dumbbell |
| Two measures, correlation | scatter |
| Magnitude over a grid (time × category) | heatmap |
| Stage drop-off | funnel |

One opportunity worth weighing before you settle for a table alone: when the data
contains a cost, size, or performance comparison across a few named options, that
horizontal bar is often the single chart readers remember from the whole document.
A table can still be the right call when precision matters more than shape — your
judgment.

Hard rules, every surface:
- **One y-axis. Never two scales on one plot.** Two measures → two charts or index
  both to 100.
- **Bars grow from zero.** A truncated bar axis lies. (Lines may zoom into a range.)
- **≤ 8 series ever; ≤ 4 for comfort.** Fold the tail into "Other" or split charts.
- **Emphasis beats rainbow:** if the story is one series, gray the others.
- **Never color a bar by its own value** when categories have no order — one series =
  one color for all bars. Ranked/ordered scales may use the sequential ramp.
- **Pie/donut only for part-to-whole at a glance**, ≤ 6 segments, never for comparing
  close values.

## 2. The palette — fixed slots, assigned in order, never invented

Series colors come from these slots **in order 1→8** (skipping is not allowed; the
order is the colorblind-safety mechanism — it was validated, your eyeballs were not):

| Slot | Hue | Light surface / print | Dark surface |
|---|---|---|---|
| 1 | blue | `#2a78d6` | `#3987e5` |
| 2 | orange | `#eb6834` | `#d95926` |
| 3 | aqua | `#1baf7a` | `#199e70` |
| 4 | yellow | `#eda100` | `#c98500` |
| 5 | magenta | `#e87ba4` | `#d55181` |
| 6 | green | `#008300` | `#008300` |
| 7 | violet | `#4a3aa7` | `#9085e9` |
| 8 | red | `#e34948` | `#e66767` |

- **De-emphasis gray** (context series, "Other", unfilled tracks): light `#c9cdd4`,
  dark `#4a4f58`.
- **Sequential** (magnitude ramps, heatmaps): ONE hue light→dark. Blue ramp:
  `#cde2fb → #9ec5f4 → #6da7ec → #3987e5 → #256abf → #184f95 → #0d366b`. A second
  simultaneous ramp uses orange. Never a rainbow ramp.
- **Diverging** (above/below): blue ↔ red arms with a neutral gray midpoint
  (`#f0efec` light / `#383835` dark). Never a hue at the midpoint.
- **Status** (good/warn/serious/critical) is reserved: `#0ca30c` / `#fab219` /
  `#ec835a` / `#d03b3b` — used only when the color MEANS state, always with a label,
  never as "series 4".
- In documents, series colors may be swapped for the document's accent family ONLY in
  single-series charts (one series = the accent). Multi-series charts use the slots.
- **Text never wears a series color.** Labels, values, axis text use ink/muted text
  colors; identity comes from a colored swatch beside the text.

## 3. Interactive chart cards in the app (the default in chat)

When the user is in the app and data deserves a chart, deliver an interactive chart
card: write a **`.chart.json`** spec file, then `send_file` it. The app renders it as
a live chart (tooltips, legend toggling, theme-aware light/dark) with an expand view.

```
file_write  files/revenue-by-quarter.chart.json   ← the spec below
send_file   files/revenue-by-quarter.chart.json   ← renders the card
```

The filename must end in **`.chart.json`** — that suffix is what makes it a chart
card; a plain `.json` renders as a file. Name it like a title, not `chart1`.

### The spec

```json
{
  "type": "column",
  "title": "Quarterly revenue, 2025–2026",
  "subtitle": "$ millions · consolidated",
  "footnote": "Source — internal ledger export, July 2026.",
  "categories": ["Q3 25", "Q4 25", "Q1 26", "Q2 26"],
  "series": [
    { "name": "Product", "data": [4.1, 4.6, 5.2, 6.1] },
    { "name": "Services", "data": [1.2, 1.4, 1.3, 1.8] }
  ],
  "unit": { "prefix": "$", "suffix": "M", "decimals": 1 }
}
```

Field reference (only `type`, `title`, and `series` are required):

| Field | Meaning |
|---|---|
| `type` | `column` `bar` `line` `area` `pie` `donut` `scatter` `heatmap` `radar` `gauge` `funnel` |
| `title` / `subtitle` | Title states the finding or measure; subtitle carries the unit and scope |
| `footnote` | Source / method line under the chart |
| `categories` | X labels (cartesian), indicator names (radar), column labels (heatmap) |
| `yCategories` | Heatmap only — row labels |
| `series[]` | `{ name, data, color?, stack? }` — `color` is a palette slot number 1–8 (rarely needed; slots auto-assign in order), `stack` groups stacked series |
| `series[].data` | Cartesian: numbers (`null` = gap). Scatter: `[x, y]` or `[x, y, size]` pairs. Pie/donut/funnel/gauge: `[{ "name": …, "value": … }]`. Heatmap: `[colIndex, rowIndex, value]` triples |
| `stacked` | `true` stacks all series (columns/bars/areas) |
| `smooth` | `true` for gently curved lines (only when the data is a smooth signal) |
| `unit` | `{ prefix, suffix, decimals, compact }` — formats axis + tooltip values (`compact` renders 12400 as 12.4K) |
| `xAxis` / `yAxis` | `{ name?, min?, max? }` — set `yAxis.max` for gauge range |
| `legend` | Force on/off; default shows it only for 2+ series |
| `height` | Card plot height in px (default 320; 220 for sparkline-ish, 420 for dense) |
| `echarts` | Escape hatch — a raw Apache ECharts option object deep-merged last, for anything the fields above can't express. Use it for reference lines, mark areas, dual-grid layouts, or exotic types |

The card styles everything else — fonts, grid hairlines, bar thickness, tooltips,
light/dark — so a minimal spec comes out right. Don't restyle via `echarts` unless the
user asked for a specific look.

### When to send a chart card

- The user asks for a chart — always.
- You computed or researched a dataset whose shape IS the answer (a trend, a ranking,
  a distribution, a share) — chart it alongside your prose; lead with the finding in
  text and let the chart carry the shape. One good chart beats three.
- "How has X done" over a period is usually a SHAPE question: the strong answer is
  the series over time (a line of 8–30 points you went and fetched), not just the
  endpoint numbers. When you only gathered endpoints, weigh whether the series is
  one search away before settling for a table — your judgment.
- Do NOT chart: two numbers (say them), fewer than 3 data points (a sentence), or
  data the user asked for as a table/CSV.
- A chart card is a delivered file — your prose must still state the headline finding
  (the card supplements the answer, it never replaces it).

## 4. SVG charts inside documents and PDFs

Chart cards do not work in print. Inside HTML→PDF documents you hand-author **inline
SVG**. Wrap every chart in the document's chart-card component (`pdf_design` manual
section 6). Geometry system for a 640×300 chart (scale proportionally):

```
Plot area: left 56 (y-axis labels) · right 16 · top 12 · bottom 34 (x labels)
→ plot = x:56…624, y:12…266
Gridlines: 4–5 horizontal lines at clean tick values, stroke #e2e6eb, width 1, NO dashes
Baseline (zero line): stroke #94a3b8, width 1
Axis text: 10px, fill #64748b; y ticks right-aligned at x=48; x labels centered under slots
Value labels: 10.5px bold, fill ink #16202e
Series legend (2+ series): 10px text + 10×10 rounded-2 swatches, above plot, right-aligned —
build it right-to-left with text-anchor="end" so the last label ends at x=624 and nothing clips the viewBox edge
```

Scale math (write it as comments in the SVG while authoring, delete after):
`y(v) = plotBottom − (v − yMin) / (yMax − yMin) × plotHeight` — pick yMax as the next
clean tick above the data max (e.g. data 52.6 → axis 60, ticks 0/20/40/60).

### Column chart

Bar width 24–44px (wider when few categories), gap ≥ 60% of bar width, centered in
category slots. Rounded top only: `<rect rx="3">` clipped at the baseline — simplest:
`<path d="M x,bottom V y+3 Q x,y x+3,y H x+w-3 Q x+w,y x+w,y+3 V bottom Z">` or a
plain rect with `rx="3"` when bars are tall (the bottom rounding disappears under the
baseline). Value label 4px above each bar top. Grouped: bars in a category sit 4px
apart, groups share one label.

### Horizontal bar (rankings, long names, "price umbrella" comparisons)

Row height 26–34px. Name label left of the bar track (or above it, 10.5px), value at
the bar's right end (inside if it fits with 8px padding, else just outside). Bars
rx=3 on the data end only. The champion move for competitor/price comparisons: gray
context bars + one accent bar for "us".

### Line / area

Line `stroke-width="2"`, `stroke-linejoin="round"`, no markers except endpoints and
the labeled extreme (r=3.5, fill series color, stroke #fff width 2). Area variant:
same line + `<path>` fill of the series color at `fill-opacity="0.10"` down to the
baseline. Label the last point with its value; earlier values live on gridline ticks.

### Donut (part-to-whole, ≤ 6 segments)

Radius outer 80 / inner 52 (a ring, not a pie), segments separated by a 2px white
stroke, ordered largest-first from 12 o'clock. Center shows the total (20px / 800) +
label (9.5px muted). Legend right of the ring: swatch + name + value + share.

### Dumbbell (before → after)

Per row: gray connector line width 2 between two dots r=5 (before = de-emphasis gray,
after = accent), values labeled beside each dot, item name left.

### Print chart rules

- Palette slots from section 2 (light column). Single-series document charts may use
  the document accent instead of slot 1.
- Numbers on marks: label directly when ≤ 8 points; otherwise rely on gridlines.
- Every chart card carries title + unit subtitle + source footnote. The SVG itself
  contains no title (the card provides it).
- `viewBox` + `width="100%"` so the SVG scales to its container; all text as `<text>`
  elements (never foreignObject).
- No animation, no scripts, no external images, no filters/shadows.

## 5. Channels (WhatsApp / Telegram)

Interactive cards can't render there. For data on a channel: state the finding, then
a compact aligned text table (monospace block) or a short ranked list. If the user
explicitly wants a picture, build the chart as a small HTML page and screenshot it
via the browser, sending the PNG — otherwise don't.

## 6. Anatomy standards (all surfaces)

- **Titles state findings** ("Retainer undercuts every incumbent at 1,000 seats"),
  or name the measure plainly ("AI agents market size, 2025 → 2030"). Subtitle
  carries unit + scope. Footnote carries source/method.
- **Legend for 2+ series; none for one** (the title names a single series).
- **Selective direct labels** — the endpoint, the extreme, the series the story is
  about. Never a number on every point of a dense chart.
- **Gridlines recessive:** 3–5 solid hairlines; never dashed; never a full box frame.
- **Clean ticks:** 0 / 20 / 40 / 60, thousands-separated, unit on the tick or in the
  subtitle — never `17.3, 34.6, 51.9`.
- **Sort bars by value** (rankings) or keep natural order (time, stages) — never
  alphabetical when magnitude is the story.
- **Horizontal `bar` chart cards render categories bottom-up** — the first category
  in the list lands at the BOTTOM. For a ranking, list categories smallest-first so
  the largest bar sits on top (or hero-last so it tops the chart).

## 7. Failure catalog — match means fix

1. Two y-axes on one plot → two charts or index to 100.
2. A 9th color, or colors invented per chart → slots in order; fold to "Other".
3. Bar axis not starting at zero → start at zero.
4. Pie with 9 slices / pie for close values → bar chart.
5. A number on every point → selective labels.
6. Dashed gridlines, heavy black axes, boxed frames → recessive hairlines.
7. Value-colored bars on unordered categories → one series, one color.
8. Chart of two numbers → a sentence or stat tiles.
9. Legend restating a single series → remove it.
10. `.chart.json` sent with a bare filename like `chart.json` → name it, and mind the
    required `.chart.json` suffix.
