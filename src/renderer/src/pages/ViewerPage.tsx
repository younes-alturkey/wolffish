import { Badge } from '@components/core/Badge'
import { CodeEditor, type CodeLanguage } from '@components/core/CodeEditor'
import { CopyButton } from '@components/core/CopyButton'
import { Markdown } from '@components/core/Markdown'
import { ImageLightbox } from '@components/common/image-viewer/ImageViewer'
import { SheetGrid } from '@components/common/spreadsheet-viewer/SheetGrid'
import { useToast } from '@components/core/toast/useToast'
import { RTL_LOCALES } from '@lib/i18n'
import { cn } from '@lib/utils/cn'
import { pageTopPadding } from '@lib/utils/platform'
import type { ViewerTreeNode } from '@preload/index'
import { useFlow } from '@providers/flow/useFlow'
import { useLocale } from '@providers/locale/useLocale'
import { useTheme } from '@providers/theme/useTheme'
import { readWorkbook } from '@lib/spreadsheet/workbook'
import type { WorkbookModel } from '@lib/spreadsheet/types'
import mammoth from 'mammoth'
import {
  ArrowDown01Icon,
  ArrowLeft02Icon,
  ArrowRight01Icon,
  ArrowRight02Icon,
  DashboardSpeed01Icon,
  Download01Icon,
  File01Icon,
  File02Icon,
  FloppyDiskIcon,
  Folder01Icon,
  FolderOpenIcon,
  Image02Icon,
  PauseIcon,
  Pdf02Icon,
  PlayIcon,
  Refresh01Icon,
  VideoOffIcon,
  VolumeMute02Icon
} from 'hugeicons-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

type ViewMode = 'edit' | 'preview'
type MediaType = 'image' | 'video' | 'audio' | 'pdf' | 'docx' | 'spreadsheet'

function isReadOnlyPath(relativePath: string): boolean {
  if (relativePath.startsWith('logs/')) return true
  if (relativePath.endsWith('.log.md')) return true
  if (relativePath.startsWith('brain/conversations/')) return true
  if (relativePath.startsWith('brain/hippocampus/episodes/')) return true
  if (relativePath.startsWith('brain/motor/tasks/')) return true
  if (relativePath.startsWith('brain/prefrontal/.debug/')) return true
  if (relativePath === 'brain/prefrontal/agents.core.md') return true
  if (relativePath === 'brain/brainstem/heartbeat.md') return true
  if (relativePath.startsWith('brain/basalganglia/')) return true
  const cereMatch = relativePath.match(/^brain\/cerebellum\/([^/]+)/)
  if (cereMatch && cereMatch[1].startsWith('.')) return true
  if (relativePath.startsWith('screenshots/')) return true
  if (relativePath.startsWith('speech/')) return true
  if (relativePath.startsWith('voice/')) return true
  if (relativePath.startsWith('files/')) return true
  return false
}

function prettyJson(content: string): string {
  try {
    return JSON.stringify(JSON.parse(content), null, 2)
  } catch {
    return content
  }
}

function languageFor(name: string): CodeLanguage | null {
  if (name.endsWith('.json')) return 'json'
  if (name.endsWith('.md') || name.endsWith('.mdx')) return 'markdown'
  if (
    name.endsWith('.js') ||
    name.endsWith('.mjs') ||
    name.endsWith('.cjs') ||
    name.endsWith('.jsx')
  )
    return 'javascript'
  if (
    name.endsWith('.ts') ||
    name.endsWith('.tsx') ||
    name.endsWith('.mts') ||
    name.endsWith('.cts')
  )
    return 'typescript'
  if (name.endsWith('.txt') || name.endsWith('.log')) return 'markdown'
  if (name.endsWith('.css') || name.endsWith('.scss') || name.endsWith('.less')) return 'css'
  if (name.endsWith('.html') || name.endsWith('.htm')) return 'html'
  if (name.endsWith('.xml') || name.endsWith('.svg')) return 'xml'
  if (name.endsWith('.yaml') || name.endsWith('.yml')) return 'yaml'
  if (name.endsWith('.sh') || name.endsWith('.bash') || name.endsWith('.zsh')) return 'shell'
  if (name.endsWith('.py')) return 'python'
  if (name.endsWith('.sql')) return 'sql'
  if (name.endsWith('.graphql') || name.endsWith('.gql')) return 'graphql'
  return null
}

const MEDIA_EXTENSIONS: Record<string, MediaType> = {
  png: 'image',
  jpg: 'image',
  jpeg: 'image',
  gif: 'image',
  webp: 'image',
  svg: 'image',
  bmp: 'image',
  ico: 'image',
  heic: 'image',
  mp4: 'video',
  // webm → audio: wolffish's webm files are voice/TTS clips, shown with the
  // audio player (consistent with the chat + upload classifiers).
  webm: 'audio',
  mov: 'video',
  avi: 'video',
  mkv: 'video',
  mp3: 'audio',
  wav: 'audio',
  ogg: 'audio',
  aac: 'audio',
  m4a: 'audio',
  flac: 'audio',
  pdf: 'pdf',
  docx: 'docx',
  xls: 'spreadsheet',
  xlsx: 'spreadsheet',
  csv: 'spreadsheet'
}

