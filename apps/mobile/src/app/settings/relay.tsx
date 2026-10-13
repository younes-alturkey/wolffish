import { Button } from '@/components/core/Button'
import { ConfirmDialog } from '@/components/core/ConfirmDialog'
import {
  Activity04Icon,
  ArrowDown02Icon,
  ArrowUp02Icon,
  CancelCircleIcon,
  Clock01Icon,
  FlashIcon,
  QrCode01Icon,
  RefreshIcon
} from '@/components/core/icons'
import { GithubLogo } from '@/components/core/providerLogos'
import { InfoRow, PanelScreen, Section, StatusDot } from '@/components/settings/SettingsUI'
import { cn } from '@/lib/utils/cn'
import { formatRelativeTime } from '@/lib/utils/relativeTime'

const RELAY_REPO_URL = 'https://github.com/younes-alturkey/wolffish/tree/main/packages/relay'
import { factoryResetDevice } from '@/lib/demo/factoryReset'
import { applyConfigSnapshot } from '@/lib/demo/importer'
import { getDemoLastSyncAt, reconnectDemoRelay, useDemoRelayState } from '@/lib/demo/relay'
import { clearAllBadges, unregisterPush } from '@/lib/notifications/push'
import { beginSync } from '@/lib/sync/activity'
import { getLastSyncedAt, refreshConfig, refreshSync } from '@/lib/sync/sync'
import { tunnelClient } from '@/lib/tunnel/client'
import { describeTunnelStatus, useTunnelState, useTunnelStatus } from '@/lib/tunnel/useTunnelStatus'
import { useAppStore } from '@/state/appStore'
import { useToast } from '@/providers/toast/useToast'
import { router } from 'expo-router'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Pressable, Text, View } from 'react-native'
import * as WebBrowser from 'expo-web-browser'

/**
 * Relay — the connection itself: where it goes, what protects it, and what
 * the relay in the middle can and cannot see.
 *
 * The first screen in Settings when paired — and in demo mode, where the same
 * rows describe the tour's made-up link (lib/demo/relay): always connected,
 * stable fingerprints, counters that move. The cipher fingerprints are here so
 * the two devices can be compared at a glance: the same short forms appear in
 * the desktop's Mobile panel, and matching values mean both ends agree on
 * which keys are in play.
 */
