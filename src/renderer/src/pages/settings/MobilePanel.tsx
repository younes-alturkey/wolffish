import { Button } from '@components/core/Button'
import { Input } from '@components/core/Input'
import { Modal } from '@components/core/Modal'
import { useToast } from '@components/core/toast/useToast'
import { cn } from '@lib/utils/cn'
import type { MobileStatus } from '@preload/index'
import {
  AndroidIcon,
  AppleIcon,
  Copy01Icon,
  Globe02Icon,
  Key01Icon,
  KeyboardIcon,
  LinkSquare02Icon,
  PlugSocketIcon,
  QrCode01Icon,
  RefreshIcon,
  SquareLock01Icon,
  Tick02Icon,
  Unlink01Icon
} from 'hugeicons-react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'

/**
 * Mobile — the phone as a companion surface, managed like any other channel.
 *
 * Two differences from Telegram/WhatsApp shape the panel. There is no token to
 * paste: the desktop *offers* a pairing and the phone claims it, so the top of
 * the panel is either an offer or a live connection, never a form. And the
 * phone renders this whole app rather than a chat, so what is worth monitoring
 * is the tunnel itself — which keys are in play, whether the link is up, how
 * much has crossed it.
 *
 * Module-level snapshot cache mirrors TelegramPanel/GitHubPanel: the panel is
 * eagerly imported by Settings.tsx, so the status is already in memory by the
 * time the user opens it and paints on the first frame.
 */
let cachedStatus: MobileStatus | null = null
let loadPromise: Promise<MobileStatus | null> | null = null

function loadStatus(): Promise<MobileStatus | null> {
  if (cachedStatus) return Promise.resolve(cachedStatus)
  const api = window.api?.mobile
  if (!api) return Promise.resolve(null) // preload not ready; the mount effect retries
  if (!loadPromise) {
    loadPromise = api
      .status()
      .then((status) => {
        cachedStatus = status
        return cachedStatus
      })
      .catch(() => null)
      .finally(() => {
        loadPromise = null
      })
  }
  return loadPromise
}

void loadStatus()

// Keep the cache warm while the panel is closed so reopening paints live state.
window.api?.mobile?.onStatusChange((status) => {
  cachedStatus = status
})

const STATUS_DOT: Record<string, string> = {
  connected: 'bg-emerald-500',
  handshaking: 'bg-amber-500',
  connecting: 'bg-amber-500',
  'waiting-for-peer': 'bg-amber-500',
  reconnecting: 'bg-amber-500',
  error: 'bg-rose-500',
  idle: 'bg-border'
}

