import { Button } from '@/components/core/Button'
import { Activity04Icon, PlayIcon } from '@/components/core/icons'
import { Select, type SelectOption } from '@/components/core/Select'
import { PanelScreen, Section } from '@/components/settings/SettingsUI'
import { pushReflectionConfig, runReflectionJob } from '@/lib/sync/reflection'
import { useFreshConfig } from '@/lib/sync/useFreshConfig'
import { formatTokens } from '@/lib/utils/formatTokens'
import { minutesUntilHour } from '@/lib/utils/schedule'
import { useToast } from '@/providers/toast/useToast'
import {
  setConfigValue,
  useCompactionRuns,
  useConfigValue,
  useDesktopInfo,
  useSettingsReadOnly,
  type CompactionRunRecord
} from '@/state/demoConfig'
import { useAppStore } from '@/state/appStore'
import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ScrollView, Text, View } from 'react-native'

/**
 * Knowledge — the desktop's two Knowledge panels on one column. Compaction
 * (the desktop CompactionPanel): when the daily compaction and weekly
 * consolidation run. Reflection (the desktop ReflectionPanel): the nightly
 * self-review's hour and quiet gate, and the monthly deep reflection. Every
 * schedule control writes through to the paired desktop — compaction over
 * the generic configSet path (setConfigValue), reflection over its own RPC
 * (lib/sync/reflection) — and stays local in demo mode; the last-run cards
 * are read-only records the desktop's brainstem wrote, carried in the
 * config snapshot.
 */
