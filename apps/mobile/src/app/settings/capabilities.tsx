import { setCapabilityEnabled } from '@/lib/sync/sync'
import { useFreshConfig } from '@/lib/sync/useFreshConfig'
import { Badge } from '@/components/core/Badge'
import {
  CheckmarkBadge01Icon,
  HelpCircleIcon,
  SecurityCheckIcon,
  SquareLock02Icon
} from '@/components/core/icons'
import { Toggle } from '@/components/settings/ConfigRows'
import { PanelScreen, Section } from '@/components/settings/SettingsUI'
import { cn } from '@/lib/utils/cn'
import { useDemoConfig } from '@/state/demoConfig'
import { memo } from 'react'
import { useTranslation } from 'react-i18next'
import { Text, View } from 'react-native'

/**
 * Capabilities — every capability from the real workspace's cerebellum, with
 * the name and description from its SKILL.md and the desktop's badge row:
 * active/inactive state, then core/official/unknown provenance, plus its
 * under-description chips (plugin, tool count, requires). Toggles are
 * fully controllable except for core capabilities, which the desktop locks on
 * (LOCKED_CAPABILITIES); import/delete stay on the desktop. While paired,
 * each flip applies on the desktop live over the tunnel and its panel moves
 * in step; demo mode keeps the edit local.
 */
export default function CapabilitiesScreen(): React.JSX.Element {
  // Desktop-owned values: pull the current ones when this screen opens.
  useFreshConfig()
  const { t } = useTranslation()
  // Metadata is snapshot-static; each row's TOGGLE subscribes on its own.
  const capabilityInfo = useDemoConfig((state) => state.capabilityInfo)
  // Alphabetical, but always-on (core) capabilities sink to the bottom.
  const names = Object.keys(capabilityInfo).sort(
    (a, b) => Number(capabilityInfo[a].core) - Number(capabilityInfo[b].core) || a.localeCompare(b)
  )

  return (
    <PanelScreen
      title={t('settings.tabs.capabilities')}
      subtitle={t('settings.capabilities.subtitle', { count: names.length })}
    >
      <View className="flex-col gap-3">
        {names.map((name) => (
          <CapabilityRow
            key={name}
            name={name}
            description={capabilityInfo[name].description}
            official={capabilityInfo[name].official}
            core={capabilityInfo[name].core}
            hasPlugin={capabilityInfo[name].hasPlugin}
            toolCount={capabilityInfo[name].toolCount}
            requires={capabilityInfo[name].requires}
          />
        ))}
      </View>
    </PanelScreen>
  )
}

/**
 * One capability card. Subscribes to its own entry in the capabilities map, so
 * flipping one toggle re-renders that card alone. The badge row mirrors the
 * desktop panel: provenance only shows while the capability is active, same as
 * `cap.enabled && isOk` there.
 */
const CapabilityRow = memo(function CapabilityRow({
  name,
  description,
  official,
  core,
  hasPlugin,
  toolCount,
  requires
}: {
  name: string
  description: string
  official: boolean
  core: boolean
  hasPlugin: boolean
  toolCount: number
  requires: string[]
}): React.JSX.Element {
  const { t } = useTranslation()
  const stored = useDemoConfig((state) => state.capabilities[name] ?? false)
  const enabled = core || stored

  return (
    <Section className={cn('gap-2 p-3', !enabled && 'opacity-50')}>
      <View className="flex-row items-center gap-3">
        <Text className="text-fg font-sans-medium flex-1 text-left text-sm">{name}</Text>
        {core ? (
          <View
            accessibilityLabel={t('settings.capabilities.alwaysOn')}
            accessibilityHint={t('settings.capabilities.lockedHint')}
            className="border-border bg-bg flex-row items-center gap-1.5 rounded-lg border px-3 py-1.5"
          >
            <SquareLock02Icon size={12} className="text-muted" />
            <Text className="text-muted font-sans-medium text-xs">
              {t('settings.capabilities.alwaysOn')}
            </Text>
          </View>
        ) : (
          <Toggle
            // Optimistic locally, applied on the desktop over the tunnel;
            // a refused or failed write snaps the switch back (lib/sync).
            value={enabled}
            onValueChange={(next) => setCapabilityEnabled(name, next)}
            accessibilityLabel={name}
          />
        )}
      </View>

      <View className="flex-row flex-wrap items-center gap-1.5">
        {enabled ? (
          <Badge
            label={t('settings.capabilities.active')}
            icon={CheckmarkBadge01Icon}
            variant="success"
          />
        ) : (
          <Badge label={t('settings.capabilities.inactive')} />
        )}
        {enabled &&
          (core ? (
            <Badge
              label={t('settings.capabilities.core')}
              icon={SquareLock02Icon}
              variant="primary"
            />
          ) : official ? (
            <Badge
              label={t('settings.capabilities.official')}
              icon={SecurityCheckIcon}
              variant="primary"
            />
          ) : (
            <Badge label={t('settings.capabilities.unknown')} icon={HelpCircleIcon} />
          ))}
      </View>

      {description ? (
        <Text className="text-muted text-left font-sans text-xs leading-5">{description}</Text>
      ) : null}

      {(hasPlugin || toolCount > 0 || requires.length > 0) && (
        <View className="flex-row flex-wrap items-center gap-1.5">
          {hasPlugin && <Chip label={t('settings.capabilities.plugin')} />}
          {toolCount > 0 && <Chip label={t('settings.capabilities.tools', { count: toolCount })} />}
          {requires.length > 0 && (
            <Chip label={t('settings.capabilities.requires', { deps: requires.join(', ') })} />
          )}
        </View>
      )}
    </Section>
  )
})

/**
 * The desktop's under-description capability chip (`bg-border/30` there) — a
 * borderless mini-tag, one notch quieter than Badge. Solid `surface-soft`
 * stands in for the desktop's alpha fill, which RN drops over var() colors.
 */
function Chip({ label }: { label: string }): React.JSX.Element {
  return (
    <View className="bg-surface-soft rounded px-1.5 py-0.5">
      <Text className="text-muted font-sans-medium text-left text-[10px]">{label}</Text>
    </View>
  )
}