export function MobilePanel(): React.JSX.Element {
  const { t } = useTranslation()
  const toast = useToast()
  const [status, setStatus] = useState<MobileStatus | null>(cachedStatus)
  const [qr, setQr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [copied, setCopied] = useState(false)
  // Relay editing: the draft tracks the input; pending is what the confirm
  // dialog will apply — a URL string, or null for "back to the default".
  const [relayDraft, setRelayDraft] = useState('')
  const [pendingRelay, setPendingRelay] = useState<{ url: string | null } | null>(null)
  const loaded = status !== null

  useEffect(() => {
    let alive = true
    void loadStatus().then((next) => {
      if (alive && next) setStatus(next)
    })
    const off = window.api?.mobile?.onStatusChange((next) => {
      if (alive) setStatus(next)
    })
    return () => {
      alive = false
      off?.()
    }
  }, [])

  // Render the pairing payload as a QR whenever an offer is open. Encoded
  // locally — the payload carries a pairing secret and never leaves the app.
  const payload = status?.offer?.payload ?? null
  useEffect(() => {
    let alive = true
    if (!payload) {
      void Promise.resolve().then(() => {
        if (alive) setQr(null)
      })
      return () => {
        alive = false
      }
    }
    // Loaded here rather than at the top, matching WhatsAppPanel: qrcode is
    // only ever needed once a pairing offer exists, and a static import in one
    // of the two panels pins it into the main bundle for everyone.
    void import('qrcode')
      .then(({ default: QRCode }) =>
        QRCode.toDataURL(payload, { margin: 1, width: 240, errorCorrectionLevel: 'M' })
      )
      .then((url) => {
        if (alive) setQr(url)
      })
      .catch(() => {
        if (alive) setQr(null)
      })
    return () => {
      alive = false
    }
  }, [payload])

  const tunnel = status?.tunnel ?? null
  const offer = status?.offer ?? null
  const verbose = status?.verbose ?? null
  // Known before pairing: the endpoint the tunnel dials. The relay serves an
  // explanation page over plain HTTPS at the same host, so the link swaps
  // schemes rather than pointing anywhere new.
  const relayUrl = tunnel?.relayUrl ?? status?.relayUrl ?? null
  const relayPageUrl = relayUrl?.replace(/^wss:/, 'https:').replace(/^ws:/, 'http:') ?? null
  const defaultRelayUrl = status?.defaultRelayUrl ?? null
  const relayIsDefault = defaultRelayUrl === null || relayUrl === defaultRelayUrl

  // "iPhone 15 Pro · iOS 18.2" from whatever parts the phone actually sent.
  const deviceLine =
    [status?.pairing?.model, osLabel(status?.pairing?.platform, status?.pairing?.osVersion)]
      .filter(Boolean)
      .join(' · ') || '—'
  const methodLine = status?.pairing?.method
    ? t(`settings.mobile.methodValue.${status.pairing.method}`)
    : '—'

  // The draft follows the applied value — which only changes on apply/reset —
  // reconciled during render (not an effect) so unrelated status updates
  // (frame counters) never clobber keystrokes.
  const [draftBase, setDraftBase] = useState<string | null>(null)
  if (draftBase !== relayUrl) {
    setDraftBase(relayUrl)
    setRelayDraft(relayUrl ?? '')
  }
  const relayDraftChanged = loaded && relayDraft.trim() !== (relayUrl ?? '')

  // A countdown the panel can render purely: the deadline is fixed, this ticks.
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!offer) return
    const timer = setInterval(() => setNow(Date.now()), 30_000)
    return () => clearInterval(timer)
  }, [offer])

  const toggleOptions = useMemo(
    () => [
      { value: false, label: t('settings.mobile.toggle.off') },
      { value: true, label: t('settings.mobile.toggle.on') }
    ],
    [t]
  )

  const act = useCallback(
    async (run: () => Promise<MobileStatus>): Promise<void> => {
      setBusy(true)
      try {
        setStatus(await run())
      } catch {
        toast.show({ tone: 'error', message: t('settings.mobile.offerFailed') })
      } finally {
        setBusy(false)
      }
    },
    [t, toast]
  )

  const copyCode = (): void => {
    if (!offer?.code) return
    void navigator.clipboard.writeText(offer.code)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  // Applies a confirmed relay change (null = reset). The main process
  // normalizes and validates; a rejection here is a malformed URL.
  const changeRelay = async (url: string | null): Promise<void> => {
    setBusy(true)
    try {
      setStatus(await window.api.mobile.setRelayUrl(url))
      setPendingRelay(null)
    } catch {
      setPendingRelay(null)
      toast.show({ tone: 'error', message: t('settings.mobile.relayConfig.invalid') })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex min-h-full w-full items-start justify-center px-6 py-10">
      <div className="flex w-full max-w-2xl flex-col gap-6">
        <header className="flex flex-col gap-2">
          <h1 className="text-fg text-2xl font-semibold tracking-tight">
            {t('settings.mobile.title')}
          </h1>
          <p className="text-muted text-sm leading-relaxed">{t('settings.mobile.description')}</p>
        </header>

        {/* Paired: the live link. Unpaired: the way to make one. */}
        {status?.paired ? (
          <section className="bg-surface border-border flex flex-col gap-5 rounded-2xl border p-6">
            <div className="flex items-center justify-between gap-4">
              <div className="flex items-center gap-2">
                <span
                  className={cn(
                    'size-2 shrink-0 rounded-full',
                    STATUS_DOT[tunnel?.status ?? 'idle'] ?? 'bg-border'
                  )}
                />
                <span className="text-fg text-sm font-medium">
                  {t(`settings.mobile.status.${tunnel?.status ?? 'idle'}`)}
                </span>
              </div>
              {/* The phone itself, named and badged — a paired device the
                  user cannot identify at a glance is one they cannot decide
                  about. Icon only when the phone said what it is. */}
              <div className="flex min-w-0 items-center gap-2">
                {status.pairing?.platform === 'ios' && (
                  <AppleIcon size={14} className="text-muted shrink-0" />
                )}
                {status.pairing?.platform === 'android' && (
                  <AndroidIcon size={14} className="text-muted shrink-0" />
                )}
                <span className="text-fg truncate text-xs font-medium">
                  {status.pairing?.deviceName ?? t('settings.mobile.unknownDevice')}
                </span>
              </div>
            </div>

            <div className="border-border/60 border-t" />

            <dl className="grid grid-cols-2 gap-x-6 gap-y-4">
              <Row label={t('settings.mobile.device')} value={deviceLine} />
              <Row
                label={t('settings.mobile.pairedAt')}
                value={
                  status.pairing?.pairedAt
                    ? new Date(status.pairing.pairedAt).toLocaleString()
                    : '—'
                }
              />
              <Row
                label={t('settings.mobile.appVersion')}
                value={status.pairing?.appVersion ?? '—'}
              />
              <Row label={t('settings.mobile.method')} value={methodLine} />
              <Row label={t('settings.mobile.relay')} value={tunnel?.relayUrl ?? '—'} />
              <Row label={t('settings.mobile.rendezvous')} value={tunnel?.rendezvous ?? '—'} mono />
              <Row label={t('settings.mobile.keyDesktop')} value={tunnel?.ownKey ?? '—'} mono />
              <Row label={t('settings.mobile.keyPhone')} value={tunnel?.peerKey ?? '—'} mono />
              <Row label={t('settings.mobile.session')} value={tunnel?.session ?? '—'} mono />
              <Row label={t('settings.mobile.cipher')} value="ChaCha20-Poly1305 · X25519" mono />
              <Row
                label={t('settings.mobile.frames')}
                value={`${tunnel?.framesSent ?? 0} ↑ · ${tunnel?.framesReceived ?? 0} ↓`}
              />
              <Row
                label={t('settings.mobile.lastSeen')}
                value={
                  status.pairing?.lastSeenAt
                    ? new Date(status.pairing.lastSeenAt).toLocaleString()
                    : '—'
                }
              />
            </dl>

            <p className="text-muted text-xs leading-relaxed">
              {t('settings.mobile.fingerprintHint')}
            </p>

            <div className="border-border/60 border-t" />

            {/* Both ways out live with the connection they end, each saying
                what it does — at the foot of the panel they read as a pair of
                unlabelled buttons, and the difference between them is the
                whole point. */}
            <ActionRow
              icon={<PlugSocketIcon size={18} className="text-muted mt-0.5 shrink-0" />}
              title={t('settings.mobile.disconnect')}
              body={t('settings.mobile.disconnectHint')}
              action={
                <Button
                  variant="outline"
                  disabled={busy || tunnel === null}
                  onClick={() => void act(() => window.api.mobile.disconnect())}
                >
                  {t('settings.mobile.disconnect')}
                </Button>
              }
            />
            <ActionRow
              icon={<Unlink01Icon size={18} className="mt-0.5 shrink-0 text-rose-500" />}
              title={t('settings.mobile.unpair')}
              body={t('settings.mobile.unpairHint')}
              action={
                <Button
                  variant="outline"
                  disabled={busy}
                  onClick={() => void act(() => window.api.mobile.unpair())}
                >
                  {t('settings.mobile.unpairAction')}
                </Button>
              }
            />
          </section>
        ) : (
          <section className="bg-surface border-border flex flex-col gap-5 rounded-2xl border p-6">
            {offer ? (
              <div className="flex flex-col items-center gap-4">
                {offer.mode === 'qr' ? (
                  <>
                    {qr ? (
                      <img
                        src={qr}
                        alt={t('settings.mobile.qrAlt')}
                        width={240}
                        height={240}
                        className="border-border rounded-xl border bg-white p-2"
                      />
                    ) : (
                      <div
                        aria-hidden="true"
                        className="bg-border/30 size-60 animate-pulse rounded-xl"
                      />
                    )}
                    <p className="text-muted max-w-sm text-center text-sm leading-relaxed">
                      {t('settings.mobile.scanHint')}
                    </p>
                  </>
                ) : (
                  <>
                    <button
                      type="button"
                      onClick={copyCode}
                      className={cn(
                        'border-border hover:bg-border/30 flex cursor-pointer items-center gap-3 rounded-xl border px-6 py-4',
                        'focus-visible:ring-accent focus-visible:ring-offset-bg font-mono text-2xl tracking-[0.2em] focus-visible:ring-2 focus-visible:ring-offset-2'
                      )}
                    >
                      {offer.code}
                      {copied ? (
                        <Tick02Icon size={18} className="text-emerald-500" />
                      ) : (
                        <Copy01Icon size={18} className="text-muted" />
                      )}
                    </button>
                    <p className="text-muted max-w-sm text-center text-sm leading-relaxed">
                      {t('settings.mobile.codeHint')}
                    </p>
                    {/* The code carries only the secret; on a custom relay
                        the phone must be told the address by hand. */}
                    {!relayIsDefault && relayUrl && (
                      <div className="flex flex-col items-center gap-1">
                        <p className="text-muted max-w-sm text-center text-sm leading-relaxed">
                          {t('settings.mobile.codeRelayHint')}
                        </p>
                        <span dir="ltr" className="text-fg break-all text-center font-mono text-xs">
                          {relayUrl}
                        </span>
                      </div>
                    )}
                  </>
                )}
                <p className="text-muted text-xs">
                  {t('settings.mobile.expires', {
                    minutes: Math.max(1, Math.round((offer.expiresAt - now) / 60000))
                  })}
                </p>
                <div className="flex gap-2">
                  <Button
                    variant="ghost"
                    disabled={busy}
                    onClick={() =>
                      void act(() =>
                        offer.mode === 'qr'
                          ? window.api.mobile.offerQr()
                          : window.api.mobile.offerCode()
                      )
                    }
                  >
                    <RefreshIcon size={16} />
                    {t('settings.mobile.newCode')}
                  </Button>
                  <Button
                    variant="ghost"
                    disabled={busy}
                    onClick={() => void act(() => window.api.mobile.unpair())}
                  >
                    {t('common.cancel')}
                  </Button>
                </div>
              </div>
            ) : (
              <div className="flex flex-col gap-5">
                <p className="text-muted text-sm leading-relaxed">
                  {t('settings.mobile.notPaired')}
                </p>
                <div className="flex items-center justify-between gap-4">
                  <div className="flex min-w-0 items-start gap-3">
                    <QrCode01Icon size={18} className="text-muted mt-0.5 shrink-0" />
                    <div className="flex flex-col gap-1">
                      <span className="text-fg text-sm font-medium">
                        {t('settings.mobile.qrTitle')}
                      </span>
                      <p className="text-muted text-xs leading-relaxed">
                        {t('settings.mobile.qrDesc')}
                      </p>
                    </div>
                  </div>
                  <Button
                    disabled={busy}
                    className="shrink-0"
                    onClick={() => void act(() => window.api.mobile.offerQr())}
                  >
                    {t('settings.mobile.generate')}
                  </Button>
                </div>
                <div className="border-border/60 border-t" />
                {/* The typed code carries only the secret, so on a custom
                    relay the description tells the user the phone needs the
                    relay address too — it has a field for it, and the offer
                    screen shows the address to type. */}
                <div className="flex items-center justify-between gap-4">
                  <div className="flex min-w-0 items-start gap-3">
                    <KeyboardIcon size={18} className="text-muted mt-0.5 shrink-0" />
                    <div className="flex flex-col gap-1">
                      <span className="text-fg text-sm font-medium">
                        {t('settings.mobile.codeTitle')}
                      </span>
                      <p className="text-muted text-xs leading-relaxed">
                        {relayIsDefault
                          ? t('settings.mobile.codeDesc')
                          : t('settings.mobile.codeDescCustomRelay')}
                      </p>
                    </div>
                  </div>
                  <Button
                    variant="outline"
                    disabled={busy}
                    className="shrink-0"
                    onClick={() => void act(() => window.api.mobile.offerCode())}
                  >
                    {t('settings.mobile.generate')}
                  </Button>
                </div>
              </div>
            )}
          </section>
        )}

        {/* The stores' permanent links — installing the app is step zero of
            pairing, so the panel hands them over instead of sending the user
            hunting. */}
        <section className="bg-surface border-border flex flex-col gap-5 rounded-2xl border p-6">
          <div className="flex flex-col gap-1">
            <span className="text-fg text-sm font-medium">{t('settings.mobile.getApp.title')}</span>
            <p className="text-muted text-xs leading-relaxed">{t('settings.mobile.getApp.body')}</p>
          </div>
          <div className="flex items-center justify-between gap-4">
            <div className="flex min-w-0 items-center gap-3">
              <AppleIcon size={18} className="text-muted shrink-0" />
              <span className="text-fg text-sm font-medium">{t('settings.mobile.getApp.ios')}</span>
            </div>
            <ExternalLink
              href="https://apps.apple.com/us/app/wolffish/id6792797989"
              label={t('settings.mobile.getApp.appStore')}
            />
          </div>
          <div className="border-border/60 border-t" />
          <div className="flex items-center justify-between gap-4">
            <div className="flex min-w-0 items-center gap-3">
              <AndroidIcon size={18} className="text-muted shrink-0" />
              <span className="text-fg text-sm font-medium">
                {t('settings.mobile.getApp.android')}
              </span>
            </div>
            <ExternalLink
              href="https://play.google.com/store/apps/details?id=sh.wolffi.mobile"
              label={t('settings.mobile.getApp.googlePlay')}
            />
          </div>
        </section>

        {/* The relay, a card of its own — nothing about it hides in code.
            Power users point this at a self-hosted deployment; the next
            pairing carries the new address to the phone. */}
        <section className="bg-surface border-border flex flex-col gap-5 rounded-2xl border p-6">
          <div className="flex items-center justify-between gap-4">
            <span className="text-fg text-sm font-medium">{t('settings.mobile.relay')}</span>
            {relayPageUrl && (
              <ExternalLink href={relayPageUrl} label={t('settings.mobile.openRelay')} />
            )}
          </div>

          <p className="text-muted text-sm leading-relaxed">
            {t('settings.mobile.relayConfig.body')}
          </p>

          <Input
            label={t('settings.mobile.relayConfig.inputLabel')}
            dir="ltr"
            value={relayDraft}
            onChange={(e) => setRelayDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && relayDraftChanged && !busy)
                setPendingRelay({ url: relayDraft.trim() || null })
            }}
            placeholder={defaultRelayUrl ?? 'wss://…'}
            disabled={busy || !loaded}
            spellCheck={false}
            className="text-left font-mono text-xs"
          />

          <div className="flex items-center justify-between gap-4">
            <div className="flex gap-2">
              <Button
                disabled={busy || !relayDraftChanged}
                onClick={() => setPendingRelay({ url: relayDraft.trim() || null })}
              >
                {t('settings.mobile.relayConfig.apply')}
              </Button>
              {!relayIsDefault && (
                <Button
                  variant="outline"
                  disabled={busy}
                  onClick={() => setPendingRelay({ url: null })}
                >
                  {t('settings.mobile.relayConfig.reset')}
                </Button>
              )}
            </div>
            <ExternalLink
              href="https://github.com/thewolffish/wolffish-relay"
              label={t('settings.mobile.relayConfig.repo')}
            />
          </div>
        </section>

        <section className="bg-surface border-border flex flex-col gap-5 rounded-2xl border p-6">
          {/* Model-initiated push notifications — the notify_phone tool's
              master switch. Off means the tool refuses before anything is
              built or sent; nothing about this is automatic either way, the
              model has to deliberately call the tool. */}
          <div className="flex items-center justify-between gap-4">
            <div className="flex flex-col gap-1">
              <span className="text-fg text-sm font-medium">
                {t('settings.mobile.notifications')}
              </span>
              <p className="text-muted text-xs">{t('settings.mobile.notificationsHint')}</p>
            </div>
            {status === null ? (
              <div
                aria-hidden="true"
                className="bg-border/30 h-7 w-19.5 shrink-0 animate-pulse rounded-lg"
              />
            ) : (
              <div
                role="tablist"
                className="border-border bg-bg/40 inline-flex shrink-0 items-center rounded-lg border p-0.5"
              >
                {toggleOptions.map((opt) => {
                  const active = opt.value === status.notificationsEnabled
                  return (
                    <button
                      key={String(opt.value)}
                      role="tab"
                      type="button"
                      aria-selected={active}
                      disabled={busy || !loaded}
                      onClick={() => {
                        if (opt.value !== status.notificationsEnabled)
                          void act(() => window.api.mobile.setNotifications(opt.value))
                      }}
                      className={cn(
                        'rounded-md px-3 py-1 text-xs font-medium',
                        'focus-visible:ring-accent focus-visible:ring-offset-bg focus-visible:ring-2 focus-visible:ring-offset-2',
                        active
                          ? 'bg-primary text-primary-fg shadow-sm'
                          : 'text-muted hover:text-fg cursor-pointer'
                      )}
                    >
                      {opt.label}
                    </button>
                  )
                })}
              </div>
            )}
          </div>
          {/* Verbose tunnel logging — off (default) keeps the app log quiet.
              On records every connection event, which is what you want while
              diagnosing a link and noise otherwise. Uses the same segmented
              control every other channel uses. */}
          <div className="flex items-center justify-between gap-4">
            <div className="flex flex-col gap-1">
              <span className="text-fg text-sm font-medium">{t('settings.mobile.verbose')}</span>
              <p className="text-muted text-xs">{t('settings.mobile.verboseHint')}</p>
            </div>
            {verbose === null ? (
              <div
                aria-hidden="true"
                className="bg-border/30 h-7 w-19.5 shrink-0 animate-pulse rounded-lg"
              />
            ) : (
              <div
                role="tablist"
                className="border-border bg-bg/40 inline-flex shrink-0 items-center rounded-lg border p-0.5"
              >
                {toggleOptions.map((opt) => {
                  const active = opt.value === verbose
                  return (
                    <button
                      key={String(opt.value)}
                      role="tab"
                      type="button"
                      aria-selected={active}
                      disabled={busy || !loaded}
                      onClick={() => {
                        if (opt.value !== verbose)
                          void act(() => window.api.mobile.setVerbose(opt.value))
                      }}
                      className={cn(
                        'rounded-md px-3 py-1 text-xs font-medium',
                        'focus-visible:ring-accent focus-visible:ring-offset-bg focus-visible:ring-2 focus-visible:ring-offset-2',
                        active
                          ? 'bg-primary text-primary-fg shadow-sm'
                          : 'text-muted hover:text-fg cursor-pointer'
                      )}
                    >
                      {opt.label}
                    </button>
                  )
                })}
              </div>
            )}
          </div>
        </section>

        {/* How it works — the same assurance the phone's Relay screen carries,
            so the two devices tell one story: pinned keys, sealed frames, and
            a relay that can forward but never read. */}
        <section className="bg-surface border-border flex flex-col gap-5 rounded-2xl border p-6">
          <span className="text-fg text-sm font-medium">{t('settings.mobile.how.title')}</span>

          <HowRow
            icon={<Key01Icon size={18} className="text-muted mt-0.5 shrink-0" />}
            title={t('settings.mobile.how.pairTitle')}
            body={t('settings.mobile.how.pairBody')}
          />
          <HowRow
            icon={<SquareLock01Icon size={18} className="text-muted mt-0.5 shrink-0" />}
            title={t('settings.mobile.how.e2eTitle')}
            body={t('settings.mobile.how.e2eBody')}
          />
          <HowRow
            icon={<Globe02Icon size={18} className="text-muted mt-0.5 shrink-0" />}
            title={t('settings.mobile.how.relayTitle')}
            body={t('settings.mobile.how.relayBody')}
          />

          <p className="text-muted text-xs leading-relaxed">
            {t('settings.mobile.keyStorage', { backend: status?.storage.backend ?? '—' })}
          </p>
        </section>

        {/* Confirm before a relay change: both the offer payload and a paired
            phone name the old relay, so this is never a silent switch. */}
        <Modal
          open={pendingRelay !== null}
          onClose={() => setPendingRelay(null)}
          title={t('settings.mobile.relayConfig.confirmTitle')}
          footer={
            <div className="flex gap-2">
              <Button
                variant="outline"
                size="sm"
                className="flex-1"
                onClick={() => setPendingRelay(null)}
              >
                {t('common.cancel')}
              </Button>
              <Button
                size="sm"
                className="flex-1"
                disabled={busy}
                onClick={() => {
                  if (pendingRelay) void changeRelay(pendingRelay.url)
                }}
              >
                {t('settings.mobile.relayConfig.confirmApply')}
              </Button>
            </div>
          }
        >
          <p className="text-muted">{t('settings.mobile.relayConfig.confirmBody')}</p>
          <p dir="ltr" className="text-fg break-all text-left font-mono text-xs">
            {pendingRelay?.url ?? defaultRelayUrl ?? ''}
          </p>
          {pendingRelay !== null && pendingRelay.url !== null && (
            <p className="text-muted">
              {t('settings.mobile.relayConfig.confirmCompat')}{' '}
              <a
                href="https://github.com/thewolffish/wolffish-relay"
                target="_blank"
                rel="noopener noreferrer"
                className="text-fg underline underline-offset-2"
              >
                {t('settings.mobile.relayConfig.repo')}
              </a>
            </p>
          )}
          {status?.paired && (
            <p className="text-muted">{t('settings.mobile.relayConfig.confirmUnpair')}</p>
          )}
        </Modal>
      </div>
    </div>
  )
}

