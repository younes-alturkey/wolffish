import { CodeBlock } from '@components/core/CodeBlock'
import { cn } from '@lib/utils/cn'
import { formatCompact } from '@lib/utils/format'
import { ArrowDown01Icon, ArrowRight01Icon } from 'hugeicons-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'

type CompactionDetail = {
  toolName?: string
  originalChars: number
  compactedChars: number
  compactedBy: string
}

type CompactionCardProps = {
  targetsCount: number
  tokensSaved: number
  durationMs?: number
  details: CompactionDetail[]
}

function formatElapsed(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  const s = ms / 1000
  if (s < 60) return `${s.toFixed(s < 10 ? 1 : 0)}s`
  const m = Math.floor(s / 60)
  const sec = Math.floor(s % 60)
  return `${m}m ${sec}s`
}

export function CompactionCard({
  targetsCount,
  tokensSaved,
  durationMs,
  details
}: CompactionCardProps): React.JSX.Element {
  const { t } = useTranslation()
  const [expanded, setExpanded] = useState(false)
  const canExpand = details.length > 0
  const tokens = formatCompact(tokensSaved)
  const elapsed = durationMs && durationMs > 0 ? formatElapsed(durationMs) : null

  const summary =
    targetsCount === 1
      ? t('chat.compactionCard.summary', { count: targetsCount, tokens })
      : t('chat.compactionCard.summary_plural', { count: targetsCount, tokens })

  const detailsText = details
    .map((d) => {
      const pct =
        d.originalChars > 0 ? Math.round((1 - d.compactedChars / d.originalChars) * 100) : 0
      const rawName = d.toolName ?? 'unknown'
      // Localize role-based labels; tool names pass through as-is
      const tool =
        rawName === 'assistant'
          ? t('chat.compactionCard.targetAssistant')
          : rawName === 'user'
            ? t('chat.compactionCard.targetUser')
            : rawName
      const from = formatCompact(d.originalChars)
      const to = formatCompact(d.compactedChars)
      const isCheap =
        d.compactedBy === 'truncate' ||
        d.compactedBy === 'truncation' ||
        d.compactedBy === 'image eviction'

      return isCheap
        ? t('chat.compactionCard.detailTruncated', { tool, from, to, pct })
        : t('chat.compactionCard.detail', {
            tool,
            from,
            to,
            pct,
            model: d.compactedBy
          })
    })
    .join('\n')

  return (
    <div className="group border-border bg-surface w-full max-w-[85%] self-start rounded-2xl border px-4 py-3 text-sm">
      <button
        type="button"
        onClick={() => canExpand && setExpanded((v) => !v)}
        disabled={!canExpand}
        className="flex w-full items-center justify-between gap-3 text-start disabled:cursor-default"
      >
        <div className="flex items-center gap-2 truncate">
          <span
            className={cn(
              'inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium',
              'bg-violet-500/10 text-violet-600 dark:text-violet-400'
            )}
          >
            {t('chat.compactionCard.title')}
          </span>
          {canExpand &&
            (expanded ? (
              <ArrowDown01Icon size={14} className="text-muted shrink-0" aria-hidden />
            ) : (
              <ArrowRight01Icon size={14} className="text-muted shrink-0" aria-hidden />
            ))}
        </div>
        {elapsed && <span className="text-muted shrink-0 text-xs tabular-nums">{elapsed}</span>}
      </button>

      <p className="text-muted mt-1 text-xs">{summary}</p>

      {expanded && <CodeBlock content={detailsText} className="mt-2" />}
    </div>
  )
}
