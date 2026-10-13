import { Input } from '@/components/core/Input'
import { Select, type SelectOption } from '@/components/core/Select'
import { cn } from '@/lib/utils/cn'
import {
  setConfigValue,
  useConfigValue,
  useDemoConfig,
  type DemoConfigValues
} from '@/state/demoConfig'
import { memo } from 'react'
import { useTranslation } from 'react-i18next'
import { Pressable, Text, View, type KeyboardTypeOptions } from 'react-native'

/**
 * Config-bound settings rows. Each row subscribes to exactly ONE flat store
 * key (single-field zustand selector), so flipping a switch or typing in a
 * field re-renders that row alone — never the panel tree. Text rows are
 * uncontrolled (defaultValue + commit on change), so typing doesn't
 * re-render anything at all.
 */

/**
 * The desktop's binary switch, exactly: a segmented Off | On tablist
 * (`border p-0.5` pill, active segment `bg-primary text-primary-fg`; the
 * desktop's shadow is dropped, see below). The desktop deliberately avoids
 * sliding knobs — a knob
 * translating along physical X inverts under RTL; segments never do.
 */
export function Toggle({
  value,
  onValueChange,
  disabled,
  accessibilityLabel,
  labels
}: {
  value: boolean
  onValueChange: (value: boolean) => void
  disabled?: boolean
  accessibilityLabel?: string
  /** Segment wording — defaults to the shared Off | On pair. */
  labels?: { off: string; on: string }
}): React.JSX.Element {
  const { t } = useTranslation()
  const options = [
    { value: false, label: labels?.off ?? t('settings.toggle.off') },
    { value: true, label: labels?.on ?? t('settings.toggle.on') }
  ]
  return (
    <View
      accessibilityRole="switch"
      accessibilityState={{ checked: value, disabled }}
      accessibilityLabel={accessibilityLabel}
      className={cn(
        'border-border bg-bg flex-row items-center self-start rounded-lg border p-0.5',
        disabled && 'opacity-60'
      )}
    >
      {options.map((option) => {
        const active = option.value === value
        return (
          <Pressable
            key={String(option.value)}
            accessibilityRole="tab"
            accessibilityState={{ selected: active }}
            disabled={disabled || active}
            onPress={() => onValueChange(option.value)}
            // No shadow class on the active segment: a shadow that appears and
            // disappears between renders makes NativeWind upgrade the view, and
            // its dev-only upgrade warning stringifies props — which walks
            // React Navigation's throwing context getters and red-boxes the app
            // on every toggle. Same reason as ModelSwitch/ChatControls.
            className={cn('rounded-md px-3 py-1', active && 'bg-primary')}
          >
            <Text
              className={cn('font-sans-medium text-xs', active ? 'text-primary-fg' : 'text-muted')}
            >
              {option.label}
            </Text>
          </Pressable>
        )
      })}
    </View>
  )
}

// `reasoningModes` — the one array-valued config key — is excluded here so
// these mapped types stay exact: no row renders it (the Library cards read it
// through useChatReasoning), and leaving an array in the union widens every
// row's key type to `undefined`.
type RowKeys = Exclude<keyof DemoConfigValues, 'reasoningModes'>

type BooleanKeys = {
  [K in RowKeys]: DemoConfigValues[K] extends boolean ? K : never
}[RowKeys]

type StringKeys = {
  [K in RowKeys]: DemoConfigValues[K] extends string ? K : never
}[RowKeys]

export type RowChrome = {
  label: string
  description?: string
  icon?: React.ReactNode
}

function RowShell({
  label,
  description,
  icon,
  disabled,
  children
}: RowChrome & { disabled?: boolean; children: React.ReactNode }): React.JSX.Element {
  return (
    <View className={cn('flex-row items-center gap-3', disabled && 'opacity-50')}>
      {icon}
      <View className="flex-1 flex-col gap-0.5">
        <Text className="text-fg font-sans-medium text-left text-sm">{label}</Text>
        {description ? (
          <Text className="text-muted text-left font-sans text-xs leading-5">{description}</Text>
        ) : null}
      </View>
      {children}
    </View>
  )
}

/**
 * Read-only state of one boolean config key — a dot and On/Off where a
 * switch would be. For settings this device can display but must not drive:
 * starting or stopping a channel bridge is the desktop's own act (it owns
 * the grammY / Baileys process), so mobile reports the state instead of
 * pretending to flip it.
 */
export const ConfigStatusRow = memo(function ConfigStatusRow({
  field,
  ...chrome
}: RowChrome & { field: BooleanKeys }): React.JSX.Element {
  const { t } = useTranslation()
  const value = useConfigValue(field)
  return (
    <RowShell {...chrome}>
      <View className="flex-row items-center gap-1.5">
        {/* StatusDot's markup rather than the import: SettingsUI already
            pulls Toggle from this file, and reaching back would cycle. */}
        <View
          className={cn('h-2 w-2 rounded-full', value ? 'bg-emerald-500' : 'bg-border')}
          accessibilityElementsHidden
        />
        <Text
          className={cn(
            'font-sans text-xs',
            value ? 'text-emerald-600 dark:text-emerald-400' : 'text-muted'
          )}
        >
          {value ? t('settings.toggle.on') : t('settings.toggle.off')}
        </Text>
      </View>
    </RowShell>
  )
})

