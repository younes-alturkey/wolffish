import { Copy01Icon, SourceCodeIcon } from '@/components/core/icons'
import { MarkdownView } from '@/components/chat/MarkdownView'
import type { ToolCallInfo } from '@/lib/conversations/segments'
import { cn } from '@/lib/utils/cn'
import { memo, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import * as Clipboard from 'expo-clipboard'
import { Pressable, ScrollView, Text, View } from 'react-native'

/**
 * The agent offers the user several alternative pieces of content — code,
 * commands, config, drafts (the `offer_options` tool). A port of the desktop's
 * OptionsCard, rule for rule: a horizontally scrolling row of lettered tabs
 * (A, B, C …) on top, each labelled with that option's short title, and the
 * selected option's body underneath, rendered as markdown, with a copy button
 * that puts the RAW content on the clipboard.
 *
 * Purely presentational and entirely model-led — the user never answers it, so
 * unlike the QuestionCard there is no live state and no response path.
 * Everything it draws comes from the persisted `tool_call` args, which is why
 * it renders identically live, on a reload, and on every other surface.
 */

type OptionItem = {
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
 * scheme, mirrored by the plugin and every other renderer so the letter the
 * model names in its reply is the letter on screen.
 */
export function optionLetter(index: number): string {
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
 * `label`/`code`/`text`/`value`) must render, or a card the user saw on the
 * desktop would come back empty here.
 */
export function parseOptionItems(raw: unknown): OptionItem[] {
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
export function bodyMarkdown(option: OptionItem): string {
  if (!option.language) return option.content
  const longest = (option.content.match(/`{3,}/g) ?? []).reduce(
    (max, run) => Math.max(max, run.length),
    2
  )
  const fence = '`'.repeat(Math.max(3, longest + 1))
  return `${fence}${option.language}\n${option.content}\n${fence}`
}

export const OptionsCard = memo(function OptionsCard({
  call
}: {
  call: ToolCallInfo
}): React.JSX.Element | null {
  const { t } = useTranslation()
  const [activeIdx, setActiveIdx] = useState(0)
  const [copied, setCopied] = useState(false)
  // The tab row scrolls horizontally and never wraps — keep the active tab in
  // view when a tap lands on one that is partly past an edge. Offsets are
  // collected on layout, exactly as the QuestionCard's chip row does it.
  const tabsRef = useRef<ScrollView | null>(null)
  const tabOffsets = useRef<number[]>([])

  const options = parseOptionItems(call.args.options)
  const total = options.length
  const current = Math.min(activeIdx, Math.max(total - 1, 0))

  useEffect(() => {
    const x = tabOffsets.current[current]
    if (typeof x === 'number') tabsRef.current?.scrollTo({ x: Math.max(x - 24, 0), animated: true })
  }, [current])

  // The copied checkmark clears itself; drop the timer if the card unmounts
  // first (a reopened conversation remounts the whole feed).
  useEffect(() => {
    if (!copied) return
    const timer = setTimeout(() => setCopied(false), 1500)
    return () => clearTimeout(timer)
  }, [copied])

  // Nothing usable from the model — don't surface an empty shell.
  if (total === 0) return null

  const cardTitle = asString(call.args.title).trim()
  const active = options[current]

  return (
    <View className="border-border bg-surface w-full max-w-[85%] self-start rounded-2xl border px-4 py-3">
      <View className="mb-2.5 flex-row items-start gap-2">
        <SourceCodeIcon size={18} className="text-accent mt-0.5 shrink-0" />
        <Text className="text-fg font-sans-semibold min-w-0 flex-1 text-left text-base">
          {cardTitle || t('chat.optionsCard.heading', { count: total })}
        </Text>
        <Text className="text-muted h-6 shrink-0 font-sans text-xs leading-6">
          {t('chat.optionsCard.optionCount', { current: current + 1, total })}
        </Text>
      </View>

      {/* One line, never wraps: the row scrolls horizontally inside the
          available card width, like the desktop card's tab row. */}
      <ScrollView
        ref={tabsRef}
        horizontal
        showsHorizontalScrollIndicator={false}
        className="mb-3"
        contentContainerStyle={{ alignItems: 'center', gap: 6 }}
      >
        {options.map((option, i) => {
          const isActive = i === current
          return (
            <Pressable
              key={i}
              accessibilityRole="button"
              accessibilityState={{ selected: isActive }}
              accessibilityLabel={option.title}
              onLayout={(event) => {
                tabOffsets.current[i] = event.nativeEvent.layout.x
              }}
              onPress={() => setActiveIdx(i)}
              className={cn(
                // Desktop tones are bg-accent/10 and bg-bg/40 — precomputed
                // tokens here, because an alpha modifier on a var() color
                // silently drops in RN and a dropped BORDER color paints black
                // (see global.css).
                'h-7 shrink-0 flex-row items-center gap-1.5 rounded-lg border px-2',
                isActive ? 'border-accent bg-accent-soft' : 'border-border bg-bg-soft'
              )}
            >
              <View
                className={cn(
                  'h-4 w-4 shrink-0 items-center justify-center rounded',
                  isActive ? 'bg-accent' : 'bg-primary-soft'
                )}
              >
                <Text
                  className={cn(
                    'font-sans-semibold text-[10px]',
                    isActive ? 'text-white' : 'text-primary'
                  )}
                >
                  {optionLetter(i)}
                </Text>
              </View>
              <Text
                numberOfLines={1}
                className={cn('font-sans-medium text-xs', isActive ? 'text-accent' : 'text-muted')}
              >
                {option.title}
              </Text>
            </Pressable>
          )
        })}
      </ScrollView>

      <View className="border-border bg-bg-soft rounded-xl border px-3 py-2.5">
        <View className="mb-1.5 flex-row items-start gap-2">
          <View className="min-w-0 flex-1 flex-col">
            <Text className="text-fg font-sans-medium text-left text-sm">{active.title}</Text>
            {active.description ? (
              <Text className="text-muted mt-0.5 text-left font-sans text-xs">
                {active.description}
              </Text>
            ) : null}
          </View>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t('chat.optionsCard.copy')}
            hitSlop={8}
            onPress={() => {
              void Clipboard.setStringAsync(active.content).then(() => setCopied(true))
            }}
            className="border-border bg-surface shrink-0 rounded-md border p-1"
          >
            <Copy01Icon size={14} className={copied ? 'text-emerald-600' : 'text-muted'} />
          </Pressable>
        </View>
        {/* Keyed on the tab so switching options remounts the markdown rather
            than diffing one body into another — a code block and a table share
            no structure, and the stale-subtree flashes that causes are worse
            than the remount. */}
        <MarkdownView key={current}>{bodyMarkdown(active)}</MarkdownView>
      </View>
    </View>
  )
})
