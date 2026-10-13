import { Asset } from 'expo-asset'
import { Directory, File, Paths } from 'expo-file-system'
// Assets, not source: Metro follows these at bundle time to pack them into the
// binary (same note as lib/changelog). `@/assets/*` is its own tsconfig path
// mapping to the repo-root assets/ — it wins over `@/*` because the longer
// prefix matches first, in Metro and in tsc alike.
import chartPageJs from '@/assets/charts/chart-page.webjs'
import echartsJs from '@/assets/charts/echarts.min.webjs'
import plexRegular from '@/assets/fonts/IBMPlexSansArabic-Regular.ttf'

/**
 * The chart WebView's host document. Everything is inlined — the vendored
 * ECharts build, the page runtime, and the app's IBM Plex Sans Arabic face
 * (charts must draw the same type as the rest of the app, and the desktop's
 * charts do) — so the page needs no network and works fully offline.
 *
 * The composed document is a few MB (mostly the base64 face), which is past
 * what `source={{ html }}` reliably carries on Android, so it is written once
 * to the cache directory and loaded as a file:// URL — the same mechanism the
 * PDF card already uses. The filename carries a fingerprint of the inputs, so
 * an app update that changes any of them lands on a fresh file instead of a
 * stale cached page.
 */

export type ChartHostDocument = {
  /** file:// URI of the composed host page. */
  uri: string
  /** Its containing directory — for WKWebView's read-access scope. */
  directory: string
}

const HOST_DIR = 'chart-host'

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

async function assetBase64(moduleId: number): Promise<string> {
  const asset = Asset.fromModule(moduleId)
  if (!asset.localUri) await asset.downloadAsync()
  return await new File(asset.localUri ?? asset.uri).base64()
}

function composeDocument(echarts: string, page: string, fontBase64: string): string {
  // dir="ltr" always: plot geometry is LTR on the desktop too — RTL locales
  // affect the chrome around the card, not the plot.
  return [
    '<!doctype html>',
    '<html dir="ltr"><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no">',
    '<style>',
    "@font-face{font-family:'IBM Plex Sans Arabic';font-style:normal;font-weight:400;" +
      `src:url(data:font/ttf;base64,${fontBase64}) format('truetype')}`,
    'html,body{margin:0;padding:0;background:transparent;overflow:hidden}',
    '#live{position:fixed;inset:0}',
    '</style></head><body><div id="live"></div>',
    '<script>',
    echarts,
    '</script>',
    '<script>',
    page,
    '</script>',
    '</body></html>'
  ].join('\n')
}

let building: Promise<ChartHostDocument> | null = null

async function build(): Promise<ChartHostDocument> {
  const [echarts, page, fontBase64] = await Promise.all([
    assetText(echartsJs),
    assetText(chartPageJs),
    assetBase64(plexRegular)
  ])
  const html = composeDocument(echarts, page, fontBase64)
  const directory = new Directory(Paths.cache, HOST_DIR)
  directory.create({ intermediates: true, idempotent: true })
  const target = new File(directory, `chart-host-${fingerprint(html)}.html`)
  if (!target.exists) {
    // Predecessors from older app versions are dead weight — clear them.
    for (const entry of directory.list()) {
      try {
        if (entry instanceof File) entry.delete()
      } catch {
        // A file busy in another WebView is fine to leave behind.
      }
    }
    await target.write(html)
  }
  return { uri: target.uri, directory: directory.uri }
}

/** Compose (once) and return the host document — concurrent callers share one build. */
export function ensureChartHostDocument(): Promise<ChartHostDocument> {
  if (!building) {
    building = build().catch((error: unknown) => {
      // A failed build (full disk, asset fetch in dev) must not poison every
      // later chart — let the next caller retry.
      building = null
      throw error
    })
  }
  return building
}
