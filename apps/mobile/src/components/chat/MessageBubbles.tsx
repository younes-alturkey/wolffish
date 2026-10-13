import { Copy01Icon, Tick02Icon } from '@/components/core/icons'
import {
  type RenderOptions,
  CODE_ACTIVITY_TOOLS,
  buildRenderBlocks,
  failedTurnEnd,
  messageText,
  toWorkspaceRelative
} from '@/lib/conversations/segments'
import type { RenderBlock, ToolResultInfo } from '@/lib/conversations/segments'
import type { TodoItem } from '@/lib/conversations/types'
import { respondApproval, respondAsk } from '@/lib/sync/cards'
import type {
  ApprovalDecision,
  AskUserResponse,
  ConversationMessage,
  MessageAttachment
} from '@/lib/conversations/types'
import { cn } from '@/lib/utils/cn'
import { formatRelativeTime } from '@/lib/utils/relativeTime'
import {
  selectCards,
  useChatRuntime,
  type ApprovalCardState,
  type AskCardState
} from '@/state/chatRuntime'
import * as Clipboard from 'expo-clipboard'
import { memo, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Pressable, Text, View } from 'react-native'
import { ApprovalCard } from '@/components/chat/ApprovalCard'
import {
  CompactionCard,
  ModelChip,
  PathCard,
  ReasoningCard,
  TurnEndCard,
  WorkflowCard
} from '@/components/chat/InlineCards'
import { ProviderErrorCards, syntheticFailure } from '@/components/chat/ProviderErrorCard'
import { FileBlock } from '@/components/chat/FileBlock'
import { MarkdownView, markdownHasTable } from '@/components/chat/MarkdownView'
import { NEEDS_SELECT_SHEET, openSelectMarkdown } from '@/components/chat/SelectTextSheet'
import { QuestionCard } from '@/components/chat/QuestionCard'
import { OptionsCard } from '@/components/chat/OptionsCard'
import { CountdownCard } from '@/components/chat/CountdownCard'
import { WaitCard } from '@/components/chat/WaitCard'
import { ProcessCard } from '@/components/chat/ProcessCard'
import { BrowserCard } from '@/components/chat/BrowserCard'
import { TaskCard } from '@/components/chat/TaskCard'
import { ThinkingIndicator } from '@/components/chat/ThinkingIndicator'
import { TodoCard } from '@/components/chat/TodoCard'
import { ToolCard } from '@/components/chat/ToolCard'

/**
 * Feed message renderers. User prompts are right-aligned primary bubbles;
 * assistant turns walk their segment stream into blocks (text bubbles, tool
 * cards, delivered files, chips) with the desktop's clean/verbose gating:
 * verbose off hides tool cards, model chips and compaction — replies,
 * question cards, task lists and delivered files always render, and the code
 * tools (edits, writes, shell runs) keep a compact activity row.
 */

function CopyFooter({
  text,
  timestamp,
  align
}: {
  text: string
  timestamp?: number
  align: 'start' | 'end'
}): React.JSX.Element {
  const { t } = useTranslation()
  const [copied, setCopied] = useState(false)
  const relative = useMemo(
    () => (timestamp ? formatRelativeTime(timestamp, t) : ''),
    [timestamp, t]
  )
  const Icon = copied ? Tick02Icon : Copy01Icon
  return (
    <View
      className={cn('flex-row items-center gap-2', align === 'end' ? 'self-end' : 'self-start')}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={t('chat.copyMessage')}
        hitSlop={8}
        onPress={() => {
          void Clipboard.setStringAsync(text).then(() => {
            setCopied(true)
            setTimeout(() => setCopied(false), 1500)
          })
        }}
        className="p-1"
      >
        <Icon size={12} className={copied ? 'text-emerald-600' : 'text-muted'} />
      </Pressable>
      {relative ? <Text className="text-muted font-sans text-[10px]">{relative}</Text> : null}
    </View>
  )
}

function AttachmentList({
  attachments,
  conversationId,
  align
}: {
  attachments: MessageAttachment[]
  conversationId?: string
  align: 'start' | 'end'
}): React.JSX.Element {
  return (
    <View className={cn('flex-col gap-2', align === 'end' ? 'items-end' : 'items-start')}>
      {attachments.map((attachment, index) => (
        <FileBlock
          key={index}
          relPath={toWorkspaceRelative(attachment.filePath)}
          conversationId={conversationId}
          declared={attachment.type}
          sizeBytes={attachment.sizeBytes}
          displayName={attachment.originalName}
          align={align}
        />
      ))}
    </View>
  )
}

