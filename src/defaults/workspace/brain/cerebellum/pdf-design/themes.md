# Document Themes

Eight complete, tested palettes for the document design manual. Each one is a full
token set — paper, ink, hairline, accent, wash, cover ground — that drops into the
**same** component kit. Nothing else about the document changes: same type scale, same
tables, same stat tiles, same footers. The theme is the only variable.

Every palette here was checked two ways before it earned its place: contrast ratios
computed for each load-bearing pair, and a specimen sheet rendered through the real
component kit and looked at. Do not invent a palette by feel when one of these fits —
these are the tested ones.

---

## 1. Choosing

Pick from the subject, not from novelty. A brief about the same subject should get the
same theme twice; variety across *different* documents is the goal, not variety for its
own sake.

| If the document is about… | Use |
|---|---|
| Anything unspecified, corporate, technology, strategy | **Steel** (the house default) |
| Health, clinical, environment, water, duty-of-care subjects | **Teal** |
| Sustainability, agriculture, land, long-horizon growth | **Forest** |
| Research, data, models, academic and analytical work | **Indigo** |
| Culture, brand, editorial, education | **Plum** |
| Risk, audit, legal, compliance, incident reviews | **Claret** |
| Energy, industry, logistics, operations, manufacturing | **Rust** |
| Minimal / editorial, where tables and charts carry the signal | **Graphite** |

When the user names a brand colour, that hue wins over this table — build a custom
theme (section 3) rather than forcing the nearest listed one.

## 2. The palettes

### Steel — `steel`

The house default. Corporate, technology, strategy, anything unspecified.

```css
:root {
  --paper:   #ffffff;  --ink:    #16202e;  --ink-2: #3d4a5c;
  --muted:   #5b6878;  --hairline: #e2e6eb;
  --accent:  #1d4ed8;  --accent-deep: #16307a;  --wash: #eef2fb;
  --good:    #166534;  --warn:   #b45309;  --bad:  #b91c1c;
  --cover-a: #0f1b33;  --cover-b: #16307a;   /* cover ground gradient */
}
```

### Teal — `teal`

Health, clinical, environment, water, calm subjects with a duty of care.

```css
:root {
  --paper:   #ffffff;  --ink:    #12211f;  --ink-2: #354a47;
  --muted:   #5a6f6c;  --hairline: #e0e8e6;
  --accent:  #0f766e;  --accent-deep: #134e4a;  --wash: #ecf6f4;
  --good:    #3f6212;  --warn:   #b45309;  --bad:  #b91c1c;
  --cover-a: #0b1f1d;  --cover-b: #134e4a;   /* cover ground gradient */
}
```

### Forest — `forest`

Sustainability, agriculture, land, long-horizon and growth subjects.

```css
:root {
  --paper:   #ffffff;  --ink:    #15211a;  --ink-2: #3a4a41;
  --muted:   #5d6f64;  --hairline: #e3e9e4;
  --accent:  #15803d;  --accent-deep: #14532d;  --wash: #edf6ef;
  --good:    #0f766e;  --warn:   #b45309;  --bad:  #b91c1c;
  --cover-a: #0c1a12;  --cover-b: #14532d;   /* cover ground gradient */
}
```

### Indigo — `indigo`

Research, data, models, academic and analytical work.

```css
:root {
  --paper:   #ffffff;  --ink:    #1a1a2e;  --ink-2: #3f3f5c;
  --muted:   #63637e;  --hairline: #e4e4ee;
  --accent:  #4338ca;  --accent-deep: #312e81;  --wash: #eef0fc;
  --good:    #166534;  --warn:   #b45309;  --bad:  #b91c1c;
  --cover-a: #14142b;  --cover-b: #312e81;   /* cover ground gradient */
}
```

### Plum — `plum`

Culture, brand, editorial, education — warmth without informality.

```css
:root {
  --paper:   #ffffff;  --ink:    #221a2b;  --ink-2: #493d55;
  --muted:   #6d6480;  --hairline: #e9e4ef;
  --accent:  #7e22ce;  --accent-deep: #581c87;  --wash: #f5eefc;
  --good:    #166534;  --warn:   #b45309;  --bad:  #b91c1c;
  --cover-a: #1a1024;  --cover-b: #581c87;   /* cover ground gradient */
}
```

### Claret — `claret`

Risk, audit, legal, compliance, incident reviews — weight and seriousness.

