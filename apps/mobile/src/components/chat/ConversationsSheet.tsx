import { ChannelBadge } from '@/components/conversations/ChannelBadge'
import { chipText, chipTone, Pulse } from '@/components/conversations/ConversationChip'
import {
  AiBrain01Icon,
  Clock01Icon,
  LibraryIcon,
  Notification03Icon,
  Search01Icon,
  Settings02Icon
} from '@/components/core/icons'
import { INPUT_TEXT_ALIGN, WRITING_DIRECTION, rtlPlaceholder } from '@/components/core/Input'
import { UnreadBadge } from '@/components/core/UnreadBadge'
import { groupByRecency } from '@/lib/conversations/grouping'
import { useConversationList } from '@/lib/conversations/hooks'
import {
  buildConversationRows,
  filterConversationRows,
  type ConversationRow
} from '@/lib/conversations/rows'
import { unreadFor, unreadNotifications, useNotifications } from '@/state/notifications'
import { useActiveProject, useProjects } from '@/lib/sync/projects'
import { DEFAULT_PROJECT_ICON } from '@/components/workspace/ProjectDialog'
import { cn } from '@/lib/utils/cn'
import { useChatRuntime } from '@/state/chatRuntime'
import { useRunStatus } from '@/state/runStatus'
import { useTheme, useTokens } from '@/providers/theme/useTheme'
import { BlurView } from 'expo-blur'
import { router } from 'expo-router'
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Animated,
  Easing,
  I18nManager,
  Keyboard,
  Modal,
  Pressable,
  SectionList,
  StyleSheet,
  Text,
  TextInput,
  useWindowDimensions,
  View
} from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'

/**
 * The chat screen's navigator — the desktop's right-hand ConversationsSidebar,
 * turned into a sheet that comes in from the LEADING edge (left in LTR, right
 * in RTL, mirrored by direction rather than hard-coded).
 *
 * Two halves, in the desktop's own order:
 *
 *  - the pages that are not settings knobs but places you GO (the Library,
 *    Customization and the full Conversations page, plus Settings itself),
 *    each with the icon the desktop's sheet gives it;
 *  - every conversation, grouped by the same recency buckets under the same
 *    labels, each row a numbered status chip + origin badge + one line of title.
 *
 * Only the second half scrolls. The pages are a fixed header ABOVE the list
 * rather than the list's own ListHeaderComponent: they are the sheet's
 * destinations, and a destination that scrolls off the top of its own navigator
 * is one the user has to scroll back up to find. The list gets the space that
 * is left and scrolls inside it.
 *
 * The chip is the whole state readout, exactly as on the desktop: it counts the
 * conversation's rank in the WHOLE list — among the matches, while a search is
 * typed — continuing across the date headers rather than restarting under
 * each, and it is tinted by what the last turn in
 * that conversation did — pale primary while one is running (pulsing) or while
 * the row is the open one, then success / error / stopped for as long as that
 * is fresh. See lib/conversations/rows.ts for where those phases come from.
 *
 * The list is windowed rather than paged: the index is already in memory (it is
 * one SQLite read), so "infinite scroll" here means rendering the first PAGE
 * rows and growing the window as the user reaches the end. The rank numbers are
 * computed after the slice, so they are the same numbers the full list would
 * have given — a window never renumbers anything.
 */

/** Rows rendered before the first scroll, and rows added per reach-the-end. */
const PAGE = 40

/** Panel width, capped so it never swallows a tablet's whole screen. */
const MAX_WIDTH = 340
const WIDTH_RATIO = 0.86

/** Enter/exit duration. Short: this sheet is a menu, not a destination. */
const SLIDE_MS = 200

/**
 * The pages the sheet links to, in the desktop sheet's order. Automations,
 * Projects and Procedures are one Library row — the three lists are tabs of
 * one screen now, as on the desktop — so the sheet carries three destinations
 * where it carried five.
 *
 * Notifications sits ABOVE Settings, at the very top. It is the only row here
 * that can be waiting on you: everything below is somewhere you decide to go,
 * and a page that carries an unread count belongs where the count is seen
 * first. It is also the only row that gets a badge — see NAV_BADGE.
 */