const MIME_MAP: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
  heic: 'image/heic',
  mp4: 'video/mp4',
  webm: 'video/webm',
  mov: 'video/quicktime',
  avi: 'video/x-msvideo',
  mkv: 'video/x-matroska',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  aac: 'audio/aac',
  m4a: 'audio/mp4',
  flac: 'audio/flac',
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  csv: 'text/csv'
}

function detectMediaType(name: string): MediaType | null {
  const ext = name.split('.').pop()?.toLowerCase()
  if (!ext) return null
  return MEDIA_EXTENSIONS[ext] ?? null
}

function mimeFor(name: string): string {
  const ext = name.split('.').pop()?.toLowerCase()
  return MIME_MAP[ext ?? ''] ?? 'application/octet-stream'
}

function stripHtmlComments(content: string): string {
  return content.replace(/<!--[\s\S]*?-->/g, '')
}

function splitFilename(name: string): { stem: string; ext: string } {
  if (name.endsWith('.log.md')) return { stem: name.slice(0, -'.log.md'.length), ext: '.log.md' }
  const lastDot = name.lastIndexOf('.')
  if (lastDot <= 0) return { stem: name, ext: '' }
  return { stem: name.slice(0, lastDot), ext: name.slice(lastDot) }
}

const FROM_NOW_RANGES: ReadonlyArray<readonly [Intl.RelativeTimeFormatUnit, number]> = [
  ['year', 60 * 60 * 24 * 365],
  ['month', 60 * 60 * 24 * 30],
  ['week', 60 * 60 * 24 * 7],
  ['day', 60 * 60 * 24],
  ['hour', 60 * 60],
  ['minute', 60]
]

function formatFromNow(mtimeMs: number, now: number, locale: string): string {
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' })
  const diff = Math.max(0, (now - mtimeMs) / 1000)
  for (const [unit, seconds] of FROM_NOW_RANGES) {
    if (diff >= seconds) return rtf.format(-Math.floor(diff / seconds), unit)
  }
  return rtf.format(-Math.floor(diff), 'second')
}

function useViewerBlob(
  relativePath: string | null,
  mimeType: string
): { url: string | null; error: boolean } {
  const [state, setState] = useState<{ url: string | null; error: boolean; path: string | null }>({
    url: null,
    error: false,
    path: null
  })

  useEffect(() => {
    if (!relativePath) return

    let cancelled = false
    let revoke: string | null = null

    void (async () => {
      try {
        const buffer: ArrayBuffer = await window.api.viewer.readBinaryFile(relativePath)
        if (cancelled) return
        const blob = new Blob([buffer], { type: mimeType })
        const objectUrl = URL.createObjectURL(blob)
        revoke = objectUrl
        setState({ url: objectUrl, error: false, path: relativePath })
      } catch {
        if (!cancelled) setState({ url: null, error: true, path: relativePath })
      }
    })()

    return () => {
      cancelled = true
      if (revoke) URL.revokeObjectURL(revoke)
    }
  }, [relativePath, mimeType])

  if (!relativePath) return { url: null, error: false }
  if (state.path !== relativePath) return { url: null, error: false }
  return { url: state.url, error: state.error }
}

