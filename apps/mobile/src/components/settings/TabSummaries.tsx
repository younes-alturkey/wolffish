import {
  BrowserIcon,
  ComputerIcon,
  ComputerTerminal01Icon,
  SmartPhone01Icon,
  TelegramLogo,
  WhatsAppLogo
} from '@/components/core/icons'
import { CodeChip } from '@/components/settings/SettingsUI'
import { formatBytes } from '@/lib/files/fileKinds'
import { useDataUsage } from '@/lib/files/useDataUsage'
import { computeUsageStats } from '@/lib/usage/stats'
import { cn } from '@/lib/utils/cn'
import { formatTokens } from '@/lib/utils/formatTokens'
import { formatShortWait, minutesUntilHour } from '@/lib/utils/schedule'
import { useLocale } from '@/providers/locale/useLocale'
import { useTheme } from '@/providers/theme/useTheme'
import {
  useConfigValue,
  useDemoConfig,
  useDesktopData,
  useDesktopInfo,
  useUsageDays
} from '@/state/demoConfig'
import Constants from 'expo-constants'
import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Text, View } from 'react-native'

/**
 * What each settings tab is worth knowing without opening it — the one figure
 * or state that answers "do I need to go in there?", rendered at the trailing
 * edge of its NavRow.
 *
 * One component per tab rather than one hook-heavy list screen, so the demo
 * config store's single-field subscription contract holds: flipping a
 * capability re-renders the capabilities summary, not the whole settings list.
 * Each one is also responsible for its own shrink behaviour — the row gives
 * the trailing slot no wrapper — so a long value truncates itself instead of
 * pushing the chevron off the row.
 */

const TONES = {
  muted: 'text-muted',
  ok: 'text-emerald-600 dark:text-emerald-400',
  warn: 'text-amber-600 dark:text-amber-400'
} as const

/** A summary that is words rather than a value: muted unless it is a state. */
function Note({
  children,
  tone = 'muted'
}: {
  children: string
  tone?: keyof typeof TONES
}): React.JSX.Element {
  return (
    <Text numberOfLines={1} className={cn('shrink font-sans text-xs', TONES[tone])}>
      {children}
    </Text>
  )
}

/**
 * Model — the brain and the mode it answers in. Only the model id truncates:
 * it is the long half and the one whose tail ("-4-8") matters least, while the
 * mode is two words that change what the app does.
 */
export function ModelSummary(): React.JSX.Element {
  const { t } = useTranslation()
  const model = useConfigValue('brainModel')
  const mode = useConfigValue('chatMode')
  return (
    <View className="max-w-[55%] shrink flex-row items-center gap-1">
      <Text
        numberOfLines={1}
        style={{ writingDirection: 'ltr' }}
        className="text-muted shrink font-mono text-xs"
      >
        {model}
      </Text>
      {/* The separator is its own node so RTL mirrors the pair by flex order
          rather than by where a "·" landed inside a bidi string. */}
      <Text className="text-muted shrink-0 font-sans text-xs">·</Text>
      <Text className="text-muted shrink-0 font-sans text-xs">
        {t(`settings.chatModes.${mode}`)}
      </Text>
    </View>
  )
}

/**
 * Channels — this phone, the terminal, the browser and the two bridges, as
 * their own marks. A channel the agent can actually reach you on is green; one
 * it cannot stays muted rather than disappearing, so the row says "WhatsApp is
 * off" instead of leaving you to wonder whether it exists.
 *
 * The phone leads, in the desktop's own channel order, and reads its
 * notifications switch: reachable is the question all five answer, and for
 * this device the answer is whether notify_phone is allowed to ring it. Being
 * paired is not the signal — you are looking at the app, so you know.
 *
 * The browser's mark answers it the desktop's way: green when a browser has
 * the extension connected, which is the one thing that has to be true before
 * the agent can do anything in it — how MUCH it can do there is the readiness
 * row's business, inside the screen.
 *
 * The terminal's mark answers that same question its own way: green when a
 * shell on the desktop can resolve `wolffish`, because a command the shell
 * cannot find is a channel you cannot reach the agent on, whatever config
 * says. Unknown (the desktop never answered) reads muted with the rest —
 * the row is a glance, and a third colour here would be a puzzle, not a fact.
 */
