import { CheckmarkCircle02Icon, MessageQuestionIcon, SentIcon } from '@/components/core/icons'
import { INPUT_TEXT_ALIGN, WRITING_DIRECTION, rtlPlaceholder } from '@/components/core/Input'
import { KeyboardDismissAccessory } from '@/components/core/KeyboardDismissBar'
import type { ToolCallInfo, ToolResultInfo } from '@/lib/conversations/segments'
import type { AskUserAnswer, AskUserOption, AskUserResponse } from '@/lib/conversations/types'
import { cn } from '@/lib/utils/cn'
import { useTokens } from '@/providers/theme/useTheme'
import type { AskCardState } from '@/state/chatRuntime'
import { memo, useEffect, useId, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Pressable, ScrollView, Text, TextInput, View } from 'react-native'

/**
 * The agent asks the user one or more multiple-choice questions (the `ask_user`
 * tool). A port of the desktop's QuestionCard, rule for rule: with a single
 * question it is the classic card — numbered options each with a title +
 * description, plus an optional free-text "something else" escape hatch; with
 * several questions a horizontally scrollable row of numbered chip tabs sits on
 * top, answering one auto-advances to the next unanswered question, and the
 * whole card submits ONCE (all answers together) when the last is answered. The
 * card keeps its full look after answering — the chips still flip between
 * questions, each showing its chosen option highlighted — with a compact
 * summary of every question and answer appended at the bottom.
 *
 * Two sources feed it, and either alone is enough:
 *  - the live `ask` state (the ask.request push) while the questions are open,
 *    carrying the agent's optional custom labels for the free-text option and,
 *    after submit, the user's optimistic answers;
 *  - the persisted tool_call `args` + tool_result output, which is how an
 *    answered card is rebuilt when the conversation is read back from storage.
 *    Nothing about the answer is persisted beyond that output, on either
 *    platform, so the parser below has to mirror the plugin's stable formats
 *    exactly — it is the same parser the desktop card runs.
 */

type QuestionData = {
  question: string
  details?: string
  options: AskUserOption[]
  allowOther: boolean
  otherLabel: string
  otherDescription: string
}

/** One question's answer for display. `text` may be missing when a custom
 * answer couldn't be recovered from persisted output. */
type AnswerView = { kind: 'option'; index: number } | { kind: 'custom'; text?: string }

function asString(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

// Coerce a question's `options` into a clean list. Tolerant of an array of
// {label, description} objects OR bare strings (the model occasionally sends
// either).
function parseOptions(raw: unknown): AskUserOption[] {
  if (!Array.isArray(raw)) return []
  const out: AskUserOption[] = []
  for (const item of raw) {
    if (typeof item === 'string') {
      const label = item.trim()
      if (label) out.push({ label })
    } else if (item && typeof item === 'object') {
      const label = asString((item as Record<string, unknown>).label).trim()
      const description = asString((item as Record<string, unknown>).description).trim()
      if (label) out.push({ label, ...(description ? { description } : {}) })
    }
  }
  return out
}

type OtherFallbacks = { label: string; description: string }

function parseQuestionItem(raw: unknown, fallbacks: OtherFallbacks): QuestionData | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const question = asString(r.question).trim()
  const options = parseOptions(r.options)
  if (!question && options.length === 0) return null
  return {
    question,
    details: asString(r.details).trim() || undefined,
    options,
    allowOther: r.allow_other !== false,
    otherLabel: asString(r.other_label).trim() || fallbacks.label,
    otherDescription: asString(r.other_description).trim() || fallbacks.description
  }
}

/**
 * Recover the question list from the persisted tool_call args: the current
 * `questions` array, or the legacy single-question shape (top-level
 * question/options) that older conversations carry.
 */
