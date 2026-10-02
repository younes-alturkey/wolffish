import {
  ActivityHeatmap,
  type ActivityHeatmapEntry
} from '@components/charts/activity-heatmap/ActivityHeatmap'
import {
  AnthropicLogo,
  BraveLogo,
  DeepSeekLogo,
  KimiLogo,
  MiniMaxLogo,
  MimoLogo,
  OllamaLogo,
  OpenAILogo,
  OpenRouterLogo,
  XAILogo,
  QwenLogo,
  StepfunLogo,
  ZaiLogo
} from '@components/core/ProviderLogos'
import { useToast } from '@components/core/toast/useToast'
import { cn } from '@lib/utils/cn'
import { formatCompact } from '@lib/utils/format'
import type {
  BraveUsageSummary,
  UsageDailyEntry,
  UsageProviderSummary,
  UsageStats,
  UsageSummary,
  UsageTimeRange,
  WeekStartsOn
} from '@preload/index'
import { useFlow } from '@providers/flow/useFlow'
import { useLocale } from '@providers/locale/useLocale'
import {
  BubbleChatIcon,
  CalendarCheckOut02Icon,
  ChartAverageIcon,
  ChartUpIcon,
  Database02Icon,
  Fire03Icon,
  MessageMultiple01Icon,
  Refresh01Icon,
  StarIcon,
  Wallet01Icon
} from 'hugeicons-react'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

type IconComp = React.ComponentType<{ size?: number; className?: string }>

type ProviderId =
  | 'local'
  | 'anthropic'
  | 'openai'
  | 'openrouter'
  | 'deepseek'
  | 'mimo'
  | 'kimi'
  | 'minimax'
  | 'xai'
  | 'qwen'
  | 'stepfun'
  | 'zai'

const TIME_RANGES: UsageTimeRange[] = [
  'today',
  'this_month',
  '3_months',
  '6_months',
  'ytd',
  'all_time'
]

const PROVIDER_ICONS: Record<ProviderId, React.ComponentType<{ size: number }>> = {
  local: OllamaLogo,
  anthropic: AnthropicLogo,
  openai: OpenAILogo,
  openrouter: OpenRouterLogo,
  deepseek: DeepSeekLogo,
  mimo: MimoLogo,
  kimi: KimiLogo,
  minimax: MiniMaxLogo,
  xai: XAILogo,
  qwen: QwenLogo,
  stepfun: StepfunLogo,
  zai: ZaiLogo
}

type RangeData = { summary: UsageSummary; stats: UsageStats }

/**
 * Module-level caches of the last-known usage numbers, warmed once at app
 * start (Settings.tsx eagerly imports this panel, so the prefill below runs
 * during startup). Settings unmounts every inactive tab, so without these the
 * panel re-fetched from null on every open and the user watched the skeleton
 * every single time. Now the numbers are already in memory and paint on the
 * first frame; each mount still re-fetches in the background and overwrites
 * the cache, so a warm paint is never stale for long. A missing key means
 * "not loaded yet".
 *
 * Mirrors McpPanel / GitHubPanel, with one difference those panels don't have:
 * this data is parameterized, so the caches are KEYED. One shared slot would
 * hit on "today" numbers while the "All time" pill is lit and never correct
 * itself, because a hit is a hit. Keyed, every range converges on its own
 * figures; `lastShown` below can bridge a miss with another range's numbers,
 * but only until that range's own fetch lands.
 */
const rangeCache = new Map<UsageTimeRange, RangeData>()
const dailyCache = new Map<number, UsageDailyEntry[]>()

/**
 * The last figures actually painted, kept so a range whose fetch hasn't landed
 * yet shows the numbers already on screen instead of a skeleton. Every range is
 * prefetched at startup, so this is a fallback for the narrow window before the
 * warm completes — not the normal path.
 */
let lastShown: RangeData | null = null

/** In-flight loads, so the startup warm and a fast tab open share one fetch. */
const inflight = new Map<string, Promise<void>>()

/**
 * Sequence number of the newest fetch whose result reached the cache, per key.
 * Sync force-starts a second fetch for a key that may already have one in
 * flight; without this the older, pre-sync response could land last and
 * silently overwrite the fresh numbers.
 */
const committed = new Map<string, number>()
let fetchSeq = 0

