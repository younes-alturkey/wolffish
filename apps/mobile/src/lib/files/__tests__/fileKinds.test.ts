import {
  classifyFile,
  fileExt,
  fileName,
  formatByteProgress,
  formatBytes,
  isPlayable,
  isTextual,
  mimeTypeFor,
  type FileViewerKind
} from '@/lib/files/fileKinds'

/**
 * The dispatch contract. Every row is a file type the desktop app can deliver
 * (send_file) or a user can attach, paired with the viewer mobile must render.
 * The desktop equivalents are named so a future divergence is visible here
 * first: this table IS the port of Chat.tsx's delivered-file branch and
 * AttachmentList.renderViewer.
 */
const MATRIX: Array<[string, FileViewerKind]> = [
  // images — desktop ImageViewer
  ['files/shot.png', 'image'],
  ['files/photo.jpg', 'image'],
  ['files/photo.JPEG', 'image'],
  ['files/loop.gif', 'image'],
  ['files/pic.webp', 'image'],
  ['files/pic.bmp', 'image'],
  ['files/pic.heic', 'image'],
  ['files/pic.avif', 'image'],
  ['files/scan.tiff', 'image'],
  // video — desktop VideoPlayer
  ['files/clip.mp4', 'video'],
  ['files/clip.mov', 'video'],
  ['files/clip.m4v', 'video'],
  ['files/clip.mkv', 'video'],
  ['files/clip.avi', 'video'],
  // audio — desktop AudioPlayer
  ['voice/reply.mp3', 'audio'],
  ['voice/reply.wav', 'audio'],
  ['voice/reply.m4a', 'audio'],
  ['voice/reply.aac', 'audio'],
  ['voice/reply.ogg', 'audio'],
  ['voice/reply.flac', 'audio'],
  ['voice/reply.opus', 'audio'],
  // documents — desktop PdfViewer / SpreadsheetViewer / DocxViewer /
  // PresentationViewer / FileCard
  ['files/report.pdf', 'pdf'],
  ['files/data.csv', 'sheet'],
  ['files/data.tsv', 'sheet'],
  ['files/book.xlsx', 'workbook'],
  ['files/book.xls', 'workbook'],
  ['files/letter.docx', 'document'],
  ['files/deck.pptx', 'slides'],
  // …and the formats no engine in the office bundle reads, which stay file
  // cards that hand the document to an app that can open it.
  ['files/legacy.doc', 'file'],
  ['files/legacy.ppt', 'file'],
  ['files/notes.rtf', 'file'],
  ['files/sheet.ods', 'file'],
  ['files/letter.odt', 'file'],
  ['files/deck.odp', 'file'],
  // text — desktop MarkdownFileViewer
  ['files/README.md', 'markdown'],
  ['files/notes.mdx', 'markdown'],
  ['files/notes.markdown', 'markdown'],
  ['files/notes.txt', 'text'],
  ['files/run.log', 'text'],
  // html — desktop HtmlFileViewer
  ['files/page.html', 'html'],
  ['files/page.htm', 'html'],
  // chart specs — desktop ChartCard; the double extension is the type
  ['files/q3-revenue.chart.json', 'chart'],
  ['files/Q3.CHART.JSON', 'chart'],
  // source — desktop FileCard; mobile renders it as a code card
  ['files/app.ts', 'code'],
  ['files/app.tsx', 'code'],
  ['files/script.py', 'code'],
  ['files/data.json', 'code'],
  ['files/conf.yaml', 'code'],
  ['files/style.css', 'code'],
  ['files/run.sh', 'code'],
  // svg — desktop ImageViewer; mobile too, expo-image decodes it
  ['files/logo.svg', 'image'],
  ['files/LOGO.SVG', 'image'],
  // catch-all — desktop FileCard
  ['files/archive.zip', 'file'],
  ['files/app.dmg', 'file'],
  ['files/data.bin', 'file'],
  ['files/no-extension', 'file']
]

