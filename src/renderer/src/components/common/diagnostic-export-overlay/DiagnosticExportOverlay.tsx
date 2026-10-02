import { Button } from '@components/core/Button'
import { cn } from '@lib/utils/cn'
import type { DiagnosticProgress, DiagnosticResult, DiagnosticStep } from '@preload/index'
import {
  Alert02Icon,
  Bug01Icon,
  CheckmarkCircle02Icon,
  Download01Icon,
  FolderOpenIcon
} from 'hugeicons-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'

/**
 * Full-screen BLOCKING overlay for the per-conversation diagnostic export.
 *
 * Visual language is the reindex overlay's (pulsing ringed icon, started-at +
 * live elapsed, explanatory body, progress bar) because that's the app's
 * established "a job owns the screen right now" look. Two differences, both
 * from the requirement:
 *
 *  - It cannot be dismissed while collecting — no Escape handler, no backdrop
 *    click, no close affordance. The only exit is the Done button, which only
 *    exists once the archive is written (or has failed).
 *  - It ends in a confirmation: the archive card with Reveal / Save a copy,
 *    the bundle summary, and the note about forwarding it to the developer.
 *
 * The export itself runs in main; this component starts it on mount, mirrors
 * the progress broadcasts, and renders the result. Portalled to <body> so it
 * paints over the conversations rail (fixed z-30) like every other chat modal.
 */

const STEP_ORDER: DiagnosticStep[] = [
  'conversation',
  'logs',
  'tasks',
  'memory',
  'context',
  'settings',
  'attachments',
  'opinion',
  'archive'
]

type DiagnosticExportOverlayProps = {
  conversationId: string
  onClose: () => void
}

