/**
 * options — show the user several alternative pieces of content as one
 * tabbed card they can read and copy.
 *
 * Unlike `ask`, this tool is PURELY PRESENTATIONAL: it does not pause the
 * agent loop, there is no host bridge, and nothing comes back from the user.
 * The card is rendered entirely from the persisted `tool_call` args — the
 * same source that rebuilds an answered ask card from history — which is why
 * it survives a reload on every surface without a byte of extra state.
 *
 * All this plugin does is validate + normalize the options and hand back a
 * short confirmation. The content itself never round-trips through the tool
 * result: the model already has it (it wrote it), and echoing a wall of code
 * back into the context for no reader is pure waste.
 */

const OPTION_ITEM_SCHEMA = {
  type: 'object',
  properties: {
    title: {
      type: 'string',
      description: 'Short tab label — 2–4 words, distinct and scannable.'
    },
    description: {
      type: 'string',
      description: 'Optional one-line note under the title — the trade-off this option makes.'
    },
    language: {
      type: 'string',
      description:
        'Language id for highlighting (ts, python, bash, json …) when the content is raw code. Omit for markdown content.'
    },
    content: {
      type: 'string',
      description: 'The body of this option, copied verbatim when the user hits copy.'
    }
  },
  required: ['title', 'content']
}

const tools = [
  {
    name: 'offer_options',
    description:
      "Show the user several alternative pieces of content as one tabbed card they can read and copy. Each option is a short title plus a body of code or markdown; the card puts the titles in a scrollable tab row (A, B, C …) and shows the selected option's body underneath with a copy button. Reach for it whenever a choice genuinely serves the user, not only when you were already going to paste two variants — if you are producing something to copy and a second version is defensibly different, show both here rather than picking one silently or asking whether they also want the other. Skip it when there is one honest answer. Purely presentational — it does not pause your turn and the user does not answer it; use ask_user when you need a decision back.",
    parameters: {
      type: 'object',
      properties: {
        title: {
          type: 'string',
          description: 'Optional heading for the whole card.'
        },
        options: {
          type: 'array',
          description: 'The alternatives, in display order. 2–8 items.',
          items: OPTION_ITEM_SCHEMA
        }
      },
      required: ['options']
    }
  }
]

/** How many options one card may carry. Beyond this the tab row stops being
 *  scannable and the model is padding rather than choosing. Exceeding it is
 *  an ERROR, never a silent drop: options the model believes it showed but
 *  the user cannot see are worse than a refused call it can fix. */
const MAX_OPTIONS = 10

/**
 * Per-option content ceiling (~300 lines). The args ride the conversation
 * file, the model's own replayed context and the mobile wire, and an option
 * is a snippet to COPY, not a file to deliver. Exceeding it is an error
 * rather than a truncation: a user pasting a snippet that was silently cut
 * short is the one failure this card must never produce.
 */
const MAX_CONTENT = 12000

function trimmed(value) {
  return typeof value === 'string' ? value.trim() : ''
}

/**
 * The tab letter for position i: A…Z, then AA, AB … — the spreadsheet
 * column scheme. Mirrored verbatim by every renderer (desktop, mobile, CLI)
 * so the letter the model names in its reply is the letter on screen.
 */
function optionLetter(index) {
  let n = index
  let out = ''
  do {
    out = String.fromCharCode(65 + (n % 26)) + out
    n = Math.floor(n / 26) - 1
  } while (n >= 0)
  return out
}

/**
 * Coerce one raw option into the card's shape, or null when it's unusable.
 * Tolerant of a bare string (the whole option IS the content) since the
 * model occasionally sends a plain array of snippets.
 */
function normalizeOption(raw, index) {
  if (typeof raw === 'string') {
    const content = raw.trim()
    return content ? { title: `Option ${optionLetter(index)}`, content } : null
  }
  if (!raw || typeof raw !== 'object') return null
  const title = trimmed(raw.title) || trimmed(raw.label)
  // `content` is the documented field; `code` / `text` / `value` are the
  // near-misses the model reaches for, and dropping an option because it
  // used a synonym would lose work it already did.
  const content = trimmed(raw.content) || trimmed(raw.code) || trimmed(raw.text) || trimmed(raw.value)
  if (!content) return null
  const language = trimmed(raw.language) || trimmed(raw.lang)
  const description = trimmed(raw.description)
  return {
    title: title || `Option ${optionLetter(index)}`,
    ...(description ? { description } : {}),
    ...(language ? { language } : {}),
    content
  }
}

function normalizeOptions(raw) {
  if (!Array.isArray(raw)) return null
  const out = []
  for (const item of raw) {
    const option = normalizeOption(item, out.length)
    if (option) out.push(option)
  }
  return out.length > 0 ? out : null
}

const plugin = {
  name: 'options',
  tools,
  async execute(toolName, args) {
    if (toolName !== 'offer_options') {
      return { success: false, error: `options: unknown tool ${toolName}` }
    }

    const a = args ?? {}
    const options = normalizeOptions(a.options)
    if (!options) {
      return {
        success: false,
        error:
          'offer_options requires "options": a non-empty array where every item has a "title" and a "content" string. Nothing was shown to the user.'
      }
    }

    // One option is a code block, not a card — say so rather than drawing a
    // one-tab card the user has to click through for no choice.
    if (options.length === 1) {
      return {
        success: false,
        error:
          'offer_options needs at least 2 alternatives — a single version belongs in your reply as a normal code block, not a card.'
      }
    }
    if (options.length > MAX_OPTIONS) {
      return {
        success: false,
        error: `offer_options takes at most ${MAX_OPTIONS} options (you sent ${options.length}). Nothing was shown — pick the ones actually worth choosing between and call again.`
      }
    }
    // Refuse an oversized body rather than cutting it: the whole point of the
    // card is that the user copies the content verbatim, and a snippet that
    // was quietly shortened breaks the moment they paste it.
    const oversized = options.findIndex((o) => o.content.length > MAX_CONTENT)
    if (oversized >= 0) {
      return {
        success: false,
        error: `Option ${optionLetter(oversized)} ("${options[oversized].title}") is ${options[oversized].content.length} characters — offer_options caps an option at ${MAX_CONTENT}. Nothing was shown. Shorten it to the part worth copying, or write the full version to a file and deliver it with send_file.`
      }
    }

    const listed = options.map((o, i) => `${optionLetter(i)}. ${o.title}`).join(', ')
    return {
      success: true,
      // Titles only. The card on screen holds the contents; repeating them
      // here would double every snippet in the model's own context.
      output: `Showed the user a card with ${options.length} options they can read and copy: ${listed}. Say in one line how they differ and which you'd pick — do NOT repeat their contents in your reply.`
    }
  }
}

export default plugin
