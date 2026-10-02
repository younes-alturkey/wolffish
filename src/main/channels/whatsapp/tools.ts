import { MAX_CONSECUTIVE_REJECTS, RejectBudget } from '@main/channels/send-policy'
import { compressVideoToLimit } from '@main/channels/video-compress'
import { validateWhatsAppFormat } from '@main/channels/whatsapp/format'
import { GIF_PLAYBACK_MAX_SECONDS, isGifMime, transcodeGifToMp4 } from '@main/channels/whatsapp/gif'
import type {
  Capability,
  SkillToolDescriptor,
  ToolExecutionResult,
  WolffishPlugin
} from '@main/runtime/cerebellum'
import { workspaceRoot } from '@main/workspace/workspace'
import type { WASocket } from '@whiskeysockets/baileys'
import type { Stats } from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

export const WHATSAPP_CAPABILITY_NAME = 'whatsapp'

/**
 * One message captured in the channel's per-chat read buffer (see
 * WhatsAppChannel.readMessages). This is what whatsapp_read formats and
 * returns — a lightweight view of an observed message, not the raw proto.
 */
export type WhatsAppBufferedMessage = {
  id: string
  /** Chat JID this message belongs to. */
  jid: string
  /** True when the message was sent by the linked account (the user/wolffish). */
  fromMe: boolean
  /** Display sender — "me", a push name + phone, or a bare phone/JID. */
  sender: string
  /** Extracted text body, or a `<media:…>` placeholder for non-text content. */
  text: string
  /** Unix epoch milliseconds. */
  timestamp: number
}

type ToolDeps = {
  getSocket: () => WASocket | null
  trackSentId: (id: string) => void
  /**
   * Return up to `count` of the most recent messages observed in `jid`,
   * oldest first. Backed by the channel's in-memory rolling buffer, so it
   * only covers traffic seen since wolffish connected.
   */
  readMessages: (jid: string, count: number) => WhatsAppBufferedMessage[]
  /**
   * Make the bundled ffmpeg available (self-installs on first use), used to
   * transcode GIFs to the mp4/gifPlayback form WhatsApp actually delivers.
   * Idempotent and cheap after the first call; a no-op if unset.
   */
  ensureFfmpeg?: () => Promise<unknown>
  /**
   * Default recipient (the first allowed number's JID) for tools that make
   * `jid` optional — mirrors the Telegram tools' default-user behavior and
   * lets framework fallbacks (a video task landing after its turn died)
   * deliver without a reverse chat-binding lookup.
   */
  defaultJid?: () => Promise<string | null>
  /**
   * Wait for WhatsApp's SERVER_ACK on a sent message id — 'acked' when the
   * server confirmed receipt, 'error' when the send was rejected, 'timeout'
   * when no ack arrived in time. Lets a send report honestly instead of
   * trusting the locally-minted id sendMessage() resolves with.
   */
  confirmDelivery?: (id: string) => Promise<'acked' | 'error' | 'timeout'>
  /**
   * Point `jid`'s chat at the conversation this turn belongs to, so the user's
   * reply lands in the conversation that messaged them. The channel owns it —
   * resolving the outbound JID to the key the inbound path uses needs the
   * socket. A no-op when the chat is already bound there.
   */
  bindChatToSendingConversation?: (jid: string) => Promise<void>
}

/**
 * Tools whose delivery invites a reply, so the recipient's chat should be
 * pointed at the conversation that sent it. Excludes the read-only lookups,
 * and two deliberate omissions: `whatsapp_react` (an emoji is not a message
 * anyone replies to) and `whatsapp_check_format` (sends nothing).
 */
const BINDS_CHAT = new Set([
  'whatsapp_send',
  'whatsapp_send_image',
  'whatsapp_send_video',
  'whatsapp_send_document',
  'whatsapp_send_audio',
  'whatsapp_reply'
])

// WhatsApp practical upload ceilings. Images/audio are sent inline; documents
// can be much larger. These are guards so we fail fast with a clear message
// instead of choking the socket.
const MAX_IMAGE_BYTES = 16 * 1024 * 1024
const MAX_AUDIO_BYTES = 16 * 1024 * 1024
const MAX_DOCUMENT_BYTES = 100 * 1024 * 1024
/**
 * Inline WhatsApp video degrades past ~16 MB; larger files are auto
 * re-encoded to fit (video-compress.ts), falling back to a document send.
 * The load cap is therefore the document ceiling, not the inline one.
 */
const MAX_VIDEO_INLINE_BYTES = 16 * 1024 * 1024

const IMAGE_MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.tiff': 'image/tiff',
  '.tif': 'image/tiff'
}

const AUDIO_MIME: Record<string, string> = {
  '.ogg': 'audio/ogg; codecs=opus',
  '.oga': 'audio/ogg; codecs=opus',
  '.opus': 'audio/ogg; codecs=opus',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.flac': 'audio/flac',
  '.webm': 'audio/webm'
}

const DOCUMENT_MIME: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.ppt': 'application/vnd.ms-powerpoint',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.csv': 'text/csv',
  '.txt': 'text/plain',
  '.json': 'application/json',
  '.zip': 'application/zip'
}

/**
 * The model's override for the pre-send format gate: information, not
 * force. A formatting reject names the problems; if the flagged markup is
 * the CONTENT (code being shown, not formatting), the model asserts that
 * and the text goes out exactly as written.
 */
const SEND_AS_IS_PARAM = {
  type: 'boolean',
  description:
    'Set true ONLY when this exact text was just rejected by the formatting check and the flagged markup is INTENTIONAL content (you are showing code/markup as literal text, not formatting). Skips the format check: the text goes out exactly as written — the recipient may see raw tags/entities. NEVER use it to avoid fixing a real formatting mistake.',
  required: false
}