const NAV = [
  {
    key: 'notifications',
    href: '/notifications',
    Icon: Notification03Icon,
    labelKey: 'notifications.title'
  },
  { key: 'settings', href: '/settings', Icon: Settings02Icon, labelKey: 'settings.title' },
  {
    key: 'library',
    href: '/settings/library',
    Icon: LibraryIcon,
    labelKey: 'settings.tabs.library'
  },
  {
    key: 'customization',
    href: '/settings/customization',
    Icon: AiBrain01Icon,
    labelKey: 'settings.tabs.customization'
  },
  // The full Conversations page — delete and the diagnostic export, which the
  // list below cannot do — last, where the desktop's sheet keeps it. It used to
  // live in Settings, but it is a place you go, not a knob you turn.
  {
    key: 'conversations',
    href: '/history',
    Icon: Clock01Icon,
    labelKey: 'settings.tabs.conversations'
  }
] as const

/** The one nav row that carries a count: unread notifications, the same mark
 *  the conversation rows below wear and the same number on the app icon. */
const NAV_BADGE = 'notifications'

/**
 * One conversation. The chip carries the number and the state; the badge hangs
 * off its bottom-trailing corner, outside the circle, so it never crowds a
 * three-digit rank; the title is one line, truncated, and nothing else is on
 * the row — a phone rail has no width for a second line and the date header
 * above already says when.
 */
const Row = memo(function Row({
  row,
  position,
  active,
  onPress
}: {
  row: ConversationRow
  position: number
  active: boolean
  onPress: (id: string) => void
}): React.JSX.Element {
  // Subscribed per row, so a badge changing re-renders exactly the row it
  // marks. The active row can briefly hold a count mid-clear; hiding it there
  // keeps the clear from flashing a badge on the conversation being read.
  const unread = useNotifications((state) => (active ? 0 : unreadFor(state, row.id)))
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={row.title}
      accessibilityState={{ selected: active }}
      onPress={() => onPress(row.id)}
      className={cn(
        'flex-row items-center gap-2.5 rounded-lg border px-1.5 py-1.5 active:bg-surface',
        active && 'bg-surface border-border'
      )}
      // The border is reserved in BOTH states so selecting a row never reflows
      // the list — but the unselected one has to be told, inline, that its
      // reserved border is invisible. `border-transparent` does not survive
      // NativeWind here, and a `border` width with no colour is BLACK in React
      // Native: every row the user was not in drew a hard outline.
      style={active ? undefined : { borderColor: 'transparent' }}
    >
      <Pulse active={row.phase === 'processing'}>
        <View className="relative">
          <View
            className={cn(
              'h-6 w-6 items-center justify-center rounded-full border',
              chipTone(row.phase, active)
            )}
          >
            <Text
              className={cn('font-sans-semibold text-[8px]', chipText(row.phase, active))}
              // The rank is a number in every locale — Arabic included, where
              // the surrounding text runs the other way.
              style={{ writingDirection: 'ltr' }}
            >
              {position}
            </Text>
          </View>
          {/* Outside the circle, hanging off its bottom-trailing corner, so it
              clears the digits. `insetInlineEnd` rather than a left/right pair:
              it is direction-aware in Yoga and untouched by RN's left/right
              swap, so it needs no isRTL branch — and a branch is exactly what
              flipped this back to the leading side under RTL. Inline rather
              than by class because a negative utility is the one place
              NativeWind's output is worth not betting on. */}
          <View
            pointerEvents="none"
            className="items-center justify-center"
            style={{
              position: 'absolute',
              bottom: -5,
              insetInlineEnd: -5,
              width: 14,
              height: 14
            }}
          >
            <ChannelBadge icon={row.icon} channel={row.channel} size={9} />
          </View>
        </View>
      </Pulse>
      <Text
        numberOfLines={1}
        className={cn('flex-1 text-left font-sans text-xs', active ? 'text-fg' : 'text-muted')}
      >
        {row.title}
      </Text>
      <UnreadBadge count={unread} />
    </Pressable>
  )
})

export type ConversationsSheetProps = {
  open: boolean
  onClose: () => void
  /** The conversation the chat screen is showing, if any — the selected row. */
  activeId: string | null
  /** Open a conversation. The screen swaps it in place; the sheet just asks. */
  onSelect: (conversationId: string) => void
}