export function ViewerPage(): React.JSX.Element {
  const { t } = useTranslation()
  const { isDark } = useTheme()
  const { locale } = useLocale()
  const { goTo } = useFlow()
  const toast = useToast()
  const isRtl = RTL_LOCALES.has(locale)
  const BackIcon = isRtl ? ArrowRight02Icon : ArrowLeft02Icon

  const [tree, setTree] = useState<ViewerTreeNode[] | null>(null)
  const [loadingTree, setLoadingTree] = useState(true)
  const [treeError, setTreeError] = useState<string | null>(null)
  const [resyncing, setResyncing] = useState(false)

  const [selectedPath, setSelectedPath] = useState<string | null>(null)
  const [originalContent, setOriginalContent] = useState<string>('')
  const [editorContent, setEditorContent] = useState<string>('')
  const [fileError, setFileError] = useState<string | null>(null)
  const [mtimeMs, setMtimeMs] = useState<number | null>(null)

  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 60_000)
    return () => clearInterval(id)
  }, [])

  const [saving, setSaving] = useState(false)
  const [viewMode, setViewMode] = useState<ViewMode>('edit')

  const loadCounter = useRef(0)

  useEffect(() => {
    let cancelled = false
    window.api.viewer
      .readTree()
      .then((next) => {
        if (cancelled) return
        setTree(next)
        setLoadingTree(false)
      })
      .catch((err: unknown) => {
        if (cancelled) return
        const message = err instanceof Error ? err.message : String(err)
        setTreeError(message)
        setTree([])
        setLoadingTree(false)
      })
    return () => {
      cancelled = true
    }
  }, [])

  const loadFile = useCallback(async (relativePath: string): Promise<void> => {
    const id = ++loadCounter.current
    try {
      const isMedia = detectMediaType(relativePath) !== null
      const [content, statInfo] = await Promise.all([
        isMedia ? Promise.resolve('') : window.api.viewer.readFile(relativePath),
        window.api.viewer.stat(relativePath)
      ])
      if (loadCounter.current !== id) return
      setFileError(null)
      setSelectedPath(relativePath)
      setOriginalContent(content)
      setEditorContent(content)
      setMtimeMs(statInfo.mtimeMs)
      setViewMode(isMedia || isReadOnlyPath(relativePath) ? 'preview' : 'edit')
    } catch (err) {
      if (loadCounter.current !== id) return
      const message = err instanceof Error ? err.message : String(err)
      setFileError(message)
      setSelectedPath(relativePath)
      setOriginalContent('')
      setEditorContent('')
      setMtimeMs(null)
    }
  }, [])

  const handleSelectFile = useCallback(
    (relativePath: string) => {
      if (relativePath === selectedPath) return
      void loadFile(relativePath)
    },
    [loadFile, selectedPath]
  )

  const handleSave = useCallback(async (): Promise<void> => {
    if (!selectedPath || saving) return
    setSaving(true)
    try {
      await window.api.viewer.writeFile(selectedPath, editorContent)
      setOriginalContent(editorContent)
      setMtimeMs(Date.now())
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      setFileError(message)
    } finally {
      setSaving(false)
    }
  }, [editorContent, saving, selectedPath])

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      if ((e.metaKey || e.ctrlKey) && e.key === 's') {
        e.preventDefault()
        void handleSave()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [handleSave])

  const handleDownload = useCallback(async (): Promise<void> => {
    if (!selectedPath) return
    try {
      await window.api.viewer.download(selectedPath)
    } catch {
      // best-effort
    }
  }, [selectedPath])

  const handleReveal = useCallback(async (): Promise<void> => {
    if (!selectedPath) return
    try {
      await window.api.viewer.revealInFolder(selectedPath)
    } catch {
      // best-effort
    }
  }, [selectedPath])

  const handleResync = useCallback(async (): Promise<void> => {
    if (resyncing) return
    setResyncing(true)
    try {
      const next = await window.api.viewer.resync()
      setTree(next)
      toast.show({ tone: 'success', message: t('workspace.resyncSuccess') })
    } catch {
      toast.show({ tone: 'error', message: t('workspace.resyncError') })
    } finally {
      setResyncing(false)
    }
  }, [resyncing, t, toast])

  const language = selectedPath ? languageFor(selectedPath) : null
  const mediaType = selectedPath ? detectMediaType(selectedPath) : null
  const readOnly = selectedPath ? isReadOnlyPath(selectedPath) : false
  const isMarkdown = language === 'markdown'
  const isDirty = editorContent !== originalContent
  const fileName = selectedPath ? (selectedPath.split('/').pop() ?? selectedPath) : null
  const hasContent = language || mediaType

  return (
    <main className={cn('bg-bg flex h-full w-full flex-col', pageTopPadding)}>
      <header className="border-border flex items-center justify-between gap-4 border-b px-4 py-3">
        <button
          type="button"
          onClick={() => goTo('chat')}
          aria-label={t('common.back')}
          className={cn(
            'text-muted hover:text-fg flex cursor-pointer items-center gap-1.5 rounded-lg px-2 py-2 text-sm',
            'focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg'
          )}
        >
          <BackIcon size={16} />
          <span>{t('common.back')}</span>
        </button>
      </header>

      <div dir="ltr" className="flex min-h-0 flex-1">
        <aside className="border-border w-64 shrink-0 overflow-y-auto border-e p-3">
          {loadingTree ? (
            <TreeSkeleton />
          ) : treeError ? (
            <p className="px-2 py-3 text-xs text-red-500">{treeError}</p>
          ) : tree && tree.length > 0 ? (
            <ViewerTree nodes={tree} selectedPath={selectedPath} onSelectFile={handleSelectFile} />
          ) : (
            <p className="text-muted px-2 py-3 text-xs">{t('workspace.empty')}</p>
          )}
        </aside>

        <section className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
          {selectedPath && hasContent ? (
            <>
              <div className="border-border flex items-center justify-between gap-2 border-b px-4 py-3">
                <div className="flex min-w-0 flex-col">
                  <div className="flex min-w-0 items-baseline gap-1.5">
                    <span className="text-fg truncate text-sm font-medium" title={selectedPath}>
                      {fileName}
                    </span>
                    {mtimeMs != null && (
                      <>
                        <span className="text-muted shrink-0 text-xs" aria-hidden>
                          ·
                        </span>
                        <span className="text-muted shrink-0 truncate text-xs">
                          {formatFromNow(mtimeMs, now, locale)}
                        </span>
                      </>
                    )}
                  </div>
                  <span className="text-muted truncate text-xs" title={selectedPath}>
                    {selectedPath}
                  </span>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  {!readOnly && !mediaType && (
                    <IconButton
                      label={t('workspace.save')}
                      disabled={!isDirty || saving}
                      onClick={() => void handleSave()}
                    >
                      <FloppyDiskIcon size={16} />
                    </IconButton>
                  )}
                  {(readOnly || mediaType) && (
                    <Badge variant="default" size="md">
                      {t('workspace.readOnly')}
                    </Badge>
                  )}
                  <button
                    type="button"
                    onClick={() => void handleReveal()}
                    aria-label={t('workspace.reveal')}
                    className={cn(
                      'inline-flex items-center gap-1 rounded-md text-xs cursor-pointer',
                      'text-muted hover:text-fg px-1.5 py-0.5',
                      'focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg'
                    )}
                  >
                    <FolderOpenIcon size={14} />
                    <span>{t('workspace.reveal')}</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => void handleDownload()}
                    aria-label={t('workspace.download')}
                    className={cn(
                      'inline-flex items-center gap-1 rounded-md text-xs cursor-pointer',
                      'text-muted hover:text-fg px-1.5 py-0.5',
                      'focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg'
                    )}
                  >
                    <Download01Icon size={14} />
                    <span>{t('workspace.download')}</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => void handleResync()}
                    disabled={resyncing}
                    aria-label={t('workspace.resync')}
                    className={cn(
                      'inline-flex items-center gap-1 rounded-md text-xs cursor-pointer',
                      'text-muted hover:text-fg px-1.5 py-0.5',
                      'focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg',
                      'disabled:cursor-not-allowed disabled:opacity-40'
                    )}
                  >
                    <Refresh01Icon size={14} />
                    <span>{t('workspace.resync')}</span>
                  </button>
                  {!mediaType && <CopyButton text={editorContent} variant="inline" />}
                  {!mediaType && (
                    <ViewModeToggle value={viewMode} onChange={setViewMode} readOnly={readOnly} />
                  )}
                </div>
              </div>
              {fileError && (
                <div className="border-b border-red-500/30 bg-red-500/10 px-4 py-2 text-xs text-red-500">
                  {fileError}
                </div>
              )}
              <div className="flex min-h-0 flex-1">
                {mediaType ? (
                  <WorkspaceMediaViewer
                    relativePath={selectedPath}
                    fileName={fileName!}
                    mediaType={mediaType}
                    onDownload={handleDownload}
                  />
                ) : viewMode === 'preview' ? (
                  <div className="bg-surface text-fg min-h-0 flex-1 overflow-y-auto px-6 py-5 text-sm">
                    {isMarkdown ? (
                      <Markdown content={stripHtmlComments(editorContent)} />
                    ) : (
                      <pre className="whitespace-pre-wrap wrap-break-word font-mono text-xs leading-relaxed">
                        {prettyJson(editorContent)}
                      </pre>
                    )}
                  </div>
                ) : (
                  <CodeEditor
                    value={editorContent}
                    language={language!}
                    isDark={isDark}
                    readOnly={readOnly}
                    onChange={setEditorContent}
                    className="h-full w-full"
                    // Prose only: squiggles on code/JSON would be noise.
                    spellcheck={!readOnly && language === 'markdown'}
                  />
                )}
              </div>
            </>
          ) : selectedPath && !hasContent ? (
            <EmptyState message={t('workspace.unsupported')} />
          ) : (
            <EmptyState message={t('workspace.pickFile')} />
          )}
        </section>
      </div>
    </main>
  )
}