export function buildWhatsAppCapability(deps: ToolDeps): {
  capability: Capability
  plugin: WolffishPlugin
} {
  const tools: SkillToolDescriptor[] = [
    {
      name: 'whatsapp_check_format',
      description:
        'Check a message for markup WhatsApp would show as raw, ugly text WITHOUT sending it. Returns "clean" or the exact problems: HTML tags/entities (<b>, &amp;, &lt; — WhatsApp renders NO HTML, they arrive as literal text) and leaked Markdown (**double asterisks**, # headings, [text](url) links, | tables |, --- rules, ```lang fences). The send tools REFUSE HTML and Markdown outright, so fixing it here saves the bounced send. Content inside `backticks` or ``` fences is exempt — that is how you show markup on purpose. It changes nothing — you fix your own text and re-check. Call this before whatsapp_send / whatsapp_reply whenever your message has any formatting. WhatsApp\'s real syntax is single-char: *bold* _italic_ ~strike~ `code`.',
      parameters: {
        message: {
          type: 'string',
          description: 'The exact message (or caption) text you intend to send.',
          required: true
        }
      }
    },
    {
      name: 'whatsapp_check',
      description:
        'Look up whether one or more phone numbers are registered on WhatsApp and resolve them to the canonical JID to send to. Pass numbers in international format, with or without a leading "+" (e.g. "+966505349989"); separate multiple numbers with commas. Always run this before messaging a number you have not messaged before, then use the returned JID with the other whatsapp_* tools — do not hand-build the JID yourself.',
      parameters: {
        number: {
          type: 'string',
          description:
            'One phone number in international format (e.g. "+966505349989"), or several separated by commas.',
          required: true
        }
      }
    },
    {
      name: 'whatsapp_send',
      description:
        'Send a plain text message to a WhatsApp JID. Use the full JID format: <phone>@s.whatsapp.net for individuals, <id>@g.us for groups. If you only have a phone number, resolve it with whatsapp_check first. Returns the message ID on success.',
      parameters: {
        jid: {
          type: 'string',
          description:
            'The recipient JID — e.g. "966505349989@s.whatsapp.net" for a person or "120363012345@g.us" for a group.',
          required: true
        },
        message: {
          type: 'string',
          description:
            'The message body, delivered VERBATIM — nothing converts it. WhatsApp formatting only: *bold* (single asterisks), _italic_, ~strikethrough~, `inline code`, ```monospace```, "- " bullets, "1. " numbered items, "> " quotes. NEVER Markdown (no **double asterisks**, no # headings, no | tables |, no [text](url), no --- rules) — leaked Markdown reaches the recipient as raw syntax. NEVER HTML: WhatsApp renders no tags and no entities, so "<b>hi</b>" and "&amp;" arrive as literal text — write plain & < > characters and WhatsApp markup, never Telegram-style HTML. A message with HTML or Markdown is rejected without sending (rewrite it in WhatsApp formatting and resend). Instead of a table write one "*Label:* value" line per fact; paste links as bare URLs. If the message has ANY formatting, run whatsapp_check_format on it first. GOOD: "*Order arrived* 🍽\\nTotal: _53 SAR_". BAD: "**Order arrived**\\n| item | price |" (Markdown bold + table), "<b>Order arrived</b>" (HTML — arrives as literal text), "━━━━━━━━━━" (divider-bar line — wraps into broken bars on a phone; separate sections with a blank line, not a drawn rule).',
          required: true
        },
        sendAsIs: SEND_AS_IS_PARAM
      }
    },
    {
      name: 'whatsapp_send_image',
      description:
        'Send an image to a WhatsApp JID. PREFERRED: pass "path" — a workspace-relative path to the image file (e.g. "uploads/memes/foo.png" or a "wolffish-media://…" URL from a tool result). Never read a file and base64-encode it yourself just to send it — pass the path and WhatsApp reads it directly. Only use "imageBase64" for image bytes you generated in memory and never wrote to disk. Returns the message ID.',
      parameters: {
        jid: {
          type: 'string',
          description: 'The recipient JID.',
          required: true
        },
        path: {
          type: 'string',
          description:
            'Workspace-relative path (or wolffish-media:// URL) to the image file. Preferred over imageBase64.',
          required: false
        },
        imageBase64: {
          type: 'string',
          description:
            'Base64-encoded image data. Only for in-memory bytes — if the image is a file on disk, use "path" instead.',
          required: false
        },
        caption: {
          type: 'string',
          description:
            'Optional caption shown beneath the image, delivered VERBATIM. WhatsApp formatting only (*bold*, _italic_) — never Markdown (no **double asterisks**, no [text](url)) and never HTML tags/entities (they arrive as literal text; a caption with HTML or Markdown is rejected without sending). If the caption has any formatting, run whatsapp_check_format on it first.',
          required: false
        },
        sendAsIs: SEND_AS_IS_PARAM,
        mimetype: {
          type: 'string',
          description:
            'MIME type of the image. Inferred from the file extension when "path" is used.',
          required: false
        }
      }
    },
    {
      name: 'whatsapp_send_video',
      description:
        'Send a video to a WhatsApp JID. PREFERRED: pass "path" — a workspace-relative path to the video file (e.g. "generations/video/conv-x/video-123.mp4"). Videos over 16 MB are automatically compressed to fit WhatsApp inline playback (the original file keeps full quality; the result notes when compression happened); if compression cannot fit it, the video is delivered as a document instead. Returns the message ID.',
      parameters: {
        jid: {
          type: 'string',
          description:
            'The recipient JID. Optional — defaults to the first allowed number (the primary user).',
          required: false
        },
        path: {
          type: 'string',
          description:
            'Workspace-relative path (or wolffish-media:// URL) to the video file. Preferred over videoBase64.',
          required: false
        },
        videoBase64: {
          type: 'string',
          description:
            'Base64-encoded video data. Only for in-memory bytes — if the video is a file on disk, use "path" instead.',
          required: false
        },
        caption: {
          type: 'string',
          description:
            'Optional caption shown beneath the video, delivered VERBATIM. WhatsApp formatting only (*bold*, _italic_) — never Markdown and never HTML (they arrive as literal text; a caption with either is rejected without sending). If the caption has any formatting, run whatsapp_check_format on it first.',
          required: false
        },
        sendAsIs: SEND_AS_IS_PARAM,
        mimetype: {
          type: 'string',
          description:
            'MIME type of the video. Inferred from the file extension when "path" is used.',
          required: false
        }
      }
    },
    {
      name: 'whatsapp_send_document',
      description:
        'Send a file/document to a WhatsApp JID. PREFERRED: pass "path" — a workspace-relative path to the file (e.g. "files/report.pdf"). Never base64-encode a file on disk just to send it — pass the path. Only use "documentBase64" for bytes you generated in memory. Returns the message ID.',
      parameters: {
        jid: {
          type: 'string',
          description: 'The recipient JID.',
          required: true
        },
        path: {
          type: 'string',
          description:
            'Workspace-relative path (or wolffish-media:// URL) to the file. Preferred over documentBase64.',
          required: false
        },
        documentBase64: {
          type: 'string',
          description:
            'Base64-encoded file data. Only for in-memory bytes — if the file is on disk, use "path" instead.',
          required: false
        },
        fileName: {
          type: 'string',
          description:
            'The filename shown to the recipient. Defaults to the basename of "path" when provided.',
          required: false
        },
        caption: {
          type: 'string',
          description:
            'Optional caption, delivered VERBATIM. WhatsApp formatting only (*bold*, _italic_) — never Markdown (no **double asterisks**, no [text](url)) and never HTML tags/entities (they arrive as literal text; a caption with HTML or Markdown is rejected without sending). If the caption has any formatting, run whatsapp_check_format on it first.',
          required: false
        },
        sendAsIs: SEND_AS_IS_PARAM,
        mimetype: {
          type: 'string',
          description:
            'MIME type of the document. Inferred from the file extension when "path" is used.',
          required: false
        }
      }
    },
    {
      name: 'whatsapp_send_audio',
      description:
        'Send a voice note (push-to-talk audio) to a WhatsApp JID. PREFERRED: pass "path" — a workspace-relative path to the audio file. Never base64-encode a file on disk just to send it — pass the path. Only use "audioBase64" for bytes you generated in memory. Always sent as PTT (voice note); a WhatsApp PTT voice note ONLY plays as OGG/Opus (audio/ogg; codecs=opus) — MP3/WAV/M4A sent this way will not play inline. DEFAULT to OGG/Opus for anything meant to play in WhatsApp: if your audio is MP3/WAV, transcode it first with the managed ffmpeg (~/.wolffish/bin/ffmpeg/ffmpeg -i in.mp3 -c:a libopus -b:a 24k out.ogg — or -i in.wav) and pass the .ogg path. Only pass MP3 as-is when the user explicitly needs or asks for an MP3 (a file they want to save, not a voice note). Returns the message ID.',
      parameters: {
        jid: {
          type: 'string',
          description: 'The recipient JID.',
          required: true
        },
        path: {
          type: 'string',
          description:
            'Workspace-relative path (or wolffish-media:// URL) to the audio file. Preferred over audioBase64.',
          required: false
        },
        audioBase64: {
          type: 'string',
          description:
            'Base64-encoded audio data (OGG/Opus preferred). Only for in-memory bytes — if the audio is on disk, use "path" instead.',
          required: false
        },
        mimetype: {
          type: 'string',
          description:
            'MIME type of the audio. Inferred from the file extension when "path" is used (default: audio/ogg; codecs=opus).',
          required: false
        }
      }
    },
    {
      name: 'whatsapp_reply',
      description:
        'Reply to a specific WhatsApp message. The reply appears as a quote-reply in the chat. Returns the message ID.',
      parameters: {
        jid: {
          type: 'string',
          description: 'The chat JID where the original message lives.',
          required: true
        },
        quotedMessageId: {
          type: 'string',
          description: 'The message ID of the message to reply to.',
          required: true
        },
        message: {
          type: 'string',
          description:
            'The reply text, delivered VERBATIM — nothing converts it. WhatsApp formatting only (*bold*, _italic_, `inline code`, "- " bullets) — never Markdown (no **double asterisks**, no [text](url)) and never HTML tags/entities (WhatsApp renders no HTML; they arrive as literal text). A reply with HTML or Markdown is rejected without sending — rewrite it in WhatsApp formatting and resend. Run whatsapp_check_format first if the text has any formatting.',
          required: true
        },
        sendAsIs: SEND_AS_IS_PARAM
      }
    },
    {
      name: 'whatsapp_react',
      description: 'React to a WhatsApp message with an emoji.',
      parameters: {
        jid: {
          type: 'string',
          description: 'The chat JID where the message lives.',
          required: true
        },
        messageId: {
          type: 'string',
          description: 'The message ID to react to.',
          required: true
        },
        emoji: {
          type: 'string',
          description: 'The reaction emoji (e.g. "👍", "❤️").',
          required: true
        }
      }
    },
    {
      name: 'whatsapp_list_groups',
      description:
        'List every WhatsApp group you are a member of, with each group\'s name, member count, and JID (…@g.us). Use this to discover a group\'s JID before sending to it — you cannot enumerate groups any other way. Optionally pass "query" to filter by name (case-insensitive substring).',
      parameters: {
        query: {
          type: 'string',
          description:
            'Optional case-insensitive substring to filter group names (e.g. "family"). Omit to list all groups.',
          required: false
        }
      }
    },
    {
      name: 'whatsapp_group_info',
      description:
        "Get full details for one WhatsApp group: name, description, settings, and the participant list with each member's phone number, name, and admin role. Use this to look up the phone numbers / JIDs of people in a group. Get the group JID from whatsapp_list_groups first.",
      parameters: {
        jid: {
          type: 'string',
          description: 'The group JID, ending in @g.us (e.g. "120363012345@g.us").',
          required: true
        },
        includeParticipants: {
          type: 'boolean',
          description:
            'Whether to include the full member list (default true). Set false for just the group summary on large groups.',
          required: false
        }
      }
    },
    {
      name: 'whatsapp_group_invite',
      description:
        'Get the shareable invite link for a WhatsApp group. You must be an admin of the group. Returns a https://chat.whatsapp.com/… link.',
      parameters: {
        jid: {
          type: 'string',
          description: 'The group JID, ending in @g.us.',
          required: true
        }
      }
    },
    {
      name: 'whatsapp_profile',
      description:
        'Look up public profile info for a WhatsApp contact or group: profile picture URL, the "about"/status text, and — for business accounts — the business profile (description, category, email, website, address, hours). Pass a JID (resolve a phone number with whatsapp_check first). Fields the user has hidden from non-contacts come back empty.',
      parameters: {
        jid: {
          type: 'string',
          description:
            'The JID to look up — <phone>@s.whatsapp.net for a person or <id>@g.us for a group.',
          required: true
        }
      }
    },
    {
      name: 'whatsapp_read',
      description:
        'Read the most recent messages observed in a WhatsApp chat — a contact DM or a group — returned oldest-first. IMPORTANT: this only covers messages received or sent while wolffish has been connected; it CANNOT fetch older history from before wolffish started and is not a full transcript. Resolve the JID first: use whatsapp_list_groups for a group JID (…@g.us) or whatsapp_check to turn a phone number into a contact JID (…@s.whatsapp.net), then pass that JID here. If no messages for the chat have been seen yet, it says so.',
      parameters: {
        jid: {
          type: 'string',
          description:
            'The chat JID to read — <phone>@s.whatsapp.net for a contact or <id>@g.us for a group.',
          required: true
        },
        count: {
          type: 'number',
          description: 'How many of the most recent messages to return (default 10, max 50).',
          required: false
        }
      }
    }
  ]

  const capability: Capability = {
    name: WHATSAPP_CAPABILITY_NAME,
    dir: '<in-process>',
    description:
      "WhatsApp messaging via Baileys (Web client). Look up any phone number to confirm it is on WhatsApp and resolve its JID, list the groups you belong to and inspect a group's members, settings, and invite link, read a contact's profile picture and status, and read the most recent messages observed in a chat (whatsapp_read — live traffic only, no pre-connect history) — then send text, images, documents, and voice notes (by file path, no manual base64 needed), reply to messages, and react. Works for any WhatsApp contact or group, not just people who have messaged first.",
    triggers: {
      keywords: [
        'whatsapp',
        'wa',
        'send whatsapp',
        'message on whatsapp',
        'whatsapp group',
        'group id',
        'group jid'
      ]
    },
    tools,
    body: '',
    hasPlugin: true,
    status: 'ok',
    requires: [],
    packages: {},
    npmDependencies: {}
  }

  const plugin: WolffishPlugin = {
    name: WHATSAPP_CAPABILITY_NAME,
    tools: tools.map((t) => ({
      name: t.name,
      description: t.description,
      parameters: toJsonSchema(t.parameters)
    })),
    execute: async (toolName, args) => {
      // Pure validation — no socket needed, so it works on overlay-less
      // turns (heartbeat/procedure/workflow) exactly when it's most needed.
      if (toolName === 'whatsapp_check_format') return checkFormat(args)

      const sock = deps.getSocket()
      if (!sock) return failure('WhatsApp is not connected')

      const track = deps.trackSentId
      const confirm = deps.confirmDelivery
      const dispatch = async (): Promise<ToolExecutionResult> => {
        switch (toolName) {
          case 'whatsapp_check':
            return checkNumbers(sock, args)
          case 'whatsapp_send':
            return sendText(sock, args, track, confirm)
          case 'whatsapp_send_image':
            return sendImage(sock, args, track, confirm, deps.ensureFfmpeg)
          case 'whatsapp_send_video':
            return sendVideo(sock, args, track, confirm, deps.ensureFfmpeg, deps.defaultJid)
          case 'whatsapp_send_document':
            return sendDocument(sock, args, track, confirm)
          case 'whatsapp_send_audio':
            return sendAudio(sock, args, track, confirm)
          case 'whatsapp_reply':
            return replyTo(sock, args, track, confirm)
          case 'whatsapp_react':
            return reactTo(sock, args)
          case 'whatsapp_list_groups':
            return listGroups(sock, args)
          case 'whatsapp_group_info':
            return groupInfo(sock, args)
          case 'whatsapp_group_invite':
            return groupInvite(sock, args)
          case 'whatsapp_profile':
            return getProfile(sock, args)
          case 'whatsapp_read':
            return readChat(args, deps.readMessages)
          default:
            return failure(`unknown whatsapp tool: ${toolName}`)
        }
      }

      const result = await dispatch()

      // A delivered message is an invitation to reply, so hand the chat to the
      // conversation that sent it — the user answering on their phone should
      // continue THIS conversation, not whatever the chat was last left on.
      // Only after a real delivery: binding on a failed send would silently
      // reroute the user's next (unrelated) message for a note they never got.
      if (result.success && BINDS_CHAT.has(toolName)) {
        const jid = stringArg(args.jid)
        // Best-effort — a message already reached the user; a bookkeeping
        // failure must not turn a delivered send into a reported failure.
        if (jid) await deps.bindChatToSendingConversation?.(jid).catch(() => undefined)
      }
      return result
    }
  }

  return { capability, plugin }
}

