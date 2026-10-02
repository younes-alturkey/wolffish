import { useToast } from '@components/core/toast/useToast'
import { cn } from '@lib/utils/cn'
import type { WeekStartsOn } from '@preload/index'
import { useFlow } from '@providers/flow/useFlow'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'

export function WolffishPanel(): React.JSX.Element {
  const { t } = useTranslation()
  const { show } = useToast()
  const { status, refreshStatus } = useFlow()
  const config = status?.config ?? null

  const [launchAtStartup, setLaunchAtStartupState] = useState<boolean | null>(null)
  const [startupActive, setStartupActive] = useState<boolean | null>(null)
  const [blockCredentials, setBlockCredentials] = useState<boolean>(
    config?.safety?.blockCredentials ?? false
  )
  const [bypass, setBypass] = useState<boolean>(config?.safety?.bypassPermissions ?? false)
  const [restrictModels, setRestrictModels] = useState<boolean>(
    config?.llm.restrictPowerfulModels ?? true
  )
  const [weekStartsOn, setWeekStartsOnState] = useState<WeekStartsOn>(config?.weekStartsOn ?? 1)
  // Voice replies (default ON): voice prompt in → spoken reply out. Lives in
  // config under tts.voiceReplies but is a PREFERENCE about how Wolffish
  // answers, so its one switch is here — the model-facing <voice_prompts>
  // instructions are included if and only if this is on.
  const [voiceReplies, setVoiceReplies] = useState<boolean>(true)
  const [savingKey, setSavingKey] = useState<
    | 'launchAtStartup'
    | 'blockCredentials'
    | 'bypass'
    | 'restrictModels'
    | 'weekStart'
    | 'voiceReplies'
    | null
  >(null)

  // Seed the four config-backed switches from a fresh value set. Reused by
  // the mount fetch and by both change subscriptions below; launchAtStartup
  // is deliberately absent everywhere — its switch reflects the OS login
  // item, not the config mirror of it.
  const seedFromPatch = useCallback((patch: Record<string, unknown>): void => {
    if (typeof patch.blockCredentials === 'boolean') setBlockCredentials(patch.blockCredentials)
    if (typeof patch.bypassPermissions === 'boolean') setBypass(patch.bypassPermissions)
    if (typeof patch.restrictPowerfulModels === 'boolean') {
      setRestrictModels(patch.restrictPowerfulModels)
    }
    if (patch.weekStartsOn === 0 || patch.weekStartsOn === 1) {
      setWeekStartsOnState(patch.weekStartsOn)
    }
    if (typeof patch.ttsVoiceReplies === 'boolean') setVoiceReplies(patch.ttsVoiceReplies)
  }, [])

  useEffect(() => {
    let cancelled = false
    void window.api.runtime.getLaunchAtStartupStatus().then(({ active }) => {
      if (cancelled) return
      setStartupActive(active)
      setLaunchAtStartupState(active)
    })
    // The panel may have been opened after a phone or another window edited
    // these settings — the useState initializers read the flow status from
    // before that. Start from disk truth rather than the cache.
    void window.api.workspace.getStatus().then((s) => {
      if (cancelled || !s?.config) return
      seedFromPatch({
        blockCredentials: s.config.safety?.blockCredentials ?? false,
        bypassPermissions: s.config.safety?.bypassPermissions ?? false,
        restrictPowerfulModels: s.config.llm.restrictPowerfulModels ?? true,
        weekStartsOn: s.config.weekStartsOn ?? 1
      })
    })
    // Voice replies lives under config.tts — disk truth via its own getter,
    // absent-means-on normalized by the main process.
    void window.api.tts.getConfig().then((cfg) => {
      if (!cancelled) setVoiceReplies(cfg.voiceReplies)
    })
    return () => {
      cancelled = true
    }
  }, [seedFromPatch])

  // The phone's Preferences screen (and any other window) edits the voice
  // replies switch through tts:setConfig, which announces on the tts service
  // channel — re-seed from disk truth when it does.
  useEffect(
    () =>
      window.api.services.onChanged((payload) => {
        if (payload.service !== 'tts') return
        void window.api.tts.getConfig().then((cfg) => setVoiceReplies(cfg.voiceReplies))
      }),
    []
  )

  // A paired phone edits these same settings over the tunnel, and another
  // window can edit them too. Either save announces itself with the applied
  // values; the switches follow, and the flow status refetches so every other
  // consumer of the config sees the same truth.
  useEffect(() => {
    const onChange = (patch: Record<string, unknown>): void => {
      seedFromPatch(patch)
      void refreshStatus()
    }
    const offPrefs = window.api.runtime.onPreferencesChanged(onChange)
    const offMobile = window.api.runtime.onMobileSettingsChange(({ settings }) =>
      onChange(settings ?? {})
    )
    return () => {
      offPrefs()
      offMobile()
    }
  }, [refreshStatus, seedFromPatch])

  const onChangeLaunchAtStartup = async (next: boolean): Promise<void> => {
    if (savingKey !== null || next === launchAtStartup) return
    setSavingKey('launchAtStartup')
    try {
      const result = await window.api.runtime.setLaunchAtStartup(next)
      setLaunchAtStartupState(result.value)
      setStartupActive(result.active)
      await refreshStatus()
      if (next && result.active) {
        show({ message: t('settings.wolffish.launchAtStartup.enabledToast'), tone: 'success' })
      }
    } finally {
      setSavingKey(null)
    }
  }

  const onChangeBlockCredentials = async (next: boolean): Promise<void> => {
    if (savingKey !== null || next === blockCredentials) return
    setSavingKey('blockCredentials')
    try {
      await window.api.runtime.setBlockCredentials(next)
      setBlockCredentials(next)
      await refreshStatus()
    } finally {
      setSavingKey(null)
    }
  }

  const onChangeBypass = async (next: boolean): Promise<void> => {
    if (savingKey !== null || next === bypass) return
    setSavingKey('bypass')
    try {
      await window.api.runtime.setBypassPermissions(next)
      setBypass(next)
      await refreshStatus()
    } finally {
      setSavingKey(null)
    }
  }

  const onChangeRestrictModels = async (next: boolean): Promise<void> => {
    if (savingKey !== null || next === restrictModels) return
    setSavingKey('restrictModels')
    try {
      await window.api.runtime.setRestrictPowerfulModels(next)
      setRestrictModels(next)
      await refreshStatus()
    } finally {
      setSavingKey(null)
    }
  }

  const onChangeVoiceReplies = async (next: boolean): Promise<void> => {
    if (savingKey !== null || next === voiceReplies) return
    setSavingKey('voiceReplies')
    try {
      await window.api.tts.setConfig({ voiceReplies: next })
      setVoiceReplies(next)
    } finally {
      setSavingKey(null)
    }
  }

  const onChangeWeekStart = async (next: WeekStartsOn): Promise<void> => {
    if (savingKey !== null || next === weekStartsOn) return
    setSavingKey('weekStart')
    try {
      await window.api.runtime.setWeekStartsOn(next)
      setWeekStartsOnState(next)
      await refreshStatus()
    } finally {
      setSavingKey(null)
    }
  }

  return (
    <div className="flex min-h-full w-full items-start justify-center px-6 py-10">
      <div className="flex w-full max-w-2xl flex-col gap-6">
        <header className="flex flex-col gap-2">
          <h1 className="text-fg text-2xl font-semibold tracking-tight">
            {t('settings.wolffish.title')}
          </h1>
          <p className="text-muted text-sm leading-relaxed">{t('settings.wolffish.subtitle')}</p>
        </header>

        <section className="bg-surface border-border flex flex-col gap-6 rounded-2xl border p-6">
          {launchAtStartup !== null && startupActive !== null ? (
            <StartupSetting
              value={launchAtStartup}
              active={startupActive}
              onChange={onChangeLaunchAtStartup}
              disabled={savingKey === 'launchAtStartup'}
            />
          ) : (
            <div className="h-13" />
          )}
          <div className="border-border/60 border-t" />
          <SettingToggle
            label={t('settings.wolffish.blockCredentials.label')}
            description={t('settings.wolffish.blockCredentials.description')}
            value={blockCredentials}
            onChange={onChangeBlockCredentials}
            disabled={savingKey === 'blockCredentials'}
          />
          <div className="border-border/60 border-t" />
          <SettingToggle
            label={t('settings.wolffish.bypassPermissions.label')}
            description={t('settings.wolffish.bypassPermissions.description')}
            value={bypass}
            onChange={onChangeBypass}
            disabled={savingKey === 'bypass'}
          />
          <div className="border-border/60 border-t" />
          <SettingToggle
            label={t('settings.wolffish.restrictPowerfulModels.label')}
            description={t('settings.wolffish.restrictPowerfulModels.description')}
            value={restrictModels}
            onChange={onChangeRestrictModels}
            disabled={savingKey === 'restrictModels'}
          />
          <div className="border-border/60 border-t" />
          <SettingToggle
            label={t('settings.wolffish.voiceReplies.label')}
            description={t('settings.wolffish.voiceReplies.description')}
            value={voiceReplies}
            onChange={onChangeVoiceReplies}
            disabled={savingKey === 'voiceReplies'}
          />
          <div className="border-border/60 border-t" />
          <WeekStartChoice
            value={weekStartsOn}
            onChange={onChangeWeekStart}
            disabled={savingKey === 'weekStart'}
          />
        </section>
      </div>
    </div>
  )
}

