import { Asset } from 'expo-asset'
import { Directory, File, Paths } from 'expo-file-system'
// Assets, not source — same note as lib/pdf/html and lib/charts/html.
import officeEngineJs from '@/assets/office/office-engine.webjs'
import officePageJs from '@/assets/office/office-page.webjs'

/**
 * The office card's host document — one self-contained page per .docx, .xlsx
 * or .pptx.
 *
 * This is lib/pdf/html's shape applied to the other three office formats, and
 * for the same reason: the renderer has to travel with the page. What differs
 * is that it travels on BOTH platforms. iOS does render all of these natively
 * in WKWebView (it is the only mobile OS that does), but that engine hands
 * back no page count, no sheet names and no way to jump to slide seven — so a
 * card built on it could show the document and nothing else. The pager, the
 * sheet switcher and a single behaviour to test are worth more than the
 * fidelity difference, and the engines here are wolffish-app's own, so a deck
 * looks the same on the phone as on the desktop.
 *
 * The bytes are inlined rather than fetched for the reason the PDF card
 * inlines its own: a `file://` page cannot read a second `file://` URL without
 * `allowFileAccessFromFileURLs`, and an agent's workspace is what sits behind
 * these files, so that door stays shut.
 *
 * The cost is a per-document page of about 1.33× the file plus ~950KB of
 * engine, written to the cache directory and keyed by a fingerprint of both —
 * so the second view of a file is a cache hit, and an app update that changes
 * the engine lands on fresh files and sweeps the old ones.
 */

export type OfficeKind = 'docx' | 'xlsx' | 'pptx'

export type OfficeHostDocument = {
  /** file:// URI of the composed host page. */
  uri: string
  /** Its containing directory — for WKWebView's read-access scope. */
  directory: string
}

/** Colours the page paints its own chrome with, from the app's theme. */
export type OfficeTheme = {
  bg: string
  surface: string
  fg: string
  muted: string
  border: string
}

const HOST_DIR = 'office-host'

/**
 * Above this the document is left to the system viewer. Composing means
 * holding the base64 and the assembled page in JS memory at once, which is
 * roughly 2.7× the file — a ceiling, not a judgement about what the engines
 * can render. Lower than the PDF card's because three engines have to parse
 * the whole document into a DOM, where pdf.js rasterises a page at a time.
 */
export const OFFICE_MAX_INLINE_BYTES = 8 * 1024 * 1024

/** Pages, slides or sheets rendered before the card stops — the desktop's cap. */
const MAX_PAGES = 300
/** Rows read per sheet. SheetJS stops parsing there, so this bounds the work. */
const MAX_ROWS = 400
const MAX_COLS = 64

/** djb2 — cheap change-detection for the composed page, not a security hash. */
function fingerprint(text: string): string {
  let hash = 5381
  for (let i = 0; i < text.length; i++) {
    hash = ((hash << 5) + hash + text.charCodeAt(i)) | 0
  }
  return (hash >>> 0).toString(36)
}

async function assetText(moduleId: number): Promise<string> {
  const asset = Asset.fromModule(moduleId)
  // Local in a store build, a Metro fetch in development — either way this
  // is what puts a readable URI on the asset, and it is a no-op once done.
  if (!asset.localUri) await asset.downloadAsync()
  return await new File(asset.localUri ?? asset.uri).text()
}

type Engine = {
  /** The engine bundle and the page runtime, in load order. */
  scripts: string[]
  /** Fingerprint of the two — the cache generation. */
  tag: string
}

let engine: Promise<Engine> | null = null

/**
 * Read the two scripts once per app run. Composing the tenth document must not
 * re-read ~950KB of assets, and the tag they hash to is the same every time.
 */
function loadEngine(): Promise<Engine> {
  if (!engine) {
    engine = Promise.all([assetText(officeEngineJs), assetText(officePageJs)])
      .then(([bundle, page]) => ({
        scripts: [bundle, page],
        // The runtime is hashed whole; the vendored bundle only by length,
        // which no real version bump leaves unchanged and which keeps this off
        // a ~950KB character loop.
        tag: fingerprint(`${bundle.length}:${page}`)
      }))
      .catch((error: unknown) => {
        engine = null
        throw error
      })
  }
  return engine
}

/**
 * The page's own chrome. Two rules, both the desktop's:
 *
 *  - a document or a deck brings its own paper, so a .docx page and a slide
 *    stay white in dark mode exactly as they do on the desktop and in the PDF
 *    card. Only the gutter around them follows the theme.
 *  - a workbook has no paper. SheetJS Community exposes no cell fills, so
 *    every cell is app chrome and follows the theme — which is the difference
 *    between a readable dark-mode sheet and a black-on-black one.
 */
