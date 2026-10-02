import { validateTelegramHtml } from '@main/channels/telegram/format'
import { MAX_CONSECUTIVE_REJECTS, RejectBudget } from '@main/channels/send-policy'
import { compressVideoToLimit } from '@main/channels/video-compress'
import type {
  Capability,
  SkillToolDescriptor,
  ToolExecutionResult,
  WolffishPlugin
} from '@main/runtime/cerebellum'
import { workspaceRoot } from '@main/workspace/workspace'
import { Bot, GrammyError, InputFile } from 'grammy'
import fs from 'node:fs/promises'
import path from 'node:path'

/**
 * Capability name used to register Telegram tools with the cerebellum.
 * Lives outside brain/cerebellum/ — it's an in-process capability the
 * channel manages directly.
 */
export const TELEGRAM_CAPABILITY_NAME = 'telegram'

/**
 * Bot upload caps published by Telegram. Photos go through the
 * compressed-image path with a 10 MB ceiling; documents/video/audio
 * use the multipart path which tops out at 50 MB. Voice notes have
 * the same 50 MB document limit. Niche file types (stickers, video
 * notes) aren't exposed as tools — they'd be more confusing than
 * useful for the LLM.
 */
const PHOTO_LIMIT = 10 * 1024 * 1024
const DOCUMENT_LIMIT = 50 * 1024 * 1024

/**
 * Formatting contract shared by every media-caption parameter description —
 * one string so the four captions can never drift apart. Mirrors the
 * telegram_send message rules (captions are parsed identically).
 */
const CAPTION_HTML_RULES =
  'Delivered with Telegram parse_mode HTML — Telegram HTML subset ONLY (<b> <i> <u> <s> <code> <pre> <a href> <blockquote> <span class="tg-spoiler">), never Markdown (**, #, tables, [text](url) show raw), never a wrapper/<br> tag, close every tag. Tags are RAW < > characters — entity-escape only a literal & < > in prose as &amp; &lt; &gt;, never the tags themselves (&lt;b&gt; arrives as literal text, not bold). A broken or Markdown-formatted caption is rejected without sending; if it has any markup, run telegram_check_format on it first.'

/**
 * The model's override for the pre-send format gate: information, not
 * force. A formatting reject names the problems; if the flagged markup is
 * the CONTENT (code being shown, not formatting), the model asserts that
 * and the text goes out exactly as written — the API plain fallback still
 * catches anything Telegram itself cannot parse.
 */
const SEND_AS_IS_PARAM = {
  type: 'boolean',
  description:
    'Set true ONLY when this exact text was just rejected by the formatting check and the flagged markup is INTENTIONAL content (you are showing code/markup as literal text, not formatting). Skips the format check: the text goes out exactly as written — the user may see raw tags, and HTML Telegram cannot parse falls back to plain text. NEVER use it to avoid fixing a real formatting mistake.',
  required: false
}

type ToolDeps = {
  getBot: () => Bot | null
  getAllowedUserIds: () => Set<number>
  /**
   * Records every outgoing message id with the channel's per-chat
   * tracker so /clear can later delete it. Optional — older
   * call sites that don't pass this still work, the messages
   * just won't be cleared by /clear.
   */
  trackOutgoing?: (chatId: number, messageId: number) => void
  /**
   * Point `chatId`'s chat at the conversation this turn belongs to, so the
   * user's reply lands in the conversation that messaged them. Owned by the
   * channel (it holds the map + the stale-clock rules). A no-op when the chat
   * is already bound there.
   */
  bindChatToSendingConversation?: (chatId: number) => Promise<void>
  /**
   * Make the bundled ffmpeg available (self-installs on first use), used to
   * compress oversized videos under the bot API's 50 MB ceiling instead of
   * refusing them. Idempotent and cheap after the first call.
   */
  ensureFfmpeg?: () => Promise<unknown>
}

/**
 * Tools whose delivery invites a reply, so the recipient's chat should be
 * pointed at the conversation that sent it. `telegram_edit_message` is left
 * out on purpose: rewording a message already delivered isn't a fresh outreach
 * — the send that created it did the binding, and re-binding on an edit would
 * grab a chat the user may have moved on from.
 */
