// Presentation — read, create, edit and verify .pptx decks.
//
// Two halves:
//  1. A LAYOUT ENGINE (`presentation_create`). The model supplies content and
//     picks a layout name per slide; the engine owns every geometry, type and
//     colour decision. That inversion is deliberate — hand-placed shapes are
//     where decks go wrong (overflow, drifting margins, ten different greys),
//     and a model cannot see the slide it just wrote. Guardrails live in code,
//     not in prose: hex is normalised, the canvas is defined explicitly, and
//     every option object is built fresh (pptxgenjs mutates them in place).
//  2. A READ/EDIT path over the raw OOXML zip for decks the engine did not
//     make — templates, client decks, anything already on disk.
//
// Palettes are the eight contrast-tested themes from `pdf-design/themes.md`,
// so a deck and its companion document come out of the same colour system.

import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { spawn } from 'node:child_process'
import PptxGenJS from 'pptxgenjs'
import AdmZip from 'adm-zip'

// ── Themes ────────────────────────────────────────────────────────────────
// Verbatim from pdf-design/themes.md. `cover` is the deep end of that file's
// cover gradient (a pptx background is flat, so we take the darker stop).

const THEMES = {
  steel:    { ink: '16202E', ink2: '3D4A5C', muted: '5B6878', hairline: 'E2E6EB', accent: '1D4ED8', accentDeep: '16307A', wash: 'EEF2FB', cover: '0F1B33', paper: 'FFFFFF' },
  teal:     { ink: '12211F', ink2: '354A47', muted: '5A6F6C', hairline: 'E0E8E6', accent: '0F766E', accentDeep: '134E4A', wash: 'ECF6F4', cover: '0B1F1D', paper: 'FFFFFF' },
  forest:   { ink: '15211A', ink2: '3A4A41', muted: '5D6F64', hairline: 'E3E9E4', accent: '15803D', accentDeep: '14532D', wash: 'EDF6EF', cover: '0C1A12', paper: 'FFFFFF' },
  indigo:   { ink: '1A1A2E', ink2: '3F3F5C', muted: '63637E', hairline: 'E4E4EE', accent: '4338CA', accentDeep: '312E81', wash: 'EEF0FC', cover: '14142B', paper: 'FFFFFF' },
  plum:     { ink: '221A2B', ink2: '493D55', muted: '6D6480', hairline: 'E9E4EF', accent: '7E22CE', accentDeep: '581C87', wash: 'F5EEFC', cover: '1A1024', paper: 'FFFFFF' },
  claret:   { ink: '241419', ink2: '4F3941', muted: '6F6068', hairline: 'ECE2E5', accent: '86174A', accentDeep: '5C0F33', wash: 'FBEEF4', cover: '1A0A12', paper: 'FFFFFF' },
  rust:     { ink: '26180F', ink2: '4F3A2C', muted: '6F6055', hairline: 'ECE2DA', accent: '7C2D12', accentDeep: '5A1F0C', wash: 'FBF0E9', cover: '1A0E07', paper: 'FFFDFB' },
  graphite: { ink: '0F172A', ink2: '334155', muted: '5B6779', hairline: 'E2E8F0', accent: '334155', accentDeep: '1E293B', wash: 'F1F5F9', cover: '0B1220', paper: 'FFFFFF' }
}
const SEMANTIC = { good: '166534', warn: 'B45309', bad: 'B91C1C' }
const DEFAULT_THEME = 'steel'

// Fonts that ship with Office on both platforms AND have predictable metrics,
// so the fit estimate below means something. Anything else is allowed but the
// estimate is reported as approximate.
const SAFE_FONTS = new Set(['Calibri', 'Arial', 'Cambria', 'Times New Roman', 'Courier New', 'Century Schoolbook', 'Bookman Old Style', 'Georgia', 'Verdana', 'Tahoma'])

// Mean advance width as a fraction of font size, measured over mixed-case
// English prose. Used only to flag text that will not fit its box — an
// over-estimate is the safe side, so these run slightly wide.
const CHAR_W = {
  Calibri: 0.479, Arial: 0.529, Cambria: 0.505, 'Times New Roman': 0.475,
  'Courier New': 0.6, 'Century Schoolbook': 0.51, 'Bookman Old Style': 0.545,
  Georgia: 0.514, Verdana: 0.566, Tahoma: 0.525
}
const CHAR_W_FALLBACK = 0.55

// ── Canvas ────────────────────────────────────────────────────────────────

const CANVAS = {
  '16x9': { w: 13.333, h: 7.5 },
  '4x3': { w: 10, h: 7.5 }
}

/** Every geometry constant in one place; all values in inches. */
function geometry(aspect) {
  const c = CANVAS[aspect] || CANVAS['16x9']
  const mx = aspect === '4x3' ? 0.55 : 0.68
  return {
    W: c.w,
    H: c.h,
    mx,
    mtop: 0.52,
    mbot: 0.46,
    contentW: c.w - mx * 2,
    titleY: 0.52,
    titleH: 0.82,
    ruleY: 1.42,
    bodyY: 1.68,
    get bodyH() { return c.h - this.bodyY - 0.62 },
    footerY: c.h - 0.42
  }
}

// ── Type scale (pt) ───────────────────────────────────────────────────────

const TYPE = {
  coverTitle: 40, coverSub: 16, coverEyebrow: 11,
  sectionNum: 58, sectionTitle: 32, sectionSub: 14,
  slideTitle: 28, lead: 15, body: 14.5, bullet: 15,
  cardTitle: 13.5, cardBody: 11.5,
  statValue: 40, statLabel: 11,
  quote: 26, attribution: 13,
  tableHead: 11.5, tableCell: 11.5,
  stepNum: 15, stepTitle: 13, stepBody: 11,
  caption: 10.5, footer: 9
}

// ── Guardrails ────────────────────────────────────────────────────────────

/**
 * Normalise a colour to the bare 6-digit form pptxgenjs requires. A leading
 * '#' and an 8-digit alpha hex each corrupt the generated file rather than
 * erroring, so both are caught here instead of reaching the library.
 */
