import { ArrowLeft01Icon, ArrowRight01Icon, File01Icon } from '@/components/core/icons'
import { cn } from '@/lib/utils/cn'
import * as Sharing from 'expo-sharing'
import { Component, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { I18nManager, Pressable, ScrollView, Text, View } from 'react-native'

/**
 * Shared card chrome for every file viewer — the bordered surface, header
 * (icon · name · meta) and footer action row the desktop viewers all share.
 * Mobile collapses the desktop's three file actions (open externally, reveal
 * in folder, download) into one: the system share sheet, which is where
 * "open in…", "save to Files" and "print" live on both platforms.
 */

export type Align = 'start' | 'end'

/** Hand a cached file to the OS — Quick Look / open-in / save, per platform. */
export function shareFile(uri: string | null): void {
  if (!uri) return
  void Sharing.shareAsync(uri).catch(() => {
    // Best-effort: a dismissed or unavailable share sheet is not an error.
  })
}

export function MissingCard({
  label,
  align = 'start'
}: {
  label: string
  align?: Align
}): React.JSX.Element {
  return (
    <View
      className={cn(
        // Same width as the card it replaces — a file going missing must not
        // change the shape of the feed.
        'bg-surface border-border w-[85%] flex-row items-center gap-2 rounded-xl border px-4 py-3 opacity-60',
        align === 'end' ? 'self-end' : 'self-start'
      )}
    >
      <File01Icon size={16} className="text-muted" />
      <Text className="text-muted font-sans text-left text-xs">{label}</Text>
    </View>
  )
}

/** The card surface: bordered, rounded, clipped, chat-bubble width. */
export function CardShell({
  children,
  align = 'start'
}: {
  children: ReactNode
  align?: Align
}): React.JSX.Element {
  return (
    <View
      className={cn(
        'bg-surface border-border w-[85%] flex-col overflow-hidden rounded-2xl border',
        align === 'end' ? 'self-end' : 'self-start'
      )}
    >
      {children}
    </View>
  )
}

export function CardHeader({
  icon,
  name,
  meta
}: {
  icon: ReactNode
  name: string
  meta?: string
}): React.JSX.Element {
  return (
    <View className="flex-row items-center gap-2 px-3 py-2">
      {icon}
      <Text numberOfLines={1} className="text-fg font-sans-medium min-w-0 flex-1 text-left text-xs">
        {name}
      </Text>
      {meta ? <Text className="text-muted font-sans text-[10px]">{meta}</Text> : null}
    </View>
  )
}

/** Footer: a muted label on the leading edge, action buttons trailing. */
export function CardFooter({
  label,
  children
}: {
  label?: string
  children?: ReactNode
}): React.JSX.Element {
  return (
    <View className="border-border flex-row items-center gap-1 border-t px-3 py-1.5">
      <Text numberOfLines={1} className="text-muted font-sans min-w-0 flex-1 text-left text-[10px]">
        {label ?? ''}
      </Text>
      {children}
    </View>
  )
}

/**
 * Renders `children`, or `fallback` if they throw. Agent-authored files are
 * not guaranteed well-formed — a malformed .svg must degrade to its source,
 * never take the whole feed down with it.
 */
export class RenderGuard extends Component<
  { children: ReactNode; fallback: ReactNode },
  { failed: boolean }
> {
  state = { failed: false }

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true }
  }

  render(): ReactNode {
    return this.state.failed ? this.props.fallback : this.props.children
  }
}

/**
 * Previous/next chevrons around a position label — the mobile ViewerPager,
 * mirroring wolffish-app's file-viewer-shell/ViewerPager.
 *
 * The chevrons follow READING direction, not the screen: in Arabic "previous"
 * points right, the same way the back arrows elsewhere in the app flip. That
 * is a property of the app's own direction, not of the document — a deck in
 * English read in an Arabic UI still pages with the Arabic chevrons, because
 * the control belongs to the app.
 */
