import { BlockingProgress } from '@/components/common/BlockingProgress'
import { Activity04Icon, RefreshIcon } from '@/components/core/icons'
import { getSyncActivity, onSyncActivity, type SyncActivity } from '@/lib/sync/activity'
import { tunnelClient } from '@/lib/tunnel/client'
import type { TunnelState } from '@/lib/tunnel/tunnel'
import { useAppStore } from '@/state/appStore'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

/**
 * The one card for everything the desktop link goes through: reconnecting,
 * then the catch-up that every reconnect runs, then gone.
 *
 * These used to be two overlays — one watching the tunnel, one watching the
 * sync — and a single blip mid-use interrupted twice: a reconnect card that
 * vanished the instant the link formed, then a sync card blinking in over the
 * same spot a beat later. They were always one event to the user (the app is
 * busy with the desktop), so they are one card now: it appears once, walks
 * through whichever phases the episode actually has, and leaves once,
 * wearing the same BlockingProgress face throughout.
 *
 * What did NOT change is when anything underneath runs. The tunnel's
 * reconnects, the reconcile on every connection, the activity reporting —
 * all untouched; this merges presentation only.
 *
 * The thresholds are the design, kept from both originals so the ordinary
 * case stays exactly as silent as it was:
 *
 * - An outage must last APPEAR_RECONNECT_MS before anything appears —
 *   reconnecting after a blip is routine and usually lands in well under a
 *   second, and a modal in front of that makes a working app feel broken.
 * - A catch-up must run APPEAR_SYNC_MS before it appears — an unchanged
 *   desktop answers in milliseconds and deserves no dialog at all.
 * - A card already up never blinks between phases: connect-then-sync swaps
 *   the words on the same card, and the end holds through MIN_VISIBLE_MS so
 *   a sync that finished just past its threshold reads as progress, not a
 *   glitch.
 */
const APPEAR_RECONNECT_MS = 1_200
const APPEAR_SYNC_MS = 800

/**
 * How long before each phase's block becomes a choice. Both sit at a full
 * minute on purpose: the card is only ever up because the app is mid-recovery
 * with the desktop, and offering a way out at three or five seconds turned a
 * blip the user would never have noticed into a decision they felt pushed to
 * make — then the reconnect they skipped finished a beat later anyway. A
 * minute is the point at which "this is not finishing on its own" becomes
 * true, so the escape stays a real answer to a real stall instead of an
 * interruption of one.
 *
 * The phases keep their own fuses even though the two now read the same,
 * because they answer different questions: reconnecting has nothing behind
 * the card until the link is back, a catch-up has a readable phone behind it
 * already. They can diverge again without either edit being a re-think.
 */
const ESCAPE_RECONNECT_MS = 60_000
const ESCAPE_SYNC_MS = 60_000

/** Once shown, stay shown this long — the floor that keeps a card that DID
 *  appear legible instead of flickering off a few frames later. */
const MIN_VISIBLE_MS = 700

/**
 * How long the card survives a momentary "nothing is happening".
 *
 * The handoff from connected to catching-up crosses a listener boundary: the
 * tunnel says connected in one notification, the reconcile it triggers
 * reports itself a beat later. Without this grace the card would hide on
 * that beat and re-appear for the sync — the exact double interruption this
 * component exists to remove.
 */
const HANDOFF_GRACE_MS = 300

/** Where each connection phase sits on its half of the bar. Not a measurement
 *  — the steps are known and ordered, so the bar reports which one is running
 *  rather than pretending to time something whose length nobody can know. */
const PHASE_RATIO: Record<string, number> = {
  idle: 0.08,
  reconnecting: 0.2,
  connecting: 0.4,
  'waiting-for-peer': 0.6,
  handshaking: 0.85,
  error: 0.2,
  connected: 1
}

/**
 * The reconnect half of an episode owns the bar up to here; the catch-up that
 * always follows a fresh connection owns the rest. A sync-only episode takes
 * the whole bar — there was no reconnect to give the first half meaning.
 */