/**
 * The sheet's shell: whether it is on screen at all, and the slide.
 *
 * ON SCREEN IS A PURE FUNCTION OF `open`, and that is not a style choice — it
 * is the fix for the worst bug this component has had. The panel used to leave
 * on its own slide-out, which meant the Modal stayed mounted past `open` and
 * came down from an ANIMATION COMPLETION CALLBACK. Every run where that
 * callback did not arrive — the animation stopped by an effect re-run, the
 * native view detached because a screen was pushed over it (the sheet's own
 * Projects link does exactly that), a re-render heavy enough to interrupt it
 * (selecting a conversation remounts the whole feed) — left a full-screen,
 * fully transparent Modal presented over the app. It looked like nothing was
 * there and it swallowed every touch: the composer, the floating buttons, the
 * sheet's own trigger. "All the buttons froze" is precisely what that is.
 *
 * So the Modal is presented exactly while `open` is true, and the only leaving
 * animation is the one RN drives itself, natively, with no JS state to strand
 * (`animationType="fade"`). The slide is enter-only and nothing depends on its
 * callback.
 *
 * Everything that COSTS something — the conversation index, the project list,
 * the live turns, the rows built from all three — lives in the body below,
 * which only exists while the sheet does. A navigator that subscribes to the
 * whole conversation list from behind a closed door is a navigator that
 * re-renders the chat screen every time a turn writes a word.
 */
export function ConversationsSheet({
  open,
  onClose,
  activeId,
  onSelect
}: ConversationsSheetProps): React.JSX.Element | null {
  const { isDark } = useTheme()
  const tokens = useTokens()
  const { width: screenWidth } = useWindowDimensions()
  const width = Math.min(MAX_WIDTH, Math.round(screenWidth * WIDTH_RATIO))

  // Enter only. Reset to 0 while closed so the next open starts off-screen
  // rather than wherever the last one finished.
  const progress = useRef(new Animated.Value(0)).current
  useEffect(() => {
    if (!open) {
      progress.setValue(0)
      return
    }
    const animation = Animated.timing(progress, {
      toValue: 1,
      duration: SLIDE_MS,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true
    })
    animation.start()
    return () => animation.stop()
  }, [open, progress])

  if (!open) return null

  /**
   * Off-screen, away from the edge it is anchored to.
   *
   * PHYSICAL, unlike everything else here: React Native does not mirror
   * transforms under RTL — a translateX of -width moves left on both sides of
   * the world — so this is the one place the direction has to be asked for by
   * name. The anchoring itself is the row below, which mirrors on its own.
   */
  const hidden = I18nManager.isRTL ? width : -width
  const panelSlide = {
    transform: [
      { translateX: progress.interpolate({ inputRange: [0, 1], outputRange: [hidden, 0] }) }
    ]
  }

  return (
    <Modal visible transparent animationType="fade" onRequestClose={onClose}>
      <View style={StyleSheet.absoluteFill}>
        {/* The same glass backdrop the dialogs use. Static: the Modal's own
            fade carries it in and out, so it holds no state of its own. */}
        <BlurView
          pointerEvents="none"
          intensity={20}
          tint={isDark ? 'dark' : 'light'}
          blurMethod="dimezisBlurView"
          style={StyleSheet.absoluteFill}
        />
        <View pointerEvents="none" className="absolute inset-0 bg-black/40" />
        <Pressable accessibilityRole="none" onPress={onClose} style={StyleSheet.absoluteFill} />
        {/**
         * The panel sits at the LEADING edge — left in LTR, right in RTL — and
         * it gets there by being the first child of a `flex-row`, which React
         * Native reverses under RTL on its own.
         *
         * Not by `left`/`right`, which is what put it on the same physical side
         * in both directions: RN's doLeftAndRightSwapInRTL (on by default)
         * already swaps those two, so asking for `right` under RTL is asking
         * for the left edge — and branching on isRTL to pick between them flips
         * it a second time, back to where it started. A row has no side to
         * name, so there is nothing to get backwards.
         */}
        <View pointerEvents="box-none" style={StyleSheet.absoluteFill} className="flex-row">
          <Animated.View
            style={[
              { width },
              panelSlide,
              // The subtle vertical rule between the sheet and the conversation
              // behind it, on the panel's trailing edge. `borderEndWidth` is
              // direction-aware in Yoga and is NOT part of the left/right swap,
              // so it lands on the inward-facing edge either way — and the
              // colour comes from the token rather than a class so the two
              // halves of one border cannot be resolved by different rules.
              { borderEndWidth: 1, borderColor: tokens.borderSoft }
            ]}
            className="bg-bg"
          >
            <SheetBody activeId={activeId} onClose={onClose} onSelect={onSelect} />
          </Animated.View>
        </View>
      </View>
    </Modal>
  )
}