export function parseQuestionsFromArgs(
  args: Record<string, unknown>,
  fallbacks: OtherFallbacks
): QuestionData[] {
  if (Array.isArray(args.questions)) {
    const out: QuestionData[] = []
    for (const raw of args.questions) {
      const q = parseQuestionItem(raw, fallbacks)
      if (q) out.push(q)
    }
    if (out.length > 0) return out
  }
  const legacy = parseQuestionItem(args, fallbacks)
  return legacy ? [legacy] : []
}

/**
 * Recover what the user picked from the persisted tool_result output, so an
 * answered card highlights the right options even after the turn ends or the
 * conversation is read back from storage (the live answers aren't saved).
 * Mirrors the stable output formats the `ask` plugin emits: the legacy
 * single-question sentence, and the numbered multi-question summary (whose
 * custom answers are indented three spaces so they can't fake a question
 * boundary). Returns null when the output doesn't parse — the card then falls
 * back to showing the raw output.
 */
export function parseAnswers(
  output: string | undefined,
  questionCount: number
): AnswerView[] | null {
  if (!output) return null

  if (questionCount === 1) {
    const opt = output.match(/selected option (\d+) of \d+/i)
    if (opt) return [{ kind: 'option', index: Number(opt[1]) - 1 }]
    const custom = output.match(/instead instructed:\n([\s\S]*)$/i)
    if (custom) return [{ kind: 'custom', text: custom[1] }]
    return null
  }

  if (!/^The user answered all \d+ questions:/.test(output)) return null
  const body = output.replace(/^The user answered all \d+ questions:\s*/, '')
  // Question blocks start at column 0 as "N. " — indented custom lines can't
  // match, so the split is safe against numbered lists in the user's text.
  const blocks = body.split(/\n\n(?=\d+\. )/)
  if (blocks.length !== questionCount) return null

  const answers: AnswerView[] = []
  for (const block of blocks) {
    const opt = block.match(/→ Selected option (\d+) of \d+/)
    if (opt) {
      answers.push({ kind: 'option', index: Number(opt[1]) - 1 })
      continue
    }
    const custom = block.match(/→ Answered in their own words:\n([\s\S]*)$/)
    if (custom) {
      const text = custom[1]
        .split('\n')
        .map((line) => line.replace(/^ {3}/, ''))
        .join('\n')
      answers.push({ kind: 'custom', text })
      continue
    }
    return null
  }
  return answers
}

export type QuestionCardProps = {
  call: ToolCallInfo
  result?: ToolResultInfo
  /** Live state while the turn is parked on this card. */
  ask?: AskCardState
  onRespond?: (askId: string, response: AskUserResponse) => void
}

