import { glassButtonClass } from '@components/common/floating-chrome/glass'
import { useHoverCapable } from '@hooks/use-hover-capable/useHoverCapable'
import { cn } from '@lib/utils/cn'
import type { Project } from '@preload/index'
import { PlusSignIcon } from 'hugeicons-react'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

/**
 * The floating New-chat glass disc (top-trailing corner, FloatingChrome) with
 * a hover card (the ContextMeter recipe: 150ms open / 200ms close timers,
 * Escape + outside-click dismiss). Clicking the disc creates a plain
 * no-project conversation, exactly as before; hovering reveals the projects
 * as cards — picking one starts the new conversation inside that project.
 * Projects load lazily on first reveal; with none, the card never shows and
 * this stays a plain New button.
 *
 * Without hover (phones, tablets) there is no reveal, so the tap itself opens
 * the card, which then leads with a plain "New conversation" row — every choice the
 * desktop offers across hover + click, reachable by tap.
 */
export function NewChatButton({
  onNew,
  onNewInProject
}: {
  onNew: () => void
  onNewInProject: (projectId: string) => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const hoverCapable = useHoverCapable()
  const [open, setOpen] = useState(false)
  const [projects, setProjects] = useState<Project[] | null>(null)
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const rootRef = useRef<HTMLSpanElement>(null)

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false)
    }
    const onDown = (e: MouseEvent): void => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('keydown', onKey)
    document.addEventListener('mousedown', onDown)
    return () => {
      document.removeEventListener('keydown', onKey)
      document.removeEventListener('mousedown', onDown)
    }
  }, [open])

  // Fetch on EVERY reveal, not once per mount: Chat instances stay mounted
  // for the whole app session (keepalive), so a one-shot cache pinned the
  // project list to whatever existed at the FIRST hover — projects created
  // later never appeared. The call is a ~1ms IPC; the previous list stays
  // rendered while the refresh lands, so there's no flicker.
  useEffect(() => {
    if (!open) return
    let cancelled = false
    void window.api.projects
      .list()
      .then((list) => {
        if (!cancelled) setProjects(list)
      })
      .catch(() => {
        if (!cancelled) setProjects((prev) => prev ?? [])
      })
    return () => {
      cancelled = true
    }
  }, [open])

  useEffect(() => {
    return () => {
      if (hoverTimer.current) clearTimeout(hoverTimer.current)
    }
  }, [])

  // A tap fires mouseenter and focus too; without hover those must stay inert
  // or the timer would reopen the card right after the tap closed it.
  const onEnter = (): void => {
    if (!hoverCapable) return
    if (hoverTimer.current) clearTimeout(hoverTimer.current)
    hoverTimer.current = setTimeout(() => setOpen(true), 150)
  }
  const onLeave = (): void => {
    if (!hoverCapable) return
    if (hoverTimer.current) clearTimeout(hoverTimer.current)
    hoverTimer.current = setTimeout(() => setOpen(false), 200)
  }

  const cardVisible = open && projects !== null && projects.length > 0
  const rowClass = cn(
    'flex w-full cursor-pointer items-start gap-2.5 rounded-lg border px-2.5 py-2 text-start',
    'focus-visible:ring-2 focus-visible:ring-accent',
    'border-border hover:bg-border/40'
  )

  return (
    <span
      ref={rootRef}
      className="pointer-events-auto relative inline-flex shrink-0"
      onMouseEnter={onEnter}
      onMouseLeave={onLeave}
    >
      <button
        type="button"
        onClick={() => {
          if (hoverCapable) {
            setOpen(false)
            onNew()
            return
          }
          if (open) {
            setOpen(false)
            return
          }
          // The tap has to know whether there is anything to choose from:
          // with no projects it stays a plain New button, with some it
          // opens the card (the reveal effect refreshes the list again).
          void window.api.projects
            .list()
            .catch((): Project[] => [])
            .then((list) => {
              if (list.length === 0) {
                onNew()
                return
              }
              setProjects(list)
              setOpen(true)
            })
        }}
        onFocus={onEnter}
        onBlur={onLeave}
        title={t('chat.newChat')}
        aria-label={t('chat.newChat')}
        aria-expanded={cardVisible}
        className={glassButtonClass}
      >
        <PlusSignIcon size={18} />
      </button>

      {cardVisible && (
        <div
          role="dialog"
          /* End-anchored under the disc: it floats at the window's top-end
             corner, so the card opens downward and inward (toward the start
             side) to stay on screen. */
          className="border-border bg-surface absolute top-full inset-e-0 z-50 mt-2 flex w-80 max-w-[90vw] flex-col gap-1.5 rounded-xl border p-1.5 shadow-xl"
        >
          <div className="flex max-h-64 flex-col gap-1.5 overflow-y-auto">
            {!hoverCapable && (
              <button
                type="button"
                onClick={() => {
                  setOpen(false)
                  onNew()
                }}
                className={rowClass}
              >
                <span aria-hidden className="mt-0.5 flex h-4 shrink-0 items-center">
                  <PlusSignIcon size={14} />
                </span>
                <span className="text-fg min-w-0 flex-1 truncate text-xs font-medium">
                  {t('chat.newChat')}
                </span>
              </button>
            )}
            {projects.map((p) => {
              // Single truncated line of the project's instructions — the
              // same name + description shape as the mode/thinking cards.
              const instructions = p.instructions.trim().replace(/\s+/g, ' ')
              return (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => {
                    setOpen(false)
                    onNewInProject(p.id)
                  }}
                  className={rowClass}
                >
                  <span aria-hidden className="mt-0.5 shrink-0 text-base leading-none">
                    {p.icon || '📁'}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="text-fg block truncate text-xs font-medium">
                      {p.title.trim() || t('projects.untitled')}
                    </span>
                    {instructions !== '' && (
                      <span
                        dir="auto"
                        className="text-muted block truncate text-[11px] leading-snug"
                      >
                        {instructions}
                      </span>
                    )}
                  </span>
                </button>
              )
            })}
          </div>
        </div>
      )}
    </span>
  )
}
