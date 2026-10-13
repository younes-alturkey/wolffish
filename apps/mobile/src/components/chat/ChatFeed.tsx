import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState
} from 'react'
import {
  ScrollView,
  View,
  type LayoutChangeEvent,
  type NativeScrollEvent,
  type NativeSyntheticEvent
} from 'react-native'
import Animated, { useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated'

/**
 * The chat transcript's scroller, and the one place its scroll position is
 * decided. The desktop gets this for free from CSS — its feed is
 * `flex flex-col-reverse overflow-y-auto`, so the scroll origin IS the bottom:
 * a conversation opens at its newest message on the first painted frame, stays
 * pinned while async children (file viewers, images, highlighting) settle, and
 * never yanks a user who has scrolled up. React Native has no column-reverse
 * scroller, so the same three guarantees are rebuilt here:
 *
 *  1. OPENS AT THE END, NEVER AT THE TOP. A ScrollView paints at offset 0 and
 *     can only be moved once its content has been measured, so the first frames
 *     of a long conversation show its FIRST message before snapping to the last
 *     — the flash this component exists to remove. The feed is therefore laid
 *     out invisibly and revealed (`onReady`) only once it has been pinned and
 *     its height has stopped changing. The caller holds the skeleton up for
 *     exactly that window, so what the eye sees is: skeleton, then the
 *     conversation, already at its end.
 *
 *  2. PINS EXACTLY WHILE THE USER MEANS TO BE AT THE END. Being pinned is an
 *     intent, and only the user's own scrolling — a drag, and the coast it
 *     releases into — may change it. It is NOT re-derived from every scroll
 *     event: the follow animation passes through the same "near the end?"
 *     test on its way down, and reading its early frames as "the user scrolled
 *     away" is what used to park the feed mid-transcript, unpinned, while new
 *     messages piled up below the fold. Scroll up to read history and nothing
 *     moves you; return to the end and the feed is yours again.
 *
 *  3. FOLLOWS GROWTH ALL THE WAY, IN TWO GAITS. Streamed lines arrive small
 *     and often, and are glued instantly — the same motion column-reverse
 *     gives the desktop, growth and scroll in the same frame. So is ANY
 *     growth while a turn streams or in the beat after the reveal (async
 *     media still sizing itself): easing those turned the follow into a
 *     chase that ran behind the whole turn. A whole message mounting into a
 *     quiet feed is the jump worth easing, so that one glides. But a glide's target is
 *     computed WHEN IT STARTS (iOS `setContentOffset:animated:`, Android's
 *     fixed-duration OverScroller), so anything that grows during its ~300ms
 *     lands it short — and nothing native ever says so: Android reports no
 *     completion for programmatic scrolls at all, and on iOS a
 *     maintainVisibleContentPosition adjustment can cancel the animation
 *     without a callback. So every glide is settled by hand: on iOS's
 *     completion event, and always by a watchdog timer, whichever speaks
 *     first — and if the feed is still short of the end, it is re-aimed until
 *     it truly lands. Before the reveal all of this is moot: pins are
 *     instantaneous, because an animation nobody can see is only a delay.
 *
 * The end must also survive the VIEWPORT changing under a fixed transcript:
 * the keyboard rising and the composer growing both shrink this scroller
 * without a single content event, which is how the newest message used to sit
 * hidden behind the composer while the feed believed itself pinned. A layout
 * change while pinned re-pins instantly.
 *
 * `maintainVisibleContentPosition` covers what sized placeholders cannot:
 * anything that still changes height ABOVE the viewport (a video's real aspect
 * ratio, a text card shorter than its reserved clamp) is absorbed natively
 * rather than shoving the reader's content down. Armed only after the reveal,
 * so it can never fight the initial pin.
 */

/** Within this many points of the end still counts as "reading the newest". */
const STICK_THRESHOLD = 64
/**
 * A touch whose whole travel is under this states no intent about the pin. A
 * tap to still a moving feed, a graze while the follow is running — both used
 * to pass through readStick mid-flight and read the FOLLOW'S position as "the
 * user scrolled away", unpinning a reader who never left the end. Only a
 * genuine displacement may re-decide the pin.
 */
const UNSTICK_MIN_DRAG = 12
/**
 * After the reveal, growth is followed with instant pins for this long. A
 * heavy conversation always reveals mid-mount (the cap below sees to it), so
 * its images, charts and viewers finish sizing AFTER the transcript is
 * visible — easing each of those jumps chained 500ms glides while the newest
 * message sat below the fold, which read as "opens scrolled short".
 */
const OPEN_FOLLOW_MS = 1500
/** One deferred re-check per instant pin — see pinNow. */
const PIN_VERIFY_MS = 80
/** No content-size change for this long ⇒ the layout has settled. */
const SETTLE_MS = 90
/** Reveal regardless after this long — a streaming feed never goes quiet. */
const SETTLE_CAP_MS = 500
/** Cross-fade duration for the reveal; the skeleton fades out over the same. */
export const FEED_FADE_MS = 180
/** Growth in one layout pass above this is a mounted message, not streamed
 *  lines: the first glides, the second is glued instantly. */
const GLIDE_MIN_DELTA = 80
/** Both platforms animate scrollToEnd over a fixed ~250–300ms. This long after
 *  a glide began it is over — finished, cancelled, or never reported. */
const GLIDE_SETTLE_MS = 500
/** Within this many points of the end, a glide has landed: the final offset is
 *  subpixel-snapped, so exactness cannot be asked of it. */
const LANDED_EPSILON = 1

export type ChatFeedHandle = {
  /** Re-pin and scroll to the newest message — for sends, which always follow. */
  scrollToEnd: () => void
}

export type ChatFeedProps = {
  children: React.ReactNode
  /**
   * True while the caller is covering this feed with the skeleton. The feed
   * stays invisible and unscrollable until it reports back through `onReady`.
   * False for a feed the user is already in (a fresh chat, a sent message):
   * there is nothing to hide, and hiding it would itself be a flash.
   */
  gated: boolean
  /**
   * True while a turn is being written into this conversation. Streamed
   * growth is followed with instant pins — the same motion column-reverse
   * gives the desktop — where an idle feed eases a mounting message in with
   * a glide. Without the distinction, mirror snapshots landing every 500ms
   * cleared the glide threshold and the follow ran as a chase: each glide
   * aimed at where the end used to be, settled 500ms later, re-aimed, and
   * the newest line lived permanently below the fold while the turn wrote.
   */
  streaming?: boolean
  /**
   * Whether there are rows to lay out yet. The gate may only open on a feed
   * pinned to REAL content, and an empty one lays out all the same — so this
   * is what separates "settled" from "still nothing here", not the measured
   * height (see handleContentSizeChange).
   */
  hasContent: boolean
  onReady: () => void
  /**
   * Extra space above the first message. The screen has no top bar — its two
   * controls float over this scroller — so the transcript starts below them and
   * passes UNDER them on the way up, which is only possible if the clearance is
   * padding inside the content rather than a bar outside it.
   */
  topInset?: number
}

export const ChatFeed = forwardRef<ChatFeedHandle, ChatFeedProps>(function ChatFeed(
  { children, gated, hasContent, onReady, topInset = 0, streaming = false },
  ref
) {
  const scrollRef = useRef<ScrollView>(null)
  const readyRef = useRef(!gated)
  const [revealed, setRevealed] = useState(!gated)
  const opacity = useSharedValue(gated ? 0 : 1)
  const settleTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const capTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Read by the scroller closure between native events — a prop would be
  // frozen at the closure's creation.
  const streamingRef = useRef(streaming)
  streamingRef.current = streaming

  /**
   * Guarantees 2 and 3, as one closure. Everything in here is plain mutable
   * state read and written between native events — none of it renders — and
   * the two halves are inseparable: whether growth is followed is decided by
   * what the user last did, and what the user last did can only be told apart
   * from the follow's own motion by who is holding which flag.
   */
  const scroller = useMemo(() => {
    /** The user means to be at the end. Follow growth while true. */
    let stuck = true
    /** The finger is on the feed right now. */
    let dragging = false
    /** Coasting out of a released drag — still the user's own motion. */
    let coasting = false
    /** An animated follow is in flight, its settle not yet run. */
    let gliding = false
    let glideTimer: ReturnType<typeof setTimeout> | null = null
    let pinCheckTimer: ReturnType<typeof setTimeout> | null = null
    /** Where the feed stood when the finger went down — the baseline every
     *  stick reading of that gesture is judged against. */
    const gesture = { startOffset: 0, startContent: 0 }
    /** Until this instant, growth follows with instant pins even when it is
     *  big enough to glide — the post-reveal window async media settles in. */
    let hardFollowUntil = 0
    /**
     * The freshest geometry each event reported. Kept so the settle can ask
     * "did we actually land?" without waiting for another event to tell it —
     * after a glide dies silently, no event is ever coming.
     */
    const metrics = { content: 0, layout: 0, offset: 0 }

    const distanceFromEnd = (): number => metrics.content - metrics.offset - metrics.layout

    const clearGlideTimer = (): void => {
      if (glideTimer) clearTimeout(glideTimer)
      glideTimer = null
    }

    /**
     * Land now. Instant — but not on faith: the jump is a request against
     * geometry the native side may be about to restate (a stale content size,
     * an MVCP adjustment in the same frame), and a pin that landed short used
     * to be terminal, because scroll frames outside a drag are deliberately
     * never re-read. One deferred check re-issues the jump if the feed is
     * still pinned-in-intent but short-in-fact; a pin that landed asks for
     * nothing more.
     */
    const pinNow = (): void => {
      gliding = false
      // The jump is programmatic motion; scroll frames it produces must not
      // be read against a released gesture's baseline (an MVCP adjustment
      // after a dead-stop release could otherwise re-stick a reader who
      // deliberately scrolled away).
      coasting = false
      clearGlideTimer()
      scrollRef.current?.scrollToEnd({ animated: false })
      if (pinCheckTimer) return
      pinCheckTimer = setTimeout(() => {
        pinCheckTimer = null
        if (stuck && !dragging && !gliding && distanceFromEnd() > LANDED_EPSILON) {
          scrollRef.current?.scrollToEnd({ animated: false })
        }
      }, PIN_VERIFY_MS)
    }

    function glide(): void {
      // Nothing to travel. An animation over zero distance never starts, so
      // nothing would ever report it finished — land exactly instead.
      if (distanceFromEnd() <= LANDED_EPSILON) {
        pinNow()
        return
      }
      gliding = true
      coasting = false
      scrollRef.current?.scrollToEnd({ animated: true })
      clearGlideTimer()
      glideTimer = setTimeout(settleGlide, GLIDE_SETTLE_MS)
    }

    /**
     * The glide is over — iOS said so, or the watchdog did. It aimed at where
     * the end WAS when it started, and everything that grew during its flight
     * left it short of where the end IS: re-aim until it truly lands. A glide
     * that did land asks for nothing more, which is what makes the chase
     * terminate.
     */
    function settleGlide(): void {
      clearGlideTimer()
      if (!gliding) return
      gliding = false
      if (stuck && distanceFromEnd() > LANDED_EPSILON) glide()
    }

    const measure = (event: NativeSyntheticEvent<NativeScrollEvent>): void => {
      const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent
      metrics.offset = contentOffset.y
      metrics.content = contentSize.height
      metrics.layout = layoutMeasurement.height
    }

    /**
     * The user's own position states their intent; nothing else may. Three
     * refinements over the raw "near the end?" test, each closing a way the
     * pin was lost or refused wrongly:
     *
     *  · A touch that barely traveled says nothing — a tap that stilled the
     *    moving feed, a graze mid-follow. It keeps whatever intent held; the
     *    feed's own motion under a still finger is not the user leaving.
     *  · Motion TOWARD the end is judged against where the end stood when
     *    the finger went down. During a streaming turn the true end recedes
     *    by hundreds of points a second — faster than any finger — so the
     *    raw test refused to re-stick a user deliberately returning to the
     *    bottom, and the follow could never be re-armed. Reaching what WAS
     *    the end when they started reaching for it is the intent that counts.
     *  · Motion away from the end unpins exactly as it always did.
     */
    const readStick = (event: NativeSyntheticEvent<NativeScrollEvent>): void => {
      const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent
      const moved = contentOffset.y - gesture.startOffset
      if (Math.abs(moved) < UNSTICK_MIN_DRAG) return
      const distance = contentSize.height - contentOffset.y - layoutMeasurement.height
      if (distance <= STICK_THRESHOLD) {
        stuck = true
        return
      }
      if (moved > 0) {
        const distanceAtStart = gesture.startContent - contentOffset.y - layoutMeasurement.height
        stuck = distanceAtStart <= STICK_THRESHOLD
        return
      }
      stuck = false
    }

    return {
      /** The transcript grew or shrank. Follow it, in the gait it calls for. */
      contentChanged(height: number): void {
        const grewBy = height - metrics.content
        metrics.content = height
        // Mid-glide growth is not skipped, it is deferred: the settle re-aims
        // at the real end. Restarting the animation per event is the stutter
        // this component used to have. A finger on the feed owns it outright:
        // a pin under a live drag both yanks the content and jumps the offset
        // past the gesture's own baseline, after which every stick reading of
        // that gesture is judged against motion the user never made.
        if (!stuck || gliding || dragging) return
        if (!readyRef.current) {
          scrollRef.current?.scrollToEnd({ animated: false })
          return
        }
        // Streamed growth is glued, however large: mirror snapshots land
        // every 500ms and easily clear the glide threshold, and easing each
        // one turned the follow into a chase that ran a snapshot behind the
        // whole turn. The same instant gait covers the post-reveal window,
        // where async media (images finding their real height, charts
        // settling) finishes sizing under a feed that just opened at its
        // end. A glide is for the quiet feed's mounting message — the jump
        // worth easing.
        if (grewBy > GLIDE_MIN_DELTA && !streamingRef.current && Date.now() >= hardFollowUntil) {
          glide()
        } else {
          pinNow()
        }
      },
      /**
       * The viewport changed size — the keyboard rose, the composer grew, the
       * device rotated. The content did not, so no content event is coming,
       * and without this the newest message ends up behind the composer while
       * the feed still believes itself pinned. Mid-glide it defers like
       * growth does: an instant jump would be stomped by Android's running
       * animator, and the settle lands on the true end anyway.
       */
      layoutChanged(event: LayoutChangeEvent): void {
        metrics.layout = event.nativeEvent.layout.height
        if (!stuck || gliding) return
        scrollRef.current?.scrollToEnd({ animated: false })
      },
      scrolled(event: NativeSyntheticEvent<NativeScrollEvent>): void {
        measure(event)
        // Only the user's own motion may re-decide the pin — the follow
        // animation passes through the same threshold on its way down, and
        // believing it was what parked the feed mid-transcript for good.
        if (dragging || coasting) readStick(event)
      },
      dragBegan(): void {
        dragging = true
        coasting = false
        // The touch owns the feed now; on iOS it has already cancelled any
        // running animation. The settle must not fire behind the finger.
        gliding = false
        clearGlideTimer()
        // The gesture's baseline: every stick reading it produces is judged
        // as displacement from HERE, against the end as it stood HERE.
        gesture.startOffset = metrics.offset
        gesture.startContent = metrics.content
      },
      dragEnded(event: NativeSyntheticEvent<NativeScrollEvent>): void {
        dragging = false
        // Momentum may follow; its motion is still the user's. If none does,
        // the flag dies with the next momentum-end or follow — and until then
        // it only ever re-reads a position the pins put at the end anyway.
        coasting = true
        measure(event)
        readStick(event)
      },
      momentumEnded(event: NativeSyntheticEvent<NativeScrollEvent>): void {
        measure(event)
        if (coasting) {
          // The user's coast ran out; where it stopped is what they meant.
          coasting = false
          readStick(event)
          return
        }
        // iOS reports a finished programmatic scroll here; Android never
        // does — there, the watchdog inside the glide stands in for this.
        settleGlide()
      },
      /** A send: the reply belongs on screen, wherever the reader was. */
      toEnd(): void {
        stuck = true
        if (!readyRef.current) {
          scrollRef.current?.scrollToEnd({ animated: false })
          return
        }
        glide()
      },
      /** The reveal just ran: follow everything instantly for a beat, so the
       *  media still sizing itself lands the open on the newest message. */
      openFollow(): void {
        hardFollowUntil = Date.now() + OPEN_FOLLOW_MS
      },
      dispose(): void {
        clearGlideTimer()
        if (pinCheckTimer) clearTimeout(pinCheckTimer)
        pinCheckTimer = null
      }
    }
  }, [])

  const reveal = useCallback(() => {
    if (readyRef.current) return
    readyRef.current = true
    setRevealed(true)
    // One last pin on the frame the feed becomes visible: anything that
    // settled during the reveal must not leave it a few points short. And a
    // follow window behind it: the cap below reveals heavy conversations
    // while their media is still sizing, so the growth that follows is the
    // open still landing, not a message arriving — glued, not glided.
    scrollRef.current?.scrollToEnd({ animated: false })
    scroller.openFollow()
    opacity.value = withTiming(1, { duration: FEED_FADE_MS })
    onReady()
  }, [onReady, opacity, scroller])

  useEffect(
    () => () => {
      if (settleTimer.current) clearTimeout(settleTimer.current)
      if (capTimer.current) clearTimeout(capTimer.current)
      scroller.dispose()
    },
    [scroller]
  )

  useImperativeHandle(ref, () => ({ scrollToEnd: scroller.toEnd }), [scroller])

  const handleContentSizeChange = useCallback(
    (_width: number, height: number) => {
      scroller.contentChanged(height)
      if (readyRef.current) return
      // An empty feed — a conversation still being read out of SQLite or
      // downloaded — has nothing to pin to, and settling on it opens the gate
      // on a blank page: the skeleton goes, nothing takes its place, and the
      // transcript then lands and scrolls itself in. Which is what the height
      // test below it used to allow: a ScrollView measures its CONTENT BOX,
      // and an empty one is still the container's own 32pt of padding, never
      // the zero this was watching for. So the question is asked of the rows,
      // and the timers start at the arrival of the first of them — including
      // the cap, whose whole point is to bound a feed that never goes quiet.
      if (!hasContent || height <= 0) return
      if (settleTimer.current) clearTimeout(settleTimer.current)
      settleTimer.current = setTimeout(reveal, SETTLE_MS)
      capTimer.current ??= setTimeout(reveal, SETTLE_CAP_MS)
    },
    [hasContent, reveal, scroller]
  )

  const fade = useAnimatedStyle(() => ({ opacity: opacity.value }))

  return (
    <Animated.View style={[{ flex: 1 }, fade]}>
      <ScrollView
        ref={scrollRef}
        onContentSizeChange={handleContentSizeChange}
        onLayout={scroller.layoutChanged}
        onScroll={scroller.scrolled}
        onScrollBeginDrag={scroller.dragBegan}
        onScrollEndDrag={scroller.dragEnded}
        onMomentumScrollEnd={scroller.momentumEnded}
        // Cheap at this rate, and the geometry the settle reads has to be
        // current by the time it runs.
        scrollEventThrottle={16}
        // Nothing to grab while it is invisible — a drag would only fight the
        // pin and leave the user parked mid-conversation.
        scrollEnabled={revealed}
        maintainVisibleContentPosition={revealed ? { minIndexForVisible: 0 } : null}
        contentContainerStyle={{
          paddingHorizontal: 16,
          paddingTop: 16 + topInset,
          paddingBottom: 16,
          gap: 16
        }}
        keyboardDismissMode="interactive"
        keyboardShouldPersistTaps="handled"
      >
        {children}
      </ScrollView>
      {/* Swallows taps aimed at the skeleton on top of the hidden transcript. */}
      {!revealed && <View className="absolute inset-0" />}
    </Animated.View>
  )
})
