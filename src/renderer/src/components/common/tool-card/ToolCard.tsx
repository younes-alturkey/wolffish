import { CodeBlock } from '@components/core/CodeBlock'
import { cn } from '@lib/utils/cn'
import type { Segment, ToolResultMeta, ToolResultStatus } from '@preload/index'
import type { ToolTiming } from '@providers/flow/useFlow'
import { ArrowDown01Icon, ArrowRight01Icon } from 'hugeicons-react'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { DiffView } from './DiffView'

type ToolCallSegment = Extract<Segment, { kind: 'tool_call' }>
type ToolResultSegment = Extract<Segment, { kind: 'tool_result' }>

type CardStatus = ToolResultStatus | 'running'

const STATUS_COLOR: Record<CardStatus, string> = {
  running: 'bg-accent/10 text-accent',
  // A call that checked in: the model has its progress report, the call is
  // still running. Amber, pulsing — neither done nor failed — until the
  // in-place update lands (or forever, if the call outlives its turn).
  checked_in: 'bg-amber-500/10 text-amber-600 dark:text-amber-400',
  success: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400',
  failed: 'bg-red-500/10 text-red-600 dark:text-red-400',
  denied: 'bg-muted/20 text-muted',
  // Ended on purpose — the user's Stop, or the model's call_stop. A warning,
  // not a failure: nothing went wrong, it was cut short.
  stopped: 'bg-amber-500/10 text-amber-600 dark:text-amber-400'
}

/** The i18n key under chat.toolCard.status for a card's pill. */
function statusLabelKey(status: CardStatus, meta?: ToolResultMeta): string {
  if (status !== 'stopped') return status
  if (meta?.stoppedBy === 'user') return 'stoppedByUser'
  if (meta?.stoppedBy === 'model') return 'stoppedByModel'
  return status
}

/**
 * The tool-activity card. Everything it shows comes from the two persisted
 * segments (the call and its result, matched by toolCallId) plus the live
 * timing while a call is running — so a card reopened from history renders
 * exactly what the live feed showed, in the same position.
 *
 * `compact` is the clean-feed variant for the code tools (edits, writes,
 * shell runs): a one-line activity row — status, label, file or command,
 * +N −M / exit chips — collapsed by default, expandable to the diff or the
 * output. Verbose renders the full card, expanded.
 */
export function ToolCard({
  call,
  result,
  timing,
  compact = false
}: {
  call: ToolCallSegment
  result?: ToolResultSegment
  timing?: ToolTiming
  compact?: boolean
}): React.JSX.Element {
  const { t } = useTranslation()
  const status: CardStatus = result?.status ?? 'running'
  const isRunning = status === 'running' || status === 'checked_in'
  const meta: ToolResultMeta | undefined = result?.meta
  const argsKeys = Object.keys(call.args)
  const hasOutput = !!result?.output && result.output.length > 0
  const hasDiff = !!meta?.diff?.patch
  const canExpand = argsKeys.length > 0 || hasOutput || !!result?.error || hasDiff

  // Full cards stay expanded by default — both while running and once done —
  // so finished work stays visible without a click. Compact rows start
  // collapsed. We never auto-collapse on status transitions; only the user's
  // manual toggle changes the state, and it sticks.
  const [expanded, setExpanded] = useState<boolean>(!compact)

  // Live-tick a wall clock while the tool is running so the elapsed
  // counter on the card moves. Once the result lands, timing.endedAt is
  // set and the effect tears the interval down — the card freezes the
  // final duration instead of drifting. A checked-in call keeps ticking:
  // its result is a progress report, not an end.
  const [now, setNow] = useState<number>(() => Date.now())
  const ticking = status === 'checked_in' || (!!timing && timing.endedAt === undefined)
  useEffect(() => {
    if (!timing || !ticking) return
    const id = setInterval(() => setNow(Date.now()), 200)
    return () => clearInterval(id)
  }, [timing, ticking])

  // A reopened conversation has no live timing; the tool's own measured
  // duration (shell runs record it) fills the same slot.
  const elapsedMs = timing
    ? (status === 'checked_in' ? now : (timing.endedAt ?? now)) - timing.startedAt
    : typeof meta?.durationMs === 'number'
      ? meta.durationMs
      : null
  const action = describeAction(call.name, call.args)
  const label = meta?.label ?? defaultLabel(call.name)
  const stopReason =
    status === 'stopped' && (meta?.stoppedBy === 'user' || meta?.stoppedBy === 'model')
      ? t(`chat.toolCard.stopReason.${meta.stoppedBy}`)
      : null

  return (
    <div
      className={cn(
        'group border-border bg-surface w-full max-w-[85%] self-start rounded-2xl border text-sm',
        compact ? 'px-3 py-2' : 'px-4 py-3'
      )}
    >
      <button
        type="button"
        onClick={() => canExpand && setExpanded((v) => !v)}
        disabled={!canExpand}
        className="flex w-full items-center justify-between gap-3 text-start disabled:cursor-default"
      >
        <div className="flex min-w-0 items-center gap-2">
          <span
            className={cn(
              'inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-xs font-medium',
              STATUS_COLOR[status],
              isRunning && 'animate-pulse'
            )}
          >
            {t(`chat.toolCard.status.${statusLabelKey(status, meta)}`)}
          </span>
          {label && <span className="text-fg shrink-0 text-xs font-medium">{label}</span>}
          <code dir="ltr" className={cn('truncate', label ? 'text-muted' : 'text-fg font-medium')}>
            {compact && action ? firstLine(action) : call.name}
          </code>
          {meta?.diff && (
            <span className="shrink-0 text-xs tabular-nums">
              <span className="text-emerald-600 dark:text-emerald-400">+{meta.diff.additions}</span>{' '}
              <span className="text-red-600 dark:text-red-400">−{meta.diff.deletions}</span>
            </span>
          )}
          {meta?.checkIn && status === 'checked_in' && (
            <span className="text-muted shrink-0 text-[11px]">{meta.checkIn.handle}</span>
          )}
          {typeof meta?.exitCode === 'number' && (
            <span
              className={cn(
                'shrink-0 rounded-full px-1.5 py-0.5 text-[11px] tabular-nums',
                meta.exitCode === 0
                  ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
                  : 'bg-red-500/10 text-red-600 dark:text-red-400'
              )}
            >
              {t('chat.toolCard.exit', { code: meta.exitCode })}
            </span>
          )}
          {canExpand &&
            (expanded ? (
              <ArrowDown01Icon size={14} className="text-muted shrink-0" aria-hidden />
            ) : (
              <ArrowRight01Icon size={14} className="text-muted shrink-0" aria-hidden />
            ))}
        </div>
        {elapsedMs !== null && (
          <span className="text-muted shrink-0 text-xs tabular-nums">
            {formatElapsedCompact(elapsedMs)}
          </span>
        )}
      </button>

      {stopReason && (!compact || expanded) && (
        <p className="text-muted mt-1.5 text-xs">{stopReason}</p>
      )}

      {action && (!compact || expanded) && (
        <CodeBlock content={action} language={detectActionLanguage(call.args)} className="mt-2" />
      )}

      {expanded && hasDiff && meta?.diff && <DiffView patch={meta.diff.patch} className="mt-2" />}

      {expanded && !compact && argsKeys.length > 0 && !hasDiff && (
        <CodeBlock content={jsonInline(call.args)} language="json" className="mt-2" />
      )}
      {/* On failure the error block below carries the full raw original, so
          suppress the output block to avoid showing the classified message
          and the raw dump as two near-identical blocks. */}
      {expanded && hasOutput && !result?.error && result && (
        <CodeBlock
          content={result.output}
          maxH={hasDiff ? 'max-h-32' : 'max-h-48'}
          className="mt-2"
        />
      )}
      {expanded && result?.error && (
        <CodeBlock
          content={result.error}
          tone={status === 'stopped' ? 'default' : 'error'}
          maxH="max-h-72"
          className="mt-2"
        />
      )}
      {expanded && meta?.outputPath && (
        <p dir="ltr" className="text-muted mt-2 truncate text-xs">
          {t('chat.toolCard.savedTo')} <code>{meta.outputPath}</code>
        </p>
      )}
    </div>
  )
}

