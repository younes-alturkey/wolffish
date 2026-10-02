import { useContextMenu } from '@components/core/ContextMenu'
import { Markdown } from '@components/core/Markdown'
import { useCallback, useRef } from 'react'
import { useTranslation } from 'react-i18next'

/**
 * Rendered markdown with a right-click menu offering Select all + Copy — the
 * read-only subset of the app's input context menu (no paste/clear, since the
 * content isn't editable). Each mount owns its own selection target and menu
 * state, so the inline file card and the expanded sheet (which render the same
 * element) behave independently.
 */
export function MarkdownContent({ content }: { content: string }): React.JSX.Element {
  const { t } = useTranslation()
  const ref = useRef<HTMLDivElement>(null)

  const { onContextMenu, menu } = useContextMenu(
    useCallback(() => {
      const hasSelection = (window.getSelection()?.toString().length ?? 0) > 0
      return [
        {
          label: t('chat.contextMenu.selectAll'),
          action: () => {
            const el = ref.current
            if (!el) return
            const range = document.createRange()
            range.selectNodeContents(el)
            const sel = window.getSelection()
            sel?.removeAllRanges()
            sel?.addRange(range)
          }
        },
        {
          label: t('chat.contextMenu.copy'),
          action: () => {
            const text = window.getSelection()?.toString()
            if (text) void navigator.clipboard.writeText(text)
          },
          disabled: !hasSelection
        }
      ]
    }, [t])
  )

  return (
    <>
      <div
        ref={ref}
        onContextMenu={onContextMenu}
        className="text-fg px-4 py-2.5 text-sm leading-relaxed wrap-break-word"
      >
        <Markdown content={content} />
      </div>
      {menu}
    </>
  )
}