function WeekStartChoice({
  value,
  onChange,
  disabled
}: {
  value: WeekStartsOn
  onChange: (next: WeekStartsOn) => void
  disabled?: boolean
}): React.JSX.Element {
  const { t } = useTranslation()
  const options = useMemo<Array<{ value: WeekStartsOn; label: string }>>(
    () => [
      { value: 0, label: t('settings.wolffish.weekStartsOn.sunday') },
      { value: 1, label: t('settings.wolffish.weekStartsOn.monday') }
    ],
    [t]
  )
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-4">
        <span className="text-fg text-sm font-medium">
          {t('settings.wolffish.weekStartsOn.label')}
        </span>
        <div
          role="tablist"
          className="border-border bg-bg/40 inline-flex shrink-0 items-center rounded-lg border p-0.5"
        >
          {options.map((opt) => {
            const active = opt.value === value
            return (
              <button
                key={opt.value}
                role="tab"
                type="button"
                disabled={disabled}
                aria-selected={active}
                onClick={() => onChange(opt.value)}
                className={cn(
                  'rounded-md px-3 py-1 text-xs font-medium',
                  'focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg',
                  active
                    ? 'bg-primary text-primary-fg shadow-sm'
                    : 'text-muted hover:text-fg cursor-pointer',
                  disabled && 'cursor-not-allowed opacity-60'
                )}
              >
                {opt.label}
              </button>
            )
          })}
        </div>
      </div>
      <p className="text-muted text-xs leading-relaxed">
        {t('settings.wolffish.weekStartsOn.description')}
      </p>
    </div>
  )
}

