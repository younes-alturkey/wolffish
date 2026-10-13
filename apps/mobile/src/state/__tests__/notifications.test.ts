jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock')
)

/**
 * The notification log, and the counts derived from it.
 *
 * EVERY unread number in the app comes from these records — the one on a
 * conversation row, the one on the app icon and the relay, and the one on the
 * sheet's Notifications row. That is the fix these tests exist to hold. There
 * used to be a second store counting arrivals per conversation, and two
 * counters for one fact drift the moment an arrival path touches one and not
 * the other: a notification that reached the log without incrementing the
 * counter left the page saying two unread and the conversation row saying one.
 * Derived, that disagreement cannot be expressed — so the assertions below
 * check the numbers TOGETHER, not each on its own.
 *
 * The three flags are separate questions and the tests keep them separate:
 * `read` is attention, `archived` is the inbox, and `counted` narrows exactly
 * one number — the OS icon — to keep the demo's seeded log off a home screen
 * it has no relay or push to clear. Everything drawn INSIDE the app counts the
 * same records either way.
 */

import {
  iconBadge,
  unreadFor,
  unreadNotifications,
  useNotifications,
  type NotificationArrival
} from '@/state/notifications'

const NOW = Date.now()

function arrival(id: string, over: Partial<NotificationArrival> = {}): NotificationArrival {
  return {
    id,
    title: `Run ${id}`,
    body: 'Your migration completed without errors.',
    at: NOW - 60_000,
    conversationId: 'conv-a',
    deeplink: 'wolffish://chat?id=conv-a',
    phase: 'completed',
    counted: true,
    ...over
  }
}

function deliver(id: string, over: Partial<NotificationArrival> = {}): void {
  useNotifications.getState().record(arrival(id, over))
}

/** The three numbers a user can see at once, read the way each surface reads
 *  them. They must never tell different stories about the same records. */
function counts(conversationId = 'conv-a'): { row: number; icon: number; sheet: number } {
  const state = useNotifications.getState()
  return {
    row: unreadFor(state, conversationId),
    icon: iconBadge(state),
    sheet: unreadNotifications(state)
  }
}

beforeEach(() => {
  useNotifications.setState({ items: [] })
})

describe('the count a conversation wears', () => {
  it('counts every notification the conversation raised, not just some', () => {
    // THE REGRESSION. Two notifications out of one conversation read as two
    // everywhere — the row, the icon and the page. The old split counter could
    // put one number on the row and another on the page for the same pair.
    deliver('n1')
    deliver('n2')

    expect(counts()).toEqual({ row: 2, icon: 2, sheet: 2 })
  })

  it('does not count one twice however many arrival paths see it', () => {
    deliver('n1')
    deliver('n1', { title: 'Run n1 (again)' })
    deliver('n1')

    expect(useNotifications.getState().items).toHaveLength(1)
    expect(counts()).toEqual({ row: 1, icon: 1, sheet: 1 })
  })

  it('keeps conversations apart', () => {
    deliver('n1')
    deliver('n2', { conversationId: 'conv-b', deeplink: 'wolffish://chat?id=conv-b' })

    expect(unreadFor(useNotifications.getState(), 'conv-a')).toBe(1)
    expect(unreadFor(useNotifications.getState(), 'conv-b')).toBe(1)
    expect(counts().icon).toBe(2)
  })

  it('agrees with the page about one that arrived while you were looking', () => {
    // push.ts records this one read: arriving for the conversation on screen
    // is the same answer as opening it, a beat earlier. What matters here is
    // that BOTH numbers treat it the same way — the old code left it unread on
    // the page while the row never counted it, which is the reported bug.
    deliver('n1')
    deliver('n2', { read: true })

    expect(counts()).toEqual({ row: 1, icon: 1, sheet: 1 })
  })
})

describe('the icon and the sheet', () => {
  it('keeps a general notification off the icon but on the page', () => {
    // No conversation to badge, and the icon is only ever read while the app
    // is away — but the page is where it can actually be answered.
    deliver('n1', { conversationId: null, deeplink: 'wolffish://settings/model', counted: true })

    expect(counts()).toEqual({ row: 0, icon: 0, sheet: 1 })
  })

  it('keeps the demo off the OS icon while it counts everywhere inside the app', () => {
    // `counted: false` is the demo's seeded log. It narrows ONE number: the
    // home-screen icon, which a demo has no relay or push to clear and which
    // would otherwise outlive the tour. Everything drawn inside the app counts
    // it, because a row that disagrees with the list beside it is the bug this
    // store exists to make impossible.
    deliver('n1', { counted: false })
    deliver('n2', { counted: false })

    expect(counts()).toEqual({ row: 2, icon: 0, sheet: 2 })
  })
})

