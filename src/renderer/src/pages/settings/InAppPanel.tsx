import { cn } from '@lib/utils/cn'
import type { InAppConfig } from '@preload/index'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'

export function InAppPanel(): React.JSX.Element {
  const { t } = useTranslation()

  const [config, setConfig] = useState<InAppConfig | null>(null)
  const loaded = config !== null

  useEffect(() => {
    let cancelled = false
    void window.api.inapp.getConfig().then((cfg: InAppConfig) => {
      if (!cancelled) setConfig(cfg)
    })
    // The phone edits the same two switches over the tunnel, and the change
    // arrives here as the very push this panel's own save fires — so an open
    // panel adopts it instead of showing pre-edit values until remounted.
    const off = window.api.inapp.onConfigChange((cfg) => {
      if (!cancelled) setConfig(cfg)
    })
    return () => {
      cancelled = true
      off()
    }
  }, [])

  const toggleOptions = useMemo(
    () => [
      { value: false, label: t('settings.services.inapp.toggle.off') },
      { value: true, label: t('settings.services.inapp.toggle.on') }
    ],
    [t]
  )

  // Persists immediately and is read fresh per render by the chat feed —
  // no restart. The setConfig handler broadcasts the change so an open chat
  // re-renders at once. Off (default) = clean feed.
  const patch = useCallback(async (next: Partial<InAppConfig>) => {
    setConfig((prev) => (prev ? { ...prev, ...next } : prev))
    await window.api.inapp.setConfig(next)
  }, [])

  return (
    <div className="flex min-h-full w-full items-start justify-center px-6 py-10">
      <div className="flex w-full max-w-2xl flex-col gap-6">
        <header className="flex flex-col gap-2">
          <h1 className="text-fg text-2xl font-semibold tracking-tight">
            {t('settings.services.inapp.title')}
          </h1>
          <p className="text-muted text-sm leading-relaxed">
            {t('settings.services.inapp.subtitle')}
          </p>
        </header>

        <section className="bg-surface border-border flex flex-col gap-5 rounded-2xl border p-6">
          {/* Show all tool activity — off (default) shows a clean feed: agent
              replies, file-bearing tool results, and errors only. On adds the
              model/provider chip plus every tool call/result/activity and
              compaction card. Display-only — never affects history. */}
          <ToggleRow
            label={t('settings.services.inapp.verbose.label')}
            description={t('settings.services.inapp.verbose.description')}
            value={config?.verbose === true}
            loaded={loaded}
            options={toggleOptions}
            onChange={(value) => void patch({ verbose: value })}
          />

          <div className="border-border/60 border-t" />

          {/* The model's thinking, as a collapsible card in the feed. On by
              default, here AND on the phone — one workspace answer, like
              `verbose` above. Switching it off hides the card and nothing
              else: the reasoning is still streamed, still stored with the
              conversation, and still in an export. */}
          <ToggleRow
            label={t('settings.services.inapp.reasoning.label')}
            description={t('settings.services.inapp.reasoning.description')}
            value={config?.reasoning !== false}
            loaded={loaded}
            options={toggleOptions}
            onChange={(value) => void patch({ reasoning: value })}
          />
        </section>
      </div>
    </div>
  )
}

/** One labelled setting with the segmented on/off control every panel uses. */
function ToggleRow({
  label,
  description,
  value,
  loaded,
  options,
  onChange
}: {
  label: string
  description: string
  value: boolean
  loaded: boolean
  options: Array<{ value: boolean; label: string }>
  onChange: (value: boolean) => void
}): React.JSX.Element {
  return (
    <div className="flex items-center justify-between gap-4">
      <div className="flex flex-col gap-1">
        <span className="text-fg text-sm font-medium">{label}</span>
        <p className="text-muted text-xs">{description}</p>
      </div>
      {!loaded ? (
        <div
          aria-hidden="true"
          className="bg-border/30 h-7 w-19.5 shrink-0 animate-pulse rounded-lg"
        />
      ) : (
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
                aria-selected={active}
                disabled={!loaded}
                onClick={() => {
                  if (opt.value !== value) onChange(opt.value)
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
  )
}