const BINDS_CHAT = new Set([
  'telegram_send',
  'telegram_send_photo',
  'telegram_send_document',
  'telegram_send_video',
  'telegram_send_audio'
])

/**
 * Build the Telegram capability + plugin pair to register with the
 * cerebellum while the bot is running. The LLM gets the widely-used
 * primitives (text, media, edit) — niche features like stickers,
 * locations, dice, polls and forum messages are intentionally left
 * out so the surface area stays small and predictable.
 *
 * The plugin captures references to the bot and allowed-id set,
 * not values, so settings changes that swap the bot or adjust the
 * id list take effect on the next tool call without re-registration.
 */
export function buildTelegramCapability(deps: ToolDeps): {
  capability: Capability
  plugin: WolffishPlugin
} {
  const tools: SkillToolDescriptor[] = [
    {
      name: 'telegram_check_format',
      description:
        'Validate text against Telegram\'s HTML rules WITHOUT sending it. Returns "valid" or the exact problems (unsupported tag, unclosed tag, orphan closing tag, bare < or &, formatting tags written as &lt;b&gt; entities instead of raw <b> characters, leaked Markdown). It changes nothing — you fix your own text and re-check. ALWAYS call this right before you send any text OR MEDIA CAPTION that contains ANY HTML tag, literal < & characters, or ANY formatting markup — via telegram_send, telegram_edit_message, or the caption of telegram_send_photo / telegram_send_document / telegram_send_video / telegram_send_audio: one bad tag makes Telegram reject that message/caption and it arrives as raw tag soup, and the send tools REFUSE broken HTML and Markdown outright. Plain prose with no markup never needs checking.',
      parameters: {
        message: {
          type: 'string',
          description:
            'The exact message body you intend to send — byte-for-byte the same string you will pass to the send tool, raw <b>-style tags and all.',
          required: true
        }
      }
    },
    {
      name: 'telegram_send',
      description:
        'Send a text message to one of the allowed Telegram users. Use to notify the user out-of-band — for example when a long-running task you started in the chat finishes. Returns the Telegram message_id so a later edit can target this message.',
      parameters: {
        message: {
          type: 'string',
          description:
            'The message body. 1–4096 characters, delivered with Telegram parse_mode HTML. Telegram does NOT render Markdown (no **, no # headings, no | tables |, no [text](url) — they show as raw syntax). Formatting, if any, is Telegram HTML ONLY: <b>, <i>, <u>, <s>, <code>, <pre>, <a href="…">, <blockquote>, <span class="tg-spoiler">. NO other tags exist — never wrap the body in a container like <message>/<html>/<p>, never use <br> (use a real newline), and close every tag you open. Write the tags as RAW < > characters: entity-escape ONLY a literal & < > in prose (as &amp; &lt; &gt;), NEVER the tags themselves — "&lt;b&gt;Digest&lt;/b&gt;" reaches the user as literal "<b>Digest</b>" text, not bold. One unknown or unclosed tag makes Telegram reject the WHOLE message and it arrives as literal tag soup, so if the text has ANY tag, call telegram_check_format first and only send once it returns valid; broken HTML is rejected by this tool without sending, and so is Markdown-formatted text (**bold**, # headings, | tables |, [text](url), --- rules) — rewrite it in Telegram HTML and resend. GOOD: "📬 <b>Digest</b>\\n<i>2 unread</i>\\nTotal &lt;5 items&gt;". BAD: "📬 <b>Digest</b> …😄</message>" (stray wrapper tag), "&lt;b&gt;Digest&lt;/b&gt;" (escaped tags — arrive as literal text), "**Digest**" (Markdown), "line<br>line" (no <br>), "cost < 5 & rising" (unescaped < &), "━━━━━━━━━━" (divider-bar line — wraps into broken bars on a phone; separate sections with a blank line, not a drawn rule). Plain prose with no markup and no divider bars is always safe.',
          required: true
        },
        sendAsIs: SEND_AS_IS_PARAM,
        userId: {
          type: 'number',
          description:
            'Optional Telegram user ID. Must be in the allowed list. Defaults to the first allowed user.',
          required: false
        }
      }
    },
    {
      name: 'telegram_send_photo',
      description:
        'Send an image to one of the allowed Telegram users. The path must point to a file inside the workspace (e.g. uploads/conv-{id}/foo.png). Up to 10 MB; PNG / JPEG / WebP. Returns the message_id.',
      parameters: {
        path: {
          type: 'string',
          description:
            'Workspace-relative path to the image file (e.g. "uploads/conv-2026-05-02_12-00-00/diagram.png").',
          required: true
        },
        caption: {
          type: 'string',
          description: `Optional caption shown beneath the image, up to 1024 characters. ${CAPTION_HTML_RULES}`,
          required: false
        },
        sendAsIs: SEND_AS_IS_PARAM,
        userId: {
          type: 'number',
          description: 'Optional Telegram user ID. Defaults to the first allowed user.',
          required: false
        }
      }
    },
    {
      name: 'telegram_send_document',
      description:
        'Send any file (text, PDF, archive, etc.) to one of the allowed Telegram users. Up to 50 MB. The original filename is preserved. Returns the message_id.',
      parameters: {
        path: {
          type: 'string',
          description: 'Workspace-relative path to the file.',
          required: true
        },
        caption: {
          type: 'string',
          description: `Optional caption shown beneath the document, up to 1024 characters. ${CAPTION_HTML_RULES}`,
          required: false
        },
        sendAsIs: SEND_AS_IS_PARAM,
        userId: {
          type: 'number',
          description: 'Optional Telegram user ID. Defaults to the first allowed user.',
          required: false
        }
      }
    },
    {
      name: 'telegram_send_video',
      description:
        'Send a video file to one of the allowed Telegram users. Up to 50 MB; MP4 streams reliably across clients. Returns the message_id.',
      parameters: {
        path: {
          type: 'string',
          description: 'Workspace-relative path to the video file.',
          required: true
        },
        caption: {
          type: 'string',
          description: `Optional caption shown beneath the video, up to 1024 characters. ${CAPTION_HTML_RULES}`,
          required: false
        },
        sendAsIs: SEND_AS_IS_PARAM,
        userId: {
          type: 'number',
          description: 'Optional Telegram user ID. Defaults to the first allowed user.',
          required: false
        }
      }
    },
    {
      name: 'telegram_send_audio',
      description:
        'Send an audio file (rendered as a music player) to one of the allowed Telegram users. Up to 50 MB; MP3 / M4A / OGG. Returns the message_id.',
      parameters: {
        path: {
          type: 'string',
          description: 'Workspace-relative path to the audio file.',
          required: true
        },
        caption: {
          type: 'string',
          description: `Optional caption shown beneath the audio, up to 1024 characters. ${CAPTION_HTML_RULES}`,
          required: false
        },
        sendAsIs: SEND_AS_IS_PARAM,
        userId: {
          type: 'number',
          description: 'Optional Telegram user ID. Defaults to the first allowed user.',
          required: false
        }
      }
    },
    {
      name: 'telegram_edit_message',
      description:
        'Edit the text of a previously-sent Telegram message. Pass the message_id from the original send result. Useful for live progress updates without spamming the chat with new messages.',
      parameters: {
        messageId: {
          type: 'number',
          description: 'The message_id returned from a previous telegram_send call.',
          required: true
        },
        message: {
          type: 'string',
          description:
            'New text body. 1–4096 characters, delivered with Telegram parse_mode HTML — same formatting rules as telegram_send (Telegram HTML subset only, never Markdown, never a wrapper/<br> tag, close every tag, escape literal & < > as entities). If the new text has ANY tag, run telegram_check_format on it first — a rejected edit leaves the old message unchanged.',
          required: true
        },
        sendAsIs: SEND_AS_IS_PARAM,
        userId: {
          type: 'number',
          description:
            'Optional Telegram user ID — must be the same chat the original message was sent to. Defaults to the first allowed user.',
          required: false
        }
      }
    }
  ]

  const capability: Capability = {
    name: TELEGRAM_CAPABILITY_NAME,
    dir: '<in-process>',
    description:
      'Out-of-band Telegram messaging. Send text and media to allowed users, or edit a message you sent earlier. Use to notify the user when they are not actively in the chat (e.g. a background task finished) or to deliver an artifact you just produced.\n\nChannel context: only one Telegram conversation processes at a time. The Telegram bot runtime intercepts a handful of slash commands BEFORE they reach you — these are user-to-runtime controls, NOT tools available to you, and you must never call any tool that imitates them:\n\n- `/new` — the runtime starts a fresh conversation.\n- `/current` — the runtime shows the conversation this chat is currently bound to.\n- `/resume` — the runtime shows a numbered picker of past conversations and switches the chat to the chosen one.\n- `/delete` — the runtime shows a numbered picker and deletes the chosen conversation.\n- `/clear` — the runtime deletes the visible Telegram messages without touching the Wolffish conversation file.\n- `/stop` — the runtime cancels the active task.\n- `/approve` and `/deny` — the runtime resolves a pending confirmation prompt.\n- `/status` — the runtime renders an introspection report directly via the insula. **Because /status already covers this on Telegram, you must NOT call introspection tools like `wolffish_status`, `wolffish_recent`, or any other reflective tool on a Telegram turn.** They duplicate /status and produce a long report the user did not ask for. The only exception is when the user explicitly asks a question that ONLY an introspection tool can answer (e.g. "what tasks failed yesterday") — and even then, prefer to summarize from your own context first.\n\nIf a Telegram user asks how to start over, switch conversations, or delete one, point them at the matching slash command — don\'t try to manage conversation state yourself. Otherwise stay focused on whatever the user actually asked for.',
    triggers: { keywords: ['telegram', 'notify', 'message me', 'send to telegram'] },
    tools,
    body: '',
    hasPlugin: true,
    status: 'ok',
    requires: [],
    packages: {},
    npmDependencies: {}
  }

  const plugin: WolffishPlugin = {
    name: TELEGRAM_CAPABILITY_NAME,
    tools: tools.map((t) => ({
      name: t.name,
      description: t.description,
      parameters: toJsonSchema(t.parameters)
    })),
    execute: async (toolName, args) => {
      // Pure validation — no bot needed, so it works on overlay-less turns
      // (heartbeat/procedure/workflow) exactly when the model most needs it.
      if (toolName === 'telegram_check_format') return checkFormat(args)

      const bot = deps.getBot()
      if (!bot) return failure('Telegram bot is not running')

      const dispatch = async (): Promise<ToolExecutionResult> => {
        switch (toolName) {
          case 'telegram_send':
            return sendText(bot, deps, args)
          case 'telegram_send_photo':
            return sendMedia(bot, deps, args, 'photo')
          case 'telegram_send_document':
            return sendMedia(bot, deps, args, 'document')
          case 'telegram_send_video':
            return sendMedia(bot, deps, args, 'video')
          case 'telegram_send_audio':
            return sendMedia(bot, deps, args, 'audio')
          case 'telegram_edit_message':
            return editText(bot, deps, args)
          default:
            return failure(`unknown telegram tool: ${toolName}`)
        }
      }

      const result = await dispatch()

      // A delivered message is an invitation to reply, so hand the chat to the
      // conversation that sent it — the user answering on their phone should
      // continue THIS conversation, not whatever the chat was last left on.
      // Only after a real delivery: binding on a failed send would silently
      // reroute the user's next (unrelated) message for a note they never got.
      if (result.success && BINDS_CHAT.has(toolName)) {
        const target = resolveTarget(deps, args.userId)
        // Best-effort — a message already reached the user; a bookkeeping
        // failure must not turn a delivered send into a reported failure.
        if (target.ok) {
          await deps.bindChatToSendingConversation?.(target.id).catch(() => undefined)
        }
      }
      return result
    }
  }

  return { capability, plugin }
}

