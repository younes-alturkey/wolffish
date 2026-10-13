import { useFreshConfig } from '@/lib/sync/useFreshConfig'
import { Button } from '@/components/core/Button'
import {
  AiBrain01Icon,
  CpuIcon,
  Database02Icon,
  HardDriveIcon,
  Pulse01Icon,
  RamMemoryIcon,
  WasteIcon,
  type IconProps
} from '@/components/core/icons'
import { Input } from '@/components/core/Input'
import { Modal } from '@/components/core/Modal'
import { InfoRow, PanelScreen, Section } from '@/components/settings/SettingsUI'
import { factoryResetDevice } from '@/lib/demo/factoryReset'
import { DEFAULT_CACHE_BUDGET_BYTES, enforceCacheBudget } from '@/lib/files/fileCache'
import { dataUsageKey, useDataUsage, type DataUsage } from '@/lib/files/useDataUsage'
import { cn } from '@/lib/utils/cn'
import { formatRelativeTime } from '@/lib/utils/relativeTime'
import { useToast } from '@/providers/toast/useToast'
import { useDesktopData, useDesktopInfo } from '@/state/demoConfig'
import { useQueryClient } from '@tanstack/react-query'
import Constants from 'expo-constants'
import * as Device from 'expo-device'
import { router } from 'expo-router'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Pressable, Text, View } from 'react-native'

/**
 * Data — the desktop DataPanel's numbers first (they travel in the config
 * snapshot: this device cannot measure that machine), then the same card for
 * the phone the app is actually running on, then a factory reset scoped to
 * THIS DEVICE only. Resetting Wolffish itself — the workspace, the memories —
 * is the desktop app's own Data-panel action, and the copy here says so.
 */

type IconComponent = (props: IconProps) => React.JSX.Element

/**
 * Bidi-isolate a value interpolated into localized text — the desktop's
 * ltrIsolate. Without it the Arabic disk sentence captures the total's
 * digits into the Arabic run and strands its unit on the far side.
 */
function bidiIsolate(value: string): string {
  return `\u2068${value}\u2069`
}

/** Desktop formatBytesL's tiers, with its null contract: unknown is an em dash. */
function formatBytes(bytes: number | null | undefined): string {
  if (bytes == null || !Number.isFinite(bytes) || bytes < 0) return '—'
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} GB`
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${bytes} B`
}

export default function DataScreen(): React.JSX.Element {
  // Desktop-owned values: pull the current ones when this screen opens.
  useFreshConfig()
  const { t } = useTranslation()
  const toast = useToast()
  const queryClient = useQueryClient()
  const [releasing, setReleasing] = useState(false)
  const [resetOpen, setResetOpen] = useState(false)

  const { data: usage } = useDataUsage()

  const release = async (): Promise<void> => {
    setReleasing(true)
    try {
      const removed = await enforceCacheBudget(0)
      toast.show({ tone: 'success', message: t('settings.data.released', { count: removed }) })
      void queryClient.invalidateQueries({ queryKey: dataUsageKey })
    } finally {
      setReleasing(false)
    }
  }

  return (
    <PanelScreen title={t('settings.tabs.data')} subtitle={t('settings.data.subtitle')}>
      <DesktopSection />
      <DeviceSection usage={usage} releasing={releasing} onRelease={() => void release()} />
      <FactoryResetCard onOpen={() => setResetOpen(true)} />
      <FactoryResetModal open={resetOpen} onClose={() => setResetOpen(false)} />
    </PanelScreen>
  )
}

/**
 * Everything the desktop DataPanel shows, in its order: disk usage, then the
 * six metric tiles (workspace, knowledge, corpus, prefrontal, RAM, CPU),
 * plus how stale this mirror is — the numbers are from the last sync, not a
 * live probe.
 */