function hex(value, fallback) {
  if (value == null || value === '') {
    if (fallback == null) throw new Error('a colour is required')
    return fallback
  }
  let v = String(value).trim().replace(/^#/, '').toUpperCase()
  if (/^[0-9A-F]{8}$/.test(v)) {
    throw new Error(`colour "${value}" carries an alpha channel; pptx needs 6 hex digits — use transparency instead`)
  }
  if (/^[0-9A-F]{3}$/.test(v)) v = v.split('').map((ch) => ch + ch).join('')
  if (!/^[0-9A-F]{6}$/.test(v)) {
    throw new Error(`colour "${value}" is not a 6-digit hex value`)
  }
  return v
}

function parseJsonParam(value, name) {
  if (value == null) return undefined
  if (typeof value === 'object') return value
  if (typeof value === 'string') {
    try { return JSON.parse(value) } catch {
      throw new Error(`Invalid JSON in ${name} parameter`)
    }
  }
  throw new Error(`Expected object or JSON string for ${name}, got ${typeof value}`)
}

function resolvePath(input) {
  if (!input || typeof input !== 'string') throw new Error('path is required')
  if (input === '~') return os.homedir()
  if (input.startsWith('~/') || input.startsWith('~\\')) return path.join(os.homedir(), input.slice(2))
  return path.resolve(input)
}

function str(value) {
  return value == null ? '' : String(value)
}

/** Estimated rendered lines for `text` in a box `w` inches wide at `size` pt. */
function estimateLines(text, w, size, fontFace) {
  const body = str(text)
  if (!body) return 0
  const per = (CHAR_W[fontFace] ?? CHAR_W_FALLBACK) * size / 72
  const capacity = Math.max(1, Math.floor((w - 0.2) / per))
  return body.split('\n').reduce((total, line) => total + Math.max(1, Math.ceil(line.length / capacity)), 0)
}

/** Height in inches that `text` needs at `size` pt with normal leading. */
function estimateHeight(text, w, size, fontFace) {
  return estimateLines(text, w, size, fontFace) * (size * 1.22) / 72
}

// ── Layout engine ─────────────────────────────────────────────────────────
// Each renderer receives (slide, spec, ctx) and owns its geometry. ctx carries
// the theme, fonts, geometry and the running fit-warning list. Nothing here
// reads a value the caller could have got wrong: colours come from the theme,
// positions from `g`, sizes from TYPE.

function warnFit(ctx, slideNo, what, needed, available) {
  if (needed <= available) return
  const over = Math.round(((needed - available) / available) * 100)
  ctx.warnings.push(`slide ${slideNo}: ${what} needs about ${needed.toFixed(2)}in of ${available.toFixed(2)}in (~${over}% over) — shorten it, or move the overflow to a second slide`)
}

/**
 * Where a content block of `contentH` should start inside the body band.
 * Top-anchoring every layout leaves short slides two-thirds empty, which is
 * the commonest way a generated deck looks unfinished; centring outright
 * makes long slides drift. So: push down by a fraction of the slack, capped.
 */
function balanceTop(g, contentH) {
  const slack = Math.max(0, g.bodyH - contentH)
  return g.bodyY + Math.min(0.7, slack * 0.38)
}

/** Title band + hairline rule + footer. Shared by every content layout. */
/**
 * pptxgenjs omits `algn` from a paragraph unless you pass `align`, leaving the
 * alignment to be inherited. Every renderer resolves that inheritance its own
 * way, and some resolve a plain text box to CENTER — which silently ruins a
 * left-aligned deck everywhere but PowerPoint. Writing the alignment we
 * actually mean costs one attribute per paragraph and removes the guess.
 * Explicit `align` on a call still wins.
 */
function withDefaultAlignment(slide) {
  const addText = slide.addText.bind(slide)
  slide.addText = (text, opts) => addText(text, { align: 'left', ...opts })
  return slide
}

function drawChrome(slide, spec, ctx, slideNo) {
  const { g, t, fonts } = ctx
  const title = str(spec.title)
  if (spec.eyebrow) {
    slide.addText(str(spec.eyebrow).toUpperCase(), {
      x: g.mx, y: g.titleY - 0.28, w: g.contentW, h: 0.24,
      fontSize: 10, fontFace: fonts.body, color: t.accent, bold: true,
      charSpacing: 1.6, margin: 0, valign: 'bottom', objectName: 'wf-eyebrow'
    })
  }
  if (title) {
    const size = estimateLines(title, g.contentW, TYPE.slideTitle, fonts.display) > 1 ? TYPE.slideTitle - 4 : TYPE.slideTitle
    slide.addText(title, {
      x: g.mx, y: spec.eyebrow ? g.titleY + 0.04 : g.titleY, w: g.contentW, h: g.titleH,
      fontSize: size, fontFace: fonts.display, color: t.ink, bold: true,
      margin: 0, valign: 'top', objectName: 'wf-title'
    })
    warnFit(ctx, slideNo, 'the slide title', estimateHeight(title, g.contentW, size, fonts.display), g.titleH + 0.16)
  }
  slide.addShape('rect', {
    x: g.mx, y: g.ruleY, w: 1.1, h: 0.035, fill: { color: t.accent }, line: { type: 'none' }
  })
}

function drawFooter(slide, ctx, slideNo) {
  const { g, t, fonts } = ctx
  if (!ctx.footer) return
  slide.addText(ctx.footer, {
    x: g.mx, y: g.footerY, w: g.contentW - 0.8, h: 0.26,
    fontSize: TYPE.footer, fontFace: fonts.body, color: t.muted, margin: 0, valign: 'middle', objectName: 'wf-footer'
  })
  slide.addText(String(slideNo), {
    x: g.W - g.mx - 0.8, y: g.footerY, w: 0.8, h: 0.26,
    fontSize: TYPE.footer, fontFace: fonts.body, color: t.muted, align: 'right', margin: 0, valign: 'middle', objectName: 'wf-pagenum'
  })
}

const LAYOUTS = {
  title(slide, spec, ctx, slideNo) {
    const { g, t, fonts } = ctx
    slide.background = { color: t.cover }
    const titleText = str(spec.title)
    if (spec.eyebrow) {
      slide.addText(str(spec.eyebrow).toUpperCase(), {
        x: g.mx, y: 2.18, w: g.contentW, h: 0.3,
        fontSize: TYPE.coverEyebrow, fontFace: fonts.body, color: t.hairline,
        bold: true, charSpacing: 2, margin: 0, valign: 'bottom', transparency: 35
      })
    }
    const titleSize = titleText.length > 62 ? TYPE.coverTitle - 8 : TYPE.coverTitle
    slide.addText(titleText, {
      x: g.mx, y: 2.55, w: g.contentW * 0.88, h: 1.9,
      fontSize: titleSize, fontFace: fonts.display, color: 'FFFFFF', bold: true,
      margin: 0, valign: 'top', lineSpacingMultiple: 1.02, objectName: 'wf-title'
    })
    warnFit(ctx, slideNo, 'the cover title', estimateHeight(titleText, g.contentW * 0.88, titleSize, fonts.display), 1.9)
    slide.addShape('rect', {
      x: g.mx, y: 4.62, w: 1.5, h: 0.045, fill: { color: t.accent }, line: { type: 'none' }
    })
    if (spec.subtitle) {
      slide.addText(str(spec.subtitle), {
        x: g.mx, y: 4.92, w: g.contentW * 0.7, h: 0.9,
        fontSize: TYPE.coverSub, fontFace: fonts.body, color: t.hairline, margin: 0, valign: 'top', transparency: 20
      })
    }
    if (spec.meta) {
      slide.addText(str(spec.meta), {
        x: g.mx, y: g.H - 0.92, w: g.contentW, h: 0.3,
        fontSize: TYPE.footer + 1, fontFace: fonts.body, color: t.hairline, margin: 0, transparency: 45
      })
    }
  },

  section(slide, spec, ctx, slideNo) {
    const { g, t, fonts } = ctx
    slide.background = { color: t.cover }
    if (spec.number != null) {
      slide.addText(String(spec.number).padStart(2, '0'), {
        x: g.mx, y: 2.0, w: 2.6, h: 1.1,
        fontSize: TYPE.sectionNum, fontFace: fonts.display, color: t.accent, bold: true, margin: 0, valign: 'middle'
      })
    }
    const y = spec.number != null ? 3.2 : 2.9
    slide.addText(str(spec.title), {
      x: g.mx, y, w: g.contentW * 0.82, h: 1.2,
      fontSize: TYPE.sectionTitle, fontFace: fonts.display, color: 'FFFFFF', bold: true, margin: 0, valign: 'top', objectName: 'wf-title'
    })
    warnFit(ctx, slideNo, 'the section title', estimateHeight(spec.title, g.contentW * 0.82, TYPE.sectionTitle, fonts.display), 1.2)
    if (spec.subtitle) {
      slide.addText(str(spec.subtitle), {
        x: g.mx, y: y + 1.22, w: g.contentW * 0.62, h: 0.8,
        fontSize: TYPE.sectionSub, fontFace: fonts.body, color: t.hairline, margin: 0, valign: 'top', transparency: 25
      })
    }
  },

  bullets(slide, spec, ctx, slideNo) {
    const { g, t, fonts } = ctx
    drawChrome(slide, spec, ctx, slideNo)
    let y = g.bodyY
    let h = g.bodyH
    if (spec.lead) {
      const leadH = Math.max(0.36, estimateHeight(spec.lead, g.contentW * 0.82, TYPE.lead, fonts.body) + 0.1)
      slide.addText(str(spec.lead), {
        x: g.mx, y, w: g.contentW * 0.82, h: leadH,
        fontSize: TYPE.lead, fontFace: fonts.body, color: t.ink2, margin: 0, valign: 'top'
      })
      y += leadH + 0.24
      h -= leadH + 0.24
    }
    const items = Array.isArray(spec.bullets) ? spec.bullets : []
    if (items.length) {
      const needed = items.reduce((sum, item) => {
        const text = str(item && typeof item === 'object' ? item.text : item)
        return sum + estimateHeight(text, g.contentW * 0.88 - 0.3, TYPE.bullet, fonts.body) + 0.125
      }, 0)
      if (!spec.lead) { const balanced = balanceTop(g, needed); h -= balanced - y; y = balanced }
      const runs = items.map((item, i) => {
        const isObj = item && typeof item === 'object'
        return {
          text: str(isObj ? item.text : item),
          options: {
            bullet: { indent: 18 },
            breakLine: i < items.length - 1,
            bold: Boolean(isObj && item.bold),
            color: isObj && item.muted ? t.muted : t.ink,
            paraSpaceAfter: 9
          }
        }
      })
      slide.addText(runs, {
        x: g.mx, y, w: g.contentW * 0.88, h,
        fontSize: TYPE.bullet, fontFace: fonts.body, color: t.ink, margin: 0, valign: 'top'
      })
      warnFit(ctx, slideNo, `${items.length} bullets`, needed, h)
    }
    drawFooter(slide, ctx, slideNo)
  },

  'two-column': function twoColumn(slide, spec, ctx, slideNo) {
    const { g, t, fonts } = ctx
    drawChrome(slide, spec, ctx, slideNo)
    const gap = 0.52
    const colW = (g.contentW - gap) / 2
    const tallest = Math.max(...[spec.left, spec.right].map((col) => {
      if (!col) return 0
      const head = col.heading ? 0.46 : 0
      const items = Array.isArray(col.bullets) ? col.bullets : null
      if (items) return head + items.reduce((sum, it) => sum + estimateHeight(it, colW - 0.3, TYPE.body, fonts.body) + 0.11, 0)
      return head + (col.body ? estimateHeight(col.body, colW, TYPE.body, fonts.body) : 0)
    }))
    const colTop = balanceTop(g, tallest)
    for (const [i, col] of [spec.left, spec.right].entries()) {
      if (!col) continue
      const x = g.mx + i * (colW + gap)
      let y = colTop
      if (col.heading) {
        slide.addText(str(col.heading), {
          x, y, w: colW, h: 0.34,
          fontSize: TYPE.cardTitle + 1.5, fontFace: fonts.display, color: t.accent, bold: true, margin: 0, valign: 'top'
        })
        y += 0.46
      }
      const items = Array.isArray(col.bullets) ? col.bullets : null
      if (items && items.length) {
        slide.addText(items.map((item, j) => ({
          text: str(item), options: { bullet: { indent: 16 }, breakLine: j < items.length - 1, paraSpaceAfter: 8 }
        })), {
          x, y, w: colW, h: g.bodyY + g.bodyH - y,
          fontSize: TYPE.body, fontFace: fonts.body, color: t.ink, margin: 0, valign: 'top'
        })
        const needed = items.reduce((sum, it) => sum + estimateHeight(it, colW - 0.3, TYPE.body, fonts.body) + 0.11, 0)
        warnFit(ctx, slideNo, `the ${i === 0 ? 'left' : 'right'} column`, needed, g.bodyY + g.bodyH - y)
      } else if (col.body) {
        slide.addText(str(col.body), {
          x, y, w: colW, h: g.bodyY + g.bodyH - y,
          fontSize: TYPE.body, fontFace: fonts.body, color: t.ink, margin: 0, valign: 'top'
        })
        warnFit(ctx, slideNo, `the ${i === 0 ? 'left' : 'right'} column`, estimateHeight(col.body, colW, TYPE.body, fonts.body), g.bodyY + g.bodyH - y)
      }
    }
    drawFooter(slide, ctx, slideNo)
  },

  cards(slide, spec, ctx, slideNo) {
    const { g, t, fonts } = ctx
    drawChrome(slide, spec, ctx, slideNo)
    const cards = (Array.isArray(spec.cards) ? spec.cards : []).slice(0, 6)
    if (!cards.length) return drawFooter(slide, ctx, slideNo)
    // Column count per card count. Three cards in two columns leaves an
    // orphan and an empty quadrant — the single most visible way a card
    // slide looks broken, so the mapping is explicit rather than derived.
    const cols = [1, 2, 3, 2, 3, 3][cards.length - 1]
    const gap = 0.26
    const rows = []
    for (let i = 0; i < cards.length; i += cols) rows.push(cards.slice(i, i + cols))
    // Height from the tallest card's content, not from the band: a row of
    // three short cards should be short, not stretched down the slide.
    const probeW = (g.contentW - gap * (cols - 1)) / cols - 0.52
    const needed = Math.max(...cards.map((c) => {
      const label = c.label != null ? 0.3 : 0
      return 0.26 + label + 0.44 + (c.body ? estimateHeight(c.body, probeW, TYPE.cardBody, fonts.body) : 0) + 0.26
    }))
    const maxRowH = (g.bodyH - gap * (rows.length - 1)) / rows.length
    // Floor the height so a single row of short cards still has presence:
    // content-sized cards on an empty band read as an unfinished slide.
    const floor = rows.length === 1 ? 3.0 : 1.6
    const ch = Math.min(maxRowH, Math.max(floor, needed))
    const blockH = ch * rows.length + gap * (rows.length - 1)
    const top = balanceTop(g, blockH)
    let index = 0
    rows.forEach((row, r) => {
      // A short last row shares the full width rather than leaving a hole.
      const cw = (g.contentW - gap * (row.length - 1)) / row.length
      row.forEach((card, c) => {
        const x = g.mx + c * (cw + gap)
        const y = top + r * (ch + gap)
        index += 1
        slide.addShape('rect', {
          x, y, w: cw, h: ch,
          fill: { color: card.emphasis ? t.wash : t.paper },
          line: { color: t.hairline, width: 1 }
        })
        let ty = y + 0.26
        if (card.label != null) {
          slide.addText(String(card.label).toUpperCase(), {
            x: x + 0.26, y: ty, w: cw - 0.52, h: 0.22,
            fontSize: 9.5, fontFace: fonts.body, color: t.accent, bold: true, charSpacing: 1.4, margin: 0, valign: 'top'
          })
          ty += 0.3
        }
        slide.addText(str(card.title), {
          x: x + 0.26, y: ty, w: cw - 0.52, h: 0.4,
          fontSize: TYPE.cardTitle, fontFace: fonts.display, color: t.ink, bold: true, margin: 0, valign: 'top'
        })
        ty += 0.44
        if (card.body) {
          const availH = y + ch - ty - 0.22
          slide.addText(str(card.body), {
            x: x + 0.26, y: ty, w: cw - 0.52, h: availH,
            fontSize: TYPE.cardBody, fontFace: fonts.body, color: t.ink2, margin: 0, valign: 'top'
          })
          warnFit(ctx, slideNo, `card ${index} ("${str(card.title).slice(0, 28)}")`, estimateHeight(card.body, cw - 0.52, TYPE.cardBody, fonts.body), availH)
        }
      })
    })
    drawFooter(slide, ctx, slideNo)
  },

  stats(slide, spec, ctx, slideNo) {
    const { g, t, fonts } = ctx
    drawChrome(slide, spec, ctx, slideNo)
    const stats = (Array.isArray(spec.stats) ? spec.stats : []).slice(0, 4)
    if (!stats.length) return drawFooter(slide, ctx, slideNo)
    const gap = 0.3
    const cw = (g.contentW - gap * (stats.length - 1)) / stats.length
    const hasNote = stats.some((s) => s.note)
    const blockH = 1.3 + (hasNote ? 0.62 : 0) + (spec.body ? 0.7 : 0)
    const top = balanceTop(g, blockH)
    const ruleH = 1.16 + (hasNote ? 0.5 : 0)
    stats.forEach((stat, i) => {
      const x = g.mx + i * (cw + gap)
      if (i > 0) {
        // A filled rect this thin disappears in some renderers; a line shape
        // is drawn as a stroke and survives.
        slide.addShape('line', {
          x: x - gap / 2, y: top, w: 0, h: ruleH, line: { color: t.hairline, width: 1 }
        })
      }
      const value = str(stat.value)
      const size = value.length > 7 ? TYPE.statValue - 12 : value.length > 5 ? TYPE.statValue - 6 : TYPE.statValue
      slide.addText(value, {
        x, y: top, w: cw, h: 0.95,
        fontSize: size, fontFace: fonts.display, color: stat.tone && SEMANTIC[stat.tone] ? SEMANTIC[stat.tone] : t.accent,
        bold: true, margin: 0, valign: 'middle'
      })
      slide.addText(str(stat.label).toUpperCase(), {
        x, y: top + 1.0, w: cw, h: 0.3,
        fontSize: TYPE.statLabel, fontFace: fonts.body, color: t.muted, bold: true, charSpacing: 1.2, margin: 0, valign: 'top'
      })
      if (stat.note) {
        slide.addText(str(stat.note), {
          x, y: top + 1.34, w: cw, h: 0.6,
          fontSize: TYPE.cardBody, fontFace: fonts.body, color: t.ink2, margin: 0, valign: 'top'
        })
      }
    })
    if (spec.body) {
      const by = top + 1.34 + (hasNote ? 0.62 : 0) + 0.34
      slide.addText(str(spec.body), {
        x: g.mx, y: by, w: g.contentW * 0.8, h: Math.max(0.4, g.bodyY + g.bodyH - by),
        fontSize: TYPE.body, fontFace: fonts.body, color: t.ink2, margin: 0, valign: 'top'
      })
    }
    drawFooter(slide, ctx, slideNo)
  },

  quote(slide, spec, ctx, slideNo) {
    const { g, t, fonts } = ctx
    slide.background = { color: t.wash }
    const quote = str(spec.quote || spec.title)
    const size = quote.length > 180 ? TYPE.quote - 8 : quote.length > 110 ? TYPE.quote - 4 : TYPE.quote
    slide.addShape('rect', {
      x: g.mx, y: 2.1, w: 0.05, h: 2.6, fill: { color: t.accent }, line: { type: 'none' }
    })
    slide.addText(quote, {
      x: g.mx + 0.42, y: 2.1, w: g.contentW - 0.9, h: 2.6,
      fontSize: size, fontFace: fonts.display, color: t.ink, italic: true, margin: 0, valign: 'middle', lineSpacingMultiple: 1.16
    })
    warnFit(ctx, slideNo, 'the quote', estimateHeight(quote, g.contentW - 0.9, size, fonts.display) * 1.16, 2.6)
    if (spec.attribution) {
      slide.addText(str(spec.attribution), {
        x: g.mx + 0.42, y: 4.85, w: g.contentW - 0.9, h: 0.4,
        fontSize: TYPE.attribution, fontFace: fonts.body, color: t.muted, margin: 0, valign: 'top'
      })
    }
    drawFooter(slide, ctx, slideNo)
  },

  table(slide, spec, ctx, slideNo) {
    const { g, t, fonts } = ctx
    drawChrome(slide, spec, ctx, slideNo)
    const columns = Array.isArray(spec.columns) ? spec.columns.map(str) : []
    const rows = Array.isArray(spec.rows) ? spec.rows : []
    if (!columns.length && !rows.length) return drawFooter(slide, ctx, slideNo)
    const head = columns.map((c) => ({
      text: c,
      options: { bold: true, color: 'FFFFFF', fill: { color: t.accentDeep }, fontSize: TYPE.tableHead, align: 'left' }
    }))
    const body = rows.map((row, r) => (Array.isArray(row) ? row : [row]).map((cell) => ({
      text: str(cell),
      options: {
        color: t.ink, fontSize: TYPE.tableCell, align: 'left',
        fill: { color: r % 2 ? t.wash : t.paper }
      }
    })))
    const rowH = (TYPE.tableCell * 1.5 + 14) / 72
    const tableH = (rows.length + (head.length ? 1 : 0)) * rowH
    slide.addTable(head.length ? [head, ...body] : body, {
      x: g.mx, y: balanceTop(g, tableH), w: g.contentW,
      colW: Array.isArray(spec.col_widths) && spec.col_widths.length === columns.length
        ? spec.col_widths.map((n) => (Number(n) / spec.col_widths.reduce((a, b) => a + Number(b), 0)) * g.contentW)
        : undefined,
      border: { type: 'solid', color: t.hairline, pt: 0.75 },
      fontFace: fonts.body,
      autoPage: false,
      margin: [7, 9, 7, 9]
    })
    warnFit(ctx, slideNo, `a ${rows.length}-row table`, tableH, g.bodyH)
    if (spec.caption) {
      slide.addText(str(spec.caption), {
        x: g.mx, y: g.footerY - 0.34, w: g.contentW * 0.8, h: 0.28,
        fontSize: TYPE.caption, fontFace: fonts.body, color: t.muted, margin: 0, valign: 'top'
      })
    }
    drawFooter(slide, ctx, slideNo)
  },

  steps(slide, spec, ctx, slideNo) {
    const { g, t, fonts } = ctx
    drawChrome(slide, spec, ctx, slideNo)
    const steps = (Array.isArray(spec.steps) ? spec.steps : []).slice(0, 6)
    if (!steps.length) return drawFooter(slide, ctx, slideNo)
    const rowH = Math.min(1.05, g.bodyH / steps.length)
    const top = balanceTop(g, rowH * steps.length)
    steps.forEach((step, i) => {
      const y = top + i * rowH
      slide.addShape('ellipse', {
        x: g.mx, y: y + 0.04, w: 0.42, h: 0.42, fill: { color: t.accent }, line: { type: 'none' }
      })
      slide.addText(String(i + 1), {
        x: g.mx, y: y + 0.04, w: 0.42, h: 0.42,
        fontSize: TYPE.stepNum - 2, fontFace: fonts.display, color: 'FFFFFF', bold: true,
        align: 'center', valign: 'middle', margin: 0
      })
      slide.addText(str(step.title), {
        x: g.mx + 0.62, y: y + 0.02, w: g.contentW - 0.62, h: 0.3,
        fontSize: TYPE.stepTitle, fontFace: fonts.display, color: t.ink, bold: true, margin: 0, valign: 'top'
      })
      if (step.body) {
        slide.addText(str(step.body), {
          x: g.mx + 0.62, y: y + 0.32, w: g.contentW - 0.62, h: rowH - 0.36,
          fontSize: TYPE.stepBody, fontFace: fonts.body, color: t.ink2, margin: 0, valign: 'top'
        })
        warnFit(ctx, slideNo, `step ${i + 1}`, estimateHeight(step.body, g.contentW - 0.62, TYPE.stepBody, fonts.body), rowH - 0.36)
      }
    })
    drawFooter(slide, ctx, slideNo)
  },

  closing(slide, spec, ctx, slideNo) {
    const { g, t, fonts } = ctx
    slide.background = { color: t.cover }
    slide.addText(str(spec.title), {
      x: g.mx, y: 2.9, w: g.contentW * 0.82, h: 1.1,
      fontSize: TYPE.sectionTitle, fontFace: fonts.display, color: 'FFFFFF', bold: true, margin: 0, valign: 'middle', objectName: 'wf-title'
    })
    slide.addShape('rect', {
      x: g.mx, y: 4.1, w: 1.5, h: 0.045, fill: { color: t.accent }, line: { type: 'none' }
    })
    if (spec.subtitle) {
      slide.addText(str(spec.subtitle), {
        x: g.mx, y: 4.38, w: g.contentW * 0.66, h: 1.0,
        fontSize: TYPE.coverSub, fontFace: fonts.body, color: t.hairline, margin: 0, valign: 'top', transparency: 20
      })
    }
  }
}

// Chart + image live outside the LAYOUTS table above only because they take
// extra arguments (the pptx instance for ChartType, and async image probing).

const CHART_TYPES = {
  bar: { type: 'bar', barDir: 'col' },
  column: { type: 'bar', barDir: 'col' },
  hbar: { type: 'bar', barDir: 'bar' },
  line: { type: 'line' },
  area: { type: 'area' },
  pie: { type: 'pie' },
  doughnut: { type: 'doughnut' },
  scatter: { type: 'scatter' }
}

/** Series colours: one accent for a single series, a theme-consistent ramp beyond. */
function seriesColors(t, count) {
  const ramp = [t.accent, t.accentDeep, t.muted, t.ink2, SEMANTIC.good, SEMANTIC.warn]
  return count <= 1 ? [t.accent] : ramp.slice(0, Math.max(2, count))
}

function drawChart(pres, slide, spec, ctx, slideNo) {
  const { g, t, fonts } = ctx
  drawChrome(slide, spec, ctx, slideNo)
  const chart = spec.chart || {}
  const mapped = CHART_TYPES[String(chart.type || 'bar').toLowerCase()]
  if (!mapped) throw new Error(`unknown chart type "${chart.type}" — use one of ${Object.keys(CHART_TYPES).join(', ')}`)
  const categories = (Array.isArray(chart.categories) ? chart.categories : []).map(str)
  const series = Array.isArray(chart.series) ? chart.series : []
  if (!series.length) throw new Error('chart.series must hold at least one { name, values } entry')
  const data = series.map((s) => ({
    name: str(s.name || 'Series'),
    labels: categories,
    values: (Array.isArray(s.values) ? s.values : []).map((v) => (v == null ? null : Number(v)))
  }))
  const single = data.length <= 1
  const isPie = mapped.type === 'pie' || mapped.type === 'doughnut'
  slide.addChart(mapped.type, data, {
    x: g.mx, y: g.bodyY, w: g.contentW, h: g.bodyH - (spec.caption ? 0.34 : 0),
    barDir: mapped.barDir,
    chartColors: isPie ? seriesColors(t, Math.max(categories.length, 3)) : seriesColors(t, data.length),
    showTitle: false,
    showLegend: !single && !isPie,
    legendPos: 'b',
    legendColor: t.muted,
    legendFontSize: 10,
    showValue: chart.show_values !== false && !isPie,
    dataLabelColor: t.ink2,
    dataLabelFontSize: 9.5,
    dataLabelFormatCode: chart.value_format || undefined,
    dataLabelPosition: mapped.type === 'bar' ? (chart.stacked ? 'ctr' : 'outEnd') : undefined,
    barGrouping: chart.stacked ? 'stacked' : 'clustered',
    catAxisLabelColor: t.muted,
    catAxisLabelFontSize: 10,
    valAxisLabelColor: t.muted,
    valAxisLabelFontSize: 10,
    valGridLine: { color: t.hairline, style: 'solid', size: 1 },
    catGridLine: { style: 'none' },
    valAxisLineShow: false,
    catAxisLineShow: true,
    catAxisLineColor: t.hairline,
    chartArea: { fill: { color: t.paper } },
    dataBorder: isPie ? { pt: 1.5, color: t.paper } : undefined,
    showPercent: isPie,
    holeSize: mapped.type === 'doughnut' ? 55 : undefined
  })
  if (spec.caption) {
    slide.addText(str(spec.caption), {
      x: g.mx, y: g.footerY - 0.34, w: g.contentW * 0.82, h: 0.28,
      fontSize: TYPE.caption, fontFace: fonts.body, color: t.muted, margin: 0, valign: 'top'
    })
  }
  drawFooter(slide, ctx, slideNo)
}

async function drawImage(slide, spec, ctx, slideNo) {
  const { g, t, fonts } = ctx
  const imagePath = resolvePath(spec.image)
  await fs.access(imagePath)
  const mode = spec.mode === 'full' ? 'full' : 'half'
  if (mode === 'full') {
    slide.addImage({ path: imagePath, x: 0, y: 0, w: g.W, h: g.H, sizing: { type: 'cover', w: g.W, h: g.H } })
    if (spec.title) {
      slide.addShape('rect', {
        x: 0, y: g.H - 2.35, w: g.W, h: 2.35, fill: { color: t.cover, transparency: 18 }, line: { type: 'none' }
      })
      slide.addText(str(spec.title), {
        x: g.mx, y: g.H - 1.95, w: g.contentW * 0.8, h: 0.9,
        fontSize: TYPE.sectionTitle - 4, fontFace: ctx.fonts.display, color: 'FFFFFF', bold: true, margin: 0, valign: 'top'
      })
      if (spec.caption) {
        slide.addText(str(spec.caption), {
          x: g.mx, y: g.H - 1.0, w: g.contentW * 0.7, h: 0.5,
          fontSize: TYPE.caption + 1, fontFace: fonts.body, color: t.hairline, margin: 0, valign: 'top', transparency: 15
        })
      }
    }
    return
  }
  drawChrome(slide, spec, ctx, slideNo)
  const half = (g.contentW - 0.5) / 2
  const side = spec.image_side === 'left' ? 'left' : 'right'
  const imgX = side === 'left' ? g.mx : g.mx + half + 0.5
  const txtX = side === 'left' ? g.mx + half + 0.5 : g.mx
  slide.addImage({ path: imagePath, x: imgX, y: g.bodyY, w: half, h: g.bodyH, sizing: { type: 'cover', w: half, h: g.bodyH } })
  const items = Array.isArray(spec.bullets) ? spec.bullets : []
  if (items.length) {
    slide.addText(items.map((item, i) => ({
      text: str(item), options: { bullet: { indent: 16 }, breakLine: i < items.length - 1, paraSpaceAfter: 9 }
    })), {
      x: txtX, y: g.bodyY, w: half, h: g.bodyH,
      fontSize: TYPE.body, fontFace: fonts.body, color: t.ink, margin: 0, valign: 'top'
    })
    warnFit(ctx, slideNo, 'the text column', items.reduce((s, it) => s + estimateHeight(it, half - 0.3, TYPE.body, fonts.body) + 0.12, 0), g.bodyH)
  } else if (spec.body) {
    slide.addText(str(spec.body), {
      x: txtX, y: g.bodyY, w: half, h: g.bodyH,
      fontSize: TYPE.body, fontFace: fonts.body, color: t.ink, margin: 0, valign: 'top'
    })
    warnFit(ctx, slideNo, 'the text column', estimateHeight(spec.body, half, TYPE.body, fonts.body), g.bodyH)
  }
  if (spec.caption) {
    slide.addText(str(spec.caption), {
      x: imgX, y: g.footerY - 0.3, w: half, h: 0.28,
      fontSize: TYPE.caption, fontFace: fonts.body, color: t.muted, margin: 0, valign: 'top'
    })
  }
  drawFooter(slide, ctx, slideNo)
}

// ── presentation_create ───────────────────────────────────────────────────

function resolveTheme(deck) {
  const named = str(deck.theme || DEFAULT_THEME).toLowerCase()
  const base = THEMES[named]
  if (!base && !deck.tokens) {
    throw new Error(`unknown theme "${deck.theme}" — use one of ${Object.keys(THEMES).join(', ')}, or pass a full tokens object`)
  }
  const merged = { ...(base || THEMES[DEFAULT_THEME]), ...(deck.tokens || {}) }
  const out = {}
  for (const [key, value] of Object.entries(merged)) out[key] = hex(value)
  return out
}

/**
 * Repair the chart XML pptxgenjs 4.0.1 emits. Two defects, both verified
 * against the ISO/IEC 29500 chart schema and both silent — every other tool
 * opens the file, and PowerPoint is the one that refuses:
 *
 *  1. Every bar/line/area chart group lists THREE <c:axId> values while only
 *     two axes are declared. An axis id pointing at nothing is what makes
 *     PowerPoint discard the chart and call the file corrupt.
 *  2. <c:lineChart> and <c:areaChart> omit <c:grouping>, which the schema
 *     requires as the group's first child.
 *
 * Text-level repair on the packed part: anything we did not mean to touch
 * stays byte-identical.
 */
function repairChartPart(xml) {
  let out = xml
  let changed = false

  const declared = new Set()
  for (const m of out.matchAll(/<c:(?:catAx|valAx|serAx|dateAx)>([\s\S]*?)<\/c:(?:catAx|valAx|serAx|dateAx)>/g)) {
    const id = /<c:axId val="(\d+)"\/>/.exec(m[1])
    if (id) declared.add(id[1])
  }

  const GROUPS = ['barChart', 'bar3DChart', 'lineChart', 'line3DChart', 'areaChart', 'area3DChart', 'scatterChart', 'radarChart', 'bubbleChart', 'stockChart']
  for (const tag of GROUPS) {
    const re = new RegExp(`<c:${tag}>[\\s\\S]*?<\\/c:${tag}>`, 'g')
    out = out.replace(re, (group) => {
      let next = group
      if (declared.size) {
        next = next.replace(/<c:axId val="(\d+)"\/>/g, (node, id) => (declared.has(id) ? node : ''))
      }
      if ((tag === 'lineChart' || tag === 'areaChart') && !/<c:grouping /.test(next)) {
        next = next.replace(`<c:${tag}>`, `<c:${tag}><c:grouping val="standard"/>`)
      }
      // invertIfNegative is a bar-series property. The generator writes it on
      // every series type, where the schema has no slot for it.
      if (tag !== 'barChart' && tag !== 'bar3DChart') {
        next = next.replace(/<c:invertIfNegative[^>]*\/>/g, '')
      }
      // In a line series <c:marker> must precede <c:dLbls>; the generator
      // emits them the other way round.
      if (tag === 'lineChart' || tag === 'line3DChart') {
        next = next.replace(/<c:ser>[\s\S]*?<\/c:ser>/g, (ser) => {
          const dl = /<c:dLbls>[\s\S]*?<\/c:dLbls>|<c:dLbls\/>/.exec(ser)
          const mk = /<c:marker>[\s\S]*?<\/c:marker>|<c:marker\/>/.exec(ser)
          if (!dl || !mk || dl.index > mk.index) return ser
          return ser.replace(dl[0], '').replace(mk[0], `${mk[0]}${dl[0]}`)
        })
      }
      if (next !== group) changed = true
      return next
    })
  }
  // <c:auto> belongs to a category axis; the generator also writes it into
  // value axes, where it lands after the elements that may follow it.
  // <c:auto>, <c:lblAlgn> and <c:noMultiLvlLbl> belong to a category axis;
  // the generator also writes them into value axes, which have no such slots.
  const beforeAx = out
  out = out.replace(/<c:valAx>[\s\S]*?<\/c:valAx>/g, (ax) =>
    ax.replace(/<c:(?:auto|lblAlgn|noMultiLvlLbl)[^>]*\/>/g, ''))
  if (out !== beforeAx) changed = true

  return { xml: out, changed }
}

/**
 * Paragraphs we leave unaligned inherit `defaultTextStyle` (algn="l") — which
 * PowerPoint and QuickLook honour, but at least one JS renderer does not: it
 * falls back to the master's titleStyle and centres the text, while the shapes
 * beside it stay left. Since the generator emits no algn unless asked, the
 * cheapest robust fix is to state the inherited value explicitly on every
 * paragraph that has none. (LTR assumption — an RTL deck would want "r".)
 */
const RTL_SCRIPT = /[\u0590-\u05FF\u0600-\u06FF\u0700-\u074F\u0750-\u077F\u08A0-\u08FF\uFB1D-\uFDFF\uFE70-\uFEFF]/

function stateParagraphAlignment(xml) {
  let changed = false
  // Walk whole paragraphs so the alignment we state matches the script the
  // paragraph is actually written in — forcing "l" onto Arabic or Hebrew would
  // trade one renderer's bug for a worse one of our own.
  const out = xml.replace(/<a:p>[\s\S]*?<\/a:p>|<a:p\/>/g, (para) => {
    if (/<a:pPr\b[^>]*\balgn=/.test(para)) return para
    const text = [...para.matchAll(/<a:t>([\s\S]*?)<\/a:t>/g)].map((m) => m[1]).join('')
    const algn = RTL_SCRIPT.test(text) ? 'r' : 'l'
    if (/<a:pPr\b/.test(para)) {
      changed = true
      return para.replace(/<a:pPr\b([^>]*?)(\/?)>/, `<a:pPr algn="${algn}"$1$2>`)
    }
    // A paragraph with no <a:pPr> at all needs one before its first child.
    if (/<a:p>/.test(para)) {
      changed = true
      return para.replace('<a:p>', `<a:p><a:pPr algn="${algn}"/>`)
    }
    return para
  })
  return { xml: out, changed }
}

/** Run the repair over every chart part in a written deck. */
async function repairDeckCharts(filePath) {
  let zip
  try {
    zip = new AdmZip(filePath)
  } catch {
    return 0
  }
  let repaired = 0
  let aligned = 0
  for (const entry of zip.getEntries()) {
    if (/^ppt\/charts\/chart\d+\.xml$/.test(entry.entryName)) {
      const { xml, changed } = repairChartPart(zip.readAsText(entry))
      if (changed) {
        zip.updateFile(entry, Buffer.from(xml, 'utf8'))
        repaired += 1
      }
    } else if (/^ppt\/slides\/slide\d+\.xml$/.test(entry.entryName)) {
      const { xml, changed } = stateParagraphAlignment(zip.readAsText(entry))
      if (changed) {
        zip.updateFile(entry, Buffer.from(xml, 'utf8'))
        aligned += 1
      }
    }
  }
  if (repaired || aligned) zip.writeZip(filePath)
  return { charts: repaired, slidesAligned: aligned }
}

async function presentationCreate(args) {
  const outputPath = resolvePath(args.output_path)
  if (path.extname(outputPath).toLowerCase() !== '.pptx') {
    return { success: false, error: 'output_path must end in .pptx' }
  }
  let deck
  try {
    deck = parseJsonParam(args.deck, 'deck')
  } catch (err) {
    return { success: false, error: err.message }
  }
  if (!deck || !Array.isArray(deck.slides) || !deck.slides.length) {
    return { success: false, error: 'deck must be an object with a non-empty slides array' }
  }

  let t
  try { t = resolveTheme(deck) } catch (err) { return { success: false, error: err.message } }

  const aspect = deck.aspect === '4x3' ? '4x3' : '16x9'
  const g = geometry(aspect)
  const fonts = {
    display: str(deck.font_display || deck.font || 'Calibri'),
    body: str(deck.font_body || deck.font || 'Calibri')
  }
  const ctx = { g, t, fonts, warnings: [], footer: deck.footer ? str(deck.footer) : '' }

  const pres = new PptxGenJS()
  // Never rely on the built-in 16x9 layout: it is 10in wide, and coordinates
  // past the edge are written rather than clamped, so shapes silently vanish.
  pres.defineLayout({ name: 'WOLFFISH', width: g.W, height: g.H })
  pres.layout = 'WOLFFISH'
  if (deck.title) pres.title = str(deck.title)
  if (deck.author) pres.author = str(deck.author)
  pres.company = str(deck.company || 'Wolffish')

  const fontNotes = []
  for (const face of new Set([fonts.display, fonts.body])) {
    if (!SAFE_FONTS.has(face)) fontNotes.push(face)
  }

  const used = []
  for (const [i, spec] of deck.slides.entries()) {
    const slideNo = i + 1
    const layoutName = str(spec.layout || 'bullets').toLowerCase()
    const slide = withDefaultAlignment(pres.addSlide())
    slide.background = { color: t.paper }
    try {
      if (layoutName === 'chart') drawChart(pres, slide, spec, ctx, slideNo)
      else if (layoutName === 'image') await drawImage(slide, spec, ctx, slideNo)
      else {
        const render = LAYOUTS[layoutName]
        if (!render) {
          throw new Error(`unknown layout "${spec.layout}" — use one of ${[...Object.keys(LAYOUTS), 'chart', 'image'].join(', ')}`)
        }
        render(slide, spec, ctx, slideNo)
      }
    } catch (err) {
      return { success: false, error: `slide ${slideNo}: ${err instanceof Error ? err.message : String(err)}` }
    }
    if (spec.notes) slide.addNotes(str(spec.notes))
    used.push(layoutName)
  }

  await fs.mkdir(path.dirname(outputPath), { recursive: true })
  try {
    await pres.writeFile({ fileName: outputPath })
  } catch (err) {
    return { success: false, error: `writing the deck failed: ${err instanceof Error ? err.message : String(err)}` }
  }
  const repairs = await repairDeckCharts(outputPath)

  const distinct = new Set(used)
  const result = {
    path: outputPath,
    slides: deck.slides.length,
    theme: deck.theme || DEFAULT_THEME,
    aspect,
    layouts_used: [...distinct],
    fit_warnings: ctx.warnings
  }
  const lines = [`Wrote ${deck.slides.length} slides to ${outputPath} (theme ${result.theme}, ${aspect}).`]
  if (distinct.size < 3 && deck.slides.length >= 5) {
    lines.push(`Only ${distinct.size} layout${distinct.size === 1 ? '' : 's'} across ${deck.slides.length} slides — vary them, a deck of identical slides reads as filler.`)
  }
  if (fontNotes.length) {
    lines.push(`Font${fontNotes.length > 1 ? 's' : ''} outside the metric-safe set: ${fontNotes.join(', ')}. Text-fit estimates for those are approximate.`)
  }
  if (repairs.charts) {
    lines.push(`Repaired the generator's chart XML on ${repairs.charts} chart part${repairs.charts === 1 ? '' : 's'} (undeclared axis ids, missing grouping) — PowerPoint refuses those.`)
  }
  if (ctx.warnings.length) {
    lines.push('', `Fit warnings (${ctx.warnings.length}) — estimated, so treat them as "look at this", not "this is broken":`)
    for (const w of ctx.warnings) lines.push(`  - ${w}`)
  }
  lines.push('', 'Not done yet: run presentation_validate on this file, and presentation_render + image_view to look at it.')
  return { success: true, output: `${lines.join('\n')}\n\n${JSON.stringify(result, null, 2)}` }
}

// ── OOXML helpers (read / edit path) ──────────────────────────────────────
// A .pptx is a zip of machine-generated XML. We read it with targeted
// patterns rather than a DOM: round-tripping OOXML through a generic parser
// rewrites namespace prefixes, which PowerPoint rejects. Everything below
// edits the XML as text and leaves every byte it did not mean to touch.

const XML_ENTITIES = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'" }

function unescapeXml(value) {
  return String(value).replace(/&(amp|lt|gt|quot|apos);/g, (m) => XML_ENTITIES[m])
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
}

function escapeXml(value) {
  return String(value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;')
}

function openDeck(filePath) {
  let zip
  try {
    zip = new AdmZip(filePath)
  } catch (err) {
    throw new Error(`could not open ${path.basename(filePath)} as a .pptx (${err instanceof Error ? err.message : String(err)})`)
  }
  const entry = (name) => {
    const e = zip.getEntry(name)
    return e ? zip.readAsText(e) : null
  }
  return { zip, entry }
}

/** Slide part names in presentation order, resolved through the rels table. */
function slideOrder(entry) {
  const pres = entry('ppt/presentation.xml')
  const rels = entry('ppt/_rels/presentation.xml.rels')
  if (!pres || !rels) throw new Error('not a presentation: ppt/presentation.xml is missing')
  const byId = new Map()
  for (const m of rels.matchAll(/<Relationship\b[^>]*\/>/g)) {
    const id = /Id="([^"]+)"/.exec(m[0])?.[1]
    const target = /Target="([^"]+)"/.exec(m[0])?.[1]
    if (id && target) byId.set(id, target.replace(/^\.\.\//, '').replace(/^\//, ''))
  }
  const order = []
  const list = /<p:sldIdLst>([\s\S]*?)<\/p:sldIdLst>/.exec(pres)?.[1] ?? ''
  for (const m of list.matchAll(/<p:sldId\b[^>]*r:id="([^"]+)"[^>]*\/>/g)) {
    const target = byId.get(m[1])
    if (target) order.push(target.startsWith('slides/') ? `ppt/${target}` : target)
  }
  return order
}

