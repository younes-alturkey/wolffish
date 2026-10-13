import AsyncStorage from '@react-native-async-storage/async-storage'
import { create } from 'zustand'
import { createJSONStorage, persist } from 'zustand/middleware'
import type { NotifyPhase } from '@/lib/tunnel/protocol'

/**
 * The notification log — every model-initiated notification this phone has
 * rendered, kept so the user can read them again on their own screen instead
 * of only in the split second the OS banner is up.
 *
 * WHY THE PHONE HAS TO KEEP THIS ITSELF. Nothing upstream holds a history to
 * fetch: the desktop mints a notification and fires it, the relay routes it
 * and remembers only an idempotency marker, and the OS tray forgets whatever
 * the user swipes away. So the log is written at ARRIVAL, by every path in
 * lib/notifications/push.ts that renders one — the in-band frame, the
 * foreground push, the tray reconciliation that catches what landed while the
 * app was dead, and the tap that opens the app. Records are keyed by
 * notificationId and the first write wins, which is what lets all four paths
 * see the same notification without it appearing four times.
 *
 * The one thing it CANNOT recover is a push that arrived while the app was
 * dead and was dismissed from the tray before the app next opened: nothing of
 * ours ran, and nothing anywhere else kept it.
 *
 * THIS LOG IS ALSO THE BADGES. Every unread count in the app is derived from
 * the records below — the number on a conversation row, the total on the app
 * icon, the count the relay stamps onto pushes, and the one on the sheet's
 * Notifications row. It did not used to be: a separate store kept a counter
 * per conversation, incremented at arrival and decremented on read, and two
 * counters for one fact drift the moment any arrival path treats them
 * differently. A notification that reached the log without incrementing the
 * counter — one that arrived while its own conversation was on screen — left
 * the page saying two unread and the conversation row saying one. Derived,
 * that disagreement cannot be expressed.
 *
 * THREE FLAGS, and they are not the same question:
 *
 *  - `read` is about attention. It starts false except on a tap (the tap IS
 *    the answer) and on a notification that arrives for the conversation the
 *    user is already looking at — which is the same answer, a beat earlier.
 *  - `archived` is about the inbox. One-way, and archiving reads at the same
 *    time, so an archived notification is always read and the archive tab is
 *    a finished pile rather than a second inbox.
 *  - `counted` is about the OS ICON, and only that. It is a STANDING property
 *    rather than a record of something that happened: may this notification
 *    put a number on the app's springboard icon (and on the relay's copy of
 *    that number, which stamps pushes while the app is away)? True for every
 *    real arrival. False only for the demo's seeded log — a demo has no relay
 *    and no push, so a number it put on the home-screen icon would outlive the
 *    tour. Everything INSIDE the app still counts it: the demo's conversation
 *    rows and its Notifications row read the same records the real ones do,
 *    because a count that disagrees with the list beside it is the bug this
 *    whole store exists to make impossible.
 */

export type NotificationRecord = {
  /** The desktop-minted ULID. Unique per notification, across both paths. */
  id: string
  title: string
  body: string
  /** When the DESKTOP sent it where that is known (the frame's `ts`, and the
   *  same value echoed in the push payload), else when this phone rendered
   *  it. Both are stamped at arrival; neither moves afterwards. */
  at: number
  /** The conversation the deeplink names, or null for a general one. */
  conversationId: string | null
  /** Exactly the link the desktop sent, so a tap here goes where the tap on
   *  the banner would have gone — including the settings routes. */
  deeplink: string | null
  phase: NotifyPhase
  read: boolean
  archived: boolean
  /** Whether this one may reach the OS icon while unread. See the header. */
  counted: boolean
}

/** What an arrival knows about itself. */
export type NotificationArrival = Omit<NotificationRecord, 'read' | 'archived'> & {
  /** A tap, or a notification for the conversation already on screen: both
   *  arrive answered. Everything else arrives unread. */
  read?: boolean
}

/**
 * How many records the log keeps, newest first. Each is a couple of hundred
 * bytes, so the whole store stays well under a hundred kilobytes — small
 * enough for one AsyncStorage value on both platforms, and far more history
 * than a phone notification list is ever read back through.
 */
const LIMIT = 300

/** A conversation's badge can never grow past this; the relay clamps to the
 *  same ceiling, so the two ends agree about what "a lot" looks like. */
const BADGE_MAX = 999

export type NotificationsState = {
  /** Newest first. */
  items: NotificationRecord[]
  /** Record an arrival. Idempotent by id — a repeat only ever marks read. */
  record: (arrival: NotificationArrival) => void
  /** The user answered one notification: read, and its badge goes with it. */
  markRead: (id: string) => void
  /** Archive one. Reads it at the same time — archived is always read. */
  archive: (id: string) => void
  /** The inbox button: every unarchived notification read at once. */
  markAllRead: () => void
  /** The inbox button: every unarchived notification archived (and read). */
  archiveAll: () => void
  /** Everything this conversation ever notified about is answered — the
   *  conversation's own sheet on open, and a deleted conversation. */
  markConversationRead: (conversationId: string) => void
  /** File one conversation's whole handful at once, from that sheet's header.
   *  Archiving reads too, so this needs no read pass of its own. */
  archiveConversation: (conversationId: string) => void
  /**
   * Read the notifications of conversations the desktop no longer has.
   * `liveIds` is the full id list from a completed index sync and `before` is
   * when that sync STARTED — a notification that arrived after the list was
   * taken is spared, because its conversation may simply be newer than the
   * list. Read rather than deleted: the text is still worth having, it just
   * stops badging a row that no longer exists.
   */
  prune: (liveIds: readonly string[], before: number) => void
  /** Unpairing or a demo purge — the log describes conversations that are
   *  about to stop existing. */
  clear: () => void
}