```css
:root {
  --paper:   #ffffff;  --ink:    #241419;  --ink-2: #4f3941;
  --muted:   #6f6068;  --hairline: #ece2e5;
  --accent:  #86174a;  --accent-deep: #5c0f33;  --wash: #fbeef4;
  --good:    #166534;  --warn:   #b45309;  --bad:  #b91c1c;
  --cover-a: #1a0a12;  --cover-b: #5c0f33;   /* cover ground gradient */
}
```

### Rust — `rust`

Energy, industry, logistics, operations, manufacturing — warmth that still clears the warning colours.

```css
:root {
  --paper:   #fffdfb;  --ink:    #26180f;  --ink-2: #4f3a2c;
  --muted:   #6f6055;  --hairline: #ece2da;
  --accent:  #7c2d12;  --accent-deep: #5a1f0c;  --wash: #fbf0e9;
  --good:    #166534;  --warn:   #b45309;  --bad:  #b91c1c;
  --cover-a: #1a0e07;  --cover-b: #5a1f0c;   /* cover ground gradient */
}
```

### Graphite — `graphite`

Minimal and editorial. Lets tables, charts and semantic colour carry all the signal.

```css
:root {
  --paper:   #ffffff;  --ink:    #0f172a;  --ink-2: #334155;
  --muted:   #5b6779;  --hairline: #e2e8f0;
  --accent:  #334155;  --accent-deep: #1e293b;  --wash: #f1f5f9;
  --good:    #166534;  --warn:   #b45309;  --bad:  #b91c1c;
  --cover-a: #0b1220;  --cover-b: #1e293b;   /* cover ground gradient */
}
```

---

## 3. Building a theme that is not on the list

When the subject or a named brand demands its own hue, derive the full set — never
half of it. A theme with an accent but a borrowed ink and wash looks wrong in a way
that is hard to name.

1. **Accent** — the brand hue, or the subject's hue. Must reach **4.5:1 on paper**; it
   is used for small text (TOC numbers, callout rules).
2. **Accent-deep** — the same hue, much darker. Must reach **7:1 against white**; it
   carries white text on section chips, step numbers and the cover ground.
3. **Wash** — the accent at roughly 5% over paper. Body ink must reach **10:1** on it.
4. **Ink** — near-black, nudged toward the accent hue. **12:1 on paper** minimum.
   Never pure `#000`.
5. **Ink-2 / muted** — **7:1** and **4.5:1** on paper. A muted that fails 4.5:1 is the
   light-grey-caption failure; captions and footers live at this value.
6. **Hairline** — must stay *under* 1.4:1 against paper. A hairline you can clearly
   see is a border, and borders date a document.
7. **Cover gradient** — two close dark shades of the accent family.
8. **Semantics stay put.** `--good #166534`, `--warn #b45309`, `--bad #b91c1c` are not
   yours to restyle. If the accent lands near one of them, move the **accent**, not the
   semantic — a reader's expectation that red means bad outranks your palette.

### The warm-band rule

The yellow-through-red band belongs to the semantic trio. An accent in that band is
only safe if it is dark enough to separate on lightness — measured, not guessed. This
is why **Rust** is a deep oxide `#7c2d12` rather than the obvious bright orange: the
bright oranges all sit within touching distance of `--warn` and `--bad` and make a
warning indistinguishable from decoration.

### Checking a custom theme

Compute the ratios; do not eyeball them. Contrast is
`(L1 + 0.05) / (L2 + 0.05)` on relative luminance, and the pairs that must pass are:
ink/paper ≥ 12, ink-2/paper ≥ 7, muted/paper ≥ 4.5, white/accent-deep ≥ 7,
accent-deep/wash ≥ 4.5, accent/paper ≥ 4.5, ink/wash ≥ 10, hairline/paper ≤ 1.4.
Then render one page with a stat row, a table and the three callouts, and look at it.

## 4. What the theme never changes

The theme is a palette swap and nothing more. These hold in all eight:

- Light body pages. Dark grounds stay on the cover, optional dividers, and a back page.
- One accent. Tints and the deep variant are free; a second hue is not.
- The semantic trio is semantic only — a verdict, a delta, a risk level. Never "the
  colour of tile three".
- **Semantic callouts are not tinted.** The accent callout wears the wash; good / warn /
  bad callouts sit on paper inside a hairline box with a coloured left rule. This is
  structural, not stylistic: in most themes the wash and a tinted semantic ground are
  the same colour to the eye, which makes an accent note and a warning
  indistinguishable. Separate them by *shape*, and the problem cannot come back.
- The type scale, the hairline discipline, the footers, and every measurement in the
  manual are theme-independent.
