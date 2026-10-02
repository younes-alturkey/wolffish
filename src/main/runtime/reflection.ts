import {
  listConversations,
  loadConversation,
  type ConversationFile,
  type ConversationMessage
} from '@main/conversations'
import { diskWriter } from '@main/io/diskWriter'
import { runDetached, type Corpus } from '@main/runtime/corpus'
import type { Hippocampus, KnowledgeFile } from '@main/runtime/hippocampus'
import type { ChatMessage, Thalamus } from '@main/runtime/thalamus'
import fs from 'node:fs/promises'
import path from 'node:path'

/**
 * Reflection — the nightly self-review that turns finished conversations
 * into durable behavioural lessons, and the playbook those lessons live in.
 *
 * This is the seam that makes "self-improving" real rather than nominal.
 * The basal ganglia records WHAT happened (tool telemetry); reflection
 * decides what it MEANT: what the user liked (their words in the transcript
 * are the signal), what failed and why (root causes, not raw errors), and
 * what to do differently. Lessons are distilled into ONE always-in-context
 * file — brain/reflection/playbook.md — rewritten (never appended) after
 * every run, so the distillate self-heals instead of self-dumping.
 *
 * Three moving parts, all driven by brainstem's scheduler:
 *   1. Nightly review — every conversation that has been quiet for
 *      `quietHours` gets one review call (automation runs included: the
 *      agent can fumble unattended, and the automation prompt IS user
 *      input). Output blocks append to reflection/YYYY-MM-DD.md.
 *      (Conversation files from before mid-2026 may carry a `ratings`
 *      array from the retired turn-scoring feature — it is ignored.)
 *   2. Playbook merge — one call folds the new lessons into the existing
 *      playbook: dedupe, resolve contradictions newest-wins, decay stale
 *      inferred entries, keep it inside a hard size envelope.
 *   3. Monthly deep clean — an adversarial audit with the OPPOSITE stance
 *      (try to kill entries, not add them) over playbook + knowledge, the
 *      structural guard against self-reinforcing bad habits.
 */

// ── Paths & constants ─────────────────────────────────────────────────

const REFLECTION_DIR = 'brain/reflection'
export const PLAYBOOK_REL = `${REFLECTION_DIR}/playbook.md`
const REVIEWED_REL = `${REFLECTION_DIR}/reviewed.json`

/**
 * Standing eligibility window: reflection only ever considers conversations
 * whose last activity falls inside this many days. This is a permanent rule,
 * not a migration — it bounds every run (including the first one ever) to
 * the recent past instead of a 900-conversation backlog, and it lets the
 * reviewed index prune itself instead of growing forever.
 */
const LOOKBACK_DAYS = 7

/** Reviewed-index entries older than the lookback (plus slack) are pruned. */
const REVIEWED_RETENTION_DAYS = LOOKBACK_DAYS + 7

/** Total transcript budget per review call (chars, ≈15k tokens). */
const TRANSCRIPT_MAX_CHARS = 60_000
/** Per-message content excerpt cap. */
const MESSAGE_MAX_CHARS = 1_800
/** Per tool-result excerpt cap (failures get a little more room). */
const TOOL_RESULT_MAX_CHARS = 240
const TOOL_FAILURE_MAX_CHARS = 500

/**
 * Hard ceiling for the playbook file. The playbook rides in EVERY system
 * prompt (see prefrontal's always-included set), so the archives may grow
 * without limit but this distillate must not: past the envelope the merge
 * pass is instructed to compress or drop the weakest entries. ~6KB ≈ 1.5k
 * tokens — ambient learning at roughly the cost of one tool description.
 */
export const PLAYBOOK_MAX_CHARS = 6_000

/** Deep-clean reads at most this much reflection history (chars). */
const DEEPCLEAN_HISTORY_MAX_CHARS = 40_000
/** How many recent reflection day-files the deep clean audits. */
const DEEPCLEAN_HISTORY_DAYS = 31