function defaultLabel(tool: string): string | null {
  switch (tool) {
    case 'file_edit':
    case 'file_patch':
      return 'Edit'
    case 'file_write':
      return 'Write'
    case 'file_read':
      return 'Read'
    case 'file_grep':
      return 'Search'
    case 'file_glob':
      return 'Find files'
    case 'shell_exec':
      return 'Run'
    default:
      return null
  }
}

function firstLine(text: string): string {
  const nl = text.indexOf('\n')
  return nl === -1 ? text : text.slice(0, nl)
}

// Pick a sensible language hint for the inline action preview based on
// which arg the describeAction function picked up.
function detectActionLanguage(args: Record<string, unknown>): string | undefined {
  if (typeof args.command === 'string' && args.command.length > 0) return 'bash'
  if (typeof args.find === 'string' && typeof args.replace === 'string') return 'diff'
  return undefined
}

// Pick the most meaningful "what's happening" line for the card. Most
// tools have one primary input (a command, a path) — that's what the
// user wants to see at a glance. Returns null when no obvious primary
// arg exists; the card falls back to the expandable args view.
function describeAction(tool: string, args: Record<string, unknown>): string | null {
  if (typeof args.command === 'string' && args.command.length > 0) {
    return args.command
  }
  if (typeof args.pattern === 'string' && args.pattern.length > 0) {
    const where = typeof args.path === 'string' && args.path.length > 0 ? ` in ${args.path}` : ''
    return `${args.pattern}${where}`
  }
  if (typeof args.path === 'string' && args.path.length > 0) {
    // file_edit carries its change as a diff on the result; the path is the
    // headline. The legacy find/replace pair keeps its two-line preview.
    if (tool === 'file_edit' || (typeof args.old === 'string' && typeof args.new === 'string')) {
      return args.path
    }
    if (typeof args.find === 'string' && typeof args.replace === 'string') {
      return `${args.path}\n- ${truncate(args.find, 80)}\n+ ${truncate(args.replace, 80)}`
    }
    if (typeof args.offset === 'number' || typeof args.limit === 'number') {
      const start = typeof args.offset === 'number' ? args.offset : 1
      const end = typeof args.limit === 'number' ? start + args.limit - 1 : ''
      return `${args.path}:${start}-${end}`
    }
    if (typeof args.startLine === 'number' || typeof args.endLine === 'number') {
      const start = args.startLine ?? ''
      const end = args.endLine ?? ''
      return `${args.path}:${start}-${end}`
    }
    return args.path
  }
  if (typeof args.query === 'string' && args.query.length > 0) {
    return args.query
  }
  return null
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text
  return `${text.slice(0, max - 1)}…`
}

function formatElapsedCompact(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  const totalSeconds = ms / 1000
  if (totalSeconds < 60) return `${totalSeconds.toFixed(totalSeconds < 10 ? 1 : 0)}s`
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = Math.floor(totalSeconds % 60)
  return `${minutes}m ${seconds}s`
}

function jsonInline(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}
