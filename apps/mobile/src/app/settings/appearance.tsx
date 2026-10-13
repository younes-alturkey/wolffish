import { LanguageToggle } from '@/components/common/language-toggle/LanguageToggle'
import { ThemeSelector } from '@/components/common/theme-selector/ThemeSelector'
import { PanelScreen, Section } from '@/components/settings/SettingsUI'
import { useTranslation } from 'react-i18next'

/** Appearance — theme + language, the desktop AppearancePanel one-to-one. */
export default function AppearanceScreen(): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <PanelScreen title={t('settings.tabs.appearance')} subtitle={t('settings.appearanceSubtitle')}>
      <Section title={t('theme.label')}>
        <ThemeSelector hideLabel />
      </Section>
      <Section title={t('locale.label')}>
        <LanguageToggle />
      </Section>
    </PanelScreen>
  )
}
