import { Button } from '@components/core/Button'
import { Input } from '@components/core/Input'
import { useToast } from '@components/core/toast/useToast'
import { cn } from '@lib/utils/cn'
import { PanelBackChevron } from '@pages/settings/drillNav'
import {
  BADGE_STYLES,
  DEFAULT_MODEL,
  isModelDisabled,
  MODEL_SPECS,
  PROVIDER_LOGOS,
  sortOpenRouterModelIds,
  sortOpenRouterModels,
  type ModelSpec
} from '@pages/settings/modelCatalog'
import type { CloudProviderConfig, ProviderListEntry, ProviderTestResult } from '@preload/index'
import {
  AlertCircleIcon,
  CheckmarkCircle02Icon,
  EyeIcon,
  InformationCircleIcon,
  LinkSquare02Icon,
  Loading02Icon,
  ViewOffIcon
} from 'hugeicons-react'
import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'

type ProviderId = CloudProviderConfig['id']
type Status = 'untested' | 'testing' | 'invalid'

const PROVIDER_URLS: Record<ProviderId, string> = {
  anthropic: 'https://console.anthropic.com',
  openai: 'https://platform.openai.com',
  openrouter: 'https://openrouter.ai',
  deepseek: 'https://platform.deepseek.com',
  mimo: 'https://platform.xiaomimimo.com',
  kimi: 'https://platform.moonshot.ai',
  minimax: 'https://platform.minimax.io',
  xai: 'https://console.x.ai',
  qwen: 'https://www.qwencloud.com',
  stepfun: 'https://platform.stepfun.ai',
  zai: 'https://z.ai/manage-apikey/apikey-list'
}

