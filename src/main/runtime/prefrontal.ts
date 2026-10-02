import { diskWriter } from '@main/io/diskWriter'
import { deliveredFilesReminder } from '@main/runtime/agent/delivered-files'
import type { BasalGanglia } from '@main/runtime/basalganglia'
import type { Cerebellum } from '@main/runtime/cerebellum'
import { COMPACTION_THRESHOLD } from '@main/runtime/compactor'
import type { Corpus } from '@main/runtime/corpus'
import { Cortex } from '@main/runtime/cortex'
import type { Device } from '@main/runtime/device'
import type { Hippocampus } from '@main/runtime/hippocampus'
import { OFFLINE_NOTICE } from '@main/runtime/outbound'
import {
  clampAssemblyBudget,
  DEFAULT_BUDGET_TOKENS,
  RAS,
  type ContextCandidate,
  type ContextCategory,
  type ScoredCandidate
} from '@main/runtime/ras'
import { reasoningModesFor } from '@main/runtime/reasoning'
import { contextWindowForModel, type ToolDefinition } from '@main/runtime/thalamus'
import { cloudModelSupportsVision } from '@main/runtime/vision'
import { readConfig } from '@main/workspace/workspace'
import fs from 'node:fs/promises'
import path from 'node:path'

export type PrefrontalOptions = {
  workspaceRoot: string
  episodeWindowDays?: number
  feedbackWindowDays?: number
  getContextBudget?: () => number
  getContextWindow?: () => number
  cortex?: Cortex
  ras?: RAS
  cerebellum?: Cerebellum
  hippocampus?: Hippocampus
  basalganglia?: BasalGanglia
  corpus?: Corpus
  device?: Device
}

export type Approach = 'direct-answer' | 'use-tools' | 'multi-step-task' | 'clarify'

export type Plan = {
  approach: Approach
  rationale: string
  toolHints: string[]
}

export type ContextBundle = {
  systemPrompt: string
  estimatedTokens: number
  sectionsIncluded: string[]
}

export type RuntimeContext = {
  iteration: number
  toolsCalled: number
  /**
   * When false, the live iteration counters are omitted from the
   * `<runtime>` block so the system prompt stays byte-stable across
   * tool-loop iterations (the counters travel in the outbound volatile
   * tail instead — see formatRuntimeStatus). Defaults to true, which
   * preserves the legacy in-prompt rendering.
   */
  renderCounters?: boolean
  /**
   * File names already delivered to the user this turn (auto-attached by a
   * tool). Travels with the per-iteration counters — rendered in the volatile
   * tail (optimized) or the `<runtime>` block (legacy), both after every cache
   * breakpoint — so it reinforces "don't re-send an already-delivered file"
   * without landing inside the cached history. Reset each turn by the caller.
   */
  deliveredFiles?: string[]
  /**
   * Host connectivity, sampled per iteration (Electron net.isOnline()). When
   * false, an explicit OFFLINE_NOTICE is rendered so the model doesn't burn
   * iterations on tools that need the internet and leans on offline tools
   * (memory recall, files, shell) instead. Travels the same vehicle as the
   * counters — volatile tail (optimized) or `<runtime>` block (legacy) — so
   * the online→offline flip never perturbs a cached prompt prefix. Undefined
   * or true renders nothing: online is the silent default.
   */
  online?: boolean
  /**
   * Conversation-resumed notice — pre-rendered by formatLastMessageNotice
   * when the conversation's previous persisted message is old enough
   * (≥ RESUME_NOTICE_MIN_GAP_MS) that the model must be told time has
   * passed: relative gap ("about 3 weeks ago") plus the full timestamp.
   * Replayed history carries no timestamps, so without this a user
   * returning days or months later is answered as if mid-conversation.
   * Computed ONCE per turn (byte-stable across iterations) and travels
   * the same vehicle as the counters — volatile tail (optimized) or
   * `<runtime>` block (legacy). Undefined (active conversation, fresh or
   * conversation-less turn) renders nothing.
   */
  lastMessage?: string
  /**
   * No-progress notice for this iteration (the model has been re-issuing the
   * same tool call to no effect — see no-progress-guard). Purely informational;
   * the model decides what to do. Travels the same vehicle as the counters —
   * volatile tail (optimized) or `<runtime>` block (legacy), both after every
   * cache breakpoint — so its per-iteration appearance/change never perturbs a
   * cached prompt prefix. Undefined (the common case) renders nothing.
   */
  noProgress?: string
  /**
   * Channel-format notice for this iteration — a prose-mirroring channel
   * (Telegram/WhatsApp) reporting that a prose block ALREADY DELIVERED to
   * the user's phone carried raw markup (leaked Markdown, broken HTML), so
   * the model can repair the delivered message and write clean blocks for
   * the rest of the turn. Observe-and-notify: nothing rewrites model prose.
   * Same vehicle and cache rationale as noProgress. Undefined renders
   * nothing.
   */
  channelFormat?: string
  /**
   * Control-token notice for this iteration — this conversation's previous
   * model call ended its user-visible text in a literal tokenizer control
   * token (e.g. a plain-text `<|eos|>`), which reached the user as gibberish,
   * so the model can stop doing that and, if needed, clear it up.
   * Observe-and-notify: nothing rewrites model output. Same vehicle and
   * cache rationale as noProgress. Undefined renders nothing.
   */
  controlToken?: string
  /**
   * Async video-task landing notice — VideoTaskManager reporting that a
   * generation task reached a terminal state while the model was doing
   * other work (it moved on instead of calling video_await), so the model
   * can present the artifact or the failure. Drained once per iteration.
   * Same vehicle and cache rationale as noProgress. Undefined renders
   * nothing.
   */
  videoTasks?: string
  /**
   * Open task list notice — the conversation's latest todo list still has
   * unfinished items from an earlier turn (the turn that wrote it was
   * interrupted, or ended mid-work), so the model knows the checklist the
   * user is looking at and can carry it on: its next todo_write updates
   * that same card. Present on every iteration until the model writes the
   * list once this turn. Same vehicle and cache rationale as noProgress.
   * Undefined renders nothing.
   */
  openTodo?: string
  /**
   * Managed-process notice — one line naming what the process manager is
   * running or has seen crash, so the model knows before it starts a second
   * copy of a dev server or forgets that one died. Computed once per turn by
   * the Agent from the registry (no I/O). Same vehicle and cache rationale
   * as noProgress. Undefined renders nothing.
   */
  processes?: string
  /**
   * Checked-in calls notice — tool calls this conversation parked as still
   * running (runtime/check-in.ts), or that finished unread. One line naming
   * each with its handle and elapsed time, every iteration until the model
   * reads or stops them. Nothing ends them for it. Same vehicle and cache
   * rationale as noProgress. Undefined renders nothing.
   */
  checkIns?: string
  /**
   * Task-list notice — the list THIS turn wrote still has open items, so
   * the model is reminded, every iteration until it closes the list, that
   * the card the user watches must be rewritten as steps land and closed
   * before the final reply (see agent/todo-guard). Same vehicle and cache
   * rationale as noProgress. Undefined renders nothing.
   */
  taskList?: string
  /**
   * Voice-reply notice, present on every master/single turn while the Voice
   * replies preference is ON — the switch alone gates it (no per-turn voice
   * detection; the notice's wording is conditional, so it reads truthfully
   * on typed turns). The deterministic every-iteration restatement of "a
   * <voice_note> turn ends with one voice_respond". Computed once per turn
   * by the Agent (preference + capability + role gates live there); stable
   * across the turn's iterations, so it rides the same volatile vehicle as
   * noProgress with the same cache rationale. Undefined (setting off, TTS
   * disabled, agent role) renders nothing.
   */
  voiceReply?: string
  /**
   * Phone-notification notice, present on every master/single turn while a
   * phone is paired and notify_phone is registered (the mobile channel ties
   * that registration to paired + identified + user allows, so its presence
   * IS the availability check). Restates the agents.core.md cadence — end
   * the turn with one, interrupt mid-turn for a major beat — at the request's
   * most salient position, for the same reason the voice notice does.
   * Recomputed per iteration but changes at most once per turn (the moment
   * the first notification lands, it flips to "don't repeat it"), so it rides
   * the same volatile vehicle with the same cache rationale as noProgress.
   * Undefined (no phone, capability disabled, agent role) renders nothing.
   */
  phoneNotify?: string
  /**
   * Screen-indicator notice — present on every iteration from the moment the
   * turn raises the computer-use glow ("Wolffish is capturing your screen")
   * until it lowers it. The user's display is making a claim only
   * computer_glow_off retracts, so the rule rides at the request's most
   * salient position rather than relying on the tool description alone. Same
   * vehicle and cache rationale as noProgress; it changes at most twice per
   * turn (on, then off). Undefined — every turn that never touches the
   * screen — renders nothing. See agent/screen-indicator-guard.
   */
  screenIndicator?: string
  /**
   * Mid-turn user-message notice — set for the ONE iteration that delivers
   * an interjection (a message the user sent while this turn was running,
   * now the most recent user text in history). Tells the model to read it
   * before its next step and to acknowledge it. Same vehicle and cache
   * rationale as noProgress. Undefined renders nothing. See
   * agent/interjection.ts.
   */
  interjection?: string
  /**
   * Closing-message notice — the turn already wrote its wrap-up and closed it
   * with a turn-closing tool (`notify_phone`, `voice_respond`, `send_file`), so
   * a reply now would be the same news twice. Present for exactly one call per
   * turn (the notice is spent when drained), on a call the model was making
   * anyway — it never buys a model request. Same volatile vehicle and cache
   * rationale as noProgress. Undefined renders nothing. See
   * agent/closing-guard.ts.
   */
  closing?: string
}

