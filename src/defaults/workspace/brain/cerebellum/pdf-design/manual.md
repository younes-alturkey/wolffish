# The Document Design Manual

You are about to produce a document a person will read and judge. This manual is the
difference between a designed document and a rendered webpage. Follow it whenever you
author a PDF, report, brief, proposal, guide, summary, one-pager, or any styled
document — unless the user or an automation prompt already specifies the design. A
live page meant to be read in a browser rather than printed — an info site, a
scrollable handbook — is `web_design`'s job; this manual governs paged output.

**Precedence — read this first.**
1. **Explicit instructions win.** If the user or the automation/procedure prompt
   specifies a layout, palette, structure, or look ("minimal", "one page, just the
   list", "match our brand", a template they described), follow it exactly. Instructed
   formats that already work must keep working — do not "upgrade" them.
2. **Everything unspecified falls to this manual.** When the request is open ("make me
   a PDF about X", "put this in a report"), this system is the default, every time.
3. This is a system, not a template. Section 10 tells you what to vary per document so
   outputs don't all look identical — and what must never vary.

---

## 1. The pipeline — exact steps, in order

1. **Plan the document** (section 2): content inventory → page map. Do this before any HTML.
2. **Author one self-contained HTML file** in the workspace (e.g. `files/report.html`).
   System fonts only, no external URLs, no `<script>`. Charts are inline SVG (call
   `dataviz` for the chart kit before authoring any data display).
3. **Open the page and run the fit audit** (section 9.1) — `browser_navigate` to the
   absolute `file:///…/report.html`, then `browser_evaluate` (or `ext_execute_js`) the
   audit snippet. It returns a fill percentage per sheet. **Fix every sheet it flags
   before you render anything.** This step is not optional and not replaceable by
   looking at the page; it takes one call and it is the only thing that reliably
   catches both overflow and dead space.
4. **Render:** `browser_pdf` (or `ext_pdf`) with `output_path` and `format: "A4"`
   (or `"Letter"`). The renderer prints **full bleed — zero page margin**; your CSS
   controls every millimeter. `print_background` stays on (default).
5. **Look at it — mandatory for anything over 2 pages** (section 9.2): confirm the page
   count equals your sheet count, then `pdf_render_pages` and `image_view` the cover, a
   dense page, any chart page, and the last page. Never deliver a document you have not
   seen.
6. **Deliver:** `send_file` the `.pdf`. `browser_pdf` does not auto-deliver.

## 2. Plan before HTML — the page map

Blank space and cramming both come from skipping this step. Before writing markup:

- **Inventory the content:** every section, table, figure, number, list you will include.
- **Assign pages:** write a one-line job for each page ("p1 cover · p2 TOC · p3 verdict +
  stat row · p4 pricing table + callout…"). Every page must have a job.
- **Budget honestly.** A page holds roughly: 550–650 words of body text, or a
  full-width table of 8–12 rows plus a paragraph and a callout, or two chart cards
  plus a stat row, or one section opener (headline + lead + one major component).
  If a page's assigned content is under ~60% of that, merge it into a neighbor or
  enrich it. If it's over, split it.
- **Calibrate length to the ask.** A quick summary: 1–2 pages, no cover. A standard
  report: cover + 4–10 content pages. A deep guide: cover + TOC + 12–30 pages +
  sources. Never pad to look thorough; never cram to fit a guess.

## 3. Page architecture — sheets, not flow

Designed documents use **fixed sheets**: each page is an explicitly composed box. This
is what gives you page numbers, footers, zero dead space, and total placement control.

The sheet is a **flex column with three parts**: a fixed-height box, a body that flexes
and clips, and the footer as a real in-flow element at the end. Write it exactly this
way — the reasoning is in the two traps below, and both of them have shipped broken
documents.

```css
@page { size: A4; margin: 0; }
* { box-sizing: border-box; margin: 0; padding: 0; }
html, body { margin: 0; padding: 0; background: #ffffff;
  -webkit-print-color-adjust: exact; print-color-adjust: exact; }
.sheet {
  width: 210mm; height: 297mm;      /* Letter: 8.5in × 11in — match the format arg exactly */
  overflow: hidden; position: relative;
  break-after: page;
  background: var(--paper);
  padding: 14mm 16mm 10mm;
  display: flex; flex-direction: column;   /* ← the footer rides at the end of this column */
}
.sheet:last-child { break-after: auto; }
.sheet-body {
  flex: 1 1 auto; min-height: 0;    /* min-height:0 lets the body shrink instead of pushing */
  overflow: hidden;
  display: flex; flex-direction: column; gap: 18px;
}
```

- **One `.sheet` per page, and every child of it goes inside `.sheet-body`** — except
  the footer, which is the sheet's last child and a sibling of the body.
- **Content that does not fit is clipped at the body's edge, above the footer.** That is
  a loss, but never a collision. The fit audit (section 9.1) tells you it happened.
- **A stray blank page between sheets** means something pushed a sheet past 297mm:
  an outer margin on `.sheet`, a border adding height without `border-box`, or a
  `<br>` after the last sheet. Sheets never carry outer margins.
- **Every content sheet carries the running footer** (section 5.4). The cover and an
  optional dark back page are the only exceptions.
- **Keep sheet layout out of `@media print`.** The audit measures the screen layout; if
  print layout differs, the numbers are lies.
- **Flow mode — the fallback, not the default.** For a long, uniform, text-dominant
  document (an essay, a transcript, a legal text) a single flowing container with
  `break-inside: avoid` blocks and `break-before: page` on top-level sections is
  acceptable. Even then: paint `html, body` background, keep every block's vertical
  margin, and keep headings glued to their content (`h1,h2,h3 { break-after: avoid; }`).
  If the document has stat rows, figures, or varied components — use sheets.

**Trap 1 — bottom padding reserves nothing.** `padding: 14mm 16mm 20mm` looks like it
holds a 20mm footer band clear. It does not. Under `overflow: hidden` a block's content
flows straight through its own bottom padding and is only clipped at the sheet's outer
edge — so the last paragraph prints *underneath* an absolutely-positioned footer, text
over text. The reserved band is a comment, not a mechanism. The flex column above is
the mechanism.

**Trap 2 — never "fix" clipping by letting the sheet grow.** When content is clipped,
the tempting repair is `min-height: 297mm; height: auto; overflow: visible`. This is
worse, and it is the single most common way these documents break. The sheet grows past
the page, Chromium paginates it, and an absolutely-positioned footer — pinned to the
*grown sheet*, not the page — lands in the middle of the spill page, printed across the
body text, while the page it belonged to has no footer at all. If a sheet overflows, the
answer is always less content on that sheet, never a taller sheet.

## 4. Foundations

### 4.1 Type scale (A4; values in px — do not improvise sizes)

| Role | Spec |
|---|---|
| Display (cover title) | 40–44px / 1.08 / weight 800 / letter-spacing -0.02em / max 3 lines |
| Page headline (H1) | 26–28px / 1.15 / 760 / -0.015em — one per section opener |
| Section head (H2) | 16.5px / 1.3 / 700 |
| Sub-head (H3) | 13px / 1.35 / 700 |
| Body | 13.5px / 1.6 / 400 — text columns max-width 620px, never full sheet width |
| Lead paragraph | 15px / 1.55 / 430 — first paragraph under a page headline only |
| Small / table text | 12.5px / 1.5 |
| Caption / footnote | 10.5px / 1.45, muted |
| Eyebrow / label | 10px / 700 / UPPERCASE / letter-spacing 0.14em |
| Running footer | 8.5px / 600 / UPPERCASE / letter-spacing 0.12em, muted |
| Stat value | 30–34px / 1 / 800 — unit rides in a 55%-size span, not full size |

Font stacks — system only, never a webfont URL:

```css
--font-sans: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
--font-arabic: "SF Arabic", "Geeza Pro", "IBM Plex Sans Arabic", "Segoe UI", Tahoma, sans-serif;
```

Numbers that sit in columns (tables, TOC page numbers) get
`font-variant-numeric: tabular-nums`. Large standalone numbers (stat values) do NOT —
proportional figures look right at display sizes.

### 4.2 Color system

Define once, use everywhere. **Pick a theme from `themes.md` beside this manual** —
eight complete, contrast-tested palettes (Steel, Teal, Forest, Indigo, Plum, Claret,
Rust, Graphite), each a full token set that drops into this same component kit. Steel
is the house default and always safe; the others exist so that documents on different
subjects do not all arrive looking like the same blue report. Choose from the subject,
not from novelty, and read `themes.md` before inventing a palette of your own — it also
carries the rules for deriving one when a brand colour demands it.

The Steel tokens, for reference:

```css
:root {
  --paper:   #ffffff;
  --ink:     #16202e;   /* near-black, hue-shifted toward the accent — never pure #000 */
  --ink-2:   #3d4a5c;   /* secondary text */
  --muted:   #64748b;   /* captions, labels, footers */
  --hairline:#e2e6eb;   /* every rule and border */
  --accent:  #1d4ed8;   /* the ONE accent — subject-appropriate, swap per document */
  --accent-deep: #16307a;  /* dark variant: cover grounds, emphasis text */
  --wash:    #eef2fb;   /* accent tinted to ~5% — callout and tile grounds */
  --good:    #166534;  --warn: #b45309;  --bad: #b91c1c;   /* semantic ONLY */
}
```

**Binding rules:**
- **Body pages are light. Always.** Dark grounds are allowed on the cover, optional
  section-divider pages, and an optional back page — never on content pages. A dark
  content page is a rendering liability and reads as a slide, not a document.
- **One accent.** Tints and the deep variant of the same hue are free; a second hue is
  not. The semantic trio (`--good/--warn/--bad`) appears only where meaning demands it
  — a verdict, a delta, a risk level — never as decoration and never as "the color of
  tile #3". If a number is not good or bad, it is ink.
- **No gradient text, ever.** `background-clip: text` prints as a solid block.
  Gradients are legal only as large, quiet surface treatments (a cover ground, a hero
  band) — subtle, two close shades, never neon.
- **No emoji anywhere** — not in headings, not as icons, not as bullets. Rendered
  emoji glyphs in a document read as chat, not print. Structure carries the hierarchy.
- Hairlines everywhere borders are needed: 1px `--hairline`. Heavy borders and drop
  shadows don't print well and look dated; use space and rules instead.

### 4.3 Spacing

4px base grid. Between components: 18–24px. Section opener block (eyebrow + headline +
lead) to first component: 20px. Inside components: 12–16px padding.

**Leftover air is a content problem, not a CSS problem.** This is the rule that decides
what to do with a page that does not fill, and it is where most of these documents go
wrong. The fit audit (section 9.1) gives you a fill percentage per sheet; act on it:

| Fill | What to do |
|---|---|
| **88–100%** | Ship it. |
| **70–88%** | Grow the content on that page — extend a callout to its real argument, add the "what it tells you" column to the table, promote a fact to a stat tile or a pull quote, or pull the first block of the next page up. |
| **under 70%** | The page map is wrong. Merge the page with a neighbour, or re-split the section. Do not decorate the gap. |

Growing a page means adding **substance** — the sentence the callout was missing, the
column that explains what a row means, the number that was sitting in your notes. If
there is nothing true left to say on that page, it does not need growing, it needs
merging. Padding a page to hit a number is worse than the gap it hides.

Two things that look like fixes and are not:

- **`justify-content: space-between` on the body.** It does not distribute air, it
  *concentrates* it — one dead half-page becomes three craters between components, which
  reads as a layout bug rather than as space.
- **Stretching the component gap to absorb the remainder.** Beyond about 28px the gap
  stops reading as rhythm and starts reading as an accident, and a computed stretch is
  one arithmetic slip away from pushing half the page's content out through the clip.
  The gap may vary between 18px and 28px. Nothing beyond that.

## 5. The component kit — exact recipes

Build pages from these. Each is print-safe and matches the type scale above.

### 5.1 Cover (the first impression — spend effort here)

Structure top-to-bottom: brand mark → (space) → eyebrow → display title →
standfirst → (space) → meta row → fine print. Two variants:

**Dark cover** (reports, strategy docs, anything with weight): ground in
`--accent-deep` to near-ink gradient (`linear-gradient(155deg, #0f1b33, #16307a)` style
— two close dark shades), white text, one large quiet geometric element at low opacity
(a 40vw circle outline, a diagonal band) for depth. Never busy art, never stock-photo
feel, never a wall of icons.

**Light cover** (briefs, summaries, friendly docs): `--paper` ground, ink title,
a single accent rule or block, generous white space.

```html
<div class="sheet cover">
  <div class="brand"><span class="brand-chip">W</span> WOLFFISH <span class="brand-light">RESEARCH</span></div>
  <div class="cover-body">
    <div class="eyebrow">MARKET BRIEF · JULY 2026</div>
    <h1 class="display">The title, stated like a finding, not a topic.</h1>
    <p class="standfirst">Two lines that tell the reader what this document will do
    for them — the scope, the stakes, and the payoff of reading it.</p>
  </div>
  <div class="cover-meta">
    <div><div class="meta-label">PREPARED FOR</div><div class="meta-value">Name</div></div>
    <div><div class="meta-label">DATE</div><div class="meta-value">July 31, 2026</div></div>
    <div><div class="meta-label">SCOPE</div><div class="meta-value">Three · Word · Scope</div></div>
  </div>
  <p class="fineprint">Sources and provenance note. Estimates labeled as such.</p>
</div>
```

```css
.cover { display: flex; flex-direction: column; }
.brand { display: flex; align-items: center; gap: 8px; font-weight: 800;
  letter-spacing: 0.18em; font-size: 13px; }
.brand-chip { display: inline-flex; align-items: center; justify-content: center;
  width: 30px; height: 30px; border-radius: 8px; background: var(--accent);
  color: #fff; font-size: 15px; letter-spacing: 0; }
.brand-light { font-weight: 400; opacity: 0.75; }
.cover-body { margin-top: auto; margin-bottom: auto; max-width: 150mm; }
.display { font-size: 42px; line-height: 1.08; font-weight: 800; letter-spacing: -0.02em; }
.standfirst { font-size: 15.5px; line-height: 1.55; margin-top: 16px; opacity: 0.92; }
.cover-meta { display: flex; gap: 40px; border-top: 1px solid var(--hairline);
  padding-top: 14px; }
.meta-label { font-size: 9px; font-weight: 700; letter-spacing: 0.14em; opacity: 0.65; }
.meta-value { font-size: 12.5px; font-weight: 650; margin-top: 3px; }
.fineprint { font-size: 9px; line-height: 1.5; opacity: 0.55; margin-top: 12px; }
```

On the dark variant the hairline becomes `rgba(255,255,255,0.18)` and **every text
element is white**, dimmed with `opacity` where it should recede. Never reach for an
ink token on a dark ground: `--ink-2` or `--muted` over a dark cover is the
unreadable-standfirst failure, and it survives review because the text is still
technically there.

The cover is a fixed sheet like any other. `.cover-body { margin: auto 0 }` centres the
title block, which means the meta row and fine print are pushed down by whatever the
title needs — on a long title they reach the bottom edge and the fine print collides
with the meta row or is clipped away. Cap the title block (`max-width: 150mm`, three
lines) and audit the cover with the rest (section 9.1).

The title states a **finding or promise**, not a topic label ("A $50B market forming at
46% a year", not "Market Analysis").

### 5.2 Table of contents

A numbered table, not a bullet list.

**Size the TOC by its entry count, not by the document's page count.** How many pages
the document runs tells you whether readers need to navigate it; how many *sections* it
lists is what decides whether the TOC fills a page. A 30-page document with six big
sections has a thin TOC; a 12-page document with 25 sections has a full one.

Measured against a 1013px A4 body with a normal page heading above the list:

| Entries | Arrangement | Page |
|---|---|---|
| under ~15 | one column | Cannot fill a page in any arrangement — **share the page** (see below) |
| ~15–22 | one column **+ a descriptor line per entry** | Own page (18 entries ≈ 98%) |
| ~23–28 | one column, titles only | Own page (27 entries ≈ 95%) |
| ~29–50 | **two columns**, titles only | Own page; expect 60–80% at the low end — group into parts rather than stretching |
| over ~50 | two columns, titles only | Own page, full |

- **One column is the default.** Two columns is the remedy for a list that would
  *overflow* — around 29 entries — not a default for "more than a handful". Splitting a
  short TOC into two columns halves its height and doubles the dead space: nine entries
  go from 41% of a page to 30%.
- **The descriptor line is the density lever.** When a TOC is short of a full page, give
  each entry a one-line "what you get from this section" under the title before you
  touch columns or spacing. It fills the page with navigation, which is the TOC's job.
- **A TOC under ~15 entries shares its page** with the material that otherwise has no
  home: a short "how to read this", the provenance key (what ESTIMATE / DOCUMENTED /
  WEAK EVIDENCE mean on the pills), or the section-numbering key. A half-empty
  contents page is the dead-page failure wearing a formal hat.

```css
.toc { width: 100%; border-collapse: collapse; }
.toc td { padding: 7px 0; border-bottom: 1px solid var(--hairline);
  font-size: 12.5px; vertical-align: top; }
.toc .n { color: var(--accent); font-weight: 700; width: 28px;
  font-variant-numeric: tabular-nums; }
.toc .p { text-align: right; color: var(--muted); width: 30px;
  font-variant-numeric: tabular-nums; }

/* the descriptor line — the density lever in the table above.
   The entry counts quoted there were measured at exactly this size. */
.toc td .d { display: block; font-size: 10.5px; line-height: 1.4;
  color: var(--muted); margin-top: 2px; }

/* two columns — only past ~29 entries. Two tables, not one table split. */
.toc-2 { display: grid; grid-template-columns: 1fr 1fr; gap: 0 28px; }
```

```html
<tr><td class="n">03</td>
    <td>The head-to-head comparison<span class="d">What your dose looks
        like against cigarettes, gum and the patch.</span></td>
    <td class="p">7</td></tr>
```

Page numbers in the TOC must match reality — fill them in AFTER the verify pass.

### 5.3 Section opener (every major section)

Numbered chip + eyebrow, then the headline, then a 1–3 sentence lead. The number is
justified only when sections form a real sequence; otherwise use the eyebrow alone.

```css
.sec-tag { display: flex; align-items: center; gap: 10px; margin-bottom: 14px; }
.sec-num { background: var(--accent-deep); color: #fff; font-size: 10px;
  font-weight: 700; padding: 3px 8px; letter-spacing: 0.1em; }
.sec-eyebrow { font-size: 10px; font-weight: 700; letter-spacing: 0.14em;
  color: var(--muted); text-transform: uppercase; }
.headline { font-size: 27px; line-height: 1.15; font-weight: 760;
  letter-spacing: -0.015em; max-width: 130mm; }
.lead { font-size: 15px; line-height: 1.55; margin-top: 12px; max-width: 620px; }
.lead strong { font-weight: 700; }
```

### 5.4 Running footer (every content sheet)

The footer is the sheet's **last in-flow child**, a sibling of `.sheet-body` — never
absolutely positioned. That is what makes it unreachable by body content (section 3).

```css
.footer { flex: none; margin-top: 10px;
  display: flex; justify-content: space-between; align-items: baseline;
  border-top: 1px solid var(--hairline); padding-top: 6px;
  font-size: 8.5px; font-weight: 600; letter-spacing: 0.12em;
  color: var(--muted); text-transform: uppercase; }
```

```html
<div class="sheet">
  <div class="sheet-body"> … everything on the page … </div>
  <div class="footer"><span>DOCUMENT TITLE</span><span>4</span></div>
</div>
```

Left: document title. Right: the page number (plain, sequential, matching the sheet
order). No footer on the cover.

### 5.5 Stat tiles (the number row)

Top-border tiles on a wash ground — never centered rounded cards, never a different
random color per tile.

```html
<div class="stat-row">
  <div class="stat"><div class="stat-v">$52.6<span class="u">B</span><sup>16</sup></div>
    <div class="stat-c">AI-agents market by 2030, from $7.8B in 2025 — about 46% CAGR</div></div>
  …3–4 tiles per row…
</div>
```

```css
.stat-row { display: grid; grid-template-columns: repeat(4, 1fr); gap: 14px; }
.stat { border-top: 3px solid var(--accent-deep); background: var(--wash);
  padding: 12px 14px 13px; }
.stat-v { font-size: 30px; font-weight: 800; line-height: 1; color: var(--ink); }
.stat-v .u { font-size: 55%; font-weight: 750; margin-left: 1px; }
.stat-v sup { font-size: 9px; color: var(--muted); font-weight: 600; }
.stat-c { font-size: 10.5px; line-height: 1.45; color: var(--ink-2); margin-top: 7px; }
```

The caption explains what the number IS and why it matters — never a bare label. A
delta or verdict inside a tile may use `--good`/`--bad`; the value itself stays ink.

### 5.6 Tables (the workhorse — get these perfect)

Hairline system: uppercase letter-spaced column heads, a stronger rule under the
header, 1px rules between rows, no vertical rules, no zebra stripes, no fills.

```css
table.data { width: 100%; border-collapse: collapse; font-size: 12.5px; }
.data th { text-align: left; font-size: 9.5px; font-weight: 700;
  letter-spacing: 0.1em; text-transform: uppercase; color: var(--muted);
  padding: 0 10px 7px 0; border-bottom: 1.5px solid var(--ink); }
.data td { padding: 9px 10px 9px 0; border-bottom: 1px solid var(--hairline);
  vertical-align: top; line-height: 1.45; }
.data td.num { text-align: right; font-variant-numeric: tabular-nums; }
.data td strong { font-weight: 700; }
```

- First column: the entity (bold when it's the anchor). Numeric columns right-aligned.
- Keep cell text tight; move explanation into a "what it tells you" column rather than
  bloating every cell.
- A table that would exceed its sheet splits at a row boundary and repeats its header
  on the next sheet. Never let `overflow: hidden` eat rows — budget rows per page
  (roughly 10–14 data rows per full-width table page).

### 5.7 Callouts (insight, warning, verdict)

Left-border + wash. The label states the KIND of note; the color follows meaning.

**The accent callout is tinted. Semantic callouts are not.** A good/warn/bad callout
sits on paper inside a hairline box, with the semantic colour on the left rule and the
label. This is structural, and it is not a style preference: a tinted semantic ground
and the accent wash are the same colour to the eye in most themes — on a green-accented
document a "good news" panel and an ordinary accent note become literally
indistinguishable. Separating them by *shape* instead of hue makes the collision
impossible in every palette, present and future.

```css
.callout { border-left: 3px solid var(--accent); background: var(--wash);
  padding: 12px 16px; max-width: 100%; }
.callout .label { font-size: 9.5px; font-weight: 700; letter-spacing: 0.12em;
  text-transform: uppercase; color: var(--accent-deep); margin-bottom: 6px; }
.callout p { font-size: 12.5px; line-height: 1.55; }

/* semantic: paper ground + hairline box + coloured rule.
   In an RTL document write every `border-left` here as `border-inline-start`
   (section 7) — otherwise the rule lands on the wrong side of the box. */
.callout.good, .callout.warn, .callout.bad {
  background: var(--paper); border: 1px solid var(--hairline); }
.callout.good { border-left: 3px solid var(--good); }
.callout.good .label { color: var(--good); }
.callout.warn { border-left: 3px solid var(--warn); }
.callout.warn .label { color: var(--warn); }
.callout.bad  { border-left: 3px solid var(--bad); }
.callout.bad  .label { color: var(--bad); }
```

Two callouts side-by-side in a 2-column grid is a strong page-bottom move. Never stack
three callouts of the same kind — merge them.

### 5.8 Provenance pills (label estimates and claims)

When a document carries researched or modeled numbers, mark provenance at the claim:

```css
.pill { display: inline-block; border: 1px solid currentColor; border-radius: 999px;
  font-size: 8.5px; font-weight: 700; letter-spacing: 0.08em; padding: 1.5px 8px;
  vertical-align: 1px; }
.pill.estimate { color: var(--warn); }  .pill.reported { color: var(--muted); }
```

Use sparingly — superscript source numbers (`<sup>21</sup>`) pointing to a sources page
are the default for cited figures; pills are for ESTIMATE / REPORTED / OPINION class
labels. A document whose numbers came from research includes a sources page. Weight
the provenance effort by how far a number will travel: figures a reader is likely to
quote onward — prices, market sizes, benchmarks, anything decision-bearing — earn a
marker at the claim and a home in the sources block; incidental numbers don't need
the ceremony. Your judgment on where that line falls.

### 5.9 Numbered steps / ranked lists

```css
.step { display: flex; gap: 12px; padding: 10px 0; }
.step-n { flex: none; width: 22px; height: 22px; border-radius: 50%;
  background: var(--accent-deep); color: #fff; font-size: 11px; font-weight: 700;
  display: flex; align-items: center; justify-content: center; }
.step-body { font-size: 12.5px; line-height: 1.5; }
.step-body strong { display: block; font-size: 13px; margin-bottom: 2px; }
```

### 5.10 Two-column layouts

`display: grid; grid-template-columns: …; gap: 18px;` — for chart + stat stack,
text + callout, paired comparisons. Never more than two text columns on A4. When one
column is a chart card and the other is tiles, align their tops.

### 5.11 Quotes, timelines, comparisons

- **Pull quote:** 17px / 1.45 / 600 italic, accent left rule, attribution in caption style.
- **Timeline row:** a 4–6 column grid of eyebrow (date) + small text cells over a 1px
  hairline with accent dots — for roadmaps.
- **Comparison (A vs B):** two bordered panels, one on `--accent-deep` ground (white
  text) and one on wash — for "us vs them", "before vs after".

## 6. Charts inside documents

**Before authoring any data display — a chart, a big-number row, a comparison — call
`dataviz` and follow its manual.** Binding rules that apply in every document:

- Charts in print are **inline SVG, hand-authored** — never `<canvas>`, never a JS
  library, never an external image for a chart you can draw.
- Every chart lives in a **chart card**: 1px hairline border, 6px radius, 16px padding,
  title (12.5px / 700), unit subtitle (10.5px muted), the SVG, and a source/method
  footnote (9.5px muted, hairline-separated). No naked SVGs floating in text.
- The form follows the data's job (the dataviz manual's first table). If the story is
  a single number, that's a stat tile, not a chart. If it's more than ~7 series,
  that's a table.
- Series colors come from the dataviz palette slots in order — never invented per
  chart. Axis text and labels wear text colors, never series colors. Gridlines are
  solid 1px hairlines, 3–5 of them, never dashed.
- Direct-label the marks when there are few (≤ 8 labeled points); use the axis when
  there are many. Every chart names its unit somewhere ("$ billions", "% of pilots").

## 7. Right-to-left and Arabic documents

When the document language is Arabic (or the user's automation is Arabic-first):

- `<html dir="rtl" lang="ar">`, `--font-arabic` stack on `body`.
- **Zero letter-spacing on Arabic text** — tracking breaks the connected script.
  Eyebrows and footers drop `letter-spacing` and carry hierarchy with size + weight +
  color instead.
- Mirror directional components: `border-left` → `border-inline-start` (write it that
  way from the start), numbered chips and meta rows flow right-to-left automatically
  under the grid — verify alignment in the render pass.
- Keep digits Latin (`1,234`) unless the user asks for Eastern Arabic numerals; keep
  tabular alignment.
- Type sizes: Arabic needs +0.5–1px on body sizes for equal optical weight (body 14px,
  table 13px).

## 8. Length, density, and the minimal document

- **A one-pager is a real format.** Single sheet, no cover, brand line at top, tight
  stat row, one table or chart, footer. Density high, margins honest.
- **A 2–4 page brief:** light cover treatment on page 1 (brand + title + standfirst in
  the top third, content starts same page) — a full cover page would be padding.
- **A full cover page earns itself at ≥ 8 content pages.**
- **A TOC earns itself when the reader will navigate rather than read straight through**
  — a reference document, a guide, anything with sections someone returns to. Its
  *shape* then follows the entry count in section 5.2, and a short one shares its page
  rather than sitting alone at 40%.
- Prose-only pages are a smell in reports: most pages should carry at least one
  structural component (tiles, table, chart, callout, steps). In essays and narrative
  documents, prose pages are fine — use pull quotes and section openers for rhythm.

## 9. Verify before delivering — mandatory

Two passes, in this order. The first is measurement and catches what eyes miss; the
second is looking and catches what numbers miss. Neither substitutes for the other.

### 9.1 The fit audit — run it on the page, before you render

A sheet's body clips silently, and a page that is one-third empty looks perfectly
composed in a thumbnail. Looking at rendered pages does not reliably catch either — a
document can survive three render-and-look cycles and still ship content printed
across its own footers. So measure. Navigate to the HTML, then `browser_evaluate`
(or `ext_execute_js`):

```js
[...document.querySelectorAll('.sheet')].map((s, i) => {
  const b = s.querySelector('.sheet-body');
  if (!b) return { page: i + 1, error: 'no .sheet-body' };
  const r = b.getBoundingClientRect();
  let ink = r.top;
  b.querySelectorAll('*').forEach(el => {
    const q = el.getBoundingClientRect();
    if (q.height > 0 && q.bottom > ink) ink = q.bottom;
  });
  const kids = [...b.children].filter(e => e.getBoundingClientRect().height > 0);
  let gap = 0;
  for (let j = 1; j < kids.length; j++) {
    const g = kids[j].getBoundingClientRect().top - kids[j - 1].getBoundingClientRect().bottom;
    if (g > gap) gap = g;
  }
  return { page: i + 1,
           fill: Math.round((ink - r.top) / r.height * 100),
           clipped: Math.round(Math.max(0, ink - r.bottom)),
           maxGap: Math.round(gap) };
})
```

Read the result per sheet:

- **`clipped` greater than 0** — content is being eaten. Move it to the next sheet or
  cut it. Never grow the sheet (section 3, trap 2).
- **`fill` under 88** — act on the table in section 4.3.
- **`maxGap` over about 40** — a crater between two components. Something is stretching
  that should not be.

A sheet reporting `error: 'no .sheet-body'` is either the cover (expected — it composes
itself, section 5.1) or a sheet you forgot to wrap.

Fix, reload, re-audit until **no sheet clips and no sheet is under 70**. Sheets in the
70–88 band are not failures, they are the "grow the content" row of the table in
section 4.3 — work them down the list as far as the material honestly allows, then
ship. Only then render.

> Measure the thing you will print. The audit reads the live layout, which is why
> section 3 forbids putting sheet layout inside `@media print` — if the two differ,
> these numbers describe a page that never gets printed.

Both eval tools are approval-gated, so this step asks the user once per document. That
is expected, not an error: say what you are measuring and why in the same breath. It is
one prompt against a document that prints its own text across its footers, and it is
the cheapest check in this manual. If the user declines, say plainly in the delivery
that the document was not audited and which pages you are unsure of.

### 9.2 Look at the pages

1. Check the PDF's page count equals your sheet count. A mismatch means a sheet grew
   past its page — the footer on that page is now in the wrong place (section 3).
2. `pdf_render_pages` on the cover, one dense mid-document page, any page with a chart,
   and the last page. `image_view` each.
3. Checklist — fix and re-render if ANY fails:
   - Nothing clipped at a sheet edge; nothing touching or overlapping the footer.
   - Footers present, sequential, and one per page; TOC page numbers match reality.
   - Charts: bars/lines inside the plot area, labels not colliding, palette correct.
   - Contrast: no light-gray-on-white body text; captions legible.
   - An accent callout and a semantic callout are still telling each other apart.
   - Arabic/RTL: alignment mirrored, nothing letter-spaced.
4. Only then `send_file`.

One audit-fix cycle is expected; two is fine; if a third is needed, simplify the
failing page rather than iterating forever.

## 10. Vary the treatment — never the standards

So documents don't come out identical, choose per document (from the subject, the
audience, and anything the user has shown you):

- **The theme** — pick one of the eight in `themes.md` from the subject. This is the
  biggest single lever on whether two documents look like siblings or like the same
  document twice, and it costs one token block. Steel is the default, not the
  obligation: a health brief is Teal, an audit is Claret, an operations review is Rust.
- **Cover treatment** (dark ground vs light, the geometric motif, its scale).
- **Component mix** (stat-heavy dashboard-brief vs table-heavy comparison vs
  narrative-with-pull-quotes).
- **Density** (dense consultant's deck vs airy executive brief).
- **Structural devices.** Numbered section chips only when the sections are genuinely a
  sequence — a process, a timeline, a ranked list. Numbering an unordered set of topics
  01–09 is decoration wearing the costume of structure; use the eyebrow alone.

What never varies: light body pages, the type scale, hairline discipline, footers with
page numbers, one accent + semantic-only status colors, untinted semantic callouts,
labeled provenance on researched numbers, charts from the dataviz kit, the fit audit
and the verify pass, no emoji, no gradient text, no dead half-pages.

## 11. Failure catalog — if your draft matches one of these, fix it before rendering

1. **The markdown dump:** default `<h1>`/`<table>` styling, no cover, no footer, no
   components — a webpage printed. Apply the kit.
2. **The slide deck:** dark body pages, giant rounded cards, 3 sentences per page.
3. **The dead page:** a page under half full, or a trailing near-empty page. Recompose.
4. **Random rainbow:** each tile/heading its own color; red/green used decoratively.
   One accent; semantic colors only where meaning demands.
5. **The emoji document:** emoji as icons/bullets/heading prefixes.
6. **Gradient-text title:** prints as a colored block. Solid ink or white, always.
7. **The unlabeled number:** stats with no caption, charts with no unit, researched
   figures with no source. Label at the claim.
8. **The 100-character line:** body text spanning the full sheet width. Cap measure
   at ~620px.
9. **The centered document:** everything center-aligned. Documents are left-aligned
   (right-aligned for RTL); centering is for covers and tiles only, sparingly.
10. **The clipped sheet:** content silently eaten at the body's edge — caught only by
    the fit audit you were about to skip. `clipped: 0` on every sheet, or it is not done.
11. **The detached footer:** a sheet allowed to grow past its page, so the footer prints
    across the body text of the following page and the page it belonged to has none.
    Always the result of "fixing" an overflow by loosening the sheet height. Section 3,
    trap 2.
12. **The reserved band that reserves nothing:** trusting `padding-bottom` to hold the
    footer zone clear. It does not; only the flex column does. Section 3, trap 1.
13. **The twin callouts:** an accent callout and a "good news" or "warning" callout with
    the same tinted ground, distinguishable only by a 3px rule most readers will never
    compare. Semantic callouts go on paper in a hairline box. Section 5.7.
15. **The invisible standfirst:** ink-coloured text on a dark cover ground. Present,
    technically legible in a thumbnail, unreadable on paper. White only, dimmed with
    opacity.
16. **The unaudited document:** rendered, glanced at, and sent. Every defect in this
    catalog that involves a measurement — clipping, dead pages, craters — is caught in
    one `browser_evaluate` call and in no other reliable way.
