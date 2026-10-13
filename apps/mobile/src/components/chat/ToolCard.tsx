import { ArrowDown01Icon, ArrowLeft01Icon, ArrowRight01Icon } from '@/components/core/icons'
import { DiffView } from '@/components/chat/DiffView'
import type { ToolCallInfo, ToolResultInfo } from '@/lib/conversations/segments'
import type { ToolTiming } from '@/lib/conversations/types'
import { NEEDS_SELECT_SHEET, openSelectText } from '@/components/chat/SelectTextSheet'
import { cn } from '@/lib/utils/cn'
import { memo, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { I18nManager, Pressable, ScrollView, Text, View } from 'react-native'

/**
 * Tool card — the mobile take on the desktop ToolCard, in its two shapes:
 *
 *  - the verbose-feed card: status pill, tool name, headline action, and
 *    expandable args/output/error blocks, expanded by default;
 *  - the COMPACT row the clean feed shows for the code tools (edits, writes,
 *    shell runs): status, a short label, the file or command, a green/red
 *    +N −M for an edit or the exit code for a run, and the elapsed time —
 *    collapsed by default, expandable to the red/green diff or the output.
 *
 * Everything on the row comes from the tool_result's `meta` (segments.ts
 * ToolResultInfo.meta) or the call's own args, so a live row and a row
 * reopened from the stored transcript are the same pixels. Long outputs are
 * clamped; unknown tool names render fine (the workspace data contains 150
 * distinct tools, some with typos — never assume a name).
 */

const OUTPUT_CLAMP = 1200

/** Best single-line summary of the call, like the desktop "action" headline. */
function headlineFor(call: ToolCallInfo): string | null {
  const args = call.args
  if (typeof args.command === 'string' && args.command.trim()) return args.command.trim()
  if (typeof args.pattern === 'string' && args.pattern.trim()) {
    const where = typeof args.path === 'string' && args.path.trim() ? ` in ${args.path}` : ''
    return `${args.pattern.trim()}${where}`
  }
  const candidates = ['path', 'file_path', 'url', 'query', 'prompt', 'to', 'title']
  for (const key of candidates) {
    const value = args[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return null
}

function firstLine(text: string): string {
  const nl = text.indexOf('\n')
  return nl === -1 ? text : text.slice(0, nl)
}

/** The label a code tool wears when its result names none — desktop defaultLabel. */
function labelKeyFor(tool: string): string | null {
  switch (tool) {
    case 'file_edit':
    case 'file_patch':
      return 'edit'
    case 'file_write':
      return 'write'
    case 'file_read':
      return 'read'
    case 'file_grep':
      return 'search'
    case 'file_glob':
      return 'find'
    case 'shell_exec':
      return 'run'
    default:
      return null
  }
}

function formatElapsed(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  const totalSeconds = ms / 1000
  if (totalSeconds < 60) return `${totalSeconds.toFixed(totalSeconds < 10 ? 1 : 0)}s`
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = Math.floor(totalSeconds % 60)
  return `${minutes}m ${seconds}s`
}

function statusTone(status: ToolResultInfo['status'] | 'running'): {
  container: string
  text: string
} {
  switch (status) {
    case 'success':
      return { container: 'bg-emerald-500/15', text: 'text-emerald-600 dark:text-emerald-400' }
    case 'failed':
      return { container: 'bg-red-500/15', text: 'text-red-600 dark:text-red-400' }
    case 'denied':
      return { container: 'bg-amber-500/15', text: 'text-amber-600 dark:text-amber-400' }
    // Checked in: the desktop's still-running state — the model got a
    // progress report and the call keeps going until its real result lands.
    case 'checked_in':
      return { container: 'bg-amber-500/15', text: 'text-amber-600 dark:text-amber-400' }
    // Stopped on purpose — the user's Stop or the model's call_stop. A
    // warning, not a failure: nothing went wrong, it was cut short.
    case 'stopped':
      return { container: 'bg-amber-500/15', text: 'text-amber-600 dark:text-amber-400' }
    default:
      return { container: 'bg-primary-soft', text: 'text-primary' }
  }
}

/** The monospace payload block. Shared with the approval card, which shows the
 *  exact command and args a flagged tool call would run.
 *
 *  A command, a path, an error string — this is the text most likely to be
 *  wanted in pieces, so it gets the same treatment as a message bubble: real
 *  in-place selection on Android, the free-selection sheet on iOS. The sheet
 *  shows the UNCLAMPED text, since a long output is exactly the case where the
 *  clamp would otherwise hide the line you were reaching for. */
export function CodeBlockText({
  text,
  error
}: {
  text: string
  error?: boolean
}): React.JSX.Element {
  const clamped = text.length > OUTPUT_CLAMP ? `${text.slice(0, OUTPUT_CLAMP)}…` : text
  return (
    <ScrollView
      horizontal={false}
      className={cn('bg-bg border-border max-h-48 rounded-md border', error && 'border-red-500/40')}
      nestedScrollEnabled
    >
      <Text
        selectable={!NEEDS_SELECT_SHEET}
        // The sheet gets the UNCLAMPED text: a long output is exactly the case
        // where the line you were reaching for is past the clamp.
        onLongPress={NEEDS_SELECT_SHEET ? () => openSelectText(text) : undefined}
        suppressHighlighting
        style={{ writingDirection: 'ltr' }}
        className={cn(
          'p-2.5 text-left font-mono text-xs leading-4',
          error ? 'text-red-600 dark:text-red-400' : 'text-fg'
        )}
      >
        {clamped}
      </Text>
    </ScrollView>
  )
}

export type ToolCardProps = {
  call: ToolCallInfo
  result?: ToolResultInfo
  timing?: ToolTiming
  /**
   * The clean-feed shape: one collapsed row (label, path or command, +N −M or
   * exit code) that expands to the diff or output. Verbose cards leave it off.
   */
  compact?: boolean
}

export const ToolCard = memo(function ToolCard({
  call,
  result,
  timing,
  compact = false
}: ToolCardProps): React.JSX.Element {
  const { t } = useTranslation()
  // Verbose cards open expanded; compact rows start folded. Only the user's
  // tap changes it afterwards — never a status transition.
  const [expanded, setExpanded] = useState(!compact)
  const status = result?.status ?? 'running'
  const running = status === 'running' || status === 'checked_in'
  const tone = statusTone(status)
  const meta = result?.meta
  const headline = headlineFor(call)
  const hasDiff = !!meta?.diff?.patch
  const hasArgs = Object.keys(call.args).length > 0
  const canExpand = hasArgs || !!result?.output || !!result?.error || hasDiff

  // A live tick keeps the elapsed counter moving while the tool runs; once the
  // result lands, timing.endedAt freezes it. A reopened conversation has no
  // live timing, so the tool's own measured duration fills the same slot.
  // A checked-in call keeps ticking: its result is a progress report, not an
  // end. Without live timing the clock runs from the reported duration.
  const checkedIn = status === 'checked_in'
  const [now, setNow] = useState(() => Date.now())
  const [mountedAt] = useState(() => Date.now())
  const ticking = checkedIn || (!!timing && timing.endedAt === undefined)
  useEffect(() => {
    if (!ticking) return
    const id = setInterval(() => setNow(Date.now()), 500)
    return () => clearInterval(id)
  }, [ticking])
  const elapsedMs = timing
    ? (checkedIn ? now : (timing.endedAt ?? now)) - timing.startedAt
    : typeof meta?.durationMs === 'number'
      ? meta.durationMs + (checkedIn ? now - mountedAt : 0)
      : null

  const labelKey = labelKeyFor(call.name)
  const label = meta?.label ?? (labelKey ? t(`chat.toolCard.label.${labelKey}`) : null)
  const stoppedBy = status === 'stopped' ? meta?.stoppedBy : undefined
  const statusLabelKey =
    stoppedBy === 'user' ? 'stoppedByUser' : stoppedBy === 'model' ? 'stoppedByModel' : status
  const statusLabel = t(`chat.toolCard.status.${statusLabelKey}`)
  const stopReason = stoppedBy ? t(`chat.toolCard.stopReason.${stoppedBy}`) : null
  // Collapsed chevron points into the reading direction.
  const Chevron = expanded
    ? ArrowDown01Icon
    : I18nManager.isRTL
      ? ArrowLeft01Icon
      : ArrowRight01Icon

  return (
    <View
      className={cn(
        // The agent's width, like every other card in the feed (85%, the same
        // cap the desktop's ToolCard carries): a tool card that runs the feed
        // edge to edge reads as the feed's own furniture rather than as
        // something the agent did.
        'bg-surface border-border w-[85%] flex-col gap-2 self-start rounded-xl border',
        compact ? 'px-2.5 py-2' : 'px-3 py-2.5'
      )}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded, disabled: !canExpand }}
        disabled={!canExpand}
        onPress={() => setExpanded((value) => !value)}
        className="flex-row items-center gap-2"
      >
        <View
          className={cn('rounded-full px-2 py-0.5', tone.container, running && 'animate-pulse')}
        >
          <Text className={cn('font-sans-medium text-[10px]', tone.text)}>{statusLabel}</Text>
        </View>
        {compact && label ? (
          <Text numberOfLines={1} className="text-fg font-sans-medium shrink-0 text-xs">
            {label}
          </Text>
        ) : null}
        <Text
          numberOfLines={1}
          className={cn(
            'flex-1 text-left text-xs',
            compact && headline ? 'text-muted font-mono' : 'text-fg font-sans-medium'
          )}
          style={compact && headline ? { writingDirection: 'ltr' } : undefined}
        >
          {compact && headline ? firstLine(headline) : call.name}
        </Text>
        {meta?.diff ? (
          <Text className="font-sans text-[11px]" style={{ writingDirection: 'ltr' }}>
            <Text className="text-emerald-600 dark:text-emerald-400">+{meta.diff.additions}</Text>
            <Text className="text-muted"> </Text>
            <Text className="text-red-600 dark:text-red-400">−{meta.diff.deletions}</Text>
          </Text>
        ) : null}
        {checkedIn && meta?.checkIn ? (
          <Text className="text-muted font-mono text-[10px]" style={{ writingDirection: 'ltr' }}>
            {meta.checkIn.handle}
          </Text>
        ) : null}
        {typeof meta?.exitCode === 'number' ? (
          <View
            className={cn(
              'rounded-full px-1.5 py-0.5',
              meta.exitCode === 0 ? 'bg-emerald-500/15' : 'bg-red-500/15'
            )}
          >
            <Text
              className={cn(
                'font-sans text-[10px]',
                meta.exitCode === 0
                  ? 'text-emerald-600 dark:text-emerald-400'
                  : 'text-red-600 dark:text-red-400'
              )}
              style={{ writingDirection: 'ltr' }}
            >
              {t('chat.toolCard.exit', { code: meta.exitCode })}
            </Text>
          </View>
        ) : null}
        {elapsedMs !== null ? (
          <Text className="text-muted font-sans text-[10px]" style={{ writingDirection: 'ltr' }}>
            {formatElapsed(Math.max(0, elapsedMs))}
          </Text>
        ) : null}
        {canExpand ? <Chevron size={14} className="text-muted" /> : null}
      </Pressable>
      {/* The verbose card always shows its headline; the compact row folds it
          into the title and shows the full text (a multi-line command) only
          once opened. */}
      {stopReason && (!compact || expanded) ? (
        <Text className="text-muted text-left font-sans text-[11px]">{stopReason}</Text>
      ) : null}
      {headline && (!compact || expanded) ? <CodeBlockText text={headline} /> : null}
      {expanded && (
        <View className="flex-col gap-2">
          {hasDiff && meta?.diff ? <DiffView patch={meta.diff.patch} /> : null}
          {!compact && hasArgs && !hasDiff ? (
            <View className="flex-col gap-1">
              <Text className="text-muted font-sans-medium text-left text-[10px]">
                {t('chat.toolCard.args')}
              </Text>
              <CodeBlockText text={JSON.stringify(call.args, null, 2)} />
            </View>
          ) : null}
          {/* On failure the error block carries the full raw original, so the
              output block stays out — the two would be near-identical. */}
          {result?.output && !result.error ? (
            <View className="flex-col gap-1">
              {!compact ? (
                <Text className="text-muted font-sans-medium text-left text-[10px]">
                  {t('chat.toolCard.output')}
                </Text>
              ) : null}
              <CodeBlockText text={result.output} />
            </View>
          ) : null}
          {result?.error ? (
            <View className="flex-col gap-1">
              <Text className="text-muted font-sans-medium text-left text-[10px]">
                {t('chat.toolCard.error')}
              </Text>
              <CodeBlockText text={result.error} error={status !== 'stopped'} />
            </View>
          ) : null}
          {meta?.outputPath ? (
            <Text
              numberOfLines={1}
              className="text-muted text-left font-sans text-[10px]"
              style={{ writingDirection: 'ltr' }}
            >
              {t('chat.toolCard.savedTo')} {meta.outputPath}
            </Text>
          ) : null}
        </View>
      )}
    </View>
  )
})