const ALWAYS_INCLUDED: Array<{ category: ContextCategory; rel: string; tag: string }> = [
  { category: 'identity', rel: 'brain/identity/soul.md', tag: 'soul' },
  { category: 'identity', rel: 'brain/identity/user.md', tag: 'user' },
  { category: 'prefrontal', rel: 'brain/prefrontal/agents.core.md', tag: 'agents-core' },
  { category: 'prefrontal', rel: 'brain/prefrontal/agents.md', tag: 'agents' }
]

const SECTION_ORDER: ContextCategory[] = ['identity', 'prefrontal', 'memory', 'skills', 'history']

/**
 * The delegation capability — planning/spawning/driving live subagents. It is
 * surfaced ONLY to a workflow master turn: a single-mode turn and an agent
 * turn never see it. Keeping it from agents is load-bearing — it holds the
 * agent tree flat (an agent can't spawn agents), so the registry stays one
 * finite source of truth with no await-stealing between concurrent consumers.
 */
const DELEGATION_CAPABILITIES: ReadonlySet<string> = new Set(['workflow'])

/**
 * Channel egress capabilities — the live messaging channels register their send
 * tools in-process under these names when connected (TELEGRAM_CAPABILITY_NAME /
 * WHATSAPP_CAPABILITY_NAME / MOBILE_CAPABILITY_NAME in
 * src/main/channels/*\/tools.ts). Their sends hit the channel API directly, so
 * a worker holding them could message the user out-of-band — `phone` even
 * buzzes a pocket. Hard-coded here (not imported) to keep runtime decoupled
 * from the channel layer; the values are stable identifiers.
 */
const CHANNEL_CAPABILITIES: ReadonlySet<string> = new Set(['telegram', 'whatsapp', 'phone'])

/**
 * Everything an agent role is denied on top of delegation: channel egress
 * stays master-only — an agent must never message the user directly; only the
 * master speaks (the single voice). The `ask` capability is also withheld: a
 * subagent's ask_user card can't anchor in the chat (its toolCallId never
 * reaches the renderer) and would park the agent on a question that can't be
 * answered — blockers belong in its report to the master. `utilities`
 * (send_file / show_path) is the same single-voice rule applied to files:
 * both tools land attachments/cards directly in the user's conversation, and
 * the courier doctrine a worker inherits from agents.core.md ("the final tool
 * call of a file-producing task is send_file") would otherwise push it into
 * delivering — workers save under the workspace files/ dir and report paths;
 * the master delivers.
 */
const AGENT_EXCLUDED_CAPABILITIES: ReadonlySet<string> = new Set([
  ...DELEGATION_CAPABILITIES,
  ...CHANNEL_CAPABILITIES,
  'ask',
  'utilities'
])

// Self-qualifying overlay for locally-run models. Deliberately NOT a
// capability claim ("you are small") — a capable local 70B would be lied to,
// and any size-based branch would reintroduce the special-casing this
// replaced. One overlay, zero branching, full access.
const LOCAL_MODEL_PROMPT = `<local_model>
You are running as a locally-hosted model on the user's own machine. If a task exceeds what you can do reliably, say so plainly and suggest switching to a capable cloud model — hallucinating capability serves nobody. But if the user insists, comply fully: you have the same tools, memory, and context as any other model here, and nothing is withheld from you.
</local_model>`