export default function KnowledgeScreen(): React.JSX.Element {
  // Desktop-owned values: pull the current ones when this screen opens.
  useFreshConfig()
  const { t, i18n } = useTranslation()
  const locale = i18n.language || 'en'
  const toast = useToast()
  const paired = useAppStore((state) => state.paired)
  const readOnly = useSettingsReadOnly()
  const dailyHour = useConfigValue('compactionDailyHour')
  const weeklyDay = useConfigValue('compactionWeeklyDay')
  const weeklyHour = useConfigValue('compactionWeeklyHour')
  const reflectionHour = useConfigValue('reflectionHour')
  const reflectionQuietHours = useConfigValue('reflectionQuietHours')
  const runs = useCompactionRuns()
  const desktop = useDesktopInfo()

  const [running, setRunning] = useState<'reflection' | 'deepClean' | null>(null)
  // Tick every 60s so the clock card and the "next run" chip stay fresh.
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 60_000)
    return () => clearInterval(id)
  }, [])

  const hourOptions = useMemo<readonly SelectOption<string>[]>(
    () =>
      Array.from({ length: 24 }, (_, hour) => ({
        value: `${hour}`,
        label: `${hour.toString().padStart(2, '0')}:00`
      })),
    []
  )
  const dayKeys = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday']
  const dayOptions = useMemo<readonly SelectOption<string>[]>(
    () => dayKeys.map((key, index) => ({ value: `${index}`, label: t(`settings.days.${key}`) })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [t]
  )
  const quietOptions = useMemo<readonly SelectOption<string>[]>(
    () =>
      QUIET_HOUR_CHOICES.map((hours) => ({
        value: `${hours}`,
        label: t('settings.knowledge.reflection.quietHoursOption', { count: hours })
      })),
    [t]
  )

  const runNow = async (kind: 'reflection' | 'deepClean'): Promise<void> => {
    if (running) return
    setRunning(kind)
    try {
      if (!paired) {
        // Demo mode has no brainstem to enqueue on — the tap acknowledges,
        // and the bundled last-run cards below are the show.
        toast.show({ tone: 'success', message: t('settings.knowledge.reflection.runStarted') })
        return
      }
      const result = await runReflectionJob(kind)
      if (result === null) {
        toast.show({ tone: 'error', message: t('settings.knowledge.reflection.runError') })
      } else if (result === 'coalesced') {
        toast.show({ tone: 'info', message: t('settings.knowledge.reflection.runAlready') })
      } else {
        toast.show({ tone: 'success', message: t('settings.knowledge.reflection.runStarted') })
      }
    } finally {
      setRunning(null)
    }
  }

  const nextRunLabel = t('settings.knowledge.reflection.nextRun', {
    time: formatFromNow(minutesUntilHour(reflectionHour, desktop.timezone, now), locale)
  })

  return (
    <PanelScreen title={t('settings.tabs.knowledge')} subtitle={t('settings.knowledge.subtitle')}>
      {/* The desktop's clock, first: every schedule on this page — compaction,
          consolidation, reflection — fires in ITS timezone, so the zone is the
          frame for everything below. Absent until a snapshot carries the zone —
          never a guessed clock. */}
      {desktop.timezone ? (
        <Section className="gap-3">
          <View className="flex-row items-center justify-between gap-3">
            <Text className="text-fg font-sans-medium text-left text-sm">
              {formatDesktopTime(now, locale, desktop.timezone)}
            </Text>
            <Chip>{desktop.timezone}</Chip>
          </View>
        </Section>
      ) : null}

      {/* Disabled while paired-but-offline like the reflection rows below:
          these write through configSet now, and a picker whose choice cannot
          land anywhere would swallow the tap. */}
      <Section title={t('settings.knowledge.dailyTitle')}>
        <Select<string>
          label={t('settings.knowledge.dailyHour')}
          value={`${dailyHour}`}
          options={hourOptions}
          disabled={readOnly}
          onChange={(value) => setConfigValue('compactionDailyHour', Number(value))}
        />
      </Section>
      <Section title={t('settings.knowledge.weeklyTitle')}>
        <Select<string>
          label={t('settings.knowledge.weeklyDay')}
          value={`${weeklyDay}`}
          options={dayOptions}
          disabled={readOnly}
          onChange={(value) => setConfigValue('compactionWeeklyDay', Number(value))}
        />
        <Select<string>
          label={t('settings.knowledge.weeklyHour')}
          value={`${weeklyHour}`}
          options={hourOptions}
          disabled={readOnly}
          onChange={(value) => setConfigValue('compactionWeeklyHour', Number(value))}
        />
      </Section>
      {/* Absent entirely until a job has actually run — same as the desktop. */}
      {runs.daily ? (
        <LastRunCard
          title={t('settings.knowledge.lastRun.dailyTitle')}
          record={runs.daily}
          locale={locale}
        />
      ) : null}
      {runs.weekly ? (
        <LastRunCard
          title={t('settings.knowledge.lastRun.weeklyTitle')}
          record={runs.weekly}
          locale={locale}
        />
      ) : null}

      {/* ── Reflection — the desktop ReflectionPanel ──────────────────── */}
      <View className="mt-2 flex-col gap-1">
        <Text className="text-fg font-sans-semibold text-left text-base">
          {t('settings.knowledge.reflection.title')}
        </Text>
        <Text className="text-muted text-left font-sans text-sm leading-relaxed">
          {t('settings.knowledge.reflection.subtitle')}
        </Text>
      </View>

      <Section title={t('settings.knowledge.reflection.nightly.label')}>
        <Text className="text-muted text-left font-sans text-xs leading-5">
          {t('settings.knowledge.reflection.nightly.description')}
        </Text>
        <Select<string>
          label={t('settings.knowledge.reflection.hour')}
          value={`${reflectionHour}`}
          options={hourOptions}
          disabled={readOnly}
          onChange={(value) => {
            setConfigValue('reflectionHour', Number(value))
            pushReflectionConfig({ hour: Number(value) })
          }}
        />
        <View className="flex-row items-center justify-between gap-3">
          <Chip>{nextRunLabel}</Chip>
          <RunNowButton
            label={t('settings.knowledge.reflection.runNow')}
            disabled={readOnly || running !== null}
            onPress={() => void runNow('reflection')}
          />
        </View>
      </Section>

      <Section title={t('settings.knowledge.reflection.quiet.label')}>
        <Text className="text-muted text-left font-sans text-xs leading-5">
          {t('settings.knowledge.reflection.quiet.description')}
        </Text>
        <Select<string>
          value={`${reflectionQuietHours}`}
          options={quietOptions}
          disabled={readOnly}
          onChange={(value) => {
            setConfigValue('reflectionQuietHours', Number(value))
            pushReflectionConfig({ quietHours: Number(value) })
          }}
        />
      </Section>

      <Section title={t('settings.knowledge.reflection.deepClean.label')}>
        <Text className="text-muted text-left font-sans text-xs leading-5">
          {t('settings.knowledge.reflection.deepClean.description')}
        </Text>
        <RunNowButton
          label={t('settings.knowledge.reflection.runNow')}
          disabled={readOnly || running !== null}
          onPress={() => void runNow('deepClean')}
        />
      </Section>

      {runs.reflection ? (
        <LastRunCard
          title={t('settings.knowledge.lastRun.reflectionTitle')}
          record={runs.reflection}
          locale={locale}
        />
      ) : null}
      {runs.deepClean ? (
        <LastRunCard
          title={t('settings.knowledge.lastRun.deepCleanTitle')}
          record={runs.deepClean}
          locale={locale}
        />
      ) : null}
    </PanelScreen>
  )
}

