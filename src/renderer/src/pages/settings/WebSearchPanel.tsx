import { BraveLogo, DeepSeekLogo, DuckDuckGoLogo } from '@components/core/ProviderLogos'
import { BraveSearchCard } from '@pages/settings/BraveSearchCard'
import { PanelBackChevron } from '@pages/settings/drillNav'
import {
  DeepSeekSearchCard,
  EngineCardHeader,
  EngineOrderCard,
  HowItWorksCard,
  OnOffToggle,
  ToggleRow,
  type EngineState,
  type OrderedEngine
} from '@pages/settings/webToolsCards'
import {
  getCachedWebTools,
  prefetchWebTools,
  WEB_TOOLS_SERVICES,
  type WebToolsSnapshot
} from '@pages/settings/webToolsSnapshot'
import type { WebSearchEngine, WebToolsConfig } from '@preload/index'
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'

import { CapabilityGateBody, CapabilityGateCard, useCapabilityGate } from './capabilityGate'

const ENGINE_ICONS: Record<WebSearchEngine, ReactNode> = {
  brave: <BraveLogo size={14} />,
  deepseek: <DeepSeekLogo size={16} />,
  duckduckgo: <DuckDuckGoLogo size={15} />
}

export function WebSearchPanel(): React.JSX.Element {
  const { t } = useTranslation()
  const gate = useCapabilityGate('web-search')
  // Seeded from the snapshot Settings prefetched, so the priority list paints
  // filled in on the first frame instead of as a skeleton.
  const [snapshot, setSnapshot] = useState<WebToolsSnapshot | null>(getCachedWebTools)

  // The order list mirrors every engine card's state, so it re-reads on any
  // of their saves — the cards themselves stay independent.
  useEffect(() => {
    let cancelled = false
    const reseed = async (): Promise<void> => {
      const next = await prefetchWebTools()
      if (!cancelled) setSnapshot(next)
    }
    void (async () => reseed())()
    const unsubscribe = window.api.services.onChanged((payload) => {
      if (WEB_TOOLS_SERVICES.has(payload.service)) void reseed()
    })
    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [])

  const saveTools = useCallback(async (patch: Partial<WebToolsConfig>) => {
    setSnapshot((s) => (s ? { ...s, tools: { ...s.tools, ...patch } } : s))
    const response = await window.api.webTools.setConfig(patch)
    setSnapshot((s) => (s ? { ...s, tools: response.config } : s))
  }, [])

  const engines = useMemo((): OrderedEngine<WebSearchEngine>[] | null => {
    if (!snapshot) return null
    const stateOf = (engine: WebSearchEngine): EngineState => {
      if (engine === 'brave') {
        return snapshot.braveStatus.status === 'configured'
          ? 'active'
          : snapshot.braveStatus.status === 'error'
            ? 'error'
            : 'off'
      }
      if (engine === 'deepseek') {
        const on = snapshot.deepseek.searchEnabled && snapshot.deepseek.apiKey.trim().length > 0
        if (!on) return 'off'
        return snapshot.deepseekStatus.status === 'error' ? 'error' : 'active'
      }
      return snapshot.tools.duckduckgoEnabled ? 'active' : 'off'
    }
    return snapshot.tools.searchOrder.map((id) => {
      const state = stateOf(id)
      return {
        id,
        label: t(`settings.services.webTools.engines.${id}`),
        icon: ENGINE_ICONS[id],
        state,
        stateLabel: t(`settings.services.webTools.state.${state}`)
      }
    })
  }, [snapshot, t])

  return (
    <div className="flex min-h-full w-full items-start justify-center px-6 py-10">
      <div className="flex w-full max-w-2xl flex-col gap-6">
        <header className="flex flex-col gap-2">
          <div className="flex items-center gap-1.5">
            <PanelBackChevron />
            <h1 className="text-fg text-2xl font-semibold tracking-tight">
              {t('settings.services.webSearch.title')}
            </h1>
          </div>
          <p className="text-muted text-sm leading-relaxed">
            {t('settings.services.webSearch.subtitle')}
          </p>
        </header>

        <CapabilityGateCard gate={gate} label={t('settings.services.tabs.webSearch')} />

        <CapabilityGateBody gate={gate}>
          <EngineOrderCard
            title={t('settings.services.webTools.orderTitle')}
            description={t('settings.services.webSearch.orderDescription')}
            engines={engines}
            rows={3}
            onReorder={(searchOrder) => void saveTools({ searchOrder })}
          />

          <BraveSearchCard />

          <DeepSeekSearchCard toggle="searchEnabled" />

          <section className="bg-surface border-border flex flex-col gap-5 rounded-2xl border p-6">
            <EngineCardHeader
              icon={<DuckDuckGoLogo size={15} />}
              title={t('settings.services.duckduckgo.title')}
              description={t('settings.services.duckduckgo.description')}
            />
            <ToggleRow
              label={t('settings.services.duckduckgo.enable')}
              description={t('settings.services.duckduckgo.enableDescription')}
            >
              <OnOffToggle
                value={snapshot ? snapshot.tools.duckduckgoEnabled : null}
                onChange={(duckduckgoEnabled) => void saveTools({ duckduckgoEnabled })}
              />
            </ToggleRow>
          </section>

          <HowItWorksCard
            points={[
              t('settings.services.webSearch.howItWorks.order'),
              t('settings.services.webSearch.howItWorks.agent'),
              t('settings.services.webSearch.howItWorks.fallback'),
              t('settings.services.webSearch.howItWorks.privacy')
            ]}
          />
        </CapabilityGateBody>
      </div>
    </div>
  )
}