// Channel formatting overlays, keyed by the turn's delivery channel (see
// AgentTurnOptions.channel). Appended when the turn's prose is delivered
// through a messaging channel whose renderer differs from the in-app chat.
// Keyed by hard-coded name — same decoupling rationale as
// CHANNEL_CAPABILITIES above. There is NO egress converter: the channels
// send the model's prose verbatim (Telegram with parse_mode HTML), so
// these overlays are the only thing standing between the model's habits
// and raw Markdown in the user's chat — the model IS the formatter.
const CHANNEL_PROMPTS: Readonly<Record<string, string>> = {
  whatsapp: `<channel>
You are talking with the user over WhatsApp: EVERY prose block you write — full replies AND the one-line narration between tool calls ("Checking the flight…", "Found it —") — is delivered VERBATIM to their phone as a WhatsApp message the moment you call the next tool or end the turn. Nothing you write here is internal, in-app-only, or "thinking out loud"; there is no Markdown renderer and no converter between you and the user. WhatsApp does NOT render Markdown; write ALL prose, narration included, in WhatsApp's own text formatting and nothing else:
- *bold* (single asterisks), _italic_ (single underscores), ~strikethrough~ (single tildes), \`inline code\` (backticks), \`\`\`monospace block\`\`\` (triple backticks, no language tag).
- Lists: start a line with "- " for a bullet or "1. " for a numbered item. Quote: start the line with "> ".
- NEVER use Markdown syntax: no **double asterisks**, no # headings, no | tables |, no [text](url) links, no --- rules. Every leaked marker reaches the user as raw, ugly syntax: the send tools REFUSE Markdown outright, and narration that leaks it lands on their phone before anything can stop it. GOOD: *Flight details*\n_Gate 22_. BAD: **Flight details**\n| gate | 22 |. BAD narration: "Key findings:\n- **Departed**: 10:23 PM" — write "Key findings:\n- *Departed:* 10:23 PM".
- NEVER use HTML: WhatsApp renders no tags and no entities — <b>hi</b> and &amp; reach the user as literal text. Write plain & < > characters and WhatsApp markup, never Telegram-style HTML. To show a tag or code as text on purpose, wrap it in \`backticks\`.
- If a message contains any formatting, call whatsapp_check_format on the exact text FIRST and only send once it comes back clean.
- Instead of a heading, write a short *bold* line. Instead of a table, write one "*Label:* value" line per fact. For a link, paste the bare URL — WhatsApp makes it clickable.
- NEVER draw horizontal divider lines: no ━━━━━, ═════, ─────, -----, _____, or any line of repeated bar/dash characters — a phone's narrow bubble wraps them into several broken lines of bars, and the send tools reject them. A blank line separates sections; an emoji + *bold* line is the header. Progress bars like ▓▓▓▓░░ 60% are fine — the ban is on drawn rules, not block-character bars.
- The same applies to everything you relay: tool results, file contents, and subagent reports are often Markdown — rewrite them in WhatsApp formatting before quoting them.
- Exception: to show an image inline you may embed ![description](wolffish-media://…) exactly as a tool result gave it to you — the channel replaces it with the actual image.
- ask_user questions, option labels, and option descriptions are rendered by the channel's own question card — write them as plain text with no formatting markers.
- Emojis render natively — use them naturally to aid scanning; a leading emoji on a *bold* line does a heading's job (✈️ *Flight details*).
- Video generation on this channel: the channel already tells the user a task started, so after video_generate write at most one short line, call video_await, then deliver the mp4 with whatsapp_send_video (it compresses oversized videos on its own and notes that the original stays in the app) — never describe the video as a substitute for sending it.
- Voice notes and audio that are meant to PLAY in WhatsApp (a voice reply, a spoken memo, any audio the user will tap and hear) MUST be OGG/Opus (audio/ogg; codecs=opus): WhatsApp PTT voice notes only play that container. Default to OGG/Opus — if your audio is MP3/WAV (e.g. a TTS voice reply comes out as mp3), transcode it to OGG/Opus first: ~/.wolffish/bin/ffmpeg/ffmpeg -i in.mp3 -c:a libopus -b:a 24k out.ogg, then pass the .ogg path to whatsapp_send_audio. Only send an MP3 as-is when the user explicitly needs or asks for an MP3 (a file to save or share, not a voice note to play) — a bare mp3 sent as a voice note will not play.
- This is a phone chat: keep replies short and scannable. Prefer a few tight lines over long structured documents.
</channel>`,
  telegram: `<channel>
You are talking with the user over Telegram: EVERY prose block you write — full replies AND the one-line narration between tool calls ("Checking the flight…", "Found it —") — is delivered VERBATIM to their phone as a Telegram message (sent with parse_mode HTML) the moment you call the next tool or end the turn. Nothing you write here is internal, in-app-only, or "thinking out loud"; there is no Markdown renderer and no converter between you and the user. Telegram does NOT render Markdown; write ALL prose, narration included, in Telegram's HTML subset and nothing else:
- Allowed tags: <b>bold</b>, <i>italic</i>, <u>underline</u>, <s>strikethrough</s>, <code>inline code</code>, <pre>multi-line code block</pre> (or <pre><code class="language-python">…</code></pre>), <a href="https://…">link</a>, <blockquote>quote</blockquote>, <span class="tg-spoiler">spoiler</span>.
- NO other tags exist: no <br> (use real newlines), no <p>, <ul>, <li>, <h1>, <table>, and NEVER wrap the message in a container tag like <message>/<html>. One unknown tag, unclosed tag, or bare < / & makes Telegram reject the ENTIRE message and it arrives as raw tag soup — write literal & as &amp;, < as &lt;, > as &gt;, in prose and inside <code>/<pre> alike, and close every tag you open. The tags THEMSELVES are raw < > characters — entity-escaping a tag (&lt;b&gt; instead of <b>) makes Telegram show the user literal "<b>" text instead of bold. GOOD: <b>Digest</b>\ncost &lt;5. BAD: <b>Digest</b>…</message> (stray wrapper), &lt;b&gt;Digest&lt;/b&gt; (escaped tags — arrive as literal text), line<br>line, cost < 5 & up (unescaped).
- If a message contains ANY HTML tag or literal < / &, call telegram_check_format on the exact text FIRST and only send once it returns valid — never guess.
- NEVER use Markdown syntax: no **bold**, no # headings, no | tables |, no [text](url), no --- rules. Every leaked marker reaches the user as raw, ugly syntax: the send tools REFUSE Markdown outright, and narration that leaks it lands on their phone before anything can stop it. BAD narration: "Key findings:\n- **Departed**: 10:23 PM" — write "Key findings:\n- <b>Departed:</b> 10:23 PM".
- Instead of a heading, write a short <b>bold</b> line. Instead of a table, write one "<b>Label:</b> value" line per fact. Lists are plain lines starting with "- " or "1. " (literal text is fine there).
- NEVER draw horizontal divider lines: no ━━━━━, ═════, ─────, -----, _____, or any line of repeated bar/dash characters — a phone's narrow bubble wraps them into several broken lines of bars, and the send tools reject them. A blank line separates sections; an emoji + <b>bold</b> line is the header. Progress bars like ▓▓▓▓░░ 60% are fine — the ban is on drawn rules, not block-character bars.
- The same applies to everything you relay: tool results, file contents, and subagent reports are often Markdown — rewrite them in Telegram HTML before quoting them.
- Exception: to show an image inline you may embed ![description](wolffish-media://…) exactly as a tool result gave it to you — the channel replaces it with the actual image.
- ask_user questions, option labels, and option descriptions are rendered by the channel's own question card — write them as plain text with no HTML and no formatting markers.
- Emojis render natively — use them naturally to aid scanning; a leading emoji on a <b>bold</b> line does a heading's job (✈️ <b>Flight details</b>).
- Video generation on this channel: the channel already tells the user a task started, so after video_generate write at most one short line, call video_await, then deliver the mp4 with telegram_send_video (it compresses oversized videos on its own and notes that the original stays in the app) — never describe the video as a substitute for sending it.
- This is a phone chat: keep replies short and scannable. Prefer a few tight lines over long structured documents.
</channel>`
}

