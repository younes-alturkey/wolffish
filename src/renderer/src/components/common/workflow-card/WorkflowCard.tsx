import { cn } from '@lib/utils/cn'
import { formatCompact } from '@lib/utils/format'
import type { WorkflowAgentView, WorkflowSnapshot } from '@main/runtime/broca'
import { PROVIDER_LOGOS } from '@pages/settings/modelCatalog'
import type { CloudProviderConfig } from '@preload/index'
import {
  Alert02Icon,
  ArrowDown01Icon,
  CancelCircleIcon,
  CheckmarkCircle02Icon,
  Loading03Icon,
  WorkflowSquare03Icon
} from 'hugeicons-react'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

/**
 * The workflow card — the single user-facing surface for a workflow-mode run.
 * Full-width, collapsible, and DETERMINISTIC: everything rendered comes from
 * the harness's WorkflowSnapshot (statuses, tokens, cost, wall-clock, tool
 * counts), never from model claims. One card per run: snapshots replace each
 * other by workflowId upstream, so this component always sees the latest
 * state — live streaming and a reloaded conversation render identically.
 *
 * Collapsed, the feed reads as the master's replies alone; expanded, it shows
 * the plan (phases with derived statuses) and one row per agent: status,
 * name, model, phase, elapsed, context (tokens), tool calls, cost, and the
 * task snippet.
 */
