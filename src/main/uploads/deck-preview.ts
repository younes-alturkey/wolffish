import { createHash } from 'crypto'
import { promises as fs } from 'fs'
import path from 'path'
import { resolveUploadPath } from '@main/uploads/uploads'
import { workspaceRoot } from '@main/workspace/root'

export type DeckPreview = {
  /** Workspace-relative path per rendered slide, in presentation order. */
  slides: string[]
  /** Slides the deck actually holds — larger than `slides.length` when a
   *  very large deck hit a budget below. */
  totalSlides: number
  /** Slide canvas in CSS px at 96 DPI; the card takes its aspect from this. */
  width: number
  height: number
}

type PreviewManifest = DeckPreview & {
  source: string
  mtimeMs: number
  sizeBytes: number
  renderer: number
}

/**
 * Bump whenever anything about how a slide is painted changes — alignment
 * handling, font repair, the renderer itself. Without it a deck rendered by
 * the old code keeps its images forever: the cache key is the deck's mtime
 * and size, and fixing our renderer does not touch the user's file.
 */
const RENDERER_VERSION = 2

/**
 * Rendered slides live in ONE hidden directory per deck, inside the workspace
 * so `rm -rf ~/.wolffish` still uninstalls everything. The leading dot is
 * load-bearing: `cortexIngest` skips any path whose segments start with one,
 * so derived images never enter the corpus, and the model never sees them as
 * files it produced.
 */
const PREVIEW_DIR = path.join('.previews', 'decks')

/** Past this the deck is a slideshow, not a chat attachment; the card says so. */
const MAX_SLIDES = 300

/** Images ride inside each SVG as base64, so a photo deck is the size risk,
 *  not the slide count. Stop writing once a single deck's renders pass this. */
const MAX_TOTAL_BYTES = 128 * 1024 * 1024

function previewKey(relativePath: string): string {
  return createHash('sha1').update(relativePath).digest('hex').slice(0, 16)
}

/** `viewBox="0 0 1279.97 720.00"` — the only place the renderer states the
 *  slide canvas, and 4:3 decks are common enough that assuming 16:9 is wrong. */
function slideCanvas(svg: string): { width: number; height: number } {
  const box = /viewBox="0 0 ([\d.]+) ([\d.]+)"/.exec(svg)
  const width = box ? Number(box[1]) : 0
  const height = box ? Number(box[2]) : 0
  return Number.isFinite(width) && width > 0 && Number.isFinite(height) && height > 0
    ? { width, height }
    : { width: 1280, height: 720 }
}

async function readManifest(dir: string): Promise<PreviewManifest | null> {
  try {
    const raw = await fs.readFile(path.join(dir, 'manifest.json'), 'utf-8')
    const parsed = JSON.parse(raw) as PreviewManifest
    return Array.isArray(parsed.slides) ? parsed : null
  } catch {
    return null
  }
}

/**
 * Render every slide of a .pptx/.potx to an SVG file under the workspace and
 * return the manifest the chat card reads.
 *
 * Cached by the source file's mtime + size: an unchanged deck re-uses its
 * directory, an edited one wipes and re-renders it, so a deck never
 * accumulates more than one directory no matter how often it is rewritten.
 *
 * Returns null when the file can't be read or the deck can't be parsed — a
 * legacy binary .ppt, an encrypted package, a truncated download. The caller
 * renders the plain file card for that, which is what it did before.
 */
