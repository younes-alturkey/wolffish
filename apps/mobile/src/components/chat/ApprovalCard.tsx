import { CodeBlockText } from '@/components/chat/ToolCard'
import { getApprovalPhrases, localizeApprovalPhrase } from '@/components/chat/localizeApproval'
import type { ApprovalDecision, RiskLevel } from '@/lib/conversations/types'
import { cn } from '@/lib/utils/cn'
import type { ApprovalCardState } from '@/state/chatRuntime'
import { memo } from 'react'
import { useTranslation } from 'react-i18next'
import { Pressable, Text, View } from 'react-native'

/**
 * A tool call the desktop flagged as dangerous, put to the user. A port of the
 * desktop's ApprovalCard: risk dot + title, the plugin's description, the exact
 * command and remaining args as code, the impact line, then Approve / Deny —
 * replaced by the decision once one is made.
 *
 * The card renders from two sources with one shape: the live approval the
 * desktop pushed while the turn is parked (interactive), and the approval
 * record persisted on the assistant message (a decided card, replayed from the
 * transcript). `onDecision` is absent for the latter, which is what makes it
 * a record rather than a control.
 */

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

// The raw call args, shown like a tool call so the user can see exactly what
// will run — not just the prose. The `command` key is dropped when it's already
// surfaced in the headline command block above, so we never repeat it.
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

export type ApprovalCardProps = {
  state: ApprovalCardState
  onDecision?: (decision: ApprovalDecision) => void
}

export const ApprovalCard = memo(function ApprovalCard({
  state,
  onDecision
}: ApprovalCardProps): React.JSX.Element {
  const { t } = useTranslation()
  const decided = state.decision !== undefined
  const live = !decided && !!onDecision

  // Plugins author the title / description / impact in English; localize each
  // here, inside the card, with a graceful fallback to the original string.
  const phrases = getApprovalPhrases(t)

  // Prefer the plugin-supplied description; fall back to a derived title and
  // the danger pattern reason so the card is never blank.
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
    <View className="border-border bg-surface w-full max-w-[85%] self-start rounded-2xl border px-4 py-3">
      <View className="mb-1 flex-row items-center gap-2">
        <View
          accessibilityRole="image"
          accessibilityLabel={riskLabel}
          className={cn('h-2 w-2 shrink-0 rounded-full', RISK_DOT[risk])}
        />
        <Text
          selectable
          className="text-fg font-sans-semibold flex-1 text-left text-base leading-tight"
        >
          {title}
        </Text>
      </View>

      {description ? (
        <Text selectable className="text-muted mb-3 text-left font-sans text-xs leading-snug">
          {description}
        </Text>
      ) : null}

      {command !== null && command !== undefined ? (
        <View className="mb-2">
          <CodeBlockText text={command} />
        </View>
      ) : null}

      {hasDetails ? (
        <View className="mb-2">
          <CodeBlockText text={jsonInline(detailArgs)} />
        </View>
      ) : null}

      {impact ? (
        <Text
          selectable
          className="text-muted mb-3 text-left font-sans text-xs italic leading-snug"
        >
          {impact}
        </Text>
      ) : null}

      {decided ? (
        <Text
          className={cn(
            'font-sans-medium text-left text-xs',
            state.decision === 'approved'
              ? 'text-emerald-600 dark:text-emerald-400'
              : 'text-red-600 dark:text-red-400'
          )}
        >
          {state.decision === 'approved' ? t('chat.approval.approved') : t('chat.approval.denied')}
        </Text>
      ) : (
        <View className="mt-2 flex-row items-center justify-between gap-2">
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ disabled: !live }}
            disabled={!live}
            onPress={() => onDecision?.('approved')}
            className={cn('bg-primary rounded-md px-3 py-1.5', !live && 'opacity-40')}
          >
            <Text className="text-primary-fg font-sans-medium text-xs">
              {t('chat.approval.approve')}
            </Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ disabled: !live }}
            disabled={!live}
            onPress={() => onDecision?.('denied')}
            className={cn(
              'bg-surface border-border rounded-md border px-3 py-1.5',
              !live && 'opacity-40'
            )}
          >
            <Text className="text-fg font-sans-medium text-xs">{t('chat.approval.deny')}</Text>
          </Pressable>
        </View>
      )}
    </View>
  )
})