function claim(key: string, seq: number): boolean {
  if ((committed.get(key) ?? -1) > seq) return false
  committed.set(key, seq)
  return true
}

function load(key: string, force: boolean, run: (seq: number) => Promise<void>): Promise<void> {
  const existing = inflight.get(key)
  if (existing && !force) return existing
  const seq = fetchSeq++
  const pending = run(seq)
  inflight.set(key, pending)
  void pending.finally(() => {
    if (inflight.get(key) === pending) inflight.delete(key)
  })
  return pending
}

function loadRange(range: UsageTimeRange, force = false): Promise<void> {
  return load(`range:${range}`, force, async (seq) => {
    const api = window.api?.usage
    if (!api) return // preload not ready yet; retry on mount
    try {
      const [summary, stats] = await Promise.all([api.getSummary(range), api.getStats(range)])
      if (claim(`range:${range}`, seq)) rangeCache.set(range, { summary, stats })
    } catch {
      // Leave the key cold so the next mount retries rather than pinning a
      // failed startup fetch as real data.
    }
  })
}

function loadDaily(year: number, force = false): Promise<void> {
  return load(`daily:${year}`, force, async (seq) => {
    const api = window.api?.usage
    if (!api) return // preload not ready yet; retry on mount
    try {
      const daily = await api.getDaily(year)
      if (claim(`daily:${year}`, seq)) dailyCache.set(year, daily)
    } catch {
      // Leave the key cold so the next mount retries.
    }
  })
}

// Prefill the cache at app start — every range, not just the one the panel
// opens on, so picking a different range is instant instead of stale-then-
// correct. All six are affordable because main answers each from memory plus a
// COUNT on the cortex index; they'd be six full conversation-directory scans if
// this ran against the old usage:getStats.
void Promise.all(TIME_RANGES.map((r) => loadRange(r)))
void loadDaily(new Date().getFullYear())