export function WorkflowCard({ snapshot }: { snapshot: WorkflowSnapshot }): React.JSX.Element {
  const { t } = useTranslation()
  const [collapsed, setCollapsed] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const running = snapshot.status === 'running'

  // 1 Hz tick while running so elapsed times count up live.
  const [now, setNow] = useState<number>(() => Date.now())
  useEffect(() => {
    if (!running) return
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [running])

  const elapsedMs = Math.max(0, (snapshot.endedAt ?? now) - snapshot.startedAt)
  // Header numbers are the WHOLE turn: agents + the master's own calls
  // (snapshot.master; absent on snapshots persisted before it shipped).
  // Agents-only totals under-reported the first real run by ~4.6%.
  const master = snapshot.master
  const contextTokens =
    snapshot.totals.inputTokens +
    snapshot.totals.cacheReadTokens +
    snapshot.totals.cacheWriteTokens +
    (master ? master.inputTokens + master.cacheReadTokens + master.cacheWriteTokens : 0)
  const totalCost = snapshot.totals.cost + (master?.cost ?? 0)

  // Render-time healing for snapshots persisted BEFORE the phase fix: a
  // completed run's agentless phases were saved as 'pending' and read as
  // "never ran" — the run finishing IS the deterministic evidence they ran.
  const phases =
    snapshot.status === 'completed'
      ? snapshot.phases.map((p) => (p.status === 'pending' ? { ...p, status: 'done' as const } : p))
      : snapshot.phases

  const StatusIcon =
    snapshot.status === 'completed'
      ? CheckmarkCircle02Icon
      : snapshot.status === 'error'
        ? Alert02Icon
        : snapshot.status === 'canceled'
          ? CancelCircleIcon
          : Loading03Icon

  const statusTone =
    snapshot.status === 'completed'
      ? 'text-emerald-600 dark:text-emerald-400'
      : snapshot.status === 'error'
        ? 'text-rose-500'
        : snapshot.status === 'canceled'
          ? 'text-muted'
          : 'text-primary'

  const doneAgents = snapshot.agents.filter((a) => a.status === 'completed').length

  return (
    <div
      ref={rootRef}
      className="border-border bg-surface w-full scroll-mt-10 rounded-xl border"
      dir="auto"
    >
      {/* Header — always visible; clicking toggles the body. */}
      <button
        type="button"
        onClick={() => {
          const next = !collapsed
          setCollapsed(next)
          // Expanding grows the card downward past the viewport in the
          // bottom-pinned feed, leaving only its tail visible — bring the
          // card's start back into view so it reads top-down. scroll-mt on
          // the root keeps it clear of the feed padding + update banner.
          if (!next) {
            requestAnimationFrame(() =>
              rootRef.current?.scrollIntoView({ block: 'start', behavior: 'smooth' })
            )
          }
        }}
        aria-expanded={!collapsed}
        aria-label={t('chat.workflow.toggleAria')}
        className="flex w-full cursor-pointer items-center gap-2.5 px-3 py-2.5 text-start focus-visible:ring-2 focus-visible:ring-accent"
      >
        <WorkflowSquare03Icon size={16} className="text-primary shrink-0" />
        <span className="text-fg shrink-0 text-sm font-medium">{t('chat.workflow.title')}</span>
        <span className={cn('inline-flex shrink-0 items-center gap-1 text-xs', statusTone)}>
          <StatusIcon size={13} className={cn(running && 'animate-spin')} />
          {t(`chat.workflow.status.${snapshot.status}`)}
        </span>
        <span className="text-muted min-w-0 flex-1 truncate text-xs">
          {snapshot.totals.agents > 0
            ? t('chat.workflow.headStats', {
                done: doneAgents,
                agents: snapshot.totals.agents,
                tools: snapshot.totals.toolCalls
              })
            : (snapshot.note ?? '')}
        </span>
        <span className="text-muted shrink-0 text-xs tabular-nums" dir="ltr">
          {formatElapsed(elapsedMs)}
        </span>
        {contextTokens > 0 && (
          // No forced LTR: the localized "1.2m tok"/"1.2m رمز" must follow the
          // UI direction so the unit sits on the correct side in Arabic.
          <span className="text-muted shrink-0 text-xs tabular-nums">
            {t('chat.workflow.tokens', {
              count: contextTokens,
              compact: formatCompact(contextTokens)
            })}
          </span>
        )}
        {totalCost > 0 && (
          <span className="text-muted shrink-0 text-xs tabular-nums" dir="ltr">
            ${totalCost.toFixed(totalCost >= 1 ? 2 : 3)}
          </span>
        )}
        <ArrowDown01Icon
          size={14}
          className={cn(
            'text-muted shrink-0 transition-transform',
            collapsed && '-rotate-90 rtl:rotate-90'
          )}
        />
      </button>

      {!collapsed && (
        <div className="border-border border-t px-3 py-2.5">
          {snapshot.note && <div className="text-muted mb-2 text-xs">{snapshot.note}</div>}

          {/* Plan: phase chips with derived statuses. */}
          {phases.length > 0 && (
            <div className="mb-2.5 flex flex-wrap items-center gap-1.5">
              {phases.map((p, i) => (
                <span
                  key={`${p.title}-${i}`}
                  className={cn(
                    'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px]',
                    p.status === 'active' && 'border-primary/40 bg-primary/10 text-primary',
                    p.status === 'done' &&
                      'border-emerald-500/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400',
                    p.status === 'pending' && 'border-border text-muted'
                  )}
                >
                  {p.status === 'done' ? (
                    <CheckmarkCircle02Icon size={11} />
                  ) : p.status === 'active' ? (
                    <Loading03Icon size={11} className="animate-spin" />
                  ) : null}
                  {p.title}
                </span>
              ))}
            </div>
          )}

          {/* Agents: one deterministic telemetry row each. */}
          {snapshot.agents.length > 0 ? (
            <div className="overflow-x-auto">
              <table className="w-full min-w-140 border-collapse text-xs">
                <thead>
                  <tr className="text-muted border-border border-b text-start text-[10px] uppercase tracking-wide">
                    <th className="px-1.5 py-1 text-start font-medium">
                      {t('chat.workflow.col.agent')}
                    </th>
                    <th className="px-1.5 py-1 text-start font-medium">
                      {t('chat.workflow.col.model')}
                    </th>
                    <th className="px-1.5 py-1 text-start font-medium">
                      {t('chat.workflow.col.phase')}
                    </th>
                    <th className="px-1.5 py-1 text-end font-medium">
                      {t('chat.workflow.col.time')}
                    </th>
                    <th className="px-1.5 py-1 text-end font-medium">
                      {t('chat.workflow.col.tokens')}
                    </th>
                    <th className="px-1.5 py-1 text-end font-medium">
                      {t('chat.workflow.col.tools')}
                    </th>
                    <th className="px-1.5 py-1 text-end font-medium">
                      {t('chat.workflow.col.cost')}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {snapshot.agents.map((a) => (
                    <AgentRow key={a.id} agent={a} now={now} />
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="text-muted text-xs">{t('chat.workflow.noAgents')}</div>
          )}
        </div>
      )}
    </div>
  )
}

function AgentRow({ agent, now }: { agent: WorkflowAgentView; now: number }): React.JSX.Element {
  const { t } = useTranslation()
  const live = agent.status === 'running' || agent.status === 'queued'
  const elapsedMs =
    agent.status === 'queued' ? 0 : Math.max(0, (agent.endedAt ?? now) - agent.startedAt)
  const tokens = agent.inputTokens + agent.cacheReadTokens + agent.cacheWriteTokens
  const Logo = PROVIDER_LOGOS[agent.provider as CloudProviderConfig['id']]

  // The status dot is the row's heartbeat: primary + pulse while working,
  // success green on a clean landing, error red on failure, warning amber
  // for the partial states (cancelled mid-work / still queued).
  const dotTone =
    agent.status === 'completed'
      ? 'bg-emerald-500'
      : agent.status === 'failed'
        ? 'bg-rose-500'
        : agent.status === 'cancelled'
          ? 'bg-amber-500'
          : agent.status === 'running'
            ? 'bg-primary animate-pulse'
            : 'bg-amber-500/50'

  return (
    <tr className="border-border/60 border-b last:border-b-0 align-top">
      <td className="max-w-55 px-1.5 py-1.5">
        <span className="flex items-center gap-1.5">
          <span
            className={cn('inline-block h-1.5 w-1.5 shrink-0 rounded-full', dotTone)}
            title={t(`chat.workflow.agentStatus.${agent.status}`)}
          />
          {/* A working agent reads as live: name in primary alongside the
              pulsing dot; landed agents settle back to the normal text tone. */}
          <span
            className={cn(
              'truncate font-medium',
              agent.status === 'running' ? 'text-primary' : 'text-fg'
            )}
          >
            {agent.name}
          </span>
        </span>
        <span className="text-muted mt-0.5 line-clamp-2 block text-[11px] leading-snug">
          {agent.task}
        </span>
      </td>
      <td className="px-1.5 py-1.5">
        <span className="inline-flex max-w-40 items-center gap-1" dir="ltr">
          {Logo ? <Logo size={12} /> : null}
          <span className="text-muted truncate">{agent.model.split('/').pop()}</span>
        </span>
      </td>
      <td className="text-muted max-w-42.5 truncate px-1.5 py-1.5">{agent.phase ?? '—'}</td>
      <td className="text-muted px-1.5 py-1.5 text-end tabular-nums" dir="ltr">
        {live && agent.status === 'queued'
          ? t('chat.workflow.agentStatus.queued')
          : formatElapsed(elapsedMs)}
      </td>
      <td className="text-muted px-1.5 py-1.5 text-end tabular-nums" dir="ltr">
        {tokens > 0 ? `${formatCompact(tokens)} / ${formatCompact(agent.outputTokens)}` : '—'}
      </td>
      <td className="text-muted px-1.5 py-1.5 text-end tabular-nums" dir="ltr">
        {agent.toolCalls}
      </td>
      <td className="text-muted px-1.5 py-1.5 text-end tabular-nums" dir="ltr">
        {agent.cost > 0 ? `$${agent.cost.toFixed(agent.cost >= 1 ? 2 : 3)}` : '—'}
      </td>
    </tr>
  )
}

function formatElapsed(ms: number): string {
  const secs = Math.max(0, Math.round(ms / 1000))
  if (secs < 60) return `${secs}s`
  const m = Math.floor(secs / 60)
  if (m < 60) return `${m}m ${secs % 60}s`
  return `${Math.floor(m / 60)}h ${m % 60}m`
}