// Non-sensitive config variables longer than this are previewed, not dumped
// verbatim, into the (RAS-bypassing) <variables> block. Generous enough that
// real values — URLs, names, IDs, keys — are never touched.
const VARIABLE_VALUE_MAX_CHARS = 400

// Framing prepended to the playbook when it rides into the prompt. The
// playbook is written by a nightly LLM pass, so the framing — how much
// authority these lessons carry — must come from code, not from content the
// merge could mangle: learned tendencies to apply by default, never rules
// that outrank the user's live instruction.
const PLAYBOOK_FRAMING = `Your playbook — lessons distilled nightly from your own reviewed conversations. Recall it naturally before and while acting, the way practice shapes habit: check Recipes when a task matches one, respect Avoid before repeating a known failure, and lean on Do / User likes to shape tone and approach. These are evidence-dated tendencies, not laws — the newest entry wins a conflict, and the user's live instruction always outranks the playbook.`

// <workflow_models> caps: enough for a realistic multi-provider setup while
// keeping the master's overlay lean (the block is per-turn pinned prompt text).
const MODELS_BLOCK_PER_PROVIDER = 10
const MODELS_BLOCK_MAX_LINES = 40

const SECTION_TAGS: Record<ContextCategory, string> = {
  identity: 'identity',
  prefrontal: 'prefrontal',
  memory: 'memory',
  skills: 'skills',
  history: 'recent'
}

/**
 * Prefrontal handles executive function — planning, working memory, and
 * deciding what approach to take.
 *
 * Maps to: the prefrontal cortex — the front of the frontal lobes, the
 * part of the brain that takes the longest to mature and the first to
 * decline. It holds working memory, weighs trade-offs, suppresses
 * impulses, and assembles a plan before the motor cortex fires.
 *
 * In Wolffish, Prefrontal reads the workspace markdown (soul, user,
 * agents, tools, recent episodes), asks the cortex for relevant memories,
 * routes everything through the RAS for budget-aware filtering, and emits
 * the assembled system prompt the model will see. A debug snapshot of
 * every assembled prompt is written to brain/prefrontal/.debug/ so the
 * exact context can be inspected after the fact.
 */
export class Prefrontal {
  private cortex: Cortex | null
  private ras: RAS
  private cerebellum: Cerebellum | null
  private basalganglia: BasalGanglia | null
  private corpus: Corpus | null
  private device: Device | null

  constructor(private options: PrefrontalOptions) {
    this.cortex = options.cortex ?? null
    this.ras = options.ras ?? new RAS({ totalBudgetTokens: this.getTokenBudget() })
    this.cerebellum = options.cerebellum ?? null
    this.basalganglia = options.basalganglia ?? null
    this.corpus = options.corpus ?? null
    this.device = options.device ?? null
  }

  async buildSystemPrompt(
    message = '',
    runtime?: RuntimeContext,
    role?: 'master' | 'agent',
    opts?: {
      /**
       * True when the resolved model runs locally. Adds the self-qualifying
       * honesty overlay — prompt text, never divergent assembly: a local
       * model gets the same context, tools, and memory as any cloud model.
       */
      localModel?: boolean
      channel?: string
      conversationId?: string | null
    }
  ): Promise<string> {
    const bundle = await this.buildContext(message, runtime, role, opts)
    const blocks = [
      bundle.systemPrompt,
      await this.buildRoleBlock(role),
      opts?.localModel ? LOCAL_MODEL_PROMPT : '',
      opts?.channel ? (CHANNEL_PROMPTS[opts.channel] ?? '') : '',
      await this.buildVideoPromptingBlock(),
      await this.buildVoicePromptingBlock(role)
    ].filter((b) => b && b.length > 0)
    return blocks.join('\n\n')
  }

  /**
   * The video Director-mode directive — a pure instruction, honored by the
   * model alone: the harness never rewrites, embellishes, or refuses a
   * prompt in either mode. Read from config at prompt build (turn-stable,
   * like the project overlay), so flipping the Settings toggle changes the
   * NEXT turn's prompt; the rarity of a flip is what makes the cache cost
   * acceptable. Empty when the video capability is disabled — no dead
   * instructions for tools that don't ship.
   */
  private async buildVideoPromptingBlock(): Promise<string> {
    if (this.cerebellum?.isDisabled('video')) return ''
    const config = await readConfig().catch(() => null)
    const director = config?.video?.director !== false
    if (director) {
      return `<video_prompting>
Director mode is ON (a Settings toggle the user controls). When generating a video you are the DIRECTOR: expand the user's request into a full cinematic prompt — subject, action, camera movement, light, mood — before calling video_generate. Directing rewrites the PROSE only: specs the user stated are orders, not context — a named length goes in duration_seconds, named quality in resolution, named orientation in ratio (format words inside the prompt text change nothing) — and only what they left unstated is yours to pick. Sparse prompts produce flat footage; your rewrite is where the quality comes from. AFTER submitting, show the user the optimized prompt you actually sent, as a short quoted block introduced naturally (e.g. "Directed as:") — they steer the next take by editing it. Never present the rewrite as the user's own words.
</video_prompting>`
    }
    return `<video_prompting>
Director mode is OFF (a Settings toggle the user controls). When generating a video, pass the user's request to video_generate VERBATIM as the prompt — no rewriting, no embellishment, no added camera or style language, even when you are sure it would look better. Trim only what is clearly not the prompt itself (e.g. "make a video of ..." framing). You still SET the parameters: a length, quality or orientation the user named goes in duration_seconds/resolution/ratio (words in the prompt text alone change nothing — '15 seconds' left there produces the 6s default), defaults fill only what they left unstated. You may mention that Director mode is available if a result looks flat.
</video_prompting>`
  }

