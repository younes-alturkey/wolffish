/**
 * ask — pose one or more multiple-choice questions to the user and wait for
 * their answers.
 *
 * The single `ask_user` tool pauses the agent loop, hands the questions to
 * the host via `context.askUser`, and blocks until the user has answered
 * every one. In the app that's one interactive card (numbered tabs when
 * there's more than one question); on text channels the questions are posed
 * one message at a time. The answers — listed options and/or free-text
 * instructions — come back together as the tool output and the loop
 * continues from there.
 *
 * The host bridge (PluginContext.askUser) only resolves on channels with an
 * interactive turn (Electron desktop, Telegram, WhatsApp); elsewhere
 * (headless) it resolves `unsupported` and we tell the model to ask in plain
 * text instead.
 */

const QUESTION_ITEM_SCHEMA = {
  type: 'object',
  properties: {
    question: {
      type: 'string',
      description: 'The question or decision to put to the user. One clear line.'
    },
    details: {
      type: 'string',
      description:
        "Optional extra context shown under the question — why you're asking, or what each choice affects."
    },
    options: {
      type: 'array',
      description: 'The choices to offer, in display order. 2–5 focused, distinct items.',
      items: {
        type: 'object',
        properties: {
          label: { type: 'string', description: 'The choice text shown to the user.' },
          description: {
            type: 'string',
            description: 'Optional short clarifying line under the label.'
          }
        },
        required: ['label']
      }
    },
    allow_other: {
      type: 'boolean',
      description:
        'Whether this question shows the free-text "something else" escape hatch so the user can type their own instructions. Defaults to true.'
    },
    other_label: {
      type: 'string',
      description: 'Optional custom title for the free-text option.'
    },
    other_description: {
      type: 'string',
      description: 'Optional custom hint for the free-text option.'
    }
  },
  required: ['question', 'options']
}

const tools = [
  {
    name: 'ask_user',
    description:
      'Pose one or more multiple-choice questions to the user and wait for their answers. Renders a single interactive card in the chat (numbered tabs when asking several questions); the user answers each question by clicking an option or writing their own instructions, then your loop resumes with all their choices. Use when the next step depends on decisions only the user can make and you can frame each as a few discrete options. Quizzes and knowledge checks MUST run through this tool — one item per quiz question, then grade from the returned answers; never print a quiz as chat text with answers hidden below.',
    parameters: {
      type: 'object',
      properties: {
        questions: {
          type: 'array',
          description:
            'The questions to ask, in order. One item per question — a single item for a simple ask, several to bundle related decisions into one card instead of chaining separate asks.',
          items: QUESTION_ITEM_SCHEMA
        }
      },
      required: ['questions']
    }
  }
]

let askUser = null

function trimmed(value) {
  return typeof value === 'string' ? value.trim() : ''
}

// Coerce a question's `options` into a clean list. Tolerant of an array of
// { label, description } objects OR bare strings, since the model
// occasionally sends either.
function normalizeOptions(raw) {
  if (!Array.isArray(raw)) return []
  const out = []
  for (const item of raw) {
    if (typeof item === 'string') {
      const label = item.trim()
      if (label) out.push({ label })
    } else if (item && typeof item === 'object') {
      const label = trimmed(item.label)
      const description = trimmed(item.description)
      if (label) out.push(description ? { label, description } : { label })
    }
  }
  return out
}

// Coerce one raw question item into the normalized shape the host expects,
// or null when it's unusable (no question text / no options).
function normalizeQuestion(raw) {
  if (!raw || typeof raw !== 'object') return null
  const question = trimmed(raw.question)
  if (!question) return null
  const options = normalizeOptions(raw.options)
  if (options.length === 0) return null
  return {
    question,
    details: trimmed(raw.details) || undefined,
    options,
    allowOther: raw.allow_other !== false,
    otherLabel: trimmed(raw.other_label) || undefined,
    otherDescription: trimmed(raw.other_description) || undefined
  }
}

/**
 * Normalize the tool args into a question list. The documented form is
 * `questions: [...]`; the legacy single-question form (top-level `question`
 * + `options`, from history replay or an older habit) is still accepted and
 * becomes a one-item list.
 */
function normalizeQuestions(a) {
  if (Array.isArray(a.questions) && a.questions.length > 0) {
    const out = []
    for (const raw of a.questions) {
      const q = normalizeQuestion(raw)
      if (!q) return null // one malformed question invalidates the ask — better a loud error than a silently dropped question
      out.push(q)
    }
    return out
  }
  const single = normalizeQuestion(a)
  return single ? [single] : null
}

