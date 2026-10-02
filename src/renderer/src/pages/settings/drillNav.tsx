import { RTL_LOCALES } from '@lib/i18n'
import { cn } from '@lib/utils/cn'
import { useLocale } from '@providers/locale/useLocale'
import { DrillBackContext } from '@pages/settings/settingsNav'
import { ArrowLeft01Icon, ArrowRight01Icon } from 'hugeicons-react'
import { useContext } from 'react'
import { useTranslation } from 'react-i18next'

/**
 * The minimal back-to-grid affordance: a bare chevron sitting inline right
 * before the panel title. Renders nothing when no drill is active, so panels
 * can keep it in their header unconditionally.
 */
export function PanelBackChevron(): React.JSX.Element | null {
  const onBack = useContext(DrillBackContext)
  const { t } = useTranslation()
  const { locale } = useLocale()
  if (!onBack) return null
  const Chevron = RTL_LOCALES.has(locale) ? ArrowRight01Icon : ArrowLeft01Icon
  return (
    <button
      type="button"
      onClick={onBack}
      aria-label={t('common.back')}
      className={cn(
        'text-muted hover:text-fg hover:bg-border/40 -ms-2 flex h-8 w-8 shrink-0 cursor-pointer items-center justify-center rounded-lg',
        'focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg'
      )}
    >
      <Chevron size={24} />
    </button>
  )
}