// ---------------------------------------------------------------------------
// Media viewer
// ---------------------------------------------------------------------------

function WorkspaceMediaViewer({
  relativePath,
  fileName,
  mediaType,
  onDownload
}: {
  relativePath: string
  fileName: string
  mediaType: MediaType
  onDownload: () => Promise<void>
}): React.JSX.Element {
  const mime = mimeFor(fileName)
  switch (mediaType) {
    case 'image':
      return <WorkspaceImage relativePath={relativePath} fileName={fileName} mime={mime} />
    case 'video':
      return <WorkspaceVideo relativePath={relativePath} fileName={fileName} mime={mime} />
    case 'audio':
      return (
        <WorkspaceAudio
          relativePath={relativePath}
          fileName={fileName}
          mime={mime}
          onDownload={onDownload}
        />
      )
    case 'pdf':
      return <WorkspacePdf relativePath={relativePath} fileName={fileName} />
    case 'docx':
      return <WorkspaceDocx relativePath={relativePath} fileName={fileName} />
    case 'spreadsheet':
      return <WorkspaceSpreadsheet relativePath={relativePath} fileName={fileName} />
  }
}

function WorkspaceImage({
  relativePath,
  fileName,
  mime
}: {
  relativePath: string
  fileName: string
  mime: string
}): React.JSX.Element {
  const { url, error } = useViewerBlob(relativePath, mime)
  const [modalOpen, setModalOpen] = useState(false)
  const [ratio, setRatio] = useState<number | null>(null)

  if (error) {
    return (
      <div className="flex min-h-full flex-1 flex-col items-center justify-center gap-2 p-6">
        <Image02Icon size={32} className="text-muted" />
        <span className="text-muted text-sm italic">Failed to load image</span>
      </div>
    )
  }

  return (
    <>
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
        {url ? (
          <div className="flex flex-1 items-center justify-center p-4">
            <button
              type="button"
              onClick={() => setModalOpen(true)}
              className="block cursor-pointer"
            >
              <img
                src={url}
                alt={fileName}
                className="max-h-[75vh] w-full object-contain"
                draggable={false}
                onLoad={(e) => {
                  const { naturalWidth, naturalHeight } = e.currentTarget
                  if (naturalWidth && naturalHeight) setRatio(naturalWidth / naturalHeight)
                }}
              />
            </button>
          </div>
        ) : (
          <div className="flex-1" />
        )}
      </div>
      {url && (
        <ImageLightbox
          open={modalOpen}
          onClose={() => setModalOpen(false)}
          url={url}
          fileName={fileName}
          ratio={ratio}
        />
      )}
    </>
  )
}