function checkFormat(args: Record<string, unknown>): ToolExecutionResult {
  const message = stringArg(args.message)
  if (!message) return failure('message is required and must be a non-empty string')
  const { ok, issues } = validateTelegramHtml(message)
  if (ok) {
    return success('Valid Telegram HTML — safe to send with telegram_send / telegram_edit_message.')
  }
  return success(
    `NOT CLEAN — fix these so the message renders right (an unsupported/unclosed tag or bare < & makes Telegram reject the HTML and it arrives as raw tag soup; entity-escaped tags like &lt;b&gt; show as literal "<b>" text; leaked Markdown shows raw symbols — the send tools REFUSE all of these until fixed). Fix, then re-check before sending:\n- ${issues.join('\n- ')}`
  )
}

/**
 * Pre-send gate shared by telegram_send / captions / telegram_edit_message:
 * the same engine as telegram_check_format, run unconditionally because the
 * model can (and does) skip the check tool. Hard issues — broken HTML AND
 * leaked Markdown — refuse the send: a rejected call is a one-round-trip
 * fix, while delivering one means tag soup, literal "&lt;b&gt;" text, or
 * raw **Markdown** symbols reaching the user. Text that legitimately
 * QUOTES markup still delivers: code spans are masked by the validator,
 * and sendAsIs is the model's deliberate override for everything else.
 * The "invalid argument" prefix is load-bearing: motor's classifyError maps
 * it to validation/non-retryable, so the model sees the reject immediately
 * instead of motor retrying identical args three times.
 */
