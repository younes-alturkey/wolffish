import {
  createConversation,
  loadConversation,
  updateConversation,
  type ConversationChannel,
  type ConversationFile
} from '@main/conversations'
import { runDetached } from '@main/runtime/corpus'

/**
 * The minimal LLM surface the titler needs: a dedicated TITLING call — a
 * titling system prompt plus the user's message as the user turn (NOT a
 * summarize). `Thalamus.title` satisfies this: it calls the active model with
 * the system prompt and emits its spend as role:'title', so titling cost lands
 * on the ledger itemized as titling (not as summarization) and never feeds a
 * conversation's context meter.
 */
export interface TitlerLLM {
  title(userMessage: string, systemPrompt: string, signal?: AbortSignal): Promise<{ text: string }>
}

const TITLE_MAX_CHARS = 80

/**
 * Abort reason a caller passes to `AbortController.abort()` when its own
 * titling DEADLINE expired, as opposed to the turn being cancelled. The two
 * unwind through the identical throw, and they want opposite outcomes (see
 * `abortOutcome`), so the reason is the only thing that tells them apart.
 */
export const TITLE_DEADLINE_REASON = 'wolffish:title-deadline'

/**
 * What an aborted titling call yields.
 *
 * A DEADLINE is not a cancellation. The user still wants this conversation
 * named — the provider was merely too slow — so it degrades to the same plain
 * slice an unreachable provider gets. Returning '' here instead is what made
 * a slow title permanent: the caller writes nothing, and the 'Untitled' the
 * channel already persisted before the turn stays on disk forever, because a
 * one-shot conversation never gets the later turn that would re-title it.
 *
 * A genuine turn CANCEL still yields '': nobody is waiting on a title for a
 * turn that was abandoned, and writing a degraded one would permanently
 * suppress the real title the next turn produces.
 */
function abortOutcome(signal: AbortSignal, trimmed: string): string {
  return signal.reason === TITLE_DEADLINE_REASON ? fallbackTitle(trimmed) : ''
}

/** How many chars of the opening message the model sees — enough to grasp the topic. */
const TITLE_INPUT_MAX_CHARS = 2000

/**
 * The titling instructions live in the SYSTEM prompt (this is a titling call,
 * not a summarize): the model is told to NAME the conversation, and the user's
 * own message rides in the user turn. Criteria: based on the message, unique
 * and memorable, and neither too long nor too short.
 */
const TITLE_SYSTEM =
  `You generate the title for a conversation, shown in a sidebar list of chats. ` +
  `Read the user's opening message and write ONE title that:\n` +
  `- captures the specific topic or intent of that message — concrete, never generic\n` +
  `- is unique and memorable, not vague or interchangeable ` +
  `(avoid "General Question", "Help Request", "New Chat", "Assistance Needed")\n` +
  `- is neither too long nor too short: aim for 3 to 6 words, up to ~60 characters\n` +
  `- uses Title Case, with no surrounding quotes, no trailing punctuation, and no emoji\n` +
  `- is plain human text: never append tokenizer control tokens (no <| … |> markers) — ` +
  `the title is displayed to a person exactly as you write it\n` +
  `Reply with ONLY the title text — nothing else.`

/**
 * The title must reflect the user's OWN words, not the delivery metadata the
 * channels wrap around a turn. The composed history content the titler receives
 * can carry an `<attachments>` / `<video_instructions>` block (filename, mime,
 * size, absolute path — load-bearing for the agent's file tools) and a leading
 * `<voice_note …>` opener (carries the reply-language hint). Those are stripped
 * from the TITLE's copy ONLY — never from the history/wire content the model
 * sees, so file tools and reply-language behaviour are untouched. A caption-less
 * attachment strips to '' — on the channels that would otherwise strand it,
 * `mediaTitleSource` then names it from the filenames ALONE, never from the
 * mime/size/path this strips. Anchored to the exact sentinels so ordinary prose
 * containing `<` or `>` is left intact.
 */
