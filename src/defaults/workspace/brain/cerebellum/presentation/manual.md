# The Deck Design Manual

A deck is not a document with the paragraphs deleted. A document is read; a deck is
*shown* — one idea per slide, at a glance, usually while someone talks over it. Every
rule here follows from that.

You do not place shapes. `presentation_create` owns geometry, type and colour; you
choose the **layout** for each slide and supply its **content**. That inversion is the
point: you cannot see the slide you just wrote, so the things you cannot check —
margins, alignment, type scale, colour discipline — are not yours to get wrong. What
is yours is the argument, the words, and which layout carries them.

Explicit user or automation design instructions always win over this manual. A named
brand colour, a supplied template, a demanded look: follow it exactly.

---

## 1. The pipeline — in order

1. **Plan the deck** (section 2). Slide map before any JSON.
2. **Pick a theme** (section 3) from the subject.
3. **Write the spec** (section 4) and call `presentation_create`.
4. **Read the fit warnings** it returns. They are estimates, not verdicts — but every
   one names a box that is close to full. Shorten the copy or split the slide.
5. **`presentation_validate`** — mandatory. It catches the structural faults that make
   PowerPoint declare the file corrupt, and leftover placeholder text.
6. **`presentation_render`** → then `pdf_render_pages` → then `image_view` **every
   slide**. Mandatory when LibreOffice is available. If it is not, say so in your reply
   instead of implying you looked.
7. **`send_file`** the `.pptx`.

Never tell the user a deck is ready at step 3.

---

## 2. Plan before you write the spec

**Calibrate first.** An internal status deck wants plain, fast slides — title, a few
bullets, a chart, done. A pitch, a board update, a conference talk, anything the user
will stand in front of: that earns a cover with a point of view, section dividers, and
a visual on every slide.

Then write the slide map — one line per slide, naming its *job*, before any JSON:

```
1 cover — the claim
2 stats — the three numbers that make the case
3 section 01 — what is happening
4 bullets — the mechanism
5 chart — six months of it
6 two-column — what we tried vs what worked
7 section 02 — what we do next
8 steps — the plan
9 table — cost and owner
10 closing — the ask
```

Rules the map must satisfy:

- **One idea per slide.** If a slide's job needs the word "and", it is two slides.
- **The title is the claim, not the topic.** "Churn doubled after the April pricing
  change" beats "Churn analysis". A deck of noun phrases makes the reader do the work.
- **Length follows the ask.** A decision deck: 5–10 slides. A talk: 15–30. A leave-behind
  can run longer because nobody is waiting. Never pad to look thorough.
- **Vary the layout.** Three `bullets` slides in a row is the tell of a deck nobody
  designed. The engine warns when a deck of five or more uses fewer than three layouts;
  do not make it have to.
- **Sandwich the darks.** Cover and closing are dark grounds, `section` dividers break
  the deck into acts, everything between is light. Dark-light-dark gives a deck shape.

---

## 3. Themes — pick from the subject

The eight palettes are the same contrast-tested sets `pdf_design` uses, so a deck and
its companion report look like one piece of work. Pass the name as `theme`.

| Subject | Theme |
|---|---|
| Unspecified, corporate, technology, strategy | `steel` (the default) |
| Health, clinical, environment, duty of care | `teal` |
| Sustainability, agriculture, land, growth | `forest` |
| Research, data, models, academic work | `indigo` |
| Culture, brand, editorial, education | `plum` |
| Risk, audit, legal, compliance, incidents | `claret` |
| Energy, industry, logistics, operations | `rust` |
| Minimal work where tables and charts carry it | `graphite` |

**A named brand colour beats the table.** Pass a full `tokens` object overriding the
palette — every token, not half of them. The contrast rules in `pdf_design`'s themes
file apply unchanged (accent ≥ 4.5:1 on paper, accent-deep ≥ 7:1 under white text,
ink ≥ 12:1). The semantic trio — green good, amber warn, red bad — is not yours to
restyle; if a brand accent lands on red, move the accent, not the meaning.

**Fonts.** Default `Calibri` for both roles: it ships with Office everywhere and its
metrics are known, which is what makes the fit estimate mean anything. For a deck with
more voice, pair a serif display with a sans body — `font_display: "Cambria"`,
`font_body: "Calibri"`. Fonts outside the metric-safe set are allowed; the engine says
so and you should leave the copy shorter to compensate. Never specify Aptos: it has no
substitute on older Office installs.

One trap in the verify pass: a renderer substitutes any font it does not have installed, and a substitute has different widths. So a preview's *apparent* text fit is not evidence — the engine's fit estimate is computed from the real font's metrics and is the number to trust. Use the render to catch overlap, balance and colour.

---

## 4. The spec

```json
{
  "theme": "steel",
  "aspect": "16x9",
  "title": "Q3 Retention Review",
  "footer": "Q3 Retention Review — internal",
  "slides": [ ... ]
}
```

`footer` prints small and muted on every content slide with a page number; omit it for
a talk deck, keep it for anything that gets forwarded.

### The layouts

