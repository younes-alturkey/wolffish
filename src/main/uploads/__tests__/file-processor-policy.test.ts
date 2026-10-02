/**
 * File-processor policy tests — pins the 100% model-led attachment contract:
 * NO file content is ever auto-injected into model context. Every attachment
 * becomes a reference note (name, absolute path, type facts) steering the
 * model to the tools that read it — pdf_info/pdf_search/pdf_read, file_read
 * line ranges, image_view, document/spreadsheet tools — and the model pulls
 * content on its own terms.
 *
 * Standalone — no vitest/jest in this repo. Run:
 *   TSX_TSCONFIG_PATH=tsconfig.node.json npx tsx src/main/uploads/__tests__/file-processor-policy.test.ts
 */
import { processAttachmentAbsolute } from '../file-processor'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

let failures = 0
function ok(name: string, cond: boolean, extra?: unknown): void {
  console.log(
    `${cond ? 'PASS' : 'FAIL'}: ${name}${extra !== undefined ? ` — ${String(extra)}` : ''}`
  )
  if (!cond) failures++
}

/**
 * Hand-rolled minimal N-page PDF (pages with no content streams are valid),
 * so tests need no PDF library. Offsets in the xref table are computed, which
 * is what makes pdf.js accept it.
 */
function makeSimplePdf(pageCount: number): Buffer {
  const objects: string[] = []
  const kids = Array.from({ length: pageCount }, (_, i) => `${3 + i} 0 R`).join(' ')
  objects.push(`1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n`)
  objects.push(`2 0 obj\n<< /Type /Pages /Kids [${kids}] /Count ${pageCount} >>\nendobj\n`)
  for (let i = 0; i < pageCount; i++) {
    objects.push(
      `${3 + i} 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>\nendobj\n`
    )
  }
  const header = '%PDF-1.4\n'
  let body = ''
  const offsets: number[] = []
  for (const obj of objects) {
    offsets.push(header.length + body.length)
    body += obj
  }
  const xrefStart = header.length + body.length
  let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  for (const off of offsets) {
    xref += `${String(off).padStart(10, '0')} 00000 n \n`
  }
  const trailer = `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`
  return Buffer.from(header + body + xref + trailer, 'latin1')
}

function noteText(r: Awaited<ReturnType<typeof processAttachmentAbsolute>>): string {
  return r?.blocks[0]?.type === 'text' ? (r.blocks[0] as { text: string }).text : ''
}