function formatGate(
  text: string,
  what: 'message' | 'caption' | 'edit'
): { reject: ToolExecutionResult | null; note: string } {
  const report = validateTelegramHtml(text)
  if (report.hard.length > 0) {
    const consequence =
      what === 'edit' ? 'edit NOT applied (the existing message is unchanged)' : 'NOT sent'
    return {
      reject: failure(
        `invalid argument — ${consequence}, the ${what === 'caption' ? 'caption' : 'message'} would reach the user broken or as raw markup symbols:\n- ${report.hard.join(
          '\n- '
        )}\nRewrite it in Telegram HTML and resend (telegram_check_format verifies without sending). If the flagged markup is INTENTIONAL content — you are showing code/markup as text, not formatting — resend the exact same text with sendAsIs: true and it goes out exactly as written.`
      ),
      note: ''
    }
  }
  const note =
    report.soft.length > 0
      ? `\nFormatting note (${what === 'edit' ? 'edit already applied — do NOT redo it' : 'already delivered — do NOT resend'}): ${report.soft.join(' ')}`
      : ''
  return { reject: null, note }
}

// Module-level so the budget survives bot restarts / capability rebuilds.
const rejectBudget = new RejectBudget()

const DELIVERED_DESPITE_NOTE = `\nDelivered DESPITE unresolved formatting problems (the format gate yields after ${MAX_CONSECUTIVE_REJECTS} rejected attempts so a message is never lost) — the user may see raw markup; fix the pattern next time.`