export function UsagePanel(): React.JSX.Element {
  const { t } = useTranslation()
  const toast = useToast()
  const { status } = useFlow()
  const weekStartsOn: WeekStartsOn = status?.config?.weekStartsOn ?? 1
  const [range, setRange] = useState<UsageTimeRange>('all_time')
  const [, setTick] = useState(0)
  const year = new Date().getFullYear()
  const [syncing, setSyncing] = useState(false)
  const repaint = (): void => setTick((n) => n + 1)

  // The caches are the source of truth and are read during render, keyed by
  // what is on screen — not seeded into state once at mount, which would go
  // stale the moment the user picked a different range.
  //
  // On the rare miss (a range not warmed yet) we keep the figures already on
  // screen and let them update silently a moment later, rather than blanking
  // the panel back to a skeleton. The skeleton is only for a genuinely cold
  // start, when there is nothing to keep.
  const cached = rangeCache.get(range)
  const data = cached ?? lastShown
  const daily = dailyCache.get(year)

  useEffect(() => {
    if (cached) lastShown = cached
  }, [cached])

  useEffect(() => {
    let mounted = true
    void loadRange(range).then(() => {
      if (mounted) repaint()
    })
    return () => {
      mounted = false
    }
  }, [range])

  useEffect(() => {
    let mounted = true
    void loadDaily(year).then(() => {
      if (mounted) repaint()
    })
    return () => {
      mounted = false
    }
  }, [year])

  const onSync = async (): Promise<void> => {
    if (syncing) return
    setSyncing(true)
    try {
      await window.api.usage.sync()
      // Sync rebuilds main's whole ledger, so every cached range is now stale.
      // Force-refresh all of them rather than dropping the off-screen keys:
      // overwriting in place means neither the visible range nor the next one
      // the user picks ever blanks back to a skeleton. These land in the cache
      // even if the user walks away mid-sync, so a sync is never silently lost
      // to an unmount.
      await Promise.all([...TIME_RANGES.map((r) => loadRange(r, true)), loadDaily(year, true)])
      repaint()
      toast.show({ tone: 'success', message: t('settings.usage.syncSuccessToast') })
    } catch {
      toast.show({ tone: 'error', message: t('settings.usage.syncErrorToast') })
    } finally {
      setSyncing(false)
    }
  }

  return (
    <div className="flex min-h-full w-full items-start justify-center px-6 py-10">
      <div className="flex w-full max-w-2xl flex-col gap-6">
        <header className="flex items-start justify-between gap-4">
          <div className="flex flex-col gap-2">
            <h1 className="text-fg text-2xl font-semibold tracking-tight">
              {t('settings.usage.title')}
            </h1>
            <p className="text-muted text-sm leading-relaxed">{t('settings.usage.subtitle')}</p>
          </div>
          <button
            type="button"
            onClick={() => void onSync()}
            disabled={syncing}
            aria-label={t('settings.usage.sync')}
            className={cn(
              'inline-flex items-center gap-1 rounded-md text-xs cursor-pointer',
              'text-muted hover:text-fg px-1.5 py-0.5',
              'focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg',
              'disabled:cursor-not-allowed disabled:opacity-40'
            )}
          >
            <Refresh01Icon size={14} />
            <span>{t('settings.usage.sync')}</span>
          </button>
        </header>

        <RangeSelector range={range} onChange={setRange} />

        <section className="flex flex-col gap-3">
          <div className="flex items-center justify-between">
            <h2 className="text-fg text-sm font-semibold">{t('settings.usage.activity')}</h2>
            <span className="text-muted text-xs font-medium tabular-nums">{year}</span>
          </div>
          {daily === undefined ? (
            <ActivityMapSkeleton year={year} weekStartsOn={weekStartsOn} />
          ) : (
            <ActivityHeatmap
              entries={toEntries(daily)}
              year={year}
              weekStartsOn={weekStartsOn}
              showMonthLabels={false}
              showWeekdayLabels={false}
              formatTooltip={(e) =>
                t('settings.usage.activityTooltip', {
                  date: e.date,
                  tokens: formatCompact(e.value)
                })
              }
            />
          )}
        </section>

        <section className="flex flex-col gap-3">
          <h2 className="text-fg text-sm font-semibold">{t('settings.usage.overview')}</h2>
          {data === null ? <StatsGridSkeleton /> : <StatsGrid stats={data.stats} />}
        </section>

        <section className="flex flex-col gap-3">
          <h2 className="text-fg text-sm font-semibold">{t('settings.usage.costs.title')}</h2>
          {data === null ? <CostCardsSkeleton /> : <CostCards stats={data.stats} />}
        </section>

        {data === null ? (
          <ProviderCardsSkeleton />
        ) : (
          <div className="flex flex-col gap-3">
            {data.summary.providers.map((p) => (
              <ProviderCard key={p.provider} provider={p} />
            ))}
            <BraveSearchCard brave={data.summary.brave} />
          </div>
        )}
      </div>
    </div>
  )
}

function CostCards({ stats }: { stats: UsageStats }): React.JSX.Element {
  const { t } = useTranslation()
  const { locale } = useLocale()
  const topDay = stats.topSpendDay
  const dailyAverage = stats.activeDays > 0 ? stats.totalCost / stats.activeDays : 0
  const items: Array<{ label: string; value: string; icon: IconComp; hint?: string }> = [
    {
      label: t('settings.usage.costs.totalSpend'),
      value: formatCost(stats.totalCost),
      icon: Wallet01Icon
    },
    {
      label: t('settings.usage.costs.topDaySpend'),
      value: formatCost(topDay?.cost ?? 0),
      hint: topDay ? formatDay(topDay.date, locale) : undefined,
      icon: ChartUpIcon
    },
    {
      label: t('settings.usage.costs.dailyAverage'),
      value: formatCost(dailyAverage),
      icon: ChartAverageIcon
    }
  ]
  return (
    <div className="grid grid-cols-3 gap-3">
      {items.map((it) => (
        <StatCard key={it.label} label={it.label} value={it.value} Icon={it.icon} hint={it.hint} />
      ))}
    </div>
  )
}

function toEntries(daily: UsageDailyEntry[]): Array<{ date: string; value: number }> {
  return daily.map((d) => ({ date: d.date, value: d.totalTokens }))
}

function RangeSelector({
  range,
  onChange
}: {
  range: UsageTimeRange
  onChange: (r: UsageTimeRange) => void
}): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <div className="bg-surface border-border flex rounded-lg border p-0.5">
      {TIME_RANGES.map((r) => (
        <button
          key={r}
          type="button"
          onClick={() => onChange(r)}
          className={cn(
            'flex-1 cursor-pointer rounded-md px-2 py-1.5 text-[11px] font-medium whitespace-nowrap',
            'focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg',
            range === r ? 'bg-primary text-primary-fg shadow-sm' : 'text-muted hover:text-fg'
          )}
        >
          {t(`settings.usage.range.${r}`)}
        </button>
      ))}
    </div>
  )
}

