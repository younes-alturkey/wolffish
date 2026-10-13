import { Asset } from 'expo-asset'
import { Directory, File, Paths } from 'expo-file-system'
// Assets, not source — same note as lib/charts/html.
import pdfPageJs from '@/assets/pdf/pdf-page.webjs'
import pdfLibJs from '@/assets/pdf/pdf.min.webjs'
import pdfWorkerJs from '@/assets/pdf/pdf.worker.min.webjs'

/**
 * The PDF WebView's host document — Android's answer to the PDF engine iOS
 * gets for free. WKWebView embeds PDFKit, so on iOS the card points a WebView
 * at the file and the document draws itself; Android's WebView has shipped no
 * PDF engine, ever, so the renderer has to come with the page. This composes
 * one: the vendored pdf.js build, its worker, the page runtime, and the
 * document's own bytes as base64, inlined into a single offline page.
 *
 * The bytes are in the page rather than fetched by it because a `file://` page
 * cannot read another `file://` URL — that is what `allowFileAccessFromFileURLs`
 * would open, and the card keeps it shut (an agent's workspace is the source of
 * these files). Inlining also makes the frame self-contained, so the inline
 * preview and the expanded sheet can each mount the same URL with no message
 * handshake between them; they differ only by the `#preview` / `#full` hash.
 *
 * The cost is a per-document page of about 1.33× the PDF plus ~1.8MB of engine,
 * written to the cache directory and keyed by a fingerprint of both — so the
 * second view of a file is a cache hit, and an app update that changes the
 * engine lands on fresh files and sweeps the old ones.
 */

export type PdfHostDocument = {
  /** file:// URI of the composed host page. */
  uri: string
  /** Its containing directory — for WKWebView's read-access scope. */
  directory: string
}

const HOST_DIR = 'pdf-host'

/**
 * Above this the document is left to the system viewer. Composing means
 * holding the base64 and the assembled page in JS memory at once, which is
 * roughly 2.7× the file — a ceiling, not a judgement about what pdf.js can
 * render.
 */
export const PDF_MAX_INLINE_BYTES = 10 * 1024 * 1024

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
  /** pdf.js + its worker + the page runtime, in load order. */
  scripts: string[]
  /** Fingerprint of the three — the cache generation. */
  tag: string
}

let engine: Promise<Engine> | null = null

/**
 * Read the three scripts once per app run. Composing the tenth PDF must not
 * re-read 1.8MB of assets, and the tag they hash to is the same every time.
 *
 * The worker script is loaded into the page rather than into a Worker: pdf.js
 * looks for `globalThis.pdfjsWorker.WorkerMessageHandler` before it tries to
 * spawn one, and finding it runs the whole parse on the page's own thread.
 * That is the only path available here — a `file://` document has an opaque
 * origin, and Chrome refuses to construct a worker from one. It costs nothing
 * the user sees: the thread it blocks is the WebView's, not the app's.
 */
function loadEngine(): Promise<Engine> {
  if (!engine) {
    engine = Promise.all([assetText(pdfLibJs), assetText(pdfWorkerJs), assetText(pdfPageJs)])
      .then(([lib, worker, page]) => ({
        scripts: [lib, worker, page],
        // The runtime is hashed whole; the two vendored builds only by length,
        // which no real version bump leaves unchanged and which keeps this off
        // 1.8MB of character loops.
        tag: fingerprint(`${lib.length}:${worker.length}:${page}`)
      }))
      .catch((error: unknown) => {
        engine = null
        throw error
      })
  }
  return engine
}

function composeDocument(scripts: string[], base64: string): string {
  // dir="ltr" always: a PDF carries its own layout, and the page around it is
  // nothing but the document.
  return [
    '<!doctype html>',
    '<html dir="ltr"><head><meta charset="utf-8">',
    // Filled in by the runtime, which needs the mode from the hash to know
    // whether pinch-zoom is allowed.
    '<meta id="viewport" name="viewport" content="width=device-width, initial-scale=1">',
    '<style>',
    'html,body{margin:0;padding:0;background:#fff}',
    'body.full{background:#e9e9ea}',
    '#doc{display:flex;flex-direction:column}',
    'body.full #doc{gap:8px;padding:8px 0}',
    '.page{background:#fff;font-size:0}',
    'body.full .page{box-shadow:0 1px 4px rgba(0,0,0,.18)}',
    'canvas{display:block;width:100%;height:auto}',
    '</style></head><body><div id="doc"></div>',
    // Data first: the runtime reads it at DOMContentLoaded, and a string this
    // large is cheaper to hand over as a literal than through any message.
    `<script>window.__wolffishPdfData=${JSON.stringify(base64)}</script>`,
    ...scripts.flatMap((script) => ['<script>', script, '</script>']),
    '</body></html>'
  ].join('\n')
}

/**
 * Compose (or reuse) the host page for one PDF.
 *
 * `key` identifies the document for caching — the workspace-relative path and
 * its size, which is what changes when an agent rewrites a file in place.
 */
export async function ensurePdfHostDocument(
  fileUri: string,
  key: string
): Promise<PdfHostDocument> {
  const { scripts, tag } = await loadEngine()
  const directory = new Directory(Paths.cache, HOST_DIR)
  directory.create({ intermediates: true, idempotent: true })

  const prefix = `pdf-${tag}-`
  const target = new File(directory, `${prefix}${fingerprint(key)}.html`)
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
    await target.write(composeDocument(scripts, await new File(fileUri).base64()))
  }
  return { uri: target.uri, directory: directory.uri }
}
