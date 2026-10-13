import {
  Activity04Icon,
  AiBrain01Icon,
  ArrowDown02Icon,
  ArrowUp02Icon,
  BrainIcon,
  BubbleChatIcon,
  Clock01Icon,
  CpuIcon,
  Database01Icon,
  Database02Icon,
  DollarCircleIcon,
  FireIcon,
  FlashIcon,
  HourglassIcon,
  RepeatIcon,
  WorkflowSquare03Icon
} from '@/components/core/icons'
import { PROVIDER_LOGOS } from '@/components/core/providerLogos'
import type {
  ConversationFile,
  WorkflowAgentView,
  WorkflowSnapshot
} from '@/lib/conversations/types'
import { cn } from '@/lib/utils/cn'
import { formatTokens } from '@/lib/utils/formatTokens'
import {
  THINKING_LEVELS,
  providerForModel,
  setConfigValue,
  useConfigValue,
  type ThinkingLevel
} from '@/state/demoConfig'
import { useTranslation } from 'react-i18next'
import { Pressable, Text, View } from 'react-native'

/**
 * The composer's control cluster, desktop composer parity: chat mode
 * (single/workflow), thinking level (off/on/high/max with the desktop's
 * Flash/Brain/AiBrain/Fire icons), model picker, and the context meter.
 * Rendered inside the chat menu sheet and the Model settings panel.
 */

type Option<T extends string> = {
  value: T
  label: string
  icon: typeof FlashIcon
}

const THINKING_ICONS: Record<ThinkingLevel, typeof FlashIcon> = {
  off: FlashIcon,
  on: BrainIcon,
  high: AiBrain01Icon,
  max: FireIcon
}

const CHAT_MODE_ICONS = {
  single: BubbleChatIcon,
  workflow: WorkflowSquare03Icon
} as const

const CHAT_MODES = ['single', 'workflow'] as const
type ChatMode = (typeof CHAT_MODES)[number]

/**
 * Segmented switch in the ModelSwitch's shape — one bordered track whose
 * segments split the full width evenly, however many options are passed.
 * The active segment carries no shadow class on purpose; see ModelSwitch.
 */
function SegmentedSwitch<T extends string>({
  value,
  options,
  onChange
}: {
  value: T
  options: readonly Option<T>[]
  onChange: (value: T) => void
}): React.JSX.Element {
  return (
    <View className="border-border bg-bg w-full flex-row items-stretch rounded-lg border p-0.5">
      {options.map((option) => {
        const active = value === option.value
        const Icon = option.icon
        return (
          <Pressable
            key={option.value}
            accessibilityRole="tab"
            accessibilityState={{ selected: active }}
            onPress={() => onChange(option.value)}
            className={cn(
              'h-11 min-w-0 flex-1 flex-row items-center justify-center gap-2 rounded-md px-2',
              active && 'bg-primary'
            )}
          >
            <Icon size={16} className={active ? 'text-primary-fg' : 'text-muted'} />
            <Text
              numberOfLines={1}
              className={cn(
                'font-sans-medium flex-shrink text-center text-xs',
                active ? 'text-primary-fg' : 'text-muted'
              )}
            >
              {option.label}
            </Text>
          </Pressable>
        )
      })}
    </View>
  )
}

/**
 * Chip row where the chips split the row evenly — the icon sits above the
 * label so a full label still fits at four-across on the narrowest phone.
 */
function ChipRow<T extends string>({
  value,
  options,
  onChange
}: {
  value: T
  options: readonly Option<T>[]
  onChange: (value: T) => void
}): React.JSX.Element {
  return (
    <View className="w-full flex-row gap-2">
      {options.map((option) => {
        const active = value === option.value
        const Icon = option.icon
        return (
          <Pressable
            key={option.value}
            accessibilityRole="button"
            accessibilityState={{ selected: active }}
            onPress={() => onChange(option.value)}
            className={cn(
              'min-w-0 flex-1 flex-col items-center justify-center gap-1 rounded-lg border px-1.5 py-2.5',
              active ? 'bg-primary border-primary' : 'bg-bg border-border active:bg-border-soft'
            )}
          >
            <Icon size={16} className={active ? 'text-primary-fg' : 'text-muted'} />
            <Text
              numberOfLines={1}
              className={cn(
                'font-sans-medium text-center text-xs',
                active ? 'text-primary-fg' : 'text-fg'
              )}
            >
              {option.label}
            </Text>
          </Pressable>
        )
      })}
    </View>
  )
}

