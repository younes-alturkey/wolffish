import { useFreshConfig } from '@/lib/sync/useFreshConfig'
import {
  BubbleChatIcon,
  CalendarCheckOut02Icon,
  ChartAverageIcon,
  ChartUpIcon,
  Database02Icon,
  FireIcon,
  MessageMultiple01Icon,
  StarIcon,
  Wallet01Icon,
  type IconProps
} from '@/components/core/icons'
import { BraveLogo, PROVIDER_LOGOS } from '@/components/core/providerLogos'
import { Select, type SelectOption } from '@/components/core/Select'
import { PanelScreen } from '@/components/settings/SettingsUI'
import { countConversationsSince } from '@/lib/conversations/repo'
import {
  computeUsageStats,
  computeUsageSummary,
  dailyTokens,
  dayDetails,
  ledgerYears,
  rangeCutoffMs,
  USAGE_TIME_RANGES,
  type UsageProviderSummary,
  type UsageTimeRange
} from '@/lib/usage/stats'
import { cn } from '@/lib/utils/cn'
import { formatTokens } from '@/lib/utils/formatTokens'
import { formatDayFromNow } from '@/lib/utils/relativeTime'
import { useTheme, useTokens } from '@/providers/theme/useTheme'
import { useAppStore } from '@/state/appStore'
import { useConfigValue, useUsageDays } from '@/state/demoConfig'
import { useQuery } from '@tanstack/react-query'
import { useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Pressable, ScrollView, Text, View, type LayoutChangeEvent } from 'react-native'

/**
 * Usage — the desktop UsagePanel on one column, computed from the usage
 * ledger rows the config snapshot carries (lib/usage/stats mirrors
 * main/runtime/usage.ts): activity pixels, then the range selector sitting
 * directly above the overview/cost/provider sections it scopes (the activity
 * month has its own month/year selects). Two adaptations for the phone: the six
 * ranges ride a horizontally scrollable switch instead of a fixed row, and
 * the year heatmap becomes one month of pixels with month/year selects plus
 * an always-visible day card standing in for the desktop's hover tooltip —
 * on today until another day is tapped.
 * Sync stays on the desktop: these numbers refresh with the dataset.
 */

type IconComp = (props: IconProps) => React.JSX.Element

function formatCost(v: number): string {
  return `$${v.toFixed(2)}`
}

/**
 * Ledger dates are local-naive `YYYY-MM-DD`; the local-midnight suffix keeps
 * the displayed day from shifting west of UTC (desktop UsagePanel formatDay).
 */
function formatDay(date: string, locale: string): string {
  const d = new Date(`${date}T00:00:00`)
  if (Number.isNaN(d.getTime())) return date
  try {
    return new Intl.DateTimeFormat(locale, {
      month: 'short',
      day: 'numeric',
      year: 'numeric'
    }).format(d)
  } catch {
    return date
  }
}