function checkFormat(args: Record<string, unknown>): ToolExecutionResult {
  const message = stringArg(args.message)
  if (!message) return failure('message is required')
  const { ok, issues } = validateWhatsAppFormat(message)
  if (ok) {
    return success('Clean — safe to send with whatsapp_send / whatsapp_reply.')
  }
  return success(
    `NOT CLEAN — fix these so the message reads right (WhatsApp renders NO HTML, so tags/entities arrive as literal "<b>" / "&amp;" text; leaked Markdown shows raw symbols — the send tools REFUSE both until fixed). Fix, then re-check before sending:\n- ${issues.join('\n- ')}`
  )
}

/**
 * Pre-send gate shared by whatsapp_send / whatsapp_reply / captions: the
 * same engine as whatsapp_check_format, run unconditionally because the
 * model can (and does) skip the check tool. Hard issues — HTML tags or
 * entities (WhatsApp parses no HTML, so they arrive as literal text) AND
 * leaked Markdown (WhatsApp renders none, so the raw symbols arrive) —
 * refuse the send with a teaching error. Text that legitimately QUOTES
 * markup still delivers: code spans are masked by the validator, and
 * sendAsIs is the model's deliberate override for everything else. Soft
 * issues (cosmetic-only) come back as a note. The "invalid argument"
 * prefix is load-bearing: motor's classifyError maps it to
 * validation/non-retryable, so the model sees the reject immediately
 * instead of motor retrying identical args.
 */
