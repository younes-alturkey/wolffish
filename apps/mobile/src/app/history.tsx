import {
  ArrowLeft01Icon,
  ArrowRight01Icon,
  Bug01Icon,
  Delete01Icon,
  Search01Icon
} from '@/components/core/icons'
import { INPUT_TEXT_ALIGN, WRITING_DIRECTION, rtlPlaceholder } from '@/components/core/Input'
import { ChannelBadge } from '@/components/conversations/ChannelBadge'
import { chipText, chipTone, Pulse } from '@/components/conversations/ConversationChip'
import { UnreadBadge } from '@/components/core/UnreadBadge'
import { unreadFor, useNotifications } from '@/state/notifications'
import { DiagnosticExportOverlay } from '@/components/conversations/DiagnosticExportOverlay'
import { ConfirmDialog } from '@/components/core/ConfirmDialog'
import { HistorySkeleton } from '@/components/history/HistorySkeleton'
import { groupByRecency } from '@/lib/conversations/grouping'
import { removeConversation, useConversationList } from '@/lib/conversations/hooks'
import {
  buildConversationRows,
  filterConversationRows,
  type ConversationRow
} from '@/lib/conversations/rows'
import { useProjects } from '@/lib/sync/projects'
import { goBack } from '@/lib/utils/back'
import { cn } from '@/lib/utils/cn'
import { useChatRuntime } from '@/state/chatRuntime'
import { useRunStatus } from '@/state/runStatus'
import { useDesktopReachable } from '@/lib/tunnel/useTunnelStatus'
import { formatRelativeTime } from '@/lib/utils/relativeTime'
import { useTokens } from '@/providers/theme/useTheme'
import { router } from 'expo-router'
import { memo, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { I18nManager, Keyboard, Pressable, SectionList, Text, TextInput, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'

/**
 * Conversation history — the desktop History page as a single-column list:
 * date-grouped under the same recency headers, numbered recency chip tinted by
 * what the last turn did, channel/source badge, title, relative time, delete
 * with the desktop's confirm copy. Rows open the conversation in the chat
 * screen.
 *
 * The rows come from buildConversationRows — the index MERGED with the turns
 * running right now — for the desktop History page's own reason: a
 * conversation started anywhere (in-app, a channel, an automation, a
 * procedure) shows up here the moment its first turn starts, with the same
 * pulsing number chip the conversations sheet gives it, instead of only once
 * the run is over.
 */

function RowSeparator(): React.JSX.Element {
  return <View className="h-2" />
}

const Row = memo(function Row({
  row,
  position,
  time,
  deleteLabel,
  diagnosticsLabel,
  onDiagnostics,
  onDelete
}: {
  row: ConversationRow
  /** Rank in the WHOLE list, not in its group — see RecencyGroup.startIndex. */
  position: number
  time: string
  deleteLabel: string
  diagnosticsLabel: string
  /** Absent unless a desktop is reachable — see the screen below. */
  onDiagnostics?: (row: ConversationRow) => void
  onDelete: (row: ConversationRow) => void
}): React.JSX.Element {
  // Per-row subscription: a badge changing re-renders only the row it marks.
  const unread = useNotifications((state) => unreadFor(state, row.id))
  // The desktop disables delete while the conversation's turn is in flight —
  // main refuses the delete anyway, so an enabled button could only fail. An
  // unindexed row is the same case by construction: it exists here only
  // because a turn is running in it.
  const processing = row.phase === 'processing'
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={row.title}
      onPress={() => {
        // A row tapped mid-search would otherwise carry the keyboard onto the
        // chat screen — the search field stays mounted (and focused) under it.
        Keyboard.dismiss()
        router.push({ pathname: '/chat', params: { id: row.id } })
      }}
      className="bg-surface border-border flex-row items-center gap-3 rounded-xl border px-4 py-3 active:bg-border-soft"
    >
      <Pulse active={processing}>
        <View
          className={cn(
            'h-6 w-6 items-center justify-center rounded-full border',
            chipTone(row.phase, false)
          )}
        >
          <Text
            className={cn('font-sans-semibold text-[8px]', chipText(row.phase, false))}
            style={{ writingDirection: 'ltr' }}
          >
            {position}
          </Text>
        </View>
      </Pulse>
      <View className="flex-1 flex-col gap-0.5">
        <View className="flex-row items-center gap-1.5">
          <ChannelBadge icon={row.icon} channel={row.channel} />
          <Text
            numberOfLines={1}
            className="text-fg font-sans-medium flex-shrink text-left text-sm"
          >
            {row.title}
          </Text>
        </View>
        <Text className="text-muted text-left font-sans text-xs">{time}</Text>
      </View>
      <UnreadBadge count={unread} />
      {/* The desktop's per-row Debug button, in the same place: beside delete,
          on the trailing edge. Absent rather than disabled without a desktop —
          the bundle is collected THERE, and a control that can only fail is
          worse than one that is not offered. */}
      {onDiagnostics && (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={diagnosticsLabel}
          hitSlop={8}
          onPress={() => onDiagnostics(row)}
          className="h-8 w-8 items-center justify-center rounded-lg active:bg-amber-500/10"
        >
          {({ pressed }) => (
            <Bug01Icon size={16} className={pressed ? 'text-amber-500' : 'text-muted'} />
          )}
        </Pressable>
      )}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={deleteLabel}
        hitSlop={8}
        disabled={processing}
        onPress={() => onDelete(row)}
        className={cn(
          'h-8 w-8 items-center justify-center rounded-lg',
          processing ? 'opacity-40' : 'active:bg-rose-500/10'
        )}
      >
        {({ pressed }) => (
          <Delete01Icon
            size={16}
            className={pressed && !processing ? 'text-rose-500' : 'text-muted'}
          />
        )}
      </Pressable>
    </Pressable>
  )
})

export default function HistoryScreen(): React.JSX.Element {
  const { t } = useTranslation()
  const insets = useSafeAreaInsets()
  const tokens = useTokens()
  const { data: metas, isLoading } = useConversationList()
  const { data: projects } = useProjects()
  const live = useChatRuntime((state) => state.streams)
  const runs = useRunStatus((state) => state.runs)
  // Title search. Screen-local: coming back to History is coming back to the
  // whole list, not to whatever it was narrowed to last time.
  const [query, setQuery] = useState('')
  const [doomed, setDoomed] = useState<ConversationRow | null>(null)
  const [deleting, setDeleting] = useState(false)
  // The conversation whose bundle is being collected, if any.
  const [diagnosing, setDiagnosing] = useState<string | null>(null)
  // The bundle is collected on the DESKTOP. Demo mode has none, and neither
  // does a paired phone that cannot reach its own right now — the same rule
  // every other write-through control on this app follows.
  const canDiagnose = useDesktopReachable()

  const untitled = t('chat.conversationsUntitled')
  const rows = useMemo(
    () => buildConversationRows({ metas: metas ?? [], live, runs, projects, untitled }),
    [metas, live, runs, projects, untitled]
  )
  // What the screen actually lists: the rows the typed keywords match, all of
  // them when nothing is typed.
  const visible = useMemo(() => filterConversationRows(rows, query), [rows, query])
  // Sliced into the same recency buckets the desktop's History page and the
  // conversations sheet use, keyed on `at` — a running turn lifts its row into
  // "Today" exactly as it lifts it to the top.
  //
  // Grouped over the MATCHES, so the chips count 1..n down what is on screen,
  // as the desktop's do. Keeping each row's rank in the unfiltered list would
  // print 3, 17, 42 under a search.
  const groups = useMemo(() => groupByRecency(visible, (row) => row.at), [visible])
  const BackIcon = I18nManager.isRTL ? ArrowRight01Icon : ArrowLeft01Icon

  return (
    <View className="bg-bg flex-1" style={{ paddingTop: insets.top }}>
      <View className="border-border-soft flex-row items-center gap-1 border-b px-2 pb-2">
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t('common.back')}
          hitSlop={8}
          onPress={goBack}
          className="h-9 w-9 items-center justify-center rounded-lg active:bg-border-soft"
        >
          <BackIcon size={20} className="text-fg" />
        </Pressable>
        <Text className="text-fg font-sans-semibold flex-1 text-left text-base">
          {t('chat.conversations')}
        </Text>
      </View>

      {/* Fixed under the header rather than scrolled with the list: it is what
          the list is being steered WITH, so it stays put while the results
          move. Only there once there is something to search — a field over an
          empty screen is a control that cannot act.

          Not autofocused, unlike the desktop page's: on a phone that raises a
          keyboard over half the list you came here to look at. */}
      {!isLoading && rows.length > 0 && (
        <View className="px-4 pt-4">
          <View className="border-border bg-surface h-10 flex-row items-center gap-2 rounded-lg border px-3">
            <Search01Icon size={15} className="text-muted" />
            <TextInput
              value={query}
              onChangeText={setQuery}
              placeholder={rtlPlaceholder(t('history.searchPlaceholder'))}
              accessibilityLabel={t('history.searchPlaceholder')}
              placeholderTextColor={tokens.muted}
              selectionColor={tokens.accent}
              autoCapitalize="none"
              autoCorrect={false}
              returnKeyType="search"
              clearButtonMode="while-editing"
              style={WRITING_DIRECTION}
              className={cn('text-fg h-10 flex-1 font-sans text-sm', INPUT_TEXT_ALIGN)}
            />
          </View>
        </View>
      )}

      {isLoading ? (
        <HistorySkeleton />
      ) : visible.length === 0 ? (
        <View className="flex-1 items-center justify-center px-8">
          <Text className="text-muted text-center font-sans text-sm">
            {rows.length === 0 ? t('history.empty') : t('history.searchEmpty')}
          </Text>
        </View>
      ) : (
        <SectionList
          sections={groups}
          keyExtractor={(item) => item.id}
          // A row tapped while the keyboard is up opens on that FIRST tap —
          // the default spends it dismissing the keyboard. And scrolling puts
          // the keyboard away, so a long result list is reachable to its end.
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="on-drag"
          // Desktop's headers scroll away with their group rather than pinning;
          // RN sticks them on iOS by default, so turn that off to match.
          stickySectionHeadersEnabled={false}
          renderSectionHeader={({ section }) => (
            <Text
              className={cn(
                'text-muted font-sans-medium px-1 pb-1.5 text-left text-[11px] uppercase',
                // Only the first group starts at rank 1 — every later header
                // gets the gap that separates it from the rows above it.
                section.startIndex > 1 && 'pt-5'
              )}
            >
              {t(section.labelKey)}
            </Text>
          )}
          renderItem={({ item, index, section }) => (
            <Row
              row={item}
              // The chip keeps counting across the headers (…7, 8 · "Yesterday"
              // · 9, 10…) instead of restarting per group.
              position={section.startIndex + index}
              time={formatRelativeTime(item.at, t)}
              deleteLabel={t('history.delete')}
              diagnosticsLabel={t('diagnostics.button')}
              onDiagnostics={canDiagnose ? (row) => setDiagnosing(row.id) : undefined}
              onDelete={setDoomed}
            />
          )}
          // A contentContainer `gap` would space the headers off their own rows
          // too — the separator keeps the 8px strictly between sibling rows.
          ItemSeparatorComponent={RowSeparator}
          contentContainerStyle={{
            padding: 16,
            paddingBottom: insets.bottom + 16
          }}
        />
      )}

      <ConfirmDialog
        open={doomed !== null}
        title={t('history.deleteTitle')}
        message={t('history.deleteWarning')}
        confirmLabel={t('history.deleteConfirm')}
        cancelLabel={t('history.deleteCancel')}
        busy={deleting}
        onCancel={() => setDoomed(null)}
        onConfirm={() => {
          if (!doomed) return
          setDeleting(true)
          void removeConversation(doomed.id).finally(() => {
            setDeleting(false)
            setDoomed(null)
          })
        }}
      />

      {/* Blocking, and mounted only while a run is asked for: the overlay
          starts the export on mount and owns the screen until the archive is
          ready. Keyed by conversation so pressing Debug on a second row after
          the first has finished starts a fresh run rather than re-showing the
          old card. */}
      {diagnosing !== null && (
        <DiagnosticExportOverlay
          key={diagnosing}
          conversationId={diagnosing}
          onClose={() => setDiagnosing(null)}
        />
      )}
    </View>
  )
}
