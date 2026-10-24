import { Button } from '@components/core/Button'
import { DeepSeekLogo } from '@components/core/ProviderLogos'
import { Input } from '@components/core/Input'
import { useToast } from '@components/core/toast/useToast'
import { cn } from '@lib/utils/cn'
import { getCachedWebTools } from '@pages/settings/webToolsSnapshot'
import type {
  DeepSeekSearchConfig,
  DeepSeekSearchErrorKind,
  DeepSeekSearchStatus
} from '@preload/index'
import {
  ArrowDown01Icon,
  ArrowUp01Icon,
  EyeIcon,
  LinkSquare02Icon,
  ViewOffIcon
} from 'hugeicons-react'
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Trans, useTranslation } from 'react-i18next'

const DEEPSEEK_PLATFORM_URL = 'https://platform.deepseek.com/api_keys'

export type EngineState = 'active' | 'off' | 'error'

const STATE_DOT: Record<EngineState, string> = {
  active: 'bg-emerald-500',
  error: 'bg-rose-500',
  off: 'bg-border'
}

function openExternal(url: string): void {
  window.open(url, '_blank', 'noopener,noreferrer')
}

export function ExternalLink({
  href,
  children
}: {
  href: string
  children: ReactNode
}): React.JSX.Element {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      onClick={(e) => {
        e.preventDefault()
        openExternal(href)
      }}
      className={cn(
        'text-muted hover:text-fg flex shrink-0 items-center gap-1.5 text-xs',
        'focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg rounded-md px-1.5 py-1'
      )}
    >
      <span>{children}</span>
      <LinkSquare02Icon size={13} className="shrink-0" />
    </a>
  )
}

/** Logo + name + one-line description at the top of an engine card. */
export function EngineCardHeader({
  icon,
  title,
  description,
  action
}: {
  icon: ReactNode
  title: string
  description: string
  action?: ReactNode
}): React.JSX.Element {
  return (
    <div className="flex items-start justify-between gap-3">
      <div className="flex min-w-0 flex-col gap-1">
        <div className="flex items-center gap-2">
          <span className="text-fg flex h-4 w-4 shrink-0 items-center justify-center">{icon}</span>
          <h2 className="text-fg text-sm font-medium">{title}</h2>
        </div>
        <p className="text-muted text-xs leading-relaxed">{description}</p>
      </div>
      {action}
    </div>
  )
}