async function sendText(
  bot: Bot,
  deps: ToolDeps,
  args: Record<string, unknown>
): Promise<ToolExecutionResult> {
  const message = stringArg(args.message)
  if (!message) return failure('message is required and must be a non-empty string')
  if (message.length > 4096) {
    return failure(
      `invalid argument: message too long (${message.length} > 4096 characters) — split it into multiple telegram_send calls`
    )
  }
  const gate = boolArg(args.sendAsIs)
    ? { reject: null, note: '\nFormat check skipped (sendAsIs) — delivered exactly as written.' }
    : formatGate(message, 'message')
  const target = resolveTarget(deps, args.userId)
  if (!target.ok) return failure(target.error)
  // The gate may bounce a broken message so the model can fix it, but it
  // can never LOSE one: once this chat's budget is exhausted the message
  // is delivered as composed (a would-400 lands via the plain fallback
  // below), so the worst case is raw markup, never silence.
  let despite = ''
  if (gate.reject) {
    if (!rejectBudget.exhausted(target.id)) {
      rejectBudget.reject(target.id)
      return gate.reject
    }
    despite = DELIVERED_DESPITE_NOTE
  }
  // parse_mode HTML matches what the channel overlay teaches the model.
  // ONLY an entity-parse reject falls through to the plain retry —
  // delivery beats formatting there (it means the message passed the gate,
  // so this is the safety net for whatever the validator missed), and the
  // result carries Telegram's own parse error so the model can fix its
  // markup next time. Any other error (network, rate limit, bad chat)
  // surfaces as a failure with the HTML intact, so the model never gets
  // steered into stripping valid formatting.
  let parseError = ''
  try {
    const result = await bot.api.sendMessage(target.id, message, { parse_mode: 'HTML' })
    deps.trackOutgoing?.(target.id, result.message_id)
    rejectBudget.delivered(target.id)
    return success(`Sent. message_id=${result.message_id} to=${target.id}${despite || gate.note}`)
  } catch (err) {
    if (!isHtmlParseError(err)) return failure(`send failed: ${errMessage(err)}`)
    parseError = errMessage(err)
  }
  try {
    const result = await bot.api.sendMessage(target.id, message)
    deps.trackOutgoing?.(target.id, result.message_id)
    rejectBudget.delivered(target.id)
    return success(
      `Sent as PLAIN text — Telegram rejected the HTML ("${parseError}"), so any tags were shown literally. Already delivered, do NOT resend; fix the markup next time. message_id=${result.message_id} to=${target.id}`
    )
  } catch (err) {
    return failure(`send failed: ${errMessage(err)}`)
  }
}