function WorkspaceVideo({
  relativePath,
  fileName,
  mime
}: {
  relativePath: string
  fileName: string
  mime: string
}): React.JSX.Element {
  const { url, error } = useViewerBlob(relativePath, mime)

  if (error) {
    return (
      <div className="flex min-h-full flex-1 flex-col items-center justify-center gap-2 p-6">
        <VideoOffIcon size={32} className="text-muted" />
        <span className="text-muted text-sm italic">Failed to load video</span>
      </div>
    )
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      {url ? (
        <div className="flex flex-1 items-center justify-center bg-black">
          <video
            src={url}
            controls
            preload="metadata"
            className="w-full"
            style={{ maxHeight: '80vh' }}
          >
            <track kind="captions" label={fileName} />
          </video>
        </div>
      ) : (
        <div className="flex-1" />
      )}
    </div>
  )
}

function WorkspaceAudio({
  relativePath,
  fileName,
  mime,
  onDownload
}: {
  relativePath: string
  fileName: string
  mime: string
  onDownload: () => Promise<void>
}): React.JSX.Element {
  const { url, error } = useViewerBlob(relativePath, mime)
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const progressRef = useRef<HTMLDivElement>(null)
  const [playing, setPlaying] = useState(false)
  const [currentTime, setCurrentTime] = useState(0)
  const [duration, setDuration] = useState(0)
  const [playbackRate, setPlaybackRate] = useState(1)

  useEffect(() => {
    const audio = audioRef.current
    if (!audio) return

    const onTime = (): void => setCurrentTime(audio.currentTime)
    const onMeta = (): void => setDuration(audio.duration)
    const onEnded = (): void => {
      setPlaying(false)
      setCurrentTime(0)
      audio.currentTime = 0
    }

    audio.addEventListener('timeupdate', onTime)
    audio.addEventListener('loadedmetadata', onMeta)
    audio.addEventListener('ended', onEnded)
    return () => {
      audio.removeEventListener('timeupdate', onTime)
      audio.removeEventListener('loadedmetadata', onMeta)
      audio.removeEventListener('ended', onEnded)
    }
  }, [url])

  const togglePlay = useCallback(() => {
    const audio = audioRef.current
    if (!audio) return
    if (playing) {
      audio.pause()
      setPlaying(false)
    } else {
      void audio.play()
      setPlaying(true)
    }
  }, [playing])

  const cycleSpeed = useCallback(() => {
    const audio = audioRef.current
    if (!audio) return
    const speeds = [1, 1.5, 2]
    const idx = speeds.indexOf(playbackRate)
    const next = speeds[(idx + 1) % speeds.length]
    audio.playbackRate = next
    setPlaybackRate(next)
  }, [playbackRate])

  const seek = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      const audio = audioRef.current
      const bar = progressRef.current
      if (!audio || !bar || !duration) return
      const rect = bar.getBoundingClientRect()
      const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width))
      audio.currentTime = ratio * duration
      setCurrentTime(audio.currentTime)
    },
    [duration]
  )

  if (error) {
    return (
      <div className="flex min-h-full flex-1 flex-col items-center justify-center gap-2 p-6">
        <VolumeMute02Icon size={32} className="text-muted" />
        <span className="text-muted text-sm italic">Failed to load audio</span>
      </div>
    )
  }

  const progress = duration > 0 ? (currentTime / duration) * 100 : 0

  return (
    <div className="flex min-h-0 flex-1 items-center justify-center p-6">
      <div
        className={cn(
          'border-border bg-surface flex w-full flex-col gap-1',
          'rounded-2xl border px-4 py-3'
        )}
      >
        <div className="text-muted truncate text-[11px] font-medium" title={fileName}>
          {fileName}
        </div>
        <div className="flex items-center gap-3">
          {url && <audio ref={audioRef} src={url} preload="metadata" />}

          <button
            type="button"
            onClick={togglePlay}
            disabled={!url}
            className={cn(
              'flex h-8 w-8 shrink-0 cursor-pointer items-center justify-center rounded-full',
              'bg-primary text-primary-fg hover:brightness-110',
              'focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg',
              'disabled:cursor-not-allowed disabled:opacity-50'
            )}
          >
            {playing ? <PauseIcon size={14} /> : <PlayIcon size={14} />}
          </button>

          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <div
              ref={progressRef}
              onClick={seek}
              className="bg-border h-1.5 w-full cursor-pointer rounded-full"
            >
              <div
                className="bg-primary h-full rounded-full transition-[width] duration-100"
                style={{ width: `${progress}%` }}
              />
            </div>
            <div className="text-muted flex items-center justify-between text-[10px] tabular-nums">
              <span>{formatAudioTime(currentTime)}</span>
              <span>{duration > 0 ? formatAudioTime(duration) : '--:--'}</span>
            </div>
          </div>

          <button
            type="button"
            onClick={cycleSpeed}
            title={`Speed: ${playbackRate}x`}
            className={cn(
              'text-muted hover:text-fg flex shrink-0 cursor-pointer items-center gap-0.5 rounded px-1 py-0.5 text-[10px] font-medium',
              'focus-visible:ring-2 focus-visible:ring-accent'
            )}
          >
            <DashboardSpeed01Icon size={12} />
            {playbackRate}x
          </button>

          <button
            type="button"
            onClick={() => void onDownload()}
            title="Download"
            className={cn(
              'text-muted hover:text-fg flex shrink-0 cursor-pointer items-center justify-center rounded p-1',
              'focus-visible:ring-2 focus-visible:ring-accent'
            )}
          >
            <Download01Icon size={14} />
          </button>
        </div>
      </div>
    </div>
  )
}

