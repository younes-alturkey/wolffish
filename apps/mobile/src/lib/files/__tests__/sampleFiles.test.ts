import {
  allSampleFiles,
  SAMPLE_BASE_URL,
  SAMPLE_README_URL,
  sampleExtFor,
  sampleUrlFor
} from '@/lib/files/sampleFiles'
import { classifyFile } from '@/lib/files/fileKinds'

/**
 * The published sample set is the demo's entire file layer, and it is a remote
 * contract: every URL here was fetched and byte-compared against the source set
 * once. These tests are what keeps the list honest afterwards — an edit that
 * drops a type, duplicates one, or malforms a URL fails here rather than
 * showing up as an unavailable card on someone's phone.
 */

const files = allSampleFiles()

describe('the published sample set', () => {
  it('is all 111 files: 110 types plus the README', () => {
    expect(files).toHaveLength(111)
    expect(files.filter((f) => f.name.startsWith('wolffish-sample.'))).toHaveLength(110)
    expect(files.at(-1)).toEqual({
      name: 'README.md',
      ext: 'md',
      url: `${SAMPLE_BASE_URL}/README.md`
    })
    expect(SAMPLE_README_URL).toBe(`${SAMPLE_BASE_URL}/README.md`)
  })

  it('has no duplicate or malformed entries', () => {
    const names = files.map((f) => f.name)
    expect(new Set(names).size).toBe(names.length)
    // Extensions are unique among the samples; README.md shares `md` with
    // wolffish-sample.md, which is why it is named explicitly rather than
    // derived from the extension list.
    const sampleExts = files.filter((f) => f.name !== 'README.md').map((f) => f.ext)
    expect(new Set(sampleExts).size).toBe(110)
    for (const file of files) {
      expect(file.ext).toBe(file.ext.toLowerCase())
      expect(file.url).toBe(`${SAMPLE_BASE_URL}/${file.name}`)
      expect(file.url).toMatch(/^https:\/\/cdn\.wolffi\.sh\/samples\/[\w.-]+$/)
    }
  })

  it('resolves a workspace path to the sample for its extension', () => {
    // The path keeps its own name and folder; only the bytes are shared.
    expect(sampleUrlFor('uploads/conv-2026-07-24/photo.png')).toBe(
      `${SAMPLE_BASE_URL}/wolffish-sample.png`
    )
    expect(sampleUrlFor('files/report.PDF')).toBe(`${SAMPLE_BASE_URL}/wolffish-sample.pdf`)
    // .tif and .tiff are the same kind to fileKinds, so one sample serves both.
    expect(sampleExtFor('scan.tif')).toBe('tiff')
  })

  it('returns null for a type with no sample, rather than a dead URL', () => {
    // .zip is the one type the demo references that the CDN has no sample for.
    expect(sampleUrlFor('files/bundle.zip')).toBeNull()
    expect(sampleUrlFor('files/no-extension')).toBeNull()
    expect(sampleUrlFor('')).toBeNull()
  })

  it('serves the chart sample — never the generic JSON one — behind a chart spec', () => {
    // `.chart.json` is its own type: the double extension resolves to the
    // published chart spec, while plain .json keeps its own sample.
    expect(sampleUrlFor('files/q3-revenue.chart.json')).toBe(
      `${SAMPLE_BASE_URL}/wolffish-sample.chart.json`
    )
    expect(sampleExtFor('files/q3-revenue.chart.json')).toBe('chart.json')
    expect(sampleUrlFor('files/data.json')).toBe(`${SAMPLE_BASE_URL}/wolffish-sample.json`)
  })

  it('gives every viewer in the dispatch table something real to render', () => {
    // A kind with no sample behind it would be untestable on a device.
    const kinds = new Set(files.map((f) => classifyFile(f.name).kind))
    const covered = ['image', 'video', 'audio', 'pdf', 'markdown', 'text', 'code', 'html', 'chart']
    for (const kind of covered) {
      expect(kinds).toContain(kind)
    }
  })
})