/** Text of one slide, grouped by shape, plus its speaker notes. */
function slideContent(entry, slidePart) {
  const xml = entry(slidePart)
  if (!xml) return { shapes: [], notes: '' }
  const shapes = []
  for (const sp of xml.matchAll(/<p:sp>[\s\S]*?<\/p:sp>/g)) {
    const block = sp[0]
    const name = /<p:cNvPr\b[^>]*name="([^"]*)"/.exec(block)?.[1] ?? ''
    // A deck this engine built tags its own chrome; a foreign deck marks its
    // title with a placeholder type. Honour whichever is present.
    if (name === 'wf-footer' || name === 'wf-pagenum') continue
    const isTitle = name === 'wf-title' || /<p:ph\b[^>]*type="(ctrTitle|title)"/.test(block)
    const paragraphs = []
    for (const p of block.matchAll(/<a:p>[\s\S]*?<\/a:p>/g)) {
      const runs = [...p[0].matchAll(/<a:t>([\s\S]*?)<\/a:t>/g)].map((r) => unescapeXml(r[1]))
      const line = runs.join('')
      if (line.trim()) paragraphs.push(line)
    }
    if (paragraphs.length) shapes.push({ name, is_title: isTitle, text: paragraphs })
  }
  const relsPart = slidePart.replace(/^(.*)\/([^/]+)$/, '$1/_rels/$2.rels')
  const rels = entry(relsPart) ?? ''
  const notesTarget = /Target="([^"]*notesSlide[^"]*)"/.exec(rels)?.[1]
  let notes = ''
  if (notesTarget) {
    const notesPart = `ppt/${notesTarget.replace(/^\.\.\//, '')}`
    const nXml = entry(notesPart) ?? ''
    const body = /<p:txBody>[\s\S]*?<\/p:txBody>/g
    const chunks = []
    for (const b of nXml.matchAll(body)) {
      for (const p of b[0].matchAll(/<a:p>[\s\S]*?<\/a:p>/g)) {
        const line = [...p[0].matchAll(/<a:t>([\s\S]*?)<\/a:t>/g)].map((r) => unescapeXml(r[1])).join('')
        if (line.trim()) chunks.push(line)
      }
    }
    // The notes part repeats the slide-number placeholder; drop bare numbers.
    notes = chunks.filter((c) => !/^\d+$/.test(c.trim())).join('\n')
  }
  return { shapes, notes }
}