/** Chat mode + thinking level chips — shared by menu sheet and Model panel. */
export function ModeAndThinkingControls(): React.JSX.Element {
  const { t } = useTranslation()
  const chatMode = useConfigValue('chatMode')
  const thinkingMode = useConfigValue('thinkingMode')

  const modeOptions = CHAT_MODES.map((mode) => ({
    value: mode,
    label: t(`settings.chatModes.${mode}`),
    icon: CHAT_MODE_ICONS[mode]
  }))
  const thinkingOptions = THINKING_LEVELS.map((level) => ({
    value: level,
    label: t(`settings.thinking.${level}`),
    icon: THINKING_ICONS[level]
  }))

  return (
    <View className="flex-col gap-4">
      <View className="flex-col gap-2">
        <Text className="text-muted font-sans-medium text-left text-sm">
          {t('settings.model.modeLabel')}
        </Text>
        <SegmentedSwitch<ChatMode>
          value={chatMode}
          options={modeOptions}
          onChange={(mode) => setConfigValue('chatMode', mode)}
        />
        <Text className="text-muted text-left font-sans text-xs leading-5">
          {chatMode === 'single'
            ? t('settings.chatModes.singleDescription')
            : t('settings.chatModes.workflowDescription')}
        </Text>
      </View>

      <View className="flex-col gap-2">
        <Text className="text-muted font-sans-medium text-left text-sm">
          {t('settings.model.thinkingLabel')}
        </Text>
        <ChipRow<ThinkingLevel>
          value={thinkingMode}
          options={thinkingOptions}
          onChange={(level) => setConfigValue('thinkingMode', level)}
        />
      </View>
    </View>
  )
}

function formatElapsed(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000)
  if (totalSeconds < 60) return `${totalSeconds}s`
  const totalMinutes = Math.floor(totalSeconds / 60)
  if (totalMinutes < 60) return `${totalMinutes}m ${totalSeconds % 60}s`
  const hours = Math.floor(totalMinutes / 60)
  return `${hours}h ${totalMinutes % 60}m`
}

function formatCost(value: number): string {
  if (value === 0) return '$0'
  if (value < 1) return `$${value.toFixed(4)}`
  return `$${value.toFixed(2)}`
}

// Data colors, raw hex on purpose — same values the desktop card uses, so a
// cache-read row reads blue on both surfaces.
const COLOR_FRESH = '#22c55e'
const COLOR_OUTPUT = '#f59e0b'
const COLOR_CACHE_READ = '#60a5fa'
const COLOR_CACHE_WRITE = '#a78bfa'
const COLOR_AGENT_BAR = '#94a3b8'

/** Agent status → dot class, mirroring the desktop's row heartbeat. */
const AGENT_DOT: Record<WorkflowAgentView['status'], string> = {
  queued: 'bg-amber-500/50',
  running: 'bg-primary',
  completed: 'bg-emerald-500',
  failed: 'bg-rose-500',
  cancelled: 'bg-amber-500'
}

/** Ring/bar color: tracks the compaction trigger when it is known. */
function meterColor(used: number, budget: number, compactionAt: number | undefined): string {
  if (compactionAt && compactionAt > 0) {
    const fraction = used / compactionAt
    if (fraction >= 0.95) return '#ef4444'
    if (fraction >= 0.7) return COLOR_OUTPUT
    return COLOR_FRESH
  }
  const percent = budget > 0 ? used / budget : 0
  if (percent >= 0.8) return '#ef4444'
  if (percent >= 0.5) return COLOR_OUTPUT
  return COLOR_FRESH
}

/** Everything an agent consumed: prompt ingest (fresh + cache) plus output. */
function agentSpend(agent: WorkflowAgentView): number {
  return agent.inputTokens + agent.cacheReadTokens + agent.cacheWriteTokens + agent.outputTokens
}

function SectionTitle({
  icon,
  label,
  trailing
}: {
  icon: React.ReactNode
  label: string
  trailing?: string
}): React.JSX.Element {
  return (
    <View className="flex-row items-center gap-1.5">
      {icon}
      <Text className="text-muted font-sans-semibold flex-1 text-left text-[10px] uppercase">
        {label}
      </Text>
      {/* Values stay LTR. A trailing string that puts a translated word
          BETWEEN two numbers reorders anyway under RTL — neither
          writingDirection nor a bidi isolate holds it on iOS — so those
          strings separate the numbers with punctuation instead (see the ar
          `usage` key). */}
      {trailing ? (
        <Text className="text-fg font-sans text-[10px]" style={{ writingDirection: 'ltr' }}>
          {trailing}
        </Text>
      ) : null}
    </View>
  )
}

