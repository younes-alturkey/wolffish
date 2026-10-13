import { useFreshConfig } from '@/lib/sync/useFreshConfig'
import { Button } from '@/components/core/Button'
import { Input } from '@/components/core/Input'
import { PlusSignIcon } from '@/components/core/icons'
import { Toggle } from '@/components/settings/ConfigRows'
import { PanelScreen, Section } from '@/components/settings/SettingsUI'
import { setConfigValue, useConfigValue, type DemoVariable } from '@/state/demoConfig'
import { useTranslation } from 'react-i18next'
import { Text, View } from 'react-native'

/**
 * Variables — the desktop VariablesPanel: named prompt variables the agent
 * can substitute, editable in place. Sensitive hides the value only (the name
 * is always plaintext), masked by Input's own eye toggle; edits persist
 * locally in demo mode.
 */

function VariableRow({
  variable,
  onChange,
  onDelete
}: {
  variable: DemoVariable
  onChange: (variable: DemoVariable) => void
  onDelete: () => void
}): React.JSX.Element {
  const { t } = useTranslation()

  return (
    <View className="border-border flex-col gap-3 rounded-xl border p-3">
      <Input
        value={variable.name}
        onChangeText={(name) => onChange({ ...variable, name })}
        placeholder={t('settings.variables.namePlaceholder')}
        autoCapitalize="characters"
        autoCorrect={false}
      />
      <Input
        value={variable.value}
        onChangeText={(value) => onChange({ ...variable, value })}
        placeholder={t('settings.variables.valuePlaceholder')}
        secureTextEntry={variable.sensitive}
        autoCapitalize="none"
        autoCorrect={false}
      />
      {/* Delete sits where the row label used to; the toggle carries its own
          wording (Plaintext | Sensitive) instead of the shared Off | On. */}
      <View className="flex-row items-center justify-between gap-3">
        <Button variant="danger" size="sm" onPress={onDelete}>
          {t('settings.variables.delete')}
        </Button>
        <Toggle
          value={variable.sensitive}
          onValueChange={(sensitive) => onChange({ ...variable, sensitive })}
          accessibilityLabel={t('settings.variables.sensitive')}
          labels={{
            off: t('settings.variables.plaintext'),
            on: t('settings.variables.sensitive')
          }}
        />
      </View>
    </View>
  )
}

export default function VariablesScreen(): React.JSX.Element {
  // Desktop-owned values: pull the current ones when this screen opens.
  useFreshConfig()
  const { t } = useTranslation()
  const variables = useConfigValue('variables')
  const setVariables = (next: DemoVariable[]): void => setConfigValue('variables', next)

  return (
    <PanelScreen title={t('settings.tabs.variables')} subtitle={t('settings.variables.subtitle')}>
      <Section>
        {variables.length === 0 ? (
          <Text className="text-muted text-left font-sans text-sm">
            {t('settings.variables.empty')}
          </Text>
        ) : (
          variables.map((variable, index) => (
            <VariableRow
              key={index}
              variable={variable}
              onChange={(next) => {
                const copy = [...variables]
                copy[index] = next
                setVariables(copy)
              }}
              onDelete={() => setVariables(variables.filter((_, i) => i !== index))}
            />
          ))
        )}
        <Button
          variant="outline"
          size="sm"
          onPress={() => setVariables([...variables, { name: '', value: '', sensitive: false }])}
        >
          <PlusSignIcon size={14} className="text-fg" />
          {t('settings.variables.add')}
        </Button>
      </Section>
    </PanelScreen>
  )
}