function formatGate(
  text: string,
  what: 'message' | 'caption'
): { reject: ToolExecutionResult | null; note: string } {
  const report = validateWhatsAppFormat(text)
  if (report.hard.length > 0) {
    return {
      reject: failure(
        `invalid argument — NOT sent, the ${what} would reach the recipient as broken-looking text or raw markup symbols:\n- ${report.hard.join(
          '\n- '
        )}\nRewrite it in WhatsApp formatting and resend (whatsapp_check_format verifies without sending). If the flagged markup is INTENTIONAL content — you are showing code/markup as text — resend the exact same text with sendAsIs: true and it goes out exactly as written.`
      ),
      note: ''
    }
  }
  const note =
    report.soft.length > 0
      ? `\nFormatting note (already delivered — do NOT resend): ${report.soft.join(' ')}`
      : ''
  return { reject: null, note }
}

// Module-level so the budget survives socket reconnects / capability rebuilds.
const rejectBudget = new RejectBudget()

const DELIVERED_DESPITE_NOTE = `\nDelivered DESPITE unresolved formatting problems (the format gate yields after ${MAX_CONSECUTIVE_REJECTS} rejected attempts so a message is never lost) — the recipient may see raw markup; fix the pattern next time.`

/** Append a formatting note to a successful result; failures pass through. */
function withNote(result: ToolExecutionResult, note: string): ToolExecutionResult {
  if (!result.success || !note) return result
  return { ...result, output: `${result.output ?? ''}${note}` }
}