/** "iOS 18.2" / "Android 15" — the OS name the platform implies, plus its
 *  version. Either half may be missing; null when both are. */
function osLabel(platform: string | null | undefined, version: string | null | undefined): string {
  const name = platform === 'ios' ? 'iOS' : platform === 'android' ? 'Android' : null
  return [name, version].filter(Boolean).join(' ')
}

function ExternalLink({ href, label }: { href: string; label: string }): React.JSX.Element {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className={cn(
        'text-muted hover:text-fg flex shrink-0 items-center gap-1.5 text-xs',
        'focus-visible:ring-accent focus-visible:ring-offset-bg rounded-md px-1.5 py-1 focus-visible:ring-2 focus-visible:ring-offset-2'
      )}
    >
      <span>{label}</span>
      <LinkSquare02Icon size={13} className="shrink-0" />
    </a>
  )
}

/** An action with its reason attached: icon, what it is, what it does. */
function ActionRow({
  icon,
  title,
  body,
  action
}: {
  icon: React.ReactNode
  title: string
  body: string
  action: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="flex items-start justify-between gap-4">
      <div className="flex min-w-0 items-start gap-3">
        {icon}
        <div className="flex flex-col gap-1">
          <span className="text-fg text-sm font-medium">{title}</span>
          <p className="text-muted text-xs leading-relaxed">{body}</p>
        </div>
      </div>
      <div className="shrink-0">{action}</div>
    </div>
  )
}

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
    <div className="flex items-start gap-3">
      {icon}
      <div className="flex min-w-0 flex-col gap-1">
        <span className="text-fg text-sm font-medium">{title}</span>
        <p className="text-muted text-xs leading-relaxed">{body}</p>
      </div>
    </div>
  )
}

function Row({
  label,
  value,
  mono
}: {
  label: string
  value: string
  mono?: boolean
}): React.JSX.Element {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <dt className="text-muted text-xs">{label}</dt>
      <dd className={cn('text-fg truncate text-sm', mono && 'font-mono text-xs')} title={value}>
        {value}
      </dd>
    </div>
  )
}