/** Switch bound to one boolean config key; `requires` gates it on another. */
export const ConfigSwitchRow = memo(function ConfigSwitchRow({
  field,
  requires,
  ...chrome
}: RowChrome & { field: BooleanKeys; requires?: BooleanKeys }): React.JSX.Element {
  const value = useConfigValue(field)
  const gate = useDemoConfig((state) => (requires ? state[requires] : true))
  return (
    <RowShell {...chrome} disabled={!gate}>
      <Toggle
        value={value}
        disabled={!gate}
        onValueChange={(next) => setConfigValue(field, next)}
        accessibilityLabel={chrome.label}
      />
    </RowShell>
  )
})

/**
 * The desktop's week-start choice: the same segmented pill the switches use,
 * with the segments named for the days instead of Off | On. Bound to the one
 * non-boolean toggle key (`weekStartsOn`, 0 Sunday | 1 Monday), written
 * through the ordinary setConfigValue path, so a tap syncs exactly like any
 * switch on the screen.
 */
export const ConfigWeekStartRow = memo(function ConfigWeekStartRow(
  chrome: RowChrome
): React.JSX.Element {
  const { t } = useTranslation()
  const value = useConfigValue('weekStartsOn')
  return (
    <RowShell {...chrome}>
      <Toggle
        value={value === 1}
        onValueChange={(next) => setConfigValue('weekStartsOn', next ? 1 : 0)}
        accessibilityLabel={chrome.label}
        labels={{ off: t('settings.days.sunday'), on: t('settings.days.monday') }}
      />
    </RowShell>
  )
})

/**
 * Text field bound to one string config key. Uncontrolled: renders once with
 * the stored value and commits on every keystroke without re-rendering.
 */
export const ConfigTextRow = memo(function ConfigTextRow({
  field,
  label,
  icon,
  requires,
  placeholder,
  keyboardType,
  commitOnEndEditing
}: {
  field: StringKeys
  label: string
  icon?: React.ReactNode
  requires?: BooleanKeys
  placeholder?: string
  keyboardType?: KeyboardTypeOptions
  /**
   * Commit once, when editing ends, instead of per keystroke. For fields
   * whose write is heavyweight on the desktop — a Telegram allow-list change
   * restarts the bridge — so a nine-digit ID arrives as one write, not nine
   * restarts. The field is uncontrolled either way, so a snapshot landing
   * mid-edit never yanks text out from under the keyboard; the store simply
   * learns the value at the same moment the desktop does.
   */
  commitOnEndEditing?: boolean
}): React.JSX.Element {
  const gate = useDemoConfig((state) => (requires ? state[requires] : true))
  return (
    <View className={cn('flex-col gap-1.5', !gate && 'opacity-50')}>
      <View className="flex-row items-center gap-2">
        {icon}
        <Text className="text-muted font-sans-medium text-left text-sm">{label}</Text>
      </View>
      <Input
        defaultValue={useDemoConfig.getState()[field]}
        onChangeText={commitOnEndEditing ? undefined : (text) => setConfigValue(field, text)}
        onEndEditing={
          commitOnEndEditing ? (event) => setConfigValue(field, event.nativeEvent.text) : undefined
        }
        editable={gate}
        placeholder={placeholder}
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType={keyboardType}
      />
    </View>
  )
})

/** Select bound to one string config key. */
export const ConfigSelectRow = memo(function ConfigSelectRow({
  field,
  label,
  options,
  searchable
}: {
  field: StringKeys
  label?: string
  options: readonly SelectOption<string>[]
  searchable?: boolean
}): React.JSX.Element {
  const value = useConfigValue(field)
  return (
    <Select<string>
      label={label}
      value={value}
      options={options}
      onChange={(next) => setConfigValue(field, next as DemoConfigValues[typeof field])}
      searchable={searchable}
    />
  )
})

/**
 * Switch for one entry of a Record<string, boolean> collection. The write
 * goes through setConfigValue with the WHOLE map — that is what buys the
 * entry the ordinary write path (the outbox dirty window, the configSet
 * push, the read-only refusal while paired-but-offline); the desktop diffs
 * the map against its own list and toggles just the row that moved. The map
 * is read fresh at press time so the row's subscription stays single-entry.
 */
export const MapSwitchRow = memo(function MapSwitchRow({
  mapKey,
  name,
  ...chrome
}: RowChrome & { mapKey: 'capabilities' | 'mcpServers'; name: string }): React.JSX.Element {
  const value = useDemoConfig((state) => state[mapKey][name] ?? false)
  return (
    <RowShell {...chrome}>
      <Toggle
        value={value}
        onValueChange={(next) =>
          setConfigValue(mapKey, { ...useDemoConfig.getState()[mapKey], [name]: next })
        }
        accessibilityLabel={chrome.label}
      />
    </RowShell>
  )
})
