import type { TouchedFolder } from '@lib/touched-folders/touchedFolders'
import { cn } from '@lib/utils/cn'
import { isMac } from '@lib/utils/platform'
import { Folder01Icon } from 'hugeicons-react'
import { useTranslation } from 'react-i18next'

/**
 * The folders this conversation works in, as a strip of chips laid over the
 * transcript's top edge — starting after the leading glass disc, on the row
 * the FloatingChrome owns, ending before the trailing disc. Every attached
 * working folder, then every project files were changed in; one chip per
 * project — each touched directory collapses to the repository (or project)
 * folder it belongs to, so nested folders never each get one. A chip carries
 * the number of files changed anywhere under it, and no number at all while
 * that is zero (an attached folder nothing has happened in yet); click opens
 * the folder in the system file manager. The strip never wraps: it scrolls
 * on x, scrollbar hidden, so a run that touches twenty folders costs the
 * transcript no height.
 *
 * Fed by folderChips over the persisted segments and the attached folders,
 * with each directory's project resolved once by main (upload.projectFolders),
 * so the chips are identical live, after the turn and on a reopened
 * conversation.
 */
export function TouchedFolders({
  folders
}: {
  folders: TouchedFolder[]
}): React.JSX.Element | null {
  const { t } = useTranslation()
  if (folders.length === 0) return null
  return (
    <div
      role="list"
      aria-label={t('chat.touchedFolders.label')}
      className={cn(
        // Same row as the floating discs (FloatingChrome): mac clears the
        // traffic lights at top-12, other platforms sit at top-6; the discs
        // attach at px-4 from the side edges on every platform. The start/end
        // padding clears a 40px disc plus its gap on each side.
        'pointer-events-none fixed inset-x-0 z-20 flex h-10 items-center ps-16 pe-16',
        isMac ? 'top-12' : 'top-6'
      )}
    >
      <div
        className={cn(
          'pointer-events-auto flex max-w-full flex-nowrap items-center gap-2 overflow-x-auto',
          '[scrollbar-width:none] [&::-webkit-scrollbar]:hidden'
        )}
      >
        {folders.map((folder) => (
          <button
            key={folder.path}
            type="button"
            role="listitem"
            onClick={() => void window.api.upload.revealPath(folder.path)}
            title={`${folder.path}\n${
              folder.files > 0
                ? t('chat.touchedFolders.chip', { count: folder.files })
                : t('chat.touchedFolders.attached')
            }`}
            className={cn(
              'flex h-7 shrink-0 cursor-pointer items-center gap-1.5 rounded-full border px-2.5 text-xs font-medium',
              // The card ground, not the chrome's glass: these chips lie over
              // scrolling transcript text, and a translucent chip let code lines
              // ghost through it. bg-surface is the same ground every card below
              // paints on — white in light, #161b22 in dark — so the strip reads
              // as chips on the transcript rather than a smudge of it.
              'border-border bg-surface text-fg hover:bg-bg active:opacity-60',
              'focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg'
            )}
          >
            <Folder01Icon size={13} className="text-accent shrink-0" aria-hidden />
            <span dir="ltr" className="max-w-[16rem] truncate">
              {folder.label}
            </span>
            {folder.files > 0 && <span className="text-muted tabular-nums">{folder.files}</span>}
          </button>
        ))}
      </div>
    </div>
  )
}