export const UserBubble = memo(function UserBubble({
  message,
  conversationId
}: {
  message: ConversationMessage
  conversationId?: string
}): React.JSX.Element {
  // A voice note's own player IS the prompt on screen. The desktop still stores
  // the transcript as this message's content — that is what it feeds the model
  // as `<voice_note>`, and what titling reads — but printing it back under the
  // player only repeats what the user just said out loud.
  const hasText = message.content.trim().length > 0 && message.voicePrompt !== true
  return (
    <View className="flex-col gap-1.5">
      {hasText && (
        <View className="bg-primary max-w-[85%] self-end overflow-hidden rounded-2xl px-4 py-2.5">
          <MarkdownView
            variant="user"
            onLongPress={NEEDS_SELECT_SHEET ? () => openSelectMarkdown(message.content) : undefined}
          >
            {message.content}
          </MarkdownView>
        </View>
      )}
      {message.attachments && message.attachments.length > 0 && (
        <AttachmentList
          attachments={message.attachments}
          conversationId={conversationId}
          align="end"
        />
      )}
      {hasText && <CopyFooter text={message.content} timestamp={message.timestamp} align="end" />}
    </View>
  )
})

export const AssistantMessageView = memo(function AssistantMessageView({
  message,
  conversationId,
  verbose,
  streaming,
  liveTurn,
  liveError,
  onTryAgain,
  todoLists,
  browserCards
}: {
  message: ConversationMessage
  conversationId?: string
  verbose: boolean
  /** Every task list in its latest state (segments.ts latestTodoLists) — a
   *  later turn's todo_write resolves an earlier card in place. */
  todoLists?: Map<string, TodoItem[]>
  /** Where each conversation browser's one card lives (segments.ts latestBrowserCards). */
  browserCards?: RenderOptions['browserCards']
  streaming?: boolean
  /** True for the in-flight turn's own row (feed.ts LIVE_KEY) — the only row
   *  that may host the conversation's live cards. */
  liveTurn?: boolean
  /** The live row when the desktop reported its turn failed — the one failure
   *  the message itself cannot show, because it can end a turn before any
   *  segment reaches this phone. */
  liveError?: boolean
  /** Present only on the last message when it is a failed turn and no turn is
   *  running — the desktop's own rule for the retry button. */
  onTryAgain?: (reason: string) => void
}): React.JSX.Element {
  const blocks = useMemo(
    () => buildRenderBlocks(message, { todoLists, browserCards }),
    [message, todoLists, browserCards]
  )
  const fullText = useMemo(() => messageText(message), [message])
  // Cards the desktop is holding this turn open for. Live state wins over the
  // persisted record for the same tool call: the two describe one approval,
  // and the live one is the one that can still be acted on. Subscribed only by
  // the live row — the cards belong to the running turn, and letting every
  // stored message consult them is what once drew a copy of the card under
  // each of them (selectCards(undefined) is the shared empty pair).
  const live = useChatRuntime(selectCards(liveTurn ? conversationId : undefined))
  const approvals: Record<string, ApprovalCardState> = useMemo(
    () => ({ ...(message.approvals ?? {}), ...live.approvals }),
    [message.approvals, live.approvals]
  )
  const asks = live.asks

  // The desktop's rule for a failed turn: the error card IS the message. A
  // structured failure renders its provider cards; a bare error string — or a
  // live turn the desktop marked failed before any segment arrived — renders
  // the generic one. Everything else about the row (partial text, tool cards,
  // the copy footer) stays behind the card, exactly as on the desktop.
  const failedEnd = failedTurnEnd(message)
  if (failedEnd || message.error || liveError) {
    const failures = failedEnd?.providerErrors?.length
      ? failedEnd.providerErrors
      : [syntheticFailure(message.error ?? 'unavailable')]
    return (
      <View className="flex-col items-start gap-1">
        <ProviderErrorCards failures={failures} onTryAgain={onTryAgain} />
      </View>
    )
  }

  const visible = blocks.filter((block) => {
    // An approval always renders — the user must be able to act on a pending
    // tool call whatever the verbose preference says. Same rule as the desktop.
    // So does a code tool: an edit, a write or a shell run is a change in the
    // user's project, shown as a compact row the clean feed can expand.
    if (block.type === 'tool')
      return (
        verbose || !!approvals[block.call.toolCallId] || CODE_ACTIVITY_TOOLS.has(block.call.name)
      )
    if (block.type === 'model' || block.type === 'compaction') return verbose
    // ask_user renders as its card while the turn is parked on it and once it
    // has been answered; with neither there is nothing to show yet.
    if (block.type === 'question') return !!asks[block.call.toolCallId] || !!block.result
    // offer_options draws from its call's args alone, so it renders the
    // instant the call lands and always — clean feed included, like a
    // delivered file: it is content the model produced FOR the user.
    if (block.type === 'options') return true
    // An anchor earns its place only when a live card renders on it.
    if (block.type === 'toolAnchor')
      return !!asks[block.toolCallId] || !!live.approvals[block.toolCallId]
    return true
  })

  // A card whose tool_call segment never reached this phone still has to be
  // answerable: the live mirror strips tool calls from the clean feed, and the
  // parked card is the whole reason the turn stopped. Anchored where its call
  // segment exists (the desktop's inline placement) or where its result landed
  // (the toolAnchor — the park position, once the turn has moved on); appended
  // at the tail only while it has neither, which is exactly the parked window,
  // when the tail IS the park position — nothing has been written after it.
  const anchored = new Set(
    blocks.flatMap((block) =>
      block.type === 'tool' || block.type === 'question'
        ? [block.call.toolCallId]
        : block.type === 'toolAnchor'
          ? [block.toolCallId]
          : []
    )
  )
  const orphans = [
    ...Object.values(asks).filter((ask) => !anchored.has(ask.toolCallId)),
    ...Object.values(live.approvals).filter((approval) => !anchored.has(approval.toolCallId))
  ]

  // Nothing renderable while the turn streams → typed thinking words. A parked
  // card counts as renderable: the turn is waiting on the user, not thinking.
  // So does a mid-turn message the agent has just read: the user's words are
  // on screen, and the thinking words go UNDER them (below) while the answer
  // to them is being worked out.
  if (
    streaming &&
    orphans.length === 0 &&
    visible.every(
      (block) =>
        block.type !== 'text' && block.type !== 'toolAnchor' && block.type !== 'userMessage'
    )
  ) {
    return <ThinkingIndicator />
  }
  const last = visible[visible.length - 1]
  const thinkingAfterInterjection =
    streaming && orphans.length === 0 && last !== undefined && last.type === 'userMessage'

  return (
    <View className="flex-col gap-2">
      {visible.map((block) => (
        <View key={block.key} className="flex-col">
          {renderBlock(
            block,
            conversationId,
            approvals,
            live.approvals,
            asks,
            verbose,
            NEEDS_SELECT_SHEET ? openSelectMarkdown : undefined
          )}
        </View>
      ))}
      {orphans.map((card) => (
        <View key={`live:${card.toolCallId}`} className="flex-col">
          {'askId' in card
            ? renderAsk(card, conversationId)
            : renderApproval(card, conversationId, true)}
        </View>
      ))}
      {thinkingAfterInterjection && <ThinkingIndicator />}
      {!streaming && fullText.trim().length > 0 && (
        <CopyFooter text={fullText} timestamp={message.timestamp} align="start" />
      )}
    </View>
  )
})

