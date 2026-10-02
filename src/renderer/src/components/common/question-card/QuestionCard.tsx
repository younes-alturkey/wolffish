import { cn } from '@lib/utils/cn'
import { RTL_LOCALES } from '@lib/i18n'
import type { AskUserAnswer, AskUserOption, AskUserResponse, Segment } from '@preload/index'
import type { AskCardState } from '@providers/flow/useFlow'
import { useLocale } from '@providers/locale/useLocale'
import { CheckmarkCircle02Icon, MessageQuestionIcon, SentIcon } from 'hugeicons-react'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

type ToolResultSegment = Extract<Segment, { kind: 'tool_result' }>

/**
 * The agent asks the user one or more multiple-choice questions (the
 * `ask_user` tool). Renders one interactive card in the chat: with a single
 * question it's the classic card — numbered options each with a title +
 * description, plus an optional free-text "something else" escape hatch;
 * with several questions a horizontally scrollable row of numbered chip
 * tabs sits on top, answering a question auto-advances to the next
 * unanswered one, and the whole card submits once (all answers together)
 * when the last one is answered. The card keeps its full look after
 * answering — the chips still flip between questions, each showing its
 * chosen option highlighted — with a compact summary of every question and
 * answer appended at the bottom.
 *
 * Two sources feed the card:
 *  - the live `ask` state (the chat:askRequest event) while the questions
 *    are open, carrying the agent's optional custom labels for the free-text
 *    option and, after submit, the user's optimistic answers;
 *  - the persisted tool_call `args` + `result` segments, used to rebuild the
 *    answered card when a conversation is resumed from history (no live
 *    state). Either is enough to render — the card never depends on both.
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
function parseQuestionsFromArgs(
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
 * answered card highlights the right options even after the turn ends or a
 * conversation is resumed from history (the live `ask` answers aren't
 * saved). Mirrors the stable output formats the `ask` plugin emits: the
 * legacy single-question sentence, and the numbered multi-question summary
 * (whose custom answers are indented three spaces so they can't fake a
 * question boundary). Returns null when the output doesn't parse — the card
 * then falls back to showing the raw output.
 */