export const QuestionCard = memo(function QuestionCard({
  call,
  result,
  ask,
  onRespond
}: QuestionCardProps): React.JSX.Element | null {
  const { t } = useTranslation()
  const tokens = useTokens()
  const [activeIdx, setActiveIdx] = useState(0)
  // Answers picked so far, before the single submit (multi-question only — a
  // one-question card submits on the first pick, like it always has).
  const [draft, setDraft] = useState<(AskUserAnswer | undefined)[]>([])
  // Per-question free-text drafts, keyed by question index.
  const [otherTexts, setOtherTexts] = useState<Record<number, string>>({})
  // The free-text answer field's own iOS keyboard-dismiss chevron.
  const accessoryID = useId()
  // The chip row scrolls horizontally (it never wraps) — keep the active
  // question's chip in view as answering auto-advances past the edge.
  const chipsRef = useRef<ScrollView | null>(null)
  const chipOffsets = useRef<number[]>([])

  const fallbacks: OtherFallbacks = {
    label: t('chat.questionCard.otherLabel'),
    description: t('chat.questionCard.otherDescription')
  }

  const questions: QuestionData[] = ask
    ? ask.questions.map((q) => ({
        question: q.question,
        details: q.details,
        options: q.options,
        allowOther: q.allowOther,
        otherLabel: q.otherLabel || fallbacks.label,
        otherDescription: q.otherDescription || fallbacks.description
      }))
    : parseQuestionsFromArgs(call.args, fallbacks)

  const total = questions.length
  const current = Math.min(activeIdx, Math.max(total - 1, 0))

  useEffect(() => {
    const x = chipOffsets.current[current]
    if (typeof x === 'number')
      chipsRef.current?.scrollTo({ x: Math.max(x - 24, 0), animated: true })
  }, [current])

  // Nothing to render if the agent gave us no usable questions — don't surface
  // an empty shell.
  if (total === 0) return null

  const multi = total > 1
  const answered = !!result || !!ask?.answered
  // Prefer the live answers (instant feedback on submit); fall back to parsing
  // the persisted result so the summary survives turn-end and a reopen.
  const answers: AnswerView[] | null =
    ask?.answers ?? (result?.status === 'success' ? parseAnswers(result.output, total) : null)

  const active = questions[current]
  const activeDraft = draft[current]
  const otherText = otherTexts[current] ?? ''
  // Interactive only while the desktop is actually holding this turn open for
  // an answer. A card replayed from the transcript, or one mirrored from a
  // turn running on another surface, is a record — never a live control.
  const live = !!ask && !answered && !!onRespond

  /** Record one question's answer, then advance — or submit when done. */
  const record = (index: number, answer: AskUserAnswer): void => {
    if (!live || !ask || !onRespond) return
    const next = [...draft]
    next[index] = answer
    setDraft(next)
    for (let step = 1; step <= total; step++) {
      const i = (index + step) % total
      if (!next[i]) {
        setActiveIdx(i)
        return
      }
    }
    onRespond(ask.askId, { kind: 'answered', answers: next as AskUserAnswer[] })
  }

  const submitOther = (): void => {
    const text = otherText.trim()
    if (!text) return
    record(current, { kind: 'custom', text })
  }

  // The question shown in the body — before submit it follows the user's taps;
  // after, the chips still flip between questions, each rendering its chosen
  // option highlighted exactly like the classic answered card.
  const activeAnswer: AnswerView | undefined = answered ? answers?.[current] : activeDraft
  const selectedIndex = activeAnswer?.kind === 'option' ? activeAnswer.index : undefined
  const customAnswer = activeAnswer?.kind === 'custom' ? activeAnswer.text : undefined
  const answeredByCustom = answered && activeAnswer?.kind === 'custom'
  // The "something else" box highlights for the submitted custom answer AND for
  // a pre-submit draft pick the user is revisiting via the tabs.
  const otherChosen = answeredByCustom || (!answered && activeDraft?.kind === 'custom')

  return (
    <View className="border-border bg-surface w-full max-w-[85%] self-start rounded-2xl border px-4 py-3">
      {multi ? (
        <View className="mb-3 flex-row items-start gap-2">
          {/* One line, never wraps: the row scrolls horizontally inside the
              available card width. The count label is pinned to its own
              chip-height line box so its text centers on the chips. */}
          <ScrollView
            ref={chipsRef}
            horizontal
            showsHorizontalScrollIndicator={false}
            className="min-w-0 flex-1"
            contentContainerStyle={{ alignItems: 'center', gap: 6 }}
          >
            {questions.map((_, i) => {
              const isActive = i === current
              const isDone = answered ? !!answers?.[i] : !!draft[i]
              return (
                <Pressable
                  key={i}
                  accessibilityRole="button"
                  accessibilityLabel={t('chat.questionCard.questionTab', { number: i + 1 })}
                  onLayout={(event) => {
                    chipOffsets.current[i] = event.nativeEvent.layout.x
                  }}
                  onPress={() => setActiveIdx(i)}
                  className={cn(
                    // Desktop tones are bg-accent/10, border-accent/40, bg-bg/40
                    // — precomputed tokens here, because an alpha modifier on a
                    // var() color silently drops in RN and a dropped BORDER
                    // color paints black (see global.css).
                    'h-6 w-6 shrink-0 items-center justify-center rounded-md border',
                    isActive
                      ? 'border-accent bg-accent-soft'
                      : isDone
                        ? 'border-accent-line bg-accent'
                        : 'border-border bg-bg-soft'
                  )}
                >
                  {isDone && !isActive ? (
                    <CheckmarkCircle02Icon size={13} className="text-white" />
                  ) : (
                    <Text
                      className={cn(
                        'font-sans-semibold text-xs',
                        isActive ? 'text-accent' : 'text-muted'
                      )}
                    >
                      {i + 1}
                    </Text>
                  )}
                </Pressable>
              )
            })}
          </ScrollView>
          <Text className="text-muted h-6 shrink-0 font-sans text-xs leading-6">
            {t('chat.questionCard.questionCount', { current: current + 1, total })}
          </Text>
        </View>
      ) : null}

      <View className="mb-3 flex-row items-start gap-2">
        <MessageQuestionIcon size={18} className="text-accent mt-0.5 shrink-0" />
        <View className="min-w-0 flex-1 flex-col">
          {/* The question and its details are prose worth copying, and neither
              sits inside a Pressable — an option label does, so those stay
              non-selectable (a selectable Text on Android takes focus and
              swallows the tap that answers the question). */}
          <Text selectable className="text-fg font-sans-semibold text-left text-base leading-snug">
            {active.question}
          </Text>
          {active.details ? (
            <Text selectable className="text-muted mt-1 text-left font-sans text-xs leading-snug">
              {active.details}
            </Text>
          ) : null}
        </View>
      </View>

      <View className="flex-col gap-1.5">
        {active.options.map((option, index) => {
          const isChosen = selectedIndex === index
          const dimmed = answered && !isChosen
          return (
            <Pressable
              key={index}
              accessibilityRole="button"
              accessibilityState={{ disabled: !live, selected: isChosen }}
              disabled={!live}
              onPress={() => record(current, { kind: 'option', index })}
              className={cn(
                'w-full flex-row items-start gap-3 rounded-xl border px-3 py-2.5',
                isChosen ? 'border-accent bg-accent-soft' : 'border-border bg-bg-soft',
                live && !isChosen && 'active:bg-bg',
                dimmed && 'opacity-50'
              )}
            >
              <View
                className={cn(
                  'mt-0.5 h-5 w-5 shrink-0 items-center justify-center rounded-md',
                  isChosen ? 'bg-accent' : 'bg-primary-soft'
                )}
              >
                {isChosen ? (
                  <CheckmarkCircle02Icon size={14} className="text-white" />
                ) : (
                  <Text className="text-primary font-sans-semibold text-xs">{index + 1}</Text>
                )}
              </View>
              <View className="min-w-0 flex-1 flex-col">
                <Text className="text-fg font-sans-medium text-left text-sm leading-snug">
                  {option.label}
                </Text>
                {option.description ? (
                  <Text className="text-muted mt-0.5 text-left font-sans text-xs leading-snug">
                    {option.description}
                  </Text>
                ) : null}
              </View>
            </Pressable>
          )
        })}

        {active.allowOther ? (
          <View
            className={cn(
              'rounded-xl border px-3 py-2.5',
              otherChosen ? 'border-accent bg-accent-soft' : 'border-border bg-bg-soft',
              answered && !answeredByCustom && 'opacity-50'
            )}
          >
            <View className="flex-row items-start gap-3">
              <View
                className={cn(
                  'mt-0.5 h-5 w-5 shrink-0 items-center justify-center rounded-md',
                  otherChosen ? 'bg-accent' : 'bg-primary-soft'
                )}
              >
                {otherChosen ? (
                  <CheckmarkCircle02Icon size={14} className="text-white" />
                ) : (
                  <Text className="text-primary font-sans-semibold text-xs">
                    {active.options.length + 1}
                  </Text>
                )}
              </View>
              <View className="min-w-0 flex-1 flex-col">
                <Text className="text-fg font-sans-medium text-left text-sm leading-snug">
                  {active.otherLabel}
                </Text>
                <Text className="text-muted mt-0.5 text-left font-sans text-xs leading-snug">
                  {active.otherDescription}
                </Text>
              </View>
            </View>

            {answered ? (
              answeredByCustom && customAnswer ? (
                <View className="border-border-soft bg-bg-soft mt-2 rounded-lg border px-3 py-2">
                  <Text selectable className="text-fg text-left font-sans text-xs leading-snug">
                    {customAnswer}
                  </Text>
                </View>
              ) : null
            ) : live ? (
              <View className="mt-2 flex-row items-center gap-2">
                <KeyboardDismissAccessory nativeID={accessoryID} />
                <TextInput
                  multiline
                  inputAccessoryViewID={accessoryID}
                  value={otherText}
                  onChangeText={(value) => setOtherTexts((prev) => ({ ...prev, [current]: value }))}
                  placeholder={rtlPlaceholder(t('chat.questionCard.otherPlaceholder'))}
                  placeholderTextColor={tokens.muted}
                  selectionColor={tokens.accent}
                  style={WRITING_DIRECTION}
                  className={cn(
                    'border-border bg-bg text-fg h-9 flex-1 rounded-lg border px-3 py-2 font-sans text-xs leading-tight',
                    INPUT_TEXT_ALIGN
                  )}
                />
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={t('chat.questionCard.submit')}
                  accessibilityState={{ disabled: !otherText.trim() }}
                  disabled={!otherText.trim()}
                  onPress={submitOther}
                  className={cn(
                    'bg-primary h-9 w-9 shrink-0 items-center justify-center rounded-lg',
                    !otherText.trim() && 'opacity-40'
                  )}
                >
                  <SentIcon size={16} className="text-primary-fg" />
                </Pressable>
              </View>
            ) : null}
          </View>
        ) : null}
      </View>

      {/* Always confirm the answers at the bottom once answered — useful even
          when the chosen options are highlighted above. A single question keeps
          the classic one-line footer; several get a compact per-question
          summary (falling back to the raw output when a persisted result can't
          be parsed back into per-question answers). */}
      {answered && multi ? (
        answers ? (
          <View className="border-border-soft mt-3 flex-col gap-1.5 border-t pt-2.5">
            <Text className="text-muted font-sans-medium mb-0 text-left text-xs">
              {t('chat.questionCard.yourAnswers')}
            </Text>
            {questions.map((q, i) => {
              const answer = answers[i]
              const chosen = answer?.kind === 'option' ? q.options[answer.index] : undefined
              return (
                <View key={i} className="flex-row items-start gap-2">
                  <View className="bg-primary-soft mt-px h-4 w-4 shrink-0 items-center justify-center rounded">
                    <Text className="text-primary font-sans-semibold text-[10px]">{i + 1}</Text>
                  </View>
                  <Text
                    selectable
                    className="text-muted min-w-0 flex-1 text-left font-sans text-xs leading-snug"
                  >
                    {q.question}{' '}
                    <Text className="text-fg font-sans-medium">
                      {chosen ? chosen.label : answer?.kind === 'custom' ? (answer.text ?? '') : ''}
                    </Text>
                  </Text>
                </View>
              )
            })}
          </View>
        ) : result?.output ? (
          <Text selectable className="text-muted mt-3 text-left font-sans text-xs leading-snug">
            {result.output}
          </Text>
        ) : null
      ) : answered && result?.output ? (
        <Text selectable className="text-muted mt-3 text-left font-sans text-xs leading-snug">
          <Text className="font-sans-medium">{t('chat.questionCard.yourAnswer')}: </Text>
          {result.output}
        </Text>
      ) : null}
    </View>
  )
})
