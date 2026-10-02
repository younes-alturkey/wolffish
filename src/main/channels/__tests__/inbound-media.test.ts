/**
 * Inbound-media tests — pins the fix that routes files sent over WhatsApp
 * (and, at the shared classification seam, Telegram) through the same
 * upload → attachment → processHistoryAttachments pipeline the in-app chat
 * uses, instead of dropping them as a dead '<media:document>' placeholder.
 *
 * Two units under test:
 *  - extractInboundMedia (whatsapp/messages.ts) — decides which inbound
 *    messages carry a downloadable file and, crucially, guarantees the saved
 *    filename has a usable extension (classifyFile derives type+mime from it,
 *    and the file-processor gates PDF/image handling on that mime).
 *  - classifyFile (uploads/uploads.ts) — the mime-hint fallback that keeps an
 *    extension-less inbound file (e.g. a PDF named "scan") from collapsing to
 *    an opaque octet-stream the model never sees.
 *
 * Standalone — no vitest/jest in this repo. Run:
 *   npx tsx --tsconfig tsconfig.node.json src/main/channels/__tests__/inbound-media.test.ts
 */

import Module from 'node:module'
import os from 'node:os'

// Shim `electron` so importing uploads.ts (workspace.ts touches electron.app
// at import) doesn't crash outside an Electron process. Must run before the
// dynamic imports in run().
const loader = Module as unknown as { _load: (...a: unknown[]) => unknown }
const origLoad = loader._load
loader._load = function (this: unknown, ...args: unknown[]): unknown {
  if (args[0] === 'electron') {
    return {
      app: { isPackaged: false, getAppPath: () => process.cwd(), getPath: () => os.tmpdir() }
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

async function run(): Promise<void> {
  const { extractInboundMedia } = await import('@main/channels/whatsapp/messages')
  const { classifyFile } = await import('@main/uploads/uploads')

  type Raw = Parameters<typeof extractInboundMedia>[0]
  const waMsg = (message: Record<string, unknown>, id = 'MSGID1'): Raw =>
    ({ key: { id }, message }) as unknown as Raw

  // 1. PDF with a proper filename — passes through untouched.
  const pdf = extractInboundMedia(
    waMsg({ documentMessage: { fileName: 'report.pdf', mimetype: 'application/pdf' } })
  )
  ok('pdf: kind document', pdf?.kind === 'document')
  ok('pdf: keeps filename', pdf?.fileName === 'report.pdf')
  ok('pdf: mime application/pdf', pdf?.mimeType === 'application/pdf')
  ok('pdf: no caption', pdf?.caption === null)

  // 2. PDF with NO filename — extension synthesized from mimetype (THE blocker:
  // without a .pdf, classifyFile returns other/octet-stream and the PDF is
  // silently dropped before the model ever sees it).
  const pdfNoName = extractInboundMedia(
    waMsg({ documentMessage: { mimetype: 'application/pdf' } }, 'ABC')
  )
  ok(
    'pdf no name: synthesized .pdf',
    pdfNoName?.fileName === 'document_ABC.pdf',
    pdfNoName?.fileName
  )

  // 3. Document filename without extension — .pdf appended from mimetype.
  const noExt = extractInboundMedia(
    waMsg({ documentMessage: { fileName: 'scan', mimetype: 'application/pdf' } })
  )
  ok('doc no ext: extension appended', noExt?.fileName === 'scan.pdf', noExt?.fileName)

  // 3b. Office documents (docx/xlsx/pptx) without an extension — synthesized
  // from the mimetype so they don't reach the model as an opaque blob (the
  // review finding: the extension-less-drop bug otherwise recreated for Office).
  const docxMime = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  const docxNoName = extractInboundMedia(waMsg({ documentMessage: { mimetype: docxMime } }, 'D'))
  ok(
    'docx no name: synthesized .docx',
    docxNoName?.fileName === 'document_D.docx',
    docxNoName?.fileName
  )
  const docxNamed = extractInboundMedia(
    waMsg({ documentMessage: { fileName: 'resume', mimetype: docxMime } })
  )
  ok('docx no ext: .docx appended', docxNamed?.fileName === 'resume.docx', docxNamed?.fileName)
  const pptxMime = 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
  const pptx = extractInboundMedia(
    waMsg({ documentMessage: { fileName: 'deck', mimetype: pptxMime } })
  )
  ok('pptx no ext: .pptx appended', pptx?.fileName === 'deck.pptx', pptx?.fileName)

  // 4. Image with a caption — caption becomes the prompt, name synthesized.
  const img = extractInboundMedia(
    waMsg({ imageMessage: { mimetype: 'image/jpeg', caption: '  look  ' } }, 'IMG')
  )
  ok('image: kind image', img?.kind === 'image')
  ok('image: synthesized name', img?.fileName === 'image_IMG.jpg', img?.fileName)
  ok('image: caption trimmed', img?.caption === 'look')

  // 5. Video.
  const vid = extractInboundMedia(waMsg({ videoMessage: { mimetype: 'video/mp4' } }, 'V'))
  ok('video: name', vid?.kind === 'video' && vid?.fileName === 'video_V.mp4', vid?.fileName)

  // 6. Non-ptt audio (attached file) — attached, not transcribed.
  const audio = extractInboundMedia(waMsg({ audioMessage: { mimetype: 'audio/mpeg' } }, 'A'))
  ok(
    'audio: kind audio',
    audio?.kind === 'audio' && audio?.fileName === 'audio_A.mp3',
    audio?.fileName
  )

  // 7. Voice note (ptt) — NOT media; handled by isInboundVoiceNote/transcribe.
  const voice = extractInboundMedia(
    waMsg({ audioMessage: { mimetype: 'audio/ogg; codecs=opus', ptt: true } })
  )
  ok('voice note: not treated as media', voice === null)

  // 8. Mimetype parameters are stripped, extension derived from the base type.
  const ogg = extractInboundMedia(
    waMsg({ audioMessage: { mimetype: 'audio/ogg; codecs=opus' } }, 'O')
  )
  ok(
    'audio: mime params stripped',
    ogg?.mimeType === 'audio/ogg' && ogg?.fileName === 'audio_O.ogg',
    `${ogg?.mimeType} / ${ogg?.fileName}`
  )

  // 9. Sticker.
  const sticker = extractInboundMedia(waMsg({ stickerMessage: { mimetype: 'image/webp' } }, 'S'))
  ok('sticker: name', sticker?.kind === 'sticker' && sticker?.fileName === 'sticker_S.webp')

  // 10. documentWithCaptionMessage wrapper is unwrapped to the inner document.
  const wrapped = extractInboundMedia(
    waMsg({
      documentWithCaptionMessage: {
        message: {
          documentMessage: { fileName: 'x.pdf', mimetype: 'application/pdf', caption: 'hi' }
        }
      }
    })
  )
  ok('wrapped doc: unwrapped', wrapped?.kind === 'document' && wrapped?.caption === 'hi')

  // 11. fileLength as a Long-like object is normalized to a number.
  const withLen = extractInboundMedia(
    waMsg({
      documentMessage: {
        fileName: 'a.pdf',
        mimetype: 'application/pdf',
        fileLength: { toNumber: () => 4096 }
      }
    })
  )
  ok('fileLength: Long normalized', withLen?.fileLength === 4096, String(withLen?.fileLength))

  // 12. Plain text / location / empty are not downloadable media.
  ok('text: null', extractInboundMedia(waMsg({ conversation: 'hello' })) === null)
  ok(
    'location: null',
    extractInboundMedia(waMsg({ locationMessage: { degreesLatitude: 1, degreesLongitude: 2 } })) ===
      null
  )
  ok('empty: null', extractInboundMedia(waMsg({})) === null)

  // --- classifyFile mime-hint fallback (extension-less inbound media) ---

  // Extension present → classified by extension.
  ok('classify: .pdf by ext', classifyFile('report.pdf').type === 'pdf')
  // No extension + pdf hint → pdf (the fix; else 'other'/octet-stream).
  const cPdf = classifyFile('scan', 'application/pdf')
  ok('classify: extless pdf via hint', cPdf.type === 'pdf' && cPdf.mimeType === 'application/pdf')
  // No extension + image hint → image.
  ok('classify: extless image via hint', classifyFile('blob', 'image/jpeg').type === 'image')
  // No extension, no hint → opaque other (unchanged legacy behavior).
  ok('classify: extless no hint → other', classifyFile('blob').type === 'other')
  // A meaningful extension wins over a conflicting hint.
  ok('classify: ext beats hint', classifyFile('note.txt', 'application/pdf').type === 'other')
  // Extension-less Office doc: type is 'other' but the mimetype is PRESERVED,
  // so the file-processor's DOC_EXT_BY_MIME fallback can still extract text.
  const cDocx = classifyFile('resume', docxMime)
  ok('classify: extless docx preserves mime', cDocx.type === 'other' && cDocx.mimeType === docxMime)
  // And a synthesized-extension docx classifies straight off the extension.
  ok('classify: resume.docx by ext', classifyFile('resume.docx').type === 'other')

  console.log(`\n${passed} passed, ${failed} failed`)
  if (failed > 0) process.exit(1)
}

void run()
