import {
  ComputerTerminal01Icon,
  Folder01Icon,
  HeartCheckIcon,
  PlayListIcon
} from '@/components/core/icons'
import { SegmentedTabs } from '@/components/core/SegmentedTabs'
import { AutomationsTab } from '@/components/library/AutomationsTab'
import { ProceduresTab } from '@/components/library/ProceduresTab'
import { ProcessesTab } from '@/components/library/ProcessesTab'
import { ProjectsTab } from '@/components/library/ProjectsTab'
import { PanelScreen } from '@/components/settings/SettingsUI'
import { useFreshConfig } from '@/lib/sync/useFreshConfig'
import { useLocalSearchParams } from 'expo-router'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

type Tab = 'automations' | 'projects' | 'procedures' | 'processes'

const TABS: readonly {
  key: Tab
  icon: (props: { size: number; className: string }) => React.JSX.Element
  labelKey: string
  subtitleKey: string
}[] = [
  {
    key: 'automations',
    icon: (p) => <HeartCheckIcon {...p} />,
    labelKey: 'settings.tabs.automations',
    subtitleKey: 'heartbeat.subtitle'
  },
  {
    key: 'projects',
    icon: (p) => <Folder01Icon {...p} />,
    labelKey: 'settings.tabs.projects',
    subtitleKey: 'projects.subtitle'
  },
  {
    key: 'procedures',
    icon: (p) => <PlayListIcon {...p} />,
    labelKey: 'settings.tabs.procedures',
    subtitleKey: 'procedures.subtitle'
  },
  {
    key: 'processes',
    icon: (p) => <ComputerTerminal01Icon {...p} />,
    labelKey: 'settings.tabs.processes',
    subtitleKey: 'processes.subtitle'
  }
]

function isTab(value: unknown): value is Tab {
  return TABS.some((tab) => tab.key === value)
}

/**
 * The tab you left on, for the next visit. Module-level rather than state:
 * the screen unmounts on Back, and coming back to Procedures after a detour
 * through chat should land on Procedures, not reset to the first tab every
 * time. A deep link naming a tab (`?tab=`) still wins over it — the link is
 * the newer intent.
 */
let lastTab: Tab = 'automations'

/**
 * Library — Automations, Projects and Procedures as one screen with three
 * tabs, the desktop's Library page.
 *
 * The same move Customization made for Soul, User and Agents: three sheet
 * rows that each opened a near-identical card list under its own back button
 * become one destination. The tabs sit in a strip pinned under the header
 * (the desktop puts them beside its back button; a phone header has no room
 * for three labelled tabs at a tappable size), and the three tabs keep their
 * own state, loads and editor sheets — this screen only owns the chrome they
 * used to duplicate.
 *
 * Only the active tab is mounted, and the screen is keyed by it: there is no
 * draft to keep warm across tabs — each is a list over a file the desktop
 * pushes changes for, so remounting is a cheap reload — and a fresh scroller
 * per tab is what keeps Projects from opening halfway down where Automations
 * was left.
 *
 * The old routes (settings/projects, settings/automations, settings/procedures)
 * still exist as redirects into this one with the tab preselected: they are on
 * the two-repo deep-link allowlist, and a notification the desktop sends
 * naming one of them must keep landing on the right list.
 */
export default function LibraryScreen(): React.JSX.Element {
  const { t } = useTranslation()
  const params = useLocalSearchParams<{ tab?: string }>()
  // Projects also ride the config snapshot (the chat picker reads them there)
  // and every tab falls back to it when unpaired — so refresh it on focus like
  // every other screen rendering desktop-owned values.
  useFreshConfig()
  const [active, setActive] = useState<Tab>(() => (isTab(params.tab) ? params.tab : lastTab))
  useEffect(() => {
    lastTab = active
  }, [active])

  const current = TABS.find((tab) => tab.key === active) ?? TABS[0]

  return (
    <PanelScreen
      key={active}
      title={t('settings.tabs.library')}
      subtitle={t(current.subtitleKey)}
      tabs={
        <SegmentedTabs
          value={active}
          accessibilityLabel={t('settings.tabs.library')}
          options={TABS.map((tab) => ({ value: tab.key, label: t(tab.labelKey), icon: tab.icon }))}
          onChange={setActive}
        />
      }
    >
      {active === 'automations' ? (
        <AutomationsTab />
      ) : active === 'projects' ? (
        <ProjectsTab />
      ) : active === 'processes' ? (
        <ProcessesTab />
      ) : (
        <ProceduresTab />
      )}
    </PanelScreen>
  )
}