const KNOWLEDGE_FILES: readonly KnowledgeFile[] = [
  'projects',
  'people',
  'preferences',
  'technical',
  'decisions'
]

// ── Prompts ───────────────────────────────────────────────────────────

export const REFLECTION_SYSTEM_PROMPT = `You are the reflection pass of a personal AI agent, reviewing ONE finished conversation the agent had with its user (or ran unattended as an automation). Your output becomes the agent's long-term training signal, so honesty beats flattery and evidence beats speculation.

Score honestly. Your self-score must reflect what actually happened, not effort — the user's own words in the transcript are the strongest evidence. A turn that annoyed the user, wasted work, or failed silently is a low score even if tools "succeeded".

Extract only lessons this conversation actually EARNED:
- A "win" needs explicit user appreciation or a clearly better-than-usual outcome worth repeating — name the trigger so it can be reused.
- A "fail" must be ROOT-CAUSED and generalized: "web_fetch is blocked on site X — use the browser extension there" is a lesson; "web_fetch failed 14 times" is telemetry. Transient errors (rate limits, expired tokens, flaky network) are only lessons when there is a durable workaround.
- A "pref" is something the USER stated or unmistakably implied about how they want things done. Never derive preferences from the agent's own behaviour, from a worker/sub-agent prompt, or from the mere existence of an automation schedule.
- Do not invent an "always/never" rule from a single ambiguous event. One occurrence = a note at most; a rule needs the user's words or repetition.
- Never copy secrets, API keys, tokens, passwords, or one-time codes into your output.

Output EXACTLY this block, nothing before or after (omit any line you have nothing real for — an empty conversation review is just header + outcome + score):

## <conversation title>
- outcome: <one plain sentence — what was attempted and how it actually ended>
- score: self=<0-10>
- win: <specific repeatable thing that worked + its trigger>
- fail: <root cause → the generalized fix/avoidance>
- pref: <new durable user preference, only if not already in the playbook you were shown>
- note: <anything else future turns genuinely need — rare>`

export const PLAYBOOK_MERGE_SYSTEM_PROMPT = `You maintain the PLAYBOOK of a personal AI agent: the distilled record of what its user likes and dislikes and what has been learned to work or fail. The playbook is injected into every future conversation, so every line must earn its place — this is a living document you REWRITE, not a log you append to.

You receive the current playbook plus new reflection blocks (per-conversation reviews). Produce the complete new playbook.

Rules:
- Structure — EXACTLY these five sections, in this order, and no others (re-home anything else into the closest fit; never invent your own section scheme):
  # Playbook
  ## Do
  ## Avoid
  ## User likes
  ## User dislikes
  ## Recipes
- Every entry is one tight line: the lesson, then "(source, YYYY-MM-DD)" where source is one of: user-said, inferred. Treat a legacy "user-scored" tag in the current playbook as user-said. When new evidence reinforces an existing entry, keep ONE line and refresh its date. Merge near-duplicates aggressively.
- Contradictions: the newest evidence wins; drop the old line (add "(changed YYYY-MM-DD)" if the reversal itself matters).
- Decay: DELETE "inferred" entries whose date is older than 30 days unless tonight's blocks reinforce them. "user-said" entries persist until contradicted.
- A failure lesson with user-visible impact AND a durable fix (e.g. "auth expired silently → alert the user on their notification channel") MUST land in Avoid or Do — never discard it as operational noise. It leaves the playbook only when later evidence shows it fixed or wrong.
- Recipes are short imperative playbooks for recurring tasks ("Daily digest: check memory for past editions first; no repeats; Arabic for LinkedIn"). Only recurring, only proven.
- HARD LIMIT: total output under ${PLAYBOOK_MAX_CHARS} characters. Over budget → compress wording first, then drop the weakest inferred entries. Never pad; a short honest playbook beats a full noisy one.
- No secrets, keys, tokens, or passwords, ever.

Output the playbook content ONLY — starting with "# Playbook", no fences, no commentary.`