type MediaKind = 'photo' | 'document' | 'video' | 'audio'

async function sendMedia(
  bot: Bot,
  deps: ToolDeps,
  args: Record<string, unknown>,
  kind: MediaKind
): Promise<ToolExecutionResult> {
  const relativePath = stringArg(args.path)
  if (!relativePath) return failure('path is required (workspace-relative)')

  const abs = resolveWorkspaceFilePath(relativePath)
  if (!abs) {
    return failure(
      `path must be a workspace-relative path inside the workspace root (got "${relativePath}")`
    )
  }

  // An animated GIF sent via sendPhoto is rejected/flattened by Telegram — it
  // must go through sendAnimation to auto-play and loop. Detect it here and
  // treat it like the larger-file kinds for the size limit.
  const isGif = kind === 'photo' && path.extname(abs).toLowerCase() === '.gif'

  let stat: import('node:fs').Stats
  try {
    stat = await fs.stat(abs)
  } catch {
    return failure(`file not found: ${relativePath}`)
  }
  if (!stat.isFile()) return failure(`not a file: ${relativePath}`)

  const limit = kind === 'photo' && !isGif ? PHOTO_LIMIT : DOCUMENT_LIMIT
  let compressedVideo: { mp4: Buffer; note: string } | null = null
  if (stat.size > limit) {
    // Videos get one rescue attempt: re-encode under the ceiling (the file on
    // disk keeps full quality) instead of refusing outright. Everything else
    // still fails fast with the clear size message.
    if (kind === 'video') {
      await deps.ensureFfmpeg?.()
      const compressed = await compressVideoToLimit(abs, limit - 2 * 1024 * 1024)
      if ('error' in compressed) {
        return failure(
          `file too large: ${formatBytes(stat.size)} > ${formatBytes(limit)} (telegram bot limit for ${kind}), and compression failed: ${compressed.error}. Tell the user the full-quality video is available in the app.`
        )
      }
      compressedVideo = compressed
    } else {
      return failure(
        `file too large: ${formatBytes(stat.size)} > ${formatBytes(limit)} (telegram bot limit for ${kind})`
      )
    }
  }

  const target = resolveTarget(deps, args.userId)
  if (!target.ok) return failure(target.error)

  const caption = stringArg(args.caption) ?? undefined
  if (caption && caption.length > 1024) {
    return failure(
      `invalid argument: caption too long (${caption.length} > 1024 characters) — shorten it or send the details as a separate telegram_send message`
    )
  }
  const gate =
    caption && !boolArg(args.sendAsIs)
      ? formatGate(caption, 'caption')
      : {
          reject: null,
          note: caption ? '\nFormat check skipped (sendAsIs) — caption delivered as written.' : ''
        }
  // Same never-lose-a-message budget as sendText — the file (and its
  // caption) always deliver once the chat's bounce budget is spent.
  let despite = ''
  if (gate.reject) {
    if (!rejectBudget.exhausted(target.id)) {
      rejectBudget.reject(target.id)
      return gate.reject
    }
    despite = DELIVERED_DESPITE_NOTE
  }

  let buffer: Buffer
  if (compressedVideo) {
    buffer = compressedVideo.mp4
  } else {
    try {
      buffer = await fs.readFile(abs)
    } catch (err) {
      return failure(`read failed: ${errMessage(err)}`)
    }
  }

  const filename = path.basename(abs)

  // A caption is delivered with parse_mode HTML, exactly like telegram_send —
  // the model writes Telegram's HTML subset and it renders. Without parse_mode
  // the tags would show literally. A fresh InputFile per attempt is required:
  // grammY consumes the buffer stream on send, so a retry needs a new one.
  type CaptionOpts = { caption: string; parse_mode?: 'HTML' } | undefined
  const send = (opts: CaptionOpts): Promise<{ message_id: number }> => {
    const file = new InputFile(buffer, filename)
    if (isGif) return bot.api.sendAnimation(target.id, file, opts)
    if (kind === 'photo') return bot.api.sendPhoto(target.id, file, opts)
    if (kind === 'video') return bot.api.sendVideo(target.id, file, opts)
    if (kind === 'audio') return bot.api.sendAudio(target.id, file, opts)
    return bot.api.sendDocument(target.id, file, opts)
  }

  const compressionNote = compressedVideo
    ? `\nCompressed for Telegram (${compressedVideo.note}) — tell the user the original quality is available in the app.`
    : ''
  let parseError = ''
  try {
    const result = await send(caption ? { caption, parse_mode: 'HTML' } : undefined)
    deps.trackOutgoing?.(target.id, result.message_id)
    rejectBudget.delivered(target.id)
    return success(
      `Sent. message_id=${result.message_id} to=${target.id} kind=${kind}${despite || gate.note}${compressionNote}`
    )
  } catch (err) {
    // Only a caption HTML-parse reject falls through, and only when a caption
    // exists — the FILE still deserves delivery, so resend it with the caption
    // as plain text (tags literal) and tell the model to fix its markup next
    // time. Any other error surfaces with the caption HTML intact.
    if (!caption || !isHtmlParseError(err)) return failure(`send failed: ${errMessage(err)}`)
    parseError = errMessage(err)
  }
  try {
    const result = await send({ caption })
    deps.trackOutgoing?.(target.id, result.message_id)
    rejectBudget.delivered(target.id)
    return success(
      `Sent, but the caption went as PLAIN text — Telegram rejected its HTML ("${parseError}"), so tags were shown literally. Already delivered, do NOT resend; fix the markup next time. message_id=${result.message_id} to=${target.id} kind=${kind}`
    )
  } catch (err) {
    return failure(`send failed: ${errMessage(err)}`)
  }
}

