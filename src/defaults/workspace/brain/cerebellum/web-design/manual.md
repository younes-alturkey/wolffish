# The Web Design Manual

You are about to produce a web page a person will open in their browser and judge.
This manual is the difference between a designed page and a rendered markdown dump.
Follow it whenever you author an info site, guide, handbook, field manual,
report-as-a-page, one-pager, or any HTML deliverable — unless the user or an
automation prompt already specifies the design. A document meant to print or ship as
a PDF is `pdf_design`'s job; this manual is for pages read on a screen.

**Precedence — read this first.**
1. **Explicit instructions win.** If the user or the automation/procedure prompt
   specifies a layout, palette, structure, or look ("minimal", "match our brand",
   "dark only", a template they described), follow it exactly. Instructed formats
   that already work must keep working — do not "upgrade" them.
2. **Everything unspecified falls to this manual.** When the request is open ("make
   me a page about X", "put this guide on a website"), this system is the default.
3. This is a system, not a template. Section 12 tells you what to vary per page so
   outputs don't all look identical — and what must never vary.

---

## 1. The pipeline — exact steps, in order

1. **Plan the page** (section 2): treatment → content inventory → section map. Before any HTML.
2. **Author one self-contained HTML file** in the workspace (e.g. `files/guide.html`).
   Every byte in the file: inline CSS, inline vanilla JS, hand-drawn inline SVG,
   system fonts only. **No CDN, no webfont URL, no external image, no library** —
   the file must work opened from disk, offline, forever, and the in-app preview
   blocks external fetches anyway. Charts: call `dataviz` first (section 6).
3. **Verify — mandatory** (section 11): `browser_launch` headless → `browser_navigate`
   to the `file:///…` path → `browser_screenshot` desktop and mobile, light and dark
   → LOOK at each with `image_view`. Fix, re-shoot. Never deliver a page unseen.
4. **Deliver:** `send_file` the `.html`. The in-app card shows a live sandboxed
   preview — **your scripts do not run there** (and won't for any reader with JS off),
   which is why section 7's rule exists: the page must read complete without them.

## 2. Plan before HTML — treatment, then the section map

**Calibrate the treatment first.** A plan, memo, or throwaway demo wants a
utilitarian treatment: real hierarchy, considered spacing, a proper palette — no
giant hero, no flourishes. A guide someone will keep, share, or hand to their boss
wants the editorial treatment: a cover with a point of view, figures, a voice chosen
for the subject. When unsure, a well-composed page is never wrong; an over-designed
one sometimes is.

Then, before writing markup:

- **Inventory the content:** every section, table, figure, number, list, Q&A.
- **Assign sections:** one-line job per section ("s1 the one-minute answer · s2 the
  six moving parts · s3 what it costs…"). Every section must have a job; the reader
  scrolls rather than flips, so order sections by the reader's questions, most
  urgent first — the whole answer compressed into section 1 is a strong opener.
- **Budget by rhythm, not pages.** A section is one to three screens: headline +
  lead + 2–6 blocks. Any stretch of two screens with no structural component (a
  figure, table, note, grid) is a wall — break it or draw it.
- **Calibrate length to the ask.** A quick reference: one screen, no rail. A brief:
  3–5 sections, rail optional. A manual: cover + rail + 8–18 numbered sections +
  glossary/FAQ. Never pad to look thorough.

**Then read the plan back once before writing markup.** Ask of each decision — voice,
accent, component mix, the cover treatment — *would I have arrived here for any page
on any subject?* If yes, it is a default wearing the costume of a choice; change it
and say what you changed and why. This costs one paragraph and is the only step that
catches a page that is competent and anonymous.

## 3. Architecture — one flowing column with a fixed rail

Screen pages **flow** — no fixed sheets, no page numbers, no `overflow: hidden`.
Structure comes from a sticky index rail beside one measured reading column:

```css
* { box-sizing: border-box; }
body { margin: 0; background: var(--paper); color: var(--ink);
  font-family: var(--f-body); font-size: 17px; line-height: 1.62;
  -webkit-font-smoothing: antialiased; }
.shell { display: grid; grid-template-columns: 250px minmax(0, 1fr);
  max-width: 1400px; margin: 0 auto; }
.rail { position: sticky; top: 0; align-self: start; height: 100vh;
  overflow-y: auto; padding: 2.2rem 1rem 3rem var(--gutter);
  border-right: 1px solid var(--rule); font-size: 13.5px; }
.main { padding: 0 var(--gutter) 7rem; min-width: 0; }
section { padding-top: 3.6rem; scroll-margin-top: 1rem; }
:root { --measure: 68ch; --gutter: clamp(1rem, 4vw, 2.5rem); }
p, ul, ol.body { max-width: var(--measure); }

@media (max-width: 940px) {
  .shell { grid-template-columns: 1fr; }
  .rail { position: static; height: auto; border-right: 0;
    border-bottom: 1px solid var(--rule); padding: 1.2rem var(--gutter); }
  section { scroll-margin-top: 5rem; }
}
```

- **`minmax(0, 1fr)` and `min-width: 0` are load-bearing** — without them one wide
  table blows the whole grid past the viewport.
- **Wide content scrolls in its own container, never the page.** Tables get a `.tw`
  wrapper, figures a `.plate` wrapper, both `overflow-x: auto`. The body never
  scrolls sideways — that is the top mobile failure.
- Every section gets an `id` and a rail entry; `scroll-margin-top` keeps anchored
  headings clear of the top edge.
- **A page under ~6 sections drops the rail** — single centered column, same tokens.

## 4. Foundations

### 4.1 Tokens and the dual theme — non-negotiable

The page renders in whatever theme the reader's OS prefers, and carries its own
toggle. The robust pattern is token-level: define the palette once on `:root`,
redefine only tokens for dark — **twice**: under the media query (OS preference)
AND under `:root[data-theme="…"]` for both values (so the toggle beats the OS in
both directions). Style components through tokens only.

```html
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
```

```css
:root {            /* light — the full roster, every color the page uses */
  --paper: #F1F2EF; --paper-2: #E8EAE5; --card: #FBFBF9;
  --ink: #17191C; --ink-2: #454A50; --ink-3: #6C7278;
  --rule: #D3D6D0; --rule-2: #BFC3BC;
  --accent: #C9490D; --accent-2: #F0E2D8;      /* the ONE loud accent + its wash */
  --co: #3E5C77; --co-2: #DFE6EC;              /* quiet structural companion */
  --good: #2C6E4D; --good-bg: #DFEBE3;
  --warn: #96660A; --warn-bg: #F2E9D4;
  --crit: #A6382C; --crit-bg: #F2DFDC;
  --shadow: 0 1px 2px rgba(23,25,28,.06), 0 8px 24px -16px rgba(23,25,28,.25);
}
@media (prefers-color-scheme: dark) { :root {
  --paper: #131619; --paper-2: #1B1F23; --card: #1A1E22;
  --ink: #E7E8E4; --ink-2: #B2B7BB; --ink-3: #858B90;
  --rule: #2C3238; --rule-2: #3C444B;
  --accent: #FF7A38; --accent-2: #33231A; --co: #8FB3D0; --co-2: #1E2A34;
  --good: #6FC194; --good-bg: #17281F; --warn: #DFB055; --warn-bg: #2A2214;
  --crit: #EE8878; --crit-bg: #2E1C19;
  --shadow: 0 1px 2px rgba(0,0,0,.4), 0 8px 24px -16px rgba(0,0,0,.8);
} }
:root[data-theme="dark"]  { /* repeat the dark block verbatim */ }
:root[data-theme="light"] { /* repeat the light block verbatim */ }
```

- **Design the dark theme, don't invert it**: lift the accent's brightness so it
  reads on the dark ground, deepen washes to dark tints of the same hue, keep body
  contrast high. Verify both in section 11.
- **Never hardcode a hex outside the tokens** — the classic half-theme bug is a
  `#fff` buried in an SVG or a shadow that only worked on light.
- Neutrals are chosen, not defaulted: bias every grey toward the accent's hue
  (workshop-paper greens, steel blues). Pure `#808080` reads as unconsidered.
- `::selection { background: var(--accent); color: #fff; }` and a visible
  `:focus-visible { outline: 2px solid var(--accent); outline-offset: 3px; }`.

### 4.2 Type — pick a voice, then hold the scale

Typography carries the page. System stacks only (no webfont URLs — they'd be dead
offline and blocked in the preview), but **system does not mean default**: choose a
display + body + mono pairing that speaks the subject's vernacular.

| Voice | Display | Body | Feels like |
|---|---|---|---|
| Field / service manual (ops, infra, "how it works") | `"Franklin Gothic Medium", "Arial Narrow", "Helvetica Neue", Arial, sans-serif` uppercase | `Corbel, "Segoe UI", Candara, Optima, system-ui, sans-serif` | stenciled machinery, hi-vis |
| Editorial essay (analysis, story, opinion) | `"Iowan Old Style", Palatino, "Book Antiqua", Georgia, serif` normal case | same serif, sans captions | printed longform |
| Technical datasheet (specs, APIs, benchmarks) | `"Avenir Next", Avenir, "Segoe UI", sans-serif` tight | body sans + heavy mono usage | lab instrument |
| Executive brief (strategy, proposals) | `"Helvetica Neue", -apple-system, system-ui, sans-serif` light weights, large | same | boardroom calm |
| Warm guide (personal, learning, family) | `Seravek, "Gill Sans", Optima, Candara, sans-serif` | same | friendly handbook |

Mono is the universal labeling voice: `Consolas, "Cascadia Mono", "SF Mono",
ui-monospace, monospace` for eyebrows, table heads, stamps, figure numbers, code.

Scale (fluid — sizes in `clamp()` so the page breathes across widths):

| Role | Spec |
|---|---|
| Display (cover title) | `clamp(2.6rem, 7.5vw, 4.6rem)` / 0.95–1.08 / heavy / `text-wrap: balance` |
| Section head (h2) | `clamp(1.5rem, 3.4vw, 2.05rem)` / 1.05 / hairline underline |
| Sub-head (h3) | 1.08rem, display face |
| Label head (h4) / eyebrow | 10–11.5px mono / UPPERCASE / letter-spacing .11–.14em / muted |
| Body | 16–17px / 1.6–1.65 / max-width `var(--measure)` (~68ch) |
| Lead | 1.09rem, `--ink-2` — first paragraph under a section head |
| Small (tables, notes, captions) | 13.5–15.5px |
| Deck (cover standfirst) | `clamp(1.08rem, 2.2vw, 1.3rem)` / 1.5 / max-width 62ch |

Numbers that sit in columns get `font-variant-numeric: tabular-nums`. Headings get
`text-wrap: balance`.

### 4.3 Color discipline

- **One loud accent**, spent as punctuation, not paint: rail active state, section
  numbers, links, `li::marker`, figure numbers, one line of the cover title,
  key arrows in figures. If everything is accented, nothing is.
- **One quiet companion** (optional): a desaturated second hue for structural
  elements — diagram boxes, info notes — that never competes with the accent.
- **Semantic trio** (`--good/--warn/--crit`) appears only where meaning demands —
  status pills, verdicts, risk notes — never as decoration. Semantic color is
  separate from the accent and doesn't count against the one-accent rule.
- No gradient-fill text. Gradients at all only as large, quiet surface treatments.
- **No emoji anywhere** — not as icons, bullets, or section markers. Structure
  carries hierarchy.
- Hairlines everywhere borders are needed: 1px `--rule`. Shadows only from the
  `--shadow` token, and only on raised plates (figures, the toggle).

### 4.4 Spacing and rhythm

rem-based rhythm; let layout do the spacing: sibling groups use flex/grid `gap`,
not per-element margins that collapse or double. Sections breathe at `3.6rem` top;
components at `1.4–2.4rem`; inside components `0.8–1.4rem`. Watch selector
specificity — a `.section` rule fighting an element rule over margins silently
undoes your rhythm; keep the cascade one-directional (tokens → base elements →
components), and never `!important`.

The **engineered-grid trick** for card sets and spec plates: `display: grid;
gap: 1px; background: var(--rule); border: 1px solid var(--rule);` with each cell
painting `background: var(--card)` — reads as machined, not floating.

## 5. The component kit — exact recipes

Build pages from these. Values are the worked example (field-manual voice); the
knobs a voice turns are case, letter-spacing, font pairing, and accent.

### 5.1 Cover plate (the first screen — spend effort here)

Not a hero banner: a title block with a point of view. Structure: stamp row →
display title (one line may take the accent) → deck → spec plate.

```html
<header class="cover">
  <div class="stamp"><span>Owner's Field Manual</span><span class="sep">/</span>
    <span>Rev. 2026-08</span><span class="sep">/</span><span>Non-technical edition</span></div>
  <h1>How this<br>system <span class="sub">actually works</span></h1>
  <p class="deck">Two or three lines that tell the reader what this page will do for
  them — scope, stakes, and the payoff of reading it.</p>
  <dl class="specplate">
    <div><dt>Live at</dt><dd>example.app</dd></div>
    <!-- 4–6 cells: the vital signs of the subject -->
  </dl>
</header>
```

```css
.cover { padding: clamp(2.5rem, 7vw, 5rem) 0 2.5rem; border-bottom: 2px solid var(--ink); }
.stamp { font-family: var(--f-mono); font-size: 11px; letter-spacing: .18em;
  text-transform: uppercase; color: var(--accent); display: flex; flex-wrap: wrap;
  gap: .5rem 1.1rem; margin-bottom: 1.6rem; }
.stamp .sep { color: var(--rule-2); }
h1 { font-family: var(--f-display); font-size: clamp(2.6rem, 7.5vw, 4.6rem);
  line-height: .95; letter-spacing: -.02em; margin: 0 0 1rem; text-wrap: balance; }
h1 .sub { display: block; color: var(--accent); }
.deck { font-size: clamp(1.08rem, 2.2vw, 1.3rem); color: var(--ink-2);
  max-width: 62ch; line-height: 1.5; }
.specplate { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
  gap: 1px; background: var(--rule); border: 1px solid var(--rule); margin-top: 2rem; }
.specplate div { background: var(--card); padding: .8rem .9rem; }
.specplate dt { font-family: var(--f-mono); font-size: 10px; letter-spacing: .12em;
  text-transform: uppercase; color: var(--ink-3); margin-bottom: .25rem; }
.specplate dd { margin: 0; font-size: 14.5px; font-weight: 600; line-height: 1.3; }
```

The title states a **finding or promise**, not a topic label ("How this system
actually works", not "System Documentation").

### 5.2 Index rail (pages ≥ 6 sections)

```html
<nav class="rail" aria-label="Contents">
  <p class="rail-title">Contents</p>
  <ol>
    <li><a href="#s1"><span class="n">01</span><span>The one-minute answer</span></a></li>
    …
  </ol>
</nav>
```

```css
.rail-title { font-family: var(--f-mono); font-size: 10.5px; letter-spacing: .13em;
  text-transform: uppercase; color: var(--ink-3); margin: 0 0 .9rem; }
.rail ol { list-style: none; margin: 0; padding: 0; display: flex;
  flex-direction: column; gap: 1px; }
.rail a { display: grid; grid-template-columns: 1.9rem 1fr; gap: .1rem;
  padding: .3rem .5rem .3rem .15rem; color: var(--ink-2); text-decoration: none;
  border-left: 2px solid transparent; line-height: 1.35; }
.rail a:hover { color: var(--ink); background: var(--paper-2); }
.rail a .n { font-family: var(--f-mono); font-size: 11px; color: var(--ink-3); }
.rail a.on { color: var(--accent); border-left-color: var(--accent); font-weight: 600; }
.rail a.on .n { color: var(--accent); }
@media (max-width: 940px) {
  .rail ol { flex-direction: row; flex-wrap: wrap; gap: .3rem .9rem; }
  .rail a { grid-template-columns: auto auto; gap: .35rem; border-left: 0; padding: .2rem 0; }
}
```

Numbers in the rail (and on section heads) are justified only when the sections
form a real reading sequence; a reference page whose sections are peers drops the
numbers and lets the titles carry it. Scrollspy highlights the current section
(section 7) — links must work without it.

### 5.3 Section heads

```css
h2 { font-family: var(--f-display); font-size: clamp(1.5rem, 3.4vw, 2.05rem);
  line-height: 1.05; margin: 0 0 1.3rem; padding-bottom: .7rem;
  border-bottom: 1px solid var(--rule); display: grid;
  grid-template-columns: auto 1fr; gap: .85rem; align-items: baseline;
  text-wrap: balance; }
h2 .num { font-family: var(--f-mono); font-size: .5em; color: var(--accent);
  letter-spacing: .04em; font-weight: 400; }
```

First paragraph after an h2 is the `.lead`.

### 5.4 Notes (info, hot, warning, good)

```css
.note { border-left: 3px solid var(--co); background: var(--co-2);
  padding: .95rem 1.1rem; margin: 1.4rem 0; max-width: var(--measure);
  font-size: 15.5px; }
.note.hot  { border-left-color: var(--accent); background: var(--accent-2); }
.note.warn { border-left-color: var(--warn); background: var(--warn-bg); }
.note.good { border-left-color: var(--good); background: var(--good-bg); }
.note .lbl { display: block; font-family: var(--f-mono); font-size: 10px;
  letter-spacing: .14em; text-transform: uppercase; margin-bottom: .35rem;
  color: var(--ink-2); }
.note p { max-width: none; } .note p:last-child { margin-bottom: 0; }
```

The label states the KIND of note ("The sentence to say out loud", "Before you
migrate"); the color follows meaning. Never stack three of the same kind — merge.

### 5.5 Figure plates

Figures are framed exhibits, not floating images:

```css
figure { margin: 2rem 0 2.4rem; border: 1px solid var(--rule);
  background: var(--card); box-shadow: var(--shadow); }
figure .plate { padding: 1.4rem 1.2rem .6rem; overflow-x: auto; }
figure svg { display: block; width: 100%; height: auto; min-width: 480px; }
figcaption { border-top: 1px solid var(--rule); padding: .65rem 1.1rem;
  font-size: 13.5px; color: var(--ink-2); background: var(--paper-2);
  display: grid; grid-template-columns: auto 1fr; gap: .8rem; }
figcaption .fignum { font-family: var(--f-mono); font-size: 10.5px;
  letter-spacing: .1em; text-transform: uppercase; color: var(--accent);
  white-space: nowrap; }
```

The caption states the figure's claim ("A server is a computer that waits for
requests"), never its topic ("Server diagram"). Drawing rules: section 6.

### 5.6 Tables

Always inside a `.tw` scroll wrapper; hairline discipline, mono heads, no zebra:

```css
.tw { overflow-x: auto; margin: 1.4rem 0 1.8rem; border: 1px solid var(--rule);
  background: var(--card); }
table { border-collapse: collapse; width: 100%; font-size: 14.8px; min-width: 520px; }
th, td { text-align: left; padding: .62rem .85rem; border-bottom: 1px solid var(--rule);
  vertical-align: top; }
thead th { font-family: var(--f-mono); font-size: 10px; letter-spacing: .11em;
  text-transform: uppercase; color: var(--ink-3); font-weight: 400;
  background: var(--paper-2); border-bottom: 1px solid var(--rule-2);
  position: sticky; top: 0; }
tbody tr:last-child td { border-bottom: 0; }
td { font-variant-numeric: lining-nums tabular-nums; }
```

First column anchors the row (`td strong { display: block; }` for a bold name with
detail beneath). Numeric columns right-aligned.

### 5.7 Pills (status, verdicts)

```css
.pill { display: inline-block; font-family: var(--f-mono); font-size: 10px;
  letter-spacing: .07em; text-transform: uppercase; padding: .16em .5em;
  border-radius: 2px; white-space: nowrap; border: 1px solid; }
.p-good { color: var(--good); background: var(--good-bg); border-color: var(--good); }
.p-warn { color: var(--warn); background: var(--warn-bg); border-color: var(--warn); }
.p-crit { color: var(--crit); background: var(--crit-bg); border-color: var(--crit); }
.p-info { color: var(--co); background: var(--co-2); border-color: var(--co); }
```

### 5.8 Card grids (entities: vendors, services, options)

The engineered grid — cells share hairlines, no floating rounded cards:

```css
.cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(230px, 1fr));
  gap: 1px; background: var(--rule); border: 1px solid var(--rule); margin: 1.6rem 0 2rem; }
.card { background: var(--card); padding: 1.1rem; display: flex;
  flex-direction: column; gap: .55rem; }
.card .nm { font-family: var(--f-display); font-size: 1rem; }
.card .role { font-family: var(--f-mono); font-size: 9.5px; letter-spacing: .1em;
  text-transform: uppercase; color: var(--accent); }
.card p { font-size: 14.2px; color: var(--ink-2); margin: 0; max-width: none; }
.card .meta { font-family: var(--f-mono); font-size: 11px; color: var(--ink-3);
  border-top: 1px solid var(--rule); padding-top: .5rem; margin-top: auto; }
```

### 5.9 Q&A (native details/summary — no JS)

```css
.qa { max-width: var(--measure); border-top: 1px solid var(--rule); margin: 1.5rem 0; }
.qa details { border-bottom: 1px solid var(--rule); }
.qa summary { cursor: pointer; padding: .85rem 1.8rem .85rem 0; font-weight: 600;
  list-style: none; position: relative; }
.qa summary::-webkit-details-marker { display: none; }
.qa summary::after { content: "+"; position: absolute; right: .2rem; top: .78rem;
  font-family: var(--f-mono); color: var(--accent); font-size: 1.1rem; }
.qa details[open] summary::after { content: "\2212"; }
.qa .ans { padding: 0 0 1rem; color: var(--ink-2); font-size: 15.6px; }
.qa .say { border-left: 3px solid var(--accent); padding-left: .85rem;
  font-style: italic; color: var(--ink); margin-top: .8rem; }
```

Made for "questions your boss will ask" sections; `.say` holds the answer to read
out loud. Quizzes with hidden answers stay `ask_user`'s job, never `<details>`.

### 5.10 Steps and checklists

```html
<div class="steps">
  <div class="step">
    <h5>Step title</h5>
    <p>What happens in this step, one to three sentences.</p>
  </div>
  …
</div>
```

```css
.steps { counter-reset: s; max-width: var(--measure); margin: 1.4rem 0 1.8rem; }
.step { counter-increment: s; display: grid; grid-template-columns: 2.4rem 1fr;
  column-gap: 1rem; padding: 1rem 0; border-bottom: 1px solid var(--rule); }
.step:first-child { border-top: 1px solid var(--rule); }
.step::before { content: counter(s, decimal-leading-zero); grid-row: 1;
  font-family: var(--f-mono); font-size: 12px; color: var(--accent);
  padding-top: .18rem; }
.step > * { grid-column: 2; }  /* load-bearing — see below */
.step h5 { margin: 0 0 .25rem; font-size: 1rem; font-weight: 600; }
.step p { margin: 0; font-size: 15.3px; color: var(--ink-2); max-width: none; }
```

**The `::before` number is a grid item too.** Without `.step > * { grid-column: 2 }`,
auto-placement seats the second child (the `<p>`) in the 2.4rem number column and
its text wraps one word per line. The same trap lives in ANY grid that pairs a
marker column with content: pin the content children to the text column, and use
`column-gap` (a row `gap` would open space between title and body).

```css
.check { max-width: var(--measure); list-style: none; padding: 0; }
.check li { position: relative; padding: .55rem 0 .55rem 1.5rem;
  border-bottom: 1px solid var(--rule); }
.check li::before { content: ""; position: absolute; left: 0; top: .93rem;
  width: 13px; height: 13px; border: 1.5px solid var(--rule-2);
  border-radius: 2px; background: var(--paper-2); }
```

The checkbox is absolutely positioned rather than a grid column, so list items may
carry any inline markup (`<strong>`, `<code>`) without fragmenting into stray grid
items.

### 5.11 Terms (glossaries), footer

```css
.terms > div { display: grid; grid-template-columns: minmax(120px, 190px) 1fr;
  gap: .3rem 1.2rem; padding: .75rem 0; border-bottom: 1px solid var(--rule); }
.terms dt { font-weight: 600; } .terms dd { margin: 0; color: var(--ink-2); }
@media (max-width: 620px) { .terms > div { grid-template-columns: 1fr; } }

.footer { margin-top: 3rem; padding-top: 1.4rem; border-top: 1px solid var(--rule);
  font-family: var(--f-mono); font-size: 11.5px; color: var(--ink-3); }
hr.rule { border: 0; border-top: 2px solid var(--ink); margin: 3.5rem 0 0; }
```

Footer carries provenance: what this page is, revision date, who prepared it.

## 6. Figures and charts

**Diagrams — hand-drawn inline SVG, themed by CSS variables.** Draw the mechanism,
not its name: the path a request takes, the boundary being crossed, the data that
moves. A box labeled "cache" says less than the prose; the arrow that appears or
disappears between two options is the information. Label the arrows (`writes`,
`polls every 30s`) — an unlabeled arrow is "related somehow". Match complexity to
the stakes; if a sentence says it faster, write the sentence.

Mechanics — define once in CSS so every figure themes automatically:

```css
svg text { font-family: var(--f-body); fill: var(--ink); }
svg .lab { font-family: var(--f-mono); font-size: 9.5px; letter-spacing: .09em;
  text-transform: uppercase; fill: var(--ink-3); }
svg .ttl { font-weight: 700; font-size: 13px; }
svg .sm { font-size: 11.5px; fill: var(--ink-2); }
svg .xs { font-size: 10px; fill: var(--ink-3); }
svg .box  { fill: var(--card); stroke: var(--rule-2); stroke-width: 1.2; }
svg .boxa { fill: var(--accent-2); stroke: var(--accent); stroke-width: 1.4; }
svg .boxc { fill: var(--co-2); stroke: var(--co); stroke-width: 1.4; }
svg .flow   { stroke: var(--co); stroke-width: 1.6; fill: none; }
svg .flow-a { stroke: var(--accent); stroke-width: 1.8; fill: none; }
svg .dash { stroke-dasharray: 4 4; }
```

- **Never a raw hex inside figure SVG** — `var(--…)` fills/strokes only, or the
  figure breaks in the other theme. (Semantic dots may use `var(--good)` etc.)
- `viewBox` sized to content (~700–760 wide for flows); `min-width: 480px` on the
  svg + the `.plate` scroll wrapper handle mobile.
- Arrowheads via `<defs><marker>` with fragment ids; text 10–13px at drawn scale;
  align boxes to a grid — shared baselines are most of what reads as deliberate.
- `role="img"` + `aria-label` stating the figure's claim; the `<figcaption>`
  carries the same claim in prose.
- No `<script>`, `<style>`, `<foreignObject>`, or external refs inside the SVG.

**Data charts — call `dataviz` first**, and follow its form-choice and palette.
Its SVG print recipes port to the web with one change: colors come from the theme
tokens (or palette slots defined as custom properties for both themes) so charts
survive dark mode. Charts live inside figure plates like any other figure. The
in-app `.chart.json` card is for chat replies — inside a page, charts are SVG.

## 7. The interaction layer — JS is enhancement, never structure

**The page must read complete with scripts off.** The in-app preview card is
sandboxed and does not execute your scripts; readers save pages, print them, block
JS. Content, navigation (real `#anchor` links), and collapsibles (native
`<details>`) all work scriptless. JS then adds polish — vanilla only, one
`<script>` block before `</body>`, no frameworks, no fetches.

The two standard enhancements:

```html
<script>
(function () { /* scrollspy — highlights the rail entry for the visible section */
  var links = [].slice.call(document.querySelectorAll('.rail a'));
  var map = {}; links.forEach(function (a) { map[a.getAttribute('href').slice(1)] = a; });
  var sections = [].slice.call(document.querySelectorAll('section[id]'));
  function setActive(id) {
    links.forEach(function (a) { a.classList.remove('on'); a.removeAttribute('aria-current'); });
    if (map[id]) { map[id].classList.add('on'); map[id].setAttribute('aria-current', 'true'); }
  }
  if ('IntersectionObserver' in window) {
    var visible = {};
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) { visible[e.target.id] = e.isIntersecting; });
      for (var i = 0; i < sections.length; i++)
        if (visible[sections[i].id]) { setActive(sections[i].id); break; }
    }, { rootMargin: '-8% 0px -70% 0px', threshold: 0 });
    sections.forEach(function (s) { io.observe(s); });
  }
})();
(function () { /* theme toggle — OS preference first, then the reader's choice */
  var root = document.documentElement, btn = document.getElementById('themeToggle');
  var stored = null;
  try { stored = localStorage.getItem('page-theme'); } catch (e) {}
  if (stored === 'dark' || stored === 'light') root.setAttribute('data-theme', stored);
  function current() {
    return root.getAttribute('data-theme') ||
      (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  }
  btn.addEventListener('click', function () {
    var next = current() === 'dark' ? 'light' : 'dark';
    root.setAttribute('data-theme', next);
    try { localStorage.setItem('page-theme', next); } catch (e) {}
  });
})();
</script>
```

The toggle button sits fixed top-right (`.theme-btn`, card ground, mono label,
swaps "Dark"/"Light" via `:root[data-theme]` display rules — no JS text swapping).

Motion: `html { scroll-behavior: smooth; }` plus the kill switch —
`@media (prefers-reduced-motion: reduce) { * { animation: none !important;
transition: none !important; scroll-behavior: auto !important; } }`. No
scroll-hijacking, no parallax, no entrance animations; hover states change color
or background, instantly. An orchestrated moment is for editorial pages that earn
it, and even then one is plenty.

## 8. Metadata, accessibility, print

Head, always:

```html
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta name="description" content="One honest sentence on what this page covers.">
<meta name="robots" content="noindex, nofollow">   <!-- personal/private pages -->
<title>Subject — What This Page Is</title>
```

- Landmarks: `<nav aria-label="Contents">`, `<main>`, `<header>`, `<section id>`.
- Keyboard: visible `:focus-visible` everywhere interactive; `<details>` and
  anchors are keyboard-native for free; the toggle is a real `<button>` with
  `aria-label`.
- Contrast holds in BOTH themes — muted text stays legible, the accent reads on
  both grounds. Checked by eye in section 11, not assumed.
- Copy is design material: name things by what the reader recognizes, not how the
  system is built; active voice; specific beats clever. Structural devices encode
  something true — number sections only when order carries information.
- Print, small courtesy block: `@media print { .theme-btn, .rail { display: none; }
  .shell { grid-template-columns: 1fr; } }`. If the user wants an actual PDF
  deliverable, that is `pdf_design`'s pipeline — do not print this page instead.

## 9. Right-to-left and Arabic pages

When the page language is Arabic (or the automation is Arabic-first):

- `<html dir="rtl" lang="ar">`; body font `"SF Arabic", "Geeza Pro",
  "IBM Plex Sans Arabic", "Segoe UI", Tahoma, sans-serif`.
- **Zero letter-spacing on Arabic text** — tracking breaks the connected script.
  Eyebrows, stamps, and rail titles drop `letter-spacing` and carry hierarchy with
  size + weight + color.
- Write directional CSS logically from the start: `border-inline-start`,
  `padding-inline`, `inset-inline-end` (the toggle), `text-align: start`. The
  shell grid then mirrors itself; verify the rail sits right and figures mirror
  sensibly in the render pass.
- Keep digits Latin unless asked; keep `tabular-nums`. Body sizes +0.5–1px for
  equal optical weight.

## 10. Density and the small page

- **A one-screen page is a real format**: no rail, no cover plate — stamp line,
  title, deck, one or two components, footer. Same tokens, same discipline.
- **A 3–5 section brief**: single column, centered `max-width: 72ch` shell, cover
  plate trimmed to stamp + title + deck.
- **Rail + numbered sections + glossary/FAQ earn their place at ≥ 6–8 sections.**
- Prose-only stretches are a smell in guides — most sections carry at least one
  structural component. In essays, prose is the point; use section heads and
  pull-quote-style `.note` blocks for rhythm instead.

## 10.5 Words are part of the design

Copy makes a page feel templated exactly as fast as layout does. It is content, not
decoration, and it gets the same intentionality as spacing and color.

- **Name things the way the reader would.** Plain verbs, sentence case, no filler.
  "Turn off notifications", not "Notification preference management".
- **A link says where it goes**, a button says what it does, and it keeps the same
  word afterwards — a control labelled *Export* produces a file the page calls an
  export, not a "download".
- **Every eyebrow and label must carry information.** An eyebrow reading
  "OVERVIEW" above an obvious overview is chrome; one reading "Where the time goes"
  is a second headline. If a label only names the component type, delete it.
- **Empty and error states give direction, not mood.** Say what happened and what
  to do next, in the page's own voice. Nothing apologises; nothing is vague.
- **Each written element does one job.** A lead that restates the headline is one
  of them doing nothing.

## 11. Verify before delivering — mandatory

You never deliver a page you have not looked at. The failure modes — horizontal
scroll on phones, a half-themed dark mode, a blown grid — are all silent in the
source and obvious in a screenshot.

1. `browser_launch` `{ headless: true, viewport_width: 1280, viewport_height: 900 }`
   → `browser_navigate` to `file:///…/files/page.html`.
2. `browser_screenshot` `{ full_page: true }` → `image_view` it. (On very long
   pages, also shoot key regions — cover, one dense section, a figure — at
   viewport size for readable detail.)
3. `browser_evaluate` `document.documentElement.setAttribute('data-theme','dark')`
   → screenshot → `image_view`. This checks the dark palette AND that the toggle
   attribute actually overrides the media query.
4. Relaunch at `{ viewport_width: 390, viewport_height: 844 }` → repeat both
   themes.
5. Checklist — fix and re-shoot if ANY fails:
   - No horizontal page scroll at 390px; wide tables/figures scroll inside their
     own wrappers (tell: content clipped at the right edge, or a squeezed column).
   - Multi-column components hold their geometry: a text block collapsed to one
     word per line means grid auto-placement seated content in a marker column
     (section 5.10) — fix the placement, don't widen the marker.
   - Dark theme complete: no baked-light patches (SVG fills and shadows are the
     usual culprits), text legible, accent reading on the dark ground.
   - Rail present and aligned on desktop, collapsed to the wrapping strip on
     mobile; anchors land clear of the top edge.
   - Cover title balanced, not overflowing; figures uncut, labels not colliding.
   - Contrast: no faint-grey-on-paper body text in either theme.
   - RTL: mirrored alignment, nothing letter-spaced.
6. Only then `send_file`.

One fix cycle is expected; two is fine; a third means simplify the failing
component rather than iterating forever.

## 12. Vary the treatment — never the standards

Choose per page, from the subject and audience (this is where pages stop looking
alike — commit to a vernacular and let it drive type, palette, and texture):

- **The vernacular**: a service manual speaks stenciled caps and safety orange on
  workshop paper; an editorial essay speaks quiet serifs and one deep accent; a
  datasheet speaks mono labels and dense engineered grids; an executive brief
  speaks air and restraint; a warm guide speaks humanist rounds. Invent others
  from the subject's own world — its materials, instruments, language.
- **Accent + companion hues**, biased into the neutrals.
- **Component mix** (figure-led explainer vs table-led reference vs Q&A-led
  handbook), **density**, **rail numbering** (sequence only).
- Looks to avoid unless the user asks for exactly them: warm-cream + serif +
  terracotta, near-black + lone neon accent, purple-gradient hero on white,
  emoji section markers, everything centered, floating rounded cards everywhere.
  These are the templated defaults this manual exists to replace.

What never varies: dual themes with the toggle-beats-OS token pattern,
self-containment (no CDN, no webfont, no external image), the one-loud-accent
discipline, semantic-colors-only-with-meaning, the measured reading column,
hairline discipline, wide-content-scrolls-in-wrappers, JS-optional completeness,
figures themed by tokens with claims for captions, the verify pass, no emoji as
UI, no gradient text, accessibility floor (landmarks, focus, contrast, labels).

## 13. Failure catalog — if your draft matches one, fix it before rendering

1. **The markdown dump**: browser-default styling, blue links, no rail, no
   components — a README pretending to be a page. Apply the kit.
2. **The CDN page**: a Google-Fonts `<link>`, a Tailwind CDN, a chart library.
   Dead offline, dead in the in-app preview. Self-contained, always.
3. **The half-theme**: tokens themed but a hardcoded `#fff` panel, a light-only
   shadow, or an unthemed SVG glowing in dark mode. Tokens everywhere; verify both.
4. **The JS-shaped hole**: content that only exists after script runs. The in-app
   preview (and any no-JS reader) sees nothing. Scripts enhance; HTML carries.
5. **The sideways phone**: fixed widths outside scroll wrappers, a missing
   `minmax(0, 1fr)` — the whole page pans horizontally at 390px.
6. **The template smell**: generic hero + three feature cards + CTA for what is
   actually a document; or the cream/terracotta and neon-on-black defaults.
7. **The 100-character line**: body text spanning the shell. Cap at `--measure`.
8. **Random rainbow**: a different hue per card or heading; semantic colors as
   decoration. One accent, one companion, meaning only.
9. **The scroll circus**: parallax, entrance animations, hijacked wheel. Info
   pages hold still; the reader does the moving.
10. **The emoji page**: emoji as icons, bullets, or section markers.
11. **The dead rail**: entries that don't match sections, numbers out of order,
    anchors that land under nothing. The rail is the contract with the reader.
12. **The unlabeled figure**: no caption claim, no `aria-label`, arrows that mean
    "related somehow". Label at the mark; claim in the caption.
13. **The generated-page tells** — small, individually defensible, and damning in
    company, because they show up whatever the subject:
    - meta strings joined with middle dots (`Draft · Internal · 2026`);
    - an arrow appended to link or button text (`Read more →`);
    - labels built as `WORD — fragment` with a spaced em dash;
    - a tinted near-black (`#0B0B0B`, `#111`) where the `--ink` token belongs —
      every color on the page comes from a token, including the dark ones;
    - one word of a headline in italic, bold, or the accent. Accent a whole line
      or nothing; a single highlighted word is the commonest generated flourish.
    Each is legitimate when the subject actually calls for it. None is a default.