  /**
   * The voice-prompt directive, controlled by ONE thing: the Voice replies
   * switch on the Preferences page (config.tts.voiceReplies, default ON).
   * Switch ON → the <voice_prompts> instructions are ALWAYS in the prompt —
   * every turn, every channel, voice note present or not — as a standing
   * policy the model applies whenever a voice prompt arrives. Switch OFF →
   * no instructions at all. Nothing here inspects the turn's content; the
   * preference is the whole gate. Same contract as the video block: read
   * from config at prompt build (turn-stable), honored by the model alone —
   * the harness never synthesizes or suppresses audio itself. Empty for an
   * agent role (a subagent never speaks to the user) and when the
   * text-to-speech capability is disabled (no voice_respond to call —
   * instructions for absent tools are noise).
   */
  private async buildVoicePromptingBlock(role?: 'master' | 'agent'): Promise<string> {
    if (role === 'agent') return ''
    if (this.cerebellum?.isDisabled('text-to-speech')) return ''
    const config = await readConfig().catch(() => null)
    if (config?.tts?.voiceReplies === false) return ''
    return `<voice_prompts>
Voice replies are ON (the Voice replies switch on the Preferences page — the user controls it). This is your STANDING POLICY for spoken messages:
A user message tagged <voice_note> was SPOKEN: the text is its transcript (already transcribed — NEVER call stt_* tools on its attached audio), and the lang="…" attribute is the language to reply in — authoritative, even when it differs from the user's usual language.
Whenever a turn's user message is a <voice_note>, your reply MUST include audio — this is the rule, not a preference:
- END the turn with exactly ONE voice_respond call that speaks your answer. Text and media BEFORE it are welcome when the work produces them — deliver files, tables, code, charts exactly as a typed turn would (send_file, cards, prose), then close with the voice_respond that speaks the answer or summary over them. The memo is your wrap-up, and it comes last, every time.
- A purely conversational answer needs no text at all: the one voice_respond IS the reply — write nothing beyond a brief label like "Voice memo", and never restate the memo's content as prose (a duplicate text bubble next to the audio reads as broken).
- voice_respond text is plain speech — no markup, no bullets, no code — and leave its voice parameter unset: the user picked their voice in Settings.
The ONLY exception: the user's own message explicitly asks for something else ("reply in text", "write it down", dictating content for a document). Otherwise a voice prompt gets a voice reply — no matter how much text and media the work needed along the way. Typed messages are unaffected by this policy.
</voice_prompts>`
  }

  /**
   * Role overlay for workflow mode, appended after the assembled prompt. A
   * master gets the workflow doctrine (it designs and drives the run) plus
   * the live model catalog for per-agent choices; an agent gets the subagent
   * framing (bounded task, reports to the master, never the user). A
   * single-mode turn (no role) gets nothing.
   */
  private async buildRoleBlock(role?: 'master' | 'agent'): Promise<string> {
    if (role === 'master') {
      const md = (await this.readFile('brain/identity/workflow.md'))?.trim() ?? ''
      const models = await this.workflowModelsBlock()
      return models ? `${md}\n\n${models}` : md
    }
    if (role === 'agent') {
      return (await this.readFile('brain/identity/workflow-agent.md'))?.trim() ?? ''
    }
    return ''
  }

  /**
   * Tell the master exactly which models it can spawn agents on — the
   * connected providers' validated catalogs, each with its reasoning efforts,
   * context window and vision support — so per-agent model choice is informed,
   * not blind. (The thalamus also clamps an out-of-range effort and rejects an
   * unconnected provider at the seam, so this is guidance, not a hard guard.)
   * Capped per provider to keep the overlay lean; rebuilt with the turn pin,
   * so it is byte-stable across iterations.
   */
  private async workflowModelsBlock(): Promise<string> {
    const cfg = await readConfig().catch(() => null)
    if (!cfg) return ''
    const connected = cfg.llm.providers.filter((p) => p.apiKey)
    if (connected.length === 0) return ''
    const brain = cfg.llm.brain
    const lines: string[] = []
    for (const p of connected) {
      const models = (p.models ?? []).filter(Boolean).slice(0, MODELS_BLOCK_PER_PROVIDER)
      // A provider with an empty cached catalog still has its saved model.
      if (models.length === 0 && p.model) models.push(p.model)
      for (const m of models) {
        const openrouterReasoning =
          p.id === 'openrouter' ? (p.reasoningModels?.includes(m) ?? false) : false
        const modes = reasoningModesFor(p.id, m, { openrouterReasoning })
        const traits: string[] = []
        traits.push(`~${Math.round(contextWindowForModel(m) / 1000)}k ctx`)
        if (modes.length > 0) traits.push(`effort: ${modes.join('/')}`)
        if (cloudModelSupportsVision(p.id, m)) traits.push('vision')
        const isBrain = brain && brain.providerId === p.id && brain.model === m
        lines.push(`- ${p.id}/${m} (${traits.join(', ')})${isBrain ? ' ← your own model' : ''}`)
      }
    }
    if (lines.length === 0) return ''
    return `<workflow_models>\nModels you can run agents on — pass agent_spawn's \`model\` exactly as listed (\`provider/model-id\`), or omit it to run the agent on your own model. Match the model to the slice: frontier models for hard reasoning, cheaper/faster ones for mechanical work. Default to models from YOUR OWN provider's family (yours is marked below); pick another family only when the slice clearly benefits from it.\n${lines.slice(0, MODELS_BLOCK_MAX_LINES).join('\n')}\n</workflow_models>`
  }

  /**
   * The capabilities a given role must NOT see. A master gets everything
   * (incl. delegation); an agent loses delegation, channel egress, ask AND
   * delivery (utilities); a single-mode turn loses only delegation. Used for
   * BOTH the API tool array (`getToolDefinitions`) and the `<capabilities>`
   * prompt block so the two never drift — an agent shouldn't read about tools
   * it can't call.
   */
  private excludedCapabilitiesFor(role?: 'master' | 'agent'): ReadonlySet<string> | undefined {
    return role === 'master'
      ? undefined
      : role === 'agent'
        ? AGENT_EXCLUDED_CAPABILITIES
        : DELEGATION_CAPABILITIES
  }

  selectTools(role?: 'master' | 'agent', conversationId?: string | null): ToolDefinition[] {
    return (
      this.cerebellum?.getToolDefinitions(this.excludedCapabilitiesFor(role), {
        conversationId: conversationId ?? null
      }) ?? []
    )
  }

