import { fileExt, fileName } from '@/lib/files/fileKinds'
import published from '@/lib/files/publishedSamples.json'

/**
 * CDN sample files — where demo-mode file bytes come from.
 *
 * Demo conversations keep the desktop's workspace-relative paths
 * ("uploads/conv-…/photo.png", "files/report.pdf"), but the bytes behind them
 * are never shipped: the real workspace media was personal, ~184 MB, and
 * different on every machine that built the dataset. Instead each path is
 * served the sample published for its extension, so every user sees the same
 * demo, nothing personal leaves a workspace, and the app installs small.
 *
 * A path maps by extension alone — 26 different .pdf references all resolve to
 * wolffish-sample.pdf. The download is stored under its original workspace
 * path, keeping the original name and extension, so classifyFile and every
 * viewer behave exactly as they would for a real file.
 *
 * publishedSamples.json lists exactly what is published at
 * https://cdn.wolffi.sh/samples/ — 110 files: one sample per file type the
 * desktop recognises (109) plus the README describing the set. Every one was
 * fetched and byte-compared against the source set before being listed, so the
 * manifest doubles as the reference list for anything else that wants these
 * files later (a file-type gallery, docs, fixtures): `allSampleFiles()` hands
 * back all 110 with their URLs. scripts/demo/sample-exts.mjs reads the same
 * file, so the demo build's "no sample for this type" warning can never
 * disagree with what the app resolves. A type with no sample (.zip) resolves to
 * null and the viewer shows its per-type unavailable state, not a broken card.
 */

export const SAMPLE_BASE_URL = published.baseUrl

const SAMPLE_EXTS = new Set<string>(published.extensions)

/**
 * Extensions with no sample of their own that a published one stands in for.
 * Only aliases fileKinds already treats identically qualify — `.tif` and
 * `.tiff` are both plain IMAGE_EXTS entries, so one TIFF serves both.
 */
const SAMPLE_ALIASES: Record<string, string> = published.aliases

/** The published sample extension serving this path, or null when there is none. */
export function sampleExtFor(pathOrName: string): string | null {
  // `.chart.json` is its own file type (an agent-authored chart spec) even
  // though its single extension says .json — serving the generic JSON sample
  // would put type-mismatched bytes behind a chart card. Until a
  // `wolffish-sample.chart.json` is published (and listed in the manifest),
  // these resolve to the per-type unavailable state, like .zip.
  if (fileName(pathOrName).toLowerCase().endsWith('.chart.json')) {
    return SAMPLE_EXTS.has('chart.json') ? 'chart.json' : null
  }
  const ext = fileExt(pathOrName)
  if (!ext) return null
  if (SAMPLE_EXTS.has(ext)) return ext
  return SAMPLE_ALIASES[ext] ?? null
}

/** CDN URL serving this path's bytes, or null when its type has no sample. */
export function sampleUrlFor(pathOrName: string): string | null {
  const ext = sampleExtFor(pathOrName)
  return ext ? `${SAMPLE_BASE_URL}/${published.stem}.${ext}` : null
}

/** The README describing the published set — the one file with no extension key. */
export const SAMPLE_README_URL = `${SAMPLE_BASE_URL}/${published.docs}`

export type SampleFile = {
  /** Filename as published, e.g. "wolffish-sample.png" or "README.md". */
  name: string
  /** Lowercase extension without the dot. */
  ext: string
  url: string
}

/**
 * Every published sample — all 110, README last. Nothing in the app needs the
 * whole list today; it is here so that whatever wants it next (a file-type
 * gallery, a docs page, test fixtures) does not have to re-derive or re-verify
 * the set.
 */
export function allSampleFiles(): SampleFile[] {
  const samples = published.extensions.map((ext) => ({
    name: `${published.stem}.${ext}`,
    ext,
    url: `${SAMPLE_BASE_URL}/${published.stem}.${ext}`
  }))
  const docsExt = published.docs.slice(published.docs.lastIndexOf('.') + 1).toLowerCase()
  return [...samples, { name: published.docs, ext: docsExt, url: SAMPLE_README_URL }]
}