function styles(kind: OfficeKind, theme: OfficeTheme): string {
  return [
    `:root{--bg:${theme.bg};--surface:${theme.surface};--fg:${theme.fg};`,
    `--muted:${theme.muted};--border:${theme.border}}`,
    'html,body{margin:0;padding:0;background:var(--bg);-webkit-text-size-adjust:100%}',
    '.page[hidden]{display:none}',
    kind === 'docx'
      ? [
          // A document scrolls: its pages are a column, each one the full width
          // of the card, separated the way paper would be.
          '#doc{position:relative;width:100%}',
          '.page{position:relative;width:100%;background:#fff;overflow:hidden;',
          'margin-bottom:8px;box-shadow:0 1px 4px rgba(0,0,0,.18)}',
          // Pinned to the origin because fitDocument scales it from there, and
          // a transform leaves the box's own height to be set explicitly.
          '.page.doc-page > section{position:absolute;top:0;left:0;background:#fff}'
        ].join('')
      : [
          // A slide or a sheet is switched to, not scrolled past: one fills the
          // frame and the rest are hidden behind it.
          'html,body{height:100%;overflow:hidden}',
          '#doc{position:relative;width:100%;height:100%}',
          '.page{position:absolute;inset:0;overflow:hidden}',
          // The gutter shows only where a slide cannot fill its box — the
          // expanded sheet, where a 4:3 slide sits in a portrait screen. In the
          // card the box is the slide's own shape, so none of it shows. It is
          // the theme's colour rather than white so that it reads as the mat
          // wolffish-app paints, instead of as a bar on the slide.
          '.page{background:var(--bg)}',
          // The slide SVGs carry preserveAspectRatio="xMidYMid meet", so
          // filling the box letterboxes them rather than stretching.
          '.page svg{display:block;width:100%;height:100%}'
        ].join(''),
    kind === 'xlsx'
      ? [
          // A sheet is not a page: it has no paper of its own, so it takes the
          // app's surface (dark included) and scrolls inside the card.
          'body{background:var(--surface)}',
          '.page{background:var(--surface);overflow:auto;',
          '-webkit-overflow-scrolling:touch}',
          'table.sheet{border-collapse:collapse;color:var(--fg);direction:ltr;',
          'font:12px -apple-system,system-ui,Roboto,sans-serif}',
          'table.sheet th,table.sheet td{border:1px solid var(--border);padding:3px 6px;',
          'white-space:nowrap;text-align:left}',
          'table.sheet th.head,table.sheet th.gutter{background:var(--bg);color:var(--muted);',
          'font-weight:500;text-align:center}',
          'table.sheet th.gutter{min-width:34px;position:sticky;left:0;z-index:1}',
          'table.sheet th.head{position:sticky;top:0;z-index:2}',
          'table.sheet tr:first-child th.gutter{z-index:3}'
        ].join('')
      : ''
  ].join('')
}

function composeDocument(
  scripts: string[],
  kind: OfficeKind,
  theme: OfficeTheme,
  base64: string
): string {
  // dir="ltr" always: an office file carries its own direction (a right-to-left
  // Word document lays itself out that way), and the page around it is nothing
  // but the document — same rule as the PDF host.
  return [
    '<!doctype html>',
    '<html dir="ltr"><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<style>${styles(kind, theme)}</style></head><body><div id="doc"></div>`,
    // Data first: the runtime reads it at DOMContentLoaded, and a string this
    // large is cheaper to hand over as a literal than through any message.
    `<script>window.__wolffishOffice=${JSON.stringify({
      kind,
      base64,
      maxPages: MAX_PAGES,
      maxRows: MAX_ROWS,
      maxCols: MAX_COLS
    })}</script>`,
    ...scripts.flatMap((script) => ['<script>', script, '</script>']),
    '</body></html>'
  ].join('\n')
}

/**
 * Compose (or reuse) the host page for one office file.
 *
 * `key` identifies the document for caching — the workspace-relative path, its
 * size and the theme, which is what changes when an agent rewrites a file in
 * place or the reader switches to dark mode.
 */
export async function ensureOfficeHostDocument(
  fileUri: string,
  kind: OfficeKind,
  theme: OfficeTheme,
  key: string
): Promise<OfficeHostDocument> {
  const { scripts, tag } = await loadEngine()
  const directory = new Directory(Paths.cache, HOST_DIR)
  directory.create({ intermediates: true, idempotent: true })

  const prefix = `office-${tag}-`
  const target = new File(directory, `${prefix}${fingerprint(`${kind}:${key}`)}.html`)
  if (!target.exists) {
    // Pages composed against an older engine are dead weight. Only those:
    // sibling cards for other documents are live and share this directory.
    for (const entry of directory.list()) {
      try {
        if (entry instanceof File && !entry.uri.includes(prefix)) entry.delete()
      } catch {
        // A file busy in another WebView is fine to leave behind.
      }
    }
    await target.write(composeDocument(scripts, kind, theme, await new File(fileUri).base64()))
  }
  return { uri: target.uri, directory: directory.uri }
}