function formatAudioTime(seconds: number): string {
  if (!Number.isFinite(seconds)) return '--:--'
  const m = Math.floor(seconds / 60)
  const s = Math.floor(seconds % 60)
  return `${m}:${s.toString().padStart(2, '0')}`
}

function WorkspacePdf({
  relativePath,
  fileName
}: {
  relativePath: string
  fileName: string
}): React.JSX.Element {
  const { url, error } = useViewerBlob(relativePath, 'application/pdf')

  if (error) {
    return (
      <div className="flex min-h-full flex-1 flex-col items-center justify-center gap-2 p-6">
        <Pdf02Icon size={32} className="text-muted" />
        <span className="text-muted text-sm italic">Failed to load PDF</span>
      </div>
    )
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      {url ? (
        <iframe src={url} title={fileName} className="h-full w-full border-0" />
      ) : (
        <div className="flex-1" />
      )}
    </div>
  )
}

function WorkspaceDocx({
  relativePath
}: {
  relativePath: string
  fileName: string
}): React.JSX.Element {
  const { t } = useTranslation()
  const [html, setHtml] = useState<string | null>(null)
  const [error, setError] = useState(false)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const buffer: ArrayBuffer = await window.api.viewer.readBinaryFile(relativePath)
        const result = await mammoth.convertToHtml({ arrayBuffer: buffer })
        if (!cancelled) setHtml(result.value)
      } catch {
        if (!cancelled) setError(true)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [relativePath])

  if (error) {
    return (
      <div className="flex min-h-full flex-1 flex-col items-center justify-center gap-2 p-6">
        <File01Icon size={32} className="text-muted" />
        <span className="text-muted text-sm italic">{t('workspace.unsupported')}</span>
      </div>
    )
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      {html !== null ? (
        <div
          className="bg-surface text-fg flex-1 overflow-auto p-6 text-sm"
          dangerouslySetInnerHTML={{ __html: html }}
        />
      ) : (
        <div className="flex-1" />
      )}
    </div>
  )
}

