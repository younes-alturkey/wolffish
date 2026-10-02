import { Button } from '@components/core/Button'
import { Input } from '@components/core/Input'
import { Select, type SelectOption } from '@components/core/Select'
import { useToast } from '@components/core/toast/useToast'
import { cn } from '@lib/utils/cn'
import type { WhatsAppChannelStatus, WhatsAppConfig } from '@preload/index'
import { WhatsappIcon } from 'hugeicons-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Trans, useTranslation } from 'react-i18next'

// <cmd> tags in locale strings render as LTR code chips (matches the
// CommandsSection chip) so slash commands read correctly inside Arabic text.
const TRANS_COMPONENTS = {
  cmd: (
    <code dir="ltr" className="text-fg bg-border/40 rounded-md px-1.5 py-0.5 font-mono text-xs" />
  )
}

const STATUS_DOT: Record<WhatsAppChannelStatus['status'], string> = {
  connected: 'bg-emerald-500',
  connecting: 'bg-amber-500',
  qr: 'bg-amber-500',
  error: 'bg-rose-500',
  disconnected: 'bg-border'
}

// Module-level snapshot of the channel's config + live status, warmed once at
// app start (this panel is eagerly imported via Settings.tsx, so the load
// below runs during startup). By the time the user opens the panel the data is
// already in memory and paints on the first frame — no getConfig()/status()
// round-trip, no defaults→loaded flash. Mirrors GitHubPanel / GooglePanel.
// `null` means "not loaded yet".
type WhatsAppSnapshot = { config: WhatsAppConfig; status: WhatsAppChannelStatus }
let cachedSnapshot: WhatsAppSnapshot | null = null
let loadPromise: Promise<WhatsAppSnapshot | null> | null = null

function loadWhatsAppSnapshot(): Promise<WhatsAppSnapshot | null> {
  if (cachedSnapshot) return Promise.resolve(cachedSnapshot)
  const api = window.api?.whatsapp
  if (!api) return Promise.resolve(null) // preload not ready yet; retry on mount
  if (!loadPromise) {
    loadPromise = Promise.all([api.getConfig(), api.status()])
      .then(([config, status]) => {
        cachedSnapshot = { config, status }
        return cachedSnapshot
      })
      .catch(() => null) // leave the cache cold so the mount effect can retry
      .finally(() => {
        loadPromise = null
      })
  }
  return loadPromise
}

// Prefill the cache at app start.
void loadWhatsAppSnapshot()

// Keep the cached status fresh even while the panel is closed, so reopening
// paints the current connection state (not a stale one). Intentionally never
// torn down — it mirrors live status into the module cache for the next open.
window.api?.whatsapp?.onStatusChange((s) => {
  if (cachedSnapshot) cachedSnapshot = { ...cachedSnapshot, status: s }
})

