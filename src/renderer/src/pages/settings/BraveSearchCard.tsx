import { BraveLogo } from '@components/core/ProviderLogos'
import { useToast } from '@components/core/toast/useToast'
import {
  Divider,
  EngineCardHeader,
  ExternalLink,
  KeyActions,
  OnOffToggle,
  SecretKeyInput,
  StatusRow,
  ToggleRow,
  type EngineState
} from '@pages/settings/webToolsCards'
import { getCachedWebTools } from '@pages/settings/webToolsSnapshot'
import type { BraveErrorKind, BraveStatus } from '@preload/index'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Trans, useTranslation } from 'react-i18next'

const BRAVE_API_URL = 'https://api.search.brave.com'

const STATE: Record<BraveStatus['status'], EngineState> = {
  configured: 'active',
  error: 'error',
  disabled: 'off'
}

export function BraveSearchCard(): React.JSX.Element {
  const { t } = useTranslation()
  const toast = useToast()

  // Seeded from the prefetched snapshot; null only when Settings opened
  // straight onto this panel before the prefetch landed — a skeleton then,
  // never a toggle flicking from a guess to the real value.
  const [initial] = useState(getCachedWebTools)
  const [enabled, setEnabled] = useState<boolean | null>(initial?.brave.enabled ?? null)
  const [apiKey, setApiKey] = useState(initial?.brave.apiKey ?? '')
  const [savedApiKey, setSavedApiKey] = useState(initial?.brave.apiKey ?? '')
  const [status, setStatus] = useState<BraveStatus>(
    initial?.braveStatus ?? { status: 'disabled', errorKind: null, error: null }
  )
  const [busy, setBusy] = useState<'idle' | 'saving' | 'testing'>('idle')
  const [validation, setValidation] = useState<string | null>(null)

  // True from the first keystroke that diverges the input until a save (or a
  // seed) realigns it — the remote-change listener below must never overwrite
  // a key mid-typing, and an event callback cannot read fresh state.
  const apiKeyDirtyRef = useRef(false)

  // The paired phone (or another window) may save Brave settings too: re-seed
  // the toggle, status and saved key; the input only when not mid-edit.
  useEffect(() => {
    let cancelled = false
    const reseed = async (): Promise<void> => {
      const [cfg, live] = await Promise.all([
        window.api.brave.getConfig(),
        window.api.brave.status()
      ])
      if (cancelled) return
      setEnabled(cfg.enabled)
      setStatus(live)
      setSavedApiKey(cfg.apiKey)
      if (!apiKeyDirtyRef.current) setApiKey(cfg.apiKey)
    }
    void (async () => reseed())()
    const unsubscribe = window.api.services.onChanged((payload) => {
      if (payload.service === 'brave') void reseed()
    })
    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [])

  const translateError = useCallback(
    (kind: BraveErrorKind, message?: string | null): string =>
      kind === 'unknown'
        ? t('settings.services.brave.errors.unknown', { message: message ?? '' })
        : t(`settings.services.brave.errors.${kind}`),
    [t]
  )

  const handleToggle = useCallback(async (value: boolean) => {
    setEnabled(value)
    const response = await window.api.brave.setConfig({ enabled: value })
    setStatus(response.status)
  }, [])

  // Plain persist — stores the key without spending quota on a live query.
  // Test connection is the explicit verify-and-connect path.
  const handleSave = useCallback(async () => {
    const key = apiKey.trim()
    if (!key) {
      setValidation(t('settings.services.brave.validation.keyRequired'))
      return
    }
    setValidation(null)
    setBusy('saving')
    try {
      const response = await window.api.brave.setConfig({ apiKey: key })
      setStatus(response.status)
      setSavedApiKey(key)
      apiKeyDirtyRef.current = false
      toast.show({ message: t('settings.services.brave.saveSuccess'), tone: 'success' })
    } finally {
      setBusy('idle')
    }
  }, [apiKey, t, toast])

  const handleTest = useCallback(async () => {
    const key = apiKey.trim()
    if (!key) {
      setValidation(t('settings.services.brave.validation.keyRequired'))
      return
    }
    setValidation(null)
    setBusy('testing')
    try {
      const result = await window.api.brave.test(key)
      if (result.ok) {
        const response = await window.api.brave.setConfig({ enabled: true, apiKey: key })
        setStatus(response.status)
        setEnabled(true)
        setSavedApiKey(key)
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
        setStatus(await window.api.brave.status())
      }
    } finally {
      setBusy('idle')
    }
  }, [apiKey, t, toast, translateError])

  const errorText = useMemo(() => {
    if (status.errorKind) return translateError(status.errorKind, status.error)
    return status.error
  }, [status, translateError])

  const trimmed = apiKey.trim()

  return (
    <section className="bg-surface border-border flex flex-col gap-5 rounded-2xl border p-6">
      <EngineCardHeader
        icon={<BraveLogo size={14} />}
        title={t('settings.services.brave.title')}
        description={t('settings.services.brave.description')}
        action={
          <ExternalLink href={BRAVE_API_URL}>{t('settings.services.brave.platform')}</ExternalLink>
        }
      />

      <ToggleRow
        label={t('settings.services.brave.enable')}
        description={t('settings.services.brave.enableDescription')}
      >
        <OnOffToggle
          value={enabled}
          disableOn={!savedApiKey}
          onChange={(value) => void handleToggle(value)}
        />
      </ToggleRow>

      <Divider />
      <StatusRow
        state={STATE[status.status]}
        label={t(`settings.services.brave.status.${status.status}`)}
        errorText={errorText}
      />
      <Divider />

      <SecretKeyInput
        id="brave-api-key"
        label={t('settings.services.brave.apiKey')}
        value={apiKey}
        placeholder={t('settings.services.brave.apiKeyPlaceholder')}
        onChange={(value) => {
          apiKeyDirtyRef.current = true
          setApiKey(value)
        }}
        hint={
          <Trans
            i18nKey="settings.services.brave.apiKeyHint"
            components={{
              link: (
                <a
                  href={BRAVE_API_URL}
                  onClick={(e) => {
                    e.preventDefault()
                    window.open(BRAVE_API_URL, '_blank', 'noopener,noreferrer')
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
        saveDisabled={busy !== 'idle' || !trimmed || trimmed === savedApiKey.trim()}
        testDisabled={busy !== 'idle' || !trimmed}
        testing={busy === 'testing'}
        onSave={() => void handleSave()}
        onTest={() => void handleTest()}
      />
      <p className="text-muted text-xs">{t('settings.services.brave.testHint')}</p>
    </section>
  )
}
