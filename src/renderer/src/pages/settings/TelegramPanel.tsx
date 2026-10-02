import { Button } from '@components/core/Button'
import { Input } from '@components/core/Input'
import { TelegramLogo } from '@components/core/ProviderLogos'
import { Select, type SelectOption } from '@components/core/Select'
import { useToast } from '@components/core/toast/useToast'
import { cn } from '@lib/utils/cn'
import type { TelegramChannelStatus, TelegramConfig, TelegramErrorKind } from '@preload/index'
import { EyeIcon, ViewOffIcon } from 'hugeicons-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Trans, useTranslation } from 'react-i18next'

// <cmd> tags in locale strings render as LTR code chips (matches the
// CommandsSection chip) so slash commands read correctly inside Arabic text.
const TRANS_COMPONENTS = {
  cmd: (
    <code dir="ltr" className="text-fg bg-border/40 rounded-md px-1.5 py-0.5 font-mono text-xs" />
  )
}

const STATUS_DOT: Record<TelegramChannelStatus['status'], string> = {
  running: 'bg-emerald-500',
  starting: 'bg-amber-500',
  error: 'bg-rose-500',
  stopped: 'bg-border'
}

// Module-level snapshot of the bot config + live status, warmed once at app
// start (this panel is eagerly imported via Settings.tsx, so the load below
// runs during startup). By the time the user opens the panel the data is
// already in memory and paints on the first frame — no getConfig()/status()
// round-trip, no defaults→loaded flash. Mirrors GitHubPanel / GooglePanel.
// `null` means "not loaded yet".
type TelegramSnapshot = { config: TelegramConfig; status: TelegramChannelStatus }
let cachedSnapshot: TelegramSnapshot | null = null
let loadPromise: Promise<TelegramSnapshot | null> | null = null

