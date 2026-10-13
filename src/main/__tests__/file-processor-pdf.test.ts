/**
 * Large and malformed PDFs must never take the main process down: garbage
 * with a .pdf name is refused before pdf.js sees it, anything above the
 * probe cap is counted by a streaming scan instead of being read into RAM,
 * and a real small PDF still gets its exact page count.
 *
 * Standalone — run:
 *   npx tsx --tsconfig tsconfig.node.json src/main/__tests__/file-processor-pdf.test.ts
 */
export {}

import Module from 'node:module'
import { mkdtempSync, writeFileSync, openSync, writeSync, closeSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const loader = Module as unknown as { _load: (...a: unknown[]) => unknown }
const origLoad = loader._load
loader._load = function (this: unknown, ...args: unknown[]): unknown {
  if (args[0] === 'electron') {
    return {
      app: {
        isPackaged: false,
        getAppPath: () => process.cwd(),
        getPath: () => os.tmpdir(),
        getVersion: () => '0.0.0'
      },
      ipcMain: { handle: () => undefined, on: () => undefined }
    }
  }
  return origLoad.apply(this, args)
}

let passed = 0
let failed = 0
function ok(label: string, cond: boolean, detail?: string): void {
  if (cond) {
    passed++
    return
  }
  failed++
  console.error(`FAIL ${label}${detail ? `: ${detail}` : ''}`)
}

const TINY_PDF =
  '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 100]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj\n4 0 obj<</Length 44>>stream\nBT /F1 18 Tf 20 40 Td (hello wolffish) Tj ET\nendstream\nendobj\n5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj\ntrailer<</Root 1 0 R>>\n'

/** A file of `megabytes` MB: a PDF header, then page objects spaced across the file, zero padding between. */
function writeBigPdfLike(file: string, megabytes: number, pages: number, header = true): void {
  const fd = openSync(file, 'w')
  try {
    const total = megabytes * 1024 * 1024
    const zero = Buffer.alloc(1024 * 1024)
    let written = 0
    if (header) {
      written += writeSync(fd, '%PDF-1.7\n')
    }
    const gap = Math.floor((total - 1024) / Math.max(pages, 1))
    let nextPage = gap
    let pageNo = 0
    while (written < total) {
      if (pageNo < pages && written >= nextPage) {
        written += writeSync(fd, `\n${10 + pageNo} 0 obj<</Type /Page /Parent 2 0 R>>endobj\n`)
        pageNo++
        nextPage += gap
        continue
      }
      const step = Math.min(
        zero.length,
        nextPage - written > 0 ? nextPage - written : zero.length,
        total - written
      )
      written += writeSync(fd, zero, 0, Math.max(step, 1))
    }
  } finally {
    closeSync(fd)
  }
}

async function run(): Promise<void> {
  const { processAttachmentAbsolute, countPdfPageObjects } =
    await import('@main/uploads/file-processor')
  const dir = mkdtempSync(path.join(os.tmpdir(), 'wolffish-pdf-'))
  const opts = { supportsVision: true } as Parameters<typeof processAttachmentAbsolute>[3]

  const tiny = path.join(dir, 'tiny.pdf')
  writeFileSync(tiny, TINY_PDF)
  const a = await processAttachmentAbsolute(tiny, 'application/pdf', 'tiny.pdf', opts)
  ok(
    'small real PDF: exact page count',
    /1 page,/.test(a?.blocks[0]?.type === 'text' ? a.blocks[0].text : ''),
    JSON.stringify(a?.blocks[0])
  )

  const garbageSmall = path.join(dir, 'garbage-small.pdf')
  writeFileSync(garbageSmall, Buffer.alloc(300 * 1024, 7))
  const b = await processAttachmentAbsolute(
    garbageSmall,
    'application/pdf',
    'garbage-small.pdf',
    opts
  )
  const bText = b?.blocks[0]?.type === 'text' ? b.blocks[0].text : ''
  ok(
    'small garbage .pdf: survives, reports unreadable',
    /unreadable/.test(bText),
    bText.slice(0, 120)
  )

  const garbageBig = path.join(dir, 'garbage-big.pdf')
  writeBigPdfLike(garbageBig, 40, 0, false)
  const c = await processAttachmentAbsolute(garbageBig, 'application/pdf', 'garbage-big.pdf', opts)
  const cText = c?.blocks[0]?.type === 'text' ? c.blocks[0].text : ''
  ok(
    '40 MB garbage .pdf: survives, not probed',
    /not probed at this size/.test(cText),
    cText.slice(0, 160)
  )
  ok('40 MB garbage .pdf: size shown', /40\.0MB/.test(cText))

  const big = path.join(dir, 'big.pdf')
  writeBigPdfLike(big, 40, 37)
  const counted = await countPdfPageObjects(big)
  ok(
    'streaming count finds every page object across chunk boundaries',
    counted === 37,
    String(counted)
  )
  const d = await processAttachmentAbsolute(big, 'application/pdf', 'big.pdf', opts)
  const dText = d?.blocks[0]?.type === 'text' ? d.blocks[0].text : ''
  ok('big PDF note says about N pages', /about 37 pages/.test(dText), dText.slice(0, 160))
  ok('big PDF note keeps the tool workflow', /pdf_read/.test(dText) && /pdf_search/.test(dText))

  const pagesWord = path.join(dir, 'pages-word.pdf')
  writeFileSync(
    pagesWord,
    '%PDF-1.4\n2 0 obj<</Type /Pages /Kids[] /Count 0>>endobj\n1 0 obj<</Type/Page>>endobj\n'
  )
  ok('/Type /Pages is not a page', (await countPdfPageObjects(pagesWord)) === 1)
  ok('no header → null count', (await countPdfPageObjects(garbageBig)) === null)

  console.log(`file-processor-pdf: ${passed} passed, ${failed} failed`)
  process.exit(failed > 0 ? 1 : 0)
}

void run().catch((err) => {
  console.error(err)
  process.exit(1)
})
