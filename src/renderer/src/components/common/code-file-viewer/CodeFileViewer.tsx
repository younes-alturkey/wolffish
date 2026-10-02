import { MarkdownContent } from '@components/common/markdown-content/MarkdownContent'
import { CopyButton } from '@components/core/CopyButton'
import { ExpandedSheet } from '@components/core/ExpandedSheet'
import { HtmlPreview, type HtmlPreviewHandle } from '@components/common/html-preview/HtmlPreview'
import { cn } from '@lib/utils/cn'
import { formatBytesL } from '@lib/utils/format'
import hljs from 'highlight.js/lib/common'
import {
  ArrowExpandIcon,
  Bug01Icon,
  CodeIcon,
  Download01Icon,
  EyeIcon,
  File01Icon,
  FolderOpenIcon,
  LinkSquare02Icon,
  RefreshIcon
} from 'hugeicons-react'
import { useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

const EXT_LANG: Record<string, string> = {
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
  html: 'html',
  htm: 'html',
  xml: 'xml',
  svg: 'xml',
  json: 'json',
  yaml: 'yaml',
  yml: 'yaml',
  toml: 'ini',
  sh: 'bash',
  bash: 'bash',
  zsh: 'bash',
  sql: 'sql',
  graphql: 'graphql',
  md: 'markdown',
  mdx: 'markdown',
  txt: 'plaintext',
  php: 'php',
  lua: 'lua',
  r: 'r',
  pl: 'perl',
  dart: 'dart',
  scala: 'scala',
  groovy: 'groovy',
  proto: 'protobuf'
}

function langHintFromExt(ext: string): string | undefined {
  return EXT_LANG[ext]
}

export function CodeFileViewer({
  content,
  fileName,
  language,
  sizeBytes,
  htmlPreview = false,
  previewUrl,
  sourceUnavailable = false,
  onDownload,
  onReveal,
  onOpenExternal
}: {
  content: string
  fileName: string
  language?: string
  /** When set, shown next to the language label in the footer. */
  sizeBytes?: number
  /**
   * HTML files only. When true, the card and the expanded sheet gain a
   * Preview⇄Source toggle: Preview renders the page live in a <webview>
   * guest loaded from `previewUrl` (scripts, canvas, keyboard, audio — a
   * browser tab), Source shows the highlighted markup.
   */
  htmlPreview?: boolean
  /** file: URL the live preview loads. Required for the preview to render. */
  previewUrl?: string
  /**
   * The file was too large to read into the renderer: `content` is empty and
   * the Source view says so instead of showing an empty listing. The live
   * preview is unaffected — the guest streams the file itself.
   */
  sourceUnavailable?: boolean
  /** When set, a download button appears in the footer (attachment cards). */
  onDownload?: () => void
  /** When set, a "reveal in folder" button appears in the footer (attachment cards). */
  onReveal?: () => void
  /**
   * When set, an "open externally" button appears — for HTML cards this hands
   * the file to the OS, which opens it in the default browser.
   */
  onOpenExternal?: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const [sheetOpen, setSheetOpen] = useState(false)
  // HTML preview⇄source view, shared by the inline card and the expanded sheet
  // so toggling one keeps the other in step. 'preview' renders the page live
  // (<webview> guest), 'source' shows the highlighted body. Defaults to
  // preview — the rendered page is the whole point of an HTML file. Only used
  // when htmlPreview is set (HTML files); other code/markdown files ignore it.
  const [view, setView] = useState<'preview' | 'source'>('preview')
  // One live guest at a time: while the sheet is open the inline card shows a
  // placeholder instead of a second copy of the page (a game running twice).
  const previewRef = useRef<HtmlPreviewHandle>(null)
  const livePreview = htmlPreview && view === 'preview' && !!previewUrl

  const ext = fileName.split('.').pop()?.toLowerCase() ?? ''
  const lang = language ?? langHintFromExt(ext)
  // Markdown files (README and friends) render as rich markdown instead of
  // line-numbered source — same renderer the chat bubbles use.
  const isMarkdown = lang === 'markdown'

  const highlighted = useMemo(() => {
    if (isMarkdown) return null
    try {
      const result =
        lang && hljs.getLanguage(lang)
          ? hljs.highlight(content, { language: lang, ignoreIllegals: true })
          : hljs.highlightAuto(content)
      return result.value || null
    } catch {
      return null
    }
  }, [content, lang, isMarkdown])

  const lines = content.split('\n')
  const lineCount = lines.length
  const gutterWidth = String(lineCount).length

  // The rendered body — markdown as rich text, everything else as
  // line-numbered source. Shared verbatim between the inline card (clamped to
  // a max height) and the full-size expanded sheet.
  const body = sourceUnavailable ? (
    <div className="text-muted px-3 py-6 text-center text-xs">
      {t('chat.htmlViewer.sourceTooLarge')}
    </div>
  ) : isMarkdown ? (
    <MarkdownContent content={content} />
  ) : (
    <div className="flex min-w-max">
      <pre
        dir="ltr"
        aria-hidden
        className="bg-bg/50 border-border sticky left-0 z-1 shrink-0 border-e py-2 text-right font-mono text-[11px] leading-5 select-none"
      >
        {lines.map((_, i) => (
          <div key={i} className="text-muted/60 px-2" style={{ minWidth: `${gutterWidth + 2}ch` }}>
            {i + 1}
          </div>
        ))}
      </pre>
      {highlighted ? (
        <pre
          dir="ltr"
          className="hljs flex-1 py-2 pe-3 ps-3 font-mono text-xs leading-5"
          dangerouslySetInnerHTML={{ __html: highlighted }}
        />
      ) : (
        <pre dir="ltr" className="text-fg flex-1 py-2 pe-3 ps-3 font-mono text-xs leading-5">
          {content}
        </pre>
      )}
    </div>
  )

  // Live preview: a <webview> guest loading the file from disk. The inline
  // card shrinks a too-wide page to fit; the sheet shows it at 1×. Only one
  // is mounted at a time (see livePreview), so a single ref serves both.
  const inlinePreview = livePreview ? (
    sheetOpen ? (
      <div className="text-muted flex h-full items-center justify-center text-xs">
        {t('chat.htmlViewer.openInSheet')}
      </div>
    ) : (
      <HtmlPreview ref={previewRef} src={previewUrl} fit />
    )
  ) : null
  const sheetPreview = livePreview ? <HtmlPreview ref={previewRef} src={previewUrl} /> : null

  // Individual action controls, composed in opposite orders per surface.
  const iconButton =
    'text-muted hover:text-fg flex shrink-0 cursor-pointer items-center justify-center rounded p-1 focus-visible:ring-2 focus-visible:ring-accent'

  // Expand opens the sheet — footer only (meaningless inside the already-
  // expanded sheet).
  const expandButton = (
    <button
      type="button"
      onClick={() => setSheetOpen(true)}
      title={t('chat.fileCard.expand')}
      aria-label={t('chat.fileCard.expand')}
      className={cn(iconButton)}
    >
      <ArrowExpandIcon size={14} />
    </button>
  )
  // HTML only: a compact eye⇄code toggle for the card footer that mirrors the
  // expanded sheet's Preview/Source control. Shows the icon of the view it will
  // switch TO (code when previewing, eye when viewing source).
  const previewToggleButton = htmlPreview ? (
    <button
      type="button"
      onClick={() => setView((v) => (v === 'preview' ? 'source' : 'preview'))}
      title={t(`chat.htmlViewer.${view === 'preview' ? 'source' : 'preview'}`)}
      aria-label={t(`chat.htmlViewer.${view === 'preview' ? 'source' : 'preview'}`)}
      aria-pressed={view === 'preview'}
      className={cn(iconButton)}
    >
      {view === 'preview' ? <CodeIcon size={14} /> : <EyeIcon size={14} />}
    </button>
  ) : null
  // Preview only: reload the page (a game back to its start screen) and open
  // the guest's own DevTools — the two things a browser tab gives that a card
  // otherwise wouldn't.
  const reloadButton = livePreview ? (
    <button
      type="button"
      onClick={() => previewRef.current?.reload()}
      title={t('chat.htmlViewer.reload')}
      aria-label={t('chat.htmlViewer.reload')}
      className={cn(iconButton)}
    >
      <RefreshIcon size={14} />
    </button>
  ) : null
  const devToolsButton = livePreview ? (
    <button
      type="button"
      onClick={() => previewRef.current?.openDevTools()}
      title={t('chat.htmlViewer.devTools')}
      aria-label={t('chat.htmlViewer.devTools')}
      className={cn(iconButton)}
    >
      <Bug01Icon size={14} />
    </button>
  ) : null
  // Website cards drop copy: what the card shows is a rendered page, not source
  // worth putting on the clipboard — open/download/reveal cover what's useful.
  const copyButton =
    htmlPreview || sourceUnavailable ? null : (
      <CopyButton
        text={content}
        variant="inline"
        ariaLabelKey="chat.copy"
        className="text-muted hover:text-fg"
      />
    )
  // Hands the file to the OS. For an .html file that means the default browser
  // — the same live page in a full window.
  const openExternalButton = onOpenExternal ? (
    <button
      type="button"
      onClick={onOpenExternal}
      title={t(htmlPreview ? 'chat.htmlViewer.openInBrowser' : 'chat.pdfViewer.openExternal')}
      aria-label={t(htmlPreview ? 'chat.htmlViewer.openInBrowser' : 'chat.pdfViewer.openExternal')}
      className={cn(iconButton)}
    >
      <LinkSquare02Icon size={14} />
    </button>
  ) : null
  const downloadButton = onDownload ? (
    <button
      type="button"
      onClick={onDownload}
      title={t('chat.fileCard.download')}
      className={cn(iconButton)}
    >
      <Download01Icon size={14} />
    </button>
  ) : null
  const revealButton = onReveal ? (
    <button
      type="button"
      onClick={onReveal}
      title={t('chat.fileCard.reveal')}
      className={cn(iconButton)}
    >
      <FolderOpenIcon size={14} />
    </button>
  ) : null

  // Expanded sheet header: copy · download · reveal · open externally (close is
  // appended by ExpandedSheet). The card footer renders the same controls
  // mirrored — open externally · reveal · download · copy · expand — so the row
  // reads identically from the card's trailing edge.
  // For HTML, the sheet leads with a Source⇄Preview toggle so the user can
  // flip between the rendered page and the highlighted markup.
  const sheetViewToggle = htmlPreview ? (
    <div className="border-border bg-bg/40 inline-flex shrink-0 items-center rounded-lg border p-0.5">
      {(['preview', 'source'] as const).map((v) => (
        <button
          key={v}
          type="button"
          onClick={() => setView(v)}
          aria-pressed={view === v}
          className={cn(
            'rounded-md px-2 py-0.5 text-[11px] font-medium',
            view === v
              ? 'bg-primary text-primary-fg shadow-sm'
              : 'text-muted hover:text-fg cursor-pointer'
          )}
        >
          {t(`chat.htmlViewer.${v}`)}
        </button>
      ))}
    </div>
  ) : null

  const sheetActions = (
    <>
      {sheetViewToggle}
      {reloadButton}
      {devToolsButton}
      {copyButton}
      {downloadButton}
      {revealButton}
      {openExternalButton}
    </>
  )

  return (
    <div
      className={cn(
        'border-border bg-surface flex w-full max-w-[85%] flex-col self-start',
        'overflow-hidden rounded-2xl border'
      )}
    >
      <div className="flex w-full items-center gap-2 px-3 py-2">
        {isMarkdown ? (
          <File01Icon size={14} className="text-muted shrink-0" />
        ) : (
          <CodeIcon size={14} className="text-muted shrink-0" />
        )}
        <span className="text-fg truncate text-xs font-medium" title={fileName}>
          {fileName}
        </span>
        {!sourceUnavailable && (
          <span className="text-muted shrink-0 text-[10px]">
            {lineCount} {lineCount === 1 ? 'line' : 'lines'}
          </span>
        )}
      </div>

      <div className={livePreview ? 'h-80 overflow-hidden' : 'max-h-80 overflow-auto'}>
        {livePreview ? inlinePreview : body}
      </div>

      <div className="border-border flex items-center gap-2 border-t px-3 py-1.5">
        <span className="text-muted min-w-0 flex-1 truncate text-[10px]">
          {lang ?? ext}
          {sizeBytes != null ? ` · ${formatBytesL(sizeBytes, t)}` : ''}
        </span>
        {previewToggleButton}
        {devToolsButton}
        {reloadButton}
        {openExternalButton}
        {revealButton}
        {downloadButton}
        {copyButton}
        {expandButton}
      </div>

      <ExpandedSheet
        open={sheetOpen}
        onClose={() => setSheetOpen(false)}
        title={fileName}
        actions={sheetActions}
      >
        {livePreview ? sheetPreview : body}
      </ExpandedSheet>
    </div>
  )
}
