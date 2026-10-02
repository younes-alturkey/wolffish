/* eslint-disable react-refresh/only-export-components */
import { cn } from '@lib/utils/cn'
import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

export type ContextMenuItem = {
  label: string
  action: () => void
  disabled?: boolean
  separator?: false
}

export type ContextMenuSeparator = { separator: true }

export type ContextMenuEntry = ContextMenuItem | ContextMenuSeparator

type Position = { x: number; y: number }

type ContextMenuProps = {
  items: ContextMenuEntry[]
  position: Position
  onClose: () => void
}

export function ContextMenuPopup({
  items,
  position,
  onClose
}: ContextMenuProps): React.JSX.Element {
  const menuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const el = menuRef.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    const vw = window.innerWidth
    const vh = window.innerHeight
    if (rect.right > vw) el.style.left = `${vw - rect.width - 4}px`
    if (rect.bottom > vh) el.style.top = `${vh - rect.height - 4}px`
  }, [position])

  useEffect(() => {
    const handleClick = (e: MouseEvent): void => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) onClose()
    }
    const handleKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('mousedown', handleClick)
    window.addEventListener('keydown', handleKey)
    return () => {
      window.removeEventListener('mousedown', handleClick)
      window.removeEventListener('keydown', handleKey)
    }
  }, [onClose])

  return createPortal(
    <div
      ref={menuRef}
      className={cn(
        'bg-surface border-border fixed z-9999 min-w-35 overflow-hidden rounded-lg border py-1 shadow-lg'
      )}
      style={{ left: position.x, top: position.y }}
    >
      {items.map((entry, i) =>
        entry.separator ? (
          <div key={i} className="bg-border my-1 h-px" />
        ) : (
          <button
            key={i}
            type="button"
            disabled={entry.disabled}
            // Keep focus (and the right-click-selected misspelling) in the field so
            // the native replaceMisspelling command has a word to act on.
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => {
              entry.action()
              onClose()
            }}
            className={cn(
              'text-fg hover:bg-accent/10 w-full px-3 py-1.5 text-start text-xs',
              'disabled:text-muted disabled:cursor-not-allowed disabled:hover:bg-transparent'
            )}
          >
            {entry.label}
          </button>
        )
      )}
    </div>,
    document.body
  )
}

export function useContextMenu(buildItems: () => ContextMenuEntry[]): {
  onContextMenu: (e: React.MouseEvent) => void
  menu: React.ReactNode
} {
  const [state, setState] = useState<{ position: Position; items: ContextMenuEntry[] } | null>(null)

  const onContextMenu = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault()
      setState({ position: { x: e.clientX, y: e.clientY }, items: buildItems() })
    },
    [buildItems]
  )

  const close = useCallback(() => setState(null), [])

  const menu = state ? (
    <ContextMenuPopup items={state.items} position={state.position} onClose={close} />
  ) : null

  return { onContextMenu, menu }
}
