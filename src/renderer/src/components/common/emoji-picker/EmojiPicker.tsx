import { EMOJI_GROUPS } from '@lib/emoji/emoji-data'
import { cn } from '@lib/utils/cn'
import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'

/**
 * The generated catalog's group labels are stable Unicode CLDR names — this
 * maps them to i18n keys so categories localize (Arabic included). An
 * unmapped label (a future regeneration adding a group) falls back to the
 * raw English name instead of breaking.
 */
const GROUP_LABEL_KEYS: Record<string, string> = {
  'Smileys & Emotion': 'projects.emojiGroups.smileys',
  'People & Body': 'projects.emojiGroups.people',
  'Animals & Nature': 'projects.emojiGroups.nature',
  'Food & Drink': 'projects.emojiGroups.food',
  'Travel & Places': 'projects.emojiGroups.travel',
  Activities: 'projects.emojiGroups.activities',
  Objects: 'projects.emojiGroups.objects',
  Symbols: 'projects.emojiGroups.symbols',
  Flags: 'projects.emojiGroups.flags'
}

/**
 * Notion-style emoji picker over the FULL generated Unicode catalog
 * (lib/emoji/emoji-data.ts — ~1,600 glyphs, searchable by name, grouped by
 * category). Rendered with the platform's native emoji font, and the catalog
 * is pre-filtered for cross-OS fidelity (version cap, no country flags), so
 * the same picker works seamlessly on macOS, Windows and Linux.
 *
 * Renders as an anchored popover: mount it inside a `relative` wrapper next
 * to the trigger. A fixed backdrop closes it on any outside click.
 */
export function EmojiPicker({
  onPick,
  onClose
}: {
  onPick: (emoji: string) => void
  onClose: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const [query, setQuery] = useState('')

  const groups = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return EMOJI_GROUPS
    return EMOJI_GROUPS.map((group) => ({
      label: group.label,
      emojis: group.emojis.filter(([, name]) => name.includes(q))
    })).filter((group) => group.emojis.length > 0)
  }, [query])

  return (
    <>
      <button
        type="button"
        aria-label={t('common.close')}
        onClick={onClose}
        className="fixed inset-0 z-40 cursor-default"
      />
      <div className="bg-surface border-border absolute inset-s-0 top-10 z-50 flex w-80 flex-col overflow-hidden rounded-xl border shadow-lg">
        <div className="border-border border-b p-2">
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('projects.emojiSearch')}
            className={cn(
              'bg-bg border-border text-fg placeholder:text-muted/60 block w-full rounded-lg border px-2.5 py-1.5 text-sm',
              'focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none'
            )}
          />
        </div>
        <div className="max-h-72 overflow-y-auto p-2">
          {groups.length === 0 ? (
            <p className="text-muted px-1 py-4 text-center text-xs">
              {t('projects.emojiNoResults')}
            </p>
          ) : (
            groups.map((group) => (
              <div key={group.label} className="mb-1.5">
                <p className="text-muted px-1 pt-1 pb-0.5 text-[10px] font-medium tracking-wide uppercase">
                  {GROUP_LABEL_KEYS[group.label] ? t(GROUP_LABEL_KEYS[group.label]) : group.label}
                </p>
                <div className="grid grid-cols-9">
                  {group.emojis.map(([emoji, name]) => (
                    <button
                      key={emoji}
                      type="button"
                      title={name}
                      aria-label={name}
                      onClick={() => onPick(emoji)}
                      className="hover:bg-bg flex h-8 w-8 cursor-pointer items-center justify-center rounded-md text-lg leading-none"
                    >
                      {emoji}
                    </button>
                  ))}
                </div>
              </div>
            ))
          )}
        </div>
      </div>
    </>
  )
}
