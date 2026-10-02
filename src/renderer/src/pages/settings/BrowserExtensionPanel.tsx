import { Button } from '@components/core/Button'
import { Tooltip } from '@components/core/Tooltip'
import { useToast } from '@components/core/toast/useToast'
import { cn } from '@lib/utils/cn'
import type {
  BrowserExtensionConfig,
  DoctorReport,
  ExtensionBrowserInfo,
  ExtensionConnectionStatus,
  ExtensionServerStatus,
  Finding
} from '@preload/index'
import braveIcon from '@renderer/assets/browsers/brave.svg'
import chromeIcon from '@renderer/assets/browsers/chrome.svg'
import chromiumIcon from '@renderer/assets/browsers/chromium.svg'
import edgeIcon from '@renderer/assets/browsers/edge.svg'
import firefoxIcon from '@renderer/assets/browsers/firefox.svg'
import safariIcon from '@renderer/assets/browsers/safari.svg'
import { ArrowDown01Icon, FolderOpenIcon, RefreshIcon, Tick02Icon } from 'hugeicons-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

/**
 * How long a browser's row survives after its socket drops. A reload
 * (button, version-mismatch, service-worker restart) disconnects for a few
 * seconds — the row must not blank out and re-pop. Expired grace means the
 * browser is genuinely gone and the row honestly disappears.
 */
const RELOAD_GRACE_MS = 20_000

const STATUS_COLORS: Record<ExtensionConnectionStatus, string> = {
  stopped: 'text-red-400',
  listening: 'text-amber-400',
  connected: 'text-green-500',
  error: 'text-red-400'
}

const STATUS_DOT_COLORS: Record<ExtensionConnectionStatus, string> = {
  stopped: 'bg-red-400',
  listening: 'bg-amber-400',
  connected: 'bg-green-500',
  error: 'bg-red-400'
}

const SEVERITY_DOT: Record<Finding['severity'], string> = {
  blocker: 'bg-red-400',
  degraded: 'bg-amber-400',
  note: 'bg-muted'
}

const SEVERITY_LABEL: Record<Finding['severity'], string> = {
  blocker: 'severityBlocker',
  degraded: 'severityDegraded',
  note: 'severityNote'
}

/** Fix kinds the app can run itself; `guided` and `none` are steps to follow. */
const RUNNABLE_FIXES = new Set(['auto', 'one-click'])

const BROWSER_ICONS: Record<string, string> = {
  chrome: chromeIcon,
  chromium: chromiumIcon,
  brave: braveIcon,
  edge: edgeIcon,
  firefox: firefoxIcon,
  safari: safariIcon
}

const ACTIONS = [
  {
    categoryKey: 'navigation',
    tools: ['ext_navigate', 'ext_back', 'ext_forward', 'ext_reload']
  },
  {
    categoryKey: 'interaction',
    tools: [
      'ext_click',
      'ext_type',
      'ext_select',
      'ext_hover',
      'ext_scroll',
      'ext_focus',
      'ext_keypress',
      'ext_drag_drop',
      'ext_file_upload',
      'ext_fill',
      'ext_fill_form'
    ]
  },
  {
    categoryKey: 'reading',
    tools: [
      'ext_take_snapshot',
      'ext_find',
      'ext_read_page',
      'ext_query_selector',
      'ext_get_attribute',
      'ext_get_value',
      'ext_get_url',
      'ext_get_page_info'
    ]
  },
  {
    categoryKey: 'tabs',
    tools: [
      'ext_tabs_list',
      'ext_tab_open',
      'ext_tab_close',
      'ext_tab_switch',
      'ext_windows_list',
      'ext_window_open',
      'ext_window_resize'
    ]
  },
  { categoryKey: 'capture', tools: ['ext_screenshot', 'ext_pdf', 'ext_download'] },
  {
    categoryKey: 'data',
    tools: [
      'ext_cookies_get',
      'ext_cookies_set',
      'ext_cookies_remove',
      'ext_storage_get',
      'ext_storage_set',
      'ext_clipboard_read',
      'ext_clipboard_write'
    ]
  },
  {
    categoryKey: 'advanced',
    tools: [
      'ext_execute_js',
      'ext_wait_for',
      'ext_wait_for_navigation',
      'ext_wait_for_network_idle',
      'ext_notify',
      'ext_debugger_attach',
      'ext_debugger_detach',
      'ext_debugger_status',
      'ext_mouse_move',
      'ext_humanize',
      'ext_list_network_requests',
      'ext_get_network_request',
      'ext_list_console_messages',
      'ext_handle_dialog',
      'ext_emulate',
      'ext_doctor',
      'ext_fix'
    ]
  }
]