async function editText(
  bot: Bot,
  deps: ToolDeps,
  args: Record<string, unknown>
): Promise<ToolExecutionResult> {
  const messageId = numberArg(args.messageId)
  if (messageId == null) return failure('messageId is required (number)')
  const message = stringArg(args.message)
  if (!message) return failure('message is required and must be a non-empty string')
  if (message.length > 4096) {
    return failure(
      `invalid argument: message too long (${message.length} > 4096 characters) — shorten the edit text`
    )
  }
  const gate = boolArg(args.sendAsIs)
    ? { reject: null, note: '\nFormat check skipped (sendAsIs) — edit applied exactly as written.' }
    : formatGate(message, 'edit')
  if (gate.reject) return gate.reject
  const target = resolveTarget(deps, args.userId)
  if (!target.ok) return failure(target.error)
  // No plain retry here, unlike sendText: the edit target already shows
  // correctly rendered content, and re-sending the same string without
  // parse_mode would REPLACE it with literal tag soup. An entity-parse
  // reject therefore fails with instructions (the original message stays
  // intact), and an identical-content edit is a successful no-op — not a
  // reason to rewrite the message.
  try {
    await bot.api.editMessageText(target.id, messageId, message, { parse_mode: 'HTML' })
    return success(`Edited. message_id=${messageId} to=${target.id}${gate.note}`)
  } catch (err) {
    if (isNotModifiedError(err)) {
      return success(
        `Edit skipped — the message already has this exact content. message_id=${messageId} to=${target.id}`
      )
    }
    if (isHtmlParseError(err)) {
      return failure(
        `edit failed: Telegram rejected the HTML entities (${errMessage(err)}). The existing message was left unchanged — fix the markup and retry.`
      )
    }
    return failure(`edit failed: ${errMessage(err)}`)
  }
}

