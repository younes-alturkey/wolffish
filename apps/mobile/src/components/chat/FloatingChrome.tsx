import { Menu01Icon, Notification03Icon, PlusSignIcon } from '@/components/core/icons'
import { UnreadBadge } from '@/components/core/UnreadBadge'
import {
  unarchivedFor,
  unreadFor,
  unreadNotifications,
  useNotifications
} from '@/state/notifications'
import { useTheme } from '@/providers/theme/useTheme'
import { BlurView } from 'expo-blur'
import type { ReactNode } from 'react'
import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { Pressable, StyleSheet, View } from 'react-native'

/**
 * The chat screen's only chrome: two floating buttons over the transcript,
 * which scrolls underneath them.
 *
 * There is no top bar. A phone chat is one column of messages and a composer,
 * and a header spent a fixed strip of the shortest axis restating a title the
 * conversation itself already says. What it held that mattered — the way out to
 * everything else, and a new chat — is here instead, as glass discs on the
 * leading and trailing edges.
 *
 * A third disc joins the trailing pair, and only sometimes: the bell, which
 * opens what THIS conversation has notified about. It is absent — not dimmed —
 * for a conversation that has raised none, which is most of them. A control
 * that is present but inert on nearly every screen teaches the user to stop
 * seeing it; one that appears only when it has something behind it is itself
 * the signal that there is something to read.
 *
 * It wears a count, and that count is load-bearing now: arriving in a
 * conversation no longer reads its notifications, so a number here survives
 * the visit and goes only when the bell itself is opened. The disc beside it
 * on the leading edge carries the same mark for everything, everywhere.
 *
 * Direction-logical by construction: the row is a `flex-row`, which RN reverses
 * under RTL, so the navigator is always on the leading edge and the plus on the
 * trailing one without either being pinned to a physical side.
 */

/** Button diameter, and the strip the feed must not start inside. */
export const FLOATING_SIZE = 40
export const FLOATING_GAP = 8
/** What a caller has to add to the top inset to clear these buttons. */
export const FLOATING_AREA = FLOATING_SIZE + FLOATING_GAP * 2

function GlassButton({
  label,
  onPress,
  children
}: {
  label: string
  onPress: () => void
  children: ReactNode
}): React.JSX.Element {
  const { isDark } = useTheme()
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      hitSlop={8}
      onPress={onPress}
      style={{ width: FLOATING_SIZE, height: FLOATING_SIZE }}
      // See-through rather than solid: the transcript passing underneath is
      // what tells the user these float over it rather than sitting in a bar.
      // The hairline keeps them legible against a white message bubble —
      // border, not border-soft: soft sits darker than the dark bg and reads
      // as a black ring on the glass.
      className="border-border items-center justify-center overflow-hidden rounded-full border active:opacity-60"
    >
      <BlurView
        pointerEvents="none"
        intensity={40}
        tint={isDark ? 'dark' : 'light'}
        blurMethod="dimezisBlurView"
        style={StyleSheet.absoluteFill}
      />
      {children}
    </Pressable>
  )
}

export function FloatingChrome({
  top,
  conversationId,
  onOpenSheet,
  onOpenNotifications,
  onNewChat
}: {
  /** Distance from the top of the screen — the caller's safe-area inset. */
  top: number
  /** The conversation on screen, or null for a chat not yet minted. */
  conversationId: string | null
  onOpenSheet: () => void
  onOpenNotifications: () => void
  onNewChat: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  // Unread across every conversation — the disc that opens the navigator
  // wears the same count the rows inside it add up to. The one being read
  // clears on focus, so what remains really is "waiting elsewhere".
  const unreadTotal = useNotifications(unreadNotifications)
  // Whether this conversation has anything to show behind the bell. Archived
  // ones are excluded because the sheet excludes them — a bell that opened on
  // an empty list would be a promise the sheet does not keep. Derived from
  // `items` rather than selected directly: a selector returning a fresh array
  // re-renders on every store write.
  const items = useNotifications((state) => state.items)
  const hasNotifications = useMemo(
    () => (conversationId ? unarchivedFor({ items }, conversationId).length > 0 : false),
    [items, conversationId]
  )
  // What this conversation is still holding. Zero renders nothing at all (see
  // UnreadBadge), so a conversation whose notifications have all been read
  // keeps its bell — there is still something to read back — without a mark.
  const unreadHere = useNotifications((state) =>
    conversationId ? unreadFor(state, conversationId) : 0
  )
  return (
    <View
      // box-none, so only the two discs take touches and every tap between
      // them reaches the transcript scrolling underneath.
      pointerEvents="box-none"
      style={{ position: 'absolute', top, left: 0, right: 0 }}
      className="flex-row items-center justify-between px-3"
    >
      {/* The disc clips to its circle (overflow-hidden for the blur), so the
          badge hangs off a wrapper around it — top-trailing, half out of the
          disc, the same corner idiom the rank chips use for their origin
          badge. insetInlineEnd keeps it direction-aware with no RTL branch. */}
      <View className="relative">
        <GlassButton label={t('chat.conversations')} onPress={onOpenSheet}>
          <Menu01Icon size={18} className="text-fg" />
        </GlassButton>
        <View pointerEvents="none" style={{ position: 'absolute', top: -4, insetInlineEnd: -4 }}>
          <UnreadBadge count={unreadTotal} />
        </View>
      </View>
      {/* The trailing pair. A row of its own so the bell sits beside the plus
          rather than pushing it off the edge, and so its absence closes the
          gap instead of leaving a hole where a disc used to be. */}
      <View className="flex-row items-center" style={{ gap: FLOATING_GAP }}>
        {hasNotifications && (
          // Same corner idiom as the navigator's badge: the disc clips to its
          // circle for the blur, so the mark hangs off a wrapper around it.
          <View className="relative">
            <GlassButton label={t('notifications.title')} onPress={onOpenNotifications}>
              <Notification03Icon size={18} className="text-fg" />
            </GlassButton>
            <View
              pointerEvents="none"
              style={{ position: 'absolute', top: -4, insetInlineEnd: -4 }}
            >
              <UnreadBadge count={unreadHere} />
            </View>
          </View>
        )}
        <GlassButton label={t('chat.newChat')} onPress={onNewChat}>
          <PlusSignIcon size={18} className="text-fg" />
        </GlassButton>
      </View>
    </View>
  )
}
