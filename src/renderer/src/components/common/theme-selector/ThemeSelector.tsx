import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { ComputerIcon, Moon02Icon, Sun03Icon } from 'hugeicons-react'
import { Select, type SelectOption } from '@components/core/Select'
import { useTheme, type ThemeSource } from '@providers/theme/useTheme'

export function ThemeSelector(): React.JSX.Element {
  const { t } = useTranslation()
  const { theme, setTheme } = useTheme()

  const options = useMemo<readonly SelectOption<ThemeSource>[]>(
    () => [
      { value: 'system', label: t('theme.system'), icon: <ComputerIcon size={16} /> },
      { value: 'light', label: t('theme.light'), icon: <Sun03Icon size={16} /> },
      { value: 'dark', label: t('theme.dark'), icon: <Moon02Icon size={16} /> }
    ],
    [t]
  )

  return (
    <Select<ThemeSource>
      label={t('theme.label')}
      value={theme}
      options={options}
      onChange={(next) => void setTheme(next)}
    />
  )
}
