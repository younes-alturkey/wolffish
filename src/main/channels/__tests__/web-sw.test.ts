/**
 * The Web UI service worker, run against a stand-in worker scope: the unread
 * ids it keeps in Cache Storage (deduped, serialized, cleared), the count it
 * puts on the app icon and posts to every page, and the push rule — a push
 * with a focused page counts nothing, and goes without a banner only where
 * the browser allows it (Chromium, told apart by userAgentData).
 *
 * Standalone — no vitest/jest in this repo. Run:
 *   npx tsx --tsconfig tsconfig.node.json src/main/channels/__tests__/web-sw.test.ts
 */
import { SERVICE_WORKER_SOURCE } from '@main/channels/web/assets'

let passed = 0
let failed = 0
function ok(label: string, cond: boolean, detail?: string): void {
  if (cond) {
    passed++
    return
  }
  failed++
  console.error(`FAIL ${label}${detail ? `: ${detail}` : ''}`)
}

type Listener = (event: Record<string, unknown>) => void
type FakeClient = {
  focused: boolean
  visibilityState: string
  posted: Array<Record<string, unknown>>
  postMessage: (m: Record<string, unknown>) => void
  focus: () => Promise<void>
}

function makeClient(focused: boolean): FakeClient {
  const client: FakeClient = {
    focused,
    visibilityState: focused ? 'visible' : 'hidden',
    posted: [],
    postMessage: (m) => {
      client.posted.push(m)
    },
    focus: async () => undefined
  }
  return client
}

type Worker = {
  clients: FakeClient[]
  shown: Array<{ title: string; options: Record<string, unknown>; closed: boolean }>
  badges: Array<number | 'clear'>
  stored: () => string[]
  message: (data: Record<string, unknown>) => Promise<void>
  push: (payload: Record<string, unknown>) => Promise<void>
  opened: string[]
  click: (data: Record<string, unknown>) => Promise<void>
}

function makeWorker(opts: { chromium: boolean }): Worker {
  const listeners = new Map<string, Listener[]>()
  const store = new Map<string, string>()
  const shown: Array<{ title: string; options: Record<string, unknown>; closed: boolean }> = []
  const badges: Array<number | 'clear'> = []
  const clients: FakeClient[] = []
  const opened: string[] = []
  const scope = {
    addEventListener: (type: string, fn: Listener) => {
      listeners.set(type, [...(listeners.get(type) ?? []), fn])
    },
    skipWaiting: () => undefined,
    location: { origin: 'https://wolffish.test' },
    navigator: {
      setAppBadge: async (n: number) => {
        badges.push(n)
      },
      clearAppBadge: async () => {
        badges.push('clear')
      },
      ...(opts.chromium ? { userAgentData: { brands: [] } } : {})
    },
    clients: {
      claim: async () => undefined,
      matchAll: async () => clients,
      openWindow: async (url: string) => {
        opened.push(url)
        return null
      }
    },
    registration: {
      showNotification: async (title: string, options: Record<string, unknown>) => {
        shown.push({ title, options, closed: false })
      },
      getNotifications: async () =>
        shown
          .filter((n) => !n.closed)
          .map((n) => ({
            close: () => {
              n.closed = true
            }
          }))
    }
  }
  const caches = {
    open: async () => ({
      match: async (key: string) =>
        store.has(key) ? { json: async () => JSON.parse(store.get(key)!) } : undefined,
      put: async (key: string, res: Response) => {
        store.set(key, await res.text())
      }
    })
  }
  new Function('self', 'caches', SERVICE_WORKER_SOURCE)(scope, caches)

  const dispatch = async (type: string, event: Record<string, unknown>): Promise<void> => {
    const pending: Promise<unknown>[] = []
    for (const fn of listeners.get(type) ?? [])
      fn({ ...event, waitUntil: (p: Promise<unknown>) => pending.push(p) })
    await Promise.all(pending)
  }
  return {
    clients,
    shown,
    badges,
    stored: (): string[] => JSON.parse(store.get('/__wolffish/unread') ?? '[]'),
    message: (data: Record<string, unknown>) => dispatch('message', { data }),
    push: (payload: Record<string, unknown>) =>
      dispatch('push', { data: { json: () => payload, text: () => JSON.stringify(payload) } }),
    opened,
    click: (data: Record<string, unknown>) =>
      dispatch('notificationclick', { notification: { close: () => undefined, data } })
  }
}