export const DEEPCLEAN_SYSTEM_PROMPT = `You are the monthly ADVERSARIAL AUDITOR of a personal AI agent's self-learned memory. The nightly passes ADD; your stance is the opposite — try to KILL what does not deserve to survive. This audit is the structural guard against the agent boxing itself into stale rules and self-reinforcing habits.

You receive the current playbook, the five long-term knowledge files, and the recent reflection history. Attack them:
- Stale: entries whose evidence is old and unreinforced in the reflection history.
- Over-general: "always/never" rules built on one incident — weaken or delete.
- Contradicted: entries the recent history argues against.
- Redundant: near-duplicates across entries or across files — merge to one canonical line.
- Misfiled or corrupted: facts attached to the wrong person/project, orphan fragments, junk headers with no content.
- Wrong register: telemetry or one-off session trivia masquerading as durable knowledge.

Output format — one block per section, each opened by a marker line of exactly five equals signs, the file name, five equals signs:

===== audit =====
<short prose report: what you killed, merged, or challenged and why; what you deliberately left alone; 10-20 lines>

Then, ONLY for files you actually changed, the complete replacement content:
===== playbook.md =====
===== projects.md =====
===== people.md =====
===== preferences.md =====
===== technical.md =====
===== decisions.md =====

Rules for replacements: complete file content, starting with the file's "# Header" line. STRUCTURE IS MANDATORY, not stylistic:
- Knowledge files: every entity/topic is a "## Section" heading with tight factual bullets underneath — NEVER a flat bullet list under the "# Header" (the agent's memory map surfaces the "##" headings; a flat file is invisible to it). Example shape:
  # People
  <!-- scope comment -->
  ## Sana (wife)
  - WhatsApp \`+9665…\`. Daily funny-romantic meme; formats tracked to avoid repeats.
- playbook.md: EXACTLY these five section headings, in this order, nothing else — "# Playbook" then "## Do", "## Avoid", "## User likes", "## User dislikes", "## Recipes" — and its ${PLAYBOOK_MAX_CHARS}-character limit. Re-home any content into the closest of the five.
Preserve facts that are true and load-bearing — this is an audit, not an amnesia pass. No fences, no commentary outside the blocks, no secrets.`

// ── Multi-file block parsing (shared with brainstem's compaction v2) ──

/**
 * Parse `===== name =====` delimited blocks out of an LLM response. Tolerant:
 * 3+ equals signs on either side, optional whitespace, case-insensitive
 * names, and a block body optionally wrapped in markdown fences (stripped).
 * Returns an insertion-ordered map of name → body.
 */
export function parseFileBlocks(response: string): Map<string, string> {
  const out = new Map<string, string>()
  const lines = response.split(/\r?\n/)
  let current: string | null = null
  let buf: string[] = []
  const flush = (): void => {
    if (current === null) return
    out.set(current, stripFences(buf.join('\n')).trim())
  }
  for (const line of lines) {
    const m = /^\s*={3,}\s*([A-Za-z0-9._-]+)\s*={3,}\s*$/.exec(line)
    if (m) {
      flush()
      current = m[1].toLowerCase()
      buf = []
      continue
    }
    if (current !== null) buf.push(line)
  }
  flush()
  return out
}

function stripFences(text: string): string {
  let t = text.trim()
  const open = /^```[A-Za-z]*\s*\n/.exec(t)
  if (open) t = t.slice(open[0].length)
  if (t.endsWith('```')) t = t.slice(0, -3)
  return t
}

// ── Reviewed index ────────────────────────────────────────────────────

type ReviewedEntry = {
  /** Epoch ms this review completed. */
  at: number
  /** The conversation's updatedAt as of the review — continued conversations re-review. */
  updatedAt: number
  selfScore: number | null
  /** Set when the conversation was marked reviewed without an LLM call. */
  skipped?: string
}

