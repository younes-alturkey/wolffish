/**
 * File-type classification — the single oracle deciding which viewer renders a
 * delivered file or an attachment. Mirrors the desktop dispatch (Chat.tsx
 * delivered-file branch + AttachmentList.renderViewer):
 *
 *   image (incl. svg)        → ImageViewer          (mobile: inline + lightbox)
 *   audio / video            → Audio/VideoPlayer    (mobile: same)
 *   pdf                      → PdfViewer            (mobile: WebView preview)
 *   docx                     → DocxViewer           (mobile: OfficeFileCard)
 *   pptx                     → PresentationViewer   (mobile: OfficeFileCard)
 *   xlsx / xls               → SpreadsheetViewer    (mobile: OfficeFileCard)
 *   csv / tsv                → SpreadsheetViewer    (mobile: native table)
 *   md / mdx / markdown, txt → MarkdownFileViewer   (mobile: same, expandable)
 *   html / htm               → HtmlFileViewer       (mobile: WebView + source)
 *   anything else            → FileCard
 *
 * Two mobile-only widenings, both strictly better than a dead card: source
 * files (.ts/.py/.json/…) render as a code card instead of a bare FileCard,
 * and .tsv joins .csv as a table. An .svg is just an image here — expo-image
 * decodes it (SDWebImageSVGCoder on iOS), so a delivered logo gets the same
 * thumbnail, lightbox and share as a .png rather than a card of its own.
 *
 * Extension decides, because that is what the desktop keys off. A declared
 * kind (attachment `type`, or the `[wolffish-output: … (kind)]` marker) only
 * breaks ties for extensions that are genuinely ambiguous (.webm is audio or
 * video) or absent (extension-less delivered files).
 */

export type FileViewerKind =
  | 'image'
  | 'video'
  | 'audio'
  | 'pdf'
  | 'markdown'
  | 'text'
  | 'code'
  | 'html'
  | 'sheet'
  | 'document'
  | 'workbook'
  | 'slides'
  | 'chart'
  | 'file'

/** What the sender said it is: attachment.type, or the output marker's kind. */
export type DeclaredFileKind =
  'image' | 'audio' | 'video' | 'pdf' | 'document' | 'file' | 'chart' | 'other' | undefined

const IMAGE_EXTS = new Set([
  'png',
  'jpg',
  'jpeg',
  'gif',
  'webp',
  'bmp',
  'heic',
  'heif',
  'avif',
  'tif',
  'tiff',
  'ico',
  'svg'
])

const VIDEO_EXTS = new Set(['mp4', 'mov', 'm4v', 'mkv', 'avi', '3gp', 'mpg', 'mpeg'])

const AUDIO_EXTS = new Set([
  'mp3',
  'wav',
  'm4a',
  'aac',
  'ogg',
  'oga',
  'flac',
  'opus',
  'amr',
  'wma',
  'aiff',
  'caf'
])

const MARKDOWN_EXTS = new Set(['md', 'mdx', 'markdown'])
const TEXT_EXTS = new Set(['txt', 'log', 'text'])
const HTML_EXTS = new Set(['html', 'htm'])
const SHEET_EXTS = new Set(['csv', 'tsv'])

/** Extension → highlight-ish language label, mirroring the desktop EXT_LANG. */
const CODE_LANGS: Record<string, string> = {
  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  ts: 'typescript',
  tsx: 'typescript',
  vue: 'xml',
  svelte: 'xml',
  py: 'python',
  rb: 'ruby',
  rs: 'rust',
  go: 'go',
  java: 'java',
  kt: 'kotlin',
  swift: 'swift',
  c: 'c',
  cpp: 'cpp',
  h: 'c',
  hpp: 'cpp',
  cs: 'csharp',
  css: 'css',
  scss: 'scss',
  less: 'less',
  xml: 'xml',
  json: 'json',
  jsonl: 'json',
  yaml: 'yaml',
  yml: 'yaml',
  toml: 'ini',
  ini: 'ini',
  env: 'ini',
  sh: 'bash',
  bash: 'bash',
  zsh: 'bash',
  sql: 'sql',
  graphql: 'graphql',
  php: 'php',
  lua: 'lua',
  r: 'r',
  pl: 'perl',
  dart: 'dart',
  scala: 'scala',
  groovy: 'groovy',
  proto: 'protobuf',
  patch: 'diff',
  diff: 'diff'
}

/**
 * Formats the office card renders inline (lib/office/html), one kind per
 * engine. `.xls` joins the workbooks because SheetJS reads the legacy binary
 * format too — the full build, not the mini one, which is why the bundle takes
 * the larger of the two. What is deliberately absent is everything no engine
 * reads: legacy binary .doc and .ppt, and OpenDocument .odt/.ods/.odp/.rtf.
 * Those stay file cards that hand the document to an app that can open it —
 * which on iOS means the system viewer, the one place it renders them.
 */
