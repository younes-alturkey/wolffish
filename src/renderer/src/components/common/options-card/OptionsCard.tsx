import { CopyButton } from '@components/core/CopyButton'
import { Markdown } from '@components/core/Markdown'
import { RTL_LOCALES } from '@lib/i18n'
import { cn } from '@lib/utils/cn'
import { useLocale } from '@providers/locale/useLocale'
import { SourceCodeIcon } from 'hugeicons-react'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

/**
 * The agent offers the user several alternative pieces of content — code,
 * commands, config, drafts (the `offer_options` tool). One card in the chat:
 * a horizontally scrolling row of lettered tabs (A, B, C …) across the top,
 * each labelled with that option's short title, and the selected option's
 * body underneath, rendered as markdown. A code body is copied by the `pre`'s
 * own hover button (the Markdown renderer puts one on every fenced block);
 * the card adds a copy button of its own only for bodies that have none —
 * markdown prose, tables, lists.
 *
 * Purely presentational and entirely model-led — the user never answers it,
 * so unlike the QuestionCard there is no live state and no response path.
 * Everything it draws comes from the persisted `tool_call` args, which is
 * why a reopened conversation renders it identically to the live turn, with
 * no extra state to persist. It renders on the clean feed too: the card is
 * content the model produced FOR the user, not tool mechanics.
 */