type ReviewedIndex = {
  /** Reserved bookkeeping slot (not a conversation). */
  __meta__?: { lastPlaybookMergeDay?: string }
} & Record<string, ReviewedEntry | { lastPlaybookMergeDay?: string } | undefined>

async function readReviewedIndex(workspaceRoot: string): Promise<ReviewedIndex> {
  try {
    const raw = await fs.readFile(path.join(workspaceRoot, REVIEWED_REL), 'utf8')
    const parsed = JSON.parse(raw) as ReviewedIndex
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

async function writeReviewedIndex(workspaceRoot: string, index: ReviewedIndex): Promise<void> {
  const abs = path.join(workspaceRoot, REVIEWED_REL)
  await diskWriter.update(abs, () => JSON.stringify(index, null, 2))
}

function pruneReviewedIndex(index: ReviewedIndex, now: number): void {
  const cutoff = now - REVIEWED_RETENTION_DAYS * 24 * 60 * 60 * 1000
  for (const key of Object.keys(index)) {
    if (key === '__meta__') continue
    const entry = index[key] as ReviewedEntry | undefined
    if (!entry || typeof entry.at !== 'number' || entry.at < cutoff) delete index[key]
  }
}

// ── Transcript rendering ──────────────────────────────────────────────

function renderMessage(msg: ConversationMessage): string {
  const parts: string[] = []
  const text = msg.content?.trim()
  if (text) parts.push(cap(text, MESSAGE_MAX_CHARS))
  for (const seg of msg.segments ?? []) {
    if (seg.kind === 'tool_call') {
      parts.push(`[tool ${seg.name}]`)
    } else if (seg.kind === 'tool_result') {
      if (seg.status === 'success') {
        if (seg.output) parts.push(`[ok: ${cap(oneLine(seg.output), TOOL_RESULT_MAX_CHARS)}]`)
      } else {
        parts.push(
          `[${seg.status}: ${cap(oneLine(seg.error ?? seg.output ?? ''), TOOL_FAILURE_MAX_CHARS)}]`
        )
      }
    }
  }
  if (
    msg.role === 'assistant' &&
    (msg.stopReason === 'error' ||
      msg.stopReason === 'max_tokens' ||
      msg.stopReason === 'no_provider_available')
  ) {
    parts.push(`[turn ended: ${msg.stopReason}]`)
  }
  if (msg.role === 'assistant' && msg.error) {
    parts.push(`[turn error: ${cap(oneLine(msg.error), 300)}]`)
  }
  return `${msg.role}:\n${parts.join('\n')}`
}

/**
 * Render one conversation for the review call: provenance header, the
 * rolling summary when one exists, then the transcript with tool outcomes.
 * Over budget, the MIDDLE is dropped — openings carry the ask, endings
 * carry the resolution.
 */
export function renderConversationForReflection(conv: ConversationFile): string {
  const origin =
    conv.channel === 'heartbeat' || conv.channel === 'procedure'
      ? `${conv.channel} automation — ran unattended; the opening user message is the automation's own prompt, which the user authored when they set it up`
      : (conv.channel ?? 'electron')
  const header = [
    `Conversation: ${conv.title}`,
    `Origin: ${origin}`,
    `Started: ${new Date(conv.createdAt).toISOString()}`,
    `Messages: ${conv.messages.length}`
  ].join('\n')

  const rendered = conv.messages.map((m) => renderMessage(m))
  let body = rendered.join('\n\n')
  if (body.length > TRANSCRIPT_MAX_CHARS) {
    // Keep head and tail whole messages; drop from the middle.
    const head: string[] = []
    const tail: string[] = []
    let headLen = 0
    let tailLen = 0
    const headBudget = Math.floor(TRANSCRIPT_MAX_CHARS * 0.45)
    const tailBudget = Math.floor(TRANSCRIPT_MAX_CHARS * 0.45)
    for (const r of rendered) {
      if (headLen + r.length > headBudget) break
      head.push(r)
      headLen += r.length
    }
    for (let i = rendered.length - 1; i >= head.length; i--) {
      const r = rendered[i]
      if (tailLen + r.length > tailBudget) break
      tail.unshift(r)
      tailLen += r.length
    }
    const omitted = rendered.length - head.length - tail.length
    body = [...head, `[… ${omitted} messages omitted …]`, ...tail].join('\n\n')
  }

  const summary = conv.summary
    ? `\n\nRolling summary of earlier turns:\n${cap(conv.summary, 4_000)}`
    : ''
  return `${header}${summary}\n\nTranscript:\n\n${body}`
}

// ── LLM side-call (Brain, reasoning off, usage captured) ──────────────

type SideCallResult = {
  text: string
  provider: string | null
  model: string | null
  inputTokens: number
  outputTokens: number
}

/**
 * One reflection-family LLM call via the thalamus stream, tagged
 * role:'summary' (the utility side-call family: Brain model, mode-agnostic,
 * reasoning off, itemized off every conversation's meter). Wrapped in
 * runDetached so a run firing mid-chat can never leak its emits into a live
 * turn's relay — same sealing runCompaction uses.
 */
async function sideCall(
  thalamus: Thalamus,
  system: string,
  material: string
): Promise<SideCallResult> {
  const messages: ChatMessage[] = [{ role: 'user', content: material }]
  let text = ''
  let provider: string | null = null
  let model: string | null = null
  let inputTokens = 0
  let outputTokens = 0
  await runDetached(async () => {
    for await (const chunk of thalamus.stream({ system, messages, role: 'summary' })) {
      if (chunk.type === 'text') text += chunk.text
      else if (chunk.type === 'active_model') {
        provider = chunk.provider
        model = chunk.model
      } else if (chunk.type === 'turn_meta' && chunk.usage) {
        inputTokens += chunk.usage.inputTokens
        outputTokens += chunk.usage.outputTokens
      } else if (chunk.type === 'error') throw new Error(chunk.message)
    }
  })
  return { text: text.trim(), provider, model, inputTokens, outputTokens }
}

// ── Nightly reflection run ────────────────────────────────────────────

export type ReflectionDeps = {
  workspaceRoot: string
  thalamus: Thalamus
  corpus?: Corpus | null
  log?: (summary: string) => void
}

export type ReflectionRunResult = {
  reviewed: number
  skipped: number
  playbookUpdated: boolean
  provider: string | null
  model: string | null
  inputTokens: number
  outputTokens: number
  /** Human-readable digest for the settings last-run card. */
  output: string
}

export async function runNightlyReflection(
  deps: ReflectionDeps,
  quietHours: number
): Promise<ReflectionRunResult> {
  const { workspaceRoot, thalamus, corpus } = deps
  const log = deps.log ?? ((): void => undefined)
  const now = Date.now()
  const floor = now - LOOKBACK_DAYS * 24 * 60 * 60 * 1000
  const quietCutoff = now - quietHours * 60 * 60 * 1000

  const index = await readReviewedIndex(workspaceRoot)
  const metas = await listConversations()
  const eligible = metas
    .filter((m) => m.updatedAt >= floor && m.updatedAt <= quietCutoff)
    .filter((m) => {
      const prev = index[m.id] as ReviewedEntry | undefined
      return !prev || (prev.updatedAt ?? 0) < m.updatedAt
    })
    .sort((a, b) => a.updatedAt - b.updatedAt)

  log(
    `${eligible.length} conversation(s) eligible (quiet ≥ ${quietHours}h, ${LOOKBACK_DAYS}d window)`
  )

  const playbook = await readPlaybook(workspaceRoot)
  const blocks: string[] = []
  const cardLines: string[] = []
  let reviewed = 0
  let skipped = 0
  let provider: string | null = null
  let model: string | null = null
  let inputTokens = 0
  let outputTokens = 0

  for (const meta of eligible) {
    const conv = await loadConversation(meta.id)
    if (!conv) continue
    const hasAssistant = conv.messages.some((m) => m.role === 'assistant' && m.content?.trim())
    if (!hasAssistant || conv.messages.length < 2) {
      index[meta.id] = {
        at: Date.now(),
        updatedAt: meta.updatedAt,
        selfScore: null,
        skipped: 'no reviewable exchange'
      }
      skipped += 1
      continue
    }

    const material =
      `CURRENT PLAYBOOK (for dedup — do not re-report what it already covers):\n` +
      `${playbook ? cap(playbook, PLAYBOOK_MAX_CHARS + 500) : '(empty — nothing learned yet)'}\n\n` +
      `CONVERSATION TO REVIEW:\n\n${renderConversationForReflection(conv)}`

    let result: SideCallResult
    try {
      result = await sideCall(thalamus, REFLECTION_SYSTEM_PROMPT, material)
    } catch (err) {
      // Leave the conversation unreviewed — the next night retries it.
      log(`review failed for ${meta.id}: ${err instanceof Error ? err.message : String(err)}`)
      continue
    }
    if (!result.text) continue

    provider = result.provider ?? provider
    model = result.model ?? model
    inputTokens += result.inputTokens
    outputTokens += result.outputTokens

    const day = formatDay(new Date())
    const block = `${result.text.trim()}\n<!-- conversation:${conv.id} reviewed:${new Date().toISOString()} -->`
    await appendReflectionBlock(workspaceRoot, day, block)

    const selfScore = parseSelfScore(result.text)
    index[meta.id] = {
      at: Date.now(),
      updatedAt: meta.updatedAt,
      selfScore
    }
    corpus?.emit('reflection.reviewed', { conversation: conv.id, selfScore })
    reviewed += 1
    blocks.push(result.text.trim())
    cardLines.push(
      `- ${conv.title} — self ${selfScore ?? '—'}${conv.channel && conv.channel !== 'electron' ? ` (${conv.channel})` : ''}`
    )
    log(`reviewed "${conv.title}" (self ${selfScore ?? '—'})`)
  }

  pruneReviewedIndex(index, now)

  // Fold the unmerged reflection days into the playbook. Tonight's blocks
  // are already on disk in today's day-file, so reading the pending days
  // covers them — and any earlier day whose merge failed self-heals here,
  // because lastPlaybookMergeDay only advances on a successful merge.
  let playbookUpdated = false
  const meta = (index.__meta__ ?? {}) as { lastPlaybookMergeDay?: string }
  index.__meta__ = meta
  const pendingDays = await unmergedReflectionDays(workspaceRoot, meta.lastPlaybookMergeDay)
  const pendingBlocks = await readReflectionDays(workspaceRoot, pendingDays)
  if (pendingBlocks.length > 0) {
    const material =
      `CURRENT PLAYBOOK:\n${playbook || '(empty — first merge)'}\n\n` +
      `NEW REFLECTION BLOCKS:\n\n${cap(pendingBlocks.join('\n\n'), 50_000)}`
    try {
      const result = await sideCall(thalamus, PLAYBOOK_MERGE_SYSTEM_PROMPT, material)
      provider = result.provider ?? provider
      model = result.model ?? model
      inputTokens += result.inputTokens
      outputTokens += result.outputTokens
      const next = sanitizePlaybook(result.text)
      if (next) {
        await writePlaybook(workspaceRoot, next)
        meta.lastPlaybookMergeDay = formatDay(new Date())
        playbookUpdated = true
        corpus?.emit('reflection.playbookUpdated', {
          day: meta.lastPlaybookMergeDay,
          bytes: next.length
        })
        log(`playbook updated (${next.length} chars)`)
      } else {
        log('playbook merge output rejected — keeping previous playbook')
      }
    } catch (err) {
      log(`playbook merge failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  await writeReviewedIndex(workspaceRoot, index)

  const summaryHead =
    `Reviewed ${reviewed} conversation(s)` +
    (skipped > 0 ? `, ${skipped} skipped (nothing reviewable)` : '') +
    `. Playbook ${playbookUpdated ? 'updated' : 'unchanged'}.`
  const output = cap([summaryHead, ...cardLines].join('\n'), 4_000)
  return { reviewed, skipped, playbookUpdated, provider, model, inputTokens, outputTokens, output }
}

// ── Monthly deep clean ────────────────────────────────────────────────

export type DeepCleanResult = {
  changedFiles: string[]
  provider: string | null
  model: string | null
  inputTokens: number
  outputTokens: number
  output: string
}

export async function runDeepClean(
  deps: ReflectionDeps & { hippocampus: Hippocampus }
): Promise<DeepCleanResult> {
  const { workspaceRoot, thalamus, hippocampus, corpus } = deps
  const log = deps.log ?? ((): void => undefined)

  const playbook = await readPlaybook(workspaceRoot)
  const knowledge: string[] = []
  for (const file of KNOWLEDGE_FILES) {
    const raw = await readWorkspaceFile(workspaceRoot, `brain/hippocampus/knowledge/${file}.md`)
    knowledge.push(`===== ${file}.md =====\n${raw ?? '(empty)'}`)
  }
  const historyDays = await recentReflectionDays(workspaceRoot, DEEPCLEAN_HISTORY_DAYS)
  const history = cap(
    (await readReflectionDays(workspaceRoot, historyDays)).join('\n\n'),
    DEEPCLEAN_HISTORY_MAX_CHARS
  )

  const material =
    `===== playbook.md =====\n${playbook || '(empty)'}\n\n` +
    `${knowledge.join('\n\n')}\n\n` +
    `RECENT REFLECTION HISTORY (evidence for what is reinforced vs stale):\n${history || '(none yet)'}`

  const result = await sideCall(thalamus, DEEPCLEAN_SYSTEM_PROMPT, material)
  const sections = parseFileBlocks(result.text)
  const audit = sections.get('audit') ?? result.text.trim()
  const changedFiles: string[] = []

  const nextPlaybook = sections.get('playbook.md')
  if (nextPlaybook) {
    const sanitized = sanitizePlaybook(nextPlaybook)
    if (sanitized) {
      await writePlaybook(workspaceRoot, sanitized)
      changedFiles.push('playbook.md')
    }
  }
  for (const file of KNOWLEDGE_FILES) {
    const next = sections.get(`${file}.md`)
    if (next && next.startsWith('# ') && next.length > 100) {
      await hippocampus.replaceKnowledgeFile(file, next)
      changedFiles.push(`${file}.md`)
    }
  }

  corpus?.emit('reflection.deepCleaned', { changedFiles })
  log(
    changedFiles.length > 0
      ? `deep clean rewrote: ${changedFiles.join(', ')}`
      : 'deep clean: no changes needed'
  )

  const output = cap(
    `${changedFiles.length > 0 ? `Rewrote ${changedFiles.join(', ')}.` : 'No changes needed.'}\n\n${audit}`,
    4_000
  )
  return {
    changedFiles,
    provider: result.provider,
    model: result.model,
    inputTokens: result.inputTokens,
    outputTokens: result.outputTokens,
    output
  }
}

// ── Playbook I/O ──────────────────────────────────────────────────────

export async function readPlaybook(workspaceRoot: string): Promise<string | null> {
  return readWorkspaceFile(workspaceRoot, PLAYBOOK_REL)
}

/**
 * Replace the playbook, keeping the previous version as playbook.md.bak —
 * the one-click restore path if a bad merge ever degrades the distillate
 * (a nightly LLM call edits an always-injected prompt block; the backup is
 * the blast-radius control).
 */
export async function writePlaybook(workspaceRoot: string, content: string): Promise<void> {
  const abs = path.join(workspaceRoot, PLAYBOOK_REL)
  const previous = await readWorkspaceFile(workspaceRoot, PLAYBOOK_REL)
  if (previous && previous.trim().length > 0) {
    await diskWriter.update(`${abs}.bak`, () => previous)
  }
  const body = content.endsWith('\n') ? content : `${content}\n`
  await diskWriter.update(abs, () => body)
}

/** Reject merge output that is clearly not a playbook (guards the ambient prompt). */
function sanitizePlaybook(text: string): string | null {
  let t = stripFences(text).trim()
  if (!t) return null
  const firstHash = t.indexOf('# Playbook')
  if (firstHash === -1) return null
  t = t.slice(firstHash)
  if (t.length < 40) return null
  if (t.length > PLAYBOOK_MAX_CHARS * 1.5) t = `${t.slice(0, PLAYBOOK_MAX_CHARS * 1.5)}…`
  return t
}

// ── Reflection day-file helpers ───────────────────────────────────────

async function appendReflectionBlock(
  workspaceRoot: string,
  day: string,
  block: string
): Promise<void> {
  const abs = path.join(workspaceRoot, REFLECTION_DIR, `${day}.md`)
  const entry = `${block}\n\n`
  await diskWriter.appendWithInit(abs, (exists) =>
    exists ? entry : `# Reflection ${day}\n\n${entry}`
  )
}

async function listReflectionDayFiles(workspaceRoot: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(path.join(workspaceRoot, REFLECTION_DIR))
    return entries.filter((n) => /^\d{4}-\d{2}-\d{2}\.md$/.test(n)).sort()
  } catch {
    return []
  }
}

/** Days on disk strictly AFTER the last merged day (all of them when never merged). */
async function unmergedReflectionDays(
  workspaceRoot: string,
  lastMergedDay: string | undefined
): Promise<string[]> {
  const files = await listReflectionDayFiles(workspaceRoot)
  const days = files.map((n) => n.replace(/\.md$/, ''))
  if (!lastMergedDay) return days.slice(-LOOKBACK_DAYS)
  return days.filter((d) => d > lastMergedDay)
}

async function recentReflectionDays(workspaceRoot: string, limit: number): Promise<string[]> {
  const files = await listReflectionDayFiles(workspaceRoot)
  return files.map((n) => n.replace(/\.md$/, '')).slice(-limit)
}

async function readReflectionDays(workspaceRoot: string, days: string[]): Promise<string[]> {
  const out: string[] = []
  for (const day of days) {
    const raw = await readWorkspaceFile(workspaceRoot, `${REFLECTION_DIR}/${day}.md`)
    if (raw && raw.trim().length > 0) out.push(raw.trim())
  }
  return out
}

// ── Small utilities ───────────────────────────────────────────────────

async function readWorkspaceFile(workspaceRoot: string, rel: string): Promise<string | null> {
  try {
    const raw = await fs.readFile(path.join(workspaceRoot, rel), 'utf8')
    return raw.length > 0 ? raw : null
  } catch {
    return null
  }
}

export function parseSelfScore(block: string): number | null {
  const m = /self\s*=\s*(10|\d)(?:\b|\/)/i.exec(block)
  if (!m) return null
  const n = Number(m[1])
  return Number.isFinite(n) && n >= 0 && n <= 10 ? n : null
}

function cap(text: string, max: number): string {
  if (text.length <= max) return text
  const head = Math.floor(max * 0.7)
  const tail = max - head - 40
  return `${text.slice(0, head)}\n…[${text.length - max} chars omitted]…\n${text.slice(text.length - tail)}`
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

function formatDay(d: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}
