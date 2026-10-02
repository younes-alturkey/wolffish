import { cn } from '@lib/utils/cn'
import { File01Icon, Folder01Icon, FolderOpenIcon, LinkSquare02Icon } from 'hugeicons-react'
import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { cachedPathInfo, statPathOnce, type PathInfo } from './pathStat'

/**
 * Renders a filesystem location the model explicitly pushed via the
 * `show_path` tool (its `[wolffish-path:]` marker) as a card — folder name
 * (or file name) + the path in a code block + a button to open it in the OS
 * file manager. A folder opens directly; a file is revealed in its parent
 * folder (selected), like "Reveal in Finder". Nothing is ever parsed out of
 * prose — no marker, no card.
 *
 * The path is still verified on the device: since the card records a real
 * tool call it never vanishes, but when the path no longer exists (deleted
 * since the turn ran, e.g. in a resumed conversation) the button is disabled
 * and the subtitle becomes an "unavailable" note. `kind` is the path's type
 * at call time (from the marker) so a gone path keeps the right icon/labels
 * — the live stat can no longer answer.
 */
export function PathCard({
  path,
  kind
}: {
  path: string
  kind?: 'folder' | 'file'
}): React.JSX.Element | null {
  const { t } = useTranslation()
  // Seed from the shared cache so a path already verified this session paints
  // its final state immediately — no empty flash. statPathOnce then confirms
  // (instantly for a cache hit, one shared IPC otherwise), so a changed path
  // still re-resolves without a synchronous setState in the effect body.
  const [info, setInfo] = useState<PathInfo | null>(() => cachedPathInfo(path) ?? null)

  useEffect(() => {
    let cancelled = false
    statPathOnce(path).then((r) => {
      if (!cancelled) setInfo(r)
    })
    return () => {
      cancelled = true
    }
  }, [path])

  const reveal = useCallback(async () => {
    try {
      await window.api.upload.revealPath(path)
    } catch {
      // best-effort
    }
  }, [path])

  // Render nothing only while the on-device check is still resolving.
  if (!info) return null

  const exists = info.exists
  // Live stat is the truth while the path exists; once gone, fall back to
  // the call-time kind from the marker.
  const isDir = exists ? info.isDirectory : kind === 'folder'
  const name = displayName(path, isDir)
  const actionLabel = isDir ? t('chat.pathCard.open') : t('chat.pathCard.reveal')
  const subtitle = exists
    ? isDir
      ? t('chat.pathCard.folder')
      : t('chat.pathCard.file')
    : kind === 'folder'
      ? t('chat.pathCard.unavailableFolder')
      : kind === 'file'
        ? t('chat.pathCard.unavailableFile')
        : t('chat.pathCard.unavailablePath')

  return (
    <div
      className={cn(
        'border-border bg-surface flex w-full max-w-[85%] flex-col gap-2 self-start',
        'rounded-2xl border px-4 py-3'
      )}
    >
      <div className="flex items-center gap-3">
        <div
          className={cn(
            'flex h-10 w-10 shrink-0 items-center justify-center rounded-lg',
            exists ? 'bg-primary/10 text-primary' : 'bg-muted/10 text-muted'
          )}
        >
          {isDir ? <Folder01Icon size={20} /> : <File01Icon size={20} />}
        </div>
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="text-fg truncate text-sm font-medium" title={name}>
            {name}
          </span>
          <span className="text-muted text-xs">{subtitle}</span>
        </div>
        <button
          type="button"
          onClick={reveal}
          disabled={!exists}
          title={exists ? actionLabel : subtitle}
          className={cn(
            'flex shrink-0 items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium',
            'focus-visible:ring-2 focus-visible:ring-accent',
            exists
              ? 'bg-primary/10 text-primary hover:bg-primary/20 cursor-pointer'
              : 'bg-muted/10 text-muted cursor-not-allowed'
          )}
        >
          {isDir ? <FolderOpenIcon size={14} /> : <LinkSquare02Icon size={14} />}
          {actionLabel}
        </button>
      </div>
      <code
        dir="ltr"
        className={cn(
          'border-border/60 bg-muted/10 text-muted block rounded-lg border px-3 py-2',
          'text-start font-mono text-xs break-all'
        )}
        title={path}
      >
        {path}
      </code>
    </div>
  )
}

function displayName(path: string, isDir: boolean): string {
  const trimmed = isDir ? path.replace(/\/+$/, '') : path
  return trimmed.split('/').pop() || trimmed
}