export function CloudProviderPanel({ provider }: { provider: ProviderId }): React.JSX.Element {
  const { t } = useTranslation()
  const toast = useToast()
  const providerLabel = t(`settings.model.providers.${provider}`)
  const Logo = PROVIDER_LOGOS[provider]

  const [stored, setStored] = useState<ProviderListEntry | null>(null)
  const [apiKey, setApiKey] = useState('')
  const [revealKey, setRevealKey] = useState(false)
  // Fresh result from the most recent successful Test. Takes precedence over
  // stored.models because the user just verified this list.
  const [fetchedModels, setFetchedModels] = useState<string[] | null>(null)
  const [model, setModel] = useState<string | null>(null)
  const [status, setStatus] = useState<Status>('untested')
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  // Set when the silent on-mount refresh finds the stored key has been
  // rejected by the provider (revoked, regenerated, expired). Cleared as
  // soon as the user starts typing a replacement.
  const [keyInvalid, setKeyInvalid] = useState(false)
  type ReloadSnapshot = {
    match: ProviderListEntry | null
  }

  // Pure read: callers are responsible for committing the snapshot to
  // state. Keeps setState out of effect bodies.
  const reloadStored = async (): Promise<ReloadSnapshot> => {
    const entries = await window.api.provider.list()
    return { match: entries.find((e) => e.id === provider) ?? null }
  }

  // The component remounts per provider tab (TabPanel returns null when
  // inactive), so we only need to read disk state on mount. We also kick
  // off a silent re-validation of the stored key — if the provider rejects
  // it (revoked, expired), the alert banner above tells the user to fix it.
  useEffect(() => {
    let cancelled = false
    void reloadStored().then((snap) => {
      if (cancelled) return
      setStored(snap.match)
      setModel(snap.match?.model ?? null)
      setApiKey(snap.match?.apiKey ?? '')
      if (!snap.match) return
      void window.api.provider.test({ id: provider }).then((result) => {
        if (cancelled) return
        if (!result.ok && result.kind === 'invalid_key') setKeyInvalid(true)
      })
    })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [provider])

  // Background startup refresh updates the cached model list. If settings is
  // open at that moment, pick up the new catalogue without making the user
  // retest.
  useEffect(() => {
    const off = window.api.provider.onUpdated((event) => {
      if (event.id !== provider) return
      void reloadStored().then((snap) => {
        setStored(snap.match)
        // Don't clobber an unsaved model selection — only sync if the user
        // hasn't picked anything yet.
        setModel((current) => current ?? snap.match?.model ?? null)
      })
    })
    return off
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [provider])

  const trimmedKey = apiKey.trim()
  const models = useMemo<readonly string[]>(() => {
    const raw = fetchedModels ?? stored?.models ?? []
    return provider === 'openrouter' ? sortOpenRouterModelIds(raw) : raw
  }, [fetchedModels, stored, provider])
  const hasModels = models.length > 0
  // Pre-filled saved key isn't a "new" key — only the user typing
  // something different counts as an edit.
  const enteringNewKey = trimmedKey.length > 0 && trimmedKey !== stored?.apiKey

  // enteringNewKey already requires a non-empty key that differs from the
  // saved one, so Test stays disabled until the user actually changes the key.
  const canTest = !saving && status !== 'testing' && enteringNewKey
  const canRemove = stored !== null && !saving

  const showKeyWorksToast = (): void => {
    toast.show({
      tone: 'success',
      message: t('settings.model.cloud.keyWorksToast', { provider: providerLabel })
    })
  }

  const onTest = async (): Promise<void> => {
    if (!canTest) return
    setStatus('testing')
    setError(null)
    const result: ProviderTestResult = await window.api.provider.test({
      id: provider,
      apiKey: enteringNewKey ? trimmedKey : undefined
    })
    if (!result.ok) {
      setStatus('invalid')
      setError(formatTestError(result, providerLabel, t))
      if (result.kind === 'invalid_key') setKeyInvalid(true)
      return
    }
    if (result.models.length === 0) {
      setStatus('invalid')
      setError(t('settings.model.cloud.errors.generic', { message: '' }))
      return
    }
    // Pick the model to save, in strict priority:
    //   1. The model the user already chose (current selection or the one on
    //      disk) — NEVER overwritten as long as the catalogue still offers it.
    //   2. Only when nothing was ever chosen (first connection): this provider's
    //      curated default.
    //   3. Fallback: the newest selectable model.
    // The curated default applies on first connection only — an existing choice
    // always wins.
    const firstSelectable =
      result.models.find((m) => !isModelDisabled(m) && !isDateSnapshot(m)) ??
      result.models.find((m) => !isModelDisabled(m)) ??
      result.models[0]
    const alreadyChosen = model ?? stored?.model ?? null
    const preferred = DEFAULT_MODEL[provider]
    const modelToSave =
      alreadyChosen && result.models.includes(alreadyChosen)
        ? alreadyChosen
        : preferred && result.models.includes(preferred)
          ? preferred
          : firstSelectable
    setSaving(true)
    try {
      await window.api.provider.save({
        id: provider,
        model: modelToSave,
        apiKey: trimmedKey,
        models: result.models,
        reasoningModels: result.reasoningModels
      })
      const snap = await reloadStored()
      setStored(snap.match)
      setModel(modelToSave)
      setApiKey(snap.match?.apiKey ?? '')
      setRevealKey(false)
      setFetchedModels(null)
      setStatus('untested')
      setKeyInvalid(false)
      showKeyWorksToast()
    } finally {
      setSaving(false)
    }
  }

  // Re-verify the already-saved key without re-fetching or re-saving — a
  // simple connection check, mirroring the "Test connection" affordance on
  // the Notion/Brave service panels. Only offered once a key is stored;
  // entering a new key is verified through the primary Save button instead.
  const canTestConnection = !!stored?.apiKey && !enteringNewKey && !saving && status !== 'testing'

  const onTestConnection = async (): Promise<void> => {
    if (!canTestConnection) return
    setStatus('testing')
    setError(null)
    const result: ProviderTestResult = await window.api.provider.test({ id: provider })
    if (!result.ok) {
      const message = formatTestError(result, providerLabel, t)
      setStatus('invalid')
      setError(message)
      if (result.kind === 'invalid_key') setKeyInvalid(true)
      toast.show({ tone: 'error', message: t('settings.model.cloud.errors.generic', { message }) })
      return
    }
    setStatus('untested')
    setKeyInvalid(false)
    showKeyWorksToast()
  }

  const onRemove = async (): Promise<void> => {
    if (!canRemove) return
    setSaving(true)
    try {
      await window.api.provider.remove(provider)
      setStored(null)
      setApiKey('')
      setRevealKey(false)
      setFetchedModels(null)
      setModel(null)
      setStatus('untested')
      setError(null)
      setKeyInvalid(false)
      toast.show({
        tone: 'info',
        message: t('settings.model.cloud.removedToast', { provider: providerLabel })
      })
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="flex min-h-full w-full items-start justify-center px-6 py-10">
      <div className="flex w-full max-w-2xl flex-col gap-6">
        <header className="flex flex-col gap-2">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <PanelBackChevron />
              <Logo size={24} className="text-fg shrink-0" />
              <h1 className="text-fg text-2xl font-semibold tracking-tight">
                {t('settings.model.cloud.title', { provider: providerLabel })}
              </h1>
            </div>
            <a
              href={PROVIDER_URLS[provider]}
              target="_blank"
              rel="noopener noreferrer"
              className={cn(
                'text-muted hover:text-fg flex items-center gap-1.5 text-xs',
                'focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg rounded-md px-1.5 py-1'
              )}
            >
              <span>{t('settings.model.cloud.platform')}</span>
              <LinkSquare02Icon size={13} className="shrink-0" />
            </a>
          </div>
          <p className="text-muted text-sm leading-relaxed">
            {t(`settings.model.providers.descriptions.${provider}`)}
          </p>
        </header>

        {keyInvalid && (
          <div className="flex items-start gap-2 rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-900 dark:border-red-700 dark:bg-red-900/40 dark:text-red-100">
            <AlertCircleIcon size={16} className="mt-0.5 shrink-0" />
            <span>{t('settings.model.cloud.alerts.invalidKey', { provider: providerLabel })}</span>
          </div>
        )}

        <section className="bg-surface border-border flex flex-col gap-5 rounded-2xl border p-6">
          <div className="flex flex-col gap-1.5">
            <label htmlFor={`apikey-${provider}`} className="text-muted text-sm font-medium">
              {t('settings.model.cloud.apiKey')}
            </label>
            <div className="relative">
              <Input
                id={`apikey-${provider}`}
                type={revealKey ? 'text' : 'password'}
                value={apiKey}
                onChange={(e) => {
                  setApiKey(e.target.value)
                  // Any edit invalidates the prior test result and the
                  // freshly fetched catalogue.
                  if (status !== 'untested') {
                    setStatus('untested')
                    setError(null)
                  }
                  if (fetchedModels) setFetchedModels(null)
                  if (keyInvalid) setKeyInvalid(false)
                }}
                placeholder={t('settings.model.cloud.apiKeyPlaceholder', {
                  provider: providerLabel
                })}
                autoComplete="off"
                spellCheck={false}
                className="pe-10"
              />
              <button
                type="button"
                onClick={() => setRevealKey((v) => !v)}
                aria-label={t(
                  revealKey ? 'settings.model.cloud.hideKey' : 'settings.model.cloud.showKey'
                )}
                className={cn(
                  'text-muted hover:text-fg absolute inset-e-2 top-1/2 -translate-y-1/2',
                  'flex h-8 w-8 cursor-pointer items-center justify-center rounded-md',
                  'focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg'
                )}
              >
                {revealKey ? <ViewOffIcon size={16} /> : <EyeIcon size={16} />}
              </button>
            </div>
          </div>

          <div className="border-border/60 bg-bg/40 text-muted flex items-start gap-2.5 rounded-xl border px-4 py-3 text-xs leading-relaxed">
            <InformationCircleIcon size={14} className="mt-0.5 shrink-0" aria-hidden />
            <p className="flex-1">{t('settings.model.cloud.brainNotice')}</p>
          </div>

          <StatusLine status={status} error={error} hasModels={hasModels} />

          <div className="flex items-center justify-between gap-2">
            <Button size="md" onClick={() => void onTest()} disabled={!canTest}>
              {t('settings.model.cloud.test')}
            </Button>
            {stored?.apiKey && (
              <div className="flex items-center gap-4">
                <button
                  type="button"
                  disabled={!canTestConnection}
                  onClick={() => void onTestConnection()}
                  className={cn(
                    'text-sm font-medium capitalize',
                    status === 'testing'
                      ? 'text-muted animate-pulse cursor-wait'
                      : !canTestConnection
                        ? 'text-muted cursor-not-allowed'
                        : 'text-primary hover:text-primary/80 cursor-pointer'
                  )}
                >
                  {t('settings.model.cloud.testConnection')}
                </button>
                <Button
                  variant="ghost"
                  size="md"
                  onClick={() => void onRemove()}
                  disabled={!canRemove}
                  className="text-red-700 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-900/30"
                >
                  {t('settings.model.cloud.remove')}
                </Button>
              </div>
            )}
          </div>
        </section>

        <ModelBreakdown
          specs={
            provider === 'openrouter'
              ? sortOpenRouterModels(MODEL_SPECS[provider])
              : MODEL_SPECS[provider]
          }
          provider={provider}
        />
      </div>
    </div>
  )
}

function ModelBreakdown({
  specs,
  provider
}: {
  specs: ModelSpec[]
  provider: ProviderId
}): React.JSX.Element {
  const { t } = useTranslation()
  const isFrontier = (m: ModelSpec): boolean => !!m.badges?.includes('frontier')
  return (
    <section className="bg-surface border-border flex flex-col gap-3 rounded-2xl border p-6">
      <h2 className="text-fg text-sm font-semibold">{t('settings.model.cloud.modelsBreakdown')}</h2>
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="text-muted border-border border-b">
              <th className="whitespace-nowrap pb-2 pe-3 text-start font-medium">
                {t('settings.model.cloud.breakdown.model')}
              </th>
              <th className="whitespace-nowrap pb-2 px-3 text-start font-medium">
                {t('settings.model.cloud.breakdown.modes')}
              </th>
              <th className="whitespace-nowrap pb-2 px-3 text-end font-medium">
                {t('settings.model.cloud.breakdown.context')}
              </th>
              <th className="whitespace-nowrap pb-2 px-3 text-end font-medium">
                {t('settings.model.cloud.breakdown.input')}
              </th>
              <th className="whitespace-nowrap pb-2 px-3 text-end font-medium">
                {t('settings.model.cloud.breakdown.output')}
              </th>
              <th className="whitespace-nowrap pb-2 ps-3 text-end font-medium">
                {t('settings.model.cloud.breakdown.cached')}
              </th>
            </tr>
          </thead>
          <tbody>
            {specs.map((m) => (
              <tr
                key={m.name}
                className={cn(
                  'border-border border-b last:border-b-0',
                  isFrontier(m) && 'bg-accent/5'
                )}
              >
                <td className="min-w-80 py-2 pe-3 text-start">
                  <span className="flex flex-nowrap items-center gap-1.5">
                    <span className={cn('text-fg', isFrontier(m) && 'font-medium')}>{m.name}</span>
                    {m.badges?.map((badge) => (
                      <span
                        key={badge}
                        className={cn(
                          'inline-flex shrink-0 items-center rounded-full px-1.5 py-0.5 text-[10px] font-semibold leading-none',
                          BADGE_STYLES[badge]
                        )}
                      >
                        {t(`settings.model.cloud.breakdown.badges.${badge}`)}
                      </span>
                    ))}
                  </span>
                </td>
                <td className="py-2 px-3 text-start">
                  {m.modes && m.modes.length > 0 ? (
                    <span className="flex flex-nowrap items-center gap-1">
                      {m.modes.map((mode) => (
                        <span
                          key={mode}
                          className="inline-flex shrink-0 items-center rounded-full bg-border/40 px-1.5 py-0.5 text-[10px] font-semibold leading-none text-muted"
                        >
                          {t(`chat.thinkingMode.${mode}`)}
                        </span>
                      ))}
                    </span>
                  ) : (
                    <span className="text-muted/50">{'—'}</span>
                  )}
                </td>
                <td className="py-2 px-3 text-end text-muted tabular-nums">{m.context}</td>
                <td className="py-2 px-3 text-end text-muted tabular-nums">{m.input}</td>
                <td className="py-2 px-3 text-end text-muted tabular-nums">{m.output}</td>
                <td className="py-2 ps-3 text-end tabular-nums">
                  {m.cached === null ? (
                    <span className="text-muted/50">{'—'}</span>
                  ) : m.cached === 'Free' ? (
                    <span className="text-emerald-600 dark:text-emerald-400 font-medium">
                      {t('settings.model.cloud.breakdown.free')}
                    </span>
                  ) : (
                    <span className="text-muted">{m.cached}</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {provider === 'openrouter' && (
        <p className="text-muted flex items-center gap-1.5 text-xs">
          <InformationCircleIcon className="size-3.5 shrink-0" />
          <span>
            <span dir="ltr" className="inline-block">
              {'200+'}
            </span>{' '}
            {t('settings.model.cloud.breakdown.moreModels')}{' '}
            <a
              href="https://openrouter.ai/models"
              target="_blank"
              rel="noopener noreferrer"
              className="text-accent hover:underline"
            >
              openrouter.ai/models
            </a>
          </span>
        </p>
      )}
      <p className="text-muted/70 text-[10px] leading-relaxed">
        {t('settings.model.cloud.breakdown.disclaimer')}
      </p>
    </section>
  )
}

function StatusLine({
  status,
  error,
  hasModels
}: {
  status: Status
  error: string | null
  hasModels: boolean
}): React.JSX.Element {
  const { t } = useTranslation()
  const wrap = 'flex items-center gap-2 text-xs'
  if (status === 'testing') {
    return (
      <p className={cn(wrap, 'text-muted animate-pulse')}>
        <Loading02Icon size={14} className="shrink-0 animate-spin" />
        <span>{t('settings.model.cloud.status.testing')}</span>
      </p>
    )
  }
  if (status === 'invalid') {
    return (
      <p className={cn(wrap, 'items-start text-red-700 dark:text-red-400')}>
        <AlertCircleIcon size={14} className="mt-0.5 shrink-0" />
        <span>{error ?? t('settings.model.cloud.status.invalid')}</span>
      </p>
    )
  }
  if (hasModels) {
    return (
      <p className={cn(wrap, 'text-emerald-700 dark:text-emerald-400')}>
        <CheckmarkCircle02Icon size={14} className="shrink-0" />
        <span>{t('settings.model.cloud.status.ready')}</span>
      </p>
    )
  }
  return (
    <p className={cn(wrap, 'text-muted')}>
      <AlertCircleIcon size={14} className="shrink-0" />
      <span>{t('settings.model.cloud.status.untested')}</span>
    </p>
  )
}

/** Prefer the undated base model (e.g. "gpt-5.5" over "gpt-5.5-2026-04-23"). */
function isDateSnapshot(id: string): boolean {
  return /\d{4}-\d{2}-\d{2}$/.test(id)
}

function formatTestError(
  result: Extract<ProviderTestResult, { ok: false }>,
  providerLabel: string,
  t: (k: string, v?: Record<string, unknown>) => string
): string {
  switch (result.kind) {
    case 'invalid_key':
      return t('settings.model.cloud.errors.invalidKey')
    case 'rate_limited':
      return t('settings.model.cloud.errors.rateLimited')
    case 'invalid_model':
      return t('settings.model.cloud.errors.invalidModel')
    case 'network':
      return t('settings.model.cloud.errors.network', { provider: providerLabel })
    default:
      return t('settings.model.cloud.errors.generic', {
        message: result.message ?? ''
      })
  }
}