async function checkNumbers(
  sock: WASocket,
  args: Record<string, unknown>
): Promise<ToolExecutionResult> {
  const raw = stringArg(args.number)
  if (!raw) return failure('number is required')
  const numbers = raw
    .split(',')
    .map((n) => n.trim())
    .filter((n) => n.length > 0)
  if (numbers.length === 0) return failure('no valid number provided')
  try {
    const results = (await sock.onWhatsApp(...numbers)) ?? []
    const lines: string[] = []
    const matchedDigits = new Set<string>()
    for (const r of results) {
      const digits = r.jid.replace(/@.*/, '')
      matchedDigits.add(digits)
      lines.push(
        r.exists ? `✓ ${digits} → on WhatsApp, jid=${r.jid}` : `✗ ${digits} → not on WhatsApp`
      )
    }
    // Numbers WhatsApp returned nothing for are not registered. Both sides are
    // normalized to bare digits (input via the regex, JID via the @-strip), so
    // match by exact equality — a substring/endsWith test would wrongly clear
    // e.g. "100" against a returned "5100".
    for (const n of numbers) {
      const digits = n.replace(/[^0-9]/g, '')
      if (!matchedDigits.has(digits)) lines.push(`✗ ${n} → not registered on WhatsApp`)
    }
    return success(
      `Lookup results:\n${lines.join('\n')}\n\nUse the jid (…@s.whatsapp.net) with whatsapp_send / whatsapp_send_image / whatsapp_send_document.`
    )
  } catch (err) {
    return failure(`lookup failed: ${errMessage(err)}`)
  }
}

type ConfirmDelivery = (id: string) => Promise<'acked' | 'error' | 'timeout'>

/**
 * Turn a completed sock.sendMessage() into an honest tool result. sendMessage
 * resolves with a client-minted id the moment the message is queued locally —
 * that is NOT proof of delivery. When a confirmer is available we wait for
 * WhatsApp's SERVER_ACK and surface the truth: a real failure on an ERROR ack,
 * an explicit "unconfirmed" note on timeout, plain success on ack.
 */
async function finalizeSend(
  label: string,
  jid: string,
  result: { key: { id?: string | null } } | undefined,
  track: (id: string) => void,
  confirm?: ConfirmDelivery
): Promise<ToolExecutionResult> {
  const id = result?.key.id ?? undefined
  if (id) track(id)
  if (!id) {
    return success(`Sent ${label} to=${jid}, but WhatsApp returned no message id to confirm it.`)
  }
  const ack = confirm ? await confirm(id) : 'acked'
  if (ack === 'error') {
    return failure(
      `WhatsApp rejected the ${label} (server returned an ERROR ack). messageId=${id} to=${jid}`
    )
  }
  if (ack === 'timeout') {
    return success(
      `Sent ${label}, but UNCONFIRMED — WhatsApp gave no server ack in time, so it may not have gone through. Do not claim it was delivered without checking. messageId=${id} to=${jid}`
    )
  }
  return success(`Sent ${label}. messageId=${id} to=${jid}`)
}

async function sendText(
  sock: WASocket,
  args: Record<string, unknown>,
  track: (id: string) => void,
  confirm?: ConfirmDelivery
): Promise<ToolExecutionResult> {
  const jid = stringArg(args.jid)
  if (!jid) return failure('jid is required')
  const message = stringArg(args.message)
  if (!message) return failure('message is required')
  const gate = boolArg(args.sendAsIs)
    ? { reject: null, note: '\nFormat check skipped (sendAsIs) — delivered exactly as written.' }
    : formatGate(message, 'message')
  // The gate may bounce a broken message so the model can fix it, but it
  // can never LOSE one: once this chat's budget is exhausted the message
  // is delivered as composed.
  let despite = ''
  if (gate.reject) {
    if (!rejectBudget.exhausted(jid)) {
      rejectBudget.reject(jid)
      return gate.reject
    }
    despite = DELIVERED_DESPITE_NOTE
  }
  try {
    // Sent VERBATIM — the tool description carries the formatting
    // contract; nothing rewrites the model's text on the way out.
    const result = await sock.sendMessage(jid, { text: message })
    const final = withNote(
      await finalizeSend('message', jid, result, track, confirm),
      despite || gate.note
    )
    if (final.success) rejectBudget.delivered(jid)
    return final
  } catch (err) {
    return failure(`send failed: ${errMessage(err)}`)
  }
}

async function sendImage(
  sock: WASocket,
  args: Record<string, unknown>,
  track: (id: string) => void,
  confirm?: ConfirmDelivery,
  ensureFfmpeg?: () => Promise<unknown>
): Promise<ToolExecutionResult> {
  const jid = stringArg(args.jid)
  if (!jid) return failure('jid is required')
  const media = await loadMedia(args, 'imageBase64', 'image')
  if ('error' in media) return failure(media.error)
  const caption = stringArg(args.caption) ?? undefined
  const gate =
    caption && !boolArg(args.sendAsIs)
      ? formatGate(caption, 'caption')
      : {
          reject: null,
          note: caption ? '\nFormat check skipped (sendAsIs) — caption delivered as written.' : ''
        }
  let despite = ''
  if (gate.reject) {
    if (!rejectBudget.exhausted(jid)) {
      rejectBudget.reject(jid)
      return gate.reject
    }
    despite = DELIVERED_DESPITE_NOTE
  }
  // An animated GIF cannot ride as an imageMessage — WhatsApp silently drops
  // it. Route it through the video/gifPlayback path so it actually delivers
  // and loops as a GIF on the recipient's phone.
  if (isGifMime(media.mimetype)) {
    const final = withNote(
      await sendGif(sock, jid, media, caption, track, confirm, ensureFfmpeg),
      despite || gate.note
    )
    if (final.success) rejectBudget.delivered(jid)
    return final
  }
  try {
    const result = await sock.sendMessage(jid, {
      image: media.buffer,
      caption,
      mimetype: media.mimetype
    })
    const final = withNote(
      await finalizeSend('image', jid, result, track, confirm),
      despite || gate.note
    )
    if (final.success) rejectBudget.delivered(jid)
    return final
  } catch (err) {
    return failure(`send image failed: ${errMessage(err)}`)
  }
}