async function presentationRead(args) {
  const filePath = resolvePath(args.path)
  try {
    await fs.access(filePath)
    const { entry } = openDeck(filePath)
    const order = slideOrder(entry)
    const from = Math.max(1, Number(args.from_slide) || 1)
    const to = Math.min(order.length, Number(args.to_slide) || order.length)
    const slides = []
    for (let i = from - 1; i < to; i += 1) {
      const { shapes, notes } = slideContent(entry, order[i])
      const titleShape = shapes.find((s) => s.is_title) || shapes[0]
      slides.push({
        slide: i + 1,
        part: order[i],
        title: titleShape ? titleShape.text.join(' ') : '',
        shapes: shapes.map((s) => ({ name: s.name, text: s.text })),
        notes
      })
    }
    if (args.format === 'text') {
      const out = slides.map((s) => {
        const body = s.shapes.map((sh) => sh.text.map((line) => `  ${line}`).join('\n')).join('\n')
        return `--- Slide ${s.slide}${s.title ? `: ${s.title}` : ''} ---\n${body}${s.notes ? `\n  [notes] ${s.notes}` : ''}`
      }).join('\n\n')
      return { success: true, output: `${order.length} slides in ${path.basename(filePath)}\n\n${out}` }
    }
    return { success: true, output: JSON.stringify({ path: filePath, slide_count: order.length, slides }, null, 2) }
  } catch (err) {
    return { success: false, error: `presentation_read: ${err instanceof Error ? err.message : String(err)}` }
  }
}