export default function RelayScreen(): React.JSX.Element {
  const { t } = useTranslation()
  const toast = useToast()
  const setPaired = useAppStore((state) => state.setPaired)
  const demoMode = useAppStore((state) => state.demoMode)
  const liveState = useTunnelState()
  const demoState = useDemoRelayState()
  // One variable for every row below, so none of them knows which mode it is
  // rendering — the demo state is a real TunnelState, just an invented one.
  const state = demoMode ? demoState : liveState
  // Same word and colour the Settings list shows for this row — one mapping,
  // so the two cannot disagree about what the link is doing. The demo pushes
  // its permanent 'connected' through that same mapping.
  const liveStatus = useTunnelStatus()
  const { label: statusLabel, tone: statusTone } = demoMode
    ? describeTunnelStatus('connected', t)
    : liveStatus
  // The demo keeps its own catch-up clock (stamped by the snapshot reads it
  // actually performs); the live one belongs to the sync module.
  const readLastSyncAt = demoMode ? getDemoLastSyncAt : getLastSyncedAt
  const [busy, setBusy] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [lastSyncAt, setLastSyncAt] = useState<number | null>(readLastSyncAt)
  // Ages the "2m ago" label between syncs; the value itself has not changed.
  const [, setTick] = useState(0)

  // The catch-up that runs on foreground finishes after this screen mounts,
  // so poll the module's timestamp rather than reading it once.
  useEffect(() => {
    const timer = setInterval(() => {
      setLastSyncAt(readLastSyncAt())
      setTick((n) => n + 1)
    }, 5_000)
    return () => clearInterval(timer)
    // readLastSyncAt is picked by demoMode, which cannot change while this
    // screen is mounted — both exits unmount the whole stack.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const resync = async (): Promise<void> => {
    setBusy(true)
    // The demo's catch-up is the same read its entry runs: the saved config
    // snapshot, which stamps the demo link's sync clock itself. Nothing can
    // have changed — the dataset is this device's own — so the honest answer
    // is the live path's no-change one, without the sync dialog a network
    // round-trip earns.
    if (demoMode) {
      await applyConfigSnapshot()
      setLastSyncAt(readLastSyncAt())
      toast.show({ tone: 'success', message: t('relay.resynced', { count: 0 }) })
      setBusy(false)
      return
    }
    // Reported so a slow manual sync gets the same dialog a background one
    // does. Wrapped here rather than inside refreshSync: reconcile calls
    // that too, and a nested reporter would fight its two-half progress.
    const progress = beginSync()
    try {
      // The button says "resync", and the user means everything they can see:
      // settings and usage travel in the config snapshot, conversations in
      // the index — pull both, plus the id sweep only a manual pass asks for.
      let settings = false
      let conversations = false
      const [, result] = await Promise.all([
        refreshConfig().finally(() => {
          settings = true
          progress.step({ settings, conversations })
        }),
        refreshSync(true).finally(() => {
          conversations = true
          progress.step({ settings, conversations })
        })
      ])
      setLastSyncAt(Date.now())
      toast.show({ tone: 'success', message: t('relay.resynced', { count: result.changed }) })
    } catch (error) {
      // A failure here usually means the session died without the status
      // noticing. Say so plainly and rebuild the link rather than leaving a
      // button that will fail identically for as long as it is pressed.
      tunnelClient.reportRpcFailure(error)
      toast.show({ tone: 'error', message: t('relay.resyncStale') })
    } finally {
      progress.end()
      setBusy(false)
    }
  }

  /** Drop the socket and build a fresh one — the manual version of what
   *  returning to the app does, for a link that has gone quiet. */
  /**
   * Rebuild the link. Deliberately does not await the connection: the tunnel
   * parks at the rendezvous until the desktop is there, which can be a while
   * if the desktop is asleep, and holding the button busy for that long makes
   * a working reconnect look like a hang. The status row above reports the
   * outcome as it happens.
   */
  const reconnect = (): void => {
    // The fiction rebuilds instantly: "Connected for" resets and the
    // reconnect counter moves — the same rows a real rebuild moves — with no
    // socket to drop or wait on.
    if (demoMode) {
      reconnectDemoRelay()
      return
    }
    setBusy(true)
    tunnelClient.suspend()
    void tunnelClient
      .resume()
      .catch(() => toast.show({ tone: 'error', message: t('relay.reconnectFailed') }))
      .finally(() => setBusy(false))
  }

  /**
   * Disconnect: drop the keys AND everything that came down the tunnel.
   *
   * The synced conversations, settings and usage on this phone are a copy of
   * the desktop's, readable by anyone holding the unlocked phone. Leaving them
   * behind would be the surprise; wiping is the point. The desktop keeps the
   * originals, so pairing again restores all of it.
   */
  const unpair = async (): Promise<void> => {
    setBusy(true)
    setConfirming(false)
    try {
      if (demoMode) {
        // Leaving the tour. No badges, push registration or socket ever
        // existed here — the imported dataset is the whole footprint, and
        // this is the same wipe the Data screen's factory reset runs.
        await factoryResetDevice()
      } else {
        // Badges first, while the socket is still up: zeroing the relay's
        // per-device count is a control frame, and the wipe below deletes the
        // conversations the buckets describe. Then the relay forgets the device
        // entirely — token, badge, registration — so a severed phone stops
        // being pushable instead of collecting notifications for a workspace
        // it no longer holds. Both must precede the socket drop.
        await clearAllBadges()
        await unregisterPush()
        await tunnelClient.disconnect()
        await factoryResetDevice()
        setPaired(false)
      }
    } catch {
      setBusy(false)
      toast.show({ tone: 'error', message: t('relay.unpairFailed') })
      return
    }
    setBusy(false)
    // Back to the door: demo mode is immediately available again.
    router.replace('/')
  }

  // What the phone can honestly say about being current: the desktop pushes
  // changes as they happen, and a catch-up runs on every return to the app.
  // There is no timer to count down to, so none is implied.
  const syncLine = lastSyncAt
    ? t('relay.syncLive', { ago: formatRelativeTime(lastSyncAt, t) })
    : t('relay.syncLivePending')

  return (
    <PanelScreen title={t('settings.tabs.relay')} subtitle={t('relay.subtitle')}>
      <Section title={t('relay.connection')}>
        <View className="flex-row items-center justify-between px-1 py-2">
          <Text className="text-muted font-sans text-sm">{t('relay.status.label')}</Text>
          <View className="flex-row items-center gap-2">
            <StatusDot tone={statusTone} />
            <Text className="text-fg font-sans text-sm">{statusLabel}</Text>
          </View>
        </View>
        <InfoRow label={t('relay.rendezvous')} value={state?.rendezvous ?? '—'} mono />
        {/* Always rendered. This row appearing the instant the link came up
            shoved everything below it down a line, so the value carries the
            state instead of the row's existence. Relative, not a clock time:
            "3d" answers the question a bare timestamp makes you compute. */}
        <InfoRow
          label={t('relay.since')}
          value={state?.connectedAt ? formatRelativeTime(state.connectedAt, t) : '—'}
        />
        {/* Endpoint and error verbatim: both are values to read exactly and
            quote back when something is wrong, not prose to skim. */}
        <CodeLine label={t('relay.endpoint')} value={state?.relayUrl ?? '—'} />
        {state?.lastError ? (
          <CodeLine label={t('relay.lastError')} value={state.lastError} tone="error" />
        ) : null}
      </Section>

      {/* Sync gets its own card: it is the one routine action here, and it
          answers "is this phone current?" — which the timing line below it
          states rather than implies. */}
      <Section title={t('relay.sync')}>
        <ActionRow
          icon={<RefreshIcon size={18} className="text-muted" />}
          title={t('relay.resync')}
          description={t('relay.resyncHint')}
          action={
            <Button size="sm" variant="outline" onPress={() => void resync()} disabled={busy}>
              {t('relay.resyncNow')}
            </Button>
          }
        />
        {/* How the phone stays current, stated rather than implied — a
            "schedule" line invited the question of when the next one is,
            and there is no timer to name. */}
        <HowRow
          icon={<FlashIcon size={16} className="text-muted" />}
          title={t('relay.how.pushTitle')}
          body={t('relay.how.pushBody')}
        />
        <HowRow
          icon={<Activity04Icon size={16} className="text-muted" />}
          title={t('relay.how.wakeTitle')}
          body={t('relay.how.wakeBody')}
        />
        <HowRow
          icon={<Clock01Icon size={16} className="text-muted" />}
          title={t('relay.how.lastTitle')}
          body={syncLine}
        />
      </Section>

      <Section title={t('relay.manage')}>
        <ActionRow
          icon={<Activity04Icon size={18} className="text-muted" />}
          title={t('relay.reconnect')}
          description={t('relay.reconnectHint')}
          action={
            <Button size="sm" variant="outline" onPress={reconnect} disabled={busy}>
              {t('relay.reconnectAction')}
            </Button>
          }
        />
        <ActionRow
          icon={<QrCode01Icon size={18} className="text-muted" />}
          title={t('relay.repair')}
          description={t('relay.repairHint')}
          action={
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onPress={() => router.push('/?stay=1')}
            >
              {t('relay.repairAction')}
            </Button>
          }
        />
        {/* The demo wording tells the truth about what the button wipes —
            sample data, not keys — while the action keeps its name. */}
        <ActionRow
          icon={<CancelCircleIcon size={18} className="text-rose-500" />}
          title={t('relay.unpair')}
          description={t(demoMode ? 'relay.demoUnpairHint' : 'relay.unpairHint')}
          action={
            <Button size="sm" variant="danger" onPress={() => setConfirming(true)} disabled={busy}>
              {t('relay.unpairAction')}
            </Button>
          }
        />
      </Section>

      {/* The safety-number screen, in miniature: matching fingerprints on both
          devices mean the session is genuinely shared and nothing sits between. */}
      <Section title={t('relay.encryption')}>
        <Text className="text-muted px-1 pb-2 font-sans text-xs leading-5">
          {t('relay.encryptionHint')}
        </Text>
        <InfoRow label={t('relay.keyThis')} value={state?.ownKey ?? '—'} mono />
        <InfoRow label={t('relay.keyDesktop')} value={state?.peerKey ?? '—'} mono />
        <InfoRow label={t('relay.session')} value={state?.session ?? '—'} mono />
        <InfoRow label={t('relay.cipher')} value="ChaCha20-Poly1305 · X25519" mono />
      </Section>

      <Section title={t('relay.traffic')}>
        <IconRow
          icon={<ArrowUp02Icon size={16} className="text-muted" />}
          label={t('relay.framesSent')}
          value={String(state?.framesSent ?? 0)}
        />
        <IconRow
          icon={<ArrowDown02Icon size={16} className="text-muted" />}
          label={t('relay.framesReceived')}
          value={String(state?.framesReceived ?? 0)}
        />
        <IconRow
          icon={<RefreshIcon size={16} className="text-muted" />}
          label={t('relay.reconnects')}
          value={String(state?.reconnects ?? 0)}
        />
      </Section>

      <Section title={t('relay.privacy')}>
        <Text className="text-muted px-1 font-sans text-sm leading-relaxed">
          {t('relay.privacyBody')}
        </Text>
        {/* The claim above is checkable — the relay is open source, and this
            is the shortest path from reading it to verifying it. */}
        <Pressable
          onPress={() => void WebBrowser.openBrowserAsync(RELAY_REPO_URL)}
          className="flex-row items-center gap-2 px-1 py-2"
        >
          <GithubLogo size={16} className="text-muted" />
          <Text className="text-muted font-sans text-sm underline">{t('relay.source')}</Text>
        </Pressable>
      </Section>

      {/* Confirmed, because it is not reversible from this device: the copy
          here is gone until the desktop sends it again. */}
      <ConfirmDialog
        open={confirming}
        busy={busy}
        title={t(demoMode ? 'relay.demoUnpairConfirmTitle' : 'relay.unpairConfirmTitle')}
        message={t(demoMode ? 'relay.demoUnpairConfirmBody' : 'relay.unpairConfirmBody')}
        confirmLabel={t('relay.unpairAction')}
        cancelLabel={t('common.cancel')}
        onConfirm={() => void unpair()}
        onCancel={() => setConfirming(false)}
      />
    </PanelScreen>
  )
}

/** An action with its reason attached: icon, what it is, what it does. */
function ActionRow({
  icon,
  title,
  description,
  action
}: {
  icon: React.ReactNode
  title: string
  description: string
  action: React.ReactNode
}): React.JSX.Element {
  return (
    <View className="flex-row items-start gap-3 px-1 py-2">
      <View className="mt-0.5">{icon}</View>
      <View className="flex-1 gap-0.5">
        <Text className="text-fg text-left font-sans-medium text-sm">{title}</Text>
        <Text className="text-muted text-left font-sans text-xs leading-relaxed">
          {description}
        </Text>
      </View>
      <View className="shrink-0">{action}</View>
    </View>
  )
}

/** A stat with its direction shown, not just named. */
function IconRow({
  icon,
  label,
  value
}: {
  icon: React.ReactNode
  label: string
  value: string
}): React.JSX.Element {
  return (
    <View className="flex-row items-center justify-between px-1 py-2">
      <View className="flex-row items-center gap-2">
        {icon}
        <Text className="text-muted font-sans text-sm">{label}</Text>
      </View>
      <Text className="text-fg font-sans text-sm">{value}</Text>
    </View>
  )
}

/** One fact about how syncing behaves — the pairing sheet's row, reused. */
function HowRow({
  icon,
  title,
  body
}: {
  icon: React.ReactNode
  title: string
  body: string
}): React.JSX.Element {
  return (
    <View className="flex-row items-start gap-3 px-1 py-2">
      <View className="mt-0.5">{icon}</View>
      <View className="flex-1 gap-0.5">
        <Text className="text-fg text-left font-sans-medium text-sm">{title}</Text>
        <Text className="text-muted text-left font-sans text-xs leading-relaxed">{body}</Text>
      </View>
    </View>
  )
}

/** A value to be read exactly — an endpoint, an error — in its own block. */
function CodeLine({
  label,
  value,
  tone
}: {
  label: string
  value: string
  tone?: 'error'
}): React.JSX.Element {
  return (
    <View className="gap-1 px-1 py-2">
      <Text className="text-muted text-left font-sans text-xs">{label}</Text>
      <View
        className={cn(
          'bg-bg border-border rounded-lg border px-3 py-2',
          tone === 'error' && 'border-rose-500/40'
        )}
      >
        {/* LTR base direction: a URL or error string must not be reordered
            by the surrounding Arabic layout. */}
        <Text
          selectable
          style={{ writingDirection: 'ltr' }}
          className="text-fg text-left font-mono text-[11px] leading-4"
        >
          {value}
        </Text>
      </View>
    </View>
  )
}