function SettingToggle({
  label,
  description,
  value,
  onChange,
  disabled
}: {
  label: string
  description: string
  value: boolean
  onChange: (next: boolean) => void
  disabled?: boolean
}): React.JSX.Element {
  const { t } = useTranslation()
  const options = useMemo(
    () => [
      { value: false, label: t('settings.wolffish.toggle.off') },
      { value: true, label: t('settings.wolffish.toggle.on') }
    ],
    [t]
  )
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-4">
        <span className="text-fg text-sm font-medium">{label}</span>
        <div
          role="tablist"
          className="border-border bg-bg/40 inline-flex shrink-0 items-center rounded-lg border p-0.5"
        >
          {options.map((opt) => {
            const active = opt.value === value
            return (
              <button
                key={String(opt.value)}
                role="tab"
                type="button"
                disabled={disabled}
                aria-selected={active}
                onClick={() => onChange(opt.value)}
                className={cn(
                  'rounded-md px-3 py-1 text-xs font-medium',
                  'focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg',
                  active
                    ? 'bg-primary text-primary-fg shadow-sm'
                    : 'text-muted hover:text-fg cursor-pointer',
                  disabled && 'cursor-not-allowed opacity-60'
                )}
              >
                {opt.label}
              </button>
            )
          })}
        </div>
      </div>
      <p className="text-muted text-xs leading-relaxed">{description}</p>
    </div>
  )
}

function StartupSetting({
  value,
  active,
  onChange,
  disabled
}: {
  value: boolean
  active: boolean
  onChange: (next: boolean) => void
  disabled?: boolean
}): React.JSX.Element {
  const { t } = useTranslation()
  const options = useMemo(
    () => [
      { value: false, label: t('settings.wolffish.toggle.off') },
      { value: true, label: t('settings.wolffish.toggle.on') }
    ],
    [t]
  )
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-2.5">
          <span className="text-fg text-sm font-medium">
            {t('settings.wolffish.launchAtStartup.label')}
          </span>
          <span
            className={cn(
              'inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide',
              active
                ? 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400'
                : 'bg-amber-500/15 text-amber-600 dark:text-amber-400'
            )}
          >
            {active
              ? t('settings.wolffish.launchAtStartup.active')
              : t('settings.wolffish.launchAtStartup.inactive')}
          </span>
        </div>
        <div
          role="tablist"
          className="border-border bg-bg/40 inline-flex shrink-0 items-center rounded-lg border p-0.5"
        >
          {options.map((opt) => {
            const isActive = opt.value === value
            return (
              <button
                key={String(opt.value)}
                role="tab"
                type="button"
                disabled={disabled}
                aria-selected={isActive}
                onClick={() => onChange(opt.value)}
                className={cn(
                  'rounded-md px-3 py-1 text-xs font-medium',
                  'focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg',
                  isActive
                    ? 'bg-primary text-primary-fg shadow-sm'
                    : 'text-muted hover:text-fg cursor-pointer',
                  disabled && 'cursor-not-allowed opacity-60'
                )}
              >
                {opt.label}
              </button>
            )
          })}
        </div>
      </div>
      <p className="text-muted text-xs leading-relaxed">
        {t('settings.wolffish.launchAtStartup.description')}
      </p>
    </div>
  )
}