| `layout` | Carries | Key fields |
|---|---|---|
| `title` | The cover. Dark. | `eyebrow`, `title`, `subtitle`, `meta` |
| `section` | An act break. Dark. | `number`, `title`, `subtitle` |
| `bullets` | A point with support | `title`, `lead`, `bullets[]` |
| `two-column` | A comparison | `title`, `left{heading,bullets[]\|body}`, `right{…}` |
| `cards` | 2–6 parallel things | `title`, `cards[{label,title,body,emphasis}]` |
| `stats` | 2–4 numbers that matter | `title`, `stats[{value,label,note,tone}]`, `body` |
| `steps` | A sequence, 2–6 long | `title`, `steps[{title,body}]` |
| `table` | Reference data | `title`, `columns[]`, `rows[][]`, `col_widths[]`, `caption` |
| `chart` | A trend or comparison | `title`, `chart{type,categories[],series[]}`, `caption` |
| `image` | A picture that argues | `title`, `image`, `mode:"half"\|"full"`, `image_side`, `bullets[]\|body`, `caption` |
| `quote` | One line, with weight | `quote`, `attribution` |
| `closing` | The ask. Dark. | `title`, `subtitle` |

Every slide takes `notes` — speaker notes, plain text. Write them for any deck someone
will present: they are where the sentences go that do not belong on the slide.

`stats[].tone` accepts `good`/`warn`/`bad` and colours the number semantically. Use it
for a verdict, never for variety.

### Worked example

```json
{
  "layout": "stats",
  "eyebrow": "Where it hurts",
  "title": "Churn doubled in the three months after the price change",
  "stats": [
    { "value": "11.4%", "label": "Q3 churn", "tone": "bad", "note": "5.9% in Q2" },
    { "value": "$1.2M", "label": "Annualised loss" },
    { "value": "72%", "label": "Of it from the $29 tier" }
  ],
  "body": "The $29 tier absorbed the whole increase. Enterprise churn did not move.",
  "notes": "Lead with the 72% — it is the number that decides the room."
}
```

### Writing for slides

- **Six words a bullet, six bullets a slide.** Over that, it is a document.
- **Bullets are fragments, not sentences.** No terminal periods. Parallel grammar down
  the list — every item starts with the same part of speech.
- **A number needs its comparison.** "11.4% churn" says nothing; "11.4%, up from 5.9%"
  says everything. Put the baseline in `note`.
- **Cut the label above the content.** An eyebrow that says "OVERVIEW" over a slide
  that is obviously an overview is chrome, not information. `eyebrow` earns its place
  when it names the *act* ("Where it hurts"), not the slide type.
- **Say what happens.** A closing slide says "Approve the $400k and we start Monday",
  not "Next steps".

---

## 5. Charts

Call `dataviz` first for anything beyond an obvious bar chart — it decides whether the
thing should be a chart at all. Then:

- **Native charts only.** `layout: "chart"` writes a real PowerPoint chart the user can
  edit and recolour. Never paste a rendered image of a chart into a deck.
- Types: `bar` (vertical columns), `hbar`, `line`, `area`, `pie`, `doughnut`, `scatter`.
- **`hbar` for ranked categories** with long names — vertical labels turn diagonal and
  become unreadable. `line` for time. `pie` only for parts of one whole, at most five
  slices, and never for change over time.
- One series: the engine drops the legend and colours it with the accent. Several: it
  uses a theme ramp and puts the legend at the bottom. Both are handled — do not pass
  `chartColors`.
- `stacked: true` switches to stacked grouping *and* moves the data labels inside,
  because the outside position corrupts a stacked chart.
- `value_format` takes an Excel format code (`"#,##0"`, `"0.0%"`, `"$#,##0"`).

---

## 6. Editing a deck you did not make

`presentation_read` first — always. You cannot edit text you have not seen the exact
spelling of, and `replace_text` reports zero hits rather than guessing.

- **Structural work before content.** Duplicating a slide copies it verbatim, so
  duplicate first, then fill. The tool enforces this order and tells you when it did.
- `replace_text` rewrites the visible run text and leaves every formatting property
  alone. That is why it is the right way to fill a template: setting a whole text frame
  collapses it to one unstyled run.
- `delete_slide` drops a slide from the running order and leaves the part in the
  package. `presentation_validate` reports the orphan. That is deliberate — an
  unreferenced part is recoverable, a deleted one is not.
- **A template's slot count is not your content count.** If it shows four team members
  and you have three, remove the fourth slide's whole group, not just its text, or an
  orphaned photo frame ships.

---

## 7. Verify — mandatory

`presentation_validate` is structure: relationships resolve, content types cover every
part, charts are in a shape PowerPoint will open, no leftover `lorem`/`TODO`/`[insert]`.
**A valid deck can still look wrong.** Render it and look.

What to look for in the images, in this order:

1. **Text overflow or clipping.** The most common defect and always user-visible.
2. Overlapping elements — text through a shape, a chart under a caption.
3. A slide that is 80% empty, or one that is wall-to-wall type.
4. A chart with unreadable category labels (the `hbar` fix).
5. Low contrast — muted text on a wash, a semantic colour used as decoration.
6. Leftover template furniture after a text replacement.

Fix in the spec and regenerate. Never hand-edit the packed XML.

---

## 8. Failure catalog — if your draft matches one, fix it before rendering

1. **The document on slides.** Full sentences, 12 bullets, 11pt type. Split it, or make
   it a PDF with `pdf_design` and say so.
2. **The topic deck.** Every title a noun phrase. Nothing is claimed, so nothing is
   remembered.
3. **One layout throughout.** Ten `bullets` slides. Vary, or admit it is a document.
4. **The decorative stripe.** Accent bars along a card edge, a rule under every title,
   a colour band across the header. The engine does not draw them; do not ask it to.
5. **Rainbow slides.** A different hue per card. One accent, semantic colours only
   where they mean something.
6. **The naked number.** A stat with no baseline and no unit.
7. **Chart junk.** Legend on a single series, 3-D anything, a pie with nine slices.
8. **The unlooked-at deck.** Validated, never rendered, sent. If you could not render,
   say which check you skipped.
