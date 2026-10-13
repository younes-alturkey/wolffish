import { Button } from '@components/core/Button'
import { Input } from '@components/core/Input'
import { useToast } from '@components/core/toast/useToast'
import { ToggleSwitch } from '@components/common/toggle-switch/ToggleSwitch'
import { cn } from '@lib/utils/cn'
import { isWeb } from '@lib/utils/platform'
import type {
  HttpsProgressEvent,
  PreflightStep,
  WebUiConfigPatch,
  WebUiHttpsMode,
  WebUiPublicConfig,
  WebUiStatus
} from '@preload/index'
import {
  Alert02Icon,
  AlertCircleIcon,
  CheckmarkCircle02Icon,
  Copy01Icon,
  LinkSquare02Icon,
  Loading02Icon,
  RefreshIcon,
  SecurityCheckIcon,
  Tick02Icon
} from 'hugeicons-react'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

/**
 * Settings → Channels → Web UI → HTTPS.
 *
 * Three views of the Let's Encrypt mode, decided by the server's state:
 * idle (an address and one button), running (every preflight and issuance
 * step as it settles, a failure expanded with the fix for this OS), and
 * active (what is being served, when it renews, what happened before). The
 * self-signed and custom modes keep their one-line forms.
 */
const HTTPS_MODES: WebUiHttpsMode[] = ['off', 'acme', 'selfsigned', 'custom']

const STEP_ORDER: PreflightStep['id'][] = [
  'public-ip',
  'interface',
  'ports',
  'privileged',
  'firewall',
  'reachable',
  'account',
  'order',
  'certificate'
]

const COUNTDOWN_S = 3

export function Notice({
  tone,
  text
}: {
  tone: 'warning' | 'error' | 'info'
  text: string
}): React.JSX.Element {
  return (
    <div
      className={cn(
        'flex items-start gap-2 rounded-xl border px-3 py-2.5 text-xs leading-relaxed',
        tone === 'error' && 'border-rose-500/30 bg-rose-500/10 text-rose-700 dark:text-rose-300',
        tone === 'warning' &&
          'border-amber-500/30 bg-amber-500/10 text-amber-800 dark:text-amber-200',
        tone === 'info' && 'border-border bg-bg/40 text-muted'
      )}
    >
      {tone === 'info' ? (
        <CheckmarkCircle02Icon size={14} className="mt-0.5 shrink-0" />
      ) : (
        <Alert02Icon size={14} className="mt-0.5 shrink-0" />
      )}
      <span>{text}</span>
    </div>
  )
}

export function Row({
  label,
  value,
  mono = false
}: {
  label: string
  value: string
  mono?: boolean
}): React.JSX.Element {
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <dt className="text-muted text-xs">{label}</dt>
      <dd
        dir={mono ? 'ltr' : undefined}
        className={cn('text-fg text-sm wrap-anywhere', mono && 'font-mono text-xs')}
      >
        {value}
      </dd>
    </div>
  )
}

function CopyLine({ text }: { text: string }): React.JSX.Element {
  const [copied, setCopied] = useState(false)
  return (
    <div className="flex items-start gap-2">
      <pre
        dir="ltr"
        className="border-border bg-bg text-fg min-w-0 flex-1 rounded-lg border px-2.5 py-2 font-mono text-[11px] leading-relaxed whitespace-pre-wrap wrap-anywhere"
      >
        {text}
      </pre>
      <button
        type="button"
        onClick={() => {
          void navigator.clipboard?.writeText(text).catch(() => undefined)
          setCopied(true)
          setTimeout(() => setCopied(false), 1500)
        }}
        className="text-muted hover:text-fg flex h-8 w-8 shrink-0 cursor-pointer items-center justify-center rounded-lg"
        aria-label="Copy"
      >
        {copied ? <Tick02Icon size={14} className="text-emerald-500" /> : <Copy01Icon size={14} />}
      </button>
    </div>
  )
}