// ── presentation_modify ───────────────────────────────────────────────────

function nextFreeSlideNumber(zip) {
  let max = 0
  for (const e of zip.getEntries()) {
    const m = /^ppt\/slides\/slide(\d+)\.xml$/.exec(e.entryName)
    if (m) max = Math.max(max, Number(m[1]))
  }
  return max + 1
}

function nextFreeRelId(relsXml) {
  let max = 0
  for (const m of relsXml.matchAll(/Id="rId(\d+)"/g)) max = Math.max(max, Number(m[1]))
  return `rId${max + 1}`
}

/**
 * Duplicate a slide with every piece of package bookkeeping a new slide
 * needs: the part itself, its rels, a Content_Types override, a presentation
 * relationship, and an entry in <p:sldIdLst>. Copying the XML alone yields a
 * file PowerPoint opens with the slide missing.
 */
function duplicateSlide(zip, order, index, afterIndex) {
  const source = order[index]
  const xml = zip.readAsText(zip.getEntry(source))
  const n = nextFreeSlideNumber(zip)
  const newPart = `ppt/slides/slide${n}.xml`
  zip.addFile(newPart, Buffer.from(xml, 'utf8'))

  const srcRels = `ppt/slides/_rels/${path.basename(source)}.rels`
  const srcRelsEntry = zip.getEntry(srcRels)
  if (srcRelsEntry) {
    zip.addFile(`ppt/slides/_rels/slide${n}.xml.rels`, Buffer.from(zip.readAsText(srcRelsEntry), 'utf8'))
  }

  const ctEntry = zip.getEntry('[Content_Types].xml')
  let ct = zip.readAsText(ctEntry)
  if (!ct.includes(`PartName="/${newPart}"`)) {
    ct = ct.replace('</Types>', `<Override PartName="/${newPart}" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/></Types>`)
    zip.updateFile(ctEntry, Buffer.from(ct, 'utf8'))
  }

  const relsEntry = zip.getEntry('ppt/_rels/presentation.xml.rels')
  let rels = zip.readAsText(relsEntry)
  const rid = nextFreeRelId(rels)
  rels = rels.replace('</Relationships>', `<Relationship Id="${rid}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide${n}.xml"/></Relationships>`)
  zip.updateFile(relsEntry, Buffer.from(rels, 'utf8'))

  const presEntry = zip.getEntry('ppt/presentation.xml')
  let pres = zip.readAsText(presEntry)
  const ids = [...pres.matchAll(/<p:sldId\b[^>]*id="(\d+)"/g)].map((m) => Number(m[1]))
  const newId = Math.max(256, ...ids) + 1
  const node = `<p:sldId id="${newId}" r:id="${rid}"/>`
  const list = /<p:sldIdLst>([\s\S]*?)<\/p:sldIdLst>/.exec(pres)
  const nodes = [...list[1].matchAll(/<p:sldId\b[^>]*\/>/g)].map((m) => m[0])
  const at = afterIndex == null ? nodes.length : Math.min(nodes.length, Math.max(0, afterIndex + 1))
  nodes.splice(at, 0, node)
  pres = pres.replace(list[0], `<p:sldIdLst>${nodes.join('')}</p:sldIdLst>`)
  zip.updateFile(presEntry, Buffer.from(pres, 'utf8'))
  return { part: newPart, position: at + 1 }
}