function DesktopSection(): React.JSX.Element {
  const { t } = useTranslation()
  const desktop = useDesktopInfo()
  const data = useDesktopData()

  const syncedAtMs = desktop.syncedAt ? new Date(desktop.syncedAt).getTime() : Number.NaN
  const syncedAt = Number.isNaN(syncedAtMs) ? '—' : formatRelativeTime(syncedAtMs, t)

  // cpuPercent is a share of ONE core (the desktop sums every thread in its
  // process), so divide by the core count — with the desktop panel's own
  // floor: a small real load reads as a small real load, not a dead gauge.
  const cpuShare = data.cpuPercent != null && data.cpuCount ? data.cpuPercent / data.cpuCount : null
  const cpuValue =
    data.cpuPercent == null
      ? '—'
      : cpuShare === null
        ? t('settings.data.metrics.cpuValue', { percent: data.cpuPercent.toFixed(1) })
        : cpuShare > 0 && cpuShare < 0.05
          ? t('settings.data.metrics.cpuValueLow')
          : t('settings.data.metrics.cpuValue', { percent: cpuShare.toFixed(1) })
  const ramValue =
    data.ramBytes == null
      ? '—'
      : `${formatBytes(data.ramBytes)} / ${formatBytes(data.totalRamBytes)}`

  const tiles: Array<{ label: string; value: string; Icon: IconComponent }> = [
    {
      label: t('settings.data.metrics.workspace'),
      value: formatBytes(data.workspaceBytes),
      Icon: HardDriveIcon
    },
    {
      label: t('settings.data.metrics.knowledge'),
      value: formatBytes(data.hippocampusBytes),
      Icon: AiBrain01Icon
    },
    {
      label: t('settings.data.metrics.corpus'),
      value: formatBytes(data.corpusBytes),
      Icon: Database02Icon
    },
    {
      label: t('settings.data.metrics.prefrontal'),
      value: formatBytes(data.prefrontalBytes),
      Icon: Pulse01Icon
    },
    { label: t('settings.data.metrics.ram'), value: ramValue, Icon: RamMemoryIcon },
    { label: t('settings.data.metrics.cpu'), value: cpuValue, Icon: CpuIcon }
  ]

  return (
    <Section title={t('settings.data.desktopTitle')}>
      <Text className="text-muted text-left font-sans text-xs leading-5">
        {t('settings.data.desktopDescription')}
      </Text>
      <DiskUsage free={data.freeDiskBytes} total={data.totalDiskBytes} />
      {[0, 2, 4].map((start) => (
        <View key={start} className="flex-row gap-3">
          {tiles.slice(start, start + 2).map((tile) => (
            <MetricTile key={tile.label} {...tile} />
          ))}
        </View>
      ))}
      <InfoRow label={t('settings.data.syncedAt')} value={syncedAt} code />
    </Section>
  )
}

/**
 * The desktop DiskUsageBar's tiers: <50% used emerald, 50–<80% amber, ≥80%
 * red. One deliberate departure: unknown values draw an EMPTY track, not the
 * desktop's full red bar — there null means a broken probe on a live
 * machine, here it means a bundle from before these numbers shipped.
 */
function DiskUsage({
  free,
  total
}: {
  free: number | null
  total: number | null
}): React.JSX.Element {
  const { t } = useTranslation()
  const known = free != null && total != null && total > 0
  const usedPercent = known ? Math.min(100, Math.max(0, ((total - free) / total) * 100)) : 0
  const fill =
    usedPercent >= 80
      ? 'bg-red-500 dark:bg-red-400'
      : usedPercent >= 50
        ? 'bg-amber-500 dark:bg-amber-400'
        : 'bg-emerald-500 dark:bg-emerald-400'
  return (
    <View className="flex-col gap-1.5">
      <View className="flex-row items-center justify-between gap-3">
        <View className="flex-1 flex-row items-center gap-1.5">
          <HardDriveIcon size={12} className="text-muted" />
          <Text numberOfLines={1} className="text-muted flex-1 text-left font-sans text-xs">
            {t('settings.data.diskUsage', {
              free: bidiIsolate(formatBytes(free)),
              total: bidiIsolate(formatBytes(total))
            })}
          </Text>
        </View>
        <Text className="text-muted font-sans text-xs">
          {known ? `${Math.round(usedPercent)}%` : '—'}
        </Text>
      </View>
      <View
        accessibilityRole="progressbar"
        accessibilityValue={{ min: 0, max: 100, now: Math.round(usedPercent) }}
        className="bg-bg border-border h-1.5 w-full overflow-hidden rounded-full border"
      >
        <View className={cn('h-full rounded-full', fill)} style={{ width: `${usedPercent}%` }} />
      </View>
    </View>
  )
}

