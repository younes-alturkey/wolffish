import { DeepSeekLogo } from '@components/core/ProviderLogos'
import { PanelBackChevron } from '@pages/settings/drillNav'
import {
  DeepSeekSearchCard,
  EngineCardHeader,
  EngineOrderCard,
  HowItWorksCard,
  StatusRow,
  type EngineState,
  type OrderedEngine
} from '@pages/settings/webToolsCards'
import {
  getCachedWebTools,
  prefetchWebTools,
  WEB_TOOLS_SERVICES,
  type WebToolsSnapshot
} from '@pages/settings/webToolsSnapshot'
import type { WebFetchEngine } from '@preload/index'
import { Download04Icon } from 'hugeicons-react'
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'

import { CapabilityGateBody, CapabilityGateCard, useCapabilityGate } from './capabilityGate'

const ENGINE_ICONS: Record<WebFetchEngine, ReactNode> = {
  direct: <Download04Icon size={15} />,
  deepseek: <DeepSeekLogo size={16} />
}

export function WebFetchPanel(): React.JSX.Element {
  const { t } = useTranslation()
  const gate = useCapabilityGate('web-fetch')
  const [snapshot, setSnapshot] = useState<WebToolsSnapshot | null>(getCachedWebTools)

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

  const saveOrder = useCallback(async (fetchOrder: WebFetchEngine[]) => {
    setSnapshot((s) => (s ? { ...s, tools: { ...s.tools, fetchOrder } } : s))
    const response = await window.api.webTools.setConfig({ fetchOrder })
    setSnapshot((s) => (s ? { ...s, tools: response.config } : s))
  }, [])

  const engines = useMemo((): OrderedEngine<WebFetchEngine>[] | null => {
    if (!snapshot) return null
    const stateOf = (engine: WebFetchEngine): EngineState => {
      if (engine === 'direct') return 'active'
      const on = snapshot.deepseek.fetchEnabled && snapshot.deepseek.apiKey.trim().length > 0
      if (!on) return 'off'
      return snapshot.deepseekStatus.status === 'error' ? 'error' : 'active'
    }
    return snapshot.tools.fetchOrder.map((id) => {
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
              {t('settings.services.webFetch.title')}
            </h1>
          </div>
          <p className="text-muted text-sm leading-relaxed">
            {t('settings.services.webFetch.subtitle')}
          </p>
        </header>

        <CapabilityGateCard gate={gate} label={t('settings.services.tabs.webFetch')} />

        <CapabilityGateBody gate={gate}>
          <EngineOrderCard
            title={t('settings.services.webTools.orderTitle')}
            description={t('settings.services.webFetch.orderDescription')}
            engines={engines}
            rows={2}
            onReorder={(order) => void saveOrder(order)}
          />

          <section className="bg-surface border-border flex flex-col gap-5 rounded-2xl border p-6">
            <EngineCardHeader
              icon={<Download04Icon size={15} />}
              title={t('settings.services.directFetch.title')}
              description={t('settings.services.directFetch.description')}
            />
            <StatusRow
              state="active"
              label={t('settings.services.directFetch.status')}
              errorText={null}
            />
          </section>

          <DeepSeekSearchCard toggle="fetchEnabled" />

          <HowItWorksCard
            points={[
              t('settings.services.webFetch.howItWorks.order'),
              t('settings.services.webFetch.howItWorks.agent'),
              t('settings.services.webFetch.howItWorks.private'),
              t('settings.services.webFetch.howItWorks.browser')
            ]}
          />
        </CapabilityGateBody>
      </div>
    </div>
  )
}