describe('classifyFile', () => {
  it.each(MATRIX)('routes %s to the %s viewer', (path, expected) => {
    expect(classifyFile(path).kind).toBe(expected)
  })

  it('classifies by the name the user sees, absolute or relative', () => {
    expect(classifyFile('/Users/x/.wolffish/workspace/files/a.pdf').kind).toBe('pdf')
    expect(classifyFile('C:\\files\\a.pdf').kind).toBe('pdf')
  })

  it('is case-insensitive about extensions', () => {
    expect(classifyFile('A.PDF').kind).toBe('pdf')
    expect(classifyFile('A.HTML').kind).toBe('html')
  })

  it('keeps plain .json a code card — only .chart.json is a chart', () => {
    expect(classifyFile('files/data.json').kind).toBe('code')
    const chart = classifyFile('files/q3.chart.json')
    expect(chart.kind).toBe('chart')
    // The spec is JSON underneath: the data view labels and shares it as such.
    expect(chart.language).toBe('json')
    expect(chart.mimeType).toBe('application/json')
  })

  describe('ambiguous containers', () => {
    it('treats .webm as video unless the sender declared audio', () => {
      expect(classifyFile('files/clip.webm').kind).toBe('video')
      expect(classifyFile('voice/reply.webm', 'audio').kind).toBe('audio')
      expect(classifyFile('files/clip.webm', 'video').kind).toBe('video')
    })

    it('never lets a declared kind override a decisive extension', () => {
      // A voice tool result declares (audio) but delivers an .mp4 screen
      // recording — the extension is what can actually be played.
      expect(classifyFile('files/clip.mp4', 'audio').kind).toBe('video')
      expect(classifyFile('files/report.pdf', 'image').kind).toBe('pdf')
      expect(classifyFile('files/notes.md', 'file').kind).toBe('markdown')
    })

    it('falls back to the declared kind only when there is no extension', () => {
      expect(classifyFile('files/screenshot', 'image').kind).toBe('image')
      expect(classifyFile('files/recording', 'audio').kind).toBe('audio')
      expect(classifyFile('files/movie', 'video').kind).toBe('video')
      expect(classifyFile('files/doc', 'document').kind).toBe('file')
      expect(classifyFile('files/thing').kind).toBe('file')
    })
  })

  it('carries a language label for source files', () => {
    expect(classifyFile('a.ts').language).toBe('typescript')
    // svg is an image now — it has no source view to label
    expect(classifyFile('a.svg').language).toBeUndefined()
    expect(classifyFile('a.py').language).toBe('python')
    expect(classifyFile('a.html').language).toBe('html')
    expect(classifyFile('a.md').language).toBeUndefined()
  })

  it('never throws on degenerate input', () => {
    for (const input of ['', '.', '..', '/', 'a.', '.gitignore', 'x'.repeat(500)]) {
      expect(() => classifyFile(input)).not.toThrow()
      expect(classifyFile(input).kind).toBeDefined()
    }
  })
})

describe('fileName / fileExt', () => {
  it('takes the last path segment across separators', () => {
    expect(fileName('files/sub/a.png')).toBe('a.png')
    expect(fileName('files\\sub\\a.png')).toBe('a.png')
    expect(fileName('a.png')).toBe('a.png')
    expect(fileName('files/sub/')).toBe('sub')
  })

  it('returns a lowercase extension, or empty when there is none', () => {
    expect(fileExt('a.PNG')).toBe('png')
    expect(fileExt('a.tar.gz')).toBe('gz')
    expect(fileExt('noext')).toBe('')
    expect(fileExt('.gitignore')).toBe('')
    expect(fileExt('trailing.')).toBe('')
  })
})

describe('mimeTypeFor', () => {
  it('maps known types and falls back to octet-stream', () => {
    expect(mimeTypeFor('a.pdf')).toBe('application/pdf')
    expect(mimeTypeFor('a.png')).toBe('image/png')
    expect(mimeTypeFor('a.unknownext')).toBe('application/octet-stream')
  })
})

describe('formatBytes', () => {
  it('scales units and renders nothing for unknown sizes', () => {
    expect(formatBytes(512)).toBe('512 B')
    expect(formatBytes(2048)).toBe('2 KB')
    expect(formatBytes(5 * 1024 * 1024)).toBe('5.0 MB')
    expect(formatBytes(0)).toBe('')
    expect(formatBytes(undefined)).toBe('')
  })
})

