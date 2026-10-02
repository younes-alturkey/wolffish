import { ErrorDetailBlock } from '@components/common/provider-error-card/ProviderErrorCard'
import { Button } from '@components/core/Button'
import { useToast } from '@components/core/toast/useToast'
import { cn } from '@lib/utils/cn'
import type { UpdateCheckResult, UpdaterErrorInfo } from '@preload/index'
import { useFlow } from '@providers/flow/useFlow'
import { Download01Icon, RefreshIcon, SystemUpdate02Icon } from 'hugeicons-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

type UpdatePhase =
  | 'idle'
  | 'checking'
  | 'downloading'
  | 'verifying'
  | 'ready'
  | 'installing'
  | 'error'

// Main owns the real state; this module-level snapshot mirrors it so a panel
// remounted after page navigation restores instantly (before getState resolves).
// These subscriptions are registered once at import and intentionally never
// torn down — they outlive any single mount of the panel.
let cachedState: {
  phase: UpdatePhase
  version: string | null
  percent: number
  error: UpdaterErrorInfo | null
} = {
  phase: 'idle',
  version: null,
  percent: 0,
  error: null
}
window.api.updater.onState((s) => {
  cachedState = { phase: s.phase, version: s.version, percent: s.percent, error: s.error }
})
window.api.updater.onReady((event) => {
  cachedState = { phase: 'ready', version: event.version, percent: 100, error: null }
})