function StepIcon({ status }: { status: PreflightStep['status'] }): React.JSX.Element {
  if (status === 'ok') return <CheckmarkCircle02Icon size={16} className="text-emerald-500" />
  if (status === 'warn') return <Alert02Icon size={16} className="text-amber-500" />
  if (status === 'fail') return <AlertCircleIcon size={16} className="text-rose-500" />
  if (status === 'running') return <Loading02Icon size={16} className="text-primary animate-spin" />
  return (
    <span
      className={cn(
        'border-border block size-3.5 rounded-full border-2',
        status === 'skip' && 'border-dashed'
      )}
    />
  )
}

function fmtDate(ms: number | null | undefined): string {
  return ms ? new Date(ms).toLocaleString() : '—'
}

/** Only move a page to the new origin when it is the same host, over plain HTTP. */
function shouldMoveTo(url: string | null): boolean {
  if (!isWeb || !url || location.protocol === 'https:') return false
  try {
    return new URL(url).hostname === location.hostname
  } catch {
    return false
  }
}

export function WebHttpsCard({
  config,
  status,
  loaded,
  busy,
  onApply,
  onStatus
}: {
  config: WebUiPublicConfig | null
  status: WebUiStatus | null
  loaded: boolean
  busy: string | null
  onApply: (patch: WebUiConfigPatch) => Promise<void>
  onStatus: (status: WebUiStatus) => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const toast = useToast()
  const storedMode = config?.https?.mode ?? 'off'
  const [chosen, setChosen] = useState<WebUiHttpsMode | null>(null)
  const mode = chosen ?? storedMode
  const https = status?.https ?? null

  // ── idle form ──────────────────────────────────────────────────────────────
  const [ip, setIp] = useState('')
  const [domain, setDomain] = useState('')
  const [staging, setStaging] = useState(false)
  const [detecting, setDetecting] = useState(false)
  const [seeded, setSeeded] = useState(false)
  if (!seeded && https) {
    setSeeded(true)
    if (https.mode === 'ip' && https.identifier) setIp(https.identifier)
    if (https.mode === 'domain' && https.identifier) setDomain(https.identifier)
    setStaging(https.staging)
  }
  useEffect(() => {
    // Once, when the form first shows empty: fill the address in from the
    // internet. No spinner here — the placeholder says it is being looked up,
    // and the state only changes when the answer arrives.
    if (!seeded || ip || domain || mode !== 'acme') return
    let alive = true
    void window.api.web
      .detectPublicIp()
      .then((found) => {
        if (alive && (found.ipv4 || found.ipv6)) setIp(found.ipv4 ?? found.ipv6 ?? '')
      })
      .catch(() => undefined)
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seeded, mode])

  // ── advanced fields ────────────────────────────────────────────────────────
  const [advanced, setAdvanced] = useState(false)
  const [email, setEmail] = useState('')
  const [httpPort, setHttpPort] = useState('')
  const [httpsPort, setHttpsPort] = useState('')
  const [certPath, setCertPath] = useState('')
  const [keyPath, setKeyPath] = useState('')
  const [base, setBase] = useState<string | null>(null)
  const applied = config ? JSON.stringify(config.https ?? {}) : null
  if (applied !== base) {
    setBase(applied)
    setEmail(config?.https?.acme?.email ?? '')
    setHttpPort(config?.https?.httpPort ? String(config.https.httpPort) : '')
    setHttpsPort(config?.https?.port ? String(config.https.port) : '')
    setCertPath(config?.https?.custom?.certPath ?? '')
    setKeyPath(config?.https?.custom?.keyPath ?? '')
  }
  const num = (s: string): number | null => (s.trim() === '' ? null : Number(s))
  const validPort = (n: number | null): boolean =>
    n === null || (Number.isInteger(n) && n >= 1 && n <= 65535)
  const advancedDirty =
    loaded &&
    (email.trim() !== (config?.https?.acme?.email ?? '') ||
      num(httpPort) !== (config?.https?.httpPort ?? null) ||
      (num(httpsPort) ?? 443) !== (config?.https?.port ?? 443) ||
      certPath.trim() !== (config?.https?.custom?.certPath ?? '') ||
      keyPath.trim() !== (config?.https?.custom?.keyPath ?? ''))
  const applyAdvanced = (): void => {
    void onApply({
      https: {
        httpPort: num(httpPort),
        port: num(httpsPort) ?? 443,
        acme: { email: email.trim() || undefined },
        custom: { certPath: certPath.trim(), keyPath: keyPath.trim() }
      }
    })
  }

  // ── live steps ─────────────────────────────────────────────────────────────
  const [liveSteps, setLiveSteps] = useState<PreflightStep[]>([])
  const [flowKey, setFlowKey] = useState<number | null>(null)
  const flowStart = https?.flow?.startedAt ?? null
  if (flowStart !== flowKey) {
    // A new run (or a reconnect that brought its snapshot): start from what the server has.
    setFlowKey(flowStart)
    setLiveSteps(https?.flow?.steps ?? [])
  }
  useEffect(() => {
    return window.api.web.onHttpsProgress((event: HttpsProgressEvent) => {
      if (!event.step) return
      const step = event.step
      setLiveSteps((steps) => {
        const i = steps.findIndex((s) => s.id === step.id)
        if (i < 0) return [...steps, step]
        const next = steps.slice()
        next[i] = step
        return next
      })
    })
  }, [])

  // ── actions ────────────────────────────────────────────────────────────────
  const [enabling, setEnabling] = useState(false)
  const [renewing, setRenewing] = useState(false)
  const [disabling, setDisabling] = useState(false)
  const [restarting, setRestarting] = useState(false)
  const [countdown, setCountdown] = useState<{ url: string; left: number } | null>(null)
  const countdownTimer = useRef<ReturnType<typeof setInterval> | null>(null)

  const stopCountdown = (): void => {
    if (countdownTimer.current) clearInterval(countdownTimer.current)
    countdownTimer.current = null
    setCountdown(null)
  }
  const startCountdown = (url: string): void => {
    stopCountdown()
    setCountdown({ url, left: COUNTDOWN_S })
    countdownTimer.current = setInterval(() => {
      setCountdown((c) => {
        if (!c) return c
        if (c.left <= 1) {
          if (countdownTimer.current) clearInterval(countdownTimer.current)
          countdownTimer.current = null
          location.replace(`${c.url}${location.pathname}${location.search}`)
          return { ...c, left: 0 }
        }
        return { ...c, left: c.left - 1 }
      })
    }, 1000)
  }
  useEffect(() => stopCountdown, [])

  const fail = (err: unknown): void => {
    toast.show({ message: err instanceof Error ? err.message : String(err), tone: 'error' })
  }

  const enable = async (): Promise<void> => {
    setEnabling(true)
    setLiveSteps([])
    try {
      const result = await window.api.web.httpsEnable({
        ip: domain.trim() ? null : ip.trim() || null,
        domain: domain.trim() || null,
        staging
      })
      setChosen(null)
      if (result.ok && result.url) {
        toast.show({
          message: t('settings.web.https.enabled', { url: result.url }),
          tone: 'success'
        })
        if (shouldMoveTo(result.url)) startCountdown(result.url)
      } else if (result.step) {
        toast.show({ message: result.step.detail, tone: 'error' })
      }
      onStatus(await window.api.web.status())
    } catch (err) {
      fail(err)
    } finally {
      setEnabling(false)
    }
  }

  const disable = async (): Promise<void> => {
    setDisabling(true)
    try {
      onStatus(await window.api.web.httpsDisable())
      setChosen(null)
      setLiveSteps([])
    } catch (err) {
      fail(err)
    } finally {
      setDisabling(false)
    }
  }

  const renew = async (): Promise<void> => {
    setRenewing(true)
    try {
      onStatus(await window.api.web.renewCertificate())
    } catch (err) {
      fail(err)
    } finally {
      setRenewing(false)
    }
  }

  const restart = async (): Promise<void> => {
    setRestarting(true)
    try {
      await window.api.app.restart()
    } catch (err) {
      fail(err)
      setRestarting(false)
      return
    }
    // Poll until the server answers again; the socket reconnects on its own.
    const started = Date.now()
    const back = async (): Promise<boolean> => {
      try {
        if (isWeb) return (await fetch('/api/auth/status', { cache: 'no-store' })).ok
        await window.api.web.status()
        return true
      } catch {
        return false
      }
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 3000))
    while (Date.now() - started < 90_000) {
      if (await back()) break
      await new Promise<void>((resolve) => setTimeout(resolve, 2000))
    }
    setRestarting(false)
    void window.api.web
      .status()
      .then(onStatus)
      .catch(() => undefined)
  }

  const selectMode = (next: WebUiHttpsMode): void => {
    if (next === mode) return
    if (next === 'acme') {
      // Shown, not applied: Let's Encrypt starts from the Enable button,
      // after the preflight, never from a tab click.
      setChosen('acme')
      return
    }
    if (storedMode === 'acme' && next === 'off') {
      setChosen(null)
      void disable()
      return
    }
    setChosen(null)
    void onApply({ https: { mode: next } })
  }

  // ── derived view ───────────────────────────────────────────────────────────
  const running = https?.flow?.running === true || enabling
  const view: 'idle' | 'running' | 'failed' | 'active' =
    mode !== 'acme'
      ? 'idle'
      : running
        ? 'running'
        : storedMode === 'acme' && (https?.state === 'active' || https?.state === 'renewing')
          ? 'active'
          : https?.state === 'error' && https.flow
            ? 'failed'
            : 'idle'
  const stepsToShow = STEP_ORDER.map((id) => liveSteps.find((s) => s.id === id)).filter(
    (s): s is PreflightStep => Boolean(s)
  )
  const failedStep = stepsToShow.find((s) => s.status === 'fail') ?? null
  const cert = https?.certificate ?? null
  const tls = status?.tls
  const state = https?.state ?? 'disabled'
  const secureChecks = isWeb
    ? [
        { key: 'context', ok: window.isSecureContext },
        { key: 'microphone', ok: Boolean(navigator.mediaDevices?.getUserMedia) },
        { key: 'notifications', ok: 'Notification' in window }
      ]
    : []

  return (
    <section className="bg-surface border-border flex flex-col gap-4 rounded-2xl border p-6">
      <div className="flex items-start gap-3">
        <SecurityCheckIcon size={18} className="text-muted mt-0.5 shrink-0" />
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-fg text-sm font-medium">{t('settings.web.https.title')}</span>
            {(storedMode === 'acme' || state !== 'disabled') && (
              <span
                className={cn(
                  'rounded-full px-2 py-0.5 text-[11px] font-medium',
                  state === 'active' && 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400',
                  (state === 'renewing' || state === 'issuing' || state === 'preflight') &&
                    'bg-amber-500/10 text-amber-700 dark:text-amber-300',
                  state === 'error' && 'bg-rose-500/10 text-rose-600 dark:text-rose-400',
                  state === 'disabled' && 'bg-border/40 text-muted'
                )}
              >
                {t(`settings.web.https.state.${state}`)}
              </span>
            )}
          </div>
          <p className="text-muted text-xs leading-relaxed">
            {t('settings.web.https.description')}
          </p>
        </div>
      </div>

      <div
        role="tablist"
        className="border-border bg-bg/40 flex flex-wrap gap-1 rounded-xl border p-1"
      >
        {HTTPS_MODES.map((m) => (
          <button
            key={m}
            role="tab"
            type="button"
            aria-selected={mode === m}
            disabled={!loaded || busy !== null || running || disabling}
            onClick={() => selectMode(m)}
            className={cn(
              'flex-1 cursor-pointer rounded-lg px-3 py-1.5 text-xs font-medium whitespace-nowrap',
              'focus-visible:ring-2 focus-visible:ring-accent',
              mode === m ? 'bg-primary text-primary-fg shadow-sm' : 'text-muted hover:text-fg'
            )}
          >
            {t(`settings.web.https.modes.${m}`)}
          </button>
        ))}
      </div>
      <p className="text-muted text-xs leading-relaxed">
        {t(`settings.web.https.modeHint.${mode}`)}
      </p>

      {restarting && <Notice tone="warning" text={t('settings.web.https.restarting')} />}
      {countdown && (
        <div className="flex items-center justify-between gap-3 rounded-xl border border-emerald-500/30 bg-emerald-500/10 px-3 py-2.5 text-xs text-emerald-800 dark:text-emerald-200">
          <span>
            {t('settings.web.https.movingIn', { url: countdown.url, seconds: countdown.left })}
          </span>
          <Button variant="ghost" size="sm" onClick={stopCountdown}>
            {t('settings.web.https.stay')}
          </Button>
        </div>
      )}

      {/* ── Let's Encrypt: idle ─────────────────────────────────────────────── */}
      {mode === 'acme' && view === 'idle' && (
        <div className="flex flex-col gap-3">
          <div className="grid grid-cols-2 gap-3 max-sm:grid-cols-1">
            <label className="flex flex-col gap-1">
              <span className="text-muted text-xs">{t('settings.web.https.ip')}</span>
              <div className="flex gap-2">
                <Input
                  value={ip}
                  onChange={(e) => setIp(e.target.value)}
                  placeholder={detecting || !ip ? t('settings.web.https.detecting') : '203.0.113.9'}
                  dir="ltr"
                  className="flex-1 font-mono"
                />
                <Button
                  variant="outline"
                  size="sm"
                  disabled={detecting}
                  className="h-10 shrink-0"
                  onClick={() => {
                    setDetecting(true)
                    void window.api.web
                      .detectPublicIp()
                      .then((found) => {
                        const v = found.ipv4 ?? found.ipv6
                        if (v) setIp(v)
                        else
                          toast.show({
                            message: t('settings.web.https.detectNone'),
                            tone: 'warning'
                          })
                      })
                      .finally(() => setDetecting(false))
                  }}
                >
                  <RefreshIcon size={14} />
                  {t('settings.web.https.detect')}
                </Button>
              </div>
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-muted text-xs">{t('settings.web.https.domain')}</span>
              <Input
                value={domain}
                onChange={(e) => setDomain(e.target.value)}
                placeholder="box.example.com"
                dir="ltr"
                className="font-mono"
              />
            </label>
          </div>
          <p className="text-muted text-xs leading-relaxed">
            {domain.trim() ? t('settings.web.https.domainHint') : t('settings.web.https.ipHint')}
          </p>
          {import.meta.env.DEV && (
            <div className="-ms-1.5 flex items-center gap-0">
              <ToggleSwitch
                on={staging}
                iconSize={22}
                className="h-8 w-8"
                labelOn={t('settings.web.https.staging')}
                labelOff={t('settings.web.https.staging')}
                onToggle={setStaging}
              />
              <button
                type="button"
                onClick={() => setStaging((v) => !v)}
                className="text-muted hover:text-fg cursor-pointer text-xs"
              >
                {t('settings.web.https.staging')}
              </button>
            </div>
          )}
          {https?.lastError && https.state === 'error' && (
            <Notice tone="error" text={https.lastError} />
          )}
          <div className="flex justify-end">
            <Button
              size="sm"
              disabled={!loaded || busy !== null || (!ip.trim() && !domain.trim())}
              onClick={() => void enable()}
            >
              <SecurityCheckIcon size={14} />
              {t('settings.web.https.enable')}
            </Button>
          </div>
        </div>
      )}

      {/* ── Let's Encrypt: running / failed ─────────────────────────────────── */}
      {mode === 'acme' && (view === 'running' || view === 'failed') && (
        <div className="flex flex-col gap-3">
          <ol className="flex flex-col gap-2">
            {STEP_ORDER.map((id) => {
              const step = stepsToShow.find((s) => s.id === id)
              const st = step?.status ?? 'pending'
              const show = step !== undefined || view === 'running'
              if (!show) return null
              return (
                <li key={id} className="flex flex-col gap-1.5">
                  <div className="flex items-start gap-2.5">
                    <span className="mt-0.5 flex size-4 shrink-0 items-center justify-center">
                      <StepIcon status={st} />
                    </span>
                    <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                      <span
                        className={cn(
                          'text-sm',
                          st === 'pending' ? 'text-muted' : 'text-fg',
                          st === 'fail' && 'text-rose-600 dark:text-rose-400'
                        )}
                      >
                        {t(`settings.web.https.steps.${id}`)}
                      </span>
                      {step?.detail && (
                        <span className="text-muted text-xs leading-relaxed">{step.detail}</span>
                      )}
                    </div>
                  </div>
                  {step?.fix && (st === 'fail' || st === 'warn') && (
                    <div className="ms-6 flex flex-col gap-2 rounded-xl border border-rose-500/20 bg-rose-500/5 p-3">
                      <span className="text-fg text-xs font-medium">
                        {t('settings.web.https.fixTitle')}
                      </span>
                      <p className="text-muted text-xs leading-relaxed">{step.fix.text}</p>
                      {step.fix.commands.map((cmd) => (
                        <CopyLine key={cmd} text={cmd} />
                      ))}
                    </div>
                  )}
                </li>
              )
            })}
          </ol>
          {view === 'failed' && (
            <div className="flex justify-end gap-2">
              <Button variant="ghost" size="sm" disabled={disabling} onClick={() => void disable()}>
                {t('settings.web.https.disable')}
              </Button>
              <Button size="sm" disabled={!loaded || busy !== null} onClick={() => void enable()}>
                <RefreshIcon size={14} />
                {t('settings.web.https.retry')}
              </Button>
            </div>
          )}
          {view === 'failed' && !failedStep && https?.lastError && (
            <Notice tone="error" text={https.lastError} />
          )}
        </div>
      )}

      {/* ── Let's Encrypt: active ───────────────────────────────────────────── */}
      {mode === 'acme' && view === 'active' && https && (
        <div className="flex flex-col gap-4">
          <dl className="grid grid-cols-2 gap-x-6 gap-y-3 max-sm:grid-cols-1">
            <Row
              label={t('settings.web.https.cert.identifier')}
              value={https.identifier ?? '—'}
              mono
            />
            <Row label={t('settings.web.https.cert.issuer')} value={cert?.issuer ?? '—'} />
            <Row label={t('settings.web.https.cert.serial')} value={cert?.serial ?? '—'} mono />
            <Row
              label={t('settings.web.https.cert.sans')}
              value={cert?.sans.join(', ') || '—'}
              mono
            />
            <Row
              label={t('settings.web.https.cert.fingerprint')}
              value={cert?.fingerprint256 ?? '—'}
              mono
            />
            <Row label={t('settings.web.https.cert.notBefore')} value={fmtDate(cert?.notBefore)} />
            <Row
              label={t('settings.web.https.cert.notAfter')}
              value={`${fmtDate(cert?.notAfter)}${https.hoursRemaining !== null ? ` · ${t('settings.web.https.cert.hoursLeft', { hours: https.hoursRemaining })}` : ''}`}
            />
            <Row
              label={t('settings.web.https.cert.lastRenewal')}
              value={
                https.lastRenewalAt
                  ? fmtDate(https.lastRenewalAt)
                  : t('settings.web.https.cert.never')
              }
            />
            <Row
              label={t('settings.web.https.cert.nextCheck')}
              value={fmtDate(https.nextCheckAt)}
            />
            <Row
              label={t('settings.web.https.cert.listeners')}
              value={`https ${https.listeners.https ?? '—'} · http ${https.listeners.http ?? '—'} · app ${https.listeners.app ?? '—'}`}
              mono
            />
          </dl>
          {https.lastError && <Notice tone="warning" text={https.lastError} />}
          {tls?.source && tls.source !== 'acme' && (
            <Notice tone="warning" text={t('settings.web.https.fallback')} />
          )}

          {secureChecks.length > 0 && (
            <div className="border-border bg-bg/40 flex flex-col gap-2 rounded-xl border p-3">
              <span className="text-fg text-xs font-medium">
                {t('settings.web.https.secure.title')}
              </span>
              <ul className="flex flex-wrap gap-x-5 gap-y-1">
                {secureChecks.map((c) => (
                  <li key={c.key} className="flex items-center gap-1.5 text-xs">
                    {c.ok ? (
                      <CheckmarkCircle02Icon size={14} className="text-emerald-500" />
                    ) : (
                      <AlertCircleIcon size={14} className="text-rose-500" />
                    )}
                    <span className={c.ok ? 'text-fg' : 'text-muted'}>
                      {t(`settings.web.https.secure.${c.key}`)}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div className="flex flex-col gap-2">
            <span className="text-fg text-xs font-medium">
              {t('settings.web.https.history.title')}
            </span>
            {https.history.length === 0 ? (
              <p className="text-muted text-xs">{t('settings.web.https.history.empty')}</p>
            ) : (
              <div className="border-border max-h-56 overflow-auto rounded-xl border">
                <table className="w-full text-start text-xs">
                  <thead className="text-muted sticky top-0 bg-surface">
                    <tr>
                      <th className="px-3 py-2 text-start font-medium">
                        {t('settings.web.https.history.when')}
                      </th>
                      <th className="px-3 py-2 text-start font-medium">
                        {t('settings.web.https.history.outcome')}
                      </th>
                      <th className="px-3 py-2 text-start font-medium">
                        {t('settings.web.https.history.duration')}
                      </th>
                      <th className="px-3 py-2 text-start font-medium">
                        {t('settings.web.https.history.error')}
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {[...https.history].reverse().map((a) => (
                      <tr key={a.at} className="border-border border-t">
                        <td className="px-3 py-1.5 whitespace-nowrap">{fmtDate(a.at)}</td>
                        <td
                          className={cn(
                            'px-3 py-1.5',
                            a.outcome === 'failed'
                              ? 'text-rose-600 dark:text-rose-400'
                              : 'text-emerald-600 dark:text-emerald-400'
                          )}
                        >
                          {t(`settings.web.https.outcome.${a.outcome}`)}
                        </td>
                        <td className="px-3 py-1.5 whitespace-nowrap">
                          {(a.durationMs / 1000).toFixed(1)}s
                        </td>
                        <td className="text-muted px-3 py-1.5 wrap-anywhere">{a.error ?? ''}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          <div className="flex flex-wrap justify-end gap-2">
            {https.identifier && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  const host = https.identifier!.includes(':')
                    ? `[${https.identifier}]`
                    : https.identifier!
                  const port = https.listeners.https ?? 443
                  const url = `https://${host}${port === 443 ? '' : `:${port}`}`
                  if (isWeb) location.assign(url)
                  else void window.api.browser.openExternal(url)
                }}
              >
                <LinkSquare02Icon size={14} />
                {t('settings.web.https.open')}
              </Button>
            )}
            <Button
              variant="outline"
              size="sm"
              disabled={renewing || busy !== null || !status?.listening}
              onClick={() => void renew()}
            >
              <RefreshIcon size={14} />
              {renewing ? t('settings.web.https.renewing') : t('settings.web.https.renew')}
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={restarting}
              onClick={() => void restart()}
            >
              {restarting ? t('settings.web.https.restarting') : t('settings.web.https.restart')}
            </Button>
            <Button
              variant="danger"
              size="sm"
              disabled={disabling || busy !== null}
              onClick={() => void disable()}
            >
              {t('settings.web.https.disable')}
            </Button>
          </div>
        </div>
      )}

      {/* ── custom files ────────────────────────────────────────────────────── */}
      {mode === 'custom' && (
        <div className="grid grid-cols-2 gap-3 max-sm:grid-cols-1">
          <label className="flex flex-col gap-1">
            <span className="text-muted text-xs">{t('settings.web.https.certPath')}</span>
            <Input
              value={certPath}
              onChange={(e) => setCertPath(e.target.value)}
              placeholder="/etc/ssl/fullchain.pem"
              dir="ltr"
              className="font-mono text-xs"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-muted text-xs">{t('settings.web.https.keyPath')}</span>
            <Input
              value={keyPath}
              onChange={(e) => setKeyPath(e.target.value)}
              placeholder="/etc/ssl/privkey.pem"
              dir="ltr"
              className="font-mono text-xs"
            />
          </label>
        </div>
      )}

      {/* ── what is being served, for the non-ACME modes ───────────────────── */}
      {mode !== 'off' && mode !== 'acme' && tls?.source && (
        <dl className="grid grid-cols-2 gap-x-6 gap-y-3 max-sm:grid-cols-1">
          <Row
            label={t('settings.web.https.serving')}
            value={t(`settings.web.https.sources.${tls.source}`)}
          />
          <Row label={t('settings.web.https.expires')} value={fmtDate(tls.notAfter)} />
          <Row label={t('settings.web.https.issuer')} value={tls.issuer ?? '—'} mono />
          <Row label={t('settings.web.https.names')} value={tls.sans.join(', ') || '—'} mono />
        </dl>
      )}

      {/* ── advanced ────────────────────────────────────────────────────────── */}
      {mode !== 'off' && (
        <div className="flex flex-col gap-3">
          <button
            type="button"
            onClick={() => setAdvanced((a) => !a)}
            aria-expanded={advanced}
            className="text-muted hover:text-fg flex cursor-pointer items-center gap-1.5 self-start text-xs font-medium"
          >
            {advanced ? '▾' : '▸'} {t('settings.web.https.advanced')}
          </button>
          {advanced && (
            <div className="flex flex-col gap-3">
              <div className="grid grid-cols-3 gap-3 max-sm:grid-cols-1">
                <label className="flex flex-col gap-1">
                  <span className="text-muted text-xs">{t('settings.web.https.httpsPort')}</span>
                  <Input
                    inputMode="numeric"
                    value={httpsPort}
                    onChange={(e) => setHttpsPort(e.target.value.replace(/\D/g, ''))}
                    placeholder="443"
                    dir="ltr"
                  />
                </label>
                <label className="flex flex-col gap-1">
                  <span className="text-muted text-xs">{t('settings.web.https.httpPort')}</span>
                  <Input
                    inputMode="numeric"
                    value={httpPort}
                    onChange={(e) => setHttpPort(e.target.value.replace(/\D/g, ''))}
                    placeholder="80"
                    dir="ltr"
                  />
                </label>
                <label className="flex flex-col gap-1">
                  <span className="text-muted text-xs">{t('settings.web.https.email')}</span>
                  <Input
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="you@example.com"
                    dir="ltr"
                  />
                </label>
              </div>
              <p className="text-muted text-xs leading-relaxed">
                {t('settings.web.https.httpPortHint')}
              </p>
              <div className="flex justify-end">
                <Button
                  size="sm"
                  disabled={
                    !advancedDirty ||
                    !validPort(num(httpPort)) ||
                    !validPort(num(httpsPort)) ||
                    busy !== null ||
                    running
                  }
                  onClick={applyAdvanced}
                >
                  {t('settings.web.https.apply')}
                </Button>
              </div>
            </div>
          )}
        </div>
      )}
      {mode === 'custom' && !advanced && advancedDirty && (
        <div className="flex justify-end">
          <Button size="sm" disabled={busy !== null} onClick={applyAdvanced}>
            {t('settings.web.https.apply')}
          </Button>
        </div>
      )}
    </section>
  )
}
