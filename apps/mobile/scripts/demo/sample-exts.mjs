/**
 * The published sample set, for the demo build scripts.
 *
 * Reads src/lib/files/publishedSamples.json — the same file the app's
 * sampleFiles.ts imports — so a build-time report of "this type has no sample"
 * can never disagree with what the app will actually resolve at runtime.
 */
import { readFileSync } from 'node:fs'

const published = JSON.parse(
  readFileSync(new URL('../../src/lib/files/publishedSamples.json', import.meta.url), 'utf8')
)

const EXTS = new Set(published.extensions)

export const SAMPLE_BASE_URL = published.baseUrl

/** Lowercase extension of a path, without the dot; '' when it has none. */
export function extOf(pathOrName) {
  const base = pathOrName.split(/[/\\]/).pop() ?? ''
  const dot = base.lastIndexOf('.')
  if (dot <= 0 || dot === base.length - 1) return ''
  return base.slice(dot + 1).toLowerCase()
}

/** The published sample extension serving this path, or null when there is none. */
export function sampleExtFor(pathOrName) {
  // `.chart.json` is its own type (a chart spec, not a plain .json) — the
  // same special case as the app's sampleFiles.ts, which this must mirror.
  const base = (pathOrName.split(/[/\\]/).pop() ?? '').toLowerCase()
  if (base.endsWith('.chart.json')) {
    return EXTS.has('chart.json') ? 'chart.json' : null
  }
  const ext = extOf(pathOrName)
  if (!ext) return null
  if (EXTS.has(ext)) return ext
  return published.aliases[ext] ?? null
}

/** CDN URL serving this path's bytes, or null when its type has no sample. */
export function sampleUrlFor(pathOrName) {
  const ext = sampleExtFor(pathOrName)
  return ext ? `${published.baseUrl}/${published.stem}.${ext}` : null
}
