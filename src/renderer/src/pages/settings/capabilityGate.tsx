/* eslint-disable react-refresh/only-export-components */
import { Button } from '@components/core/Button'
import { cn } from '@lib/utils/cn'
import type { CapabilityEntry } from '@preload/index'
import { AlertCircleIcon } from 'hugeicons-react'
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'

import { requestSettingsTab } from './settingsNav'

/**
 * The Services nav lists every service unconditionally — a page that
 * depends on a cerebellum capability gates itself instead: an alert card
 * spelling out what's wrong, with every control underneath disabled.
 */
export type CapabilityGate =
  | { kind: 'loading' | 'ok'; blocked: false }
  | { kind: 'missing' | 'off'; blocked: true }
  | { kind: 'error'; blocked: true; message: string }

// Snapshot shared by every gated panel, warmed when Settings opens so a
// panel's first paint already has a settled verdict instead of flashing
// enabled → blocked.
let cache: CapabilityEntry[] | null = null

export function prefetchCapabilityGate(): void {
  void window.api.cerebellum
    .listCapabilities()
    .then((caps) => {
      cache = caps
    })
    .catch(() => {})
}

function resolveGate(caps: CapabilityEntry[] | null, name: string): CapabilityGate {
  if (!caps) return { kind: 'loading', blocked: false }
  const entry = caps.find((c) => c.name === name)
  if (!entry) return { kind: 'missing', blocked: true }
  if (entry.status === 'error') return { kind: 'error', blocked: true, message: entry.error ?? '' }
  if (!entry.enabled) return { kind: 'off', blocked: true }
  return { kind: 'ok', blocked: false }
}

export function useCapabilityGate(name: string): CapabilityGate {
  const [caps, setCaps] = useState<CapabilityEntry[] | null>(cache)

  useEffect(() => {
    let cancelled = false
    // Fresh probe on mount: toggles that happened while no gated panel was
    // mounted never reached the subscription below, so the cache can be stale.
    void window.api.cerebellum
      .listCapabilities()
      .then((fresh) => {
        cache = fresh
        if (!cancelled) setCaps(fresh)
      })
      .catch(() => {})
    const unsubscribe = window.api.cerebellum.onCapabilitiesChanged((fresh) => {
      cache = fresh
      if (!cancelled) setCaps(fresh)
    })
    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [])

  return useMemo(() => resolveGate(caps, name), [caps, name])
}

/**
 * The detailed "why these settings are disabled" card. Renders nothing
 * while the capability is fine, so panels can mount it unconditionally
 * right under their header. `label` is the localized service name.
 */
export function CapabilityGateCard({
  gate,
  label
}: {
  gate: CapabilityGate
  label: string
}): React.JSX.Element | null {
  const { t } = useTranslation()
  if (!gate.blocked) return null
  const isError = gate.kind === 'error'
  return (
    <section
      role="alert"
      className={cn(
        'flex flex-col gap-3 rounded-2xl border p-5',
        isError ? 'border-rose-500/30 bg-rose-500/5' : 'border-amber-500/30 bg-amber-500/5'
      )}
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <AlertCircleIcon
            size={16}
            className={cn('shrink-0', isError ? 'text-rose-500' : 'text-amber-500')}
          />
          <span className={cn('text-sm font-medium', isError ? 'text-rose-500' : 'text-amber-500')}>
            {t(`settings.services.gate.${gate.kind}Title`)}
          </span>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => requestSettingsTab('capabilities')}
        >
          {t('settings.services.gate.openCapabilities')}
        </Button>
      </div>
      <p className="text-fg text-sm leading-relaxed">
        {t(`settings.services.gate.${gate.kind}Body`, { name: label })}
      </p>
      {gate.kind === 'error' && gate.message.length > 0 && (
        <pre className="bg-bg/60 border-border text-fg/90 whitespace-pre-wrap wrap-break-word rounded-md border px-3 py-2 font-mono text-xs leading-relaxed">
          {gate.message}
        </pre>
      )}
    </section>
  )
}

/**
 * Wraps a panel's settings sections and turns them fully inert while the
 * gate is blocked — `inert` kills focus and clicks (links included), the
 * classes communicate it visually. Keeps the panel's own column rhythm.
 */
export function CapabilityGateBody({
  gate,
  children
}: {
  gate: CapabilityGate
  children: ReactNode
}): React.JSX.Element {
  return (
    <div
      inert={gate.blocked}
      className={cn(
        'flex flex-col gap-6',
        gate.blocked && 'pointer-events-none select-none opacity-40'
      )}
    >
      {children}
    </div>
  )
}