async function main(): Promise<void> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wolffish-fp-test-'))
  const write = async (name: string, data: Buffer | string): Promise<string> => {
    const p = path.join(dir, name)
    await fs.writeFile(p, data)
    return p
  }
  const vision = { supportsVision: true }
  const textOnly = { supportsVision: false }

  // --- PDFs: never inlined, note tier by size --------------------------
  const smallPdf = await write('small.pdf', makeSimplePdf(3))
  const r1 = await processAttachmentAbsolute(smallPdf, 'application/pdf', 'small.pdf', vision)
  const r1text = noteText(r1)
  ok('small pdf: NOT a document block (never inlined)', r1?.blocks[0]?.type === 'text')
  ok('small pdf note: flags not-loaded', r1text.includes('not loaded into context'))
  ok('small pdf note: real page count', r1text.includes('3 pages'), r1text.split('\n')[0])
  ok('small pdf note: exact read call', r1text.includes('pdf_read (pages="1-3")'))

  const manyPagesPdf = await write('manypages.pdf', makeSimplePdf(40))
  const r2 = await processAttachmentAbsolute(
    manyPagesPdf,
    'application/pdf',
    'manypages.pdf',
    vision
  )
  const r2text = noteText(r2)
  ok('40-page pdf: reference note', r2?.blocks[0]?.type === 'text')
  ok('40-page pdf note: real page count', r2text.includes('40 pages'))
  ok(
    '40-page pdf note: full workflow',
    r2text.includes('pdf_info') && r2text.includes('pdf_search') && r2text.includes('pdf_read')
  )
  ok('40-page pdf note: no-skip contract', r2text.includes('Never guess or claim knowledge'))

  const junkPdf = await write('junk.pdf', Buffer.alloc(5 * 1024 * 1024, 0x41))
  const r3 = await processAttachmentAbsolute(junkPdf, 'application/pdf', 'junk.pdf', vision)
  ok('unparseable pdf: unreadable label', noteText(r3).includes('page count unreadable'))

  // --- Text-family documents: never inlined ----------------------------
  const smallTxt = await write('notes.txt', 'hello wolffish\nline two\n')
  const r4 = await processAttachmentAbsolute(smallTxt, 'text/plain', 'notes.txt', vision)
  const r4text = noteText(r4)
  ok('small txt: content NOT injected', !r4text.includes('hello wolffish'))
  ok('small txt note: flags not-loaded', r4text.includes('not loaded into context'))
  ok('small txt note: names file_read', r4text.includes('file_read'))

  const bigTxt = await write('big.txt', 'data line\n'.repeat(20_000)) // ~200KB
  const r5 = await processAttachmentAbsolute(bigTxt, 'text/plain', 'big.txt', vision)
  const r5text = noteText(r5)
  ok('big txt: content NOT injected', !r5text.includes('data line'))
  ok(
    'big txt note: ranged reads + exhaustive search',
    r5text.includes('startLine') && r5text.includes('rg -n')
  )
  ok('big txt note: no-skip contract', r5text.includes('Never guess or claim knowledge'))

  const bigCsv = await write('big.csv', 'a,b,c\n'.repeat(30_000))
  const r6 = await processAttachmentAbsolute(bigCsv, 'text/csv', 'big.csv', vision)
  ok('big csv note: steers to data tools', noteText(r6).includes('python or spreadsheet'))

  const smallCsv = await write('small.csv', 'a,b\n1,2\n')
  const r7 = await processAttachmentAbsolute(smallCsv, 'text/csv', 'small.csv', vision)
  ok('small csv note: names file_read', noteText(r7).includes('file_read'))

  // --- Office formats: guidance names only tools that exist ------------
  const docx = await write('report.docx', 'zip-bytes-placeholder')
  const r8 = await processAttachmentAbsolute(
    docx,
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'report.docx',
    vision
  )
  ok('docx note: names document_read', noteText(r8).includes('document_read'))

  const xlsx = await write('data.xlsx', 'zip-bytes-placeholder')
  const r9 = await processAttachmentAbsolute(
    xlsx,
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'data.xlsx',
    vision
  )
  ok('xlsx note: names spreadsheet_read', noteText(r9).includes('spreadsheet_read'))

  const pptx = await write('deck.pptx', 'zip-bytes-placeholder')
  const r10 = await processAttachmentAbsolute(
    pptx,
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    'deck.pptx',
    vision
  )
  ok('pptx note: names presentation_read', noteText(r10).includes('presentation_read'))

  // --- Archives: never unpacked, and ask before acting -----------------
  const zip = await write('project.zip', Buffer.from('PKzip-bytes-placeholder'))
  const r14 = await processAttachmentAbsolute(zip, 'application/zip', 'project.zip', vision)
  const r14text = noteText(r14)
  ok('zip: NOT inlined (reference note only)', r14?.blocks[0]?.type === 'text')
  ok('zip note: flags nothing unpacked', r14text.includes('nothing unpacked'))
  ok(
    'zip note: names the archive tools',
    r14text.includes('archive_list') && r14text.includes('archive_extract')
  )
  ok('zip note: do-not-extract-by-default contract', r14text.includes('do NOT extract by default'))

  // A .zip that arrives with no mimetype (channel media) must still route by
  // extension, not fall through to "unsupported → invisible to the model".
  const r15 = await processAttachmentAbsolute(
    zip,
    'application/octet-stream',
    'project.zip',
    vision
  )
  ok('zip by extension alone: still a note', noteText(r15).includes('archive_list'))

  // --- Images: pixels only on demand via image_view --------------------
  const sharp = (await import('sharp')).default
  const realPng = await write(
    'photo.png',
    await sharp({
      create: { width: 800, height: 600, channels: 3, background: { r: 200, g: 30, b: 30 } }
    })
      .png()
      .toBuffer()
  )
  const r11 = await processAttachmentAbsolute(realPng, 'image/png', 'photo.png', vision)
  const r11text = noteText(r11)
  ok('image (vision): NOT an image block (never inlined)', r11?.blocks[0]?.type === 'text')
  ok('image note: flags not-loaded', r11text.includes('not loaded into context'))
  ok('image note: real dimensions', r11text.includes('800x600'), r11text.split('\n')[0])
  ok('image note: names image_view', r11text.includes('image_view'))
  ok('image note: no-view-no-claims contract', r11text.includes('have not actually viewed'))

  const corruptPng = await write('broken.png', Buffer.from('not really a png at all'))
  const r12 = await processAttachmentAbsolute(corruptPng, 'image/png', 'broken.png', vision)
  const r12text = noteText(r12)
  ok(
    'corrupt image (vision): still a note (probe failure tolerated)',
    r12text.includes('image_view'),
    r12text.split('\n')[0]
  )

  const r13 = await processAttachmentAbsolute(realPng, 'image/png', 'photo.png', textOnly)
  ok('image on text-only model: existing note path intact', noteText(r13).includes('text-only'))

  await fs.rm(dir, { recursive: true, force: true })
  console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURES`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error('Test run crashed:', err)
  process.exit(1)
})