function rewriteSldIdLst(zip, mutate) {
  const presEntry = zip.getEntry('ppt/presentation.xml')
  let pres = zip.readAsText(presEntry)
  const list = /<p:sldIdLst>([\s\S]*?)<\/p:sldIdLst>/.exec(pres)
  const nodes = [...list[1].matchAll(/<p:sldId\b[^>]*\/>/g)].map((m) => m[0])
  const next = mutate(nodes)
  pres = pres.replace(list[0], `<p:sldIdLst>${next.join('')}</p:sldIdLst>`)
  zip.updateFile(presEntry, Buffer.from(pres, 'utf8'))
}

/** Replace visible text without disturbing run properties. */
function replaceTextInPart(zip, part, find, replace, caseSensitive) {
  const e = zip.getEntry(part)
  if (!e) return 0
  const xml = zip.readAsText(e)
  let hits = 0
  const needle = caseSensitive ? find : find.toLowerCase()
  const next = xml.replace(/(<a:t>)([\s\S]*?)(<\/a:t>)/g, (whole, open, inner, close) => {
    const plain = unescapeXml(inner)
    const hay = caseSensitive ? plain : plain.toLowerCase()
    if (!hay.includes(needle)) return whole
    hits += 1
    let out = ''
    let i = 0
    while (i < plain.length) {
      const at = (caseSensitive ? plain : plain.toLowerCase()).indexOf(needle, i)
      if (at === -1) { out += plain.slice(i); break }
      out += plain.slice(i, at) + replace
      i = at + find.length
    }
    return `${open}${escapeXml(out)}${close}`
  })
  if (hits) zip.updateFile(e, Buffer.from(next, 'utf8'))
  return hits
}