describe('answering one', () => {
  it('takes it off every count at once', () => {
    deliver('n1')
    deliver('n2')

    useNotifications.getState().markRead('n1')

    expect(counts()).toEqual({ row: 1, icon: 1, sheet: 1 })
  })

  it('is idempotent', () => {
    deliver('n1')
    deliver('n2')
    useNotifications.getState().markRead('n1')
    useNotifications.getState().markRead('n1')

    expect(counts()).toEqual({ row: 1, icon: 1, sheet: 1 })
  })

  it('archiving reads at the same time, and leaves the inbox', () => {
    deliver('n1')

    useNotifications.getState().archive('n1')

    expect(useNotifications.getState().items[0]).toMatchObject({ archived: true, read: true })
    expect(counts()).toEqual({ row: 0, icon: 0, sheet: 0 })
  })

  it('opening the conversation answers all of its notifications at once', () => {
    deliver('n1')
    deliver('n2')
    deliver('other', { conversationId: 'conv-b', deeplink: 'wolffish://chat?id=conv-b' })

    useNotifications.getState().markConversationRead('conv-a')

    expect(unreadFor(useNotifications.getState(), 'conv-a')).toBe(0)
    // …and takes nothing off the conversation next to it.
    expect(unreadFor(useNotifications.getState(), 'conv-b')).toBe(1)
    expect(counts().icon).toBe(1)
  })
})

describe('the two bulk buttons', () => {
  it('mark-all-read clears every count without emptying the list', () => {
    deliver('n1')
    deliver('n2', { conversationId: 'conv-b', deeplink: 'wolffish://chat?id=conv-b' })

    useNotifications.getState().markAllRead()

    expect(counts()).toEqual({ row: 0, icon: 0, sheet: 0 })
    expect(useNotifications.getState().items.every((record) => !record.archived)).toBe(true)
  })

  it('archive-all empties the inbox and reads it on the way', () => {
    deliver('n1')
    deliver('n2')

    useNotifications.getState().archiveAll()

    expect(useNotifications.getState().items.every((r) => r.archived && r.read)).toBe(true)
    expect(counts()).toEqual({ row: 0, icon: 0, sheet: 0 })
  })

  it('leaves the archive alone — it is finished, not a second inbox', () => {
    deliver('n1')
    useNotifications.getState().archive('n1')
    deliver('n2')

    useNotifications.getState().archiveAll()

    expect(useNotifications.getState().items.filter((r) => r.archived)).toHaveLength(2)
  })
})

describe('a conversation the desktop no longer has', () => {
  it('stops badging once a full index sync says it is gone', () => {
    deliver('n1')
    deliver('n2', { conversationId: 'conv-b', deeplink: 'wolffish://chat?id=conv-b' })

    // conv-a is absent from the completed index, and its notification predates
    // the sync — so it cannot simply be newer than the list.
    useNotifications.getState().prune(['conv-b'], NOW)

    expect(unreadFor(useNotifications.getState(), 'conv-a')).toBe(0)
    expect(unreadFor(useNotifications.getState(), 'conv-b')).toBe(1)
    // Read, not deleted: the text is still worth having.
    expect(useNotifications.getState().items).toHaveLength(2)
  })

  it('spares a notification that arrived after the index was taken', () => {
    deliver('n1', { at: NOW + 5_000 })

    useNotifications.getState().prune(['conv-b'], NOW)

    expect(unreadFor(useNotifications.getState(), 'conv-a')).toBe(1)
  })
})

describe('the list itself', () => {
  it('keeps the newest first, whatever order the paths hand them over', () => {
    deliver('old', { at: NOW - 3 * 3_600_000 })
    deliver('new', { at: NOW - 60_000 })
    deliver('middle', { at: NOW - 3_600_000 })

    expect(useNotifications.getState().items.map((r) => r.id)).toEqual(['new', 'middle', 'old'])
  })

  it('records a tapped notification as already answered', () => {
    deliver('n1', { read: true })

    expect(counts()).toEqual({ row: 0, icon: 0, sheet: 0 })
  })
})
