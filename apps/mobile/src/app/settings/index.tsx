import {
  AiMagicIcon,
  AnalyticsUpIcon,
  ArrowUp02Icon,
  BrainIcon,
  BubbleChatIcon,
  Database02Icon,
  DnaIcon,
  Key01Icon,
  McpServerIcon,
  Globe02Icon,
  NeuralNetworkIcon,
  PaintBoardIcon,
  PuzzleIcon
} from '@/components/core/icons'
import {
  AppearanceSummary,
  CapabilitiesSummary,
  ChannelsSummary,
  DataSummary,
  KnowledgeSummary,
  McpSummary,
  ModelSummary,
  PreferencesSummary,
  ServicesSummary,
  UpdatesSummary,
  UsageSummary,
  VariablesSummary
} from '@/components/settings/TabSummaries'
import { NavRow, PanelScreen, type StatusTone } from '@/components/settings/SettingsUI'
import { useFreshConfig } from '@/lib/sync/useFreshConfig'
import { describeTunnelStatus, useTunnelStatus } from '@/lib/tunnel/useTunnelStatus'
import { useAppStore } from '@/state/appStore'
import { router } from 'expo-router'
import { useTranslation } from 'react-i18next'
import { View } from 'react-native'

/**
 * Settings root — the desktop's settings sidebar as a nav list: same tab
 * order, same hugeicons per tab (Settings.tsx TABS), live state summaries.
 *
 * Every row ends in the one figure or state that tab is about, so the list
 * answers "is anything worth opening?" on its own — the desktop sidebar can
 * afford bare labels beside the panel it is already showing; a phone screen
 * that only shows the labels is a menu you have to walk to read.
 */
export default function SettingsScreen(): React.JSX.Element {
  const { t } = useTranslation()
  // The summaries below are the desktop's values, so this list now needs the
  // same on-focus refresh every screen rendering them takes.
  useFreshConfig()
  const paired = useAppStore((state) => state.paired)
  // Demo mode has no tunnel, but it does have a Relay screen now — the tour's
  // made-up link (lib/demo/relay) — so the row shows there too, wearing the
  // connected face that screen always describes.
  const demoMode = useAppStore((state) => state.demoMode)
  // The link's state is the one thing on this list worth knowing before you
  // tap anything: a stale phone explains every other screen, and the
  // connecting overlay is dismissible, so "not connected" has to be legible
  // from here rather than only from inside Relay.
  const relayStatus = useTunnelStatus()

  const rows: Array<{
    key: string
    href: string
    icon: React.JSX.Element
    trailing?: React.JSX.Element
    status?: { tone: StatusTone; label: string }
  }> = [
    ...(paired || demoMode
      ? [
          {
            key: 'relay',
            href: '/settings/relay',
            // The globe the pairing sheet uses for the relay row — and no
            // longer the brain, which belongs to Model two rows down.
            icon: <Globe02Icon size={18} className="text-muted" />,
            status: demoMode
              ? describeTunnelStatus('connected', t)
              : { tone: relayStatus.tone, label: relayStatus.label }
          }
        ]
      : []),
    // The Library, Customization and the Conversations page are NOT here. They
    // are things the user MAKES with the app rather than knobs on it, and they
    // are reached from the conversations sheet in chat — one tap from the only
    // screen the app really has, instead of two through a list of settings.
    {
      key: 'model',
      href: '/settings/model',
      icon: <NeuralNetworkIcon size={18} className="text-muted" />,
      trailing: <ModelSummary />
    },
    {
      key: 'channels',
      href: '/settings/channels',
      icon: <BubbleChatIcon size={18} className="text-muted" />,
      trailing: <ChannelsSummary />
    },
    {
      key: 'services',
      href: '/settings/services',
      icon: <PuzzleIcon size={18} className="text-muted" />,
      trailing: <ServicesSummary />
    },
    {
      key: 'mcp',
      href: '/settings/mcp',
      icon: <McpServerIcon size={18} className="text-muted" />,
      trailing: <McpSummary />
    },
    {
      key: 'variables',
      href: '/settings/variables',
      icon: <Key01Icon size={18} className="text-muted" />,
      trailing: <VariablesSummary />
    },
    {
      key: 'capabilities',
      href: '/settings/capabilities',
      icon: <BrainIcon size={18} className="text-muted" />,
      trailing: <CapabilitiesSummary />
    },
    {
      key: 'knowledge',
      href: '/settings/knowledge',
      icon: <DnaIcon size={18} className="text-muted" />,
      trailing: <KnowledgeSummary />
    },
    {
      key: 'usage',
      href: '/settings/usage',
      icon: <AnalyticsUpIcon size={18} className="text-muted" />,
      trailing: <UsageSummary />
    },
    {
      key: 'data',
      href: '/settings/data',
      icon: <Database02Icon size={18} className="text-muted" />,
      trailing: <DataSummary />
    },
    {
      key: 'updates',
      href: '/settings/updates',
      icon: <ArrowUp02Icon size={18} className="text-muted" />,
      trailing: <UpdatesSummary />
    },
    {
      key: 'preferences',
      href: '/settings/preferences',
      icon: <AiMagicIcon size={18} className="text-muted" />,
      trailing: <PreferencesSummary />
    },
    {
      key: 'appearance',
      href: '/settings/appearance',
      icon: <PaintBoardIcon size={18} className="text-muted" />,
      trailing: <AppearanceSummary />
    }
  ]

  return (
    <PanelScreen title={t('settings.title')}>
      <View className="flex-col gap-2">
        {rows.map((row) => (
          <NavRow
            key={row.key}
            label={t(`settings.tabs.${row.key}`)}
            icon={row.icon}
            status={row.status}
            trailing={row.trailing}
            onPress={() => router.push(row.href as never)}
          />
        ))}
      </View>
    </PanelScreen>
  )
}
