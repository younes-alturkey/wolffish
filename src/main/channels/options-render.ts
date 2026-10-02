/**
 * Rendering an `offer_options` card on a text-only channel (Telegram /
 * WhatsApp), where there are no tabs and no copy button.
 *
 * The card's entire content lives in the tool CALL's args — unlike every
 * other tool there is no result to fall back on — so without this the model
 * would offer the user a set of snippets and the channel would show nothing
 * at all. Tabs can't exist here, so each option becomes its own message: a
 * lettered heading plus the body in a monospace block, which is the one
 * thing both clients make tap-to-copy. That is the channel's copy button.
 */
import { optionLetter, parseOfferedOptions, type OfferedOption } from '@main/runtime/cerebellum'

/**
 * Per-option body ceiling on a channel. Telegram caps a message at 4096
 * characters and WhatsApp is unhappy well before that; an option longer than
 * this is truncated with a note rather than silently swallowing the send.
 */
const CHANNEL_CONTENT_CLAMP = 3200

export type RenderedOption = {
  letter: string
  title: string
  description?: string
  language?: string
  /** Clamped to what a single channel message can carry. */
  content: string
  /** Whether `content` was cut short. */
  truncated: boolean
}

export type RenderedOptionsCard = {
  title?: string
  options: RenderedOption[]
}

/**
 * Shape an offer_options call's args for a text channel, or null when it
 * carries nothing usable (the renderers then send nothing, exactly as the
 * in-app card draws nothing).
 */
export function renderOptionsForChannel(
  args: Record<string, unknown> | undefined
): RenderedOptionsCard | null {
  const parsed: OfferedOption[] = parseOfferedOptions(args)
  if (parsed.length === 0) return null
  const title = typeof args?.title === 'string' ? args.title.trim() : ''
  return {
    ...(title ? { title } : {}),
    options: parsed.map((option, i) => {
      const truncated = option.content.length > CHANNEL_CONTENT_CLAMP
      return {
        letter: optionLetter(i),
        title: option.title,
        ...(option.description ? { description: option.description } : {}),
        ...(option.language ? { language: option.language } : {}),
        content: truncated ? option.content.slice(0, CHANNEL_CONTENT_CLAMP) : option.content,
        truncated
      }
    })
  }
}