// ── Reflection controls ──────────────────────────────────────────────

/** Desktop QUIET_HOUR_CHOICES, verbatim. */
const QUIET_HOUR_CHOICES = [1, 2, 3, 6, 12, 24, 48]

/**
 * The label never swaps while a run is in flight — `disabled` covers the busy
 * window (callers pass `running !== null`), and the dim is the whole signal,
 * so the button never changes size mid-run.
 */
function RunNowButton({
  label,
  disabled,
  onPress
}: {
  label: string
  disabled: boolean
  onPress: () => void
}): React.JSX.Element {
  return (
    <Button variant="outline" size="sm" disabled={disabled} onPress={onPress}>
      <PlayIcon size={12} className="text-fg" />
      {label}
    </Button>
  )
}

// ── Last-run cards ───────────────────────────────────────────────────

/**
 * The desktop's `<code>` chip: a bordered mono capsule on the page ground.
 * Flat `bg-bg`/`border-border` rather than the desktop's /60 and /40 — RN
 * cannot alpha-compose a var() color, and such a class silently drops (see
 * global.css, where --color-border-soft exists for exactly this reason).
 */
function Chip({ children }: { children: string }): React.JSX.Element {
  return (
    <View className="bg-bg border-border self-start rounded-lg border px-2.5 py-1">
      {/* No forced direction or alignment: a chip holds either a localized
          sentence ("استغرق ١٤ث") or a bare model id, and RN's default `auto`
          resolves each from its own first strong character — the desktop's
          bidi behaviour. Forcing ltr drags the Arabic leading number to the
          wrong end of the capsule. */}
      <Text selectable className="text-muted font-mono text-[11px]">
        {children}
      </Text>
    </View>
  )
}

