import { CodeBlock } from '@components/core/CodeBlock'
import { cn } from '@lib/utils/cn'
import type { ApprovalDecision, RiskLevel } from '@preload/index'
import type { ApprovalCardState } from '@providers/flow/useFlow'
import { getApprovalPhrases, localizeApprovalPhrase } from './localizeApproval'
import { useTranslation } from 'react-i18next'

const RISK_DOT: Record<RiskLevel, string> = {
  low: 'bg-emerald-500',
  medium: 'bg-amber-500',
  high: 'bg-red-500'
}

function titleCase(toolName: string): string {
  return toolName
    .split('_')
    .map((part) => (part.length === 0 ? '' : part[0].toUpperCase() + part.slice(1)))
    .join(' ')
}

// Pick a language hint for the command preview. Most approvals are
// shell commands; some tools surface diffs or paths instead.
function detectCommandLanguage(tool: string, args: Record<string, unknown>): string | undefined {
  if (typeof args.command === 'string') return 'bash'
  if (typeof args.find === 'string' && typeof args.replace === 'string') return 'diff'
  if (typeof args.old === 'string' && typeof args.new === 'string') return 'diff'
  if (tool.includes('shell') || tool.includes('bash') || tool.includes('exec')) return 'bash'
  return undefined
}

// The raw call args, shown like a tool call so the user can see exactly what
// will run — not just the prose. The `command` key is dropped when it's
// already surfaced in the headline command block above, so we never repeat it.
function buildDetailArgs(
  args: Record<string, unknown>,
  command: string | null
): Record<string, unknown> {
  const rest = { ...args }
  if (command !== null && typeof rest.command === 'string' && rest.command === command) {
    delete rest.command
  }
  return rest
}

function jsonInline(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

export function ApprovalCard({
  state,
  onDecision
}: {
  state: ApprovalCardState
  onDecision: (decision: ApprovalDecision) => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const decided = state.decision !== undefined

  // Plugins author the title / description / impact in English; localize each
  // here, inside the card, with a graceful fallback to the original string.
  const phrases = getApprovalPhrases(t)

  // Prefer the plugin-supplied description; fall back to a derived title
  // and the danger pattern reason so the card is never blank.
  const title = localizeApprovalPhrase(state.description?.title ?? titleCase(state.tool), phrases)
  const description = localizeApprovalPhrase(
    state.description?.description ?? state.reason,
    phrases
  )
  const command =
    state.description?.command ??
    (typeof state.args.command === 'string' ? state.args.command : null)
  const impact = localizeApprovalPhrase(state.description?.impact, phrases)
  const risk: RiskLevel = state.description?.risk ?? 'medium'
  const riskLabel = t(`chat.approval.risk.${risk}`)

  const detailArgs = buildDetailArgs(state.args, command)
  const hasDetails = Object.keys(detailArgs).length > 0

  return (
    <div className="border-border bg-surface w-full max-w-[85%] self-start rounded-2xl border px-4 py-3 text-sm">
      <div className="mb-1 flex items-center gap-2">
        <span
          role="img"
          aria-label={riskLabel}
          title={riskLabel}
          className={cn('inline-block h-2 w-2 shrink-0 rounded-full', RISK_DOT[risk])}
        />
        <span className="text-fg text-base font-semibold leading-tight">{title}</span>
      </div>

      <p className="text-muted mb-3 text-xs leading-snug">{description}</p>

      {command !== null && command !== undefined ? (
        <CodeBlock
          content={command}
          language={detectCommandLanguage(state.tool, state.args)}
          maxH="max-h-40"
          className="mb-2"
        />
      ) : null}

      {hasDetails ? (
        <CodeBlock
          content={jsonInline(detailArgs)}
          language="json"
          maxH="max-h-40"
          className="mb-2"
        />
      ) : null}

      {impact ? <p className="text-muted mb-3 text-xs italic">{impact}</p> : null}

      {decided ? (
        <p
          className={cn(
            'text-xs font-medium',
            state.decision !== 'denied'
              ? 'text-emerald-600 dark:text-emerald-400'
              : 'text-red-600 dark:text-red-400'
          )}
        >
          {state.decision === 'approved_session'
            ? t('chat.approval.approvedSession')
            : state.decision === 'approved'
              ? t('chat.approval.approved')
              : t('chat.approval.denied')}
        </p>
      ) : (
        <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => onDecision('approved')}
              className="bg-primary text-primary-fg cursor-pointer rounded-md px-3 py-1.5 text-xs font-medium hover:brightness-110"
            >
              {t('chat.approval.approve')}
            </button>
            {/* "Allow for this conversation": approves now and auto-approves
                the same kind of call (same tool; for the shell, the same
                command head such as `git push` or `npm install`) for the
                rest of this conversation. Never offered for block-level
                calls, which never reach this card. */}
            <button
              type="button"
              onClick={() => onDecision('approved_session')}
              className="bg-surface text-fg border-border hover:bg-bg cursor-pointer rounded-md border px-3 py-1.5 text-xs font-medium"
            >
              {t('chat.approval.approveSession')}
            </button>
          </div>
          <button
            type="button"
            onClick={() => onDecision('denied')}
            className="bg-surface text-fg border-border hover:bg-bg cursor-pointer rounded-md border px-3 py-1.5 text-xs font-medium"
          >
            {t('chat.approval.deny')}
          </button>
        </div>
      )}
    </div>
  )
}