export default function UsageScreen(): React.JSX.Element {
  // Desktop-owned values: pull the current ones when this screen opens.
  useFreshConfig()
  const { t, i18n } = useTranslation()
  const locale = i18n.language || 'en'
  const days = useUsageDays()
  const [range, setRange] = useState<UsageTimeRange>('all_time')
  // One clock reading per visit — every cutoff on screen agrees on "now".
  const [now] = useState(() => new Date())

  const stats = useMemo(() => computeUsageStats(days, range, now), [days, range, now])
  const summary = useMemo(() => computeUsageSummary(days, range, now), [days, range, now])
  const { data: storedConversations } = useQuery({
    queryKey: ['usage-conversations', range],
    queryFn: () => countConversationsSince(rangeCutoffMs(range, new Date())),
    staleTime: 60_000
  })
  /**
   * Paired: the conversations this phone actually holds, which is the honest
   * answer and the one the desktop gives.
   *
   * Demo: the ledger's own figure. The bundled conversations stop when the
   * bundle was built while the ledger runs forward, so a range near now counts
   * zero of them beside a Messages card in the hundreds — the two halves are on
   * different clocks by construction (LEDGER_TURNS_PER_CONVERSATION says more).
   */
  const paired = useAppStore((state) => state.paired)
  const conversations = paired ? (storedConversations ?? 0) : stats.conversations

  return (
    <PanelScreen title={t('settings.tabs.usage')} subtitle={t('settings.usage.subtitle')}>
      <ActivityMonth days={days} now={now} locale={locale} />

      <RangeSelector range={range} onChange={setRange} />

      <View className="flex-col gap-3">
        <Text className="text-fg font-sans-semibold text-left text-sm">
          {t('settings.usage.overview')}
        </Text>
        <View className="flex-row flex-wrap gap-3">
          <StatCard
            label={t('settings.usage.stats.conversations')}
            value={formatTokens(conversations, locale)}
            Icon={MessageMultiple01Icon}
          />
          <StatCard
            label={t('settings.usage.stats.messages')}
            value={formatTokens(stats.messages, locale)}
            Icon={BubbleChatIcon}
          />
          <StatCard
            label={t('settings.usage.stats.totalTokens')}
            value={formatTokens(stats.totalTokens, locale)}
            Icon={Database02Icon}
          />
          <StatCard
            label={t('settings.usage.stats.activeDays')}
            value={formatTokens(stats.activeDays, locale)}
            Icon={CalendarCheckOut02Icon}
          />
          <StatCard
            label={t('settings.usage.stats.longestStreak')}
            value={t(
              stats.longestStreak === 1
                ? 'settings.usage.stats.streakDay'
                : 'settings.usage.stats.streakDays',
              { count: stats.longestStreak }
            )}
            Icon={FireIcon}
          />
          <StatCard
            label={t('settings.usage.stats.favouriteModel')}
            value={stats.favouriteModel ?? t('settings.usage.stats.noModel')}
            Icon={StarIcon}
          />
        </View>
      </View>

      <View className="flex-col gap-3">
        <Text className="text-fg font-sans-semibold text-left text-sm">
          {t('settings.usage.costs.title')}
        </Text>
        <View className="flex-row flex-wrap gap-3">
          <StatCard
            label={t('settings.usage.costs.totalSpend')}
            value={formatCost(stats.totalCost)}
            Icon={Wallet01Icon}
          />
          <StatCard
            label={t('settings.usage.costs.topDaySpend')}
            value={formatCost(stats.topSpendDay?.cost ?? 0)}
            hint={stats.topSpendDay ? formatDay(stats.topSpendDay.date, locale) : undefined}
            Icon={ChartUpIcon}
          />
          <StatCard
            label={t('settings.usage.costs.dailyAverage')}
            value={formatCost(stats.activeDays > 0 ? stats.totalCost / stats.activeDays : 0)}
            Icon={ChartAverageIcon}
          />
        </View>
      </View>

      <View className="flex-col gap-3">
        {summary.providers.map((provider) => (
          <ProviderCard key={provider.provider} provider={provider} locale={locale} />
        ))}
        <BraveSearchCard brave={summary.brave} locale={locale} />
      </View>
    </PanelScreen>
  )
}

// ── Range selector ───────────────────────────────────────────────────

/**
 * The desktop's six-range pill row in the ModelSwitch's binary-switch chrome.
 *
 * The pills SHARE the row rather than hugging their labels: `flexGrow` on the
 * content container makes it at least as wide as the switch, and `flex-1` on
 * each pill splits that evenly, so six ranges fill the control instead of
 * leaving a dead gap on the trailing edge. `RANGE_PILL_MIN_WIDTH` is the floor
 * that keeps it honest — once the pills can no longer all fit at that width
 * (a seventh range, or a locale whose labels are longer, as Arabic's YTD is)
 * the container outgrows the switch and the whole row scrolls, which is why
 * this is still a ScrollView and not a plain flex row.
 */