/** Newest first, and capped. */
function ordered(items: NotificationRecord[]): NotificationRecord[] {
  return [...items].sort((a, b) => b.at - a.at).slice(0, LIMIT)
}

/**
 * Flip `read` — and optionally `archived` — on the records an action names.
 * Returns the same array reference when nothing changed, which is what lets
 * every caller no-op without comparing contents.
 */
function settle(
  items: NotificationRecord[],
  matches: (record: NotificationRecord) => boolean,
  archive: boolean
): NotificationRecord[] {
  let changed = false
  const next = items.map((record) => {
    if (!matches(record)) return record
    if (record.read && (!archive || record.archived)) return record
    changed = true
    return { ...record, read: true, archived: archive ? true : record.archived }
  })
  return changed ? next : items
}

export const useNotifications = create<NotificationsState>()(
  persist(
    (set, get) => ({
      items: [],
      record: (arrival) => {
        const { items } = get()
        const existing = items.find((record) => record.id === arrival.id)
        if (existing) {
          // A second sighting of a notification already logged. The only thing
          // it can still tell us is that the user has now answered it — a tap
          // on a banner whose notification the in-band path logged minutes
          // ago. Content never changes; re-reading it would resurrect a record
          // the user has since read or archived.
          if (arrival.read && !existing.read) get().markRead(arrival.id)
          return
        }
        set({
          items: ordered([{ ...arrival, read: arrival.read === true, archived: false }, ...items])
        })
      },
      markRead: (id) => {
        const items = settle(get().items, (record) => record.id === id, false)
        if (items === get().items) return
        set({ items })
      },
      archive: (id) => {
        const items = settle(get().items, (record) => record.id === id, true)
        if (items === get().items) return
        set({ items })
      },
      markAllRead: () => {
        const items = settle(get().items, (record) => !record.archived, false)
        if (items === get().items) return
        set({ items })
      },
      archiveAll: () => {
        const items = settle(get().items, (record) => !record.archived, true)
        if (items === get().items) return
        set({ items })
      },
      markConversationRead: (conversationId) => {
        const items = settle(
          get().items,
          (record) => record.conversationId === conversationId,
          false
        )
        if (items === get().items) return
        set({ items })
      },
      archiveConversation: (conversationId) => {
        const items = settle(
          get().items,
          (record) => record.conversationId === conversationId,
          true
        )
        if (items === get().items) return
        set({ items })
      },
      prune: (liveIds, before) => {
        const live = new Set(liveIds)
        const items = settle(
          get().items,
          (record) =>
            record.conversationId !== null &&
            !live.has(record.conversationId) &&
            record.at < before,
          false
        )
        if (items === get().items) return
        set({ items })
      },
      clear: () => {
        if (get().items.length === 0) return
        set({ items: [] })
      }
    }),
    {
      name: 'wolffish.notifications',
      storage: createJSONStorage(() => AsyncStorage),
      version: 1,
      partialize: (state) => ({ items: state.items })
    }
  )
)

/** Unread notifications for one conversation — the number its row wears. */
export function unreadFor(
  state: Pick<NotificationsState, 'items'>,
  conversationId: string
): number {
  let total = 0
  for (const record of state.items) {
    if (record.read) continue
    if (record.conversationId === conversationId) total += 1
  }
  return Math.min(BADGE_MAX, total)
}

/**
 * One conversation's notifications, minus the archived ones — what the
 * conversation's own sheet lists, newest first.
 *
 * Read ones stay: being IN a conversation marks its notifications read, so by
 * the time that sheet opens they usually all are, and a list that hid them
 * would be empty exactly when it is opened. Archived ones go: archiving is
 * filing, and the notifications page is where a filed one is read back.
 */
export function unarchivedFor(
  state: Pick<NotificationsState, 'items'>,
  conversationId: string
): NotificationRecord[] {
  return state.items.filter(
    (record) => record.conversationId === conversationId && !record.archived
  )
}

/**
 * Everything unread — the number on the side sheet's Notifications row and on
 * the chat screen's menu disc, which is the door to that sheet. General
 * notifications are in it: they deep-link to a settings page or nowhere, but
 * the page can still answer them, so a count that leaves them out sends the
 * user looking for something they cannot find. Archived records are read by
 * construction and never reach this.
 */
export function unreadNotifications(state: Pick<NotificationsState, 'items'>): number {
  let total = 0
  for (const record of state.items) if (!record.read) total += 1
  return Math.min(BADGE_MAX, total)
}

/**
 * The number the OS ICON carries — and, through it, the relay's copy that
 * stamps pushes while the app is away.
 *
 * Two things narrow it, and both are about the icon being the one badge the
 * app cannot redraw while the user is elsewhere. General notifications are
 * out because opening the app is what answers those, and the icon is only
 * read while the app is closed. The demo's seeded log is out because a demo
 * has no relay and no push, so a number it put on someone's home screen would
 * outlive the tour that minted it. Neither exclusion reaches anything drawn
 * INSIDE the app — see unreadFor and unreadNotifications.
 */
export function iconBadge(state: Pick<NotificationsState, 'items'>): number {
  let total = 0
  for (const record of state.items) {
    if (record.read || !record.counted || record.conversationId === null) continue
    total += 1
  }
  return Math.min(BADGE_MAX, total)
}

/** Resolves once the persisted log is restored — counting before that would
 *  be overwritten by the rehydrate. */
export function whenNotificationsHydrated(): Promise<void> {
  if (useNotifications.persist.hasHydrated()) return Promise.resolve()
  return new Promise((resolve) => {
    const unsub = useNotifications.persist.onFinishHydration(() => {
      unsub()
      resolve()
    })
  })
}