function ProviderCard({ provider }: { provider: UsageProviderSummary }): React.JSX.Element {
  const { t } = useTranslation()
  const Logo = PROVIDER_ICONS[provider.provider]
  const totalTokens = provider.totalInputTokens + provider.totalOutputTokens
  const hasUsage = totalTokens > 0

  return (
    <div
      className={cn('bg-surface border-border rounded-xl border p-4', !hasUsage && 'opacity-50')}
    >
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Logo size={16} />
          <span className="text-fg text-sm font-medium">
            {t(`settings.usage.providers.${provider.provider}`)}
          </span>
        </div>
        {hasUsage ? (
          <div className="flex items-center gap-4">
            <span className="text-muted text-xs">
              {formatCompact(totalTokens)} {t('settings.usage.tokens')}
            </span>
            <span className="text-fg text-xs font-medium">${provider.totalCost.toFixed(2)}</span>
          </div>
        ) : (
          <span className="text-muted text-xs">{t('settings.usage.noUsage')}</span>
        )}
      </div>

      {hasUsage && provider.models.length > 0 && (
        <div className="mt-3 flex flex-col gap-1.5">
          {provider.models.map((m) => (
            <div key={m.model} className="flex items-center justify-between text-xs">
              <span className="text-muted truncate max-w-50">{m.model}</span>
              <div className="flex items-center gap-3">
                <span className="text-muted">
                  {formatCompact(m.inputTokens + m.outputTokens)} {t('settings.usage.tokens')}
                </span>
                <span className="text-muted">${m.cost.toFixed(2)}</span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function BraveSearchCard({ brave }: { brave: BraveUsageSummary }): React.JSX.Element {
  const { t } = useTranslation()
  const hasUsage = brave.totalQueries > 0

  return (
    <div
      className={cn('bg-surface border-border rounded-xl border p-4', !hasUsage && 'opacity-50')}
    >
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <BraveLogo size={16} />
          <span className="text-fg text-sm font-medium">{t('settings.usage.providers.brave')}</span>
        </div>
        {hasUsage ? (
          <div className="flex items-center gap-4">
            <span className="text-muted text-xs">
              {formatCompact(brave.totalQueries)} {t('settings.usage.queries')}
            </span>
            <span className="text-fg text-xs font-medium">${brave.totalCost.toFixed(2)}</span>
          </div>
        ) : (
          <span className="text-muted text-xs">{t('settings.usage.noUsage')}</span>
        )}
      </div>
    </div>
  )
}

function StatsGrid({ stats }: { stats: UsageStats }): React.JSX.Element {
  const { t } = useTranslation()
  const items: Array<{ label: string; value: string; icon: IconComp }> = [
    {
      label: t('settings.usage.stats.conversations'),
      value: formatCompact(stats.conversations),
      icon: MessageMultiple01Icon
    },
    {
      label: t('settings.usage.stats.messages'),
      value: formatCompact(stats.messages),
      icon: BubbleChatIcon
    },
    {
      label: t('settings.usage.stats.totalTokens'),
      value: formatCompact(stats.totalTokens),
      icon: Database02Icon
    },
    {
      label: t('settings.usage.stats.activeDays'),
      value: formatCompact(stats.activeDays),
      icon: CalendarCheckOut02Icon
    },
    {
      label: t('settings.usage.stats.longestStreak'),
      value: t(
        stats.longestStreak === 1
          ? 'settings.usage.stats.streakDay'
          : 'settings.usage.stats.streakDays',
        {
          count: stats.longestStreak
        }
      ),
      icon: Fire03Icon
    },
    {
      label: t('settings.usage.stats.favouriteModel'),
      value: stats.favouriteModel ?? t('settings.usage.stats.noModel'),
      icon: StarIcon
    }
  ]
  return (
    <div className="grid grid-cols-3 gap-3">
      {items.map((it) => (
        <StatCard key={it.label} label={it.label} value={it.value} Icon={it.icon} />
      ))}
    </div>
  )
}

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
    <div className="bg-surface border-border flex flex-col gap-1 rounded-xl border p-3">
      <div className="text-muted flex items-center gap-1.5 text-[11px]">
        <Icon size={12} />
        <span className="truncate">{label}</span>
      </div>
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-fg truncate text-sm font-semibold tabular-nums">{value}</span>
        {hint !== undefined && (
          <span className="text-muted shrink-0 text-[11px] tabular-nums">{hint}</span>
        )}
      </div>
    </div>
  )
}

/**
 * A pulse bar that is a real — if transparent — text node, so its height is
 * the exact line box of the text it stands in for and tracks it for free if
 * that text is ever restyled. Hand-picked bar heights are what left the old
 * skeleton short of every row it replaced: `text-[11px]` sets no line-height
 * of its own and resolves to 16.5px, not the 12px a `h-3` bar guessed.
 */
function SkeletonBar({ className }: { className?: string }): React.JSX.Element {
  return (
    <span
      className={cn('bg-border/60 animate-pulse rounded text-transparent select-none', className)}
    >
      &nbsp;
    </span>
  )
}

// Every skeleton below mirrors the element structure, classes and font sizes of
// the component it stands in for, so the two are the same height by
// construction and the panel doesn't jump when the numbers land.

function StatCardSkeleton(): React.JSX.Element {
  return (
    <div className="bg-surface border-border flex flex-col gap-1 rounded-xl border p-3">
      <div className="text-muted flex items-center gap-1.5 text-[11px]">
        <span className="bg-border/60 size-3 shrink-0 animate-pulse rounded-sm" />
        <SkeletonBar className="w-16" />
      </div>
      <SkeletonBar className="w-12 text-sm" />
    </div>
  )
}

function StatsGridSkeleton(): React.JSX.Element {
  return (
    <div className="grid grid-cols-3 gap-3">
      {[0, 1, 2, 3, 4, 5].map((i) => (
        <StatCardSkeleton key={i} />
      ))}
    </div>
  )
}

function CostCardsSkeleton(): React.JSX.Element {
  return (
    <div className="grid grid-cols-3 gap-3">
      {[0, 1, 2].map((i) => (
        <StatCardSkeleton key={i} />
      ))}
    </div>
  )
}

function ProviderCardsSkeleton(): React.JSX.Element {
  // getSummary zero-fills every provider it knows about, so the real list is
  // always the full roster plus the Brave card — never a short list. Counting
  // the icon map keeps this honest when a provider is added.
  const count = Object.keys(PROVIDER_ICONS).length + 1
  return (
    <div className="flex flex-col gap-3">
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className="bg-surface border-border rounded-xl border p-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <span className="bg-border/60 size-4 shrink-0 animate-pulse rounded-sm" />
              <SkeletonBar className="w-24 text-sm" />
            </div>
            <SkeletonBar className="w-16 text-xs" />
          </div>
        </div>
      ))}
    </div>
  )
}

// The heatmap derives its cell size from its own measured width, so the
// skeleton is the real component fed an empty year: identical geometry at every
// window width, which a fixed height could only match at the panel's max-width.
const NO_ENTRIES: ActivityHeatmapEntry[] = []

function ActivityMapSkeleton({
  year,
  weekStartsOn
}: {
  year: number
  weekStartsOn: WeekStartsOn
}): React.JSX.Element {
  return (
    <div className="pointer-events-none animate-pulse">
      <ActivityHeatmap
        entries={NO_ENTRIES}
        year={year}
        weekStartsOn={weekStartsOn}
        showMonthLabels={false}
        showWeekdayLabels={false}
      />
    </div>
  )
}

function formatCost(v: number): string {
  return `$${v.toFixed(2)}`
}

/**
 * Ledger dates are local-naive `YYYY-MM-DD`; the local-midnight suffix keeps
 * the displayed calendar day from shifting for timezones west of UTC, which
 * a bare `new Date(date)` (parsed as UTC midnight) would do.
 */
function formatDay(date: string, locale: string): string {
  const d = new Date(`${date}T00:00:00`)
  if (Number.isNaN(d.getTime())) return date
  return new Intl.DateTimeFormat(locale, {
    month: 'short',
    day: 'numeric',
    year: 'numeric'
  }).format(d)
}
