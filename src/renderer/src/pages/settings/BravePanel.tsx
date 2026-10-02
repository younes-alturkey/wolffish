import { Button } from '@components/core/Button'
import { Input } from '@components/core/Input'
import { useToast } from '@components/core/toast/useToast'
import { cn } from '@lib/utils/cn'
import { PanelBackChevron } from '@pages/settings/drillNav'
import type { BraveErrorKind, BraveStatus } from '@preload/index'
import { EyeIcon, LinkSquare02Icon, ViewOffIcon } from 'hugeicons-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Trans, useTranslation } from 'react-i18next'

const BRAVE_API_URL = 'https://api.search.brave.com'

const TRANS_COMPONENTS = {
  link: (
    <a
      href={BRAVE_API_URL}
      target="_blank"
      rel="noreferrer"
      onClick={(e) => {
        e.preventDefault()
        window.open(BRAVE_API_URL, '_blank', 'noopener,noreferrer')
      }}
      className="text-accent hover:underline"
    />
  )
}

const STATUS_DOT: Record<BraveStatus['status'], string> = {
  configured: 'bg-emerald-500',
  error: 'bg-rose-500',
  disabled: 'bg-border'
}

export function BravePanel(): React.JSX.Element {
  const { t } = useTranslation()
  const toast = useToast()

  // null while loading — same single-paint pattern TelegramPanel uses to
  // avoid flicker when the toggle resolves from "guess" to actual value.
  const [enabled, setEnabled] = useState<boolean | null>(null)
  const [apiKey, setApiKey] = useState('')
  // Last persisted key, so the Test/save button can disable when the input
  // matches what's already saved (no change to apply).
  const [savedApiKey, setSavedApiKey] = useState('')
  const [hasSavedKey, setHasSavedKey] = useState(false)
  const [keyVisible, setKeyVisible] = useState(false)
  const [status, setStatus] = useState<BraveStatus>({
    status: 'disabled',
    errorKind: null,
    error: null
  })
  const [busy, setBusy] = useState<'idle' | 'saving' | 'testing'>('idle')
  const [validation, setValidation] = useState<string | null>(null)

  // True from the first keystroke that diverges the input until a save (or a
  // seed) realigns it — the remote-change listener below must never overwrite
  // a key mid-typing, and an event callback cannot read fresh state.
  const apiKeyDirtyRef = useRef(false)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      const cfg = await window.api.brave.getConfig()
      const live = await window.api.brave.status()
      if (cancelled) return
      setApiKey(cfg.apiKey)
      setSavedApiKey(cfg.apiKey)
      setHasSavedKey(cfg.apiKey.length > 0)
      setStatus(live)
      setEnabled(cfg.enabled)
      apiKeyDirtyRef.current = false
    })()
    return () => {
      cancelled = true
    }
  }, [])

  // The paired phone (or another window) saved Brave settings: re-seed the
  // toggle, status and saved-key markers; the input itself only when the user
  // is not mid-edit.
  useEffect(
    () =>
      window.api.services.onChanged((payload) => {
        if (payload.service !== 'brave') return
        void (async () => {
          const [cfg, live] = await Promise.all([
            window.api.brave.getConfig(),
            window.api.brave.status()
          ])
          setEnabled(cfg.enabled)
          setStatus(live)
          setSavedApiKey(cfg.apiKey)
          setHasSavedKey(cfg.apiKey.length > 0)
          if (!apiKeyDirtyRef.current) setApiKey(cfg.apiKey)
        })()
      }),
    []
  )

  const handleToggle = useCallback(async (value: boolean) => {
    setEnabled(value)
    const response = await window.api.brave.setConfig({ enabled: value })
    setStatus(response.status)
  }, [])

  const translateError = useCallback(
    (kind: BraveErrorKind, message?: string | null): string => {
      if (kind === 'unknown') {
        return t('settings.services.brave.errors.unknown', { message: message ?? '' })
      }
      return t(`settings.services.brave.errors.${kind}`)
    },
    [t]
  )

  // Plain persist — stores the key without spending quota on a live query.
  // Lets the user save (and then enable) a key they trust, or keep editing
  // before verifying. Test connection is the explicit verify-and-connect path.
  const handleSave = useCallback(async () => {
    if (apiKey.trim().length === 0) {
      setValidation(t('settings.services.brave.validation.keyRequired'))
      return
    }
    setValidation(null)
    setBusy('saving')
    try {
      const response = await window.api.brave.setConfig({ apiKey: apiKey.trim() })
      setStatus(response.status)
      setHasSavedKey(true)
      setSavedApiKey(apiKey.trim())
      apiKeyDirtyRef.current = false
      toast.show({ message: t('settings.services.brave.saveSuccess'), tone: 'success' })
    } finally {
      setBusy('idle')
    }
  }, [apiKey, t, toast])

  const handleTest = useCallback(async () => {
    if (apiKey.trim().length === 0) {
      setValidation(t('settings.services.brave.validation.keyRequired'))
      return
    }
    setValidation(null)
    setBusy('testing')
    try {
      const result = await window.api.brave.test(apiKey.trim())
      if (result.ok) {
        const response = await window.api.brave.setConfig({
          enabled: true,
          apiKey: apiKey.trim()
        })
        setStatus(response.status)
        setEnabled(true)
        setHasSavedKey(true)
        setSavedApiKey(apiKey.trim())
        apiKeyDirtyRef.current = false
        toast.show({
          message: t('settings.services.brave.testSuccess', { count: result.resultsCount }),
          tone: 'success'
        })
      } else {
        toast.show({
          message: t('settings.services.brave.testFailure', {
            message: translateError(result.kind, result.message)
          }),
          tone: 'error'
        })
        const live = await window.api.brave.status()
        setStatus(live)
      }
    } finally {
      setBusy('idle')
    }
  }, [apiKey, t, toast, translateError])

  const statusLabel = useMemo(
    () => t(`settings.services.brave.status.${status.status}`),
    [status, t]
  )
  const statusErrorText = useMemo(() => {
    if (status.errorKind) return translateError(status.errorKind, status.error)
    if (status.error) return status.error
    return null
  }, [status, translateError])

  const toggleOptions = useMemo(
    () => [
      { value: false, label: t('settings.services.brave.toggle.off') },
      { value: true, label: t('settings.services.brave.toggle.on') }
    ],
    [t]
  )

  return (
    <div className="flex min-h-full w-full items-start justify-center px-6 py-10">
      <div className="flex w-full max-w-2xl flex-col gap-6">
        <header className="flex flex-col gap-2">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-1.5">
              <PanelBackChevron />
              <h1 className="text-fg text-2xl font-semibold tracking-tight">
                {t('settings.services.brave.title')}
              </h1>
            </div>
            <a
              href={BRAVE_API_URL}
              target="_blank"
              rel="noopener noreferrer"
              className={cn(
                'text-muted hover:text-fg flex items-center gap-1.5 text-xs',
                'focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg rounded-md px-1.5 py-1'
              )}
            >
              <span>{t('settings.services.brave.platform')}</span>
              <LinkSquare02Icon size={13} className="shrink-0" />
            </a>
          </div>
          <p className="text-muted text-sm leading-relaxed">
            {t('settings.services.brave.subtitle')}
          </p>
        </header>

        <section className="bg-surface border-border flex flex-col gap-5 rounded-2xl border p-6">
          <div className="flex items-center justify-between gap-4">
            <div className="flex flex-col gap-1">
              <span className="text-fg text-sm font-medium">
                {t('settings.services.brave.enable')}
              </span>
              <p className="text-muted text-xs">{t('settings.services.brave.enableDescription')}</p>
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
                  const cantEnable = opt.value && !hasSavedKey
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
                {t('settings.services.brave.status.label')}
              </span>
              <div className="flex items-center gap-2">
                <span
                  aria-hidden="true"
                  className={cn('h-2 w-2 rounded-full', STATUS_DOT[status.status])}
                />
                <span className="text-fg text-sm">{statusLabel}</span>
              </div>
            </div>
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

          <div className="flex flex-col gap-1.5">
            <label htmlFor="brave-api-key" className="text-muted text-sm font-medium">
              {t('settings.services.brave.apiKey')}
            </label>
            <div className="relative w-full">
              <Input
                id="brave-api-key"
                type={keyVisible ? 'text' : 'password'}
                value={apiKey}
                onChange={(e) => {
                  apiKeyDirtyRef.current = true
                  setApiKey(e.target.value)
                }}
                placeholder={t('settings.services.brave.apiKeyPlaceholder')}
                autoComplete="off"
                spellCheck={false}
                className="pe-10 font-mono"
              />
              <button
                type="button"
                onClick={() => setKeyVisible((v) => !v)}
                aria-label={t(
                  keyVisible ? 'settings.services.brave.hideKey' : 'settings.services.brave.showKey'
                )}
                className={cn(
                  'text-muted hover:text-fg absolute inset-e-2 top-1/2 -translate-y-1/2',
                  'flex h-8 w-8 cursor-pointer items-center justify-center rounded-md',
                  'focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg'
                )}
              >
                {keyVisible ? <ViewOffIcon size={16} /> : <EyeIcon size={16} />}
              </button>
            </div>
            <p className="text-muted text-xs">
              <Trans i18nKey="settings.services.brave.apiKeyHint" components={TRANS_COMPONENTS} />
            </p>
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
              onClick={() => void handleSave()}
              disabled={
                busy !== 'idle' ||
                apiKey.trim().length === 0 ||
                apiKey.trim() === savedApiKey.trim()
              }
            >
              {t('settings.services.brave.save')}
            </Button>
            <button
              type="button"
              disabled={busy !== 'idle' || apiKey.trim().length === 0}
              onClick={() => void handleTest()}
              className={cn(
                'text-xs font-medium capitalize',
                busy === 'testing'
                  ? 'text-muted animate-pulse cursor-wait'
                  : busy !== 'idle' || apiKey.trim().length === 0
                    ? 'text-muted cursor-not-allowed'
                    : 'text-primary hover:text-primary/80 cursor-pointer'
              )}
            >
              {t('settings.services.brave.testConnection')}
            </button>
          </div>

          <p className="text-muted text-xs">{t('settings.services.brave.testHint')}</p>
        </section>

        <HowItWorksSection />
      </div>
    </div>
  )
}

function HowItWorksSection(): React.JSX.Element {
  const { t } = useTranslation()
  const points: string[] = [
    t('settings.services.brave.howItWorks.primary'),
    t('settings.services.brave.howItWorks.fallback'),
    t('settings.services.brave.howItWorks.free'),
    t('settings.services.brave.howItWorks.paid'),
    t('settings.services.brave.howItWorks.privacy')
  ]
  return (
    <section className="bg-surface border-border flex flex-col gap-3 rounded-2xl border p-6">
      <header className="flex flex-col gap-1">
        <h2 className="text-fg text-sm font-medium">
          {t('settings.services.brave.howItWorksTitle')}
        </h2>
      </header>
      <ul className="text-muted flex flex-col gap-1.5 text-xs leading-relaxed">
        {points.map((line, i) => (
          <li key={i} className="flex gap-2">
            <span aria-hidden="true">•</span>
            <span>{line}</span>
          </li>
        ))}
      </ul>
    </section>
  )
}