export async function renderDeckPreview(relativePath: string): Promise<DeckPreview | null> {
  const abs = resolveUploadPath(relativePath)
  if (!abs) return null

  let stat: Awaited<ReturnType<typeof fs.stat>>
  try {
    stat = await fs.stat(abs)
    if (!stat.isFile()) return null
  } catch {
    return null
  }

  const dir = path.join(workspaceRoot(), PREVIEW_DIR, previewKey(relativePath))
  const cached = await readManifest(dir)
  if (
    cached &&
    cached.renderer === RENDERER_VERSION &&
    cached.mtimeMs === stat.mtimeMs &&
    cached.sizeBytes === stat.size
  ) {
    return {
      slides: cached.slides,
      totalSlides: cached.totalSlides,
      width: cached.width,
      height: cached.height
    }
  }

  // The OOXML parser and the slide painter are only pulled in when a deck
  // actually shows up, so a session that never sees one never loads them.
  const pptx = await import('@office-kit/pptx')
  const { renderSlideToSvg } = await import('@office-kit/pptx-preview')
  const { getSlides, loadPresentation } = pptx

  let slides: ReturnType<typeof getSlides>
  let presentation: Awaited<ReturnType<typeof loadPresentation>>
  try {
    presentation = await loadPresentation(await fs.readFile(abs))
    slides = getSlides(presentation)
  } catch {
    return null
  }
  if (!slides.length) return null

  for (const slide of slides) anchorTextLeft(pptx, slide)

  // A re-render replaces the directory wholesale: leaving the old slides in
  // place would strand slide 9 of a deck that now has 6.
  await fs.rm(dir, { recursive: true, force: true })
  await fs.mkdir(dir, { recursive: true })

  const written: string[] = []
  let canvas = { width: 1280, height: 720 }
  let canvasMeasured = false
  let totalBytes = 0

  for (let i = 0; i < Math.min(slides.length, MAX_SLIDES); i++) {
    let svg: string
    try {
      svg = repairFontFallbacks(renderSlideToSvg(presentation, slides[i]))
    } catch {
      // One unpaintable slide shouldn't cost the reader the other twenty.
      continue
    }
    // The first slide that actually painted, not slide 0: an unpaintable first
    // slide is skipped above, and keying on its index would leave a 4:3 deck
    // stuck on the 16:9 default for every slide after it.
    if (!canvasMeasured) {
      canvas = slideCanvas(svg)
      canvasMeasured = true
    }
    totalBytes += Buffer.byteLength(svg)
    if (totalBytes > MAX_TOTAL_BYTES) break

    const name = `slide-${String(i + 1).padStart(3, '0')}.svg`
    await fs.writeFile(path.join(dir, name), svg, 'utf-8')
    written.push(
      path.posix.join(PREVIEW_DIR.split(path.sep).join('/'), previewKey(relativePath), name)
    )

    // Rendering is synchronous CPU work on the main process; yielding between
    // slides keeps IPC and the window responsive through a long deck.
    await new Promise((resolve) => setImmediate(resolve))
  }

  if (!written.length) {
    await fs.rm(dir, { recursive: true, force: true })
    return null
  }

  const manifest: PreviewManifest = {
    source: relativePath,
    mtimeMs: stat.mtimeMs,
    sizeBytes: stat.size,
    renderer: RENDERER_VERSION,
    slides: written,
    totalSlides: slides.length,
    width: canvas.width,
    height: canvas.height
  }
  await fs.writeFile(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf-8')

  return {
    slides: manifest.slides,
    totalSlides: manifest.totalSlides,
    width: manifest.width,
    height: manifest.height
  }
}

/** Serif faces common in decks. A name containing "serif" is caught too, so
 *  this only has to carry the ones that don't say so. */
const SERIF_FACES = new Set(
  [
    'cambria',
    'georgia',
    'times',
    'times new roman',
    'garamond',
    'book antiqua',
    'palatino',
    'palatino linotype',
    'baskerville',
    'libre baskerville',
    'playfair display',
    'merriweather',
    'lora',
    'crimson text',
    'crimson pro',
    'spectral',
    'bitter',
    'constantia',
    'cardo',
    'caladea'
  ].map((f) => f)
)

const MONO_FACES = new Set([
  'consolas',
  'courier',
  'courier new',
  'menlo',
  'monaco',
  'cascadia code',
  'cascadia mono',
  'sf mono',
  'liberation mono',
  'dejavu sans mono'
])

/**
 * Repair the generic at the end of every font stack the renderer emits.
 *
 * It writes `<requested>, <the deck's own body font>, 'Helvetica Neue', Arial,
 * sans-serif` for EVERY run — so a serif heading whose face is missing lands
 * on a sans-serif, and the deck loses the one thing that made it look like
 * itself. The decks we generate ask for Cambria headings over Calibri body,
 * and neither font exists on a machine without Office.
 *
 * Keeps the requested face first (when it IS installed nothing changes), then
 * the metric-compatible free substitute, then a generic of the RIGHT class.
 */
export function repairFontFallbacks(svg: string): string {
  return svg.replace(/font-family:([^;"]+)/g, (whole, stack: string) => {
    const first = stack
      .split(',')[0]
      .trim()
      .replace(/^['"]|['"]$/g, '')
    if (!first) return whole
    const key = first.toLowerCase()
    if (/^(serif|sans-serif|monospace|cursive|fantasy|system-ui)$/.test(key)) return whole
    const fallback =
      MONO_FACES.has(key) || /\bmono\b/.test(key)
        ? ["'Liberation Mono'", 'Consolas', "'Courier New'", 'monospace']
        : SERIF_FACES.has(key) || /serif/.test(key)
          ? ['Caladea', 'Georgia', "'Times New Roman'", 'serif']
          : ['Carlito', "'Helvetica Neue'", 'Arial', 'sans-serif']
    // The requested face leads, so drop it from the tail: naming it twice
    // is harmless to the browser and just noise in the file.
    const tail = fallback.filter((f) => f.replace(/'/g, '').toLowerCase() !== key)
    return `font-family:'${first}', ${tail.join(', ')}`
  })
}

type PptxApi = typeof import('@office-kit/pptx')
type Shape = ReturnType<PptxApi['getSlideShapes']>[number]

/**
 * Give every un-aligned paragraph on a non-placeholder shape an explicit LEFT
 * alignment, in memory, before the slide is painted. The .pptx on disk is
 * never touched.
 *
 * Why: OOXML lets a paragraph say nothing about alignment, and the two ways of
 * resolving that disagree. The renderer follows the authoring convention —
 * text typed into an autoshape centres, text in a text box (`txBox="1"`) sits
 * left — while PowerPoint resolves the same silence through the deck's own
 * `defaultTextStyle`, which says `algn="l"` in every deck we have looked at.
 * The two only diverge on an autoshape, and that is exactly what pptxgenjs
 * emits for a run of text: `<p:cNvSpPr/>`, no `txBox`. So a deck rendered
 * faithfully by PowerPoint came out centre-aligned here, title, headings and
 * all.
 *
 * Placeholders are left alone: they inherit from the layout and master, that
 * chain is resolved correctly, and a real title placeholder IS centred when
 * its master says so. Paragraphs that state their own alignment are untouched,
 * so a deliberately centred line stays centred.
 */
function anchorTextLeft(pptx: PptxApi, slide: Parameters<PptxApi['getSlideShapes']>[0]): void {
  const walk = (shapes: ReadonlyArray<Shape>): void => {
    for (const shape of shapes) {
      if (pptx.getShapeKind(shape) === 'group') {
        walk(pptx.getGroupChildren(shape))
        continue
      }
      if (pptx.isShapePlaceholder(shape)) continue
      let paragraphs = 0
      try {
        paragraphs = pptx.getShapeParagraphCount(shape)
      } catch {
        continue
      }
      for (let i = 0; i < paragraphs; i++) {
        try {
          if (pptx.getParagraphAlignment(shape, i) === null) {
            pptx.setParagraphAlignment(shape, i, 'left')
          }
        } catch {
          // A shape whose text model won't answer keeps whatever it had.
        }
      }
    }
  }
  walk(pptx.getSlideShapes(slide))
}

/**
 * Drop preview directories whose deck is gone — a deleted upload, a purged
 * conversation. Idempotent, and safe to run while nothing has ever rendered.
 * Called from `cleanupWorkspace()` on every launch.
 */
export async function sweepDeckPreviews(): Promise<void> {
  const root = path.join(workspaceRoot(), PREVIEW_DIR)
  let entries: string[]
  try {
    entries = await fs.readdir(root)
  } catch {
    return
  }
  for (const entry of entries) {
    const dir = path.join(root, entry)
    const manifest = await readManifest(dir)
    const abs = manifest ? resolveUploadPath(manifest.source) : null
    if (abs) {
      try {
        await fs.access(abs)
        continue
      } catch {
        // falls through to removal
      }
    }
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined)
  }
}
