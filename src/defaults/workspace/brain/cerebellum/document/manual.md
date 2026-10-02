# The Word Document Manual

A `.docx` is not a PDF with a different extension. A PDF is finished — it is read.
A Word document is *unfinished on purpose* — someone will open it, comment on it,
track changes through it, paste it into a house template, and restyle it. Every rule
here follows from that.

You do not set fonts, sizes, colours or indents. `document_create` owns a Word **style
sheet**, and the blocks reference it. That inversion is the whole difference between a
document a person can work with and one they have to fight: formatting painted onto
each paragraph cannot be restyled, does not reach the navigation pane, and is invisible
to a table of contents.

Explicit user or automation design instructions always win over this manual. A supplied
template, a named brand colour, a demanded format: follow it exactly.

---

## 1. Word or PDF — settle this first

| The reader will… | Build |
|---|---|
| Read it, and that is all | **PDF** — call `pdf_design`, it is a better-looking document |
| Edit, comment, or track changes | **Word** — this manual |
| Paste it into their own template | **Word** |
| Submit it where .docx is required | **Word** |

If the user said "report" or "memo" with no format, ask yourself who touches it next.
A board pack is a PDF. A contract draft, a policy for review, a proposal the client will
mark up — Word. Getting this wrong wastes the whole document.

## 2. The pipeline — in order

1. **Plan** (section 3): the section map, before any blocks.
2. **Pick a theme** (section 4) from the subject.
3. **Write the block list** and call `document_create`.
4. **`document_validate`** — mandatory. It catches what makes Word refuse or repair a
   file, plus the direct-formatting failure and a TOC that will open blank.
5. **`document_render`** → `pdf_render_pages` → `image_view` **every page**. Mandatory
   when LibreOffice is available; when it is not, say so in your reply rather than
   implying you looked.
6. **`send_file`** the `.docx`.

## 3. Plan before you write blocks

Write the section map first — one line per section naming its job:

```
cover — the claim and who it is for
toc — only if it runs past ~6 pages
1 what happened — the evidence
2 what it costs — the table
3 what we do next — the numbered plan
callout — the decision we need
```

- **Headings are claims.** "Churn doubled after the April price change" beats
  "Churn analysis". A document of noun phrases makes the reader do the work.
- **Three heading levels, no more.** A fourth means the document wants to be two.
- **A table of contents earns its place past about six pages.** Below that it is
  furniture.
- **Length follows the ask.** A memo: one to two pages, no cover, no TOC. A report:
  cover, 3–8 sections. A policy or proposal: cover, TOC, numbered sections. Never pad.

## 4. Themes

The eight palettes are the same contrast-tested sets `pdf_design` and `deck_design`
use, so a report, its deck and its PDF look like one body of work. Pass `theme` in
`options`.

| Subject | Theme |
|---|---|
| Unspecified, corporate, technology, strategy | `steel` (default) |
| Health, clinical, environment, duty of care | `teal` |
| Sustainability, agriculture, land, growth | `forest` |
| Research, data, models, academic work | `indigo` |
| Culture, brand, editorial, education | `plum` |
| Risk, audit, legal, compliance, incidents | `claret` |
| Energy, industry, logistics, operations | `rust` |
| Minimal work where tables carry the signal | `graphite` |

A named brand colour beats the table — pass a full `tokens` object, every token, not
half of them. The semantic trio (green good, amber warn, red bad) is not yours to
restyle.

**Fonts.** The default is a pair — `Cambria` headings over `Calibri` text. Both ship
with Office everywhere, and one typeface doing every job is the flattest a document
can look. Override with `font_display` / `font_body`; `Georgia`+`Calibri` and
`Calibri`+`Calibri` (plainest) are the other safe pairs. Never specify Aptos — no
substitute on older installs. `page` takes `a4` (default), `letter` or `legal`.

**Margins default to 1.25 inches** and the body sets solid on 130%. Both are measure
decisions: at one inch an A4 line runs past 90 characters, which is over the top of
the readable range. Widen them for a document with wide tables, never to fit more in.

## 5. The blocks

| `type` | Carries | Key fields |
|---|---|---|
| `cover` | Title page | `eyebrow`, `title`, `subtitle`, `meta`, `top_space`, `page_break` |
| `toc` | Contents field | `title`, `page_break` |
| `heading` | Section head | `text`, `level` (1–3 — see below) |
| `lead` | The paragraph that answers the section | `text` |
| `paragraph` | Body | `text`, `bold`, `italic`, `alignment`, `rtl` |
| `bullets` | Unordered list | `items[]` (string or `{text, bold, level}`) |
| `numbered` | A sequence | `items[]` |
| `table` | Reference data | `headers[]`, `rows[][]`, `column_widths[]`, `caption` |
| `callout` | One thing the reader must not miss | `tone` (`info`/`good`/`warn`/`bad`), `title`, `text` |
| `quote` | A line with weight | `text`, `attribution` |
| `image` | A figure | `path`, `width`, `height`, `caption`, `alignment` |
| `caption` | A note under something | `text` |
| `divider` | A section break | — |
| `page_break` | A hard break | — |

`options` carries `theme`, `page`, `orientation`, `margin_inches`, `font_display`,
`font_body`, `base_size`, `title`, `author`, `header`, `footer`, `page_numbers`.