export type OptionItem = {
  title: string
  description?: string
  /** Set when `content` is raw code — the body is fenced with it so it
   *  highlights. Absent means the content is markdown already. */
  language?: string
  content: string
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

/**
 * The tab letter for position i: A…Z, then AA, AB … — the spreadsheet column
 * scheme. Mirrors the plugin's `optionLetter` (and the mobile + CLI cards) so
 * the letter the model names in its reply is the letter on screen. Kept
 * module-private (this file exports a component); the cross-surface parity
 * test in `main/channels/__tests__/options-card.test.ts` reads it out of this
 * source rather than importing it, so a drifted copy still fails loudly.
 */
function optionLetter(index: number): string {
  let n = index
  let out = ''
  do {
    out = String.fromCharCode(65 + (n % 26)) + out
    n = Math.floor(n / 26) - 1
  } while (n >= 0)
  return out
}

/**
 * Recover the options from the persisted tool_call args. Deliberately
 * tolerant — the same synonyms the plugin accepts (a bare string option,
 * `label`/`code`/`text`/`value`) must render, or a card the user saw live
 * would come back empty from history.
 */
function parseOptions(raw: unknown): OptionItem[] {
  if (!Array.isArray(raw)) return []
  const out: OptionItem[] = []
  for (const item of raw) {
    if (typeof item === 'string') {
      const content = item.trim()
      if (content) out.push({ title: `Option ${optionLetter(out.length)}`, content })
      continue
    }
    if (!item || typeof item !== 'object') continue
    const r = item as Record<string, unknown>
    const content =
      asString(r.content).trim() ||
      asString(r.code).trim() ||
      asString(r.text).trim() ||
      asString(r.value).trim()
    if (!content) continue
    const title = asString(r.title).trim() || asString(r.label).trim()
    const description = asString(r.description).trim()
    const language = asString(r.language).trim() || asString(r.lang).trim()
    out.push({
      title: title || `Option ${optionLetter(out.length)}`,
      ...(description ? { description } : {}),
      ...(language ? { language } : {}),
      content
    })
  }
  return out
}

/**
 * The markdown the body renders. A `language` means the content is raw code,
 * so it gets fenced here rather than by the model — with a fence long enough
 * to survive content that contains backtick fences of its own.
 */
function bodyMarkdown(option: OptionItem): string {
  if (!option.language) return option.content
  const longest = (option.content.match(/`{3,}/g) ?? []).reduce(
    (max, run) => Math.max(max, run.length),
    2
  )
  const fence = '`'.repeat(Math.max(3, longest + 1))
  return `${fence}${option.language}\n${option.content}\n${fence}`
}

/**
 * Whether the rendered body is ONE code block and nothing else — in which
 * case the Markdown renderer's own `pre` already carries a copy button for
 * exactly this content, and a second card-level button would copy the same
 * bytes from two places a centimetre apart.
 *
 * True by construction when `language` is set (bodyMarkdown wraps the whole
 * content in one fence). Otherwise the content is the model's own markdown,
 * which may ALREADY be a lone fenced block — so check for that too, strictly:
 * an opening fence, a closing fence at least as long, and no fence of that
 * length at column 0 in between (which would mean two blocks, or prose
 * between them, and no single button covering the body).
 */
function bodyIsLoneCodeBlock(option: OptionItem): boolean {
  if (option.language) return true
  const match = /^(`{3,})[^\n]*\n([\s\S]*)\n(`{3,})$/.exec(option.content.trim())
  if (!match) return false
  const [, open, inner, close] = match
  if (close.length < open.length) return false
  const innerFence = new RegExp(`^\`{${open.length},}`, 'm')
  return !innerFence.test(inner)
}

export function OptionsCard({ args }: { args: Record<string, unknown> }): React.JSX.Element | null {
  const { t } = useTranslation()
  const { locale } = useLocale()
  const isRtl = RTL_LOCALES.has(locale)
  const [activeIdx, setActiveIdx] = useState(0)

  // The tab row scrolls horizontally and never wraps — keep the active tab in
  // view when the user clicks one that is partly past an edge. Row-local
  // scrollBy ONLY, never scrollIntoView: this effect fires on mount too, and
  // scrollIntoView walks every scrollable ancestor, so a card sitting
  // mid-transcript would drag the whole feed up to itself instead of leaving
  // it pinned to the bottom (the same trap the QuestionCard documents).
  // scrollBy deltas are visual, so the math holds under dir="rtl" as well.
  const tabsRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    const row = tabsRef.current
    if (!row || row.children.length === 0) return
    const tab = row.children[Math.min(activeIdx, row.children.length - 1)] as
      | HTMLElement
      | undefined
    if (!tab) return
    const rowBox = row.getBoundingClientRect()
    const tabBox = tab.getBoundingClientRect()
    const pastEnd = tabBox.right - rowBox.right
    const beforeStart = tabBox.left - rowBox.left
    if (pastEnd > 0) row.scrollBy({ left: pastEnd, behavior: 'smooth' })
    else if (beforeStart < 0) row.scrollBy({ left: beforeStart, behavior: 'smooth' })
  }, [activeIdx])

  const options = parseOptions(args.options)
  // Nothing usable from the model — don't surface an empty shell.
  if (options.length === 0) return null

  const cardTitle = asString(args.title).trim()
  const current = Math.min(activeIdx, options.length - 1)
  const active = options[current]

  return (
    <div
      dir={isRtl ? 'rtl' : 'ltr'}
      className="border-border bg-surface w-full max-w-[85%] self-start rounded-2xl border px-4 py-3 text-sm"
    >
      <div className="mb-2.5 flex items-start gap-2">
        <SourceCodeIcon size={18} className="text-accent mt-0.5 shrink-0" />
        <p className="text-fg min-w-0 flex-1 text-base font-semibold leading-snug">
          {cardTitle || t('chat.optionsCard.heading', { count: options.length })}
        </p>
        <span className="text-muted inline-flex h-6 shrink-0 items-center text-xs">
          {t('chat.optionsCard.optionCount', { current: current + 1, total: options.length })}
        </span>
      </div>

      {/* One line, never wraps: the row grows to the tabs' total width and
          scrolls horizontally inside the available card width. The scrollbar
          is hidden (still scrollable by wheel/drag, plus the follow effect
          above) — the global stylesheet otherwise reserves an 8px gutter
          inside the scroller, which would make this row taller than its
          tabs. */}
      <div
        ref={tabsRef}
        role="tablist"
        aria-label={t('chat.optionsCard.tabsLabel')}
        className="mb-3 flex items-center gap-1.5 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      >
        {options.map((option, i) => {
          const isActive = i === current
          return (
            <button
              key={i}
              type="button"
              role="tab"
              aria-selected={isActive}
              title={option.title}
              onClick={() => setActiveIdx(i)}
              className={cn(
                'flex h-7 shrink-0 cursor-pointer items-center gap-1.5 rounded-lg border px-2 text-xs font-medium',
                isActive
                  ? 'border-accent bg-accent/10 text-accent'
                  : 'border-border bg-bg/40 text-muted hover:bg-bg'
              )}
            >
              <span
                className={cn(
                  'flex h-4 w-4 shrink-0 items-center justify-center rounded text-[10px] font-semibold',
                  isActive ? 'bg-accent text-white' : 'bg-primary/10 text-primary'
                )}
              >
                {optionLetter(i)}
              </span>
              <span className="whitespace-nowrap">{option.title}</span>
            </button>
          )
        })}
      </div>

      <div className="border-border bg-bg/40 rounded-xl border px-3 py-2.5">
        <div className="mb-1.5 flex items-start gap-2">
          <span className="min-w-0 flex-1">
            <span className="text-fg block font-medium leading-snug">{active.title}</span>
            {active.description ? (
              <span className="text-muted mt-0.5 block text-xs leading-snug">
                {active.description}
              </span>
            ) : null}
          </span>
          {/* Only when the body has no copy control of its own. A code body is
              rendered as one `pre`, which already hovers its own copy button
              over exactly this content — a second button here would be the
              same bytes twice. Markdown prose, tables and lists have no such
              button, so there the card supplies it. */}
          {bodyIsLoneCodeBlock(active) ? null : (
            <CopyButton
              text={active.content}
              variant="inline"
              ariaLabelKey="chat.optionsCard.copy"
              className="mt-px shrink-0"
            />
          )}
        </div>
        {/* Keyed on the tab so switching options remounts the markdown rather
            than diffing one body into another — a code block and a table
            share no structure, and the stale-subtree flashes that causes are
            worse than the remount. */}
        <div key={current} className="text-fg min-w-0 text-sm">
          <Markdown content={bodyMarkdown(active)} />
        </div>
      </div>
    </div>
  )
}