async function main(): Promise<void> {
  console.log('step: unread ids — deduped, serialized, cleared')
  {
    const sw = makeWorker({ chromium: true })
    const page = makeClient(false)
    sw.clients.push(page)
    await Promise.all([
      sw.message({ type: 'unread:add', id: 'a' }),
      sw.message({ type: 'unread:add', id: 'b' }),
      sw.message({ type: 'unread:add', id: 'a' }),
      sw.message({ type: 'unread:add', id: 'c' })
    ])
    ok(
      'concurrent adds all kept, the duplicate once',
      sw.stored().join() === 'a,b,c',
      sw.stored().join()
    )
    ok('the app icon carries the count', sw.badges.at(-1) === 3, JSON.stringify(sw.badges))
    const counts = page.posted.filter((m) => m.type === 'unread').map((m) => m.count)
    ok('every page is told the count', counts.at(-1) === 3, JSON.stringify(counts))
    await sw.message({ type: 'unread:get' })
    ok(
      'get re-announces without changing',
      sw.stored().length === 3 && page.posted.at(-1)?.count === 3
    )
    await sw.message({ type: 'notify', data: { id: 'n1', title: 'T', body: 'B' } })
    await sw.message({ type: 'unread:clear' })
    ok('clear empties the store', sw.stored().length === 0)
    ok('clear takes the badge off the icon', sw.badges.at(-1) === 'clear')
    ok(
      'clear closes what the worker showed',
      sw.shown.every((n) => n.closed)
    )
    ok('pages hear zero', page.posted.at(-1)?.count === 0)
  }

  console.log('step: a push while the user is away')
  {
    const sw = makeWorker({ chromium: true })
    sw.clients.push(makeClient(false))
    await sw.push({ id: 'p1', title: 'Done', body: 'ok', phase: 'completed', url: '/x', at: 5 })
    ok('banner shown', sw.shown.length === 1 && sw.shown[0].title === 'Done')
    ok(
      'tagged by id, small icon set',
      sw.shown[0].options.tag === 'p1' && sw.shown[0].options.badge === '/icon-128.png'
    )
    ok('counted', sw.stored().join() === 'p1' && sw.badges.at(-1) === 1)
    await sw.push({ id: 'needs-q', title: 'Wolffish', body: 'q', phase: 'needs_input', url: '/' })
    ok('a blocked turn stays on screen', sw.shown[1].options.requireInteraction === true)
    ok('counted too', sw.stored().length === 2)
  }

  console.log('step: no pages open at all (tab closed, phone locked)')
  {
    const sw = makeWorker({ chromium: false })
    await sw.push({ id: 'p1', title: 'Done', body: 'ok', phase: 'completed', url: '/' })
    ok(
      'shown and counted with no page to tell',
      sw.shown.length === 1 && sw.stored().join() === 'p1'
    )
  }

  console.log('step: a push while the user is on the page')
  {
    const sw = makeWorker({ chromium: true })
    const page = makeClient(true)
    sw.clients.push(page)
    await sw.push({ id: 'p1', title: 'Done', body: 'ok', phase: 'completed', url: '/' })
    ok('Chromium: no banner over the page the user is reading', sw.shown.length === 0)
    ok('nothing counted', sw.stored().length === 0)
    ok(
      'the page gets the payload for its toast',
      page.posted.some((m) => m.type === 'push' && (m.data as { id: string }).id === 'p1')
    )
  }
  {
    const sw = makeWorker({ chromium: false })
    sw.clients.push(makeClient(true))
    await sw.push({ id: 'p1', title: 'Done', body: 'ok', phase: 'completed', url: '/' })
    ok(
      'Safari/Firefox: the banner still shows (skipping one costs the subscription)',
      sw.shown.length === 1
    )
    ok('but nothing is counted', sw.stored().length === 0)
  }

  console.log('step: a tap answers the notification')
  {
    const sw = makeWorker({ chromium: true })
    const page = makeClient(false)
    sw.clients.push(page)
    await sw.click({ url: '/?conversation=c1', id: 'n1' })
    const told = page.posted.find((m) => m.type === 'open')
    ok(
      'an open tab is told where to go and which notification was tapped',
      told?.url === 'https://wolffish.test/?conversation=c1' && told?.id === 'n1',
      JSON.stringify(told)
    )
    ok('no second window', sw.opened.length === 0)
  }
  {
    const sw = makeWorker({ chromium: true })
    await sw.click({ url: '/?conversation=c1', id: 'n1' })
    ok(
      'no tab open: a new one carries the id to mark read',
      sw.opened[0] === 'https://wolffish.test/?conversation=c1&read=n1',
      sw.opened[0]
    )
  }

  console.log(`web-sw: ${passed} passed, ${failed} failed`)
  if (failed > 0) process.exit(1)
}

void main()