export function ChannelsSummary(): React.JSX.Element {
  const { t } = useTranslation()
  const phone = useConfigValue('mobileNotifications')
  const cli = useDemoConfig((state) => state.cli.pathInstalled === true)
  const browser = useDemoConfig((state) =>
    state.services.some((service) => service.key === 'browserExtension' && service.connected)
  )
  const telegram = useConfigValue('telegramEnabled')
  const whatsapp = useConfigValue('whatsappEnabled')
  const state = (on: boolean): string => (on ? t('settings.toggle.on') : t('settings.toggle.off'))
  return (
    <View
      className="shrink-0 flex-row items-center gap-2"
      accessibilityLabel={`${t('settings.channels.notifications')} ${state(phone)}, ${t(
        'settings.channels.cli.title'
      )} ${state(cli)}, ${t('settings.channels.browser.title')} ${state(
        browser
      )}, Telegram ${state(telegram)}, WhatsApp ${state(whatsapp)}`}
    >
      <SmartPhone01Icon size={15} className={phone ? TONES.ok : TONES.muted} />
      <ComputerTerminal01Icon size={15} className={cli ? TONES.ok : TONES.muted} />
      <BrowserIcon size={15} className={browser ? TONES.ok : TONES.muted} />
      <TelegramLogo size={15} className={telegram ? TONES.ok : TONES.muted} />
      <WhatsAppLogo size={15} className={whatsapp ? TONES.ok : TONES.muted} />
    </View>
  )
}

/**
 * Services — how many are actually live, out of the ones that can be. The
 * account links carry a connection the desktop reports; Brave, video and memes
 * carry a switch. Speech-to-text and text-to-speech are neither: they are
 * always-on settings, so counting them would only ever add a constant.
 *
 * The browser extension is skipped even though the desktop still reports it in
 * the same services map: it is a channel now (Channels › Browser), and a
 * denominator that counts a panel the screen does not have is a count nobody
 * can check against what they see.
 */
export function ServicesSummary(): React.JSX.Element {
  // Filtered in the body, not in the selector: a selector that builds a new
  // array every call hands useSyncExternalStore an unstable snapshot.
  const all = useDemoConfig((state) => state.services)
  const services = all.filter((service) => service.key !== 'browserExtension')
  const brave = useConfigValue('braveEnabled')
  const video = useConfigValue('videoEnabled')
  const memes = useConfigValue('memesEnabled')
  const switches = [brave, video, memes]
  const on =
    services.filter((service) => service.connected).length + switches.filter(Boolean).length
  return <CodeChip mono className="shrink-0" value={`${on}/${services.length + switches.length}`} />
}

/** MCP — servers switched on, out of those the desktop has configured. */
export function McpSummary(): React.JSX.Element {
  const servers = useDemoConfig((state) => state.mcpServers)
  const names = Object.keys(servers)
  return (
    <CodeChip
      mono
      className="shrink-0"
      value={`${names.filter((name) => servers[name]).length}/${names.length}`}
    />
  )
}

/** Variables — a plain count: a variable is defined or it is not. */
export function VariablesSummary(): React.JSX.Element {
  const variables = useConfigValue('variables')
  return <CodeChip mono className="shrink-0" value={`${variables.length}`} />
}

/** Capabilities — active out of installed, the desktop's own active/inactive. */
export function CapabilitiesSummary(): React.JSX.Element {
  const capabilities = useDemoConfig((state) => state.capabilities)
  const names = Object.keys(capabilities)
  return (
    <CodeChip
      mono
      className="shrink-0"
      value={`${names.filter((name) => capabilities[name]).length}/${names.length}`}
    />
  )
}

/**
 * Knowledge — when the next two nightly passes fire, in the desktop's zone.
 * Both waits are labelled because "4h · 22h" alone leaves the reader to guess
 * which pass is which, and the whole point is not having to open the tab.
 */
export function KnowledgeSummary(): React.JSX.Element {
  const { t } = useTranslation()
  const dailyHour = useConfigValue('compactionDailyHour')
  const reflectionHour = useConfigValue('reflectionHour')
  const { timezone } = useDesktopInfo()
  // Same 60s tick as the Knowledge panel's own next-run chip: a settings list
  // left open must not keep claiming the wait it had when it mounted.
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 60_000)
    return () => clearInterval(id)
  }, [])

  const compaction = formatShortWait(minutesUntilHour(dailyHour, timezone, now), t)
  const reflection = formatShortWait(minutesUntilHour(reflectionHour, timezone, now), t)
  return (
    <Note>{`${t('settings.summary.compaction')} ${compaction} · ${t('settings.summary.reflection')} ${reflection}`}</Note>
  )
}

