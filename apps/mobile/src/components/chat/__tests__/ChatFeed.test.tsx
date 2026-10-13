/**
 * The feed's reveal gate — what decides when a conversation stops being a
 * skeleton and becomes messages — and the follow, which keeps a pinned feed
 * at its end without ever mistaking its own motion for the user's.
 *
 * The gate opens on one signal: the layout going quiet. The bug those tests
 * hold shut is what "quiet" used to mean — an EMPTY feed lays out too, and it
 * lays out at once, so a conversation still being read out of SQLite or pulled
 * over the tunnel opened its gate on nothing: the skeleton faded out, a blank
 * page took its place, and the transcript then landed and scrolled itself in.
 * The old guard tried to catch that with `height <= 0` and never could — a
 * ScrollView reports its CONTENT BOX, and an empty one still measures the
 * container's own 32pt of padding.
 *
 * The follow tests hold shut the clipped feed: the animated follow's own
 * scroll events used to be read as "the user scrolled away", which unpinned
 * the feed mid-animation — and the animation itself aimed at where the end
 * was when it STARTED, so everything that grew during its flight left the
 * newest messages below the fold with nothing ever coming back for them.
 *
 * Driven through the scroller's own props with the events RN would really
 * deliver, because every rule here is a claim about those events. What the
 * feed DID in response is read from the jest preset's ScrollView mock, whose
 * instance methods are shared jest.fn()s on the prototype — the one seam
 * every imperative scroll passes through here, `animated` flag and all.
 */
import { ChatFeed, type ChatFeedHandle } from '@/components/chat/ChatFeed'
import { render } from '@testing-library/react-native'
import { act, createRef } from 'react'
import { ScrollView, Text } from 'react-native'

// The gate is timers and a ref; the cross-fade around it needs the native
// runtime and has no say in when onReady fires.
jest.mock('react-native-reanimated', () => {
  const { View } = jest.requireActual('react-native')
  return {
    __esModule: true,
    default: { View },
    useSharedValue: (value: number) => ({ value }),
    useAnimatedStyle: (style: () => object) => style(),
    withTiming: (value: number) => value
  }
})

/** What an empty feed measures: `contentContainerStyle`'s paddingVertical. */
const EMPTY = 32
/** What a screenful of messages measures. Anything past the fold will do. */
const FULL = 1200
/** Past the settle timer and the cap behind it, both. */
const SETTLED_MS = 1000
/** The scroller's viewport in every follow test. */
const VIEWPORT = 600
/** Past the glide watchdog. */
const GLIDE_MS = 600

const scrollToEnd = (ScrollView as unknown as { prototype: { scrollToEnd: jest.Mock } }).prototype
  .scrollToEnd

/** The `animated` flag of every scrollToEnd the feed issued, in order. */
const pins = (): boolean[] =>
  scrollToEnd.mock.calls.map((call: [{ animated: boolean }]) => call[0].animated)

let view: Awaited<ReturnType<typeof render>>
const onReady = jest.fn()

/** The scroller, as RN's own mock renders it — props and all. */
const scroller = (): Record<string, unknown> => {
  const found = view.root?.queryAll((node) => node.type === 'RCTScrollView', {
    includeSelf: true
  })
  // Guards the query itself: a renamed host type would otherwise leave every
  // assertion below reading `undefined` and passing.
  expect(found).toHaveLength(1)
  return (found ?? [])[0].props
}

/** A scroll event as native delivers it: the full geometry triple. */
const scrollEvent = (
  offset: number,
  content: number
): { nativeEvent: Record<string, unknown> } => ({
  nativeEvent: {
    contentOffset: { x: 0, y: offset },
    contentSize: { width: 390, height: content },
    layoutMeasurement: { width: 390, height: VIEWPORT },
    contentInset: { top: 0, left: 0, bottom: 0, right: 0 },
    velocity: { x: 0, y: 0 },
    zoomScale: 1,
    responderIgnoreScroll: false
  }
})

type Handler = (event: { nativeEvent: Record<string, unknown> }) => void

/** Lay out `height` points of content, then let every timer run out. */
const layout = async (height: number): Promise<void> => {
  await act(async () => {
    ;(scroller().onContentSizeChange as (w: number, h: number) => void)(390, height)
    jest.advanceTimersByTime(SETTLED_MS)
  })
}