export function UpdatesPanel(): React.JSX.Element {
  const { t } = useTranslation()
  const { show } = useToast()
  const { status, refreshStatus, goTo } = useFlow()
  const updatesEnabled = status?.config?.updates?.enabled !== false

  const [appVersion, setAppVersion] = useState<string | null>(null)
  // The toggle renders desktop truth (flow status), not a mounted-once copy —
  // a copy went stale the moment the phone flipped the switch. The override
  // exists only between a click here and the refresh that confirms it.
  const [pendingAuto, setPendingAuto] = useState<boolean | null>(null)
  const autoUpdates = pendingAuto ?? updatesEnabled
  const [phase, setPhase] = useState<UpdatePhase>(cachedState.phase)
  const [updateVersion, setUpdateVersion] = useState<string | null>(cachedState.version)
  const [downloadPercent, setDownloadPercent] = useState(cachedState.percent)
  const [errorInfo, setErrorInfo] = useState<UpdaterErrorInfo | null>(cachedState.error)
  const [saving, setSaving] = useState(false)
  // Flipped once any live updater:state broadcast lands, so the async getState
  // seed below never clobbers fresher state (e.g. reverting 'ready' back to
  // 'verifying' if its snapshot resolves after the ready broadcast).
  const liveSeen = useRef(false)

  useEffect(() => {
    void window.api.updater.getVersion().then(setAppVersion)
    // Authoritative recovery from main on (re)mount. The panel is fully
    // unmounted when switching settings tabs or leaving Settings, so without
    // this a download in progress would be lost and the user would have to
    // click "Check" again. getState() restores live phase/version/percent —
    // but only if no live broadcast has already superseded the snapshot.
    let cancelled = false
    void window.api.updater.getState().then((s) => {
      if (cancelled || liveSeen.current) return
      // Keep the install view pinned while main is still 'ready' — but an
      // error (the install failed and main released the artifact) wins.
      setPhase((prev) => (prev === 'installing' && s.phase !== 'error' ? prev : s.phase))
      setUpdateVersion(s.version)
      setDownloadPercent(s.percent)
      setErrorInfo(s.phase === 'error' ? s.error : null)
    })
    return () => {
      cancelled = true
    }
  }, [])

  // A phone edit lands as settings:mobileChange — pull a fresh status so the
  // derived value above snaps to what the phone just persisted. Filtered to
  // this panel's key; every panel watches for its own.
  useEffect(
    () =>
      window.api.runtime.onMobileSettingsChange(({ keys }) => {
        if (keys.includes('updatesEnabled')) void refreshStatus()
      }),
    [refreshStatus]
  )

  useEffect(() => {
    const unsubState = window.api.updater.onState((s) => {
      liveSeen.current = true
      setUpdateVersion(s.version)
      // Mirror main directly — it is the source of truth: monotonic within a
      // download and reset to 0 on a fresh one. Clamping here would pin the bar
      // at the previous peak when a retry restarts the download.
      setDownloadPercent(s.percent)
      // A late 'ready' broadcast must not yank the user out of the install view.
      setPhase((prev) => (prev === 'installing' && s.phase === 'ready' ? 'installing' : s.phase))
      // The error rides along in state and renders as an inline alert (no toast):
      // surface its detail while in error, clear it the moment a retry advances.
      setErrorInfo(s.phase === 'error' ? s.error : null)
    })
    return () => {
      unsubState()
    }
  }, [])

  const onToggleAutoUpdates = useCallback(
    async (next: boolean) => {
      if (saving || next === autoUpdates) return
      setSaving(true)
      setPendingAuto(next)
      try {
        await window.api.runtime.setUpdatesEnabled(next)
        await refreshStatus()
      } finally {
        // Back to derived truth: the refreshed status carries the new value,
        // and a failed save snaps the toggle to what actually holds.
        setPendingAuto(null)
        setSaving(false)
      }
    },
    [saving, autoUpdates, refreshStatus]
  )

  const onCheckForUpdates = useCallback(async () => {
    // Allow a retry from idle/error, but never re-check during an active
    // transfer — that would reset the bar to 0% and disable Install.
    if (phase === 'checking' || phase === 'downloading' || phase === 'verifying') return
    setPhase('checking')
    try {
      const result: UpdateCheckResult = await window.api.updater.check()
      if (result.ok && result.version) {
        // the updater:state broadcast will transition phase to 'downloading'
        setUpdateVersion(result.version)
      } else if (result.ok) {
        show({ message: t('settings.updates.upToDate', 'Up to date'), tone: 'success' })
        setPhase('idle')
      } else {
        show({
          message: t('settings.updates.checkFailed', 'Could not check for updates'),
          tone: 'error'
        })
        setPhase('idle')
      }
    } catch {
      setPhase('idle')
    }
  }, [phase, show, t])

  const onInstall = useCallback(() => {
    setPhase('installing')
    void window.api.updater.install()
  }, [])

  const toggleOptions = useMemo(
    () => [
      { value: false, label: t('settings.wolffish.toggle.off') },
      { value: true, label: t('settings.wolffish.toggle.on') }
    ],
    [t]
  )

  return (
    <div className="flex min-h-full w-full items-start justify-center px-6 py-10">
      <div className="flex w-full max-w-2xl flex-col gap-6">
        <header className="flex flex-col gap-2">
          <h1 className="text-fg text-2xl font-semibold tracking-tight">
            {t('settings.updates.title', 'Updates')}
          </h1>
          <p className="text-muted text-sm leading-relaxed">
            {t('settings.updates.subtitle', 'Manage app updates and version info.')}
          </p>
        </header>

        <section className="bg-surface border-border flex flex-col gap-5 rounded-2xl border p-6">
          <div className="flex items-center justify-between gap-4">
            <span className="text-fg text-sm font-medium">
              {t('settings.updates.version', 'Version')}
            </span>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => goTo('changelog', 'settings')}
                className={cn(
                  'text-muted hover:text-fg text-xs underline cursor-pointer',
                  'focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg rounded'
                )}
              >
                {t('settings.updates.changelog', 'Changelog')}
              </button>
              <code className="bg-border/50 text-fg rounded px-2 py-0.5 text-xs font-mono">
                {appVersion ? `v${appVersion}` : '...'}
              </code>
            </div>
          </div>

          <div className="border-border/60 border-t" />

          {/* Auto-updates toggle */}
          <div className="flex flex-col gap-2">
            <div className="flex items-center justify-between gap-4">
              <span className="text-fg text-sm font-medium">
                {t('settings.updates.autoUpdates', 'Auto-updates')}
              </span>
              <div
                role="tablist"
                className="border-border bg-bg/40 inline-flex shrink-0 items-center rounded-lg border p-0.5"
              >
                {toggleOptions.map((opt) => {
                  const active = opt.value === autoUpdates
                  return (
                    <button
                      key={String(opt.value)}
                      role="tab"
                      type="button"
                      disabled={saving}
                      aria-selected={active}
                      onClick={() => onToggleAutoUpdates(opt.value)}
                      className={cn(
                        'rounded-md px-3 py-1 text-xs font-medium',
                        'focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg',
                        active
                          ? 'bg-primary text-primary-fg shadow-sm'
                          : 'text-muted hover:text-fg cursor-pointer',
                        saving && 'cursor-not-allowed opacity-60'
                      )}
                    >
                      {opt.label}
                    </button>
                  )
                })}
              </div>
            </div>
            <p className="text-muted text-xs leading-relaxed">
              {t(
                'settings.updates.autoUpdatesDescription',
                'Check for and download updates automatically on launch.'
              )}
            </p>
          </div>

          <div className="border-border/60 border-t" />

          <div className="flex flex-col gap-3 min-h-17">
            {phase === 'downloading' || phase === 'verifying' ? (
              <>
                <div className="flex items-center justify-between gap-4">
                  <div className="flex flex-col gap-1">
                    <span className="text-fg text-sm font-medium">
                      {phase === 'verifying'
                        ? t('settings.updates.verifyingTitle', 'Verifying update')
                        : t('settings.updates.downloadingTitle', 'Downloading update')}
                    </span>
                    <p className="text-muted text-xs flex items-center gap-1.5 animate-pulse">
                      <Download01Icon size={12} className="shrink-0" />
                      {phase === 'verifying'
                        ? t(
                            'settings.updates.verifyingSubtitle',
                            'Almost done — verifying your update'
                          )
                        : t('settings.updates.downloadingSubtitle', 'Your update is downloading')}
                      {phase === 'downloading' && downloadPercent > 0 && ` ${downloadPercent}%`}
                    </p>
                  </div>
                  <button
                    type="button"
                    disabled
                    className={cn(
                      'bg-primary text-primary-fg flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium shadow-sm',
                      'cursor-not-allowed opacity-60'
                    )}
                  >
                    <span>{t('settings.updates.install', 'Update')}</span>
                  </button>
                </div>
                <div
                  role="progressbar"
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={phase === 'verifying' ? 100 : downloadPercent}
                  className="bg-border/40 h-1 w-full overflow-hidden rounded-full"
                >
                  <div
                    className="bg-primary h-full rounded-full transition-[width] duration-300 ease-out"
                    style={{ width: `${phase === 'verifying' ? 100 : downloadPercent}%` }}
                  />
                </div>
              </>
            ) : phase === 'ready' || phase === 'installing' ? (
              <div className="flex items-center justify-between gap-4">
                <div className="flex flex-col gap-1">
                  <span className="text-fg text-sm font-medium">
                    {t('settings.updates.installReady', 'Install downloaded update')}
                  </span>
                  <div className="flex items-center gap-2">
                    <code className="bg-border/50 text-fg rounded px-2 py-0.5 text-xs font-mono">
                      v{updateVersion}
                    </code>
                    <span className="text-muted text-xs">
                      {t('settings.updates.updateAvailable', 'Ready to install')}
                    </span>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={onInstall}
                  disabled={phase === 'installing'}
                  className={cn(
                    'bg-primary text-primary-fg flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium shadow-sm',
                    'hover:bg-primary/90 cursor-pointer',
                    'focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg',
                    phase === 'installing' && 'cursor-not-allowed opacity-60'
                  )}
                >
                  {/* Stays Update while installing — the button only dims. */}
                  <span>{t('settings.updates.install', 'Update')}</span>
                </button>
              </div>
            ) : phase === 'error' ? (
              <UpdateErrorAlert
                title={t('settings.updates.errorTitle', 'Update failed')}
                reason={t(
                  `settings.updates.errors.${errorInfo?.code ?? 'unknown'}`,
                  errorInfo?.message ?? 'The update failed to download.'
                )}
                detail={errorInfo?.detail ?? null}
                retryLabel={t('settings.updates.retry', 'Retry')}
                onRetry={() => void onCheckForUpdates()}
              />
            ) : (
              <div className="flex items-center justify-between gap-4">
                <div className="flex flex-col gap-1">
                  <span className="text-fg text-sm font-medium">
                    {t('settings.updates.checkManual', 'Check for updates')}
                  </span>
                  <p className="text-muted text-xs">
                    {t(
                      'settings.updates.checkManualDescription',
                      'Manually check for new versions.'
                    )}
                  </p>
                </div>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => void onCheckForUpdates()}
                  disabled={phase === 'checking'}
                >
                  {t('settings.updates.check', 'Check')}
                </Button>
              </div>
            )}
          </div>
        </section>
      </div>
    </div>
  )
}