/** Usage — what today has cost in tokens, the ledger's headline figure. */
export function UsageSummary(): React.JSX.Element {
  const { t } = useTranslation()
  const { locale } = useLocale()
  const days = useUsageDays()
  // Cheap enough to recompute per render (one pass over day rows) and immune
  // to the stale-`now` a memo over `days` would freeze in at midnight.
  const { totalTokens } = computeUsageStats(days, 'today', new Date())
  return <Note>{t('settings.summary.today', { value: formatTokens(totalTokens, locale) })}</Note>
}

/**
 * Data — the two figures the panel opens with, in its own order: the
 * workspace's size on the desktop, then what this phone has downloaded.
 * Same tiers the Data screen prints, and the same em dash on the desktop
 * side when no snapshot has landed — this device cannot measure that
 * machine. The phone's side is a measurement, so it stays an em dash only
 * while the query is in flight and reads `0 B` once it answers with nothing.
 */
export function DataSummary(): React.JSX.Element {
  const { workspaceBytes } = useDesktopData()
  const { data: usage } = useDataUsage()
  const desktop = formatBytes(workspaceBytes) || '—'
  const device = usage ? formatBytes(usage.cache.totalBytes) || '0 B' : '—'
  return <CodeChip mono className="shrink-0" value={`${desktop} · ${device}`} />
}

/**
 * Updates — both builds, each behind its device's mark: this phone's version,
 * then the paired desktop's. The build number stays on the screen itself —
 * two versions already fill the slot, and "which apps, how far apart" is the
 * question this row answers from the list. The desktop half reads an em dash
 * until a snapshot has landed: this device cannot know that machine's build.
 */
export function UpdatesSummary(): React.JSX.Element {
  const { t } = useTranslation()
  const version = Constants.expoConfig?.version ?? '?'
  const desktop = useDesktopInfo()
  const desktopVersion = desktop.version ? `v${desktop.version}` : '—'
  return (
    <View
      className="shrink-0 flex-row items-center gap-1.5"
      accessibilityLabel={`${t('settings.updates.thisAppTitle')} v${version}, ${t(
        'settings.updates.desktopTitle'
      )} ${desktopVersion}`}
    >
      <SmartPhone01Icon size={13} className="text-muted" />
      <CodeChip mono value={`v${version}`} />
      <ComputerIcon size={13} className="text-muted" />
      <CodeChip mono value={desktopVersion} />
    </View>
  )
}

/**
 * Preferences — whether the desktop comes up on its own, and whether the agent
 * still stops to ask, in the panel's own order.
 *
 * Both halves are stated in colour rather than merely printed: these are the
 * two preferences whose off state changes what the machine does on its own —
 * one run stops to ask, the other never starts — and a word in amber says so
 * from the list, without opening the tab.
 *
 * Two Texts and a separator node rather than one string, so each half carries
 * its own tone and RTL mirrors the pair by flex order instead of by where the
 * "·" landed inside a bidi run.
 */
export function PreferencesSummary(): React.JSX.Element {
  const { t } = useTranslation()
  const startup = useConfigValue('launchAtStartup')
  const bypass = useConfigValue('bypassPermissions')
  const state = (on: boolean): string => (on ? t('settings.toggle.on') : t('settings.toggle.off'))
  const tone = (on: boolean): 'ok' | 'warn' => (on ? 'ok' : 'warn')
  return (
    <View className="max-w-[60%] shrink flex-row items-center gap-1">
      <Note tone={tone(startup)}>{`${t('settings.summary.startup')} ${state(startup)}`}</Note>
      <Text className="text-muted shrink-0 font-sans text-xs">·</Text>
      <Note tone={tone(bypass)}>{`${t('settings.summary.bypass')} ${state(bypass)}`}</Note>
    </View>
  )
}

/**
 * Appearance — the theme SOURCE, not the scheme it resolved to: "System" is
 * the choice that was made, and whether it currently reads dark is already
 * visible on the screen saying so.
 */
export function AppearanceSummary(): React.JSX.Element {
  const { t } = useTranslation()
  const { theme } = useTheme()
  const { locale } = useLocale()
  return <Note>{`${t(`theme.${theme}`)} · ${locale.toUpperCase()}`}</Note>
}