const RECONNECT_SHARE = 0.5

export function ConnectionOverlay(): React.JSX.Element | null {
  const { t } = useTranslation()
  const paired = useAppStore((state) => state.paired)
  const [state, setState] = useState<TunnelState | null>(tunnelClient.state)
  const [activity, setActivity] = useState<SyncActivity>(getSyncActivity)
  const [visible, setVisible] = useState(false)
  const [escapable, setEscapable] = useState(false)
  // Dismissal lasts for the whole episode: whoever chose "continue" while the
  // link was down must not be interrupted again by the catch-up that follows
  // the reconnect they were not waiting on.
  const [dismissed, setDismissed] = useState(false)
  /**
   * When this episode's wait began — what the card's clock counts from, held
   * across every phase the episode goes through. The moment the link was
   * lost (or the catch-up started), deliberately not the moment the card
   * appeared: the card is held back first, and a counter reading 0:00 when
   * the app has been unreachable for two seconds is wrong about the one
   * number on screen anyone can check against their own sense of waiting.
   */
  const [since, setSince] = useState<number | null>(null)
  /** Whether this episode went through a reconnect — decides how the two
   *  halves of the bar are shared out. */
  const [sawReconnect, setSawReconnect] = useState(false)
  /** Whether this episode's catch-up has started — tells the handoff gap
   *  (connected, reconcile not yet reporting) apart from the hold at the end,
   *  so the bar waits at the sync half's start instead of jumping to full and
   *  back. */
  const [sawSync, setSawSync] = useState(false)

  const appearTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const escapeTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const shownAt = useRef<number | null>(null)
  /** When the CURRENT outage started — the reconnect appearance debounce
   *  counts from here, which may be later than the episode's `since` when a
   *  connection drops mid-catch-up. */
  const reconnectingSince = useRef<number | null>(null)

  useEffect(() => tunnelClient.subscribe(setState), [])
  useEffect(() => onSyncActivity(setActivity), [])

  const reconnecting = paired && state?.status !== 'connected'
  // The startedAt is stable for the life of one catch-up, so effects keyed on
  // it do not churn on every progress tick the activity object carries.
  const syncStartedAt = paired && activity ? activity.startedAt : null
  const busy = reconnecting || syncStartedAt !== null

  useEffect(() => {
    if (reconnecting) {
      if (reconnectingSince.current === null) reconnectingSince.current = Date.now()
    } else {
      reconnectingSince.current = null
    }

    if (busy) {
      setSawReconnect((saw) => saw || reconnecting)
      setSawSync((saw) => saw || syncStartedAt !== null)
      // Stamped on the way in, before the appearance delay, and left alone by
      // every phase the episode goes through afterwards.
      setSince((current) => current ?? reconnectingSince.current ?? syncStartedAt ?? Date.now())
      // The episode continues — a hide pending from a momentary lull is void.
      if (hideTimer.current) {
        clearTimeout(hideTimer.current)
        hideTimer.current = null
      }
      if (visible) return
      // Each trigger earns its appearance against its own clock, exactly as
      // the two separate cards did: an outage must reach APPEAR_RECONNECT_MS
      // as an outage, a catch-up APPEAR_SYNC_MS as a catch-up. A blip that
      // resolves into a fast sync therefore still shows nothing at all. The
      // deadline re-arms when the trigger changes mid-wait.
      const target = reconnecting
        ? (reconnectingSince.current ?? Date.now()) + APPEAR_RECONNECT_MS
        : (syncStartedAt ?? Date.now()) + APPEAR_SYNC_MS
      if (appearTimer.current) clearTimeout(appearTimer.current)
      appearTimer.current = setTimeout(
        () => {
          appearTimer.current = null
          shownAt.current = Date.now()
          setVisible(true)
        },
        Math.max(0, target - Date.now())
      )
      return
    }

    // Idle: connected, nothing catching up. A card that never appeared is
    // simply cancelled, and the next episode starts from scratch.
    if (appearTimer.current) {
      clearTimeout(appearTimer.current)
      appearTimer.current = null
    }
    if (!visible) {
      setEscapable(false)
      setDismissed(false)
      setSince(null)
      setSawReconnect(false)
      setSawSync(false)
      return
    }
    if (hideTimer.current) return
    const shownFor = Date.now() - (shownAt.current ?? 0)
    hideTimer.current = setTimeout(
      () => {
        hideTimer.current = null
        shownAt.current = null
        setVisible(false)
        setEscapable(false)
        // A dismissal is about this episode, not every one from now on.
        setDismissed(false)
        setSince(null)
        setSawReconnect(false)
        setSawSync(false)
      },
      Math.max(HANDOFF_GRACE_MS, MIN_VISIBLE_MS - shownFor)
    )
  }, [paired, reconnecting, syncStartedAt, busy, visible])

  const phase: 'reconnecting' | 'syncing' = reconnecting ? 'reconnecting' : 'syncing'

  // The way out arrives on the visible phase's own schedule. A phase change
  // before it lands re-arms it on the new phase's fuse; once offered it stays
  // — an escape that vanished mid-reach would be worse than none.
  useEffect(() => {
    if (!visible || escapable) {
      if (escapeTimer.current) clearTimeout(escapeTimer.current)
      escapeTimer.current = null
      return
    }
    if (escapeTimer.current) clearTimeout(escapeTimer.current)
    escapeTimer.current = setTimeout(
      () => {
        escapeTimer.current = null
        setEscapable(true)
      },
      phase === 'reconnecting' ? ESCAPE_RECONNECT_MS : ESCAPE_SYNC_MS
    )
    return () => {
      if (escapeTimer.current) clearTimeout(escapeTimer.current)
      escapeTimer.current = null
    }
  }, [visible, escapable, phase])

  if (!visible || !paired || dismissed) return null

  if (phase === 'reconnecting') {
    const status = state?.status ?? 'idle'
    // The relay tells us which side is missing, and that changes what the
    // user should do: their desktop being asleep is not the app being broken.
    const detail =
      status === 'waiting-for-peer'
        ? t('connecting.waitingPeer')
        : status === 'error' || state?.lastError
          ? t('connecting.retrying')
          : t('connecting.dialing')
    return (
      <BlockingProgress
        icon={<Activity04Icon size={22} className="text-primary" />}
        title={t('connecting.title')}
        body={t('connecting.body')}
        ratio={(PHASE_RATIO[status] ?? 0.2) * RECONNECT_SHARE}
        detail={detail}
        since={since}
        note={state?.reconnects ? t('connecting.attempts', { count: state.reconnects }) : undefined}
        escape={
          escapable
            ? {
                label: t('connecting.continueOffline'),
                hint: t('connecting.offlineHint'),
                onPress: () => setDismissed(true)
              }
            : undefined
        }
      />
    )
  }

  // Two quiet moments wear this phase with no activity to report, and they
  // sit at opposite ends of it. The handoff gap — connected, the reconcile a
  // beat away from reporting — shows the sync half at its start. The hold at
  // the end (the hide floor, the grace) says the work is over honestly: full
  // bar, last step, rather than freezing on whatever was mid-flight. The
  // clock keeps the start it had either way; the wait it is timing is the
  // one the user sat through.
  const shown =
    activity ??
    (sawSync ? { ratio: 1, step: 'wrapping' as const } : { ratio: 0, step: 'settings' as const })
  return (
    <BlockingProgress
      icon={<RefreshIcon size={22} className="text-primary" />}
      title={t('syncing.title')}
      body={t('syncing.body')}
      ratio={sawReconnect ? RECONNECT_SHARE + shown.ratio * (1 - RECONNECT_SHARE) : shown.ratio}
      detail={t(`syncing.step.${shown.step}`)}
      since={since}
      escape={
        escapable
          ? {
              label: t('syncing.continue'),
              hint: t('syncing.continueHint'),
              onPress: () => setDismissed(true)
            }
          : undefined
      }
    />
  )
}