async function sendVideo(
  sock: WASocket,
  args: Record<string, unknown>,
  track: (id: string) => void,
  confirm?: ConfirmDelivery,
  ensureFfmpeg?: () => Promise<unknown>,
  defaultJid?: () => Promise<string | null>
): Promise<ToolExecutionResult> {
  let jid = stringArg(args.jid)
  if (!jid && defaultJid) jid = await defaultJid().catch(() => null)
  if (!jid) return failure('jid is required (no default recipient is configured)')
  const media = await loadMedia(args, 'videoBase64', 'video')
  if ('error' in media) return failure(media.error)
  const caption = stringArg(args.caption) ?? undefined
  const gate =
    caption && !boolArg(args.sendAsIs)
      ? formatGate(caption, 'caption')
      : {
          reject: null,
          note: caption ? '\nFormat check skipped (sendAsIs) — caption delivered as written.' : ''
        }
  let despite = ''
  if (gate.reject) {
    if (!rejectBudget.exhausted(jid)) {
      rejectBudget.reject(jid)
      return gate.reject
    }
    despite = DELIVERED_DESPITE_NOTE
  }

  // Oversized for inline playback: re-encode to fit (the original file keeps
  // full quality); if even that fails, deliver as a document so the user
  // still receives it.
  let buffer = media.buffer
  let mimetype = media.mimetype
  let compressionNote = ''
  if (buffer.length > MAX_VIDEO_INLINE_BYTES) {
    await ensureFfmpeg?.()
    const compressed = await compressVideoToLimit(buffer, MAX_VIDEO_INLINE_BYTES - 512 * 1024)
    if ('error' in compressed) {
      try {
        const result = await sock.sendMessage(jid, {
          document: buffer,
          fileName: media.basename ?? 'video.mp4',
          mimetype,
          caption
        })
        const final = withNote(
          await finalizeSend('video', jid, result, track, confirm),
          `${despite || gate.note}\nDelivered as a document — too large for inline playback and compression failed (${compressed.error}). The original quality stays available in the app.`
        )
        if (final.success) rejectBudget.delivered(jid)
        return final
      } catch (err) {
        return failure(`send video failed: ${errMessage(err)}`)
      }
    }
    buffer = compressed.mp4
    mimetype = 'video/mp4'
    compressionNote = `\nCompressed for WhatsApp (${compressed.note}) — tell the user the original quality is available in the app.`
  }

  try {
    const result = await sock.sendMessage(jid, {
      video: buffer,
      caption,
      mimetype
    })
    const final = withNote(
      await finalizeSend('video', jid, result, track, confirm),
      (despite || gate.note) + compressionNote
    )
    if (final.success) rejectBudget.delivered(jid)
    return final
  } catch (err) {
    return failure(`send video failed: ${errMessage(err)}`)
  }
}

async function sendGif(
  sock: WASocket,
  jid: string,
  media: LoadedMedia,
  caption: string | undefined,
  track: (id: string) => void,
  confirm?: ConfirmDelivery,
  ensureFfmpeg?: () => Promise<unknown>
): Promise<ToolExecutionResult> {
  // Self-install the bundled ffmpeg if it isn't present yet, so the GIF plays
  // as a GIF instead of degrading to the document fallback below.
  await ensureFfmpeg?.()
  const converted = await transcodeGifToMp4(media.buffer)
  if ('error' in converted) {
    // ffmpeg unavailable or the encode failed. Deliver the original GIF as a
    // document so it still reaches the recipient (a raw .gif imageMessage would
    // silently drop); WhatsApp animates it when opened.
    try {
      const result = await sock.sendMessage(jid, {
        document: media.buffer,
        fileName: media.basename ?? 'animation.gif',
        caption,
        mimetype: 'image/gif'
      })
      return finalizeSend(
        `GIF as document (transcode unavailable: ${converted.error})`,
        jid,
        result,
        track,
        confirm
      )
    } catch (err) {
      return failure(`send gif failed: ${errMessage(err)}`)
    }
  }
  // Short clips loop as a GIF; longer ones go as a normal (scrubbable) video.
  const asGif = converted.durationSec <= GIF_PLAYBACK_MAX_SECONDS
  try {
    const result = await sock.sendMessage(jid, {
      video: converted.mp4,
      caption,
      gifPlayback: asGif,
      mimetype: 'video/mp4'
    })
    return finalizeSend(
      `${asGif ? 'GIF' : 'video'} (${converted.durationSec.toFixed(1)}s)`,
      jid,
      result,
      track,
      confirm
    )
  } catch (err) {
    return failure(`send gif failed: ${errMessage(err)}`)
  }
}

async function sendDocument(
  sock: WASocket,
  args: Record<string, unknown>,
  track: (id: string) => void,
  confirm?: ConfirmDelivery
): Promise<ToolExecutionResult> {
  const jid = stringArg(args.jid)
  if (!jid) return failure('jid is required')
  const media = await loadMedia(args, 'documentBase64', 'document')
  if ('error' in media) return failure(media.error)
  const fileName = stringArg(args.fileName) ?? media.basename ?? 'file'
  const caption = stringArg(args.caption) ?? undefined
  const gate =
    caption && !boolArg(args.sendAsIs)
      ? formatGate(caption, 'caption')
      : {
          reject: null,
          note: caption ? '\nFormat check skipped (sendAsIs) — caption delivered as written.' : ''
        }
  let despite = ''
  if (gate.reject) {
    if (!rejectBudget.exhausted(jid)) {
      rejectBudget.reject(jid)
      return gate.reject
    }
    despite = DELIVERED_DESPITE_NOTE
  }
  try {
    const result = await sock.sendMessage(jid, {
      document: media.buffer,
      fileName,
      caption,
      mimetype: media.mimetype
    })
    const final = withNote(
      await finalizeSend('document', jid, result, track, confirm),
      despite || gate.note
    )
    if (final.success) rejectBudget.delivered(jid)
    return final
  } catch (err) {
    return failure(`send document failed: ${errMessage(err)}`)
  }
}