const RANGE_PILL_MIN_WIDTH = 58
function RangeSelector({
  range,
  onChange
}: {
  range: UsageTimeRange
  onChange: (range: UsageTimeRange) => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const scrollRef = useRef<ScrollView>(null)
  // The default range is the LAST pill; without this it mounts off-screen and
  // the switch looks like nothing is selected.
  const autoScrolled = useRef(false)
  const onActiveLayout = (): void => {
    if (autoScrolled.current) return
    autoScrolled.current = true
    if (USAGE_TIME_RANGES.indexOf(range) >= 3) {
      scrollRef.current?.scrollToEnd({ animated: false })
    }
  }

  return (
    // `bg-surface`, not the `bg-bg` the in-card switches use (ModePills, the
    // automations toggles). Those sit INSIDE a surface card, where the page
    // colour is what gives them their well. This one sits directly on the page
    // between the activity grid and the stat cards, so `bg-bg` painted it the
    // same colour as the screen and the control read as a floating row of words
    // with a hairline around it. It is a card here, so it takes the card recipe
    // every other block on this screen uses.
    <View className="border-border bg-surface rounded-lg border p-0.5">
      <ScrollView
        ref={scrollRef}
        horizontal
        showsHorizontalScrollIndicator={false}
        // Row direction comes from `horizontal`; flexGrow is what lets the
        // pills stretch to the switch's width instead of hugging their text.
        contentContainerStyle={{ flexGrow: 1 }}
      >
        {USAGE_TIME_RANGES.map((candidate) => {
          const active = candidate === range
          return (
            <Pressable
              key={candidate}
              accessibilityRole="tab"
              accessibilityState={{ selected: active }}
              onPress={() => onChange(candidate)}
              onLayout={active ? onActiveLayout : undefined}
              style={{ minWidth: RANGE_PILL_MIN_WIDTH }}
              className={cn(
                'h-9 flex-1 items-center justify-center rounded-md px-2',
                active && 'bg-primary'
              )}
            >
              <Text
                // One line always: a label that outgrows its share pushes the
                // row into scrolling, which is the intended answer — wrapping
                // would silently make the switch two lines tall instead.
                numberOfLines={1}
                className={cn(
                  'font-sans-medium text-xs',
                  active ? 'text-primary-fg' : 'text-muted'
                )}
              >
                {t(`settings.usage.range.${candidate}`)}
              </Text>
            </Pressable>
          )
        })}
      </ScrollView>
    </View>
  )
}

// ── Activity ─────────────────────────────────────────────────────────

const CELL_GAP = 4

/**
 * One month of the desktop's activity pixels, month/year selects above, day
 * details card below. The card is always present — it opens on today and only
 * ever moves to another tapped day; browsing months leaves it in place.
 * Intensity is normalised against the selected YEAR's peak — the desktop
 * heatmap's scale — so a quiet month reads quiet instead of being stretched
 * to full brightness.
 */
function ActivityMonth({
  days,
  now,
  locale
}: {
  days: ReturnType<typeof useUsageDays>
  now: Date
  locale: string
}): React.JSX.Element {
  const { t } = useTranslation()
  const { isDark } = useTheme()
  const tokens = useTokens()
  const weekStartsOn = useConfigValue('weekStartsOn')
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(
    now.getDate()
  ).padStart(2, '0')}`
  const [month, setMonth] = useState(now.getMonth())
  const [year, setYear] = useState(now.getFullYear())
  const [selected, setSelected] = useState(today)
  const [gridWidth, setGridWidth] = useState(0)

  const daily = useMemo(() => dailyTokens(days, year), [days, year])
  const yearMax = useMemo(() => Math.max(0, ...daily.values()), [daily])

  const monthOptions = useMemo<Array<SelectOption<string>>>(
    () =>
      Array.from({ length: 12 }, (_, m) => ({
        value: `${m}`,
        label: monthName(m, locale)
      })),
    [locale]
  )
  const yearOptions = useMemo<Array<SelectOption<string>>>(
    () => ledgerYears(days, now).map((y) => ({ value: `${y}`, label: `${y}` })),
    [days, now]
  )

  // Calendar cells: leading blanks to the first weekday, then every day.
  const cells = useMemo(() => {
    const rowOf = (d: Date): number => (weekStartsOn === 1 ? (d.getDay() + 6) % 7 : d.getDay())
    const first = new Date(year, month, 1)
    const count = new Date(year, month + 1, 0).getDate()
    const list: Array<string | null> = Array.from({ length: rowOf(first) }, () => null)
    for (let day = 1; day <= count; day++) {
      const m = String(month + 1).padStart(2, '0')
      list.push(`${year}-${m}-${String(day).padStart(2, '0')}`)
    }
    while (list.length % 7 !== 0) list.push(null)
    return list
  }, [year, month, weekStartsOn])

  const weekdayLabels = useMemo(() => {
    // 2024-01-01 is a Monday; walk one known week from the configured start.
    const base = weekStartsOn === 1 ? 1 : 7
    return Array.from({ length: 7 }, (_, i) => {
      try {
        return new Intl.DateTimeFormat(locale, { weekday: 'narrow' }).format(
          new Date(2024, 0, base + i)
        )
      } catch {
        return ''
      }
    })
  }, [locale, weekStartsOn])

  const cellSize = gridWidth > 0 ? (gridWidth - 6 * CELL_GAP) / 7 : 0

  const cellColor = (date: string): string => {
    const value = daily.get(date) ?? 0
    if (value === 0 || yearMax === 0) return withAlpha(tokens.border, isDark ? 0.4 : 0.6)
    const ratio = value / yearMax
    if (ratio < 0.2) return withAlpha(tokens.primary, 0.25)
    if (ratio < 0.4) return withAlpha(tokens.primary, 0.45)
    if (ratio < 0.6) return withAlpha(tokens.primary, 0.65)
    if (ratio < 0.8) return withAlpha(tokens.primary, 0.85)
    return tokens.primary
  }

  return (
    <View className="flex-col gap-3">
      {/* Title, selects and pixels share one card in the DayCard's chrome —
          the Select trigger's bg-bg well is the in-card recipe already. */}
      <View className="bg-surface border-border flex-col gap-3 rounded-2xl border p-4">
        <Text className="text-fg font-sans-semibold text-left text-sm">
          {t('settings.usage.activity')}
        </Text>

        <View className="flex-row gap-3">
          <Select<string>
            className="flex-1"
            value={`${month}`}
            options={monthOptions}
            onChange={(value) => setMonth(Number(value))}
          />
          <Select<string>
            className="w-28"
            value={`${year}`}
            options={yearOptions}
            onChange={(value) => setYear(Number(value))}
          />
        </View>

        <View
          className="flex-col"
          style={{ gap: CELL_GAP }}
          onLayout={(event: LayoutChangeEvent) => setGridWidth(event.nativeEvent.layout.width)}
        >
          <View className="flex-row" style={{ gap: CELL_GAP }}>
            {weekdayLabels.map((label, index) => (
              <View key={index} className="items-center" style={{ width: cellSize }}>
                <Text className="text-muted font-sans text-[10px]">{label}</Text>
              </View>
            ))}
          </View>
          {cellSize > 0 &&
            Array.from({ length: cells.length / 7 }, (_, row) => (
              <View key={row} className="flex-row" style={{ gap: CELL_GAP }}>
                {cells.slice(row * 7, row * 7 + 7).map((date, column) =>
                  date === null ? (
                    <View key={column} style={{ width: cellSize, height: cellSize }} />
                  ) : (
                    <Pressable
                      key={column}
                      accessibilityRole="button"
                      accessibilityLabel={date}
                      accessibilityState={{ selected: selected === date }}
                      onPress={() => setSelected(date)}
                      style={{
                        width: cellSize,
                        height: cellSize,
                        borderRadius: 4,
                        backgroundColor: cellColor(date),
                        borderWidth: selected === date ? 2 : date === today ? 1 : 0,
                        borderColor: selected === date ? tokens.accent : tokens.muted
                      }}
                    />
                  )
                )}
              </View>
            ))}
        </View>
      </View>

      <DayCard days={days} date={selected} now={now} locale={locale} />
    </View>
  )
}

/** The tap-a-day card — the desktop tooltip's date + tokens, plus the rest. */
function DayCard({
  days,
  date,
  now,
  locale
}: {
  days: ReturnType<typeof useUsageDays>
  date: string
  now: Date
  locale: string
}): React.JSX.Element {
  const { t } = useTranslation()
  const details = useMemo(() => dayDetails(days, date), [days, date])
  const hasUsage = details.messages > 0 || details.braveQueries > 0

  let title = date
  try {
    const parsed = new Date(`${date}T00:00:00`)
    if (!Number.isNaN(parsed.getTime())) {
      title = new Intl.DateTimeFormat(locale, {
        weekday: 'long',
        day: 'numeric',
        month: 'long',
        year: 'numeric'
      }).format(parsed)
    }
  } catch {
    // Keep the ISO date.
  }

  return (
    <View className="bg-surface border-border flex-col gap-3 rounded-2xl border p-4">
      <View className="flex-row items-baseline justify-between gap-3">
        <Text className="text-fg font-sans-semibold min-w-0 flex-1 text-left text-sm">{title}</Text>
        <Text className="text-muted font-sans text-xs">{formatDayFromNow(date, now, t)}</Text>
      </View>
      {hasUsage ? (
        <>
          <View className="flex-row flex-wrap gap-3">
            <DayStat
              label={t('settings.usage.day.tokens')}
              value={formatTokens(details.totalTokens, locale)}
            />
            <DayStat label={t('settings.usage.day.cost')} value={formatCost(details.cost)} />
            <DayStat
              label={t('settings.usage.day.messages')}
              value={formatTokens(details.messages, locale)}
            />
          </View>
          {(details.models.length > 0 || details.braveQueries > 0) && (
            <View className="flex-col gap-1.5">
              {details.models.map((row) => (
                <View
                  key={`${row.provider}:${row.model}`}
                  className="flex-row items-center justify-between gap-3"
                >
                  <Text
                    numberOfLines={1}
                    className="text-muted min-w-0 flex-1 text-left font-sans text-xs"
                    style={{ writingDirection: 'ltr' }}
                  >
                    {row.model}
                  </Text>
                  <View className="flex-row items-center gap-3">
                    <Text
                      className="text-muted font-sans text-xs"
                      style={{ writingDirection: 'ltr' }}
                    >
                      {formatTokens(row.inputTokens + row.outputTokens, locale)}{' '}
                      {t('settings.usage.tokens')}
                    </Text>
                    <Text
                      className="text-muted font-sans text-xs"
                      style={{ writingDirection: 'ltr' }}
                    >
                      ${row.cost.toFixed(2)}
                    </Text>
                  </View>
                </View>
              ))}
              {details.braveQueries > 0 && (
                <View className="flex-row items-center justify-between gap-3">
                  <Text className="text-muted min-w-0 flex-1 text-left font-sans text-xs">
                    {t('settings.usage.providers.brave')}
                  </Text>
                  <Text
                    className="text-muted font-sans text-xs"
                    style={{ writingDirection: 'ltr' }}
                  >
                    {formatTokens(details.braveQueries, locale)} {t('settings.usage.queries')}
                  </Text>
                </View>
              )}
            </View>
          )}
        </>
      ) : (
        <Text className="text-muted text-left font-sans text-xs">
          {t('settings.usage.noUsage')}
        </Text>
      )}
    </View>
  )
}

function DayStat({ label, value }: { label: string; value: string }): React.JSX.Element {
  return (
    <View className="bg-bg border-border min-w-[28%] flex-1 flex-col gap-0.5 rounded-xl border p-2.5">
      <Text
        className="text-fg font-sans-semibold text-left text-sm"
        style={{ writingDirection: 'ltr' }}
      >
        {value}
      </Text>
      <Text numberOfLines={1} className="text-muted text-left font-sans text-[11px]">
        {label}
      </Text>
    </View>
  )
}

// ── Stat cards ───────────────────────────────────────────────────────

/** The desktop's StatCard: icon + label row, then the figure (and its hint). */
function StatCard({
  label,
  value,
  Icon,
  hint
}: {
  label: string
  value: string
  Icon: IconComp
  hint?: string
}): React.JSX.Element {
  return (
    <View className="bg-surface border-border min-w-[30%] flex-1 flex-col gap-1 rounded-xl border p-3">
      <View className="flex-row items-center gap-1.5">
        <Icon size={12} className="text-muted" />
        <Text
          numberOfLines={1}
          className="text-muted min-w-0 flex-1 text-left font-sans text-[11px]"
        >
          {label}
        </Text>
      </View>
      <View className="flex-row flex-wrap items-baseline justify-between gap-x-2">
        <Text
          numberOfLines={1}
          className="text-fg font-sans-semibold flex-shrink text-left text-sm"
          style={{ writingDirection: 'ltr' }}
        >
          {value}
        </Text>
        {hint !== undefined && (
          <Text numberOfLines={1} className="text-muted font-sans text-[10px]">
            {hint}
          </Text>
        )}
      </View>
    </View>
  )
}

// ── Provider cards ───────────────────────────────────────────────────

function ProviderCard({
  provider,
  locale
}: {
  provider: UsageProviderSummary
  locale: string
}): React.JSX.Element {
  const { t } = useTranslation()
  const Logo = PROVIDER_LOGOS[provider.provider === 'local' ? 'ollama' : provider.provider]
  const totalTokens = provider.totalInputTokens + provider.totalOutputTokens
  const hasUsage = totalTokens > 0

  return (
    <View
      className={cn('bg-surface border-border rounded-xl border p-4', !hasUsage && 'opacity-50')}
    >
      <View className="flex-row items-center justify-between gap-3">
        <View className="min-w-0 flex-1 flex-row items-center gap-2">
          {Logo && <Logo size={16} className="text-fg" />}
          <Text numberOfLines={1} className="text-fg font-sans-medium text-left text-sm">
            {t(`settings.usage.providers.${provider.provider}`)}
          </Text>
        </View>
        {hasUsage ? (
          <View className="flex-row items-center gap-4">
            <Text className="text-muted font-sans text-xs" style={{ writingDirection: 'ltr' }}>
              {formatTokens(totalTokens, locale)} {t('settings.usage.tokens')}
            </Text>
            <Text className="text-fg font-sans-medium text-xs" style={{ writingDirection: 'ltr' }}>
              ${provider.totalCost.toFixed(2)}
            </Text>
          </View>
        ) : (
          <Text className="text-muted font-sans text-xs">{t('settings.usage.noUsage')}</Text>
        )}
      </View>

      {hasUsage && provider.models.length > 0 && (
        <View className="mt-3 flex-col gap-1.5">
          {provider.models.map((model) => (
            <View key={model.model} className="flex-row items-center justify-between gap-3">
              <Text
                numberOfLines={1}
                className="text-muted min-w-0 flex-1 text-left font-sans text-xs"
                style={{ writingDirection: 'ltr' }}
              >
                {model.model}
              </Text>
              <View className="flex-row items-center gap-3">
                <Text className="text-muted font-sans text-xs" style={{ writingDirection: 'ltr' }}>
                  {formatTokens(model.inputTokens + model.outputTokens, locale)}{' '}
                  {t('settings.usage.tokens')}
                </Text>
                <Text className="text-muted font-sans text-xs" style={{ writingDirection: 'ltr' }}>
                  ${model.cost.toFixed(2)}
                </Text>
              </View>
            </View>
          ))}
        </View>
      )}
    </View>
  )
}

function BraveSearchCard({
  brave,
  locale
}: {
  brave: { totalQueries: number; totalCost: number }
  locale: string
}): React.JSX.Element {
  const { t } = useTranslation()
  const hasUsage = brave.totalQueries > 0

  return (
    <View
      className={cn('bg-surface border-border rounded-xl border p-4', !hasUsage && 'opacity-50')}
    >
      <View className="flex-row items-center justify-between gap-3">
        <View className="min-w-0 flex-1 flex-row items-center gap-2">
          <BraveLogo size={16} className="text-fg" />
          <Text numberOfLines={1} className="text-fg font-sans-medium text-left text-sm">
            {t('settings.usage.providers.brave')}
          </Text>
        </View>
        {hasUsage ? (
          <View className="flex-row items-center gap-4">
            <Text className="text-muted font-sans text-xs" style={{ writingDirection: 'ltr' }}>
              {formatTokens(brave.totalQueries, locale)} {t('settings.usage.queries')}
            </Text>
            <Text className="text-fg font-sans-medium text-xs" style={{ writingDirection: 'ltr' }}>
              ${brave.totalCost.toFixed(2)}
            </Text>
          </View>
        ) : (
          <Text className="text-muted font-sans text-xs">{t('settings.usage.noUsage')}</Text>
        )}
      </View>
    </View>
  )
}

// ── Formatting ───────────────────────────────────────────────────────

function monthName(month: number, locale: string): string {
  try {
    return new Intl.DateTimeFormat(locale, { month: 'long' }).format(new Date(2026, month, 1))
  } catch {
    return `${month + 1}`
  }
}

/** `#rrggbb` + alpha → `rgba()` — RN can't stack Tailwind alpha on var() colors. */
function withAlpha(hex: string, alpha: number): string {
  const r = parseInt(hex.slice(1, 3), 16)
  const g = parseInt(hex.slice(3, 5), 16)
  const b = parseInt(hex.slice(5, 7), 16)
  return `rgba(${r}, ${g}, ${b}, ${alpha})`
}
