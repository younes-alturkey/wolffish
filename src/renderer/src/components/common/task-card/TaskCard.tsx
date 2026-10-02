import { useUploadBlob } from '@hooks/use-upload-blob/useUploadBlob'
import { cn } from '@lib/utils/cn'
import type { TaskSnapshot, TaskStatus } from '@preload/index'
import { Cancel01Icon, Video01Icon } from 'hugeicons-react'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

/**
 * Generic async-generation task card (MiniMax H3 video today; snapshot.kind
 * leaves room for future generators). Fully DETERMINISTIC: everything
 * rendered comes from the manager's TaskSnapshot — the model narrates
 * nothing. One card per task: snapshots replace each other by taskId
 * upstream (upsertTaskSegment live, the task:changed fold after the turn
 * ends), so live streaming and a reloaded conversation render identically.
 *
 * Progress: the API reports no true percentage, so the bar interpolates
 * elapsed time against the manager's measured estimate, clamped at 95%
 * until a terminal snapshot arrives. A 1 Hz self-tick keeps it moving
 * without any push traffic (the WorkflowCard pattern).
 */

const STATUS_COLOR: Record<TaskStatus, string> = {
  submitted: 'bg-accent/10 text-accent',
  queued: 'bg-accent/10 text-accent',
  running: 'bg-accent/10 text-accent',
  succeeded: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400',
  failed: 'bg-red-500/10 text-red-600 dark:text-red-400',
  cancelled: 'bg-muted/20 text-muted'
}

const LIVE_STATUSES: ReadonlySet<TaskStatus> = new Set(['submitted', 'queued', 'running'])

export function TaskCard({ snapshot }: { snapshot: TaskSnapshot }): React.JSX.Element {
  const { t } = useTranslation()
  const live = LIVE_STATUSES.has(snapshot.status)

  // 1 Hz tick while live so elapsed time and the estimate bar move.
  const [now, setNow] = useState<number>(() => Date.now())
  useEffect(() => {
    if (!live) return
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [live])

  const elapsedMs = Math.max(0, (snapshot.endedAt ?? now) - snapshot.createdAt)
  const percent =
    snapshot.status === 'succeeded'
      ? 100
      : live
        ? Math.min(95, Math.round((elapsedMs / 1000 / Math.max(1, snapshot.estimateSeconds)) * 100))
        : 0

  const video = snapshot.video
  const facts: string[] = []
  if (video) {
    facts.push(video.resolution)
    facts.push(`${video.durationSeconds}s`)
    if (video.ratio) facts.push(video.ratio)
    facts.push(video.inputSummary)
  }

  return (
    <div className="border-border bg-surface flex w-full max-w-[85%] flex-col gap-2 self-start rounded-2xl border px-4 py-3 text-sm">
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <Video01Icon size={15} className="text-muted shrink-0" aria-hidden />
          <span
            className={cn(
              'inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-xs font-medium',
              STATUS_COLOR[snapshot.status]
            )}
          >
            {t(`chat.task.status.${snapshot.status}`)}
          </span>
          <span dir="auto" className="text-fg truncate font-medium">
            {snapshot.title}
          </span>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <span dir="ltr" className="text-muted text-xs tabular-nums">
            {formatElapsed(elapsedMs)}
          </span>
          {live && (
            <button
              type="button"
              onClick={() => void window.api.task.cancel(snapshot.taskId)}
              title={t('chat.task.cancel')}
              aria-label={t('chat.task.cancel')}
              className="text-muted hover:text-fg flex shrink-0 cursor-pointer items-center justify-center rounded p-1 focus-visible:ring-2 focus-visible:ring-accent"
            >
              <Cancel01Icon size={14} />
            </button>
          )}
        </div>
      </div>

      {live && (
        <div
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={percent}
          className="bg-bg border-border h-1.5 w-full overflow-hidden rounded-full border"
        >
          <div
            className="bg-accent h-full rounded-full transition-[width] duration-500 ease-out"
            style={{ width: `${percent}%` }}
          />
        </div>
      )}

      <div className="text-muted flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
        {facts.map((fact, idx) => (
          <span key={idx} dir="auto" className="whitespace-nowrap">
            {idx > 0 && <span className="me-2 opacity-50">·</span>}
            {fact}
          </span>
        ))}
        <span dir="ltr" className="ms-auto font-mono tabular-nums opacity-70">
          {snapshot.taskId}
        </span>
      </div>

      {snapshot.detail && snapshot.status !== 'failed' && (
        <div dir="auto" className="text-muted text-xs">
          {snapshot.detail}
        </div>
      )}

      {snapshot.status === 'failed' && (
        <div
          role="alert"
          aria-live="polite"
          className="rounded-md border border-red-300 bg-red-50 px-3 py-2 text-xs text-red-900 dark:border-red-700 dark:bg-red-900/40 dark:text-red-100"
        >
          {snapshot.error ?? t('chat.task.status.failed')}
        </div>
      )}

      {snapshot.status === 'succeeded' && snapshot.outputPath && (
        <TaskVideoPreview filePath={snapshot.outputPath} />
      )}
    </div>
  )
}

/**
 * Inline preview of the finished artifact. A slim sibling of VideoPlayer's
 * ActiveVideo (which carries its own feed-shell max-width and can't nest
 * here — cn has no tailwind-merge, so shells don't override). Same blob
 * source; the send_file delivery the model performs is where the full
 * player with lightbox lives.
 */
function TaskVideoPreview({ filePath }: { filePath: string }): React.JSX.Element | null {
  const { url, error } = useUploadBlob(filePath, 'video/mp4')
  if (error) return null
  if (!url) {
    return (
      <div
        className="bg-border/30 flex w-full items-center justify-center overflow-hidden rounded-xl"
        style={{ aspectRatio: '16 / 9' }}
      >
        <span className="text-muted animate-pulse text-xs">…</span>
      </div>
    )
  }
  return (
    <video
      src={url}
      controls
      preload="metadata"
      className="bg-black w-full overflow-hidden rounded-xl"
      style={{ maxHeight: '50vh' }}
    />
  )
}

function formatElapsed(ms: number): string {
  const total = Math.floor(ms / 1000)
  const minutes = Math.floor(total / 60)
  const seconds = total % 60
  return `${minutes}:${String(seconds).padStart(2, '0')}`
}