function parseAnswers(output: string | undefined, questionCount: number): AnswerView[] | null {
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

export function QuestionCard({
  args,
  result,
  ask,
  onRespond
}: {
  args: Record<string, unknown>
  result?: ToolResultSegment
  ask?: AskCardState
  onRespond: (askId: string, response: AskUserResponse) => void
}): React.JSX.Element | null {
  const { t } = useTranslation()
  const { locale } = useLocale()
  const isRtl = RTL_LOCALES.has(locale)
  const [activeIdx, setActiveIdx] = useState(0)
  // Answers picked so far, before the single submit (multi-question only —
  // a one-question card submits on the first pick, like it always has).
  const [draft, setDraft] = useState<(AskUserAnswer | undefined)[]>([])
  // Per-question free-text drafts, keyed by question index.
  const [otherTexts, setOtherTexts] = useState<Record<number, string>>({})
  // The chip row scrolls horizontally (it never wraps) — keep the active
  // question's chip in view as answering auto-advances past the edge.
  // Row-local scroll ONLY — never scrollIntoView, which walks every
  // scrollable ancestor: this effect fires on mount too, so a card sitting
  // mid-transcript (a reopened conversation with an answered multi-question
  // card in its history) would drag the whole feed up to itself instead of
  // leaving it pinned to the bottom. scrollBy deltas are visual, so the same
  // math holds under the card's dir="rtl".
  const chipsRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    const row = chipsRef.current
    if (!row || row.children.length === 0) return
    const chip = row.children[Math.min(activeIdx, row.children.length - 1)] as
      | HTMLElement
      | undefined
    if (!chip) return
    const rowBox = row.getBoundingClientRect()
    const chipBox = chip.getBoundingClientRect()
    const pastEnd = chipBox.right - rowBox.right
    const beforeStart = chipBox.left - rowBox.left
    if (pastEnd > 0) row.scrollBy({ left: pastEnd, behavior: 'smooth' })
    else if (beforeStart < 0) row.scrollBy({ left: beforeStart, behavior: 'smooth' })
  }, [activeIdx])

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
    : parseQuestionsFromArgs(args, fallbacks)

  // Nothing to render if the agent gave us no usable questions — don't
  // surface an empty shell.
  if (questions.length === 0) return null

  const total = questions.length
  const multi = total > 1
  const answered = !!result || !!ask?.answered
  // Prefer the live answers (instant feedback on submit); fall back to
  // parsing the persisted result so the summary survives turn-end and
  // history-resume.
  const answers: AnswerView[] | null =
    ask?.answers ?? (result?.status === 'success' ? parseAnswers(result.output, total) : null)

  const current = Math.min(activeIdx, total - 1)
  const active = questions[current]
  const activeDraft = draft[current]
  const otherText = otherTexts[current] ?? ''

  /** Record one question's answer, then advance — or submit when done. */
  const record = (index: number, answer: AskUserAnswer): void => {
    if (answered || !ask) return
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

  // The question shown in the body — before submit it follows the user's
  // clicks; after, the chips still flip between questions, each rendering
  // its chosen option highlighted exactly like the classic answered card.
  const activeAnswer: AnswerView | undefined = answered ? answers?.[current] : activeDraft
  const selectedIndex = activeAnswer?.kind === 'option' ? activeAnswer.index : undefined
  const customAnswer = activeAnswer?.kind === 'custom' ? activeAnswer.text : undefined
  const answeredByCustom = answered && activeAnswer?.kind === 'custom'
  // The "something else" box highlights for the submitted custom answer AND
  // for a pre-submit draft pick the user is revisiting via the tabs.
  const otherChosen = answeredByCustom || (!answered && activeDraft?.kind === 'custom')

  return (
    <div
      dir={isRtl ? 'rtl' : 'ltr'}
      className="border-border bg-surface w-full max-w-[85%] self-start rounded-2xl border px-4 py-3 text-sm"
    >
      {multi ? (
        <div className="mb-3 flex items-start gap-2">
          {/* One line, never wraps: the row grows to the chips' total width
              and scrolls horizontally inside the available card width. The
              scrollbar is hidden (still scrollable by wheel/drag + the
              chip-follow effect) — the global stylesheet otherwise
              reserves an 8px gutter inside the scroller. The count label is
              pinned to its own chip-height (h-6) line box at the top of the
              row, so its text centers on the CHIPS themselves — exact even
              if a scrollbar gutter makes the scroller taller than a chip. */}
          <div
            ref={chipsRef}
            className="flex min-w-0 flex-1 items-center gap-1.5 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
          >
            {questions.map((_, i) => {
              const isActive = i === current
              const isDone = answered ? !!answers?.[i] : !!draft[i]
              return (
                <button
                  key={i}
                  type="button"
                  title={t('chat.questionCard.questionTab', { number: i + 1 })}
                  onClick={() => setActiveIdx(i)}
                  className={cn(
                    'flex h-6 w-6 shrink-0 cursor-pointer items-center justify-center rounded-md border text-xs font-semibold',
                    isActive
                      ? 'border-accent bg-accent/10 text-accent'
                      : isDone
                        ? 'border-accent/40 bg-accent text-white'
                        : 'border-border bg-bg/40 text-muted hover:bg-bg'
                  )}
                >
                  {isDone && !isActive ? <CheckmarkCircle02Icon size={13} /> : i + 1}
                </button>
              )
            })}
          </div>
          <span className="text-muted inline-flex h-6 shrink-0 items-center text-xs">
            {t('chat.questionCard.questionCount', { current: current + 1, total })}
          </span>
        </div>
      ) : null}

      <div className="mb-3 flex items-start gap-2">
        <MessageQuestionIcon size={18} className="text-accent mt-0.5 shrink-0" />
        <div className="min-w-0 flex-1">
          <p className="text-fg text-base font-semibold leading-snug">{active.question}</p>
          {active.details ? (
            <p className="text-muted mt-1 text-xs leading-snug">{active.details}</p>
          ) : null}
        </div>
      </div>

      <div className="flex flex-col gap-1.5">
        {active.options.map((option, index) => {
          const isChosen = selectedIndex === index
          const dimmed = answered && !isChosen
          return (
            <button
              key={index}
              type="button"
              disabled={answered}
              onClick={() => record(current, { kind: 'option', index })}
              className={cn(
                'flex w-full items-start gap-3 rounded-xl border px-3 py-2.5 text-start',
                isChosen ? 'border-accent bg-accent/10' : 'border-border bg-bg/40',
                // Hover feedback only while the buttons are actually live —
                // :hover still paints on disabled buttons otherwise.
                !answered && !isChosen && 'hover:bg-bg',
                dimmed && 'opacity-50',
                !answered && 'cursor-pointer',
                answered && 'cursor-default'
              )}
            >
              <span
                className={cn(
                  'mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-md text-xs font-semibold',
                  isChosen ? 'bg-accent text-white' : 'bg-primary/10 text-primary'
                )}
              >
                {isChosen ? <CheckmarkCircle02Icon size={14} /> : index + 1}
              </span>
              <span className="min-w-0 flex-1">
                <span className="text-fg block font-medium leading-snug">{option.label}</span>
                {option.description ? (
                  <span className="text-muted mt-0.5 block text-xs leading-snug">
                    {option.description}
                  </span>
                ) : null}
              </span>
            </button>
          )
        })}

        {active.allowOther ? (
          <div
            className={cn(
              'rounded-xl border px-3 py-2.5',
              otherChosen ? 'border-accent bg-accent/10' : 'border-border bg-bg/40',
              answered && !answeredByCustom && 'opacity-50'
            )}
          >
            <div className="flex items-start gap-3">
              <span
                className={cn(
                  'mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-md text-xs font-semibold',
                  otherChosen ? 'bg-accent text-white' : 'bg-primary/10 text-primary'
                )}
              >
                {otherChosen ? <CheckmarkCircle02Icon size={14} /> : active.options.length + 1}
              </span>
              <span className="min-w-0 flex-1">
                <span className="text-fg block font-medium leading-snug">{active.otherLabel}</span>
                <span className="text-muted mt-0.5 block text-xs leading-snug">
                  {active.otherDescription}
                </span>
              </span>
            </div>

            {answered ? (
              answeredByCustom && customAnswer ? (
                <p className="text-fg border-border/60 mt-2 rounded-lg border bg-bg/60 px-3 py-2 text-xs leading-snug whitespace-pre-wrap">
                  {customAnswer}
                </p>
              ) : null
            ) : (
              <div className="mt-2 flex items-center gap-2">
                <textarea
                  dir={isRtl ? 'rtl' : 'ltr'}
                  value={otherText}
                  onChange={(e) =>
                    setOtherTexts((prev) => ({ ...prev, [current]: e.target.value }))
                  }
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.shiftKey) {
                      e.preventDefault()
                      submitOther()
                    }
                  }}
                  rows={1}
                  placeholder={t('chat.questionCard.otherPlaceholder')}
                  className={cn(
                    'border-border bg-bg text-fg h-9 flex-1 resize-none overflow-y-auto rounded-lg border px-3 py-2 text-xs leading-tight',
                    'focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none'
                  )}
                />
                <button
                  type="button"
                  onClick={submitOther}
                  disabled={!otherText.trim()}
                  title={t('chat.questionCard.submit')}
                  className={cn(
                    'bg-primary text-primary-fg flex h-9 w-9 shrink-0 items-center justify-center rounded-lg',
                    'enabled:hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40'
                  )}
                >
                  <SentIcon size={16} />
                </button>
              </div>
            )}
          </div>
        ) : null}
      </div>

      {/* Always confirm the answers at the bottom once answered — useful even
          when the chosen options are highlighted above. Single question keeps
          the classic one-line footer; several get a compact per-question
          summary (falling back to the raw output when a persisted result
          can't be parsed back into per-question answers). */}
      {answered && multi ? (
        answers ? (
          <div className="border-border/60 mt-3 border-t pt-2.5">
            <p className="text-muted mb-1.5 text-xs font-medium">
              {t('chat.questionCard.yourAnswers')}
            </p>
            <div className="flex flex-col gap-1.5">
              {questions.map((q, i) => {
                const answer = answers[i]
                const chosen = answer?.kind === 'option' ? q.options[answer.index] : undefined
                return (
                  <div key={i} className="flex items-start gap-2 text-xs leading-snug">
                    <span className="bg-primary/10 text-primary mt-px flex h-4 w-4 shrink-0 items-center justify-center rounded text-[10px] font-semibold">
                      {i + 1}
                    </span>
                    <span className="text-muted min-w-0">
                      {q.question}
                      <span className="text-fg ms-1.5 font-medium whitespace-pre-wrap">
                        {chosen
                          ? chosen.label
                          : answer?.kind === 'custom'
                            ? (answer.text ?? '')
                            : ''}
                      </span>
                    </span>
                  </div>
                )
              })}
            </div>
          </div>
        ) : result?.output ? (
          <p className="text-muted mt-3 text-xs leading-snug whitespace-pre-wrap">
            {result.output}
          </p>
        ) : null
      ) : answered && result?.output ? (
        <p className="text-muted mt-3 text-xs leading-snug">
          <span className="font-medium">{t('chat.questionCard.yourAnswer')}: </span>
          {result.output}
        </p>
      ) : null}
    </div>
  )
}