export function DiagnosticExportOverlay({
  conversationId,
  onClose
}: DiagnosticExportOverlayProps): React.JSX.Element {
  const { t, i18n } = useTranslation()
  const [progress, setProgress] = useState<DiagnosticProgress | null>(null)
  const [result, setResult] = useState<DiagnosticResult | null>(null)
  const [savingCopy, setSavingCopy] = useState(false)
  const [copySaved, setCopySaved] = useState(false)
  const [startedAt] = useState(() => Date.now())
  const [now, setNow] = useState(() => Date.now())
  // The run is fired exactly once per mount. Without the guard React's
  // development double-invoke would start two collections over the same files.
  const startedRef = useRef(false)

  useEffect(() => {
    return window.api.diagnostics.onProgress((p) => {
      if (p.conversationId === conversationId) setProgress(p)
    })
  }, [conversationId])

  useEffect(() => {
    if (startedRef.current) return
    startedRef.current = true
    // No `cancelled` flag here, deliberately. It would pair with the guard above
    // to hang the overlay forever: StrictMode mounts, runs the cleanup, then
    // mounts again — and on that second pass `startedRef` short-circuits before
    // a fresh flag is created, so the first pass's flag stays true and swallows
    // the only result this component will ever receive. The archive lands on
    // disk and the screen keeps spinning over it. Settling state after a real
    // unmount is a harmless no-op in React 18+, so there is nothing to guard.
    window.api.diagnostics
      .export({ conversationId })
      .then((r) => setResult(r))
      .catch((err: unknown) => {
        setResult({
          ok: false,
          error: err instanceof Error ? err.message : String(err),
          conversationId,
          conversationTitle: '',
          fileName: '',
          zipPath: '',
          relativePath: '',
          sizeBytes: 0,
          fileCount: 0,
          durationMs: 0,
          modelOpinion: false,
          groups: [],
          warnings: []
        })
      })
  }, [conversationId])

  // Ticks only while collecting — a finished bundle shows its own duration.
  useEffect(() => {
    if (result) return
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [result])

  const reveal = useCallback(() => {
    if (result?.zipPath) void window.api.diagnostics.reveal(result.zipPath)
  }, [result])

  const saveCopy = useCallback(async () => {
    if (!result?.ok || savingCopy) return
    setSavingCopy(true)
    try {
      const r = await window.api.diagnostics.saveCopy({
        zipPath: result.zipPath,
        fileName: result.fileName
      })
      if (r.ok) setCopySaved(true)
    } finally {
      setSavingCopy(false)
    }
  }, [result, savingCopy])

  const running = result === null
  // Live while collecting; once finished it freezes on the run's OWN duration
  // (main's measurement) rather than however long the window stayed open.
  const elapsed = Math.max(0, Math.floor((running ? now - startedAt : result.durationMs) / 1000))
  const elapsedStr = `${Math.floor(elapsed / 60)}:${(elapsed % 60).toString().padStart(2, '0')}`
  const startedStr = new Date(startedAt).toLocaleTimeString(i18n.language, {
    hour: '2-digit',
    minute: '2-digit'
  })
  const stepIndex = progress ? progress.index : 0
  const pct = running ? Math.min(95, Math.round((stepIndex / (STEP_ORDER.length + 1)) * 100)) : 100

  return createPortal(
    <div
      // No onClick / onKeyDown dismissal: the export owns the screen until it
      // finishes. `bg-bg` (opaque, not a translucent scrim) matches the reindex
      // overlay and makes the blocking intent unambiguous.
      className="bg-bg fixed inset-0 z-50 flex items-center justify-center overflow-y-auto px-6 py-12"
      role="dialog"
      aria-modal="true"
      aria-busy={running}
      aria-label={t('diagnostics.overlay.title')}
    >
      <div className="flex w-full max-w-md flex-col items-center gap-6">
        <div className="relative">
          {running && (
            <div className="absolute inset-0 animate-ping rounded-full bg-amber-500/20" />
          )}
          <div
            className={cn(
              'relative flex h-10 w-10 items-center justify-center rounded-full',
              running ? 'bg-amber-500/15' : result?.ok ? 'bg-emerald-500/15' : 'bg-red-500/15'
            )}
          >
            {running ? (
              <Bug01Icon size={20} className="animate-pulse text-amber-500" />
            ) : result?.ok ? (
              <CheckmarkCircle02Icon size={20} className="text-emerald-500" />
            ) : (
              <Alert02Icon size={20} className="text-red-500" />
            )}
          </div>
        </div>

        <div className="flex flex-col items-center gap-1.5 text-center">
          <h2 className="text-fg text-sm font-medium">
            {running
              ? t('diagnostics.overlay.title')
              : result?.ok
                ? t('diagnostics.overlay.doneTitle')
                : t('diagnostics.overlay.failedTitle')}
          </h2>
          <div className="text-muted flex items-center gap-2 text-xs">
            <span>{t('diagnostics.overlay.startedAt', { time: startedStr })}</span>
            <span className="text-border">·</span>
            {/* duration is conventionally LTR even in RTL UIs */}
            <span dir="ltr" className="font-mono tabular-nums">
              {elapsedStr}
            </span>
          </div>
        </div>

        {running ? (
          <>
            <pre className="text-muted bg-surface border-border w-full rounded-lg border px-3 py-2 text-[11px] leading-relaxed whitespace-pre-wrap">
              {t('diagnostics.overlay.body')}
            </pre>

            <div className="border-border bg-surface/50 w-full rounded-lg border px-3 py-2.5">
              <div className="text-muted mb-1.5 flex items-center justify-between text-[10px] font-medium tracking-wide uppercase">
                <span>
                  {progress
                    ? t(`diagnostics.steps.${progress.step}`)
                    : t('diagnostics.overlay.progress')}
                </span>
                {/* "n / total" pinned LTR so the count reads correctly in RTL */}
                <span dir="ltr" className="tabular-nums">
                  {stepIndex} / {STEP_ORDER.length}
                </span>
              </div>
              <div className="bg-border/60 h-1.5 w-full overflow-hidden rounded-full">
                <div
                  className="h-full rounded-full bg-amber-500 transition-[width] duration-500 ease-out"
                  style={{ width: `${pct}%` }}
                />
              </div>
              {progress && progress.files > 0 && (
                <p className="text-muted/70 mt-1.5 text-[10px]">
                  {t('diagnostics.overlay.filesCollected', { count: progress.files })}
                </p>
              )}
            </div>

            <p className="text-muted/50 text-center text-[11px]">
              {t('diagnostics.overlay.blocked')}
            </p>
          </>
        ) : result?.ok ? (
          <>
            {/* The archive card sits ABOVE the save prompt: the file already
                exists in the workspace, and saving a copy elsewhere is the
                optional second step. */}
            <div className="border-border bg-surface w-full rounded-lg border p-3">
              <div className="flex items-start gap-3">
                <div className="bg-primary/10 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg">
                  <Download01Icon size={16} className="text-primary" />
                </div>
                <div className="min-w-0 flex-1">
                  <p className="text-fg truncate text-xs font-medium" title={result.fileName}>
                    {result.fileName}
                  </p>
                  <p className="text-muted mt-0.5 text-[11px]" dir="ltr">
                    {formatBytes(result.sizeBytes)} ·{' '}
                    {t('diagnostics.overlay.fileCount', { count: result.fileCount })}
                  </p>
                  <p className="text-muted/70 mt-0.5 truncate text-[10px]" dir="ltr">
                    {result.relativePath}
                  </p>
                </div>
              </div>
              <div className="mt-3 flex gap-2">
                <Button variant="outline" size="sm" onClick={reveal} className="flex-1">
                  <FolderOpenIcon size={14} />
                  {t('diagnostics.overlay.reveal')}
                </Button>
                <Button
                  variant="primary"
                  size="sm"
                  onClick={() => void saveCopy()}
                  disabled={savingCopy}
                  className="flex-1"
                >
                  <Download01Icon size={14} />
                  {copySaved
                    ? t('diagnostics.overlay.copySaved')
                    : t('diagnostics.overlay.saveCopy')}
                </Button>
              </div>
            </div>

            <div className="border-border bg-surface/50 w-full rounded-lg border px-3 py-2.5">
              <p className="text-muted mb-1.5 text-[10px] font-medium tracking-wide uppercase">
                {t('diagnostics.overlay.summary')}
              </p>
              <ul className="text-muted flex flex-col gap-1 text-[11px]">
                {result.groups
                  .filter((g) => g.count > 0)
                  .map((group) => (
                    <li key={group.key} className="flex items-center justify-between gap-2">
                      <span className="truncate">{t(`diagnostics.groups.${group.key}`)}</span>
                      <span dir="ltr" className="tabular-nums">
                        {group.count}
                      </span>
                    </li>
                  ))}
                <li className="flex items-center justify-between gap-2">
                  <span className="truncate">{t('diagnostics.groups.opinion')}</span>
                  <span className="truncate text-right">
                    {result.modelOpinion
                      ? t('diagnostics.overlay.opinionIncluded')
                      : t(
                          `diagnostics.overlay.opinionSkipped.${result.opinionSkipped ?? 'failed'}`
                        )}
                  </span>
                </li>
              </ul>
              {result.warnings.length > 0 && (
                <ul className="text-muted/70 border-border mt-2 flex flex-col gap-1 border-t pt-2 text-[10px]">
                  {result.warnings.map((warning) => (
                    <li key={warning}>{warning}</li>
                  ))}
                </ul>
              )}
            </div>

            <p className="text-muted text-center text-[11px] leading-relaxed">
              {t('diagnostics.overlay.forward')}
            </p>
          </>
        ) : (
          <>
            <pre className="text-muted bg-surface border-border w-full rounded-lg border px-3 py-2 text-[11px] leading-relaxed whitespace-pre-wrap">
              {result?.error || t('diagnostics.overlay.failedBody')}
            </pre>
            <p className="text-muted/50 text-center text-[11px]">
              {t('diagnostics.overlay.failedHint')}
            </p>
          </>
        )}

        {/* The ONLY way out, and it only exists once the run has finished. */}
        {!running && (
          <button
            type="button"
            onClick={onClose}
            autoFocus
            className={cn(
              'bg-primary text-primary-fg w-full cursor-pointer rounded-lg px-4 py-2 text-xs font-medium',
              'hover:brightness-110',
              'focus-visible:ring-accent focus-visible:ring-offset-bg focus-visible:ring-2 focus-visible:ring-offset-2'
            )}
          >
            {t('diagnostics.overlay.done')}
          </button>
        )}
      </div>
    </div>,
    document.body
  )
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}
