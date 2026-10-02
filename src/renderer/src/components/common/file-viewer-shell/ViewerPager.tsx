import { RTL_LOCALES } from '@lib/i18n'
import { cn } from '@lib/utils/cn'
import { useLocale } from '@providers/locale/useLocale'
import { ArrowLeft01Icon, ArrowRight01Icon } from 'hugeicons-react'
import { useTranslation } from 'react-i18next'

export type ViewerPagerProps = {
  /** 0-based position. */
  index: number
  count: number
  /** Omit to render the position chip alone. A document that scrolls needs no
   *  chevrons — scrolling is already the way through it. */
  onChange?: (next: number) => void
  /** Already-translated position line, e.g. "Slide 3 of 11". */
  label: string
}

/**
 * Position readout laid over the render itself: a quiet chip in the bottom
 * corner, plus — for something you page rather than scroll — chevrons against
 * the two side edges that appear on hover. Absolutely positioned: the parent
 * must be `relative`, and something above it must carry `group` for the hover
 * reveal.
 *
 * Both chevrons and the chip carry their own translucent backing because a
 * slide can be any colour underneath; plain low-opacity text would vanish on
 * half the decks.
 */
export function ViewerPager({
  index,
  count,
  onChange,
  label
}: ViewerPagerProps): React.JSX.Element {
  const { t } = useTranslation()
  const { locale } = useLocale()
  const isRtl = RTL_LOCALES.has(locale)
  const PrevIcon = isRtl ? ArrowRight01Icon : ArrowLeft01Icon
  const NextIcon = isRtl ? ArrowLeft01Icon : ArrowRight01Icon

  return (
    <>
      {onChange && index > 0 && (
        <PagerChevron
          title={t('chat.viewerPager.previous')}
          className="start-2"
          onClick={() => onChange(index - 1)}
        >
          <PrevIcon size={16} />
        </PagerChevron>
      )}
      {onChange && index < count - 1 && (
        <PagerChevron
          title={t('chat.viewerPager.next')}
          className="end-2"
          onClick={() => onChange(index + 1)}
        >
          <NextIcon size={16} />
        </PagerChevron>
      )}
      <span
        className={cn(
          'pointer-events-none absolute bottom-2 start-2 rounded px-1.5 py-0.5',
          'bg-black/35 text-[10px] font-medium text-white/70'
        )}
        dir="auto"
      >
        {label}
      </span>
    </>
  )
}

/**
 * Only rendered when it can actually move — the first slide has no previous
 * chevron at all rather than a greyed one.
 */
function PagerChevron({
  title,
  className,
  onClick,
  children
}: {
  title: string
  className: string
  onClick: () => void
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-label={title}
      className={cn(
        'absolute top-1/2 z-10 -translate-y-1/2 cursor-pointer rounded-full p-1.5',
        'bg-black/35 text-white hover:bg-black/60',
        // Hidden until the pointer is on the card, but never hidden from the
        // keyboard. No opacity transition — those read as lag in this feed.
        'opacity-0 group-hover:opacity-100 group-focus-within:opacity-100',
        'focus-visible:ring-accent focus-visible:opacity-100 focus-visible:ring-2',
        className
      )}
    >
      {children}
    </button>
  )
}