function loadTelegramSnapshot(): Promise<TelegramSnapshot | null> {
  if (cachedSnapshot) return Promise.resolve(cachedSnapshot)
  const api = window.api?.telegram
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
void loadTelegramSnapshot()

// Keep the cached status fresh even while the panel is closed, so reopening
// paints the current bot state (not a stale one). Intentionally never torn
// down — it mirrors live status into the module cache for the next open.
window.api?.telegram?.onStatusChange((s) => {
  if (cachedSnapshot) cachedSnapshot = { ...cachedSnapshot, status: s }
})

export function TelegramPanel(): React.JSX.Element {
  const { t } = useTranslation()
  const toast = useToast()

  // Seed from the module cache so the panel paints real config + status on the
  // first frame instead of flashing "I don't know yet" defaults → loaded
  // values. When the cache isn't warm yet (cold first open right after startup)
  // these fall back to null/empty and the mount effect below hydrates.
  const [enabled, setEnabled] = useState<boolean | null>(cachedSnapshot?.config.enabled ?? null)
  const [botToken, setBotToken] = useState(cachedSnapshot?.config.botToken ?? '')
  const [hasSavedToken, setHasSavedToken] = useState(
    (cachedSnapshot?.config.botToken.length ?? 0) > 0
  )
  const [allowedUsersInput, setAllowedUsersInput] = useState(() =>
    (cachedSnapshot?.config.allowedUserIds ?? []).join(', ')
  )
  // Last persisted token + allow-list, so the Test/save button can disable
  // when nothing has changed since the last successful connect.
  const [savedBotToken, setSavedBotToken] = useState(cachedSnapshot?.config.botToken ?? '')
  const [savedAllowedUsers, setSavedAllowedUsers] = useState(() =>
    (cachedSnapshot?.config.allowedUserIds ?? []).join(', ')
  )
  const [tokenVisible, setTokenVisible] = useState(false)
  const [status, setStatus] = useState<TelegramChannelStatus>(
    () =>
      cachedSnapshot?.status ?? {
        status: 'stopped',
        errorKind: null,
        error: null,
        botUsername: null,
        botName: null
      }
  )
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
  // Remembered bot identity so the connected-bot card stays visible when the
  // channel is toggled off (a stopped bot reports a null username). Cleared
  // only on disconnect, when the token — and thus the bot — is actually gone.
  const [lastBot, setLastBot] = useState<{ username: string; name: string | null } | null>(() =>
    cachedSnapshot?.status.botUsername
      ? { username: cachedSnapshot.status.botUsername, name: cachedSnapshot.status.botName }
      : null
  )
  const [busy, setBusy] = useState<'idle' | 'saving' | 'testing'>('idle')
  const [validation, setValidation] = useState<string | null>(null)
  // Whether the first render was seeded from the warm cache — if so the mount
  // hydrate is skipped (there's nothing left to fill in). Captured once.
  const seededRef = useRef(cachedSnapshot !== null)
  const loaded = enabled !== null

  // Hydrate from disk on mount only when the cache wasn't already warm (cold
  // first open right after startup). setState only fires inside the async IIFE
  // — never synchronously in the effect body — so the react-hooks
  // set-state-in-effect rule stays happy. The cancelled flag protects against
  // the user navigating away mid-load.
  useEffect(() => {
    if (seededRef.current) return // already painted from the warm cache
    let cancelled = false
    void (async () => {
      const snap = await loadTelegramSnapshot()
      if (cancelled || !snap) return
      setBotToken(snap.config.botToken)
      setHasSavedToken(snap.config.botToken.length > 0)
      setAllowedUsersInput(snap.config.allowedUserIds.join(', '))
      setSavedBotToken(snap.config.botToken)
      setSavedAllowedUsers(snap.config.allowedUserIds.join(', '))
      setAutoRefresh(snap.config.autoRefresh ?? true)
      setStaleHours(snap.config.staleHours ?? 3)
      setVerbose(snap.config.verbose ?? false)
      setHideAutomations(snap.config.hideAutomationsFromResume ?? true)
      setStatus(snap.status)
      if (snap.status.botUsername) {
        setLastBot({ username: snap.status.botUsername, name: snap.status.botName })
      }
      // Set `enabled` last so the first render with a real boolean
      // has the rest of the form already populated. Avoids sub-flicker.
      setEnabled(snap.config.enabled)
    })()
    return () => {
      cancelled = true
    }
  }, [])

  // Live status pushes from the main process. The bot's start handshake
  // runs in the background, so without this the panel would keep showing
  // the snapshot it read on mount (e.g. "starting") until a manual Save.
  useEffect(() => {
    const off = window.api.telegram.onStatusChange((s) => {
      setStatus(s)
      if (s.botUsername) setLastBot({ username: s.botUsername, name: s.botName })
    })
    return () => {
      off()
    }
  }, [])

  const parseUserIds = useCallback(
    (input: string): { ok: true; ids: number[] } | { ok: false; error: string } => {
      const tokens = input
        .split(/[,\s]+/)
        .map((s) => s.trim())
        .filter((s) => s.length > 0)
      if (tokens.length === 0) return { ok: true, ids: [] }
      const ids: number[] = []
      for (const token of tokens) {
        if (!/^\d+$/.test(token)) {
          return { ok: false, error: t('settings.services.telegram.validation.userIdInvalid') }
        }
        ids.push(Number(token))
      }
      return { ok: true, ids }
    },
    [t]
  )

  // Mirror the committed panel state back into the module cache so reopening
  // the panel paints the latest values (never a stale snapshot). Covers every
  // mutation path uniformly — toggle, test/connect, disconnect, verbose —
  // without threading a cache write through each handler. Skipped until the
  // first real load (enabled !== null).
  useEffect(() => {
    if (enabled === null) return
    const parsed = parseUserIds(savedAllowedUsers)
    cachedSnapshot = {
      config: {
        enabled,
        botToken: savedBotToken,
        allowedUserIds: parsed.ok ? parsed.ids : [],
        autoRefresh: autoRefresh ?? true,
        staleHours,
        verbose: verbose ?? false,
        hideAutomationsFromResume: hideAutomations ?? true
      },
      status
    }
  }, [
    enabled,
    savedBotToken,
    savedAllowedUsers,
    autoRefresh,
    staleHours,
    verbose,
    hideAutomations,
    status,
    parseUserIds
  ])

  const handleToggle = useCallback(async (value: boolean) => {
    setEnabled(value)
    const response = await window.api.telegram.setConfig({ enabled: value })
    setStatus(response.status)
  }, [])

  // Verbosity is a prefs-only patch — the main process persists it without
  // restarting the bot. Read fresh per turn in the channel. Off (default) =
  // clean feed (agent messages + file results + errors only).
  const handleVerbose = useCallback(async (value: boolean) => {
    setVerbose(value)
    const response = await window.api.telegram.setConfig({ verbose: value })
    setStatus(response.status)
  }, [])

  // Also prefs-only — the picker reads it fresh each time /resume runs, so
  // there's nothing to restart.
  const handleHideAutomations = useCallback(async (value: boolean) => {
    setHideAutomations(value)
    const response = await window.api.telegram.setConfig({ hideAutomationsFromResume: value })
    setStatus(response.status)
  }, [])

  // Auto-refresh + stale-window persist immediately (prefs-only patches — the
  // main process writes them without restarting the bot; read fresh per turn),
  // exactly like WhatsApp's handleAutoRefresh/handleStaleHours. Previously these
  // toggles mutated local state ONLY and rode along on the next Test/connect, so
  // toggling without a token change never reached disk. These controls are gated
  // on `connected`, so enabled is always true here — the patch never restarts.
  const handleAutoRefresh = useCallback(async (value: boolean) => {
    setAutoRefresh(value)
    await window.api.telegram.setConfig({ autoRefresh: value })
  }, [])

  const handleStaleHours = useCallback(async (hours: number) => {
    setStaleHours(hours)
    await window.api.telegram.setConfig({ staleHours: hours })
  }, [])

  const translateError = useCallback(
    (kind: TelegramErrorKind, message?: string | null): string => {
      if (kind === 'unknown') {
        return t('settings.services.telegram.errors.unknown', {
          message: message ?? ''
        })
      }
      return t(`settings.services.telegram.errors.${kind}`)
    },
    [t]
  )

  const handleTest = useCallback(async () => {
    const parsed = parseUserIds(allowedUsersInput)
    if (!parsed.ok) {
      setValidation(parsed.error)
      return
    }
    if (botToken.trim().length === 0) {
      setValidation(t('settings.services.telegram.validation.tokenRequired'))
      return
    }
    if (parsed.ids.length === 0) {
      setValidation(t('settings.services.telegram.validation.userIdRequired'))
      return
    }
    setValidation(null)
    setBusy('testing')
    try {
      const result = await window.api.telegram.sendTestMessage({
        token: botToken.trim(),
        userId: parsed.ids[0]
      })
      if (result.ok) {
        const response = await window.api.telegram.setConfig({
          enabled: true,
          botToken: botToken.trim(),
          allowedUserIds: parsed.ids,
          autoRefresh: autoRefresh ?? true,
          staleHours
        })
        setStatus(response.status)
        setEnabled(true)
        setHasSavedToken(true)
        setSavedBotToken(botToken.trim())
        setSavedAllowedUsers(allowedUsersInput.trim())
        toast.show({
          message: t('settings.services.telegram.testSuccess'),
          tone: 'success'
        })
      } else {
        toast.show({
          message: t('settings.services.telegram.testFailure', {
            message: translateError(result.kind, result.message)
          }),
          tone: 'error'
        })
      }
    } finally {
      setBusy('idle')
    }
  }, [allowedUsersInput, autoRefresh, botToken, parseUserIds, staleHours, t, toast, translateError])

  // Disconnect mirrors WhatsApp's logout: cleanly clear the connection by
  // stopping the bot and wiping the saved token (the credential), keeping
  // the allow-list. setConfig({ enabled: false }) routes to the channel's
  // stop() in the main process; clearing the token means the On toggle
  // stays locked until a fresh token is pasted.
  const handleDisconnect = useCallback(async () => {
    setBusy('saving')
    try {
      await window.api.telegram.setConfig({ enabled: false, botToken: '' })
      setBotToken('')
      setHasSavedToken(false)
      // Token is cleared; the allow-list is intentionally kept, so only the
      // saved token resets here.
      setSavedBotToken('')
      setEnabled(false)
      // Token is gone, so the bot is too — drop the remembered identity.
      setLastBot(null)
      setStatus({
        status: 'stopped',
        errorKind: null,
        error: null,
        botUsername: null,
        botName: null
      })
      toast.show({
        message: t('settings.services.telegram.disconnectSuccess'),
        tone: 'success'
      })
    } catch {
      const live = await window.api.telegram.status()
      setStatus(live)
      toast.show({
        message: t('settings.services.telegram.disconnectFailed'),
        tone: 'error'
      })
    } finally {
      setBusy('idle')
    }
  }, [t, toast])

  const statusLabel = useMemo(() => {
    return t(`settings.services.telegram.status.${status.status}`)
  }, [status, t])

  const statusErrorText = useMemo(() => {
    if (status.errorKind) return translateError(status.errorKind, status.error)
    if (status.error) return status.error
    return null
  }, [status, translateError])

  const connected = status.status === 'running'
  // Config is read-only while the channel is off — but only once it's been
  // set up. First-time setup (no saved token yet) keeps the fields editable
  // so the user can enter a token and Save to come online.
  const configLocked = enabled === false && hasSavedToken
  // Mirrors WhatsApp's Save guard: the Test/save button stays disabled until
  // the token or allow-list actually differs from what's persisted.
  const hasChanges =
    botToken.trim() !== savedBotToken.trim() ||
    allowedUsersInput.trim() !== savedAllowedUsers.trim()
  // Disconnect only clears a real session: a saved token, or a live/error
  // status to reset. A typed-but-unsaved token doesn't count — the user can
  // just clear the field. Nothing saved + stopped → nothing to clear, disable.
  const canDisconnect = hasSavedToken || status.status !== 'stopped'
  // Verbose only governs an active task feed, so it's editable once the
  // channel is on and a session (saved token) exists. Off or token-less,
  // there's nothing to relay — lock and dim it.
  const verboseLocked = enabled === false || !hasSavedToken

  // Segmented toggle: matches the Off | On pattern in WolffishPanel and
  // is RTL-safe by construction (flex layout reflows with `dir`). The
  // sliding switch this replaces translated only along physical X,
  // which inverted in Arabic.
  const toggleOptions = useMemo(
    () => [
      { value: false, label: t('settings.services.telegram.toggle.off') },
      { value: true, label: t('settings.services.telegram.toggle.on') }
    ],
    [t]
  )

  const staleHoursOptions: readonly SelectOption<string>[] = useMemo(
    () =>
      Array.from({ length: 24 }, (_, i) => {
        const h = i + 1
        return {
          value: String(h),
          label: t('settings.services.telegram.autoRefresh.hours', { count: h })
        }
      }),
    [t]
  )

  return (
    <div className="flex min-h-full w-full items-start justify-center px-6 py-10">
      <div className="flex w-full max-w-2xl flex-col gap-6">
        <header className="flex flex-col gap-2">
          <h1 className="text-fg text-2xl font-semibold tracking-tight">
            {t('settings.services.telegram.title')}
          </h1>
          <p className="text-muted text-sm leading-relaxed">
            {t('settings.services.telegram.subtitle')}
          </p>
        </header>

        <section className="bg-surface border-border flex flex-col gap-5 rounded-2xl border p-6">
          <div className="flex items-center justify-between gap-4">
            <div className="flex flex-col gap-1">
              <span className="text-fg text-sm font-medium">
                {t('settings.services.telegram.enable')}
              </span>
              <p className="text-muted text-xs">
                {t('settings.services.telegram.enableDescription')}
              </p>
            </div>
            {/* Hold the toggle's footprint until config is loaded so the
                first paint with the real value is the only paint —
                otherwise the segmented control flickers from off to on. */}
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
                  const cantEnable = opt.value && !hasSavedToken
                  return (
                    <button
                      key={String(opt.value)}
                      role="tab"
                      type="button"
                      aria-selected={active}
                      disabled={cantEnable}
                      onClick={() => void handleToggle(opt.value)}
                      className={cn(
                        'rounded-md px-3 py-1 text-xs font-medium',
                        'focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg',
                        cantEnable
                          ? 'text-muted/50 cursor-not-allowed'
                          : active
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

          <div className="flex flex-col gap-2">
            <div className="flex items-center justify-between gap-3">
              <span className="text-muted text-xs font-medium uppercase tracking-wider">
                {t('settings.services.telegram.status.label')}
              </span>
              {/* Pulse the dot and label together while starting/retrying so
                  it reads as "actively working", not frozen. */}
              <div
                className={cn(
                  'flex items-center gap-2',
                  status.status === 'starting' && 'animate-pulse'
                )}
              >
                <span
                  aria-hidden="true"
                  className={cn('h-2 w-2 rounded-full', STATUS_DOT[status.status])}
                />
                <span className="text-fg text-sm">{statusLabel}</span>
              </div>
            </div>

            {/* Connected bot chip — mirrors WhatsApp's connected-account card.
                Driven by the remembered identity so it stays put when the
                channel is toggled off, not only while it's running. */}
            {lastBot && (
              <div
                className={cn(
                  'bg-bg/40 border-border flex items-center gap-3 rounded-xl border px-3 py-2.5',
                  !connected && 'opacity-40'
                )}
              >
                <div className="bg-surface border-border flex h-9 w-9 shrink-0 items-center justify-center rounded-full border">
                  <TelegramLogo size={18} className="text-sky-500" />
                </div>
                <div className="flex min-w-0 flex-col">
                  <span className="text-muted text-xs font-medium uppercase tracking-wider">
                    {t('settings.services.telegram.connectedAs')}
                  </span>
                  <span className="text-fg truncate text-sm font-medium">
                    {lastBot.name ? (
                      <>
                        {lastBot.name} (<span dir="ltr">@{lastBot.username}</span>)
                      </>
                    ) : (
                      <span dir="ltr">@{lastBot.username}</span>
                    )}
                  </span>
                </div>
              </div>
            )}

            {statusErrorText && (
              <pre
                className={cn(
                  'bg-bg/40 border-border rounded-md border px-3 py-2',
                  'text-xs whitespace-pre-wrap wrap-break-word font-mono text-rose-500'
                )}
              >
                {statusErrorText}
              </pre>
            )}
          </div>

          <div className="border-border/60 border-t" />

          {/* Bot token: full-width input with the eye toggle inside the
              field, matching the API-key field in CloudProviderPanel. */}
          <div className="flex flex-col gap-1.5">
            <label htmlFor="telegram-bot-token" className="text-muted text-sm font-medium">
              {t('settings.services.telegram.botToken')}
            </label>
            <div className="relative w-full">
              <Input
                id="telegram-bot-token"
                type={tokenVisible ? 'text' : 'password'}
                value={botToken}
                onChange={(e) => setBotToken(e.target.value)}
                placeholder={t('settings.services.telegram.botTokenPlaceholder')}
                autoComplete="off"
                spellCheck={false}
                disabled={configLocked}
                className="pe-10 font-mono"
              />
              <button
                type="button"
                onClick={() => setTokenVisible((v) => !v)}
                aria-label={t(
                  tokenVisible
                    ? 'settings.services.telegram.hideToken'
                    : 'settings.services.telegram.showToken'
                )}
                className={cn(
                  'text-muted hover:text-fg absolute inset-e-2 top-1/2 -translate-y-1/2',
                  'flex h-8 w-8 cursor-pointer items-center justify-center rounded-md',
                  'focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg'
                )}
              >
                {tokenVisible ? <ViewOffIcon size={16} /> : <EyeIcon size={16} />}
              </button>
            </div>
            <p className="text-muted text-xs">{t('settings.services.telegram.botTokenHint')}</p>
          </div>

          <div className="flex flex-col gap-1.5">
            <Input
              label={t('settings.services.telegram.allowedUsers')}
              value={allowedUsersInput}
              onChange={(e) => setAllowedUsersInput(e.target.value)}
              placeholder={t('settings.services.telegram.allowedUsersPlaceholder')}
              autoComplete="off"
              spellCheck={false}
              disabled={configLocked}
              className="font-mono"
            />
            <p className="text-muted text-xs">{t('settings.services.telegram.allowedUsersHint')}</p>
          </div>

          <div className="border-border/60 border-t" />

          {/* Auto-refresh only makes sense once the bot is online — there
              are no live conversations to roll over otherwise. Dim and
              disable the whole group until the connection is running. */}
          <div
            className={cn('flex flex-col gap-5', !connected && 'pointer-events-none opacity-40')}
          >
            <div className="flex items-center justify-between gap-4">
              <div className="flex flex-col gap-1">
                <span className="text-fg text-sm font-medium">
                  {t('settings.services.telegram.autoRefresh.label')}
                </span>
                <p className="text-muted text-xs">
                  {t('settings.services.telegram.autoRefresh.description')}
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
                        disabled={!connected}
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

            {/* Always shown — disabled (not hidden) when the bot is offline
                or auto-refresh is toggled off. */}
            <Select<string>
              label={t('settings.services.telegram.autoRefresh.staleLabel')}
              value={String(staleHours)}
              options={staleHoursOptions}
              onChange={(next) => void handleStaleHours(Number(next))}
              disabled={!connected || autoRefresh !== true}
            />
          </div>

          <div className="border-border/60 border-t" />

          {/* Show all tool activity — off (default) sends a clean feed:
              agent messages, file-bearing tool results, and errors only.
              On relays every tool call/result/activity. Persists without a
              bot restart and affects sending only, never history. Gated on a
              session: locked while the channel is off or has no saved token,
              since there's no feed to relay until then. */}
          <div
            className={cn(
              'flex items-center justify-between gap-4',
              verboseLocked && 'pointer-events-none opacity-40'
            )}
          >
            <div className="flex flex-col gap-1">
              <span className="text-fg text-sm font-medium">
                {t('settings.services.telegram.verbose.label')}
              </span>
              <p className="text-muted text-xs">
                {t('settings.services.telegram.verbose.description')}
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
                      disabled={busy !== 'idle' || !loaded || verboseLocked}
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

          <div className="border-border/60 border-t" />

          {/* Hide automations from /resume — on by default. Automation runs
              outnumber real chats several-to-one, so a newest-first /resume
              buries the conversation you actually want. Prefs-only and read
              per /resume, so it needs no bot session: unlike verbose there's
              nothing being relayed, hence no `verboseLocked` gate. */}
          <div className="flex items-center justify-between gap-4">
            <div className="flex flex-col gap-1">
              <span className="text-fg text-sm font-medium">
                <Trans
                  i18nKey="settings.services.telegram.hideAutomations.label"
                  components={TRANS_COMPONENTS}
                />
              </span>
              <p className="text-muted text-xs">
                <Trans
                  i18nKey="settings.services.telegram.hideAutomations.description"
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
                      disabled={busy !== 'idle' || !loaded}
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

          {validation && (
            <p className="text-rose-500 text-xs" role="alert">
              {validation}
            </p>
          )}

          <div className="border-border/60 border-t" />

          <div className="flex items-center justify-between gap-2">
            <Button
              type="button"
              onClick={() => void handleTest()}
              disabled={
                busy !== 'idle' ||
                !loaded ||
                botToken.trim().length === 0 ||
                allowedUsersInput.trim().length === 0 ||
                configLocked ||
                !hasChanges
              }
            >
              {t('settings.services.telegram.test')}
            </Button>
            {/* Reachable even when offline so the user can clear a saved
                token/connection — but disabled when there's nothing to clear. */}
            <Button
              type="button"
              variant="danger"
              onClick={() => void handleDisconnect()}
              disabled={busy !== 'idle' || !canDisconnect}
            >
              {t('settings.services.telegram.disconnect')}
            </Button>
          </div>

          <p className="text-muted text-xs">{t('settings.services.telegram.testHint')}</p>
        </section>

        <CommandsSection />
      </div>
    </div>
  )
}

function CommandsSection(): React.JSX.Element {
  const { t } = useTranslation()
  const commands: Array<{ name: string; description: string }> = [
    { name: '/new', description: t('settings.services.telegram.commands.new') },
    { name: '/current', description: t('settings.services.telegram.commands.current') },
    { name: '/resume', description: t('settings.services.telegram.commands.resume') },
    { name: '/delete', description: t('settings.services.telegram.commands.delete') },
    { name: '/clear', description: t('settings.services.telegram.commands.clear') },
    { name: '/stop', description: t('settings.services.telegram.commands.stop') },
    { name: '/cancel', description: t('settings.services.telegram.commands.cancel') },
    { name: '/approve', description: t('settings.services.telegram.commands.approve') },
    { name: '/deny', description: t('settings.services.telegram.commands.deny') },
    { name: '/status', description: t('settings.services.telegram.commands.status') },
    { name: '/mode', description: t('settings.services.telegram.commands.mode') },
    { name: '/model', description: t('settings.services.telegram.commands.model') }
  ]
  const limitations: string[] = [
    t('settings.services.telegram.limitations.singleConversation'),
    t('settings.services.telegram.limitations.fileSize'),
    t('settings.services.telegram.limitations.allowList'),
    t('settings.services.telegram.limitations.silentIgnore')
  ]

  return (
    <section className="bg-surface border-border flex flex-col gap-5 rounded-2xl border p-6">
      <header className="flex flex-col gap-1">
        <h2 className="text-fg text-sm font-medium">
          {t('settings.services.telegram.commandsTitle')}
        </h2>
        <p className="text-muted text-xs">{t('settings.services.telegram.commandsSubtitle')}</p>
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
          {t('settings.services.telegram.limitationsTitle')}
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