async function presentationModify(args) {
  const filePath = resolvePath(args.path)
  const outputPath = resolvePath(args.output_path || args.path)
  let operations
  try {
    operations = parseJsonParam(args.operations, 'operations')
  } catch (err) {
    return { success: false, error: err.message }
  }
  if (!Array.isArray(operations) || !operations.length) {
    return { success: false, error: 'operations must be a non-empty JSON array' }
  }
  try {
    await fs.access(filePath)
    const { zip, entry } = openDeck(filePath)
    let order = slideOrder(entry)
    const log = []

    // Structural first, always. add_slide copies a part verbatim, so
    // duplicating after a content edit clones the edited text; and a delete
    // renumbers everything a later content op would have addressed.
    const structural = operations.filter((op) => ['duplicate_slide', 'delete_slide', 'reorder'].includes(op.type))
    const content = operations.filter((op) => !['duplicate_slide', 'delete_slide', 'reorder'].includes(op.type))
    if (structural.length && content.length && operations.indexOf(content[0]) < operations.indexOf(structural[0])) {
      log.push('note: structural operations were applied before content edits; slide numbers below refer to the final deck')
    }

    for (const op of structural) {
      if (op.type === 'duplicate_slide') {
        const idx = Number(op.slide) - 1
        if (!(idx >= 0 && idx < order.length)) throw new Error(`duplicate_slide: slide ${op.slide} is out of range (1-${order.length})`)
        const after = op.after == null ? null : Number(op.after) - 1
        const made = duplicateSlide(zip, order, idx, after)
        log.push(`duplicated slide ${op.slide} as ${made.part} at position ${made.position}`)
      } else if (op.type === 'delete_slide') {
        const idx = Number(op.slide) - 1
        if (!(idx >= 0 && idx < order.length)) throw new Error(`delete_slide: slide ${op.slide} is out of range (1-${order.length})`)
        rewriteSldIdLst(zip, (nodes) => nodes.filter((_, i) => i !== idx))
        log.push(`removed slide ${op.slide} from the running order (its part stays in the package, unreferenced)`)
      } else if (op.type === 'reorder') {
        const target = Array.isArray(op.order) ? op.order.map((n) => Number(n) - 1) : null
        if (!target || target.length !== order.length || target.some((n) => !(n >= 0 && n < order.length))) {
          throw new Error(`reorder: order must list all ${order.length} slide numbers exactly once`)
        }
        rewriteSldIdLst(zip, (nodes) => target.map((i) => nodes[i]))
        log.push(`reordered to ${op.order.join(', ')}`)
      }
      order = slideOrder((name) => {
        const e = zip.getEntry(name)
        return e ? zip.readAsText(e) : null
      })
    }

    for (const op of content) {
      if (op.type === 'replace_text') {
        const find = str(op.find)
        if (!find) throw new Error('replace_text: find is required')
        const parts = op.slide ? [order[Number(op.slide) - 1]] : order
        if (op.slide && !parts[0]) throw new Error(`replace_text: slide ${op.slide} is out of range (1-${order.length})`)
        let hits = 0
        for (const part of parts) hits += replaceTextInPart(zip, part, find, str(op.replace), Boolean(op.case_sensitive))
        log.push(`replaced "${find}" in ${hits} text run${hits === 1 ? '' : 's'}${op.slide ? ` on slide ${op.slide}` : ''}`)
        if (!hits) log.push(`  warning: "${find}" matched nothing — check the exact spelling with presentation_read`)
      } else if (op.type === 'set_notes') {
        const idx = Number(op.slide) - 1
        if (!(idx >= 0 && idx < order.length)) throw new Error(`set_notes: slide ${op.slide} is out of range (1-${order.length})`)
        const applied = setNotes(zip, order[idx], idx, str(op.notes))
        log.push(applied ? `set speaker notes on slide ${op.slide}` : `slide ${op.slide} has no notes part yet — notes were not written (create the deck with notes, or duplicate a slide that has them)`)
      } else {
        throw new Error(`unknown operation type "${op.type}" — use duplicate_slide, delete_slide, reorder, replace_text or set_notes`)
      }
    }

    await fs.mkdir(path.dirname(outputPath), { recursive: true })
    zip.writeZip(outputPath)
    const finalCount = slideOrder((name) => {
      const e = zip.getEntry(name)
      return e ? zip.readAsText(e) : null
    }).length
    return {
      success: true,
      output: `${outputPath}\n${log.map((l) => `- ${l}`).join('\n')}\n\n${finalCount} slides in the running order. Run presentation_validate on the result before sending it.`
    }
  } catch (err) {
    return { success: false, error: `presentation_modify: ${err instanceof Error ? err.message : String(err)}` }
  }
}

/** Rewrite the text of an existing notes part. Returns false when there is none. */
function setNotes(zip, slidePart, _index, text) {
  const relsPart = slidePart.replace(/^(.*)\/([^/]+)$/, '$1/_rels/$2.rels')
  const relsEntry = zip.getEntry(relsPart)
  if (!relsEntry) return false
  const target = /Target="([^"]*notesSlide[^"]*)"/.exec(zip.readAsText(relsEntry))?.[1]
  if (!target) return false
  const notesPart = `ppt/${target.replace(/^\.\.\//, '')}`
  const notesEntry = zip.getEntry(notesPart)
  if (!notesEntry) return false
  let xml = zip.readAsText(notesEntry)
  // The body placeholder holds the notes; leave the slide-image placeholder alone.
  const body = /(<p:ph\b[^>]*type="body"[^>]*\/>[\s\S]*?<p:txBody>)([\s\S]*?)(<\/p:txBody>)/.exec(xml)
  if (!body) return false
  const paragraphs = text.split('\n').map((line) => `<a:p><a:r><a:rPr lang="en-US" dirty="0"/><a:t>${escapeXml(line)}</a:t></a:r></a:p>`).join('')
  const keepProps = /<a:bodyPr[^>]*\/>|<a:bodyPr[\s\S]*?<\/a:bodyPr>/.exec(body[2])?.[0] ?? '<a:bodyPr/>'
  xml = xml.replace(body[0], `${body[1]}${keepProps}<a:lstStyle/>${paragraphs}${body[3]}`)
  zip.updateFile(notesEntry, Buffer.from(xml, 'utf8'))
  return true
}

// ── presentation_validate ─────────────────────────────────────────────────

const PLACEHOLDER = /\b(lorem|ipsum|TODO|FIXME|TBD|\[insert[^\]]*\]|xxxx+|your (?:title|text|company) here)\b/i

async function presentationValidate(args) {
  const filePath = resolvePath(args.path)
  try {
    await fs.access(filePath)
    const { zip, entry } = openDeck(filePath)
    const errors = []
    const warnings = []
    const names = new Set(zip.getEntries().map((e) => e.entryName))

    for (const required of ['[Content_Types].xml', 'ppt/presentation.xml', 'ppt/_rels/presentation.xml.rels']) {
      if (!names.has(required)) errors.push(`missing required part ${required}`)
    }
    if (errors.length) {
      return { success: true, output: `INVALID — ${path.basename(filePath)}\n${errors.map((e) => `  ERROR ${e}`).join('\n')}` }
    }

    const order = slideOrder(entry)
    if (!order.length) errors.push('<p:sldIdLst> lists no slides — the deck will open empty')
    for (const part of order) {
      if (!names.has(part)) errors.push(`${part} is referenced by the running order but missing from the package`)
    }

    // Every relationship target must resolve, or PowerPoint reports the file
    // as corrupt rather than dropping the one broken link.
    for (const e of zip.getEntries()) {
      if (!/_rels\/.+\.rels$/.test(e.entryName)) continue
      const base = e.entryName.replace(/_rels\/[^/]+$/, '')
      for (const m of zip.readAsText(e).matchAll(/<Relationship\b[^>]*\/>/g)) {
        if (/TargetMode="External"/.test(m[0])) continue
        const target = /Target="([^"]+)"/.exec(m[0])?.[1]
        if (!target) continue
        // A leading "/" means "from the package root" in OPC, not "relative
        // to this rels folder" — joining it with the base invents a path that
        // is never there, which reads as a corrupt deck when it is fine.
        const resolved = target.startsWith('/')
          ? target.slice(1)
          : path.posix.normalize(path.posix.join(base, target)).replace(/^\//, '')
        if (!names.has(resolved)) {
          errors.push(`${e.entryName}: target "${target}" resolves to ${resolved}, which is not in the package`)
        }
      }
    }

    // Content-type overrides must cover every slide part.
    const ct = entry('[Content_Types].xml') ?? ''
    for (const part of order) {
      if (!ct.includes(`PartName="/${part}"`)) errors.push(`${part} has no <Override> in [Content_Types].xml`)
    }

    // Charts: the two shapes PowerPoint refuses and every other tool accepts.
    for (const e of zip.getEntries()) {
      if (!/^ppt\/charts\/chart\d+\.xml$/.test(e.entryName)) continue
      const xml = zip.readAsText(e)
      const declared = new Set()
      for (const ax of xml.matchAll(/<c:(?:catAx|valAx|serAx|dateAx)>([\s\S]*?)<\/c:(?:catAx|valAx|serAx|dateAx)>/g)) {
        const id = /<c:axId val="(\d+)"\/>/.exec(ax[1])
        if (id) declared.add(id[1])
      }
      if (declared.size) {
        const dangling = new Set()
        for (const group of xml.matchAll(/<c:\w*[Cc]hart>[\s\S]*?<\/c:\w*[Cc]hart>/g)) {
          for (const ref of group[0].matchAll(/<c:axId val="(\d+)"\/>/g)) {
            if (!declared.has(ref[1])) dangling.add(ref[1])
          }
        }
        if (dangling.size) {
          errors.push(`${e.entryName}: axis id${dangling.size === 1 ? '' : 's'} ${[...dangling].join(', ')} referenced by a chart group but declared by no axis — PowerPoint discards this chart and reports the file as corrupt`)
        }
      }
      for (const group of xml.matchAll(/<c:(lineChart|areaChart)>([\s\S]*?)<\/c:\1>/g)) {
        if (!/<c:grouping /.test(group[2])) {
          errors.push(`${e.entryName}: <c:${group[1]}> has no <c:grouping>, which the chart schema requires as its first child`)
        }
        if (/<c:invertIfNegative/.test(group[2])) {
          errors.push(`${e.entryName}: <c:${group[1]}> carries <c:invertIfNegative>, which only a bar series may have`)
        }
      }
      for (const ax of xml.matchAll(/<c:valAx>([\s\S]*?)<\/c:valAx>/g)) {
        const stray = ['auto', 'lblAlgn', 'noMultiLvlLbl'].filter((tag) => new RegExp(`<c:${tag}[ /]`).test(ax[1]))
        if (stray.length) {
          errors.push(`${e.entryName}: a value axis carries ${stray.map((t) => `<c:${t}>`).join(', ')}, which belong${stray.length === 1 ? 's' : ''} to a category axis`)
        }
      }
      if (/<c:grouping val="stacked"\/>/.test(xml) && /<c:dLblPos val="outEnd"\/>/.test(xml)) {
        errors.push(`${e.entryName}: stacked series with dataLabelPosition "outEnd" — PowerPoint refuses this; use ctr, inEnd or inBase`)
      }
    }

    // Slide XML must at least be well-formed enough to find its body.
    let placeholderHits = 0
    let emptySlides = 0
    for (const [i, part] of order.entries()) {
      const xml = entry(part) ?? ''
      const opens = (xml.match(/<p:sp>/g) || []).length
      const closes = (xml.match(/<\/p:sp>/g) || []).length
      if (opens !== closes) errors.push(`${part}: ${opens} <p:sp> opened, ${closes} closed — the XML is malformed`)
      const text = [...xml.matchAll(/<a:t>([\s\S]*?)<\/a:t>/g)].map((m) => unescapeXml(m[1])).join(' ')
      if (!text.trim()) { emptySlides += 1; warnings.push(`slide ${i + 1} (${path.basename(part)}) carries no text`) }
      if (PLACEHOLDER.test(text)) {
        placeholderHits += 1
        warnings.push(`slide ${i + 1}: leftover placeholder text — "${(PLACEHOLDER.exec(text) || [])[0]}"`)
      }
    }

    // Unreferenced slide parts are the residue of a delete; harmless to
    // PowerPoint, but they inflate the file and confuse the next edit.
    const orphans = [...names].filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n) && !order.includes(n))
    if (orphans.length) warnings.push(`${orphans.length} slide part(s) in the package but not in the running order: ${orphans.join(', ')}`)

    const ok = errors.length === 0
    const head = ok
      ? `VALID — ${path.basename(filePath)}: ${order.length} slides, ${warnings.length} warning${warnings.length === 1 ? '' : 's'}`
      : `INVALID — ${path.basename(filePath)}: ${errors.length} error${errors.length === 1 ? '' : 's'}, ${warnings.length} warning${warnings.length === 1 ? '' : 's'}`
    const lines = [head]
    for (const e of errors) lines.push(`  ERROR   ${e}`)
    for (const w of warnings) lines.push(`  WARNING ${w}`)
    if (ok && !warnings.length) lines.push('  Structure, relationships, content types and charts all check out.')
    lines.push('', ok
      ? 'Structure is sound. That is not the same as looking right — render it and look at the slides before you send it.'
      : 'Fix these in the generator or the modify call, not by hand-editing the packed XML, then validate again.')
    return { success: true, output: lines.join('\n'), meta: { valid: ok, errors: errors.length, warnings: warnings.length, slides: order.length, placeholders: placeholderHits, empty_slides: emptySlides } }
  } catch (err) {
    return { success: false, error: `presentation_validate: ${err instanceof Error ? err.message : String(err)}` }
  }
}