function titleSource(message: string): string {
  return message
    .replace(/^\s*<voice_note\b[^>]*>/i, '')
    .replace(/<attachments>[\s\S]*?<\/attachments>/gi, '')
    .replace(/<video_instructions>[\s\S]*?<\/video_instructions>/gi, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * The attached filenames, in order, parsed out of the `<attachments>` block.
 * TWO producers must stay in step with this regex — main's
 * composeAttachmentContext() (uploads/compose-attachments.ts) and the
 * renderer's composeHistoryContent() (pages/Chat.tsx), byte-identical today.
 * If either changes shape, a caption-less turn quietly falls back to 'Untitled'
 * rather than misfiring. Matched against the line shape they emit —
 * `  - name.ext (type=…, mime=…, size=…b, path=…)` — and keyed on the ` (type=`
 * delimiter rather than the parens, so a filename that itself contains
 * parentheses ("report (final).pdf") survives intact.
 */
function attachmentNames(message: string): string[] {
  const block = /<attachments>([\s\S]*?)<\/attachments>/i.exec(message)
  if (!block) return []
  const names: string[] = []
  for (const line of block[1].split('\n')) {
    const m = /^\s*-\s+(.+?)\s+\(type=/.exec(line)
    if (m) names.push(m[1].trim())
  }
  return names
}

/**
 * A stand-in "message" for a caption-less media turn, so the model can still
 * NAME the conversation off what it was actually given — the filenames.
 *
 * Send someone a photo with no caption and the conversation is still about
 * something; titling it 'Untitled' threw away the one piece of signal present.
 * The filename is genuine user intent (`q3-budget-final.xlsx` says plenty), so
 * it goes to the model as ordinary prose and gets titled like any other
 * message. Deliberately excludes the mime/size/path from the block: those are
 * plumbing, they'd steer the title toward the metadata, and the sanitizer
 * exists precisely to keep them out.
 *
 * Doubles as a decent fallback string — if the provider is unreachable this is
 * what fallbackTitle() slices, and "Shared a file: photo.jpg" reads fine.
 */
function mediaTitleSource(message: string): string {
  const names = attachmentNames(message)
  if (names.length === 0) return ''
  if (names.length === 1) return `Shared a file: ${names[0]}`
  return `Shared ${names.length} files: ${names.join(', ')}`
}

/**
 * Whether a conversation on this channel can be stranded 'Untitled' FOREVER —
 * the only place naming a turn after its filenames is the right trade.
 *
 * These two channels write an 'Untitled' file to disk before the turn and are
 * typically one-shot: the chat rotates to a fresh conversation after
 * staleHours, so the later turn that would re-title never comes. Naming such a
 * conversation "Shared a file: invoice.pdf" beats leaving it nameless.
 *
 * Everywhere else the trade inverts, because the FIRST real title a
 * conversation gets is its last (ensureConversationTitle short-circuits on any
 * non-'Untitled' title). In-app, a caption-less paste is normally followed by
 * the actual question, and its filename is synthetic anyway
 * (`pasted-1752641234567.png`, `recording-…webm`) — so titling from it would
 * bury the real title under a machine name. Leaving those 'Untitled' for one
 * turn is strictly better, and they self-heal.
 *
 * Matches what the runtime shows: telegram and whatsapp stranded 21% and 11% of
 * their conversations; in-app, heartbeat and procedure stranded zero of 627.
 */
function canStrandUntitled(channel: ConversationChannel | undefined): boolean {
  return channel === 'telegram' || channel === 'whatsapp'
}

/**
 * What the model (or the offline slice) actually names the chat from: the
 * user's own words, or — only where 'Untitled' would otherwise be permanent —
 * the media they sent. Empty means nothing nameable was in the message.
 * The single source of truth for both titleFromMessage and offlineTitle, so
 * a live title and a backfilled one can't drift apart.
 */
function titleInput(userMessage: string, channel: ConversationChannel | undefined): string {
  return (
    titleSource(userMessage) || (canStrandUntitled(channel) ? mediaTitleSource(userMessage) : '')
  )
}

/**
 * Title a conversation from its first user message with a PURE LLM call to the
 * chosen model — no heuristics. The message is first reduced to the user's own
 * words via titleSource() (delivery markup is stripped so a caption-less media
 * turn doesn't get titled from `<attachments>` metadata). Falls back to a plain
 * trimmed slice only if the model is UNREACHABLE, so titling can never block a
 * turn. The single title() call is itself resilient — Thalamus retries it 5×
 * with escalating backoff (abort-aware) before it throws — so the titler adds no
 * retry loop of its own; a second layer would only compound latency on the
 * title-first critical path. Returns '' when the call was CANCELLED (a
 * same-conversation resend, a stopped turn) — a cancel is NOT unreachability,
 * so we must NOT persist a degraded fallback that would permanently suppress
 * the real title; the caller leaves the conversation 'Untitled' and a later
 * turn re-titles it. A caller's titling DEADLINE is the other way round — it
 * degrades to the slice, because the conversation it names may never get a
 * later turn (see abortOutcome). The call runs in a sealed background scope so
 * its usage event isn't relayed into any live turn's meter (the ledger still
 * records it).
 */
export async function titleFromMessage(
  userMessage: string,
  llm: TitlerLLM,
  signal?: AbortSignal,
  channel?: ConversationChannel
): Promise<string> {
  const trimmed = titleInput(userMessage, channel)
  if (!trimmed) return 'Untitled'
  if (signal?.aborted) return abortOutcome(signal, trimmed)
  try {
    const { text } = await runDetached(() =>
      llm.title(trimmed.slice(0, TITLE_INPUT_MAX_CHARS), TITLE_SYSTEM, signal)
    )
    return cleanTitle(text) || fallbackTitle(trimmed)
  } catch {
    // Abort takes the same throw path as a provider failure — tell them apart
    // so a CANCELLED titling never lands a raw-slice fallback on disk/in cache.
    // A deadline is not a cancel and does degrade to the slice: see abortOutcome.
    if (signal?.aborted) return abortOutcome(signal, trimmed)
    return fallbackTitle(trimmed)
  }
}

/**
 * The title a message degrades to with NO model involved — exactly what the
 * unreachable-provider and deadline paths produce, via the same sanitizer and
 * the same slice. 'Untitled' only for a message that carries neither words nor
 * media.
 *
 * Exists for the workspace backfill, which heals conversations the old build
 * stranded as 'Untitled' and cannot afford blocking LLM calls on the startup
 * path. Kept here, beside the rules it mirrors, so the two can't drift.
 */
export function offlineTitle(userMessage: string, channel?: ConversationChannel): string {
  const trimmed = titleInput(userMessage, channel)
  return trimmed ? fallbackTitle(trimmed) : 'Untitled'
}

/**
 * Ensure `conversationId` has a real (non-'Untitled') title, producing one via
 * the LLM and PERSISTING it if it doesn't yet — the caller runs this BEFORE
 * the turn processes, so the conversation is saved with its title first.
 *
 * Idempotent: a conversation already titled (a follow-up turn, a resumed chat)
 * returns its existing title with no LLM call. For an in-app conversation whose
 * file doesn't exist yet (the renderer persists only at end of turn), a titled
 * shell carrying the first user message is written now; the renderer's
 * end-of-turn save merges its messages in and keeps this title
 * (mergeConversationOnto prefers a real on-disk title over 'Untitled').
 *
 * Returns the resolved title, or undefined when there's nothing to title (no
 * conversation id / empty message) so the caller passes no title downstream.
 *
 * `userMessageId` is the sender's own id for the user message this turn
 * carries. The shell written below persists that SAME logical message, so it
 * must stamp that SAME id — the renderer's end-of-turn save then reconciles
 * with the shell by id (its bare-text copy wins) instead of the two copies
 * surviving as duplicates in the id-keyed merge.
 */
export async function ensureConversationTitle(
  conversationId: string | null,
  userMessage: string,
  channel: ConversationChannel | undefined,
  llm: TitlerLLM,
  signal?: AbortSignal,
  userMessageId?: string
): Promise<string | undefined> {
  const trimmed = userMessage.trim()
  if (!conversationId) {
    // No persisted conversation (a null-id / subagent turn) — a display title
    // only, no save.
    return trimmed ? titleFromMessage(trimmed, llm, signal, channel) : undefined
  }

  const existing = await loadConversation(conversationId).catch(() => null)
  if (existing?.title && existing.title !== 'Untitled') return existing.title
  if (!trimmed) return existing?.title ?? undefined

  const title = await titleFromMessage(trimmed, llm, signal, channel)
  // Aborted (empty) — leave the conversation Untitled and UNwritten so the
  // titledCache isn't poisoned; the next turn on this conversation re-titles.
  if (!title) return existing?.title ?? undefined

  await updateConversation(conversationId, (disk) => {
    if (disk) {
      // Another writer may have titled it while the LLM ran — keep theirs.
      if (disk.title && disk.title !== 'Untitled') return null
      disk.title = title
      return disk
    }
    // In-app first turn: no file yet. Write a titled shell carrying the user's
    // message so the conversation appears (correctly titled) immediately and
    // survives even if the turn is abandoned before the renderer's save. The
    // message carries the sender's id (see the doc above) so the sender's own
    // save reconciles with it by id. A caller that threads NO id gets a shell
    // with none — deliberately: an id the caller doesn't know can never match
    // its later save (a guaranteed duplicate under the id-keyed merge), while
    // an id-LESS shell pairs positionally, the exact pre-id semantics. A
    // shell stranded id-less (turn abandoned, never saved over) is minted an
    // id by the next launch's migration.
    const shell: ConversationFile = {
      ...createConversation(null),
      id: conversationId,
      title,
      messages: [
        {
          ...(userMessageId ? { id: userMessageId } : {}),
          role: 'user',
          content: trimmed,
          timestamp: Date.now()
        }
      ]
    }
    if (channel) shell.channel = channel
    return shell
  }).catch(() => undefined)

  return title
}

/** Strip the model's framing (quotes, "Title:", trailing punctuation, extra lines). */
function cleanTitle(raw: string): string {
  let t = raw.trim()
  t = t.split(/\r?\n/)[0].trim()
  t = t.replace(/^title\s*[:\-–—]\s*/i, '').trim()
  t = t.replace(/^["'`“”]+|["'`“”]+$/g, '').trim()
  t = t.replace(/[.!?,;:]+$/, '').trim()
  if (t.length > TITLE_MAX_CHARS) t = t.slice(0, TITLE_MAX_CHARS).trim()
  return t
}

/** Plain trimmed slice — the only fallback when the model is unreachable. */
function fallbackTitle(message: string): string {
  const t = message.replace(/\s+/g, ' ').trim().slice(0, TITLE_MAX_CHARS).trim()
  return t || 'Untitled'
}
