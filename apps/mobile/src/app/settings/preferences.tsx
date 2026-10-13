import { useFreshConfig } from '@/lib/sync/useFreshConfig'
import {
  ConfigStatusRow,
  ConfigSwitchRow,
  ConfigWeekStartRow
} from '@/components/settings/ConfigRows'
import { PanelScreen, Section } from '@/components/settings/SettingsUI'
import { useTranslation } from 'react-i18next'

/**
 * Preferences — the desktop WolffishPanel, mirrored. The RAM guard, the two
 * agent safety switches and the week-start choice are editable here:
 * setConfigValue routes them through the outbox to the desktop, which
 * persists them exactly as its own panel would and announces the change
 * back. Launch at startup stays display-only — it registers a login item
 * with that machine's OS, an act only the desktop can perform on itself.
 */
export default function PreferencesScreen(): React.JSX.Element {
  // Desktop-owned values: pull the current ones when this screen opens.
  useFreshConfig()
  const { t } = useTranslation()

  return (
    <PanelScreen
      title={t('settings.tabs.preferences')}
      subtitle={t('settings.preferences.subtitle')}
    >
      <Section title={t('settings.preferences.generalTitle')}>
        <ConfigStatusRow
          field="launchAtStartup"
          label={t('settings.preferences.launchAtStartup')}
          description={t('settings.preferences.launchAtStartupDescription')}
        />
        <ConfigSwitchRow
          field="restrictPowerfulModels"
          label={t('settings.preferences.restrictPowerfulModels')}
          description={t('settings.preferences.restrictPowerfulModelsDescription')}
        />
        <ConfigSwitchRow
          field="ttsVoiceReplies"
          label={t('settings.preferences.voiceReplies')}
          description={t('settings.preferences.voiceRepliesDescription')}
        />
        <ConfigWeekStartRow
          label={t('settings.preferences.weekStartsOn')}
          description={t('settings.preferences.weekStartsOnDescription')}
        />
      </Section>
      <Section title={t('settings.preferences.safetyTitle')}>
        <ConfigSwitchRow
          field="bypassPermissions"
          label={t('settings.preferences.bypassPermissions')}
          description={t('settings.preferences.bypassPermissionsDescription')}
        />
        <ConfigSwitchRow
          field="blockCredentials"
          label={t('settings.preferences.blockCredentials')}
          description={t('settings.preferences.blockCredentialsDescription')}
        />
      </Section>
    </PanelScreen>
  )
}
