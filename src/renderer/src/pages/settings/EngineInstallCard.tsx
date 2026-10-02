import { Button } from '@components/core/Button'
import { cn } from '@lib/utils/cn'
import { useTranslation } from 'react-i18next'

import type { EngineInstallState } from './useEngineInstall'

/**
 * Manual install card for a local voice engine, mirroring the gogcli setup
 * section: a status line, an Install / Reinstall button, and a progress bar
 * that shows real byte progress while a model downloads and an indeterminate
 * "working" pulse during the runtime/engine phases (which have no byte count).
 */
export function EngineInstallCard({
  state,
  requirementKey
}: {
  state: EngineInstallState
  requirementKey: string
}): React.JSX.Element {
  const { t } = useTranslation()
  const { installed, installing, progress, error } = state
  const checking = installed === null
  const hasError = !!error && !installing

  const phaseLabel = ((): string => {
    switch (progress?.phase) {
      case 'model':
        return t('settings.services.engineInstall.phaseModel', { percent: progress.percent })
      case 'engine':
        return t('settings.services.engineInstall.phaseEngine')
      case 'ffmpeg':
        return t('settings.services.engineInstall.phaseFfmpeg')
      case 'done':
        return t('settings.services.engineInstall.phaseDone')
      default:
        return t('settings.services.engineInstall.phasePython')
    }
  })()

  const statusText = installing
    ? t('settings.services.engineInstall.installing')
    : checking
      ? t('settings.services.engineInstall.checking')
      : installed
        ? t('settings.services.engineInstall.installed')
        : t('settings.services.engineInstall.notInstalled')

  // One always-rendered sub-line with reserved height — content swaps between
  // the live install phase, a failure reason, and the engine's requirement, so
  // nothing pops in/out and the card height never changes between states.
  const subText = installing
    ? phaseLabel
    : hasError
      ? t('settings.services.engineInstall.failed', { error })
      : t(requirementKey)

  const isModel = progress?.phase === 'model'
  const barWidth = installing
    ? isModel
      ? `${progress?.percent ?? 0}%`
      : '100%'
    : installed
      ? '100%'
      : '0%'

  return (
    <section className="bg-surface border-border flex flex-col gap-3 rounded-2xl border p-6">
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <div className="flex items-center gap-2">
            <span
              className={cn(
                'h-2 w-2 shrink-0 rounded-full',
                installing
                  ? 'bg-accent animate-pulse'
                  : installed
                    ? 'bg-emerald-500'
                    : checking
                      ? 'bg-border'
                      : 'bg-amber-500'
              )}
            />
            <span
              className={cn(
                'text-sm font-medium',
                installing ? 'text-accent animate-pulse' : 'text-fg'
              )}
            >
              {statusText}
            </span>
          </div>
          <span
            className={cn(
              'line-clamp-2 min-h-8 text-xs',
              hasError ? 'text-amber-500' : 'text-muted'
            )}
          >
            {subText}
          </span>
        </div>
        <Button
          type="button"
          variant={installed ? 'outline' : 'primary'}
          onClick={state.install}
          disabled={installing || checking}
          className="shrink-0"
        >
          {installed
            ? t('settings.services.engineInstall.reinstall')
            : t('settings.services.engineInstall.install')}
        </Button>
      </div>

      <div className="bg-border/30 h-1 overflow-hidden rounded-full">
        <div
          className={cn(
            'h-full rounded-full bg-emerald-500 transition-[width] duration-300 ease-out',
            installing && !isModel && 'animate-pulse'
          )}
          style={{ width: barWidth }}
        />
      </div>
    </section>
  )
}