function MetricTile({
  label,
  value,
  Icon
}: {
  label: string
  value: string
  Icon: IconComponent
}): React.JSX.Element {
  return (
    <View className="bg-bg border-border flex-1 flex-col gap-1 rounded-xl border p-3">
      <View className="flex-row items-center gap-1.5">
        <Icon size={12} className="text-muted" />
        <Text numberOfLines={1} className="text-muted flex-1 text-left font-sans text-[11px]">
          {label}
        </Text>
      </View>
      {/* Byte and percent figures are LTR technical values — same contract as
          InfoRow's `mono`, minus the mono face the desktop tiles don't use. */}
      <Text
        numberOfLines={1}
        style={{ writingDirection: 'ltr' }}
        className="text-fg font-sans-semibold text-left text-sm"
      >
        {value}
      </Text>
    </View>
  )
}

/** The phone's own card — what this install is, runs on, and has downloaded. */
function DeviceSection({
  usage,
  releasing,
  onRelease
}: {
  usage?: DataUsage
  releasing: boolean
  onRelease: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const version = Constants.expoConfig?.version ?? '?'
  const build =
    Constants.expoConfig?.ios?.buildNumber ?? Constants.expoConfig?.android?.versionCode ?? '?'
  const model = Device.modelName ?? '—'
  const system = [Device.osName, Device.osVersion].filter(Boolean).join(' ') || '—'

  return (
    <Section title={t('settings.data.deviceTitle')}>
      <Text className="text-muted text-left font-sans text-xs leading-5">
        {t('settings.data.deviceDescription')}
      </Text>
      <InfoRow label={t('settings.data.deviceModel')} value={model} />
      <InfoRow label={t('settings.data.deviceSystem')} value={system} code mono />
      <InfoRow label={t('settings.data.appVersion')} value={`v${version} (${build})`} code mono />
      <InfoRow
        label={t('settings.data.cachedMedia')}
        value={formatBytes(usage?.cache.totalBytes)}
      />
      <InfoRow
        label={t('settings.data.cachedFiles')}
        value={usage ? `${usage.cache.fileCount}` : '—'}
      />
      <InfoRow label={t('settings.data.budget')} value={formatBytes(DEFAULT_CACHE_BUDGET_BYTES)} />
      <InfoRow
        label={t('settings.data.conversations')}
        value={usage ? `${usage.conversations}` : '—'}
      />
      <View className="flex-row items-center gap-3">
        <View className="flex-1 flex-col gap-0.5">
          <Text className="text-fg font-sans-medium text-left text-sm">
            {t('settings.data.releaseNow')}
          </Text>
          <Text className="text-muted text-left font-sans text-xs leading-5">
            {t('settings.data.releaseDescription')}
          </Text>
        </View>
        {/* No spinner and no label swap — the disabled dim alone carries the
            busy moment, so the button keeps its identity mid-action. */}
        <Button variant="outline" size="sm" disabled={releasing} onPress={onRelease}>
          {t('settings.data.release')}
        </Button>
      </View>
    </Section>
  )
}

/**
 * The desktop's FactoryResetCard, scoped down: red-tinted affordance, plain
 * words about what it wipes — and that the wipe stops at this phone.
 */
function FactoryResetCard({ onOpen }: { onOpen: () => void }): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <Section>
      <View className="flex-row items-start gap-3">
        <View className="rounded-lg bg-red-500/10 p-2">
          <WasteIcon size={18} className="text-red-600 dark:text-red-400" />
        </View>
        <View className="flex-1 flex-col items-start gap-3">
          <View className="flex-col gap-1">
            <Text className="text-fg font-sans-semibold text-left text-sm">
              {t('settings.data.factoryReset.label')}
            </Text>
            <Text className="text-muted text-left font-sans text-xs leading-5">
              {t('settings.data.factoryReset.description')}
            </Text>
          </View>
          <Pressable
            accessibilityRole="button"
            onPress={onOpen}
            className="h-10 flex-row items-center justify-center rounded-lg border border-red-500/40 bg-red-500/10 px-4 active:bg-red-500/20"
          >
            <Text className="font-sans-medium text-sm text-red-700 dark:text-red-400">
              {t('settings.data.factoryReset.button')}
            </Text>
          </Pressable>
        </View>
      </View>
    </Section>
  )
}

