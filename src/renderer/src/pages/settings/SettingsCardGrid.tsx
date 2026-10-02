import { cn } from '@lib/utils/cn'
import { Search01Icon } from 'hugeicons-react'
import { useState, type ReactNode } from 'react'

export type SettingsCardItem = {
  id: string
  title: string
  description: string
  glyph: ReactNode
  badge?: ReactNode
}

/**
 * The tabless Services and Models landing pages: one searchable grid of
 * cards, one card per service or provider. Adding an entry means adding a
 * card — no nav surgery. The search matches on the card's display name.
 */
export function SettingsCardGrid({
  title,
  subtitle,
  searchPlaceholder,
  emptyLabel,
  cards,
  onOpen
}: {
  title: string
  subtitle: string
  searchPlaceholder: string
  emptyLabel: string
  cards: SettingsCardItem[]
  onOpen: (id: string) => void
}): React.JSX.Element {
  const [query, setQuery] = useState('')
  const needle = query.trim().toLowerCase()
  const visible = needle ? cards.filter((c) => c.title.toLowerCase().includes(needle)) : cards

  return (
    <div className="flex min-h-full w-full items-start justify-center px-6 py-10">
      <div className="flex w-full max-w-4xl flex-col gap-6">
        <header className="flex flex-col gap-2">
          <h1 className="text-fg text-2xl font-semibold tracking-tight">{title}</h1>
          <p className="text-muted text-sm leading-relaxed">{subtitle}</p>
        </header>

        <div className="relative w-full">
          <Search01Icon
            size={16}
            className="text-muted pointer-events-none absolute inset-s-3 top-1/2 -translate-y-1/2"
          />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={searchPlaceholder}
            aria-label={searchPlaceholder}
            className={cn(
              'bg-surface text-fg border-border placeholder:text-muted hover:border-muted',
              'h-10 w-full rounded-lg border ps-10 pe-3 text-sm',
              'focus-visible:border-accent focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg'
            )}
          />
        </div>

        {visible.length === 0 ? (
          <div className="border-border text-muted rounded-2xl border border-dashed px-6 py-12 text-center text-sm">
            {emptyLabel}
          </div>
        ) : (
          <ul className="grid grid-cols-3 gap-3">
            {visible.map((card) => (
              <li key={card.id} className="min-w-0">
                <button
                  type="button"
                  onClick={() => onOpen(card.id)}
                  className={cn(
                    'bg-surface border-border hover:border-muted flex h-full w-full cursor-pointer flex-col items-start gap-3 rounded-2xl border p-4 text-start',
                    'focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg'
                  )}
                >
                  <span className="flex w-full items-center justify-between gap-2">
                    <span className="border-border bg-bg text-fg flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border">
                      {card.glyph}
                    </span>
                    {card.badge}
                  </span>
                  <span className="flex w-full min-w-0 flex-col gap-1">
                    <span className="text-fg truncate text-sm font-semibold">{card.title}</span>
                    <span
                      className="text-muted line-clamp-2 text-xs leading-relaxed"
                      title={card.description}
                    >
                      {card.description}
                    </span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}