function UpdateErrorAlert({
  title,
  reason,
  detail,
  retryLabel,
  onRetry
}: {
  title: string
  reason: string
  detail: string | null
  retryLabel: string
  onRetry: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const [showDetail, setShowDetail] = useState(false)

  return (
    <div
      role="alert"
      aria-live="polite"
      className={cn(
        'border-red-300 bg-red-50 text-red-900',
        'dark:border-red-700 dark:bg-red-900/40 dark:text-red-100',
        'w-full rounded-2xl border px-4 py-3 text-sm'
      )}
    >
      <div className="flex items-center gap-3">
        <SystemUpdate02Icon size={18} className="shrink-0" aria-hidden />
        <div className="flex-1 text-xs">
          <p className="font-medium">{title}</p>
          <p className="opacity-80">{reason}</p>
          {detail && (
            <button
              type="button"
              onClick={() => setShowDetail((v) => !v)}
              className={cn(
                'mt-1 text-[11px] underline underline-offset-2 opacity-60',
                'hover:opacity-90'
              )}
            >
              {t('errors.provider.viewDetails')}
            </button>
          )}
        </div>
        <button
          type="button"
          onClick={onRetry}
          className={cn(
            'flex shrink-0 items-center gap-1.5 self-center rounded-lg px-2.5 py-1.5',
            'text-[11px] font-medium cursor-pointer',
            'bg-red-600 text-white hover:bg-red-700',
            'dark:bg-red-700 dark:hover:bg-red-600'
          )}
        >
          <RefreshIcon size={12} aria-hidden />
          {retryLabel}
        </button>
      </div>
      {showDetail && detail && <ErrorDetailBlock text={detail} />}
    </div>
  )
}
