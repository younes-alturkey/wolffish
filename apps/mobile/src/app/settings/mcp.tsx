import { useFreshConfig } from '@/lib/sync/useFreshConfig'
import { MapSwitchRow } from '@/components/settings/ConfigRows'
import { PanelScreen, Section } from '@/components/settings/SettingsUI'
import { useDemoConfig } from '@/state/demoConfig'
import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { Text } from 'react-native'

/**
 * MCP — enable/disable configured MCP servers. Adding servers, headers and
 * OAuth remain desktop tasks; the switches are controllable from here.
 */
export default function McpScreen(): React.JSX.Element {
  // Desktop-owned values: pull the current ones when this screen opens.
  useFreshConfig()
  const { t } = useTranslation()
  // Subscribed, not snapshotted: the refresh above can land while the screen
  // is open, and a server added on the desktop must grow a row right then.
  const servers = useDemoConfig((state) => state.mcpServers)
  const names = useMemo(() => Object.keys(servers).sort(), [servers])

  return (
    <PanelScreen title={t('settings.tabs.mcp')} subtitle={t('settings.mcp.subtitle')}>
      <Section>
        {names.map((name) => (
          <MapSwitchRow key={name} mapKey="mcpServers" name={name} label={name} />
        ))}
        <Text className="text-muted text-left font-sans text-xs leading-5">
          {t('settings.mcp.desktopNote')}
        </Text>
      </Section>
    </PanelScreen>
  )
}