  /**
   * Score candidates, fit them into the budget, and assemble the final
   * system prompt. Writes a debug snapshot and emits `context.built`.
   * If `runtime` is supplied, a `<runtime>` block reporting the live
   * iteration counter is appended last so the model can see its own
   * loop position.
   */
  async buildContext(
    message = '',
    runtime?: RuntimeContext,
    role?: 'master' | 'agent',
    opts?: { localModel?: boolean; conversationId?: string | null }
  ): Promise<ContextBundle> {
    // LEAN BY DESIGN: the prompt carries the essentials only — identity, the
    // behavioral contract, device facts, the learned-preferences digest, a
    // "what memory exists" map, and a one-line-per-capability index. No
    // memory dumps, no episode dumps, no tool catalogs: everything else is
    // indexed on disk and retrieved surgically (memory_search / tool_search)
    // when the turn actually needs it.
    //
    // An agent runs a bounded, self-contained task the master composed — it
    // additionally skips the preferences digest and the memory map (those are
    // about the live user thread, not the agent's slice).
    const lean = role === 'agent'
    const conversationId = opts?.conversationId ?? null
    // Assemble against a clamped budget, not the raw model window — the guard
    // that keeps a pathological candidate from ever ballooning the prompt.
    const budget = this.ras.allocateBudget(clampAssemblyBudget(this.getTokenBudget()))
    const candidates: ContextCandidate[] = []
    const includedPaths = new Set<string>()

    for (const entry of ALWAYS_INCLUDED) {
      const content = await this.readFile(entry.rel)
      if (content) {
        candidates.push({ category: entry.category, source: entry.rel, content })
        includedPaths.add(entry.rel)
      }
    }

    if (!lean) {
      // The one ambient memory that stays: the bounded learned-preferences
      // digest (~500 tokens). Checking preferences must not cost a retrieval
      // round-trip on every task.
      const feedbackCandidate = await this.collectFeedbackCandidate(
        this.options.feedbackWindowDays ?? 7
      )
      if (feedbackCandidate && !includedPaths.has(feedbackCandidate.source)) {
        candidates.push(feedbackCandidate)
        includedPaths.add(feedbackCandidate.source)
      }
    }

    const filtered = this.ras.filterContext(message, candidates, budget)
    const grouped = groupByCategory(filtered)

    const sections: string[] = []
    const sectionsIncluded: string[] = []

    // Device facts bypass RAS — they're universally relevant for any
    // tool call (correct shell syntax, correct paths, resource limits).
    const deviceBody = this.device ? await this.device.getBlockBody().catch(() => '') : ''

    for (const category of SECTION_ORDER) {
      const items = grouped.get(category) ?? []
      if (items.length > 0) {
        const body = items.map((it) => formatItem(it)).join('\n\n')
        sections.push(this.wrap(SECTION_TAGS[category], body))
        sectionsIncluded.push(category)
      }

      // Device facts sit right after <identity> so the model reads
      // "who I am, then where I am".
      if (category === 'identity' && deviceBody.length > 0) {
        sections.push(this.wrap('device', deviceBody))
        sectionsIncluded.push('device')
      }

      // User-defined variables from config.json sit right after <device>.
      // Sensitive values are passed in plaintext so the agent can use them
      // in tool calls.
      if (category === 'identity') {
        const variablesBody = await this.collectVariablesBlock()
        if (variablesBody.length > 0) {
          sections.push(this.wrap('variables', variablesBody))
          sectionsIncluded.push('variables')
        }
      }

      if (category === 'prefrontal') {
        // The capability INDEX — one line per capability, no schemas. The
        // model always knows what exists; tool_search loads what a turn
        // needs. Full schemas ship only for the core + activated set (the
        // native tools param, selected in lockstep via selectTools).
        const indexBody =
          this.cerebellum
            ?.getCapabilityIndex(this.excludedCapabilitiesFor(role), conversationId)
            .trim() ?? ''
        if (indexBody.length > 0) {
          sections.push(
            this.wrap(
              'capabilities',
              `Installed capabilities ([loaded] = callable right now; anything else is one tool_search/tool_activate away):\n${indexBody}`
            )
          )
          sectionsIncluded.push('capabilities')
        }

        // The memory map: a byte-stable-per-day coverage stub telling the
        // model WHAT exists to be recalled — never the content itself.
        if (!lean) {
          const memoryMap = await this.buildMemoryMap()
          if (memoryMap.length > 0) {
            sections.push(this.wrap('memory_map', memoryMap))
            sectionsIncluded.push('memory_map')
          }
        }
      }
    }

    if (runtime) {
      sections.push(this.wrap('runtime', formatRuntimeBody(runtime)))
      sectionsIncluded.push('runtime')
    }

    const systemPrompt = sections.join('\n\n')
    const estimatedTokens = this.ras.estimateTokens(systemPrompt)

    if (this.corpus) {
      this.corpus.emit('context.built', {
        tokenCount: estimatedTokens,
        // The model's FULL context window — a 1M model reads 1M on the meter.
        // (Compaction enforces against getTokenBudget(), the window minus the
        // output reserve; the meter deliberately shows the headline window
        // because that's the number the user knows their model by.)
        tokenBudget: this.getContextWindow(),
        // Where auto-compaction actually triggers, in the same token units as
        // tokenBudget — the meter draws this as a tick so the visible % and
        // the compaction trigger stop being two unrelated denominators.
        compactionAt: Math.floor(this.getTokenBudget() * COMPACTION_THRESHOLD),
        sectionsIncluded
      })
    }

    await this.writeDebugSnapshot({
      message,
      systemPrompt,
      estimatedTokens,
      sectionsIncluded,
      filtered
    })

    return { systemPrompt, estimatedTokens, sectionsIncluded }
  }

  /**
   * Choose how to handle the user's message. Phase 2 will read the
   * thalamus classification and basal-ganglia preferences to pick the
   * right approach.
   */
  // plan(_message: string): Plan {
  //   throw new Error('Prefrontal.plan not implemented — Phase 2')
  // }

  /**
   * Total tokens available for context this turn. Phase 2 will subtract
   * what the model needs to generate from the model's max-context.
   */
  getTokenBudget(): number {
    return this.options.getContextBudget?.() ?? DEFAULT_BUDGET_TOKENS
  }

  getContextWindow(): number {
    return this.options.getContextWindow?.() ?? this.getTokenBudget()
  }

  /**
   * The `<memory_map>` stub: a coverage MAP of everything recallable — never
   * the content. Byte-stable per calendar day (cached) so it doesn't churn
   * the provider prompt-cache prefix between turns: counts are rounded to
   * coarse buckets and the whole string regenerates once per day.
   */
  private memoryMapCache: { day: string; body: string } | null = null