function FactoryResetModal({
  open,
  onClose
}: {
  open: boolean
  onClose: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const toast = useToast()
  const expected = t('settings.data.factoryReset.confirmPhrase')
  const [input, setInput] = useState('')
  const [resetting, setResetting] = useState(false)

  const matches = input.trim() === expected

  const handleClose = (): void => {
    if (resetting) return
    setInput('')
    onClose()
  }

  const onConfirm = async (): Promise<void> => {
    if (!matches || resetting) return
    setResetting(true)
    try {
      await factoryResetDevice()
    } catch {
      setResetting(false)
      toast.show({ tone: 'error', message: t('settings.data.factoryReset.errorToast') })
      return
    }
    toast.show({ tone: 'success', message: t('settings.data.factoryReset.doneToast') })
    // The settings stack now describes a dataset that no longer exists. Home
    // is this device's version of the desktop reset's restart: the blank
    // screen a fresh install boots into, demo door ready.
    try {
      router.dismissAll()
    } catch {
      router.replace('/')
    }
  }

  return (
    <Modal
      open={open}
      onClose={handleClose}
      dismissable={!resetting}
      title={t('settings.data.factoryReset.title')}
      footer={
        <View className="flex-row gap-2">
          <Button variant="ghost" disabled={resetting} onPress={handleClose} className="flex-1">
            {t('settings.data.factoryReset.cancel')}
          </Button>
          {/* Solid-red confirm, hand-rolled: cn() does not resolve class
              conflicts, so overriding a Button variant's background is not a
              safe operation — the composer's stop button sets the precedent. */}
          <Pressable
            accessibilityRole="button"
            disabled={!matches || resetting}
            onPress={() => void onConfirm()}
            className={cn(
              'h-10 flex-1 flex-row items-center justify-center gap-2 rounded-lg bg-red-600 active:bg-red-700',
              (!matches || resetting) && 'opacity-50'
            )}
          >
            {/* Nothing joins the label mid-reset — the opacity dim above is
                the busy signal, so the text never shifts inside the button. */}
            <Text className="font-sans-medium text-sm text-white">
              {t('settings.data.factoryReset.confirm')}
            </Text>
          </Pressable>
        </View>
      }
    >
      <Text className="text-fg text-left font-sans text-sm leading-relaxed">
        {t('settings.data.factoryReset.warning')}
      </Text>
      <Text className="text-muted text-left font-sans text-xs leading-5">
        {t('settings.data.factoryReset.typePrompt', { phrase: expected })}
      </Text>
      <Input
        value={input}
        onChangeText={setInput}
        placeholder={expected}
        autoCapitalize="characters"
        autoCorrect={false}
        editable={!resetting}
      />
    </Modal>
  )
}