/** One stat line: icon + label, value at the end, optional magnitude bar. */
function StatRow({
  icon,
  label,
  value,
  fraction,
  color
}: {
  icon?: React.ReactNode
  label: string
  value: string
  fraction?: number
  color?: string
}): React.JSX.Element {
  return (
    <View className="flex-col gap-0.5">
      <View className="flex-row items-center gap-1.5">
        {icon}
        <Text numberOfLines={1} className="text-muted flex-1 text-left font-sans text-[11px]">
          {label}
        </Text>
        <Text className="text-fg font-sans text-[11px]" style={{ writingDirection: 'ltr' }}>
          {value}
        </Text>
      </View>
      {fraction !== undefined ? (
        <View className="bg-surface-soft h-0.5 w-full overflow-hidden rounded-full">
          <View
            className="h-full rounded-full"
            style={{
              width: `${Math.min(100, Math.max(0, fraction * 100))}%`,
              backgroundColor: color ?? COLOR_AGENT_BAR
            }}
          />
        </View>
      ) : null}
    </View>
  )
}

/** The workflow run behind the conversation's most recent workflow segment. */
function lastWorkflow(conversation: ConversationFile | null | undefined): WorkflowSnapshot | null {
  const messages = conversation?.messages ?? []
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const segments = messages[index]?.segments ?? []
    for (let inner = segments.length - 1; inner >= 0; inner -= 1) {
      const segment = segments[inner]
      if (segment.kind === 'workflow') return segment.snapshot
    }
  }
  return null
}

/**
 * Context meter — the desktop's hover card (common/context-meter) as a mobile
 * panel: the model that measured the reading, the context window with its
 * auto-compaction tick, the last turn's token composition, the workflow run
 * that produced it, and the conversation's all-time roll-up. Everything is
 * read from the persisted stats block the desktop writes at each turn fold;
 * the live-turn and last-call sections have no persisted counterpart, so they
 * are the two the desktop card has and this one does not.
 */