/** Telegram 400 "can't parse entities" — malformed HTML in the payload. */
function isHtmlParseError(err: unknown): boolean {
  return (
    err instanceof GrammyError &&
    err.error_code === 400 &&
    /can't parse entities/i.test(err.description)
  )
}

/** Telegram 400 for an edit whose text+entities match the current message. */
function isNotModifiedError(err: unknown): boolean {
  return (
    err instanceof GrammyError &&
    err.error_code === 400 &&
    /message is not modified/i.test(err.description)
  )
}

function resolveTarget(
  deps: ToolDeps,
  userIdArg: unknown
): { ok: true; id: number } | { ok: false; error: string } {
  const allowed = deps.getAllowedUserIds()
  if (allowed.size === 0) {
    return {
      ok: false,
      error: 'no allowed Telegram users configured — add user IDs in Settings → Telegram first'
    }
  }
  const requested = numberArg(userIdArg)
  const id = requested ?? allowed.values().next().value
  if (typeof id !== 'number') {
    return { ok: false, error: 'no target user id available' }
  }
  if (!allowed.has(id)) {
    return { ok: false, error: `user id ${id} is not in the allowed list` }
  }
  return { ok: true, id }
}

/**
 * Resolve a workspace-relative path to an absolute path on disk,
 * refusing absolute paths and `..` traversal so the LLM tool can only
 * read files inside ~/.wolffish/workspace. Returns null when the
 * path would escape the workspace.
 */
function resolveWorkspaceFilePath(relativePath: string): string | null {
  if (relativePath.includes('..')) return null
  if (path.isAbsolute(relativePath)) return null
  const root = workspaceRoot()
  const abs = path.resolve(root, relativePath)
  if (abs !== root && !abs.startsWith(root + path.sep)) return null
  return abs
}

function stringArg(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed.length > 0 ? value : null
}

function numberArg(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && /^-?\d+$/.test(value)) return Number(value)
  return null
}

// Models sometimes serialize booleans as strings — accept both spellings.
function boolArg(value: unknown): boolean {
  return value === true || value === 'true'
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function success(output: string): ToolExecutionResult {
  return { success: true, output }
}

function failure(error: string): ToolExecutionResult {
  return { success: false, error }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`
}

/**
 * Convert the inline parameter spec on each tool into the JSON Schema
 * shape thalamus expects when handing tools to the LLM. Mirrors what
 * cerebellum's disk-loaded plugins do at registration time.
 */
function toJsonSchema(parameters: SkillToolDescriptor['parameters']): {
  type: 'object'
  properties: Record<string, { type: string; description: string }>
  required: string[]
} {
  const properties: Record<string, { type: string; description: string }> = {}
  const required: string[] = []
  for (const [name, spec] of Object.entries(parameters)) {
    properties[name] = {
      type: spec.type ?? 'string',
      description: spec.description ?? ''
    }
    if (spec.required) required.push(name)
  }
  return { type: 'object', properties, required }
}