describe('formatByteProgress', () => {
  it('renders zero received rather than a blank side', () => {
    expect(formatByteProgress(0, 660 * 1024)).toBe('0 KB / 660 KB')
  })

  it('holds both sides in the total unit while the transfer climbs', () => {
    const total = 5 * 1024 * 1024
    expect(formatByteProgress(512, total)).toBe('0.0 MB / 5.0 MB')
    expect(formatByteProgress(2.5 * 1024 * 1024, total)).toBe('2.5 MB / 5.0 MB')
    expect(formatByteProgress(total, total)).toBe('5.0 MB / 5.0 MB')
  })

  it('never prints past the total', () => {
    expect(formatByteProgress(900, 512)).toBe('512 B / 512 B')
  })

  it('falls back to the plain size when no total is known', () => {
    expect(formatByteProgress(2048, 0)).toBe('2 KB')
    expect(formatByteProgress(0, 0)).toBe('')
  })
})

describe('isTextual', () => {
  it('marks exactly the kinds whose body is read into the card', () => {
    expect(['markdown', 'text', 'code', 'html', 'sheet'].every(isTextual as never)).toBe(true)
    expect(['image', 'video', 'audio', 'pdf', 'file'].some(isTextual as never)).toBe(false)
  })
})

describe('isPlayable', () => {
  it('keeps every format the platform can decode', () => {
    for (const ext of ['mp3', 'm4a', 'wav', 'aac', 'flac']) {
      expect(isPlayable('audio', ext, 'ios')).toBe(true)
      expect(isPlayable('audio', ext, 'android')).toBe(true)
    }
    for (const ext of ['mp4', 'mov', 'm4v']) {
      expect(isPlayable('video', ext, 'ios')).toBe(true)
      expect(isPlayable('video', ext, 'android')).toBe(true)
    }
  })

  it('rejects the containers iOS has no decoder for', () => {
    // WebM (audio + video) and Matroska (mkv) are still undecodable by
    // CoreMedia/AVFoundation on any iOS version, so they stay file cards.
    expect(isPlayable('audio', 'webm', 'ios', '18.4')).toBe(false)
    expect(isPlayable('audio', 'wma', 'ios', '18.4')).toBe(false)
    expect(isPlayable('video', 'webm', 'ios', '18.4')).toBe(false)
    expect(isPlayable('video', 'mkv', 'ios', '18.4')).toBe(false)
  })

  it('plays Ogg audio inline on iOS 18.4+ (native CoreMedia/AVFoundation decode)', () => {
    // iOS 18.4 added Ogg container decode for Opus + Vorbis at the system
    // media level — the same stack expo-audio's AVPlayer wraps.
    for (const ext of ['ogg', 'oga', 'opus']) {
      expect(isPlayable('audio', ext, 'ios', '18.4')).toBe(true)
      expect(isPlayable('audio', ext, 'ios', '18.4.1')).toBe(true)
      expect(isPlayable('audio', ext, 'ios', '19.0')).toBe(true)
    }
  })

  it('keeps the file-card fallback for Ogg on iOS before 18.4', () => {
    // Pre-18.4 devices genuinely cannot decode the Ogg container.
    for (const ext of ['ogg', 'oga', 'opus']) {
      expect(isPlayable('audio', ext, 'ios', '16.4')).toBe(false)
      expect(isPlayable('audio', ext, 'ios', '17.5')).toBe(false)
      expect(isPlayable('audio', ext, 'ios', '18.3')).toBe(false)
      // No version reported → conservative: treat as unplayable.
      expect(isPlayable('audio', ext, 'ios')).toBe(false)
    }
  })

  it('lets Android play what its decoders support but iOS does not', () => {
    expect(isPlayable('audio', 'ogg', 'android')).toBe(true)
    expect(isPlayable('audio', 'opus', 'android')).toBe(true)
    expect(isPlayable('audio', 'webm', 'android')).toBe(true)
    expect(isPlayable('video', 'webm', 'android')).toBe(true)
    expect(isPlayable('video', 'mkv', 'android')).toBe(true)
  })

  it('assumes playable on unknown platforms', () => {
    expect(isPlayable('audio', 'ogg', 'web')).toBe(true)
  })
})