export function BrowserExtensionPanel(): React.JSX.Element {
  const { t } = useTranslation()
  const toast = useToast()

  const [config, setConfig] = useState<BrowserExtensionConfig | null>(null)
  const [status, setStatus] = useState<ExtensionServerStatus | null>(null)
  const [extensionPath, setExtensionPath] = useState('')
  const [portInput, setPortInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [copied, setCopied] = useState(false)
  const [testing, setTesting] = useState(false)
  const [testingKey, setTestingKey] = useState<string | null>(null)
  const [lastTestedKey, setLastTestedKey] = useState<string | null>(null)
  const [testResult, setTestResult] = useState<'success' | 'failed' | null>(null)
  const [displayBrowsers, setDisplayBrowsers] = useState<ExtensionBrowserInfo[]>([])
  const graceRef = useRef<Map<string, { info: ExtensionBrowserInfo; at: number }>>(new Map())
  const prevLiveRef = useRef<ExtensionBrowserInfo[]>([])
  // True while the port field diverges from what's saved — a remote save
  // (phone screenshot settings, another window's port move) re-seeds the
  // config, but must not overwrite a port the user is mid-typing.
  const portDirtyRef = useRef(false)
  const [everConnected, setEverConnected] = useState(false)
  const [debuggerGuideOpen, setDebuggerGuideOpen] = useState(false)
  const [readiness, setReadiness] = useState<DoctorReport | null>(null)
  const [checking, setChecking] = useState(false)
  const [fixing, setFixing] = useState<string | null>(null)

  const runDoctor = useCallback(async () => {
    setChecking(true)
    try {
      setReadiness(await window.api.browserExtension.doctor())
    } catch {
      setReadiness(null)
    } finally {
      setChecking(false)
    }
  }, [])

  const handleFix = useCallback(
    async (finding: Finding) => {
      if (!finding.fix.action) return
      setFixing(finding.id)
      try {
        const result = await window.api.browserExtension.fix(finding.fix.action, {
          target: finding.browser ?? null,
          url: finding.fix.url,
          // The finding names its own macOS pane; without it every
          // open_system_settings fix landed on Screen Recording.
          pane: finding.fix.pane
        })
        toast.show({ message: result.message, tone: result.ok ? 'success' : 'error' })
      } catch {
        toast.show({ message: t('settings.services.browserExtension.updateError'), tone: 'error' })
      } finally {
        setFixing(null)
        // Re-probe: the finding is either gone or the next one surfaces.
        await runDoctor()
      }
    },
    [runDoctor, t, toast]
  )

  const handleOverlayToggle = useCallback(async (enabled: boolean) => {
    setConfig((prev) => (prev ? { ...prev, overlayEnabled: enabled } : prev))
    await window.api.browserExtension.setOverlayEnabled(enabled).catch(() => {})
  }, [])

  useEffect(() => {
    let cancelled = false
    void (async () => {
      const [cfg, st, path] = await Promise.all([
        window.api.browserExtension.getConfig(),
        window.api.browserExtension.status(),
        window.api.browserExtension.getExtensionPath()
      ])
      if (cancelled) return
      setConfig(cfg)
      setStatus(st)
      if (st.status === 'connected') setEverConnected(true)
      setExtensionPath(path)
      setPortInput(String(cfg.port))
      portDirtyRef.current = false
    })()
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(
    () =>
      window.api.services.onChanged((payload) => {
        if (payload.service !== 'browserExtension') return
        void window.api.browserExtension.getConfig().then((cfg) => {
          setConfig(cfg)
          if (!portDirtyRef.current) setPortInput(String(cfg.port))
        })
      }),
    []
  )

  useEffect(() => {
    return window.api.browserExtension.onStatusChange((st) => {
      setStatus(st)
      if (st.status === 'connected') setEverConnected(true)
    })
  }, [])

  // The readiness answer changes with the connection, so re-probe on both.
  // Deferred a tick: the probe flips `checking` immediately, and doing that
  // inside the effect body cascades a render on every status push.
  useEffect(() => {
    const timer = setTimeout(() => void runDoctor(), 0)
    return () => clearTimeout(timer)
  }, [runDoctor, status?.status, status?.browsers.length])

  const isConnected = status?.status === 'connected'
  const isListening = status?.status === 'listening'
  const showInstallGuide = !isConnected && !everConnected

  // Reload-stable browser list: rows survive the few-second reconnect gap of
  // an extension reload instead of blanking to "waiting". Only the status
  // dot/text tracks the live connection state. Rows whose browser does not
  // come back within the grace window drop out; genuinely-zero-connection
  // states (fresh install, server stopped) render truthfully empty.
  useEffect(() => {
    const idOf = (b: ExtensionBrowserInfo): string => b.instanceId ?? b.id
    const reconcile = (): void => {
      const live = status?.browsers ?? []
      const now = Date.now()
      if (!status || status.status === 'stopped' || status.status === 'error') {
        graceRef.current.clear()
        prevLiveRef.current = live
        setDisplayBrowsers(live)
        return
      }
      for (const prev of prevLiveRef.current) {
        if (!live.some((b) => idOf(b) === idOf(prev)) && !graceRef.current.has(idOf(prev))) {
          graceRef.current.set(idOf(prev), { info: prev, at: now })
        }
      }
      for (const [key, entry] of graceRef.current) {
        if (live.some((b) => idOf(b) === key) || now - entry.at > RELOAD_GRACE_MS) {
          graceRef.current.delete(key)
        }
      }
      prevLiveRef.current = live
      setDisplayBrowsers([...live, ...[...graceRef.current.values()].map((entry) => entry.info)])
    }
    reconcile()
    if (graceRef.current.size === 0) return undefined
    const timer = setInterval(reconcile, 1000)
    return () => clearInterval(timer)
  }, [status])

  const handlePortSave = useCallback(async () => {
    const port = parseInt(portInput, 10)
    if (isNaN(port) || port < 1 || port > 65535) {
      toast.show({ message: t('settings.services.browserExtension.invalidPort'), tone: 'error' })
      return
    }
    setBusy(true)
    try {
      const result = await window.api.browserExtension.setConfig({ port })
      setConfig(result.config)
      setPortInput(String(result.config.port))
      portDirtyRef.current = false
      toast.show({
        message: t('settings.services.browserExtension.saveSuccess'),
        tone: 'success'
      })
    } catch {
      toast.show({ message: t('settings.services.browserExtension.saveError'), tone: 'error' })
    } finally {
      setBusy(false)
    }
  }, [portInput, t, toast])

  const handleOpenFolder = useCallback(async () => {
    await window.api.browserExtension.openExtensionFolder()
  }, [])

  const handleUpdate = useCallback(async () => {
    setBusy(true)
    try {
      await window.api.browserExtension.updateExtension()
      toast.show({
        message: t('settings.services.browserExtension.updateSent'),
        tone: 'success'
      })
    } catch {
      toast.show({
        message: t('settings.services.browserExtension.updateError'),
        tone: 'error'
      })
    } finally {
      setBusy(false)
    }
  }, [t, toast])

  const handleTest = useCallback(
    async (target?: string) => {
      setTesting(true)
      setTestingKey(target ?? null)
      setLastTestedKey(target ?? null)
      setTestResult(null)
      try {
        const result = await window.api.browserExtension.testConnection(target ?? null)
        setTestResult(result.ok ? 'success' : 'failed')
        toast.show({
          message: result.ok
            ? t('settings.services.browserExtension.testPassedToast', {
                passed: result.passed,
                steps: result.steps
              })
            : t('settings.services.browserExtension.testFailedToast', {
                passed: result.passed,
                steps: result.steps
              }),
          tone: result.ok ? 'success' : 'error'
        })
      } catch {
        setTestResult('failed')
        toast.show({
          message: t('settings.services.browserExtension.testErrorToast'),
          tone: 'error'
        })
      } finally {
        setTesting(false)
        setTestingKey(null)
        setTimeout(() => setTestResult(null), 4000)
      }
    },
    [t, toast]
  )

  const handleScreenshotSave = useCallback(
    async (patch: { screenshotMaxWidth?: number; screenshotFormat?: 'jpeg' | 'png' }) => {
      try {
        const result = await window.api.browserExtension.setConfig(patch)
        setConfig(result.config)
      } catch {
        // best-effort
      }
    },
    []
  )

  const handleCopyPath = useCallback(() => {
    if (!extensionPath || copied) return
    void navigator.clipboard.writeText(extensionPath)
    setCopied(true)
    setTimeout(() => setCopied(false), 3000)
  }, [extensionPath, copied])

  const revealKey = navigator.platform.startsWith('Mac')
    ? 'settings.services.browserExtension.revealMac'
    : navigator.platform.startsWith('Win')
      ? 'settings.services.browserExtension.revealWindows'
      : 'settings.services.browserExtension.revealLinux'

  const portDirty = config !== null && portInput !== String(config.port)

  return (
    <div className="flex min-h-full w-full items-start justify-center px-6 py-10">
      <div className="flex w-full max-w-2xl flex-col gap-6">
        <header className="flex flex-col gap-2">
          <h1 className="text-fg text-2xl font-semibold tracking-tight">
            {t('settings.services.browserExtension.title')}
          </h1>
          <p className="text-muted text-sm leading-relaxed">
            {t('settings.services.browserExtension.subtitle')}
          </p>
        </header>

        {/* Extension Folder */}
        {extensionPath && (
          <section className="bg-surface border-border flex flex-col gap-3 rounded-2xl border p-4">
            <div className="flex items-center justify-between gap-3">
              <div className="text-fg flex items-center gap-2 text-sm font-medium">
                <FolderOpenIcon size={16} className="text-muted shrink-0" />
                {t('settings.services.browserExtension.extensionFolder')}
              </div>
              <button
                type="button"
                onClick={handleOpenFolder}
                className="text-primary hover:text-primary/80 shrink-0 cursor-pointer text-sm font-medium"
              >
                {t(revealKey)}
              </button>
            </div>
            <div dir="ltr" className="bg-bg flex w-full items-center gap-2 rounded-lg px-3 py-2">
              <code className="text-muted min-w-0 flex-1 truncate text-xs">{extensionPath}</code>
              <button
                type="button"
                disabled={copied}
                onClick={handleCopyPath}
                className={cn(
                  'shrink-0',
                  copied ? 'text-muted' : 'text-muted hover:text-fg cursor-pointer'
                )}
                aria-label="Copy path"
              >
                {copied ? (
                  <Tick02Icon size={14} />
                ) : (
                  <svg
                    width="14"
                    height="14"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                    <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                  </svg>
                )}
              </button>
            </div>
            <div className="flex flex-wrap items-center gap-2 pt-1">
              <BrowserBadge name="Chromium" supported icon={chromiumIcon} />
              <BrowserBadge name="Chrome" supported icon={chromeIcon} />
              <BrowserBadge name="Brave" supported icon={braveIcon} />
              <BrowserBadge name="Edge" supported icon={edgeIcon} />
              <BrowserBadge name="Safari" supported={false} icon={safariIcon} />
              <BrowserBadge name="Firefox" supported={false} icon={firefoxIcon} />
            </div>
          </section>
        )}

        {/* Connection Status */}
        {status && (
          <section className="bg-surface border-border flex flex-col gap-4 rounded-2xl border p-6">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <span
                  className={cn(
                    'inline-block h-2.5 w-2.5 rounded-full',
                    STATUS_DOT_COLORS[status.status],
                    status.status === 'listening' && 'animate-pulse'
                  )}
                />
                <span
                  className={cn(
                    'text-sm font-medium',
                    STATUS_COLORS[status.status],
                    status.status === 'listening' && 'animate-pulse'
                  )}
                >
                  {t(`settings.services.browserExtension.status.${status.status}`)}
                </span>
                {status.error && <span className="text-muted text-xs">{status.error}</span>}
              </div>
            </div>

            {displayBrowsers.length > 0 && (
              <div className="flex flex-col gap-2">
                {displayBrowsers.map((b) => (
                  <div key={b.id} className="bg-bg flex flex-col gap-2.5 rounded-xl px-3 py-2.5">
                    <div className="flex items-center gap-3">
                      <img
                        src={BROWSER_ICONS[b.browser] ?? chromiumIcon}
                        alt=""
                        className="h-5 w-5 shrink-0"
                      />
                      <div className="flex min-w-0 flex-1 flex-col">
                        <span className="text-fg truncate text-sm font-medium">
                          {b.name}
                          {b.browserVersion && (
                            <span className="text-muted font-normal">
                              {' '}
                              {b.browserVersion.split('.')[0]}
                            </span>
                          )}
                        </span>
                        <span className="text-muted truncate text-xs">
                          {[
                            b.profileEmail,
                            b.os,
                            `${t('settings.services.browserExtension.status.connected')} ${new Date(
                              b.connectedAt
                            ).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
                          ]
                            .filter(Boolean)
                            .join(' · ')}
                        </span>
                      </div>
                      {displayBrowsers.length > 1 && (
                        <code className="bg-surface text-muted rounded px-1.5 py-0.5 font-mono text-[11px]">
                          {b.key}
                        </code>
                      )}
                      {b.version && (
                        <code className="bg-surface text-muted rounded px-1.5 py-0.5 font-mono text-[11px]">
                          v{b.version}
                        </code>
                      )}
                    </div>
                    <div className="flex items-center gap-3 ps-8">
                      <button
                        type="button"
                        disabled={busy || testing}
                        onClick={() => handleTest(b.key)}
                        className={cn(
                          'text-xs font-medium capitalize',
                          busy || (testing && testingKey !== b.key)
                            ? 'text-muted cursor-not-allowed'
                            : testing && testingKey === b.key
                              ? 'text-muted animate-pulse cursor-wait'
                              : testResult === 'success' && lastTestedKey === b.key
                                ? 'text-green-500'
                                : testResult === 'failed' && lastTestedKey === b.key
                                  ? 'text-red-400'
                                  : 'text-primary hover:text-primary/80 cursor-pointer'
                        )}
                      >
                        {testing && testingKey === b.key
                          ? t('settings.services.browserExtension.testRunning')
                          : testResult === 'success' && lastTestedKey === b.key
                            ? t('settings.services.browserExtension.testPassed')
                            : testResult === 'failed' && lastTestedKey === b.key
                              ? t('settings.services.browserExtension.testFailed')
                              : t('settings.services.browserExtension.testBtn')}
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}

            <div className="flex items-center">
              <button
                type="button"
                onClick={() => void handleUpdate()}
                disabled={busy || !isConnected}
                className={cn(
                  'border-border bg-bg/40 inline-flex items-center gap-1.5 rounded-lg border px-3 py-1 text-xs font-medium',
                  'focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg',
                  busy || !isConnected
                    ? 'text-muted/50 cursor-not-allowed'
                    : 'text-fg hover:bg-border/40 cursor-pointer'
                )}
              >
                <RefreshIcon size={12} />
                <span>{t('settings.services.browserExtension.updateBtn')}</span>
              </button>
            </div>
          </section>
        )}

        {/* Readiness — what is missing, and what to do about it */}
        <section className="bg-surface border-border flex flex-col gap-4 rounded-2xl border p-6">
          <div className="flex items-start justify-between gap-3">
            <div className="flex flex-col gap-1">
              <h2 className="text-fg text-sm font-semibold">
                {t('settings.services.browserExtension.readinessTitle')}
              </h2>
              <p className="text-muted text-xs">
                {t('settings.services.browserExtension.readinessSubtitle')}
              </p>
            </div>
            <button
              type="button"
              onClick={() => void runDoctor()}
              disabled={checking}
              className={cn(
                'border-border bg-bg/40 inline-flex shrink-0 items-center gap-1.5 rounded-lg border px-3 py-1 text-xs font-medium',
                checking
                  ? 'text-muted/50 cursor-not-allowed'
                  : 'text-fg hover:bg-border/40 cursor-pointer'
              )}
            >
              <RefreshIcon size={12} className={cn(checking && 'animate-spin')} />
              <span>
                {checking
                  ? t('settings.services.browserExtension.readinessChecking')
                  : t('settings.services.browserExtension.readinessRecheck')}
              </span>
            </button>
          </div>

          {readiness && (
            <div className="flex flex-col gap-3">
              {readiness.findings.length === 0 ? (
                <div className="flex items-center gap-2">
                  <span className="inline-block h-2 w-2 shrink-0 rounded-full bg-green-500" />
                  <p className="text-green-500 text-xs">
                    {t('settings.services.browserExtension.readinessReady')}
                  </p>
                </div>
              ) : (
                readiness.findings.map((f) => (
                  <div key={f.id} className="bg-bg flex flex-col gap-2 rounded-xl px-3 py-2.5">
                    <div className="flex items-start gap-2.5">
                      <span
                        className={cn(
                          'mt-1.5 inline-block h-2 w-2 shrink-0 rounded-full',
                          SEVERITY_DOT[f.severity]
                        )}
                      />
                      <div className="flex min-w-0 flex-1 flex-col gap-1">
                        <div className="flex flex-wrap items-baseline gap-2">
                          <span className="text-fg text-sm font-medium">{f.title}</span>
                          <span className="text-muted text-[10px] font-semibold uppercase tracking-wider">
                            {t(`settings.services.browserExtension.${SEVERITY_LABEL[f.severity]}`)}
                          </span>
                        </div>
                        <span className="text-muted text-xs leading-relaxed">{f.detail}</span>
                        {f.fix.steps.length > 0 && (
                          <ol className="text-muted flex list-inside list-decimal flex-col gap-0.5 text-xs">
                            {f.fix.steps.map((step) => (
                              <li key={step}>{step}</li>
                            ))}
                          </ol>
                        )}
                      </div>
                      {f.fix.action && RUNNABLE_FIXES.has(f.fix.kind) && (
                        <button
                          type="button"
                          disabled={fixing !== null}
                          onClick={() => void handleFix(f)}
                          className={cn(
                            'shrink-0 text-xs font-medium',
                            fixing !== null
                              ? 'text-muted cursor-not-allowed'
                              : 'text-primary hover:text-primary/80 cursor-pointer'
                          )}
                        >
                          {fixing === f.id
                            ? t('settings.services.browserExtension.readinessFixing')
                            : t('settings.services.browserExtension.readinessFix')}
                        </button>
                      )}
                    </div>
                  </div>
                ))
              )}
              <span className="text-muted text-[11px]">
                {t('settings.services.browserExtension.readinessTier')}: {readiness.tier}
              </span>
            </div>
          )}
        </section>

        {/* On-page cursor */}
        {config && (
          <section className="bg-surface border-border flex flex-col gap-3 rounded-2xl border p-6">
            <div className="flex items-center justify-between gap-3">
              <label htmlFor="wf-overlay" className="text-fg text-sm font-medium">
                {t('settings.services.browserExtension.overlayTitle')}
              </label>
              <button
                id="wf-overlay"
                type="button"
                role="switch"
                aria-checked={config.overlayEnabled !== false}
                onClick={() => void handleOverlayToggle(config.overlayEnabled === false)}
                className={cn(
                  'rounded-lg border px-3 py-1.5 text-sm cursor-pointer',
                  config.overlayEnabled !== false
                    ? 'bg-primary text-primary-fg border-primary'
                    : 'border-border text-muted hover:bg-border/40 hover:text-fg'
                )}
              >
                {config.overlayEnabled !== false
                  ? t('settings.services.browserExtension.overlayOn')
                  : t('settings.services.browserExtension.overlayOff')}
              </button>
            </div>
            <p className="text-muted text-xs leading-relaxed">
              {t('settings.services.browserExtension.overlayHint')}
            </p>
          </section>
        )}

        {/* Port Configuration */}
        {config && (
          <section className="bg-surface border-border flex flex-col gap-4 rounded-2xl border p-6">
            <div className="flex flex-col gap-1">
              <label className="text-fg text-sm font-medium">
                {t('settings.services.browserExtension.portLabel')}
              </label>
              <p className="text-muted text-xs">
                {t('settings.services.browserExtension.portHint')}
              </p>
            </div>
            <div className="flex items-center gap-3">
              <input
                type="number"
                min={1}
                max={65535}
                value={portInput}
                onChange={(e) => {
                  portDirtyRef.current = true
                  setPortInput(e.target.value)
                }}
                className={cn(
                  'border-border bg-bg text-fg h-10 min-w-0 flex-1 rounded-lg border px-3 text-sm font-mono',
                  'focus:ring-2 focus:ring-primary focus:border-primary focus:outline-none'
                )}
              />
              <Button onClick={handlePortSave} disabled={!config || busy || !portDirty}>
                {t('settings.services.browserExtension.savePort')}
              </Button>
            </div>
          </section>
        )}

        {/* Screenshot Settings */}
        {config && (
          <section className="bg-surface border-border flex flex-col gap-5 rounded-2xl border p-6">
            <div className="flex flex-col gap-2">
              <label className="text-fg text-sm font-medium">
                {t('settings.services.browserExtension.resolutionLabel')}
              </label>
              <p className="text-muted text-xs">
                {t('settings.services.browserExtension.resolutionHint')}
              </p>
              <div className="flex gap-2">
                {[640, 960, 1280, 1920].map((w) => (
                  <button
                    key={w}
                    type="button"
                    onClick={() => handleScreenshotSave({ screenshotMaxWidth: w })}
                    className={cn(
                      'rounded-lg border px-3 py-1.5 text-sm cursor-pointer',
                      config.screenshotMaxWidth === w
                        ? 'bg-primary text-primary-fg border-primary'
                        : 'border-border text-muted hover:bg-border/40 hover:text-fg'
                    )}
                  >
                    {w}px
                  </button>
                ))}
              </div>
            </div>

            <div className="flex flex-col gap-2">
              <label className="text-fg text-sm font-medium">
                {t('settings.services.browserExtension.formatLabel')}
              </label>
              <p className="text-muted text-xs">
                {t('settings.services.browserExtension.formatHint')}
              </p>
              <div className="flex gap-2">
                {(['jpeg', 'png'] as const).map((fmt) => (
                  <button
                    key={fmt}
                    type="button"
                    onClick={() => handleScreenshotSave({ screenshotFormat: fmt })}
                    className={cn(
                      'rounded-lg border px-3 py-1.5 text-sm cursor-pointer uppercase',
                      config.screenshotFormat === fmt
                        ? 'bg-primary text-primary-fg border-primary'
                        : 'border-border text-muted hover:bg-border/40 hover:text-fg'
                    )}
                  >
                    {fmt}
                  </button>
                ))}
              </div>
            </div>
          </section>
        )}

        {/* Installation Guide (shown when never connected this session) */}
        {showInstallGuide && (
          <section className="bg-surface border-border flex flex-col gap-4 rounded-2xl border p-6">
            <h2 className="text-fg text-sm font-semibold">
              {t('settings.services.browserExtension.installTitle')}
            </h2>
            <ol className="text-muted flex flex-col gap-3 text-sm leading-relaxed">
              {[1, 2, 3, 4].map((step) => (
                <li key={step} className="flex items-start gap-3">
                  <span
                    className={cn(
                      'flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-xs font-bold',
                      'bg-primary/15 text-primary'
                    )}
                  >
                    {step}
                  </span>
                  <span>
                    {t(`settings.services.browserExtension.step${step}`)}
                    {step === 1 && (
                      <button
                        type="button"
                        onClick={() => {
                          window.api.browserExtension.openExtensionsPage()
                          toast.show({
                            message: t('settings.services.browserExtension.step1Toast'),
                            tone: 'success'
                          })
                        }}
                        className="text-primary hover:text-primary/80 cursor-pointer underline"
                      >
                        {t('settings.services.browserExtension.step1Link')}
                      </button>
                    )}
                  </span>
                </li>
              ))}
            </ol>
            {isListening && (
              <div className="flex items-center gap-2">
                <span className="inline-block h-2 w-2 shrink-0 rounded-full bg-green-500 animate-pulse" />
                <p className="text-green-500 text-xs animate-pulse">
                  {t('settings.services.browserExtension.waitingForConnection')}
                </p>
              </div>
            )}
          </section>
        )}

        {/* Debugger Mode Guide */}
        <section className="bg-surface border-border flex flex-col rounded-2xl border">
          <button
            type="button"
            onClick={() => setDebuggerGuideOpen((v) => !v)}
            className="flex w-full cursor-pointer items-center justify-between p-5"
          >
            <h2 className="text-fg text-sm font-semibold">
              {t('settings.services.browserExtension.debuggerMode.title')}
            </h2>
            <ArrowDown01Icon
              size={16}
              className={cn(
                'text-muted shrink-0 transition-transform duration-200',
                debuggerGuideOpen && 'rotate-180'
              )}
            />
          </button>
          <div
            className={cn(
              'grid transition-[grid-template-rows] duration-200 ease-out',
              debuggerGuideOpen ? 'grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0'
            )}
          >
            <div className="overflow-hidden">
              <div className="flex flex-col gap-4 px-5 pb-5 pt-0">
                <p className="text-muted text-sm leading-relaxed">
                  {t('settings.services.browserExtension.debuggerMode.body')}
                </p>
                <div className="bg-bg rounded-lg p-4">
                  <p className="text-muted text-xs leading-relaxed">
                    {t('settings.services.browserExtension.debuggerMode.infobarNote')}
                  </p>
                  <div className="mt-3 flex flex-col gap-2">
                    <div className="flex flex-col gap-1">
                      <span className="text-muted text-[10px] font-semibold uppercase tracking-wider">
                        macOS
                      </span>
                      <code className="text-fg bg-surface rounded px-2 py-1 text-[11px] font-mono break-all">
                        open -a &quot;Google Chrome&quot; --args --silent-debugger-extension-api
                      </code>
                    </div>
                    <div className="flex flex-col gap-1">
                      <span className="text-muted text-[10px] font-semibold uppercase tracking-wider">
                        Windows
                      </span>
                      <code className="text-fg bg-surface rounded px-2 py-1 text-[11px] font-mono break-all">
                        &quot;C:\Program Files\Google\Chrome\Application\chrome.exe&quot;
                        --silent-debugger-extension-api
                      </code>
                    </div>
                    <div className="flex flex-col gap-1">
                      <span className="text-muted text-[10px] font-semibold uppercase tracking-wider">
                        Linux
                      </span>
                      <code className="text-fg bg-surface rounded px-2 py-1 text-[11px] font-mono break-all">
                        google-chrome --silent-debugger-extension-api
                      </code>
                    </div>
                  </div>
                </div>
                <p className="text-muted text-xs leading-relaxed">
                  <span className="font-semibold">
                    {t('settings.services.browserExtension.debuggerMode.tipLabel')}
                  </span>{' '}
                  {t('settings.services.browserExtension.debuggerMode.tipText')}
                </p>
                <p className="text-muted text-xs leading-relaxed">
                  <span className="font-semibold">
                    {t('settings.services.browserExtension.debuggerMode.notSupportedLabel')}
                  </span>{' '}
                  {t('settings.services.browserExtension.debuggerMode.notSupportedText')}
                </p>
              </div>
            </div>
          </div>
        </section>

        {/* Actions Table */}
        <section className="bg-surface border-border flex flex-col rounded-2xl border">
          <div className="p-5 pb-3">
            <h2 className="text-fg text-sm font-semibold">
              {t('settings.services.browserExtension.actionsTitle')}
            </h2>
            <p className="text-muted mt-1 text-xs">
              {t('settings.services.browserExtension.actionsSubtitle')}
            </p>
          </div>
          {ACTIONS.map((group, gi) => (
            <div key={group.categoryKey}>
              <div className="border-border/60 border-t" />
              <div className="px-5 pt-3 pb-1">
                <span className="text-muted text-[10px] font-semibold uppercase tracking-wider">
                  {t(`settings.services.browserExtension.actions.${group.categoryKey}.category`)}
                </span>
              </div>
              {group.tools.map((tool, ai) => (
                <div
                  key={tool}
                  className={cn(
                    'flex items-center gap-3 px-5 py-2',
                    gi === ACTIONS.length - 1 && ai === group.tools.length - 1 && 'pb-4'
                  )}
                >
                  <code className="text-fg bg-bg shrink-0 rounded px-1.5 py-0.5 text-[11px] font-mono">
                    {tool}
                  </code>
                  <span className="text-muted min-w-0 truncate text-xs">
                    {t(`settings.services.browserExtension.actions.${tool}`)}
                  </span>
                </div>
              ))}
            </div>
          ))}
        </section>
      </div>
    </div>
  )
}

function BrowserBadge({
  name,
  supported,
  icon
}: {
  name: string
  supported: boolean
  icon: string
}): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <Tooltip
      content={
        supported
          ? t('settings.services.browserExtension.supported')
          : t('settings.services.browserExtension.notSupported')
      }
    >
      <span
        className={cn(
          'inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-[11px] font-medium ring-1 cursor-default select-none',
          supported
            ? 'bg-emerald-500/10 text-emerald-600 ring-emerald-500/20 dark:text-emerald-400'
            : 'bg-border/30 text-muted ring-border/50 line-through opacity-50'
        )}
      >
        <img src={icon} alt={name} className={cn('h-3.5 w-3.5', !supported && 'grayscale')} />
        {name}
      </span>
    </Tooltip>
  )
}
