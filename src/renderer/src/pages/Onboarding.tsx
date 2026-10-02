import { useTranslation } from 'react-i18next'
import { ArrowLeft02Icon, ArrowRight02Icon } from 'hugeicons-react'
import iconTransparent from '@resources/images/icon_transparent.png'
import { Button } from '@components/core/Button'
import { ThemeSelector } from '@components/common/theme-selector/ThemeSelector'
import { LocaleSelector } from '@components/common/locale-selector/LocaleSelector'
import { useLocale } from '@providers/locale/useLocale'
import { useFlow } from '@providers/flow/useFlow'
import { RTL_LOCALES } from '@lib/i18n'

export function Onboarding(): React.JSX.Element {
  const { t } = useTranslation()
  const { locale } = useLocale()
  const { goTo, status, refreshStatus } = useFlow()
  const isRtl = RTL_LOCALES.has(locale)
  const ArrowIcon = isRtl ? ArrowLeft02Icon : ArrowRight02Icon

  const isReentry = !!status?.onboardingCompleted

  // Onboarding is theme and language, then the chat. Nothing else: no
  // provider setup, no Ollama, no model to choose. A local model is one
  // optional provider among several — the user configures it in Settings →
  // Models → Ollama if and when they want one, and an empty chat carries its
  // own notice while no model or cloud provider is set up.
  const onContinue = async (): Promise<void> => {
    if (!isReentry) {
      await window.api.workspace.completeOnboarding()
      await refreshStatus()
    }
    goTo('chat')
  }

  return (
    <main className="bg-bg flex min-h-full w-full items-center justify-center px-6 py-12">
      <div className="flex w-full max-w-md flex-col items-center gap-8">
        <header className="flex flex-col items-center gap-4 text-center">
          <img
            src={iconTransparent}
            alt=""
            aria-hidden
            className="h-20 w-20 object-contain"
            draggable={false}
          />
          <div className="flex flex-col gap-2">
            <h1 className="text-fg text-2xl font-semibold tracking-tight">
              {isReentry ? t('onboarding.settingsTitle') : t('onboarding.welcome')}
            </h1>
            <p className="text-muted text-sm leading-relaxed">
              {isReentry ? t('onboarding.settingsSubtitle') : t('onboarding.subtitle')}
            </p>
          </div>
        </header>

        <section className="bg-surface border-border flex w-full flex-col gap-5 rounded-2xl border p-6 shadow-sm dark:shadow-none">
          <ThemeSelector />
          <LocaleSelector />
          <Button size="lg" className="mt-2 w-full" onClick={() => void onContinue()}>
            <span>{isReentry ? t('onboarding.done') : t('onboarding.getStarted')}</span>
            <ArrowIcon size={18} />
          </Button>
        </section>
      </div>
    </main>
  )
}