export function ContextMeterCard({
  conversation
}: {
  conversation: ConversationFile | null | undefined
}): React.JSX.Element {
  const { t, i18n } = useTranslation()
  const locale = i18n.language || 'en'
  const meter = conversation?.stats?.meter
  const allTime = conversation?.stats?.allTime
  const lastTurn = conversation?.stats?.lastTurn
  const workflow = lastWorkflow(conversation)

  const used = meter?.contextTokens ?? 0
  const budget = meter?.contextBudget ?? 0
  const compactionAt = meter?.compactionAt
  const percent = budget > 0 ? Math.min(Math.round((used / budget) * 100), 100) : 0
  const hasReading = used > 0 && budget > 0
  const color = hasReading ? meterColor(used, budget, compactionAt) : undefined

  const meterModel = meter?.model ?? null
  const activeModel = conversation?.model ?? null
  const model = meterModel ?? activeModel
  const provider = lastTurn?.provider ?? allTime?.provider ?? providerForModel(model)
  const HeaderLogo = provider ? PROVIDER_LOGOS[provider === 'local' ? 'ollama' : provider] : null
  const modelMismatch =
    meterModel !== null && activeModel !== null && meterModel !== activeModel && hasReading

  // The tick sits where auto-compaction fires, as a share of the window.
  const tickPercent =
    compactionAt && budget > 0 && compactionAt < budget ? (compactionAt / budget) * 100 : null

  const turnIn = lastTurn?.inputTokens ?? 0
  const turnOut = lastTurn?.outputTokens ?? 0
  const turnCacheRead = lastTurn?.cacheReadTokens ?? 0
  const turnCacheWrite = lastTurn?.cacheCreationTokens ?? 0
  const turnMax = Math.max(turnIn, turnOut, turnCacheRead, turnCacheWrite, 1)

  const allMax = Math.max(
    allTime?.inputTokens ?? 0,
    allTime?.outputTokens ?? 0,
    allTime?.cacheReadTokens ?? 0,
    allTime?.cacheCreationTokens ?? 0,
    1
  )
  const allIngested =
    (allTime?.inputTokens ?? 0) +
    (allTime?.cacheReadTokens ?? 0) +
    (allTime?.cacheCreationTokens ?? 0)
  const cachedShare =
    allIngested > 0 ? Math.round(((allTime?.cacheReadTokens ?? 0) / allIngested) * 100) : 0

  const agents = workflow?.agents ?? []
  const agentsDone = agents.filter((agent) => agent.status === 'completed').length
  const agentMaxSpend = agents.reduce((max, agent) => Math.max(max, agentSpend(agent)), 1)
  const workflowTokens = workflow
    ? workflow.totals.inputTokens +
      workflow.totals.outputTokens +
      workflow.totals.cacheReadTokens +
      workflow.totals.cacheWriteTokens
    : 0

  const hasAnything = hasReading || Boolean(lastTurn) || Boolean(allTime) || agents.length > 0

  return (
    <View className="flex-col gap-3">
      {/* Header: the brain the reading was measured under. */}
      <View className="flex-row items-center gap-2">
        {HeaderLogo ? <HeaderLogo size={14} className="text-fg" /> : null}
        <Text
          numberOfLines={1}
          className="text-fg font-sans-medium flex-1 text-left text-xs"
          style={{ writingDirection: 'ltr' }}
        >
          {model ?? t('chat.contextCard.noModel')}
        </Text>
      </View>

      {!hasAnything ? (
        <Text className="text-muted text-center font-sans text-[11px] leading-5">
          {t('chat.contextCard.empty')}
        </Text>
      ) : (
        <>
          {/* Context window */}
          <View className="flex-col gap-1.5">
            <SectionTitle
              icon={<Database01Icon size={12} className="text-muted" />}
              label={t('chat.contextCard.context')}
              trailing={t('chat.contextCard.usage', {
                used: formatTokens(used, locale),
                max: formatTokens(budget, locale),
                percent
              })}
            />
            <View className="relative">
              <View className="bg-surface-soft h-1.5 w-full flex-row overflow-hidden rounded-full">
                <View
                  className="h-full"
                  style={{
                    width: `${budget > 0 ? Math.min(100, (used / budget) * 100) : 0}%`,
                    backgroundColor: color ?? COLOR_FRESH
                  }}
                />
              </View>
              {tickPercent !== null ? (
                // Physical `left`: the bar is a fixed LTR scale, so a logical
                // inset would mirror the tick to the wrong end in Arabic.
                <View
                  className="bg-muted absolute -top-0.5 h-2.5 w-px"
                  style={{ left: `${tickPercent}%` }}
                />
              ) : null}
            </View>
            {tickPercent !== null ? (
              <Text className="text-muted text-left font-sans text-[10px]">
                {t('chat.contextCard.compactAt', {
                  value: formatTokens(compactionAt ?? 0, locale)
                })}
              </Text>
            ) : null}
            {modelMismatch ? (
              <Text className="text-muted text-left font-sans text-[10px]">
                {t('chat.contextCard.measuredUnder', { model: meterModel })}
              </Text>
            ) : null}
          </View>

          {/* Last turn */}
          {lastTurn ? (
            <View className="flex-col gap-1.5">
              <SectionTitle
                icon={<Clock01Icon size={12} className="text-muted" />}
                label={t('chat.contextCard.lastTurn')}
                trailing={
                  lastTurn.elapsedMs !== undefined ? formatElapsed(lastTurn.elapsedMs) : undefined
                }
              />
              <View className="flex-col gap-1">
                <StatRow
                  icon={<ArrowUp02Icon size={12} className="text-muted" />}
                  label={t('chat.contextCard.input')}
                  value={formatTokens(turnIn, locale)}
                  fraction={turnIn / turnMax}
                  color={COLOR_FRESH}
                />
                <StatRow
                  icon={<ArrowDown02Icon size={12} className="text-muted" />}
                  label={t('chat.contextCard.output')}
                  value={formatTokens(turnOut, locale)}
                  fraction={turnOut / turnMax}
                  color={COLOR_OUTPUT}
                />
                <StatRow
                  icon={<Database01Icon size={12} className="text-muted" />}
                  label={t('chat.contextCard.cacheRead')}
                  value={formatTokens(turnCacheRead, locale)}
                  fraction={turnCacheRead / turnMax}
                  color={COLOR_CACHE_READ}
                />
                <StatRow
                  icon={<Database02Icon size={12} className="text-muted" />}
                  label={t('chat.contextCard.cacheWrite')}
                  value={formatTokens(turnCacheWrite, locale)}
                  fraction={turnCacheWrite / turnMax}
                  color={COLOR_CACHE_WRITE}
                />
                <StatRow
                  icon={<Activity04Icon size={12} className="text-muted" />}
                  label={t('chat.contextCard.calls')}
                  value={`${lastTurn.apiCalls ?? 0} · ${t('chat.contextCard.tools', {
                    count: lastTurn.toolCalls ?? 0
                  })}`}
                />
                {lastTurn.cost !== undefined && lastTurn.cost > 0 ? (
                  <StatRow
                    icon={<DollarCircleIcon size={12} className="text-muted" />}
                    label={t('chat.contextCard.cost')}
                    value={formatCost(lastTurn.cost)}
                  />
                ) : null}
              </View>
            </View>
          ) : null}

          {/* Workflow — one row per agent of the last run. */}
          {workflow && agents.length > 0 ? (
            <View className="flex-col gap-1.5">
              <SectionTitle
                icon={<WorkflowSquare03Icon size={12} className="text-muted" />}
                label={t('chat.contextCard.workflow')}
                trailing={`${agentsDone}/${agents.length}`}
              />
              <View className="flex-col gap-1">
                {agents.map((agent) => (
                  <StatRow
                    key={agent.id}
                    icon={
                      <View className={cn('h-1.5 w-1.5 rounded-full', AGENT_DOT[agent.status])} />
                    }
                    label={agent.name}
                    value={`${formatTokens(agentSpend(agent), locale)}${
                      agent.cost > 0 ? ` · ${formatCost(agent.cost)}` : ''
                    }`}
                    fraction={agentSpend(agent) / agentMaxSpend}
                    color={COLOR_AGENT_BAR}
                  />
                ))}
              </View>
              <Text
                className="text-muted text-left font-sans text-[10px]"
                style={{ writingDirection: 'ltr' }}
              >
                {t('chat.contextCard.workflowTotals', {
                  tools: workflow.totals.toolCalls,
                  tokens: formatTokens(workflowTokens, locale)
                })}
                {workflow.totals.cost > 0 ? ` · ${formatCost(workflow.totals.cost)}` : ''}
              </Text>
            </View>
          ) : null}

          {/* All time */}
          {allTime && (allTime.turns ?? 0) > 0 ? (
            <View className="flex-col gap-1.5">
              <SectionTitle
                icon={<HourglassIcon size={12} className="text-muted" />}
                label={t('chat.contextCard.allTime')}
                trailing={
                  allTime.processingMs !== undefined
                    ? formatElapsed(allTime.processingMs)
                    : undefined
                }
              />
              <View className="flex-col gap-1">
                <StatRow
                  icon={<RepeatIcon size={12} className="text-muted" />}
                  label={t('chat.contextCard.turns')}
                  value={`${allTime.turns ?? 0}`}
                />
                <StatRow
                  icon={<Activity04Icon size={12} className="text-muted" />}
                  label={t('chat.contextCard.apiCalls')}
                  value={`${allTime.apiCalls ?? 0}`}
                />
                <StatRow
                  icon={<CpuIcon size={12} className="text-muted" />}
                  label={t('chat.contextCard.toolCalls')}
                  value={`${allTime.toolCalls ?? 0}`}
                />
                <StatRow
                  icon={<ArrowUp02Icon size={12} className="text-muted" />}
                  label={t('chat.contextCard.input')}
                  value={formatTokens(allTime.inputTokens, locale)}
                  fraction={(allTime.inputTokens ?? 0) / allMax}
                  color={COLOR_FRESH}
                />
                <StatRow
                  icon={<ArrowDown02Icon size={12} className="text-muted" />}
                  label={t('chat.contextCard.output')}
                  value={formatTokens(allTime.outputTokens, locale)}
                  fraction={(allTime.outputTokens ?? 0) / allMax}
                  color={COLOR_OUTPUT}
                />
                <StatRow
                  icon={<Database01Icon size={12} className="text-muted" />}
                  label={t('chat.contextCard.cacheRead')}
                  value={formatTokens(allTime.cacheReadTokens, locale)}
                  fraction={(allTime.cacheReadTokens ?? 0) / allMax}
                  color={COLOR_CACHE_READ}
                />
                <StatRow
                  icon={<Database02Icon size={12} className="text-muted" />}
                  label={t('chat.contextCard.cacheWrite')}
                  value={formatTokens(allTime.cacheCreationTokens, locale)}
                  fraction={(allTime.cacheCreationTokens ?? 0) / allMax}
                  color={COLOR_CACHE_WRITE}
                />
                <StatRow
                  icon={<DollarCircleIcon size={12} className="text-muted" />}
                  label={t('chat.contextCard.cost')}
                  value={formatCost(allTime.cost ?? 0)}
                />
              </View>
              {cachedShare > 0 ? (
                <Text className="text-muted text-left font-sans text-[10px] leading-4">
                  {t('chat.contextCard.cachedShare', { percent: cachedShare })}
                </Text>
              ) : null}
            </View>
          ) : null}
        </>
      )}
    </View>
  )
}
