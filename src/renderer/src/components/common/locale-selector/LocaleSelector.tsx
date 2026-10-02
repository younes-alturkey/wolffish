import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { GlobalIcon } from 'hugeicons-react'
import { Select, type SelectOption } from '@components/core/Select'
import { useLocale } from '@providers/locale/useLocale'
import type { SupportedLocale } from '@lib/i18n'

export function LocaleSelector(): React.JSX.Element {
  const { t } = useTranslation()
  const { locale, setLocale } = useLocale()

  const options = useMemo<readonly SelectOption<SupportedLocale>[]>(
    () => [
      { value: 'en', label: t('locale.en'), icon: <GlobalIcon size={16} /> },
      { value: 'ar', label: t('locale.ar'), icon: <GlobalIcon size={16} /> }
    ],
    [t]
  )

  return (
    <Select<SupportedLocale>
      label={t('locale.label')}
      value={locale}
      options={options}
      onChange={(next) => void setLocale(next)}
    />
  )
}