/** The question card, live: answering it resolves the desktop's parked turn. */
function renderAsk(
  ask: AskCardState,
  conversationId?: string,
  result?: ToolResultInfo
): React.ReactNode {
  return (
    <QuestionCard
      call={{ toolCallId: ask.toolCallId, name: 'ask_user', args: {} }}
      result={result}
      ask={ask}
      onRespond={
        conversationId
          ? (askId: string, response: AskUserResponse) =>
              void respondAsk(conversationId, askId, ask.toolCallId, response)
          : undefined
      }
    />
  )
}

/**
 * The approval card. Actionable ONLY when `live` — i.e. when the request came
 * from the desktop's push and is sitting in the store waiting for an answer.
 *
 * The distinction matters because the same card arrives by two other routes
 * that look identical: the assistant message the desktop mirrors mid-turn
 * carries the approval record too (undecided, since it hasn't been), and the
 * saved transcript carries it decided. Wiring buttons to either would produce
 * a control that does nothing when tapped — the request it names is not one
 * this phone is holding.
 */
function renderApproval(
  approval: ApprovalCardState,
  conversationId: string | undefined,
  live: boolean
): React.ReactNode {
  return (
    <ApprovalCard
      state={approval}
      onDecision={
        live && conversationId && approval.decision === undefined
          ? (decision: ApprovalDecision) => void respondApproval(conversationId, approval, decision)
          : undefined
      }
    />
  )
}