const DOCUMENT_EXTS = new Set(['docx'])
const WORKBOOK_EXTS = new Set(['xlsx', 'xls'])
const SLIDES_EXTS = new Set(['pptx'])

/** Office formats mobile hands to the system viewer rather than rendering. */
const OFFICE_EXTS = new Set(['doc', 'rtf', 'odt', 'ods', 'ppt', 'odp'])

const MIME_BY_EXT: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  heic: 'image/heic',
  mp4: 'video/mp4',
  mov: 'video/quicktime',
  webm: 'video/webm',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  m4a: 'audio/mp4',
  ogg: 'audio/ogg',
  flac: 'audio/flac',
  pdf: 'application/pdf',
  csv: 'text/csv',
  tsv: 'text/tab-separated-values',
  html: 'text/html',
  htm: 'text/html',
  md: 'text/markdown',
  txt: 'text/plain',
  json: 'application/json',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  // The legacy trio never renders inline, but the share sheet still offers a
  // better "open in…" list when the file goes out with its real type.
  doc: 'application/msword',
  xls: 'application/vnd.ms-excel',
  ppt: 'application/vnd.ms-powerpoint',
  zip: 'application/zip'
}

/** Last path segment, tolerating both separators and trailing slashes. */
export function fileName(pathOrName: string): string {
  const cleaned = pathOrName.trim().replace(/[/\\]+$/, '')
  const cut = Math.max(cleaned.lastIndexOf('/'), cleaned.lastIndexOf('\\'))
  const name = cut >= 0 ? cleaned.slice(cut + 1) : cleaned
  return name || pathOrName
}

/** Lowercase extension without the dot; '' when the name has none. */
export function fileExt(pathOrName: string): string {
  const name = fileName(pathOrName)
  const dot = name.lastIndexOf('.')
  if (dot <= 0 || dot === name.length - 1) return ''
  return name.slice(dot + 1).toLowerCase()
}

export function mimeTypeFor(pathOrName: string): string {
  return MIME_BY_EXT[fileExt(pathOrName)] ?? 'application/octet-stream'
}