// Resolve `canceled` if the run is stopped while the questions are open, so
// a user pressing stop doesn't leave execute() hanging on answers that will
// never come.
function withAbort(promise, signal) {
  if (!signal) return promise
  if (signal.aborted) return Promise.resolve({ kind: 'canceled' })
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      cleanup()
      resolve({ kind: 'canceled' })
    }
    const cleanup = () => signal.removeEventListener('abort', onAbort)
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(
      (value) => {
        cleanup()
        resolve(value)
      },
      (err) => {
        cleanup()
        reject(err)
      }
    )
  })
}

/**
 * One question's answer, reduced to a composable phrase: for an option pick,
 * `phrase` reads `option N of M: "label" — description` (the wording both
 * output formats share); for custom, `text` is the user's own words.
 * Returns null when the answer doesn't line up with the question (an index
 * out of range, an empty custom text) — the caller turns that into an error.
 */
function describeAnswer(question, answer) {
  if (answer && answer.kind === 'option') {
    const chosen = question.options[answer.index]
    if (!chosen) return null
    const desc = chosen.description ? ` — ${chosen.description}` : ''
    return {
      kind: 'option',
      phrase: `option ${answer.index + 1} of ${question.options.length}: "${chosen.label}"${desc}`
    }
  }
  if (answer && answer.kind === 'custom') {
    const text = trimmed(answer.text)
    if (!text) return null
    return { kind: 'custom', text }
  }
  return null
}

/**
 * The multi-question output block for question i. Custom text is indented
 * three spaces on every line so a numbered line inside the user's own words
 * can never look like the next question boundary (`^N. ` at column 0) —
 * the renderer re-parses this exact format to rebuild answered cards from
 * history.
 */
function formatAnswerBlock(question, described, index) {
  const head = `${index + 1}. ${question.question}`
  if (described.kind === 'option') {
    return `${head}\n   → Selected ${described.phrase}`
  }
  const indented = described.text.split('\n').join('\n   ')
  return `${head}\n   → Answered in their own words:\n   ${indented}`
}

const plugin = {
  name: 'ask',
  tools,
  async init(context) {
    askUser = typeof context?.askUser === 'function' ? context.askUser : null
  },
  async execute(toolName, args, signal) {
    if (toolName !== 'ask_user') {
      return { success: false, error: `ask: unknown tool ${toolName}` }
    }
    if (typeof askUser !== 'function') {
      return {
        success: false,
        error:
          'ask_user is unavailable in this runtime. Ask the user directly in your reply instead.'
      }
    }

    const a = args ?? {}
    const questions = normalizeQuestions(a)
    if (!questions) {
      return {
        success: false,
        error:
          'ask_user requires "questions": a non-empty array where every item has a "question" string and a non-empty "options" array of { label, description? } choices.'
      }
    }

    let response
    try {
      response = await withAbort(Promise.resolve(askUser({ questions })), signal)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return { success: false, error: `ask_user failed: ${message}` }
    }

    switch (response && response.kind) {
      case 'answered': {
        const answers = Array.isArray(response.answers) ? response.answers : []
        if (answers.length !== questions.length) {
          return { success: false, error: "The user's answers could not be read back. Ask again." }
        }
        const described = []
        for (let i = 0; i < questions.length; i++) {
          const d = describeAnswer(questions[i], answers[i])
          if (!d) {
            return {
              success: false,
              error: "The user's answers could not be read back. Ask again."
            }
          }
          described.push(d)
        }

        // Single question: keep the exact legacy output format — the
        // renderer and channel history parse it, and the model knows it.
        if (questions.length === 1) {
          const d = described[0]
          return {
            success: true,
            output:
              d.kind === 'option'
                ? `The user selected ${d.phrase}`
                : `The user did not pick any of the listed options and instead instructed:\n${d.text}`
          }
        }

        const blocks = described.map((d, i) => formatAnswerBlock(questions[i], d, i))
        return {
          success: true,
          output: `The user answered all ${questions.length} questions:\n\n${blocks.join('\n\n')}`
        }
      }
      case 'unsupported':
        return {
          success: false,
          error:
            'Interactive questions are not available on this channel. Ask the user directly in your reply instead.'
        }
      case 'canceled':
      default:
        return {
          success: false,
          error: 'The user dismissed the questions without answering (or the run was stopped).'
        }
    }
  }
}

export default plugin