**The contents breaks to a new page after itself.** In a short document that spends a
page on four lines — pass `page_break: false` on the `toc` block and let the contents
sit under the title block on page one, or drop the contents entirely.

**Give `cover.meta` a list, not a paragraph.** `[{label: "Prepared for", value: "The
board"}, {label: "Date", value: "17 September 2026"}]` sets a label/value row across a
hairline — the thing that makes a cover look composed rather than typed. Up to four
columns; a plain string still works and prints as caption lines. The title block sits a
third of the way down the page; `top_space` (twips) moves it, `top_space: false`
pins it to the top margin for a one-page memo.

**The three heading levels are three different voices, not three sizes.** Level 1 is the
section claim and carries a rule beneath it. Level 2 is a heading inside a section, in
the accent. Level 3 is a letterspaced caps label at body size — use it for a short
label over a list or a table, never for a heading with a paragraph of its own beneath.

**Hard page breaks are for a cover and a genuinely new part — nothing else.** A
`page_break` before every section is the fastest way to a document with half-empty
pages: a section that ends two lines into a page leaves the rest of it white. Let the
flow break where it breaks; headings already carry `keepNext`, so one never strands at
the foot of a page. This is the defect a render pass exists to catch, and it is
invisible in the block list.

**One callout per two pages, at most.** A document where everything is called out has
called out nothing.

**`column_widths` are relative** — `[3, 2, 2, 1.5]` means the first column gets 3/8.5
of the text width. Give the column holding sentences the largest share, and give a
column of figures enough width for its heading: heads set in letterspaced caps are
wider than they look in your block list.

**Numbers right-align themselves.** A column whose cells are mostly figures is detected
and set right, header included, so digits line up against digits. Never pad a cell with
spaces to fake alignment, and keep a column's figures to one format — `5.1%` and
`5.10%` in the same column do not line up however they are aligned. Tables carry no
vertical rules, no stripes and no fills: a rule under the header, hairlines between
rows, and the same system `pdf_design` uses, so a report and its PDF match.

## 6. Writing a document someone will edit

- **Say it in the heading and the lead.** A reader who reads only those two must still
  get the answer. Everything below is support.
- **One idea per paragraph**, and the first sentence carries it.
- **Curly quotes and real dashes.** `"price"` and `--` are the two marks that say a
  machine typed this; write “price” and an em dash. One space after a period.
- **Numbers get their comparison** — "11.4%, up from 5.9%", never a bare figure.
- **Name the owner and the date** for anything that is someone's job. A plan with no
  name against it is a wish.
- **Mark what is still open** with a `warn` callout rather than burying it. The reader
  is going to edit this; tell them where to look.
- Avoid the tells of a generated document: a label above content that only names the
  content type, meta strings joined with middle dots, an arrow appended to a heading,
  one word of a heading in a different colour.

## 7. Editing a document you did not write

`document_read` first — always. You cannot replace text you have not seen the exact
wording of.

- **`find_replace` works on the text, not the markup.** It coalesces the split runs
  Word leaves behind (revision ids, spell-check state) so a visible phrase is findable,
  edits only inside text nodes, and escapes what it writes. It reports how many runs it
  changed — **zero hits is reported as a warning, not a success**; go read the document
  again.
- A phrase split across runs with *different* formatting (half of it bold) still will
  not match. That is the case to handle by rewriting the whole paragraph.
- **Never reformat or pretty-print `word/document.xml`.** Whitespace between elements is
  content in OOXML.
- A document from outside is untrusted: it may carry macros, external references and
  tracked changes from other people. Do not accept or reject anyone's tracked changes
  unless the user asked.

## 8. Verify — mandatory

`document_validate` is structure: parts present, relationships resolve, every style a
paragraph references actually exists, no unescaped `&`, no blank-on-open TOC, no
leftover placeholder. **It also fails a document with no named styles at all** — that is
the direct-formatting failure, and it is the difference between a Word document and a
printout that happens to be .docx.

Then render and look, in this order:

1. **Half-empty pages** from hard page breaks, and **text overflowing a table cell**
   or a column too narrow to hold its sentences.
2. A heading alone at the foot of a page, or a table split across a break.
3. A callout or figure separated from the text it belongs to.
4. The TOC — in a LibreOffice render it is blank, which is expected; Word fills it.
5. Page numbers and the running footer on every page.

## 9. Failure catalog

1. **The direct-formatted document** — no named styles, so nothing can be restyled and
   the navigation pane is empty. `document_validate` warns; fix it, do not ship it.
2. **The PDF that should have been a PDF.** If nobody will edit it, `pdf_design` makes
   a better document.
3. **The wall.** Two pages with no heading, table, list or callout. Break it.
4. **The bare number.** A figure with no baseline and no unit.
5. **The silent replace.** `find_replace` reporting zero hits, treated as done.
6. **The blank contents.** A TOC field with `updateFields` unset — it opens empty and
   the reader assumes the document is broken.
7. **The half-empty page.** A hard page break before every section, so sections that
   run short leave most of a page white. Use breaks sparingly and look at the render.
8. **The unread document.** Validated, never rendered, sent. If you could not render,
   say which check you skipped.