function SheetBody({
  activeId,
  onClose,
  onSelect
}: Omit<ConversationsSheetProps, 'open'>): React.JSX.Element {
  const { t } = useTranslation()
  const insets = useSafeAreaInsets()
  const tokens = useTokens()
  const { data: metas } = useConversationList()
  // The whole inbox's unread count, on the one row that leads to it.
  const unread = useNotifications(unreadNotifications)
  const { data: projects } = useProjects()
  const live = useChatRuntime((state) => state.streams)
  const runs = useRunStatus((state) => state.runs)
  // Project mode narrows this list to the project, exactly as it narrows the
  // desktop's rail: inside a project, the conversations that are not in it are
  // not what "my conversations" means.
  const activeProject = useActiveProject()

  const untitled = t('chat.conversationsUntitled')
  const rows = useMemo(() => {
    const all = buildConversationRows({ metas: metas ?? [], live, runs, projects, untitled })
    if (!activeProject) return all
    // The open conversation bridges through on its id. A conversation created
    // inside the project a moment ago may not carry projectId in this phone's
    // index yet — the desktop stamps it at creation and the row follows — and
    // the one you are looking at must never fall out of the list you are
    // looking at it from. Same bridge the desktop rail uses.
    return all.filter((row) => row.projectId === activeProject.id || row.id === activeId)
  }, [metas, live, runs, projects, untitled, activeProject, activeId])

  // Title search over the conversations — never over the pages above them,
  // which are the way OUT of chat and must stay where they are. Cleared on
  // every open for free, like the window: this component mounts with the sheet.
  const [query, setQuery] = useState('')
  // Filtered BEFORE the window, so a match that sits at row 500 is on screen
  // at once rather than after a dozen reach-the-ends.
  const visible = useMemo(() => filterConversationRows(rows, query), [rows, query])

  // The window, grown as the user reaches the end rather than fetched by page —
  // there is only one list and it is already in memory. It starts small on
  // every open for free: this component is mounted with the sheet.
  const [limit, setLimit] = useState(PAGE)
  const windowed = useMemo(() => visible.slice(0, limit), [visible, limit])
  const groups = useMemo(() => groupByRecency(windowed, (row) => row.at), [windowed])
  const more = visible.length > windowed.length
  const loadMore = useCallback(() => {
    if (more) setLimit((current) => current + PAGE)
  }, [more])

  // Both ways out put the keyboard away first. The Modal fades rather than
  // vanishing, and a keyboard raised by the search field would otherwise ride
  // that fade over the conversation (or page) the user just picked.
  const select = useCallback(
    (id: string) => {
      Keyboard.dismiss()
      onClose()
      onSelect(id)
    },
    [onClose, onSelect]
  )

  // Navigate AFTER asking the sheet to close: the pushed screen renders behind
  // a Modal that is still on its way out, and would otherwise be invisible
  // until something else dismissed it.
  const go = useCallback(
    (href: string) => {
      Keyboard.dismiss()
      onClose()
      router.push(href as never)
    },
    [onClose]
  )

  return (
    <View className="flex-1">
      {/* Fixed. It carries the top inset and the horizontal padding the list's
          content container used to give it, so the pages sit exactly where they
          did — the only thing that changed is that they no longer move. */}
      <View
        className="flex-col gap-0.5 pb-1"
        style={{ paddingTop: insets.top + 12, paddingHorizontal: 10 }}
      >
        {NAV.map(({ key, href, Icon, labelKey }) => (
          <Pressable
            key={key}
            accessibilityRole="button"
            accessibilityLabel={t(labelKey)}
            onPress={() => go(href)}
            className="flex-row items-center gap-2.5 rounded-lg px-1.5 py-2.5 active:bg-surface"
          >
            <View className="h-6 w-6 items-center justify-center">
              <Icon size={17} className="text-muted" />
            </View>
            {/* min-w-0 with flex-1: the label is the growing half of the row,
                and without it a long one pushes the badge off the panel
                instead of truncating itself. */}
            <Text
              numberOfLines={1}
              className="text-fg font-sans-medium min-w-0 flex-1 text-left text-[13px]"
            >
              {t(labelKey)}
            </Text>
            {key === NAV_BADGE && <UnreadBadge count={unread} />}
          </Pressable>
        ))}
        {/* The rule between what you MAKE and what you have SAID. It stays with
            the pages rather than the list: it is the lid the conversations
            scroll under, and a scrolling rule is just another row. */}
        <View className="border-border-soft mx-1.5 mt-2 border-t" />
        {/* Inside a project the list below is only that project's, so it says
            whose it is. Without this the list simply looks short, which is
            indistinguishable from conversations having gone missing. */}
        {activeProject && (
          <View className="flex-row items-center gap-1.5 px-1.5 pt-3">
            <Text className="text-[11px] leading-none">
              {activeProject.icon || DEFAULT_PROJECT_ICON}
            </Text>
            <Text
              numberOfLines={1}
              className="text-muted font-sans-medium min-w-0 flex-1 text-left text-[10px] uppercase"
            >
              {activeProject.title.trim() || t('projects.untitled')}
            </Text>
          </View>
        )}
        {/* Fixed with the pages rather than scrolled with the list: it is what
            the list is being steered WITH, so it stays on screen while the
            results move. Only there once there is something to search, and
            never autofocused — opening the sheet to go somewhere must not
            raise a keyboard over the way there. */}
        {rows.length > 0 && (
          <View className="border-border bg-surface mx-1.5 mt-3 h-9 flex-row items-center gap-2 rounded-lg border px-2.5">
            <Search01Icon size={14} className="text-muted" />
            <TextInput
              value={query}
              onChangeText={(text) => {
                setQuery(text)
                // A new query is a new list — start it at one window again,
                // or a wide search inherits every row the last scroll grew.
                setLimit(PAGE)
              }}
              placeholder={rtlPlaceholder(t('history.searchPlaceholder'))}
              accessibilityLabel={t('history.searchPlaceholder')}
              placeholderTextColor={tokens.muted}
              selectionColor={tokens.accent}
              autoCapitalize="none"
              autoCorrect={false}
              returnKeyType="search"
              clearButtonMode="while-editing"
              style={WRITING_DIRECTION}
              className={cn('text-fg h-9 flex-1 font-sans text-xs', INPUT_TEXT_ALIGN)}
            />
          </View>
        )}
      </View>
      {/* The one scroller. `flex: 1` rather than nothing: a virtualized list in
          a column with a sibling above it sizes to its CONTENT unless it is told
          to take what is left, which is how a long list ends up overflowing the
          panel instead of scrolling inside it. */}
      <SectionList
        style={{ flex: 1 }}
        sections={groups}
        keyExtractor={(row) => row.id}
        // The desktop's headers scroll away with their group rather than
        // pinning; RN sticks them on iOS by default.
        stickySectionHeadersEnabled={false}
        onEndReached={loadMore}
        onEndReachedThreshold={0.6}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
        // Scrolling puts the search keyboard away, so a long result list is
        // reachable to its end instead of ending behind the keys.
        keyboardDismissMode="on-drag"
        contentContainerStyle={{ paddingBottom: insets.bottom + 16, paddingHorizontal: 10 }}
        renderSectionHeader={({ section }) => (
          <Text
            className={cn(
              'text-muted font-sans-medium px-1.5 pb-1 text-left text-[10px] uppercase',
              // Only the first group sits directly under the divider; every
              // later one gets the gap that separates it from the rows above.
              section.startIndex > 1 ? 'pt-4' : 'pt-3'
            )}
          >
            {t(section.labelKey)}
          </Text>
        )}
        renderItem={({ item, index, section }) => (
          <Row
            row={item}
            // Rank in the WHOLE list — the chip keeps counting past the group
            // headers rather than restarting at 1 under each.
            position={section.startIndex + index}
            active={item.id === activeId}
            onPress={select}
          />
        )}
        ListEmptyComponent={
          <Text className="text-muted px-1.5 pt-3 text-left font-sans text-xs">
            {rows.length === 0 ? t('history.empty') : t('history.searchEmpty')}
          </Text>
        }
      />
    </View>
  )
}