function LastRunCard({
  title,
  record,
  locale
}: {
  title: string
  record: CompactionRunRecord
  locale: string
}): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <Section className="gap-3">
      <View className="flex-row items-center justify-between gap-3">
        <View className="flex-shrink flex-row items-center gap-2">
          <Activity04Icon size={16} className="text-muted" />
          <Text
            numberOfLines={1}
            className="text-fg font-sans-medium flex-shrink text-left text-sm"
          >
            {title}
          </Text>
        </View>
        <Chip>
          {t('settings.knowledge.lastRun.ranAt', { time: formatRanAt(record.at, locale) })}
        </Chip>
      </View>
      <View className="flex-row flex-wrap items-center gap-2">
        {record.model ? <Chip>{record.model}</Chip> : null}
        <Chip>
          {t('settings.knowledge.lastRun.took', {
            duration: formatDuration(record.durationMs, locale)
          })}
        </Chip>
        {record.inputTokens !== null && record.outputTokens !== null ? (
          <Chip>
            {t('settings.knowledge.lastRun.tokens', {
              input: formatTokens(record.inputTokens, locale),
              output: formatTokens(record.outputTokens, locale)
            })}
          </Chip>
        ) : null}
      </View>
      {/* Scrolls in place rather than stretching the panel — the desktop's
          max-h-64 overflow-auto block, in the app's own code-block tones. */}
      <ScrollView className="bg-bg border-border max-h-64 rounded-lg border" nestedScrollEnabled>
        {/* Alignment left to RN's `auto`, the desktop's `dir="auto"`: an
            English summary reads flush-left even while the panel is RTL. */}
        <Text selectable className="text-fg p-3 font-mono text-[11px] leading-4">
          {record.output}
        </Text>
      </ScrollView>
    </Section>
  )
}

// ── Formatting ───────────────────────────────────────────────────────

/** "Jul 26, 04:20" — the desktop card's timestamp, month/day + time. */
function formatRanAt(at: number, locale: string): string {
  try {
    return new Intl.DateTimeFormat(locale, {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    }).format(new Date(at))
  } catch {
    return new Date(at).toISOString().slice(0, 16).replace('T', ' ')
  }
}

/**
 * Seconds under 90, minutes beyond — the desktop's split, so a 14s daily run
 * and a 3.2min one read at the granularity each deserves.
 *
 * Rounded BEFORE formatting: Hermes honours `style: 'unit'` but ignores
 * `maximumFractionDigits`, so leaving the precision to the formatter renders a
 * 14041ms run as "14.041s". The unit suffix is then checked rather than
 * assumed, falling back to the plain `s`/`m` the chat cards use.
 */
function formatDuration(ms: number, locale: string): string {
  const seconds = ms / 1000
  const asMinutes = seconds >= 90
  const digits = asMinutes || seconds < 10 ? 1 : 0
  const value = Number((asMinutes ? seconds / 60 : seconds).toFixed(digits))
  try {
    const formatted = new Intl.NumberFormat(locale, {
      style: 'unit',
      unit: asMinutes ? 'minute' : 'second',
      maximumFractionDigits: digits
    }).format(value)
    if (/[^\d\s.,٠-٩٫٬]/.test(formatted)) return formatted
  } catch {
    // Falls through to the plain form below.
  }
  return `${value.toFixed(digits)}${asMinutes ? 'm' : 's'}`
}

/**
 * The desktop's wall clock, from this phone's clock plus the desktop's IANA
 * zone — the same instant, that machine's local time. Hermes ships full ICU
 * on iOS, but an unknown zone string must cost the zone, not the card.
 */
function formatDesktopTime(now: number, locale: string, timezone: string): string {
  try {
    return new Intl.DateTimeFormat(locale, {
      hour: '2-digit',
      minute: '2-digit',
      timeZone: timezone
    }).format(now)
  } catch {
    try {
      return new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit' }).format(now)
    } catch {
      return new Date(now).toISOString().slice(11, 16)
    }
  }
}

/** The desktop's formatFromNow: relative-time wording, plain fallback. */
function formatFromNow(totalMinutes: number, locale: string): string {
  const hours = Math.floor(totalMinutes / 60)
  const days = Math.floor(hours / 24)
  try {
    const rtf = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' })
    if (days > 0) return rtf.format(days, 'day')
    if (hours > 0) return rtf.format(hours, 'hour')
    return rtf.format(totalMinutes, 'minute')
  } catch {
    if (days > 0) return `in ${days}d`
    if (hours > 0) return `in ${hours}h`
    return `in ${totalMinutes}m`
  }
}