async function sendAudio(
  sock: WASocket,
  args: Record<string, unknown>,
  track: (id: string) => void,
  confirm?: ConfirmDelivery
): Promise<ToolExecutionResult> {
  const jid = stringArg(args.jid)
  if (!jid) return failure('jid is required')
  const media = await loadMedia(args, 'audioBase64', 'audio')
  if ('error' in media) return failure(media.error)
  try {
    const result = await sock.sendMessage(jid, {
      audio: media.buffer,
      ptt: true,
      mimetype: media.mimetype
    })
    return finalizeSend('audio', jid, result, track, confirm)
  } catch (err) {
    return failure(`send audio failed: ${errMessage(err)}`)
  }
}

async function replyTo(
  sock: WASocket,
  args: Record<string, unknown>,
  track: (id: string) => void,
  confirm?: ConfirmDelivery
): Promise<ToolExecutionResult> {
  const jid = stringArg(args.jid)
  if (!jid) return failure('jid is required')
  const quotedId = stringArg(args.quotedMessageId)
  if (!quotedId) return failure('quotedMessageId is required')
  const message = stringArg(args.message)
  if (!message) return failure('message is required')
  const gate = boolArg(args.sendAsIs)
    ? { reject: null, note: '\nFormat check skipped (sendAsIs) — delivered exactly as written.' }
    : formatGate(message, 'message')
  let despite = ''
  if (gate.reject) {
    if (!rejectBudget.exhausted(jid)) {
      rejectBudget.reject(jid)
      return gate.reject
    }
    despite = DELIVERED_DESPITE_NOTE
  }
  try {
    const result = await sock.sendMessage(
      jid,
      { text: message },
      {
        quoted: {
          key: { remoteJid: jid, id: quotedId },
          message: { conversation: '' }
        }
      }
    )
    const final = withNote(
      await finalizeSend('reply', jid, result, track, confirm),
      despite || gate.note
    )
    if (final.success) rejectBudget.delivered(jid)
    return final
  } catch (err) {
    return failure(`reply failed: ${errMessage(err)}`)
  }
}

async function reactTo(
  sock: WASocket,
  args: Record<string, unknown>
): Promise<ToolExecutionResult> {
  const jid = stringArg(args.jid)
  if (!jid) return failure('jid is required')
  const messageId = stringArg(args.messageId)
  if (!messageId) return failure('messageId is required')
  const emoji = stringArg(args.emoji)
  if (!emoji) return failure('emoji is required')
  try {
    await sock.sendMessage(jid, {
      react: { text: emoji, key: { remoteJid: jid, id: messageId } }
    })
    return success(`Reacted with ${emoji} to message ${messageId}`)
  } catch (err) {
    return failure(`react failed: ${errMessage(err)}`)
  }
}

async function listGroups(
  sock: WASocket,
  args: Record<string, unknown>
): Promise<ToolExecutionResult> {
  const query = stringArg(args.query)?.toLowerCase() ?? null
  try {
    const all = await sock.groupFetchAllParticipating()
    let groups = Object.values(all)
    if (query) groups = groups.filter((g) => (g.subject ?? '').toLowerCase().includes(query))
    if (groups.length === 0) {
      return success(
        query
          ? `No groups match "${stringArg(args.query)}". (You may not be in a group with that name.)`
          : 'You are not a member of any WhatsApp groups.'
      )
    }
    groups.sort((a, b) => (a.subject ?? '').localeCompare(b.subject ?? ''))
    const lines = groups.map((g) => {
      const size = g.size ?? g.participants?.length ?? '?'
      const tag = g.isCommunity ? ' [community]' : ''
      return `• ${g.subject || '(no name)'}${tag} — ${size} members — jid=${g.id}`
    })
    return success(
      `${groups.length} group(s):\n${lines.join('\n')}\n\nUse a jid (…@g.us) with whatsapp_send, whatsapp_group_info, or whatsapp_group_invite.`
    )
  } catch (err) {
    return failure(`list groups failed: ${errMessage(err)}`)
  }
}

async function groupInfo(
  sock: WASocket,
  args: Record<string, unknown>
): Promise<ToolExecutionResult> {
  const jid = stringArg(args.jid)
  if (!jid) return failure('jid is required')
  const includeParticipants = args.includeParticipants !== false
  try {
    const meta = await sock.groupMetadata(jid)
    const lines: string[] = []
    lines.push(`Group: ${meta.subject || '(no name)'}`)
    lines.push(`jid: ${meta.id}`)
    if (meta.desc) lines.push(`description: ${meta.desc}`)
    lines.push(`members: ${meta.size ?? meta.participants?.length ?? 0}`)
    if (meta.owner) lines.push(`owner: ${meta.ownerPn ?? meta.owner}`)
    if (meta.creation) lines.push(`created: ${new Date(meta.creation * 1000).toISOString()}`)
    const settings: string[] = []
    if (meta.announce) settings.push('admins-only messages')
    if (meta.restrict) settings.push('admins-only settings')
    if (meta.joinApprovalMode) settings.push('join approval required')
    if (meta.isCommunity) settings.push('community')
    if (settings.length) lines.push(`settings: ${settings.join(', ')}`)
    if (includeParticipants && meta.participants?.length) {
      lines.push('', 'Participants:')
      for (const p of meta.participants) {
        const num = p.phoneNumber ?? p.id
        const name = p.name ?? p.notify ?? ''
        const role = p.isSuperAdmin ? ' (owner)' : p.isAdmin || p.admin ? ' (admin)' : ''
        lines.push(`  • ${num}${name ? ` — ${name}` : ''}${role}`)
      }
    }
    return success(lines.join('\n'))
  } catch (err) {
    return failure(
      `group info failed: ${errMessage(err)} (check that "${jid}" is a group jid ending in @g.us and that you are a member)`
    )
  }
}

async function groupInvite(
  sock: WASocket,
  args: Record<string, unknown>
): Promise<ToolExecutionResult> {
  const jid = stringArg(args.jid)
  if (!jid) return failure('jid is required')
  try {
    const code = await sock.groupInviteCode(jid)
    if (!code) return failure('no invite code returned — you must be an admin of the group')
    return success(`Invite link: https://chat.whatsapp.com/${code}`)
  } catch (err) {
    return failure(`get invite failed: ${errMessage(err)} (you must be an admin of the group)`)
  }
}