export function formatBytes(bytes: number | undefined | null): string {
  if (!bytes || bytes <= 0) return ''
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`
}

/**
 * A transfer's counter — "0 KB / 645 KB" — for a bar that knows its total.
 *
 * NOT `formatBytes(a) / formatBytes(b)`, for two reasons. Zero bytes render as
 * an empty string there, which is right for a file card whose size is unknown
 * and wrong here: the first frame of every download would read " / 645 KB"
 * until the first chunk landed. And a received side free to pick its own unit
 * climbs "512 B → 45 KB → 1.2 MB" against a fixed total, which reads as churn
 * rather than progress — so both sides are rendered in the TOTAL's unit.
 *
 * Received is clamped to the total, matching the bar the count sits above: a
 * final chunk that overshoots a stale stat should not print past 100%.
 */
export function formatByteProgress(received: number, total: number): string {
  if (!(total > 0)) return formatBytes(received)
  const scale =
    total < 1024
      ? { divisor: 1, suffix: 'B', digits: 0 }
      : total < 1024 * 1024
        ? { divisor: 1024, suffix: 'KB', digits: 0 }
        : total < 1024 * 1024 * 1024
          ? { divisor: 1024 * 1024, suffix: 'MB', digits: 1 }
          : { divisor: 1024 * 1024 * 1024, suffix: 'GB', digits: 2 }
  const at = (bytes: number): string =>
    `${(Math.min(Math.max(bytes, 0), total) / scale.divisor).toFixed(scale.digits)} ${scale.suffix}`
  return `${at(received)} / ${at(total)}`
}

export type FileClassification = {
  kind: FileViewerKind
  ext: string
  name: string
  /** Set for `code` (and `html`) — the label shown in the card footer. */
  language?: string
  mimeType: string
}

/**
 * Classify a delivered file or attachment. Total: any input yields a
 * classification, falling back to the generic file card.
 */
export function classifyFile(pathOrName: string, declared?: DeclaredFileKind): FileClassification {
  const name = fileName(pathOrName)
  const ext = fileExt(name)
  const mimeType = mimeTypeFor(name)
  const base = { ext, name, mimeType }

  // `.chart.json` is its own type — an agent-authored chart spec rendered by
  // the interactive chart card, exactly the desktop's dispatch (its marker
  // kind is `chart`, and its bucket keys off the same double extension). The
  // check needs the full name: by single extension it is just a .json.
  if (name.toLowerCase().endsWith('.chart.json')) {
    return { ...base, kind: 'chart', language: 'json' }
  }

  // .webm (and .ogg containers) are audio or video depending on what was
  // encoded — only the sender knows. Voice replies declare 'audio'.
  if (ext === 'webm' || ext === 'ogv') {
    return { ...base, kind: declared === 'audio' ? 'audio' : 'video' }
  }

  if (IMAGE_EXTS.has(ext)) return { ...base, kind: 'image' }
  if (VIDEO_EXTS.has(ext)) return { ...base, kind: 'video' }
  if (AUDIO_EXTS.has(ext)) return { ...base, kind: 'audio' }
  if (ext === 'pdf') return { ...base, kind: 'pdf' }
  if (HTML_EXTS.has(ext)) return { ...base, kind: 'html', language: 'html' }
  if (MARKDOWN_EXTS.has(ext)) return { ...base, kind: 'markdown' }
  if (TEXT_EXTS.has(ext)) return { ...base, kind: 'text' }
  if (SHEET_EXTS.has(ext)) return { ...base, kind: 'sheet' }
  if (DOCUMENT_EXTS.has(ext)) return { ...base, kind: 'document' }
  if (WORKBOOK_EXTS.has(ext)) return { ...base, kind: 'workbook' }
  if (SLIDES_EXTS.has(ext)) return { ...base, kind: 'slides' }
  if (OFFICE_EXTS.has(ext)) return { ...base, kind: 'file' }
  if (CODE_LANGS[ext]) return { ...base, kind: 'code', language: CODE_LANGS[ext] }

  // No usable extension — fall back to what the sender declared.
  if (!ext || ext.length > 5) {
    if (declared === 'image') return { ...base, kind: 'image' }
    if (declared === 'audio') return { ...base, kind: 'audio' }
    if (declared === 'video') return { ...base, kind: 'video' }
    if (declared === 'pdf') return { ...base, kind: 'pdf' }
  }

  return { ...base, kind: 'file' }
}

/**
 * Containers the platform's own decoders cannot play. The desktop renders
 * these fine (Chromium ships its own codecs), so this is the one place mobile
 * genuinely can't match it — a card that hands the file to an app that can
 * play it beats a transport stuck at 0:00. Deliberately conservative: only
 * formats known to be unsupported are listed, and video has a second, runtime
 * guard (the player's own error status) for anything missed here.
 *
 * Ogg audio is deliberately ABSENT from the iOS audio set: iOS 18.4 added
 * native Ogg (Vorbis + Opus) decode to CoreMedia/AVFoundation, so it no longer
 * belongs here. `isPlayable` gates it on the OS version instead, because the
 * app still runs on iOS 16.4 where a genuine dead transport exists.
 */
const UNPLAYABLE = {
  ios: {
    audio: new Set(['webm', 'wma']),
    video: new Set(['webm', 'mkv', 'avi', 'wmv', 'flv', 'ogv'])
  },
  android: {
    audio: new Set(['wma']),
    video: new Set(['avi', 'wmv', 'flv'])
  }
} as const

export function isPlayable(
  kind: 'audio' | 'video',
  ext: string,
  os: string,
  osVersion?: string | number
): boolean {
  // Ogg audio (Vorbis + Opus) is the one format whose iOS support arrived in a
  // point release: iOS 18.4 added native Ogg container decode to
  // CoreMedia/AVFoundation — the stack expo-audio's AVPlayer wraps — so it now
  // plays inline exactly like mp3. The app still targets iOS 16.4, so older
  // devices keep the file-card fallback (a transport stuck at 0:00 there).
  if (os === 'ios' && kind === 'audio' && (ext === 'ogg' || ext === 'oga' || ext === 'opus')) {
    return iosVersionAtLeast(osVersion, 18, 4)
  }

  const table = os === 'ios' ? UNPLAYABLE.ios : os === 'android' ? UNPLAYABLE.android : null
  if (!table) return true
  return !table[kind].has(ext)
}

/** iOS `Platform.Version` is a dotted string ("18.4.1"); Android passes a number. */
function iosVersionAtLeast(
  version: string | number | undefined,
  minMajor: number,
  minMinor: number
): boolean {
  if (version == null) return false
  const parts = String(version).split('.')
  const major = Number.parseInt(parts[0] ?? '', 10)
  const minor = Number.parseInt(parts[1] ?? '', 10)
  const mj = Number.isNaN(major) ? 0 : major
  const mn = Number.isNaN(minor) ? 0 : minor
  return mj > minMajor || (mj === minMajor && mn >= minMinor)
}

/** Text-ish kinds whose bodies are read into the card. */
export function isTextual(kind: FileViewerKind): boolean {
  return (
    kind === 'markdown' || kind === 'text' || kind === 'code' || kind === 'html' || kind === 'sheet'
  )
}