// RTL 14 renders through act() and publishes the result asynchronously.
const mount = async (hasContent: boolean): Promise<void> => {
  view = await render(
    <ChatFeed gated hasContent={hasContent} onReady={onReady}>
      {hasContent ? <Text>a message</Text> : []}
    </ChatFeed>
  )
}

beforeEach(() => {
  jest.useFakeTimers()
  onReady.mockClear()
  scrollToEnd.mockClear()
})
afterEach(() => jest.useRealTimers())

describe('the chat feed reveal gate', () => {
  it('stays shut on an empty feed, however long it sits there', async () => {
    await mount(false)
    await layout(EMPTY)

    expect(onReady).not.toHaveBeenCalled()
    // Still covered: a revealed feed is a scrollable one.
    expect(scroller().scrollEnabled).toBe(false)
  })

  it('opens once the transcript arrives and its layout goes quiet', async () => {
    await mount(false)
    await layout(EMPTY)

    // The messages land.
    await view.rerender(
      <ChatFeed gated hasContent onReady={onReady}>
        <Text>a message</Text>
      </ChatFeed>
    )
    await layout(FULL)

    expect(onReady).toHaveBeenCalledTimes(1)
    expect(scroller().scrollEnabled).toBe(true)
  })

  it('reveals a feed that opens with its rows already in hand', async () => {
    await mount(true)
    await layout(FULL)

    expect(onReady).toHaveBeenCalledTimes(1)
  })

  it('never gates a feed the user is already in', async () => {
    view = await render(
      <ChatFeed gated={false} hasContent onReady={onReady}>
        <Text>a message</Text>
      </ChatFeed>
    )

    // Visible from the first frame — there is nothing to hide, and hiding it
    // would itself be the flash. onReady is a cue to drop a skeleton that was
    // never raised, so it stays unfired.
    expect(scroller().scrollEnabled).toBe(true)
    expect(onReady).not.toHaveBeenCalled()
  })
})

