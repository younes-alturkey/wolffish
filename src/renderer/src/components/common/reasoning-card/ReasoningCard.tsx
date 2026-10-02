import { CopyButton } from '@components/core/CopyButton'
import { BrainIcon } from 'hugeicons-react'
import { useLayoutEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'

const HEADING = /^(?:\*\*(.+?)\*\*:?|__(.+?)__:?|#{1,6}\s+(.+?))$/
const TITLE_MAX = 80

/**
 * Lift a leading heading line out of the reasoning text to label the card.
 * Nothing structured rides the segment (providers stream thinking as plain
 * text), but summarised reasoning opens with a bold or `#` heading — the
 * closest thing to a title. A lone heading with no body underneath stays in
 * the body; the card falls back to the generic label.
 */
function splitReasoningTitle(content: string): { title: string | null; body: string } {
  const text = content.trim()
  const [first = '', ...rest] = text.split('\n')
  const match = first.trim().match(HEADING)
  const title = (match?.[1] ?? match?.[2] ?? match?.[3])?.trim()
  const body = rest.join('\n').trim()
  if (!title || title.length > TITLE_MAX || body.length === 0) return { title: null, body: text }
  return { title, body }
}

/**
 * The model's reasoning for a turn — a scroll block styled like the tool
 * card's output block: sized by its content up to eight lines, scrollable past
 * that, with the copy control revealed on hover. Mirrors the mobile app's
 * ReasoningCard.
 */
export function ReasoningCard({ content }: { content: string }): React.JSX.Element {
  const { t } = useTranslation()
  const { title, body } = splitReasoningTitle(content)
  const bodyRef = useRef<HTMLDivElement>(null)
  // A streaming run follows its tail: while the reader has not scrolled up,
  // every delta keeps the newest line in view. Scrolling up releases the pin;
  // scrolling back to the bottom re-arms it. The first layout is skipped so a
  // reloaded conversation opens every card on its head, in reading order.
  const followRef = useRef(true)
  const laidOutRef = useRef(false)
  useLayoutEffect(() => {
    const el = bodyRef.current
    if (!el) return
    if (!laidOutRef.current) {
      laidOutRef.current = true
      return
    }
    if (followRef.current) el.scrollTop = el.scrollHeight
  }, [body])

  return (
    <div className="border-border bg-surface w-full max-w-[85%] self-start rounded-2xl border px-4 py-2.5">
      <div className="flex items-center gap-2">
        <BrainIcon size={14} className="text-muted shrink-0" aria-hidden />
        <span className="text-fg truncate text-xs font-medium">
          {title ?? t('chat.reasoningCard.title')}
        </span>
      </div>
      <div className="group/reasoning relative mt-2">
        {/* box-content: max-h-40 caps the text area alone — eight lines of
            leading-5 — so padding and border sit outside the count. */}
        <div
          ref={bodyRef}
          data-select-root
          onScroll={(e) => {
            const el = e.currentTarget
            followRef.current = el.scrollTop + el.clientHeight >= el.scrollHeight - 2
          }}
          className="border-border bg-bg text-muted wrap-anywhere box-content max-h-40 overflow-y-auto rounded-md border px-3 py-2 pe-12 text-start text-xs leading-5 whitespace-pre-wrap"
        >
          {body}
        </div>
        <CopyButton
          text={content.trim()}
          variant="overlay"
          ariaLabelKey="chat.copy"
          className="absolute inset-e-1.5 top-1.5 opacity-0 group-hover/reasoning:opacity-100 focus-visible:opacity-100"
        />
      </div>
    </div>
  )
}