function WorkspaceSpreadsheet({
  relativePath,
  fileName
}: {
  relativePath: string
  fileName: string
}): React.JSX.Element {
  const { t } = useTranslation()
  // Stamped with the path it belongs to, so switching files reads as "loading"
  // without a synchronous reset inside the effect.
  const [loaded, setLoaded] = useState<{
    path: string
    workbook: WorkbookModel | null
  } | null>(null)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const buffer: ArrayBuffer = await window.api.viewer.readBinaryFile(relativePath)
        const model = await readWorkbook(buffer, fileName)
        if (!cancelled) setLoaded({ path: relativePath, workbook: model })
      } catch {
        if (!cancelled) setLoaded({ path: relativePath, workbook: null })
      }
    })()
    return () => {
      cancelled = true
    }
  }, [relativePath, fileName])

  const ready = loaded?.path === relativePath ? loaded : null

  if (ready && !ready.workbook) {
    return (
      <div className="flex min-h-full flex-1 flex-col items-center justify-center gap-2 p-6">
        <File01Icon size={32} className="text-muted" />
        <span className="text-muted text-sm italic">{t('workspace.unsupported')}</span>
      </div>
    )
  }

  if (!ready?.workbook) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center">
        <span className="text-muted animate-pulse text-xs">
          {t('chat.spreadsheetViewer.loading')}
        </span>
      </div>
    )
  }

  return <SheetGrid workbook={ready.workbook} variant="page" />
}

// ---------------------------------------------------------------------------
// Shared UI pieces
// ---------------------------------------------------------------------------

function IconButton({
  label,
  disabled,
  onClick,
  children
}: {
  label: string
  disabled?: boolean
  onClick: () => void
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={label}
      className={cn(
        'text-muted hover:text-fg hover:bg-border/40 flex h-8 w-8 items-center justify-center rounded-lg cursor-pointer',
        'focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg',
        'disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-muted'
      )}
    >
      {children}
    </button>
  )
}

function ViewModeToggle({
  value,
  onChange,
  readOnly = false
}: {
  value: ViewMode
  onChange: (next: ViewMode) => void
  readOnly?: boolean
}): React.JSX.Element {
  const { t } = useTranslation()
  const modes: { key: ViewMode; label: string }[] = [
    { key: 'edit', label: t('workspace.edit') },
    { key: 'preview', label: t('workspace.preview') }
  ]
  return (
    <div
      role="tablist"
      className="border-border bg-surface inline-flex items-center rounded-lg border p-0.5"
    >
      {modes.map((m) => {
        const active = m.key === value
        const disabled = readOnly && m.key === 'edit'
        return (
          <button
            key={m.key}
            role="tab"
            type="button"
            aria-selected={active}
            disabled={disabled}
            onClick={() => onChange(m.key)}
            className={cn(
              'rounded-md px-2.5 py-1 text-xs font-medium',
              'focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg',
              disabled ? 'cursor-not-allowed opacity-40' : 'cursor-pointer',
              active ? 'bg-primary text-primary-fg' : 'text-muted hover:text-fg'
            )}
          >
            {m.label}
          </button>
        )
      })}
    </div>
  )
}

function TreeSkeleton(): React.JSX.Element {
  const rows = [
    { indent: 0, width: 'w-28' },
    { indent: 1, width: 'w-36' },
    { indent: 1, width: 'w-24' },
    { indent: 1, width: 'w-32' },
    { indent: 2, width: 'w-28' },
    { indent: 2, width: 'w-20' },
    { indent: 2, width: 'w-32' },
    { indent: 1, width: 'w-28' },
    { indent: 0, width: 'w-24' },
    { indent: 1, width: 'w-32' },
    { indent: 1, width: 'w-28' },
    { indent: 1, width: 'w-36' },
    { indent: 2, width: 'w-24' },
    { indent: 2, width: 'w-28' },
    { indent: 2, width: 'w-20' },
    { indent: 2, width: 'w-32' },
    { indent: 1, width: 'w-28' },
    { indent: 1, width: 'w-24' },
    { indent: 0, width: 'w-32' },
    { indent: 1, width: 'w-24' },
    { indent: 1, width: 'w-28' },
    { indent: 1, width: 'w-36' },
    { indent: 2, width: 'w-20' },
    { indent: 2, width: 'w-28' },
    { indent: 1, width: 'w-24' },
    { indent: 0, width: 'w-20' },
    { indent: 0, width: 'w-28' },
    { indent: 1, width: 'w-36' },
    { indent: 1, width: 'w-24' },
    { indent: 1, width: 'w-32' },
    { indent: 1, width: 'w-28' },
    { indent: 2, width: 'w-24' },
    { indent: 2, width: 'w-36' },
    { indent: 0, width: 'w-28' },
    { indent: 1, width: 'w-32' },
    { indent: 1, width: 'w-20' },
    { indent: 1, width: 'w-28' },
    { indent: 0, width: 'w-24' },
    { indent: 0, width: 'w-32' },
    { indent: 1, width: 'w-28' },
    { indent: 1, width: 'w-36' },
    { indent: 1, width: 'w-24' },
    { indent: 2, width: 'w-28' },
    { indent: 2, width: 'w-32' },
    { indent: 2, width: 'w-20' },
    { indent: 1, width: 'w-24' },
    { indent: 0, width: 'w-28' },
    { indent: 1, width: 'w-32' },
    { indent: 1, width: 'w-28' },
    { indent: 1, width: 'w-36' },
    { indent: 0, width: 'w-24' },
    { indent: 0, width: 'w-32' },
    { indent: 1, width: 'w-28' },
    { indent: 1, width: 'w-24' },
    { indent: 1, width: 'w-36' },
    { indent: 2, width: 'w-28' },
    { indent: 2, width: 'w-24' },
    { indent: 0, width: 'w-28' },
    { indent: 1, width: 'w-32' },
    { indent: 1, width: 'w-28' }
  ]
  return (
    <div className="flex flex-col gap-2 px-2 py-3">
      {rows.map((row, i) => (
        <div
          key={i}
          className="flex items-center gap-2"
          style={{ paddingInlineStart: `${row.indent * 12 + 8}px` }}
        >
          <div className="bg-border/60 h-3.5 w-3.5 shrink-0 animate-pulse rounded" />
          <div className={cn('bg-border/60 h-3.5 animate-pulse rounded', row.width)} />
        </div>
      ))}
    </div>
  )
}