describe('the follow', () => {
  const handle = createRef<ChatFeedHandle>()

  /**
   * A revealed feed, pinned to the end of a transcript one viewport tall of
   * content past the fold: viewport 600, content 1200, offset 600. Every test
   * below starts from this position with the call log empty.
   */
  const openPinned = async (): Promise<void> => {
    view = await render(
      <ChatFeed ref={handle} gated={false} hasContent onReady={onReady}>
        <Text>a message</Text>
      </ChatFeed>
    )
    await act(async () => {
      ;(scroller().onLayout as Handler)({ nativeEvent: { layout: { height: VIEWPORT } } })
      ;(scroller().onContentSizeChange as (w: number, h: number) => void)(390, FULL)
      ;(scroller().onScroll as Handler)(scrollEvent(FULL - VIEWPORT, FULL))
      jest.advanceTimersByTime(GLIDE_MS)
    })
    scrollToEnd.mockClear()
  }

  it('glues a streamed line instantly, and glides for a mounted message', async () => {
    await openPinned()

    // A couple of streamed lines: small growth, followed in the same frame —
    // the motion column-reverse gives the desktop, no animation to lag it.
    await act(async () => {
      ;(scroller().onContentSizeChange as (w: number, h: number) => void)(390, FULL + 40)
      ;(scroller().onScroll as Handler)(scrollEvent(FULL + 40 - VIEWPORT, FULL + 40))
    })
    expect(pins()).toEqual([false])

    // A whole message mounts: a jump worth easing.
    await act(async () => {
      ;(scroller().onContentSizeChange as (w: number, h: number) => void)(390, FULL + 440)
    })
    expect(pins()).toEqual([false, true])
  })

  it('is not unpinned by its own follow animation, and finishes a glide that lands short', async () => {
    await openPinned()

    // A message mounts; the glide begins.
    await act(async () => {
      ;(scroller().onContentSizeChange as (w: number, h: number) => void)(390, FULL + 400)
    })
    expect(pins()).toEqual([true])

    // The animation's own early frames pass far from the end. Reading these
    // as the user leaving is the old bug — the feed must stay pinned.
    await act(async () => {
      ;(scroller().onScroll as Handler)(scrollEvent(650, FULL + 400))
      ;(scroller().onScroll as Handler)(scrollEvent(750, FULL + 400))
    })

    // iOS reports the animation done — but more content grew during its
    // flight, so it landed short of the end. The follow must re-aim, not
    // leave the newest messages below the fold.
    await act(async () => {
      ;(scroller().onMomentumScrollEnd as Handler)(scrollEvent(FULL + 400 - VIEWPORT, FULL + 700))
    })
    expect(pins()).toEqual([true, true])
  })

  it('finishes a glide nothing ever reported — the watchdog', async () => {
    await openPinned()

    await act(async () => {
      ;(scroller().onContentSizeChange as (w: number, h: number) => void)(390, FULL + 400)
    })
    expect(pins()).toEqual([true])

    // Android never reports programmatic scrolls done; on iOS an mVCP
    // adjustment can cancel one without a callback. Either way the watchdog
    // runs the settle, finds the feed short, and lands it.
    await act(async () => {
      ;(scroller().onScroll as Handler)(scrollEvent(800, FULL + 400))
      jest.advanceTimersByTime(GLIDE_MS)
    })
    expect(pins()).toEqual([true, true])
  })

  it('lets the user leave, and follows again when they come back', async () => {
    await openPinned()

    // The user drags up into history and releases there.
    await act(async () => {
      ;(scroller().onScrollBeginDrag as Handler)(scrollEvent(FULL - VIEWPORT, FULL))
      ;(scroller().onScroll as Handler)(scrollEvent(200, FULL))
      ;(scroller().onScrollEndDrag as Handler)(scrollEvent(200, FULL))
    })

    // Growth of every size arrives; nothing may move them.
    await act(async () => {
      ;(scroller().onContentSizeChange as (w: number, h: number) => void)(390, FULL + 40)
      ;(scroller().onContentSizeChange as (w: number, h: number) => void)(390, FULL + 440)
      jest.advanceTimersByTime(GLIDE_MS)
    })
    expect(pins()).toEqual([])

    // They drag back to the end; the feed is theirs to follow again.
    await act(async () => {
      ;(scroller().onScrollBeginDrag as Handler)(scrollEvent(200, FULL + 440))
      ;(scroller().onScroll as Handler)(scrollEvent(FULL + 440 - VIEWPORT, FULL + 440))
      ;(scroller().onScrollEndDrag as Handler)(scrollEvent(FULL + 440 - VIEWPORT, FULL + 440))
      ;(scroller().onContentSizeChange as (w: number, h: number) => void)(390, FULL + 480)
    })
    expect(pins()).toEqual([false])
  })

  it('re-pins when the viewport shrinks under a pinned feed', async () => {
    await openPinned()

    // The keyboard rises: the scroller loses height, the content none — no
    // content event is coming, and without a re-pin the newest message sits
    // behind the composer.
    await act(async () => {
      ;(scroller().onLayout as Handler)({ nativeEvent: { layout: { height: VIEWPORT - 300 } } })
    })
    expect(pins()).toEqual([false])
  })

  it('leaves a reader alone when the viewport shrinks', async () => {
    await openPinned()

    await act(async () => {
      ;(scroller().onScrollBeginDrag as Handler)(scrollEvent(FULL - VIEWPORT, FULL))
      ;(scroller().onScroll as Handler)(scrollEvent(200, FULL))
      ;(scroller().onScrollEndDrag as Handler)(scrollEvent(200, FULL))
      ;(scroller().onLayout as Handler)({ nativeEvent: { layout: { height: VIEWPORT - 300 } } })
    })
    expect(pins()).toEqual([])
  })

  it('re-pins from anywhere on a send', async () => {
    await openPinned()

    // Reading history when the send happens: the reply belongs on screen.
    await act(async () => {
      ;(scroller().onScrollBeginDrag as Handler)(scrollEvent(FULL - VIEWPORT, FULL))
      ;(scroller().onScroll as Handler)(scrollEvent(200, FULL))
      ;(scroller().onScrollEndDrag as Handler)(scrollEvent(200, FULL))
      handle.current?.scrollToEnd()
    })
    expect(pins()).toEqual([true])

    // And the feed is pinned again: the prompt mounting keeps following.
    await act(async () => {
      ;(scroller().onScroll as Handler)(scrollEvent(FULL - VIEWPORT, FULL))
      jest.advanceTimersByTime(GLIDE_MS)
      ;(scroller().onContentSizeChange as (w: number, h: number) => void)(390, FULL + 40)
    })
    expect(pins()).toEqual([true, false])
  })
})