function renderBlock(
  block: RenderBlock,
  conversationId: string | undefined,
  /** Every approval this message can show — the persisted record merged
   *  under whatever is live right now. */
  approvals: Record<string, ApprovalCardState>,
  /** Only the ones the desktop is holding open, which is what makes a card
   *  a control rather than a record. */
  liveApprovals: Record<string, ApprovalCardState>,
  asks: Record<string, AskCardState>,
  verbose: boolean,
  /** Present only where the platform needs the sheet — iOS. */
  onSelectText?: (text: string) => void
): React.ReactNode {
  switch (block.type) {
    case 'text':
      return (
        // A table needs the bubble at a DEFINITE width (w-[85%]) — a
        // content-sized bubble around a horizontal scroller is a circular
        // constraint that explodes Yoga layout. overflow-hidden clips any
        // painting past the rounded corners.
        <View
          className={cn(
            'bg-surface border-border self-start overflow-hidden rounded-2xl border px-4 py-2.5',
            markdownHasTable(block.markdown) ? 'w-[85%]' : 'max-w-[85%]'
          )}
        >
          {/* Long press selects THIS block's markdown, not the whole turn: a
              turn can be several bubbles with tool cards between them, and the
              one under the finger is the one the reader meant. */}
          <MarkdownView onLongPress={onSelectText && (() => onSelectText(block.markdown))}>
            {block.markdown}
          </MarkdownView>
        </View>
      )
    case 'media':
      return <FileBlock relPath={block.relPath} conversationId={conversationId} declared="image" />
    case 'tool': {
      // A flagged call shows its approval card in place of the tool card, and
      // keeps the tool card underneath once decided — verbose only, because
      // by then it is mechanics again. The desktop makes the same swap.
      const approval = approvals[block.call.toolCallId]
      if (!approval) {
        return (
          <ToolCard
            call={block.call}
            result={block.result}
            timing={block.timing}
            compact={!verbose}
          />
        )
      }
      return (
        <View className="flex-col gap-2">
          {renderApproval(approval, conversationId, !!liveApprovals[block.call.toolCallId])}
          {approval.decision !== undefined &&
          (verbose || CODE_ACTIVITY_TOOLS.has(block.call.name)) ? (
            <ToolCard
              call={block.call}
              result={block.result}
              timing={block.timing}
              compact={!verbose}
            />
          ) : null}
        </View>
      )
    }
    case 'options':
      return <OptionsCard call={block.call} />
    case 'question': {
      const ask = asks[block.call.toolCallId]
      return (
        <QuestionCard
          call={block.call}
          result={block.result}
          ask={ask}
          onRespond={
            ask && conversationId
              ? (askId: string, response: AskUserResponse) =>
                  void respondAsk(conversationId, askId, ask.toolCallId, response)
              : undefined
          }
        />
      )
    }
    case 'toolAnchor': {
      // A live card's park position, held by its result segment (the clean
      // feed strips the call segment this card would otherwise anchor to).
      // Rendering it HERE is what keeps everything the turn writes after the
      // user's answer below the card rather than above it.
      const ask = asks[block.toolCallId]
      if (ask) return renderAsk(ask, conversationId, block.result)
      const approval = liveApprovals[block.toolCallId]
      if (approval) return renderApproval(approval, conversationId, true)
      return null
    }
    case 'file':
      // The marker's kind is only a hint — the extension decides which viewer
      // renders, exactly as on the desktop.
      return (
        <FileBlock relPath={block.relPath} conversationId={conversationId} declared={block.kind} />
      )
    case 'model':
      return <ModelChip provider={block.provider} model={block.model} />
    case 'userMessage':
      // The user's own mid-turn words, worn exactly as a user row is — the
      // primary bubble, its files, the copy footer — sitting inside the
      // assistant card at the point the agent read them.
      return <UserBubble message={block.message} conversationId={conversationId} />
    case 'path':
      return <PathCard path={block.path} kind={block.kind} />
    case 'workflow':
      return <WorkflowCard snapshot={block.snapshot} />
    case 'task':
      // Generic async-generation card (video). Deliberately outside the
      // verbose gate above — like workflow, it is output FOR the user.
      return <TaskCard snapshot={block.snapshot} conversationId={conversationId} />
    case 'countdown':
      // Turn-end countdown — output FOR the user, never verbose-gated.
      return <CountdownCard snapshot={block.snapshot} />
    case 'wait':
      // Why the agent went quiet — output FOR the user, never verbose-gated:
      // a silent turn with no card is indistinguishable from a hang.
      return <WaitCard snapshot={block.snapshot} conversationId={conversationId} />
    case 'process':
      // The live process card the model chose to show — output FOR the user,
      // never verbose-gated; its buttons drive the desktop's registry.
      return <ProcessCard snapshot={block.snapshot} />
    case 'browser':
      // The conversation's in-app browser, read-only: a still of what the
      // desktop shows. Output FOR the user, never verbose-gated.
      return <BrowserCard snapshot={block.snapshot} conversationId={conversationId} />
    case 'todo':
      // The model's task list — output FOR the user, so never verbose-gated.
      return <TodoCard items={block.items} />
    case 'compaction':
      return <CompactionCard block={block} />
    case 'reasoning':
      // In-place thinking — not verbose-gated: it is the reply's provenance,
      // not tool mechanics. Its own switch is `inapp.reasoning` (on by
      // default), enforced inside ReasoningCard so the legacy turn_end copy
      // obeys the same answer.
      return <ReasoningCard content={block.content} />
    case 'turnEnd':
      return <TurnEndCard block={block} />
    default:
      return null
  }
}