export function OnOffToggle({
  value,
  onChange,
  disableOn = false
}: {
  value: boolean | null
  onChange: (value: boolean) => void
  /** Off stays reachable; On waits for a saved key. */
  disableOn?: boolean
}): React.JSX.Element {
  const { t } = useTranslation()
  if (value === null) {
    return (
      <div
        aria-hidden="true"
        className="bg-border/30 h-7 w-19.5 shrink-0 animate-pulse rounded-lg"
      />
    )
  }
  const options = [
    { value: false, label: t('settings.services.brave.toggle.off') },
    { value: true, label: t('settings.services.brave.toggle.on') }
  ]
  return (
    <div
      role="tablist"
      className="border-border bg-bg/40 inline-flex shrink-0 items-center rounded-lg border p-0.5"
    >
      {options.map((opt) => {
        const active = opt.value === value
        const blocked = opt.value && disableOn
        return (
          <button
            key={String(opt.value)}
            role="tab"
            type="button"
            aria-selected={active}
            disabled={blocked}
            onClick={() => onChange(opt.value)}
            className={cn(
              'rounded-md px-3 py-1 text-xs font-medium',
              'focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg',
              blocked
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
  )
}

export function ToggleRow({
  label,
  description,
  children
}: {
  label: string
  description: string
  children: ReactNode
}): React.JSX.Element {
  return (
    <div className="flex items-center justify-between gap-4">
      <div className="flex flex-col gap-1">
        <span className="text-fg text-sm font-medium">{label}</span>
        <p className="text-muted text-xs">{description}</p>
      </div>
      {children}
    </div>
  )
}

export function StatusRow({
  state,
  label,
  errorText
}: {
  state: EngineState
  label: string
  errorText: string | null
}): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-3">
        <span className="text-muted text-xs font-medium uppercase tracking-wider">
          {t('settings.services.brave.status.label')}
        </span>
        <div className="flex items-center gap-2">
          <span aria-hidden="true" className={cn('h-2 w-2 rounded-full', STATE_DOT[state])} />
          <span className="text-fg text-sm">{label}</span>
        </div>
      </div>
      {errorText && (
        <pre
          className={cn(
            'bg-bg/40 border-border rounded-md border px-3 py-2',
            'text-xs whitespace-pre-wrap wrap-break-word font-mono text-rose-500'
          )}
        >
          {errorText}
        </pre>
      )}
    </div>
  )
}

export function SecretKeyInput({
  id,
  label,
  value,
  placeholder,
  hint,
  onChange
}: {
  id: string
  label: string
  value: string
  placeholder: string
  hint: ReactNode
  onChange: (value: string) => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const [visible, setVisible] = useState(false)
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-muted text-sm font-medium">
        {label}
      </label>
      <div className="relative w-full">
        <Input
          id={id}
          type={visible ? 'text' : 'password'}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          autoComplete="off"
          spellCheck={false}
          className="pe-10 font-mono"
        />
        <button
          type="button"
          onClick={() => setVisible((v) => !v)}
          aria-label={t(
            visible ? 'settings.services.brave.hideKey' : 'settings.services.brave.showKey'
          )}
          className={cn(
            'text-muted hover:text-fg absolute inset-e-2 top-1/2 -translate-y-1/2',
            'flex h-8 w-8 cursor-pointer items-center justify-center rounded-md',
            'focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg'
          )}
        >
          {visible ? <ViewOffIcon size={16} /> : <EyeIcon size={16} />}
        </button>
      </div>
      <p className="text-muted text-xs">{hint}</p>
    </div>
  )
}

/** Save button on the left, the quieter Test link on the right. */
export function KeyActions({
  saveDisabled,
  testDisabled,
  testing,
  onSave,
  onTest
}: {
  saveDisabled: boolean
  testDisabled: boolean
  testing: boolean
  onSave: () => void
  onTest: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <div className="flex items-center justify-between gap-2">
      <Button type="button" onClick={onSave} disabled={saveDisabled}>
        {t('settings.services.brave.save')}
      </Button>
      <button
        type="button"
        disabled={testDisabled}
        onClick={onTest}
        className={cn(
          'text-xs font-medium capitalize',
          testing
            ? 'text-muted animate-pulse cursor-wait'
            : testDisabled
              ? 'text-muted cursor-not-allowed'
              : 'text-primary hover:text-primary/80 cursor-pointer'
        )}
      >
        {t('settings.services.brave.testConnection')}
      </button>
    </div>
  )
}

export function Divider(): React.JSX.Element {
  return <div className="border-border/60 border-t" />
}

export type OrderedEngine<T extends string> = {
  id: T
  label: string
  icon: ReactNode
  state: EngineState
  stateLabel: string
}

/**
 * The user's engine priority. Up/down buttons rather than drag: the list is
 * two or three rows, and buttons work the same with a keyboard, a screen
 * reader and the Web UI on a phone.
 */
export function EngineOrderCard<T extends string>({
  title,
  description,
  engines,
  rows,
  onReorder
}: {
  title: string
  description: string
  engines: OrderedEngine<T>[] | null
  /** How many engines the list holds, so the cold-start skeleton matches its height. */
  rows: number
  onReorder: (order: T[]) => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const move = (index: number, delta: number): void => {
    if (!engines) return
    const target = index + delta
    if (target < 0 || target >= engines.length) return
    const next = engines.map((e) => e.id)
    ;[next[index], next[target]] = [next[target], next[index]]
    onReorder(next)
  }
  return (
    <section className="bg-surface border-border flex flex-col gap-4 rounded-2xl border p-6">
      <header className="flex flex-col gap-1">
        <h2 className="text-fg text-sm font-medium">{title}</h2>
        <p className="text-muted text-xs leading-relaxed">{description}</p>
      </header>
      <ol className="flex flex-col gap-2">
        {engines === null
          ? Array.from({ length: rows }, (_, i) => (
              <li
                key={i}
                aria-hidden="true"
                className="bg-border/30 h-11 animate-pulse rounded-xl"
              />
            ))
          : engines.map((engine, index) => (
              <li
                key={engine.id}
                className="border-border bg-bg/40 flex items-center gap-3 rounded-xl border px-3 py-2"
              >
                <span className="text-muted w-4 text-center text-xs font-medium tabular-nums">
                  {index + 1}
                </span>
                <span className="text-fg flex h-4 w-4 shrink-0 items-center justify-center">
                  {engine.icon}
                </span>
                <span className="text-fg min-w-0 flex-1 truncate text-sm">{engine.label}</span>
                <span className="flex items-center gap-1.5">
                  <span
                    aria-hidden="true"
                    className={cn('h-1.5 w-1.5 rounded-full', STATE_DOT[engine.state])}
                  />
                  <span className="text-muted text-xs">{engine.stateLabel}</span>
                </span>
                <span className="flex items-center">
                  {[
                    {
                      delta: -1,
                      Icon: ArrowUp01Icon,
                      label: t('settings.services.webTools.moveUp')
                    },
                    {
                      delta: 1,
                      Icon: ArrowDown01Icon,
                      label: t('settings.services.webTools.moveDown')
                    }
                  ].map(({ delta, Icon, label }) => {
                    const disabled = index + delta < 0 || index + delta >= engines.length
                    return (
                      <button
                        key={delta}
                        type="button"
                        disabled={disabled}
                        onClick={() => move(index, delta)}
                        aria-label={`${label}: ${engine.label}`}
                        className={cn(
                          'flex h-7 w-7 items-center justify-center rounded-md',
                          'focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg',
                          disabled
                            ? 'text-muted/30 cursor-not-allowed'
                            : 'text-muted hover:text-fg hover:bg-border/40 cursor-pointer'
                        )}
                      >
                        <Icon size={14} />
                      </button>
                    )
                  })}
                </span>
              </li>
            ))}
      </ol>
    </section>
  )
}

export function HowItWorksCard({ points }: { points: string[] }): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <section className="bg-surface border-border flex flex-col gap-3 rounded-2xl border p-6">
      <h2 className="text-fg text-sm font-medium">
        {t('settings.services.brave.howItWorksTitle')}
      </h2>
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

/**
 * The DeepSeek Search & Fetch card. Both panels render it over the same
 * config record — the key is shared, so saving it on one panel is what the
 * other shows next time — while each panel owns one of the two toggles.
 */
export function DeepSeekSearchCard({
  toggle
}: {
  toggle: 'searchEnabled' | 'fetchEnabled'
}): React.JSX.Element {
  const { t } = useTranslation()
  const toast = useToast()
  const scope = toggle === 'searchEnabled' ? 'search' : 'fetch'

  const [initial] = useState(getCachedWebTools)
  const [config, setConfig] = useState<DeepSeekSearchConfig | null>(initial?.deepseek ?? null)
  const [apiKey, setApiKey] = useState(initial?.deepseek.apiKey ?? '')
  const [status, setStatus] = useState<DeepSeekSearchStatus>(
    initial?.deepseekStatus ?? { status: 'disabled', errorKind: null, error: null }
  )
  const [busy, setBusy] = useState<'idle' | 'saving' | 'testing'>('idle')
  const [validation, setValidation] = useState<string | null>(null)
  // Never overwrite a key mid-typing when another surface saves.
  const apiKeyDirtyRef = useRef(false)

  useEffect(() => {
    let cancelled = false
    const reseed = async (): Promise<void> => {
      const [cfg, live] = await Promise.all([
        window.api.deepseekSearch.getConfig(),
        window.api.deepseekSearch.status()
      ])
      if (cancelled) return
      setConfig(cfg)
      setStatus(live)
      if (!apiKeyDirtyRef.current) setApiKey(cfg.apiKey)
    }
    void (async () => reseed())()
    const unsubscribe = window.api.services.onChanged((payload) => {
      if (payload.service === 'deepseekSearch') void reseed()
    })
    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [])

  const enabled = config ? config[toggle] : null
  const savedKey = config?.apiKey ?? ''
  const trimmed = apiKey.trim()

  const translateError = useCallback(
    (kind: DeepSeekSearchErrorKind, message?: string | null): string =>
      kind === 'unknown'
        ? t('settings.services.deepseekSearch.errors.unknown', { message: message ?? '' })
        : t(`settings.services.deepseekSearch.errors.${kind}`),
    [t]
  )

  const persist = useCallback(async (patch: Partial<DeepSeekSearchConfig>) => {
    const response = await window.api.deepseekSearch.setConfig(patch)
    setConfig(response.config)
    setStatus(response.status)
    return response
  }, [])

  const handleSave = useCallback(async () => {
    if (!trimmed) {
      setValidation(t('settings.services.brave.validation.keyRequired'))
      return
    }
    setValidation(null)
    setBusy('saving')
    try {
      await persist({ apiKey: trimmed })
      apiKeyDirtyRef.current = false
      toast.show({ message: t('settings.services.deepseekSearch.saveSuccess'), tone: 'success' })
    } finally {
      setBusy('idle')
    }
  }, [persist, t, toast, trimmed])

  const handleTest = useCallback(async () => {
    if (!trimmed) {
      setValidation(t('settings.services.brave.validation.keyRequired'))
      return
    }
    setValidation(null)
    setBusy('testing')
    try {
      const result = await window.api.deepseekSearch.test(trimmed)
      if (result.ok) {
        // A passing test saves the key and switches on this panel's half —
        // the other half stays as the user left it.
        await persist({ apiKey: trimmed, [toggle]: true })
        apiKeyDirtyRef.current = false
        toast.show({ message: t('settings.services.deepseekSearch.testSuccess'), tone: 'success' })
      } else {
        toast.show({
          message: t('settings.services.brave.testFailure', {
            message: translateError(result.kind, result.message)
          }),
          tone: 'error'
        })
        setStatus(await window.api.deepseekSearch.status())
      }
    } finally {
      setBusy('idle')
    }
  }, [persist, t, toast, toggle, translateError, trimmed])

  // Status is per panel: the shared service says "configured" when either
  // half is on, but this card is only active when its own half is.
  const state: EngineState =
    status.status === 'error' && enabled ? 'error' : enabled && savedKey ? 'active' : 'off'
  const statusLabel = t(
    `settings.services.brave.status.${state === 'active' ? 'configured' : state === 'error' ? 'error' : 'disabled'}`
  )
  const errorText = useMemo(
    () =>
      state === 'error' && status.errorKind ? translateError(status.errorKind, status.error) : null,
    [state, status, translateError]
  )

  return (
    <section className="bg-surface border-border flex flex-col gap-5 rounded-2xl border p-6">
      <EngineCardHeader
        icon={<DeepSeekLogo size={16} />}
        title={t(`settings.services.deepseekSearch.${scope}.title`)}
        description={t(`settings.services.deepseekSearch.${scope}.description`)}
        action={
          <ExternalLink href={DEEPSEEK_PLATFORM_URL}>
            {t('settings.services.brave.platform')}
          </ExternalLink>
        }
      />

      <ToggleRow
        label={t(`settings.services.deepseekSearch.${scope}.enable`)}
        description={t(`settings.services.deepseekSearch.${scope}.enableDescription`)}
      >
        <OnOffToggle
          value={enabled}
          disableOn={!savedKey}
          onChange={(value) => void persist({ [toggle]: value })}
        />
      </ToggleRow>

      <Divider />
      <StatusRow state={state} label={statusLabel} errorText={errorText} />
      <Divider />

      <SecretKeyInput
        id={`deepseek-search-key-${scope}`}
        label={t('settings.services.deepseekSearch.apiKey')}
        value={apiKey}
        placeholder="sk-…"
        onChange={(value) => {
          apiKeyDirtyRef.current = true
          setApiKey(value)
        }}
        hint={
          <Trans
            i18nKey="settings.services.deepseekSearch.apiKeyHint"
            components={{
              link: (
                <a
                  href={DEEPSEEK_PLATFORM_URL}
                  onClick={(e) => {
                    e.preventDefault()
                    openExternal(DEEPSEEK_PLATFORM_URL)
                  }}
                  className="text-accent hover:underline"
                />
              )
            }}
          />
        }
      />

      {validation && (
        <p className="text-rose-500 text-xs" role="alert">
          {validation}
        </p>
      )}

      <Divider />
      <KeyActions
        saveDisabled={busy !== 'idle' || !trimmed || trimmed === savedKey.trim()}
        testDisabled={busy !== 'idle' || !trimmed}
        testing={busy === 'testing'}
        onSave={() => void handleSave()}
        onTest={() => void handleTest()}
      />
      <p className="text-muted text-xs">{t('settings.services.deepseekSearch.testHint')}</p>
    </section>
  )
}