// ── presentation_render ───────────────────────────────────────────────────
// Converts the deck to PDF so the existing pdf.js rasteriser (pdf_render_pages)
// can turn it into images you can actually look at. LibreOffice is the only
// thing on any platform that renders .pptx headlessly; when it is absent we
// say so plainly rather than pretending the verify step ran.

const SOFFICE_CANDIDATES = {
  darwin: ['/Applications/LibreOffice.app/Contents/MacOS/soffice', '/opt/homebrew/bin/soffice', '/usr/local/bin/soffice'],
  linux: ['/usr/bin/soffice', '/usr/local/bin/soffice', '/snap/bin/libreoffice', '/usr/bin/libreoffice'],
  win32: ['C:\\Program Files\\LibreOffice\\program\\soffice.exe', 'C:\\Program Files (x86)\\LibreOffice\\program\\soffice.exe']
}

async function findSoffice() {
  for (const candidate of SOFFICE_CANDIDATES[process.platform] ?? []) {
    try { await fs.access(candidate); return candidate } catch { /* next */ }
  }
  return null
}

function run(cmd, cmdArgs, timeoutMs) {
  return new Promise((resolve) => {
    const child = spawn(cmd, cmdArgs, { stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    let err = ''
    const timer = setTimeout(() => { child.kill('SIGKILL'); resolve({ code: -1, out, err: `${err}\ntimed out after ${timeoutMs}ms` }) }, timeoutMs)
    child.stdout.on('data', (d) => { out += d.toString() })
    child.stderr.on('data', (d) => { err += d.toString() })
    child.on('error', (e) => { clearTimeout(timer); resolve({ code: -1, out, err: e.message }) })
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, out, err }) })
  })
}

async function presentationRender(args) {
  const filePath = resolvePath(args.path)
  try {
    await fs.access(filePath)
  } catch {
    return { success: false, error: `presentation_render: ${filePath} does not exist` }
  }
  const soffice = await findSoffice()
  if (!soffice) {
    return {
      success: false,
      error: 'presentation_render: LibreOffice is not installed, so the deck cannot be rendered to images here.\n' +
        'Two honest ways forward:\n' +
        '  1. Ask the user to install it (`brew install --cask libreoffice` on macOS) — then this tool works.\n' +
        '  2. Ship without a visual pass: run presentation_validate, read the deck back with presentation_read, and SAY in your reply that you verified structure and content but could not look at the rendered slides.\n' +
        'Do not claim a deck is visually checked when it was not.'
    }
  }
  const outDir = resolvePath(args.output_dir || path.dirname(filePath))
  await fs.mkdir(outDir, { recursive: true })
  // A private profile: a bare `soffice` blocks forever when the user already
  // has LibreOffice open, which reads as a hang rather than an error.
  const profile = path.join(os.tmpdir(), `wolffish-soffice-${process.pid}`)
  const { code, err } = await run(soffice, [
    `-env:UserInstallation=file://${profile}`,
    '--headless', '--norestore', '--convert-to', 'pdf', '--outdir', outDir, filePath
  ], Number(args.timeout_ms) || 120000)
  const pdfPath = path.join(outDir, `${path.basename(filePath, path.extname(filePath))}.pdf`)
  try {
    await fs.access(pdfPath)
  } catch {
    return { success: false, error: `presentation_render: LibreOffice exited ${code} without producing a PDF.\n${err.trim().slice(0, 600)}` }
  }
  return {
    success: true,
    output: `${pdfPath}\n\nNow LOOK at it: pdf_render_pages on this PDF, then image_view on each image. ` +
      'Text overflow and overlap are the two defects that are always user-visible and never visible from the code.'
  }
}

// ── deck_design ───────────────────────────────────────────────────────────

const MANUAL_URL = new URL('../manual.md', import.meta.url)

async function deckDesign() {
  try {
    const manual = await readManual()
    return { success: true, output: manual }
  } catch (err) {
    return { success: false, error: `deck_design: could not read manual.md (${err instanceof Error ? err.message : String(err)})` }
  }
}

async function readManual() {
  return (await fs.readFile(MANUAL_URL, 'utf8')).trimEnd()
}

// ── Tool surface ──────────────────────────────────────────────────────────

const toolDefinitions = [
  { name: 'deck_design', description: 'Load the deck design manual.', parameters: { type: 'object', properties: { deck: { type: 'string' } } } },
  { name: 'presentation_read', description: 'Read a .pptx/.potx: slides, shape text and speaker notes.', parameters: { type: 'object', properties: { path: { type: 'string' }, format: { type: 'string', enum: ['json', 'text'] }, from_slide: { type: 'number' }, to_slide: { type: 'number' } }, required: ['path'] } },
  { name: 'presentation_create', description: 'Create a designed .pptx from a deck spec.', parameters: { type: 'object', properties: { output_path: { type: 'string' }, deck: { type: 'string' } }, required: ['output_path', 'deck'] } },
  { name: 'presentation_modify', description: 'Edit an existing .pptx — duplicate, delete, reorder slides, replace text, set notes.', parameters: { type: 'object', properties: { path: { type: 'string' }, output_path: { type: 'string' }, operations: { type: 'string' } }, required: ['path', 'operations'] } },
  { name: 'presentation_validate', description: 'Check a .pptx for the structural faults PowerPoint refuses to open.', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } },
  { name: 'presentation_render', description: 'Render a .pptx to PDF for visual inspection.', parameters: { type: 'object', properties: { path: { type: 'string' }, output_dir: { type: 'string' }, timeout_ms: { type: 'number' } }, required: ['path'] } }
]

function describeAction(toolName, args) {
  const target = String(args?.output_path || args?.path || '')
  const name = path.basename(target)
  switch (toolName) {
    case 'presentation_read': return { title: 'Read Deck', description: `Read ${name}`, risk: 'low' }
    case 'presentation_create': return { title: 'Create Deck', description: `Create ${name}`, command: target, risk: 'medium' }
    case 'presentation_modify': return { title: 'Modify Deck', description: `Edit ${name}`, command: target, risk: 'medium' }
    case 'presentation_validate': return { title: 'Validate Deck', description: `Check ${name}`, risk: 'low' }
    case 'presentation_render': return { title: 'Render Deck', description: `Render ${name} to PDF`, command: target, risk: 'low' }
    default: return null
  }
}

const plugin = {
  name: 'presentation',
  tools: toolDefinitions,
  describeAction,
  async execute(toolName, args) {
    switch (toolName) {
      case 'deck_design': return deckDesign()
      case 'presentation_read': return presentationRead(args)
      case 'presentation_create': return presentationCreate(args)
      case 'presentation_modify': return presentationModify(args)
      case 'presentation_validate': return presentationValidate(args)
      case 'presentation_render': return presentationRender(args)
      default: return { success: false, error: `presentation: unknown tool ${toolName}` }
    }
  }
}

export default plugin