  /**
   * Drop the day-cached memory map so the next prompt re-derives it. Called
   * when the agent edits a knowledge file's `##` topics through the
   * `knowledge` capability: without this the map would advertise yesterday's
   * topic list until midnight — a topic just added would be invisible, and one
   * just forgotten would still be offered. Deliberately NOT called for
   * ordinary fact edits inside an existing section: the map only carries
   * headings, so re-deriving it there would break the prompt-cache prefix for
   * nothing.
   */
  invalidateMemoryMap(): void {
    this.memoryMapCache = null
  }

  private async buildMemoryMap(): Promise<string> {
    const day = new Date().toISOString().slice(0, 10)
    if (this.memoryMapCache?.day === day) return this.memoryMapCache.body
    if (!this.cortex) return ''

    let body = ''
    try {
      const cov = this.cortex.coverage()
      const round = (n: number): string =>
        n < 20 ? String(n) : n < 200 ? `~${Math.round(n / 10) * 10}` : `~${Math.round(n / 50) * 50}`
      const lines: string[] = [
        'Everything you have ever done, said, produced, or spent is indexed on disk — this is the coverage map, NOT the content. It is never evidence of absence: memory_search (2-3 phrasings) before concluding something was not recorded.'
      ]
      for (const s of cov.recordsBySource) {
        const range = s.minDate && s.maxDate ? ` (${s.minDate} → ${s.maxDate})` : ''
        lines.push(`- ${s.source}: ${round(s.count)} records${range}`)
      }
      lines.push(
        `- conversations on disk: ${round(cov.conversations)} (conversation_list / conversation_read)`
      )
      lines.push(
        `- generated/uploaded files: ${round(cov.artifacts)} (memory_search sources: artifact)`
      )

      // Long-term knowledge topics (## headers of the five curated files) —
      // tiny, and they tell the model what durable facts exist to be fetched.
      const topics: string[] = []
      for (const file of ['projects', 'people', 'preferences', 'technical', 'decisions']) {
        const raw = await this.readFile(`brain/hippocampus/knowledge/${file}.md`)
        if (!raw) continue
        const headers = [...raw.matchAll(/^##\s+(.+\S)\s*$/gm)].map((m) => m[1]).slice(0, 8)
        if (headers.length > 0) topics.push(`${file}: ${headers.join(', ')}`)
      }
      if (topics.length > 0) {
        lines.push(`- knowledge topics — ${topics.join(' | ')} (memory_get the file for details)`)
      }
      body = lines.join('\n')
    } catch {
      body = ''
    }
    this.memoryMapCache = { day, body }
    return body
  }

  private async collectFeedbackCandidate(windowDays: number): Promise<ContextCandidate | null> {
    // The playbook — the nightly reflection's distilled lessons (what the
    // user liked and disliked, what worked, what failed and why, per-task
    // recipes) — is the ambient learning surface. It SUPERSEDES the raw
    // basalganglia digest: the digest was reliability stats plus the last 12
    // raw failures, which in practice was twelve copies of one transient
    // error; the playbook carries root causes with dated evidence instead.
    // The digest remains the bootstrap fallback until the first reflection
    // run writes a playbook, and stays available on demand via the insula.
    const playbook = (await this.readFile('brain/reflection/playbook.md'))?.trim() ?? ''
    if (playbook.length > 0) {
      return {
        category: 'prefrontal',
        source: 'playbook (nightly reflection)',
        content: `${PLAYBOOK_FRAMING}\n\n${playbook}`
      }
    }

    if (!this.basalganglia) return null
    const content = await this.basalganglia.getPreferences(windowDays).catch(() => '')
    if (!content || content.trim().length === 0) return null
    // Mandatory (prefrontal) so the synthesized habit digest is always present
    // — it's tiny and represents standing behavioural guidance, not a
    // query-dependent memory. The source label is deliberately not a real path
    // (the digest is synthesized, not a file the model should try to read).
    return {
      category: 'prefrontal',
      source: 'synthesized: learned preferences',
      content
    }
  }

  private async collectVariablesBlock(): Promise<string> {
    try {
      const config = await readConfig()
      const vars = config?.variables ?? []
      if (vars.length === 0) return ''
      // This block bypasses RAS, so an oversized pasted value (a JSON blob, a
      // cert) would land in the prefix uncapped on every turn — the same
      // unbounded-source failure mode this work hardened elsewhere. Cap
      // non-sensitive values; keep sensitive ones whole so the agent can still
      // use a secret verbatim in a tool call (keys are short anyway).
      const lines = vars.map((v) => {
        const value =
          v.sensitive || v.value.length <= VARIABLE_VALUE_MAX_CHARS
            ? v.value
            : `${v.value.slice(0, VARIABLE_VALUE_MAX_CHARS).trimEnd()}… (${v.value.length} chars; read config.json for the full value)`
        return `- ${v.name} = ${value}${v.sensitive ? ' (sensitive)' : ''}`
      })
      return [
        'The user has defined the following variables in Settings > Variables.',
        'Use these values when the user references them or when a task requires them.',
        'These are the single source of truth — never ask the user to re-enter a value that exists here.',
        'If the user shares a secret or API key in chat and asks you to save it, write it to config.json under the variables array using file_write so it appears in the Variables UI.',
        '',
        ...lines
      ].join('\n')
    } catch {
      return ''
    }
  }

  /**
   * The coding overlay: appended to the pinned prompt by the Agent when a
   * working folder is a code project (see workdir.ts anyCodeFolder). The
   * base file stands on its own for every provider; a provider-specific
   * addendum (coding.<provider>.md) follows it when one ships. Both are
   * app-managed (workspace.ts migrateAgentsCore) and read fresh per turn, so
   * the cached prefix is stable across a turn and current across launches.
   */
  async buildCodingOverlay(provider: string | null): Promise<string> {
    const base = (await this.readFile('brain/prefrontal/coding.md'))?.trim() ?? ''
    if (!base) return ''
    const extra =
      provider && /^[a-z0-9-]+$/i.test(provider)
        ? ((await this.readFile(`brain/prefrontal/coding.${provider}.md`))?.trim() ?? '')
        : ''
    return `\n\n${base}${extra ? `\n\n${extra}` : ''}`
  }

  private async readFile(relPath: string): Promise<string | null> {
    try {
      const raw = await fs.readFile(path.join(this.options.workspaceRoot, relPath), 'utf8')
      // Strip HTML comments so workspace files can carry author-facing
      // instructions (<!-- ... -->) without burning context tokens.
      const content = raw.replace(/<!--[\s\S]*?-->/g, '').trim()
      return content.length > 0 ? content : null
    } catch {
      return null
    }
  }

  private async writeDebugSnapshot(args: {
    message: string
    systemPrompt: string
    estimatedTokens: number
    sectionsIncluded: string[]
    filtered: ScoredCandidate[]
  }): Promise<void> {
    const dir = path.join(this.options.workspaceRoot, 'brain', 'prefrontal', '.debug')
    try {
      await fs.mkdir(dir, { recursive: true })
    } catch {
      return
    }
    const stamp = formatStamp(new Date())
    const filename = `${stamp}.md`
    await pruneDebugSnapshots(dir)
    const sourceList = args.filtered
      .map((it) => `- (${it.category}, score=${it.score.toFixed(2)}, ~${it.tokens}t) ${it.source}`)
      .join('\n')
    const header = [
      `# Prefrontal context snapshot`,
      ``,
      `- timestamp: ${new Date().toISOString()}`,
      `- estimated tokens: ${args.estimatedTokens}`,
      `- budget: ${this.getTokenBudget()}`,
      `- sections: ${args.sectionsIncluded.join(', ') || '(none)'}`,
      ``,
      `## message`,
      ``,
      args.message || '(empty)',
      ``,
      `## sources`,
      ``,
      sourceList || '(none)',
      ``,
      `## prompt`,
      ``,
      args.systemPrompt,
      ''
    ].join('\n')
    try {
      await diskWriter.writeFileAtomic(path.join(dir, filename), header)
    } catch {
      // best-effort: snapshot failure must not block a turn
    }
  }

  private wrap(tag: string, body: string): string {
    return `<${tag}>\n${body}\n</${tag}>`
  }
}

function formatItem(item: ScoredCandidate): string {
  return `<source path="${item.source}">\n${item.content}\n</source>`
}

function formatRuntimeBody(runtime: RuntimeContext | undefined): string {
  // The batch-every-item doctrine that used to ride here unconditionally
  // lives in the core contract (agents.core.md "Loop discipline") now — the
  // runtime block carries only live counters, and only on the legacy path.
  const lines: string[] = []
  if (runtime && runtime.renderCounters !== false) {
    lines.push(`  Tool iteration this turn: ${runtime.iteration}`)
    lines.push(`  Tools called this turn: ${runtime.toolsCalled}`)
    // Conversation-resumed notice — same vehicle rule as the counters
    // (legacy in-prompt here, volatile tail on the optimized path); keeping
    // it inside the renderCounters gate is load-bearing: on the optimized
    // path the prompt is pinned and must stay byte-identical across turns,
    // and this string changes every turn the gap grows.
    if (runtime.lastMessage) lines.push(`  ${runtime.lastMessage}`)
    // Gated on renderCounters (legacy path only) — in the optimized path the
    // prompt is pinned, so this per-turn fact rides the volatile tail via
    // formatRuntimeStatus instead, never touching the cached prefix.
    const delivered = deliveredFilesReminder(runtime.deliveredFiles ?? [])
    if (delivered) lines.push(`  ${delivered}`)
    // Same vehicle rule as the counters: legacy rebuilds the prompt each
    // iteration so the notice lives here; optimized pins the prompt and the
    // notice rides the volatile tail instead.
    if (runtime.online === false) lines.push(`  ${OFFLINE_NOTICE}`)
    // No-progress notice rides the same vehicle for the same reason.
    if (runtime.noProgress) lines.push(`  ${runtime.noProgress}`)
    // Channel-format notice (prose delivered to a phone with raw markup) —
    // same vehicle, same reason.
    if (runtime.channelFormat) lines.push(`  ${runtime.channelFormat}`)
    // Control-token notice (a control token leaked into user-visible text) —
    // same vehicle, same reason.
    if (runtime.controlToken) lines.push(`  ${runtime.controlToken}`)
    // Video-task landing notice — same vehicle, same reason.
    if (runtime.videoTasks) lines.push(`  ${runtime.videoTasks}`)
    if (runtime.openTodo) lines.push(`  ${runtime.openTodo}`)
    if (runtime.processes) lines.push(`  ${runtime.processes}`)
    if (runtime.checkIns) lines.push(`  ${runtime.checkIns}`)
    if (runtime.taskList) lines.push(`  ${runtime.taskList}`)
    // Voice-reply notice (voice-prompted turn, Voice replies ON) — same
    // vehicle, same reason.
    if (runtime.voiceReply) lines.push(`  ${runtime.voiceReply}`)
    // Phone-notification notice (a phone is paired) — same vehicle, same
    // reason.
    if (runtime.phoneNotify) lines.push(`  ${runtime.phoneNotify}`)
    // Screen-indicator notice (a computer-use glow this turn raised is up) —
    // same vehicle, same reason.
    if (runtime.screenIndicator) lines.push(`  ${runtime.screenIndicator}`)
    // Mid-turn user-message notice (an interjection was just delivered) —
    // same vehicle, same reason; present on one iteration.
    if (runtime.interjection) lines.push(`  ${runtime.interjection}`)
  }
  return lines.join('\n')
}

function groupByCategory(items: ScoredCandidate[]): Map<ContextCategory, ScoredCandidate[]> {
  const map = new Map<ContextCategory, ScoredCandidate[]>()
  for (const item of items) {
    const list = map.get(item.category) ?? []
    list.push(item)
    map.set(item.category, list)
  }
  return map
}

function formatStamp(d: Date): string {
  const yyyy = d.getFullYear()
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  const hh = String(d.getHours()).padStart(2, '0')
  const mi = String(d.getMinutes()).padStart(2, '0')
  const ss = String(d.getSeconds()).padStart(2, '0')
  const ms = String(d.getMilliseconds()).padStart(3, '0')
  return `${yyyy}-${mm}-${dd}_${hh}-${mi}-${ss}.${ms}`
}

/** Keep at most this many prompt snapshots in brain/prefrontal/.debug. */
const SNAPSHOT_KEEP = 50
/** Only pay the readdir once the dir has clearly outgrown the cap. */
const SNAPSHOT_PRUNE_SLACK = 10

/**
 * Cap .debug snapshot growth. Snapshot filenames are sortable timestamps, so
 * lexicographic order IS chronological order — delete the oldest overflow.
 * One snapshot lands per context build (hourly heartbeats alone add ~180KB
 * each); without pruning the dir grew unbounded (83MB in 18 days observed).
 */
async function pruneDebugSnapshots(dir: string): Promise<void> {
  let names: string[]
  try {
    names = (await fs.readdir(dir)).filter((n) => n.endsWith('.md'))
  } catch {
    return
  }
  if (names.length < SNAPSHOT_KEEP + SNAPSHOT_PRUNE_SLACK) return
  names.sort()
  const excess = names.slice(0, names.length - SNAPSHOT_KEEP)
  for (const name of excess) {
    try {
      await fs.unlink(path.join(dir, name))
    } catch {
      // best-effort: pruning must never block a turn
    }
  }
}