function EmptyState({ message }: { message: string }): React.JSX.Element {
  return (
    <div className="flex min-h-full flex-1 items-center justify-center p-6 text-center">
      <p className="text-muted text-sm leading-relaxed">{message}</p>
    </div>
  )
}

function ViewerTree({
  nodes,
  selectedPath,
  onSelectFile
}: {
  nodes: ViewerTreeNode[]
  selectedPath: string | null
  onSelectFile: (path: string) => void
}): React.JSX.Element {
  return (
    <ul className="flex flex-col gap-0.5">
      {nodes.map((node) => (
        <ViewerTreeNodeItem
          key={node.relativePath}
          node={node}
          depth={0}
          selectedPath={selectedPath}
          onSelectFile={onSelectFile}
        />
      ))}
    </ul>
  )
}

function ViewerTreeNodeItem({
  node,
  depth,
  selectedPath,
  onSelectFile
}: {
  node: ViewerTreeNode
  depth: number
  selectedPath: string | null
  onSelectFile: (path: string) => void
}): React.JSX.Element {
  const containsSelected = useMemo(() => {
    if (!selectedPath) return false
    if (node.type === 'file') return false
    return selectedPath === node.relativePath || selectedPath.startsWith(node.relativePath + '/')
  }, [node, selectedPath])

  const [userOpen, setUserOpen] = useState<boolean | null>(null)
  const open = userOpen ?? (depth === 0 || containsSelected)

  const indent = { paddingInlineStart: `${depth * 12 + 8}px` }

  if (node.type === 'dir') {
    const Chevron = open ? ArrowDown01Icon : ArrowRight01Icon
    return (
      <li>
        <button
          type="button"
          onClick={() => setUserOpen(!open)}
          aria-expanded={open}
          style={indent}
          className={cn(
            'text-muted hover:text-fg hover:bg-border/40 flex w-full items-center gap-1.5 rounded-md py-1.5 pe-2 text-start text-sm cursor-pointer',
            'focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg'
          )}
        >
          <Chevron size={14} className="shrink-0" />
          <Folder01Icon size={14} className="shrink-0" />
          <span className="truncate">{node.name}</span>
        </button>
        {open && node.children.length > 0 && (
          <ul className="flex flex-col gap-0.5">
            {node.children.map((child) => (
              <ViewerTreeNodeItem
                key={child.relativePath}
                node={child}
                depth={depth + 1}
                selectedPath={selectedPath}
                onSelectFile={onSelectFile}
              />
            ))}
          </ul>
        )}
      </li>
    )
  }

  const isSelected = selectedPath === node.relativePath
  const { stem, ext } = splitFilename(node.name)
  return (
    <li>
      <button
        type="button"
        onClick={() => onSelectFile(node.relativePath)}
        aria-current={isSelected ? 'true' : undefined}
        style={indent}
        title={node.name}
        className={cn(
          'flex w-full items-center gap-1.5 rounded-md py-1.5 pe-2 text-start text-sm cursor-pointer',
          'focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg',
          isSelected ? 'bg-primary text-primary-fg' : 'text-muted hover:text-fg hover:bg-border/40'
        )}
      >
        <span className="w-3.5 shrink-0" />
        <File02Icon size={14} className="shrink-0" />
        <span className="flex min-w-0 flex-1 items-baseline">
          <span className="truncate">{stem}</span>
          {ext && <span className="shrink-0">{ext}</span>}
        </span>
      </button>
    </li>
  )
}