async function getProfile(
  sock: WASocket,
  args: Record<string, unknown>
): Promise<ToolExecutionResult> {
  const jid = stringArg(args.jid)
  if (!jid) return failure('jid is required')
  const lines: string[] = [`Profile for ${jid}:`]
  try {
    const pic = await sock.profilePictureUrl(jid, 'image')
    lines.push(pic ? `picture: ${pic}` : 'picture: (none or hidden)')
  } catch {
    lines.push('picture: (none or hidden)')
  }
  try {
    const statuses = await sock.fetchStatus(jid)
    const entry = statuses?.[0]?.status as { status?: string | null } | undefined
    const text = entry?.status ?? null
    lines.push(text ? `about: ${text}` : 'about: (none or hidden)')
  } catch {
    lines.push('about: (none or hidden)')
  }
  try {
    const biz = await sock.getBusinessProfile(jid)
    if (biz) {
      lines.push('', 'Business profile:')
      if (biz.description) lines.push(`  description: ${biz.description}`)
      if (biz.category) lines.push(`  category: ${biz.category}`)
      if (biz.email) lines.push(`  email: ${biz.email}`)
      const sites = (biz.website ?? []).filter(Boolean)
      if (sites.length) lines.push(`  website: ${sites.join(', ')}`)
      if (biz.address) lines.push(`  address: ${biz.address}`)
      const tz = biz.business_hours?.timezone
      if (tz) lines.push(`  hours timezone: ${tz}`)
    }
  } catch {
    // Not a business account, or hours/profile not shared — silently skip.
  }
  return success(lines.join('\n'))
}

function readChat(
  args: Record<string, unknown>,
  read: (jid: string, count: number) => WhatsAppBufferedMessage[]
): ToolExecutionResult {
  const jid = stringArg(args.jid)
  if (!jid) return failure('jid is required')
  let count = numberArg(args.count) ?? 10
  if (count < 1) count = 1
  if (count > 50) count = 50

  const messages = read(jid, count)
  if (messages.length === 0) {
    return success(
      `No messages seen for ${jid} yet. whatsapp_read only captures traffic received or sent while wolffish has been connected — there may simply be none since it started, or the JID may not match the chat. For a contact, resolve the number with whatsapp_check; for a group, get the JID from whatsapp_list_groups.`
    )
  }

  const lines = messages.map((m) => {
    const time = new Date(m.timestamp).toISOString().slice(0, 16).replace('T', ' ')
    const who = m.fromMe ? 'me' : m.sender
    return `[${time} UTC] ${who}: ${m.text}`
  })
  return success(
    `Last ${messages.length} message(s) in ${jid} (oldest first):\n${lines.join('\n')}`
  )
}

type MediaKind = 'image' | 'audio' | 'video' | 'document'
type LoadedMedia = { buffer: Buffer; mimetype: string; basename: string | null }

/**
 * Resolve a file argument (workspace-relative path, `wolffish-media://` URL,
 * `~`-prefixed path, or an absolute path that lives inside the workspace) into
 * a Buffer + mimetype. Falls back to a base64 string arg for bytes generated in
 * memory. This is the key fix for the freeze-on-send bug: the agent passes a
 * path and WhatsApp reads the file here, instead of base64-encoding a large
 * image into its own context just to hand it back as a tool argument.
 */
async function loadMedia(
  args: Record<string, unknown>,
  base64Key: string,
  kind: MediaKind
): Promise<LoadedMedia | { error: string }> {
  const explicitMime = stringArg(args.mimetype) ?? undefined

  const pathArg = stringArg(args.path)
  if (pathArg) {
    const abs = resolveWorkspaceMediaPath(pathArg)
    if (!abs) {
      return { error: `path must point inside the workspace (got "${pathArg}")` }
    }
    let stat: Stats
    try {
      stat = await fs.stat(abs)
    } catch {
      return { error: `file not found: ${pathArg}` }
    }
    if (!stat.isFile()) return { error: `not a file: ${pathArg}` }
    const cap =
      kind === 'document' || kind === 'video'
        ? MAX_DOCUMENT_BYTES
        : kind === 'audio'
          ? MAX_AUDIO_BYTES
          : MAX_IMAGE_BYTES
    if (stat.size > cap) {
      return {
        error: `file too large (${mb(stat.size)} MB); WhatsApp ${kind} max is ${mb(cap)} MB`
      }
    }
    const buffer = await fs.readFile(abs)
    const ext = path.extname(abs).toLowerCase()
    const mimetype = explicitMime ?? mimeFor(kind, ext)
    return { buffer, mimetype, basename: path.basename(abs) }
  }

  const b64 = stringArg(args[base64Key])
  if (b64) {
    const buffer = Buffer.from(b64, 'base64')
    if (buffer.length === 0) return { error: `${base64Key} did not decode to any data` }
    return { buffer, mimetype: explicitMime ?? mimeFor(kind, ''), basename: null }
  }

  return {
    error: `provide either "path" (workspace-relative, preferred) or "${base64Key}"`
  }
}

function resolveWorkspaceMediaPath(input: string): string | null {
  const root = workspaceRoot()
  let p = input.trim()
  if (p.startsWith('wolffish-media://')) p = p.slice('wolffish-media://'.length)
  if (p === '~') p = os.homedir()
  else if (p.startsWith('~/')) p = path.join(os.homedir(), p.slice(2))
  const abs = path.isAbsolute(p) ? path.resolve(p) : path.resolve(root, p)
  // Sandbox: the resolved path must stay within the workspace root.
  if (abs !== root && !abs.startsWith(root + path.sep)) return null
  return abs
}

const VIDEO_MIME: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.avi': 'video/x-msvideo',
  '.mkv': 'video/x-matroska',
  '.m4v': 'video/mp4',
  '.webm': 'video/webm'
}

function mimeFor(kind: MediaKind, ext: string): string {
  if (kind === 'image') return IMAGE_MIME[ext] ?? 'image/jpeg'
  if (kind === 'audio') return AUDIO_MIME[ext] ?? 'audio/ogg; codecs=opus'
  if (kind === 'video') return VIDEO_MIME[ext] ?? 'video/mp4'
  return DOCUMENT_MIME[ext] ?? 'application/octet-stream'
}

function mb(bytes: number): number {
  return Math.round((bytes / 1024 / 1024) * 10) / 10
}

// Models sometimes serialize booleans as strings — accept both spellings.
function boolArg(value: unknown): boolean {
  return value === true || value === 'true'
}

function stringArg(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed.length > 0 ? value : null
}

function numberArg(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && /^-?\d+$/.test(value.trim())) return Number(value.trim())
  return null
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