export function WhatsAppPanel(): React.JSX.Element {
  const { t } = useTranslation()
  const toast = useToast()

  // Seed from the module cache so the panel paints real config + status on the
  // first frame instead of flashing defaults → loaded values. When the cache
  // isn't warm yet (cold first open right after startup) these fall back to the
  // loading defaults and the mount effect below hydrates.
  const [enabled, setEnabled] = useState<boolean | null>(cachedSnapshot?.config.enabled ?? null)
  const [allowedPhonesInput, setAllowedPhonesInput] = useState(() =>
    (cachedSnapshot?.config.allowedPhoneNumbers ?? []).join(', ')
  )
  const [savedPhones, setSavedPhones] = useState(() =>
    (cachedSnapshot?.config.allowedPhoneNumbers ?? []).join(', ')
  )
  const [status, setStatus] = useState<WhatsAppChannelStatus>(
    () =>
      cachedSnapshot?.status ?? {
        status: 'disconnected',
        error: null,
        qr: null,
        pairingCode: null,
        connectedPhone: null,
        connectedName: null,
        hasSession: false
      }
  )
  const [qrCode, setQrCode] = useState<string | null>(cachedSnapshot?.status.qr ?? null)
  const [busy, setBusy] = useState(false)
  const [autoRefresh, setAutoRefresh] = useState<boolean | null>(
    cachedSnapshot ? (cachedSnapshot.config.autoRefresh ?? true) : null
  )
  const [staleHours, setStaleHours] = useState(cachedSnapshot?.config.staleHours ?? 3)
  const [verbose, setVerbose] = useState<boolean | null>(
    cachedSnapshot ? (cachedSnapshot.config.verbose ?? false) : null
  )
  const [hideAutomations, setHideAutomations] = useState<boolean | null>(
    cachedSnapshot ? (cachedSnapshot.config.hideAutomationsFromResume ?? true) : null
  )
  const loggingOut = useRef(false)
  // Whether the first render was seeded from the warm cache — if so the mount
  // hydrate is skipped (there's nothing left to fill in). Captured once.
  const seededRef = useRef(cachedSnapshot !== null)
  const loaded = enabled !== null

  useEffect(() => {
    if (seededRef.current) return // already painted from the warm cache
    let cancelled = false
    void (async () => {
      const snap = await loadWhatsAppSnapshot()
      if (cancelled || !snap) return
      const phonesStr = (snap.config.allowedPhoneNumbers ?? []).join(', ')
      setAllowedPhonesInput(phonesStr)
      setSavedPhones(phonesStr)
      setStatus(snap.status)
      if (snap.status.qr) setQrCode(snap.status.qr)
      setAutoRefresh(snap.config.autoRefresh ?? true)
      setStaleHours(snap.config.staleHours ?? 3)
      setVerbose(snap.config.verbose ?? false)
      setHideAutomations(snap.config.hideAutomationsFromResume ?? true)
      setEnabled(snap.config.enabled)
    })()
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    const offQr = window.api.whatsapp.onQr((qr) => setQrCode(qr))
    const offStatus = window.api.whatsapp.onStatusChange((s) => {
      if (loggingOut.current) return
      setStatus(s)
      if (s.qr) setQrCode(s.qr)
      if (s.status === 'connected') setQrCode(null)
    })
    return () => {
      offQr()
      offStatus()
    }
  }, [])

  const parsePhones = useCallback(
    (input: string): string[] =>
      input
        .split(/[,\s]+/)
        .map((s) => s.trim())
        .filter((s) => s.length > 0),
    []
  )

  // Mirror the committed panel state back into the module cache so reopening
  // the panel paints the latest values (never a stale snapshot). Covers every
  // mutation path uniformly — toggle, save, logout, verbose, auto-refresh —
  // without threading a cache write through each handler. Skipped until the
  // first real load (enabled !== null).
  useEffect(() => {
    if (enabled === null) return
    cachedSnapshot = {
      config: {
        enabled,
        allowedPhoneNumbers: parsePhones(savedPhones),
        autoRefresh: autoRefresh ?? true,
        staleHours,
        verbose: verbose ?? false,
        hideAutomationsFromResume: hideAutomations ?? true
      },
      status
    }
  }, [enabled, savedPhones, autoRefresh, staleHours, verbose, hideAutomations, status, parsePhones])

  // Toggle immediately starts/stops WhatsApp
  const handleToggle = useCallback(async (next: boolean) => {
    setEnabled(next)
    setBusy(true)
    try {
      const response = await window.api.whatsapp.setConfig({ enabled: next })
      setStatus(response.status)
    } finally {
      setBusy(false)
    }
  }, [])

  // Save only persists the allowed phone numbers (no restart)
  const handleSave = useCallback(async () => {
    const phones = parsePhones(allowedPhonesInput)
    setBusy(true)
    try {
      const response = await window.api.whatsapp.setConfig({
        allowedPhoneNumbers: phones
      })
      setStatus(response.status)
      const phonesStr = (response.config.allowedPhoneNumbers ?? []).join(', ')
      setSavedPhones(phonesStr)
      setAllowedPhonesInput(phonesStr)
      toast.show({
        message: t('settings.services.whatsapp.saveSuccess'),
        tone: 'success'
      })
    } finally {
      setBusy(false)
    }
  }, [allowedPhonesInput, parsePhones, t, toast])

  const handleLogout = useCallback(async () => {
    loggingOut.current = true
    setBusy(true)
    try {
      await window.api.whatsapp.logout()
      setQrCode(null)
      setEnabled(false)
      setStatus({
        status: 'disconnected',
        error: null,
        qr: null,
        pairingCode: null,
        connectedPhone: null,
        connectedName: null,
        hasSession: false
      })
      toast.show({
        message: t('settings.services.whatsapp.logoutSuccess'),
        tone: 'success'
      })
    } catch {
      const live = await window.api.whatsapp.status()
      setStatus(live)
      toast.show({
        message: t('settings.services.whatsapp.logoutFailed'),
        tone: 'error'
      })
    } finally {
      loggingOut.current = false
      setBusy(false)
    }
  }, [t, toast])

  const statusLabel = useMemo(
    () =>
      enabled === false
        ? t('settings.services.whatsapp.status.inactive')
        : t(`settings.services.whatsapp.status.${status.status}`),
    [enabled, status, t]
  )

  const toggleOptions = useMemo(
    () => [
      { value: false, label: t('settings.services.whatsapp.toggle.off') },
      { value: true, label: t('settings.services.whatsapp.toggle.on') }
    ],
    [t]
  )

  const handleRequestQr = useCallback(async () => {
    setBusy(true)
    try {
      await window.api.whatsapp.requestQr()
    } finally {
      setBusy(false)
    }
  }, [])

  // Auto-refresh settings persist immediately, like the enable toggle —
  // no socket restart, the values are read fresh per message in the
  // channel's loadOrCreateConversation.
  const handleAutoRefresh = useCallback(async (value: boolean) => {
    setAutoRefresh(value)
    await window.api.whatsapp.setConfig({ autoRefresh: value })
  }, [])

  const handleStaleHours = useCallback(async (hours: number) => {
    setStaleHours(hours)
    await window.api.whatsapp.setConfig({ staleHours: hours })
  }, [])

  // Verbosity persists immediately and is read fresh per turn in the
  // channel — no socket restart. Off (default) = clean feed.
  const handleVerbose = useCallback(async (value: boolean) => {
    setVerbose(value)
    await window.api.whatsapp.setConfig({ verbose: value })
  }, [])

  // Also prefs-only — the picker reads it fresh each time /resume runs, so
  // there's nothing to restart.
  const handleHideAutomations = useCallback(async (value: boolean) => {
    setHideAutomations(value)
    await window.api.whatsapp.setConfig({ hideAutomationsFromResume: value })
  }, [])

  const staleHoursOptions: readonly SelectOption<string>[] = useMemo(
    () =>
      Array.from({ length: 24 }, (_, i) => {
        const h = i + 1
        return {
          value: String(h),
          label: t('settings.services.whatsapp.autoRefresh.hours', { count: h })
        }
      }),
    [t]
  )

  const showConnected = status.status === 'connected' && status.connectedPhone
  const hasChanges = allowedPhonesInput !== savedPhones
  // Disconnect only has something to do when there's a stored session on disk
  // or a live socket (connecting/qr/connected/error) to tear down. Nothing
  // stored and already disconnected → there's nothing to clear, so disable it.
  const canDisconnect = status.hasSession || status.status !== 'disconnected'
  // A 'connecting' state for an already-linked account is a reconnect (a
  // network blip or a fresh launch of a paired session) — no QR needed.
  // Show just the pulsing status dot + "Connecting" label, not the QR box.
  const reconnecting = status.status === 'connecting' && status.hasSession
  // Verbose only governs an active task feed, so it's editable once the
  // channel is on and a linked session exists. Off or session-less, there's
  // nothing to relay — lock it. The parent block already dims the off case,
  // so the row itself only re-dims the enabled-but-session-less state.
  const verboseLocked = enabled === false || !status.hasSession

  return (
    <div className="flex min-h-full w-full items-start justify-center px-6 py-10">
      <div className="flex w-full max-w-2xl flex-col gap-6">
        <header className="flex flex-col gap-2">
          <h1 className="text-fg text-2xl font-semibold tracking-tight">
            {t('settings.services.whatsapp.title')}
          </h1>
          <p className="text-muted text-sm leading-relaxed">
            {t('settings.services.whatsapp.subtitle')}
          </p>
        </header>

        <section className="bg-surface border-border flex flex-col gap-5 rounded-2xl border p-6">
          {/* Enable toggle — immediately starts/stops */}
          <div className="flex items-center justify-between gap-4">
            <div className="flex flex-col gap-1">
              <span className="text-fg text-sm font-medium">
                {t('settings.services.whatsapp.enable')}
              </span>
              <p className="text-muted text-xs">
                {t('settings.services.whatsapp.enableDescription')}
              </p>
            </div>
            {enabled === null ? (
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
                  const active = opt.value === enabled
                  return (
                    <button
                      key={String(opt.value)}
                      role="tab"
                      type="button"
                      aria-selected={active}
                      disabled={busy || !loaded}
                      onClick={() => {
                        if (opt.value !== enabled) void handleToggle(opt.value)
                      }}
                      className={cn(
                        'rounded-md px-3 py-1 text-xs font-medium',
                        'focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg',
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

          <div className="border-border/60 border-t" />

          <div className={cn('flex flex-col gap-5', !enabled && 'pointer-events-none opacity-40')}>
            {/* Status row — always visible so layout is stable */}
            <div className="flex flex-col gap-3">
              <div className="flex items-center justify-between gap-3">
                <span className="text-muted text-xs font-medium uppercase tracking-wider">
                  {t('settings.services.whatsapp.status.label')}
                </span>
                <div className="flex items-center gap-2">
                  <span
                    aria-hidden="true"
                    className={cn(
                      'h-2 w-2 rounded-full',
                      enabled === false ? 'bg-rose-500' : STATUS_DOT[status.status],
                      reconnecting && 'animate-pulse'
                    )}
                  />
                  <span className="text-fg text-sm">{statusLabel}</span>
                </div>
              </div>

              {/* Connected account chip */}
              {showConnected && (
                <div className="bg-bg/40 border-border flex items-center gap-3 rounded-xl border px-3 py-2.5">
                  <div className="bg-surface border-border flex h-9 w-9 shrink-0 items-center justify-center rounded-full border">
                    <WhatsappIcon size={18} className="text-emerald-500" />
                  </div>
                  <div className="flex min-w-0 flex-col">
                    <span className="text-muted text-xs font-medium uppercase tracking-wider">
                      {t('settings.services.whatsapp.connectedAs')}
                    </span>
                    <span className="text-fg truncate text-sm font-medium">
                      {status.connectedName ? (
                        <>
                          {status.connectedName} (<span dir="ltr">+{status.connectedPhone}</span>)
                        </>
                      ) : (
                        <span dir="ltr">+{status.connectedPhone}</span>
                      )}
                    </span>
                  </div>
                </div>
              )}

              {status.error && (
                <pre
                  className={cn(
                    'bg-bg/40 border-border rounded-md border px-3 py-2',
                    'text-xs whitespace-pre-wrap wrap-break-word font-mono text-rose-500'
                  )}
                >
                  {status.error}
                </pre>
              )}
            </div>

            {/* Connect / QR / Connecting — mutually exclusive, same container size.
                Hidden while reconnecting an established session: the pulsing
                status dot + "Connecting" label above is enough, no QR box. */}
            {enabled && !showConnected && !reconnecting && (
              <>
                <div className="border-border/60 border-t" />
                <div className="flex flex-col items-center gap-3 rounded-lg bg-bg/40 p-6">
                  <p className="text-muted text-sm">
                    {status.status === 'qr' && qrCode
                      ? t('settings.services.whatsapp.scanQr')
                      : status.status === 'connecting'
                        ? t('settings.services.whatsapp.status.connecting')
                        : status.error || t('settings.services.whatsapp.connectDescription')}
                  </p>
                  <div className="rounded-lg bg-white p-4">
                    {status.status === 'qr' && qrCode ? (
                      <QrDisplay value={qrCode} />
                    ) : (
                      <div className="flex h-48 w-48 flex-col items-center justify-center gap-3">
                        {status.status === 'connecting' ? (
                          <div className="h-5 w-5 animate-spin rounded-full border-2 border-gray-300 border-t-gray-600" />
                        ) : (
                          <>
                            <WhatsappIcon size={32} className="text-emerald-500" />
                            <Button
                              onClick={handleRequestQr}
                              disabled={busy}
                              variant="primary"
                              size="sm"
                            >
                              {t('settings.services.whatsapp.connect')}
                            </Button>
                          </>
                        )}
                      </div>
                    )}
                  </div>
                  <p className="text-muted text-xs">
                    {status.status === 'qr' && qrCode
                      ? t('settings.services.whatsapp.scanQrHelp')
                      : ' '}
                  </p>
                </div>
              </>
            )}

            <div className="border-border/60 border-t" />

            {/* Allowed phone numbers */}
            <div className="flex flex-col gap-1.5">
              <Input
                label={t('settings.services.whatsapp.allowedPhones')}
                value={allowedPhonesInput}
                onChange={(e) => setAllowedPhonesInput(e.target.value)}
                placeholder={t('settings.services.whatsapp.allowedPhonesPlaceholder')}
                autoComplete="off"
                spellCheck={false}
                disabled={!showConnected || enabled === false}
                className="font-mono"
              />
              <p className="text-muted text-xs">
                {t('settings.services.whatsapp.allowedPhonesHint')}
              </p>
            </div>

            <div className="border-border/60 border-t" />

            {/* Auto-refresh conversations — same idle→fresh-conversation logic
                as Telegram. Gated on a live connection like the phones field. */}
            <div
              className={cn(
                'flex flex-col gap-5',
                !showConnected && 'pointer-events-none opacity-40'
              )}
            >
              <div className="flex items-center justify-between gap-4">
                <div className="flex flex-col gap-1">
                  <span className="text-fg text-sm font-medium">
                    {t('settings.services.whatsapp.autoRefresh.label')}
                  </span>
                  <p className="text-muted text-xs">
                    {t('settings.services.whatsapp.autoRefresh.description')}
                  </p>
                </div>
                {autoRefresh === null ? (
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
                      const active = opt.value === autoRefresh
                      return (
                        <button
                          key={String(opt.value)}
                          role="tab"
                          type="button"
                          aria-selected={active}
                          disabled={busy || !showConnected}
                          onClick={() => {
                            if (opt.value !== autoRefresh) void handleAutoRefresh(opt.value)
                          }}
                          className={cn(
                            'rounded-md px-3 py-1 text-xs font-medium',
                            'focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg',
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

              {autoRefresh !== false && (
                <Select<string>
                  label={t('settings.services.whatsapp.autoRefresh.staleLabel')}
                  value={String(staleHours)}
                  options={staleHoursOptions}
                  onChange={(next) => void handleStaleHours(Number(next))}
                  disabled={busy || !showConnected}
                />
              )}
            </div>

            <div className="border-border/60 border-t" />

            {/* Show all tool activity — off (default) sends a clean feed:
                agent messages, file-bearing tool results, and errors only.
                On relays every tool call/result/activity. Read fresh per
                turn in the channel; affects sending only, never history.
                Locked while the channel is off (parent block dims it) or
                there's no linked session, since there's no feed to relay. */}
            <div
              className={cn(
                'flex items-center justify-between gap-4',
                enabled === true && !status.hasSession && 'pointer-events-none opacity-40'
              )}
            >
              <div className="flex flex-col gap-1">
                <span className="text-fg text-sm font-medium">
                  {t('settings.services.whatsapp.verbose.label')}
                </span>
                <p className="text-muted text-xs">
                  {t('settings.services.whatsapp.verbose.description')}
                </p>
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
                        disabled={busy || !loaded || verboseLocked}
                        onClick={() => {
                          if (opt.value !== verbose) void handleVerbose(opt.value)
                        }}
                        className={cn(
                          'rounded-md px-3 py-1 text-xs font-medium',
                          'focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg',
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
          </div>

          <div className="border-border/60 border-t" />

          {/* Hide automations from /resume — on by default. Automation runs
              outnumber real chats several-to-one, so a newest-first /resume
              buries the conversation you actually want. Sits OUTSIDE the
              session-gated group above: it only filters a list, so unlike
              verbose it stays usable with no linked session. */}
          <div className="flex items-center justify-between gap-4">
            <div className="flex flex-col gap-1">
              <span className="text-fg text-sm font-medium">
                <Trans
                  i18nKey="settings.services.whatsapp.hideAutomations.label"
                  components={TRANS_COMPONENTS}
                />
              </span>
              <p className="text-muted text-xs">
                <Trans
                  i18nKey="settings.services.whatsapp.hideAutomations.description"
                  components={TRANS_COMPONENTS}
                />
              </p>
            </div>
            {hideAutomations === null ? (
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
                  const active = opt.value === hideAutomations
                  return (
                    <button
                      key={String(opt.value)}
                      role="tab"
                      type="button"
                      aria-selected={active}
                      disabled={busy || !loaded}
                      onClick={() => {
                        if (opt.value !== hideAutomations) void handleHideAutomations(opt.value)
                      }}
                      className={cn(
                        'rounded-md px-3 py-1 text-xs font-medium',
                        'focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg',
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

          <div className="border-border/60 border-t" />

          {/* Actions — kept outside the off-gate above so Disconnect stays
              reachable even when the channel is toggled off (lets the user
              clear a stored session). Disconnect disables itself when there's
              nothing to clear; Save governs its own enabled state. */}
          <div className="flex items-center justify-between gap-2">
            <Button
              type="button"
              onClick={() => void handleSave()}
              disabled={busy || enabled === false || !showConnected || !hasChanges}
            >
              {t('settings.services.whatsapp.save')}
            </Button>
            <Button
              type="button"
              variant="danger"
              onClick={() => void handleLogout()}
              disabled={busy || !canDisconnect}
            >
              {t('settings.services.whatsapp.logout')}
            </Button>
          </div>
        </section>

        <CommandsSection />
      </div>
    </div>
  )
}

function CommandsSection(): React.JSX.Element {
  const { t } = useTranslation()
  const commands: Array<{ name: string; description: string }> = [
    { name: '/new', description: t('settings.services.whatsapp.commands.new') },
    { name: '/current', description: t('settings.services.whatsapp.commands.current') },
    { name: '/resume', description: t('settings.services.whatsapp.commands.resume') },
    { name: '/delete', description: t('settings.services.whatsapp.commands.delete') },
    { name: '/stop', description: t('settings.services.whatsapp.commands.stop') },
    { name: '/cancel', description: t('settings.services.whatsapp.commands.cancel') },
    { name: '/approve', description: t('settings.services.whatsapp.commands.approve') },
    { name: '/deny', description: t('settings.services.whatsapp.commands.deny') },
    { name: '/status', description: t('settings.services.whatsapp.commands.status') },
    { name: '/mode', description: t('settings.services.whatsapp.commands.mode') },
    { name: '/model', description: t('settings.services.whatsapp.commands.model') },
    { name: '/local', description: t('settings.services.whatsapp.commands.local') },
    { name: '/cloud', description: t('settings.services.whatsapp.commands.cloud') }
  ]
  const limitations: string[] = [
    t('settings.services.whatsapp.limitations.singleConversation'),
    t('settings.services.whatsapp.limitations.allowList'),
    t('settings.services.whatsapp.limitations.silentIgnore')
  ]

  return (
    <section className="bg-surface border-border flex flex-col gap-5 rounded-2xl border p-6">
      <header className="flex flex-col gap-1">
        <h2 className="text-fg text-sm font-medium">
          {t('settings.services.whatsapp.commandsTitle')}
        </h2>
        <p className="text-muted text-xs">{t('settings.services.whatsapp.commandsSubtitle')}</p>
      </header>
      <ul className="divide-border/40 divide-y">
        {commands.map((cmd) => (
          <li key={cmd.name} className="flex items-baseline gap-3 py-2 first:pt-0 last:pb-0">
            <code
              dir="ltr"
              className="text-fg bg-border/40 rounded-md px-1.5 py-0.5 font-mono text-xs"
            >
              {cmd.name}
            </code>
            <span className="text-muted text-xs leading-relaxed">{cmd.description}</span>
          </li>
        ))}
      </ul>

      <div className="border-border/60 border-t" />

      <div className="flex flex-col gap-2">
        <h2 className="text-fg text-sm font-medium">
          {t('settings.services.whatsapp.limitationsTitle')}
        </h2>
        <ul className="text-muted flex flex-col gap-1 text-xs leading-relaxed">
          {limitations.map((line, i) => (
            <li key={i} className="flex gap-2">
              <span aria-hidden="true">•</span>
              <span>{line}</span>
            </li>
          ))}
        </ul>
      </div>
    </section>
  )
}

function QrDisplay({ value }: { value: string }): React.JSX.Element {
  const [dataUrl, setDataUrl] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    void renderQrToCanvas(value).then((url) => {
      if (!cancelled) setDataUrl(url)
    })
    return () => {
      cancelled = true
    }
  }, [value])

  if (!dataUrl) {
    return <div aria-hidden="true" className="h-48 w-48 animate-pulse rounded-md bg-gray-200" />
  }

  return <img src={dataUrl} alt="WhatsApp QR code" className="h-48 w-48" />
}

async function renderQrToCanvas(data: string): Promise<string> {
  const size = 192
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const ctx = canvas.getContext('2d')
  if (!ctx) return ''

  try {
    const { default: QRCode } = await import('qrcode')
    return await QRCode.toDataURL(data, {
      width: size,
      margin: 0,
      color: { dark: '#000000', light: '#ffffff' }
    })
  } catch {
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, size, size)
    ctx.fillStyle = '#000000'
    ctx.font = '10px monospace'
    ctx.fillText('QR: ' + data.slice(0, 30) + '...', 4, size / 2)
    return canvas.toDataURL()
  }
}