export function ViewerPager({
  index,
  count,
  onChange
}: {
  /** 0-based position. */
  index: number
  count: number
  onChange: (next: number) => void
}): React.JSX.Element {
  const { t } = useTranslation()
  // I18nManager, not the locale: it is what the layout is ACTUALLY doing. The
  // two disagree between choosing Arabic and the restart that applies it, and
  // during that window flipping on the locale would point "previous" right
  // while the unflipped row still has it on the left. Same source the back
  // arrows in Library and Settings use.
  const isRtl = I18nManager.isRTL
  // Both halves are needed and they are not the same flip: I18nManager already
  // reverses the row, putting "previous" on the right, and this points its
  // chevron that way to match.
  const PrevIcon = isRtl ? ArrowRight01Icon : ArrowLeft01Icon
  const NextIcon = isRtl ? ArrowLeft01Icon : ArrowRight01Icon
  const atStart = index <= 0
  const atEnd = index >= count - 1

  return (
    <View className="flex-row items-center gap-0.5">
      <PagerButton
        label={t('chat.viewerPager.previous')}
        disabled={atStart}
        onPress={() => onChange(index - 1)}
      >
        <PrevIcon size={14} className="text-muted" />
      </PagerButton>
      <PagerButton
        label={t('chat.viewerPager.next')}
        disabled={atEnd}
        onPress={() => onChange(index + 1)}
      >
        <NextIcon size={14} className="text-muted" />
      </PagerButton>
    </View>
  )
}

function PagerButton({
  label,
  disabled,
  onPress,
  children
}: {
  label: string
  disabled: boolean
  onPress: () => void
  children: ReactNode
}): React.JSX.Element {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled }}
      disabled={disabled}
      hitSlop={6}
      onPress={onPress}
      className={cn('rounded p-1.5', disabled ? 'opacity-30' : 'active:opacity-60')}
    >
      {children}
    </Pressable>
  )
}

/**
 * A workbook's sheet tabs — the mobile counterpart of SheetTabs in
 * wolffish-app's SheetGrid, and the reason a workbook card has no pager: a
 * spreadsheet's sheets are named, not numbered, so "Readings" is worth more
 * than "2 of 3" and every sheet is one tap away instead of two chevrons.
 *
 * The strip scrolls horizontally because a workbook with eleven sheets is
 * ordinary and a phone is 390pt wide.
 */
export function SheetTabs({
  names,
  index,
  onSelect
}: {
  names: string[]
  index: number
  onSelect: (next: number) => void
}): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      accessibilityRole="tablist"
      accessibilityLabel={t('chat.spreadsheetViewer.sheets')}
      // grow-0/shrink-0 is load-bearing, not tidiness: a horizontal ScrollView
      // in a column stretches to whatever height is going spare, and then
      // `items-center` centres the tabs in the middle of that gap — which is
      // what the expanded sheet has, and the card (all fixed-height rows) does
      // not. The strip has to size to its own content in both.
      className="border-border grow-0 shrink-0 border-t"
      contentContainerClassName="items-center gap-1 px-2 py-1"
    >
      {names.map((name, i) => (
        <Pressable
          key={`${name}-${i}`}
          accessibilityRole="tab"
          accessibilityState={{ selected: i === index }}
          accessibilityLabel={name}
          hitSlop={4}
          onPress={() => onSelect(i)}
          // bg-primary-soft, not bg-primary/10: an alpha modifier on a var()
          // colour compiles to nothing here, and a dropped background paints
          // black (see global.css) — the token is that composite, precomputed.
          className={cn(
            'shrink-0 rounded px-2 py-0.5',
            i === index ? 'bg-primary-soft' : 'active:opacity-60'
          )}
        >
          <Text
            numberOfLines={1}
            className={cn(
              'text-[11px]',
              i === index ? 'text-primary font-sans-medium' : 'text-muted font-sans'
            )}
          >
            {name}
          </Text>
        </Pressable>
      ))}
    </ScrollView>
  )
}

export function IconAction({
  icon,
  label,
  onPress,
  selected
}: {
  icon: ReactNode
  label: string
  onPress: () => void
  selected?: boolean
}): React.JSX.Element {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={selected === undefined ? undefined : { selected }}
      hitSlop={6}
      onPress={onPress}
      className="rounded p-1.5 active:opacity-60"
    >
      {icon}
    </Pressable>
  )
}
