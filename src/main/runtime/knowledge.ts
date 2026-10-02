import { diskWriter } from '@main/io/diskWriter'
import type { Corpus } from '@main/runtime/corpus'
import { Hippocampus } from '@main/runtime/hippocampus'
import { PLAYBOOK_MAX_CHARS } from '@main/runtime/reflection'
import fs from 'node:fs/promises'
import path from 'node:path'

/**
 * Knowledge — the editable surface of everything Wolffish believes long-term.
 *
 * Nine files carry the agent's durable self: who it is, who the user is, the
 * standing procedures, the behavioural lessons distilled nightly, and the five
 * curated fact files. Until this module they were WRITE-ONCE from the model's
 * side: `memory_save` could append a fact, and everything else was reachable
 * only by a nightly LLM pass. There was no way to correct a wrong fact, retire
 * a lesson the user had just contradicted, or amend a standing instruction —
 * the agent could learn but not UNLEARN, and a mistaken belief survived until
 * the monthly deep clean happened to notice it.
 *
 * This store is the amend path. It is deliberately NOT a file writer with a
 * path argument: the target set is a fixed allowlist, so the app-owned files
 * (agents.core.md, workflow.md — overwritten on every launch) can never be
 * edited into a false sense of persistence, and no traversal reaches outside
 * the brain. Every mutation keeps the previous version as `<file>.bak`, so
 * "unlearn" is always one `knowledge_restore` from undone.
 *
 * Structure is normalized IN CODE, never left to model discipline: the
 * playbook's five fixed sections and character ceiling, the knowledge files'
 * `## Entity` headings (the memory map keys on them), bullet shape, blank-line
 * collapse, empty-section pruning. The same invariants the nightly passes
 * enforce, enforced identically on the interactive path.
 */

export type KnowledgeTarget =
  | 'playbook'
  | 'instructions'
  | 'soul'
  | 'user'
  | 'projects'
  | 'people'
  | 'preferences'
  | 'technical'
  | 'decisions'

/** What kind of file a target is — drives structure normalization and prose vs. bullet shape. */
type TargetKind = 'playbook' | 'instructions' | 'identity' | 'knowledge'

type TargetSpec = {
  rel: string
  kind: TargetKind
  /** One line: what this file governs, shown by knowledge_list. */
  governs: string
  /** True when the file's full text rides in EVERY system prompt. */
  everyPrompt: boolean
  /** Required opening heading — a rewrite that loses it is rejected. */
  header: string
  /** Soft ceiling; a write that grows past it is rejected (shrinking always allowed). */
  maxChars: number
}

/**
 * The allowlist. Adding a row here is the ONLY way to make a file editable by
 * the agent — deliberately excluded: `brain/prefrontal/agents.core.md` and
 * `brain/identity/workflow*.md`, which workspace.ts overwrites on every launch
 * (an edit there would silently evaporate), and `brain/reflection/*.md` day
 * files plus `reviewed.json`, which are the raw audit trail the nightly merge
 * reads — rewriting history is not amending belief.
 */
const TARGETS: Record<KnowledgeTarget, TargetSpec> = {
  playbook: {
    rel: 'brain/reflection/playbook.md',
    kind: 'playbook',
    governs:
      'Behavioural lessons — what to do, what to avoid, what the user likes/dislikes, proven recipes',
    everyPrompt: true,
    header: '# Playbook',
    maxChars: PLAYBOOK_MAX_CHARS
  },
  instructions: {
    rel: 'brain/prefrontal/agents.md',
    kind: 'instructions',
    governs: 'Standing custom procedures and overrides — outrank the core contract on any conflict',
    everyPrompt: true,
    header: '',
    maxChars: 16_000
  },
  soul: {
    rel: 'brain/identity/soul.md',
    kind: 'identity',
    governs: 'Who you are — character, voice, standing manner',
    everyPrompt: true,
    header: '',
    maxChars: 16_000
  },
  user: {
    rel: 'brain/identity/user.md',
    kind: 'identity',
    governs: 'Who the user is — the durable profile you address every turn',
    everyPrompt: true,
    header: '',
    maxChars: 16_000
  },
  projects: {
    rel: 'brain/hippocampus/knowledge/projects.md',
    kind: 'knowledge',
    governs: 'Long-term facts about ongoing projects and work',
    everyPrompt: false,
    header: '# Projects',
    maxChars: 40_000
  },
  people: {
    rel: 'brain/hippocampus/knowledge/people.md',
    kind: 'knowledge',
    governs: 'Long-term facts about people in the user’s life',
    everyPrompt: false,
    header: '# People',
    maxChars: 40_000
  },
  preferences: {
    rel: 'brain/hippocampus/knowledge/preferences.md',
    kind: 'knowledge',
    governs: 'Long-term facts about how the user wants things done',
    everyPrompt: false,
    header: '# Preferences',
    maxChars: 40_000
  },
  technical: {
    rel: 'brain/hippocampus/knowledge/technical.md',
    kind: 'knowledge',
    governs: 'Long-term facts about the machine, stack, accounts and setup',
    everyPrompt: false,
    header: '# Technical',
    maxChars: 40_000
  },
  decisions: {
    rel: 'brain/hippocampus/knowledge/decisions.md',
    kind: 'knowledge',
    governs: 'Long-term record of decisions taken and why',
    everyPrompt: false,
    header: '# Decisions',
    maxChars: 40_000
  }
}

export const KNOWLEDGE_TARGETS = Object.keys(TARGETS) as KnowledgeTarget[]

/** The playbook's five fixed sections, in order. Enforced, not suggested. */
export const PLAYBOOK_SECTIONS = ['Do', 'Avoid', 'User likes', 'User dislikes', 'Recipes'] as const

/** Provenance vocabulary for playbook entries (mirrors the nightly merge prompt). */
export type EntrySource = 'user-said' | 'user-scored' | 'inferred'

export type TargetInfo = {
  target: KnowledgeTarget
  rel: string
  governs: string
  everyPrompt: boolean
  bytes: number
  maxChars: number
  /** `##` headings in the file, in order — the amendable anchors. */
  sections: string[]
  entries: number
  updatedAt: string | null
  hasBackup: boolean
}

export type KnowledgeResult =
  | { ok: true; message: string; warning?: string }
  | { ok: false; error: string }

/**
 * What one operation decides once it has seen the file's current bytes:
 * produce new content, refuse with a reason, or report that nothing needed to
 * change. Computed INSIDE the write queue (see commit) so the bytes it read
 * are the bytes it writes over.
 */
type PlanOutcome = { next: string; message: string } | { error: string } | { unchanged: string }

/** What actually landed on disk, captured inside the write queue. */
type WriteRecord = { body: string; previous: string }

export type KnowledgeStoreOptions = {
  workspaceRoot: string
  corpus?: Corpus
  /**
   * Called when a write changed the `##` headings of a knowledge file. The
   * memory map is cached per calendar day for prompt-cache stability, so a
   * new topic would otherwise stay invisible to the model until tomorrow —
   * this is the targeted invalidation, fired only on a real heading change so
   * ordinary fact edits still cost no cache break.
   */
  onKnowledgeTopicsChanged?: () => void
}

export function isKnowledgeTarget(value: unknown): value is KnowledgeTarget {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(TARGETS, value)
}

export class KnowledgeStore {
  private workspaceRoot: string
  private corpus?: Corpus
  private onTopicsChanged?: () => void

  constructor(options: KnowledgeStoreOptions) {
    this.workspaceRoot = options.workspaceRoot
    this.corpus = options.corpus
    this.onTopicsChanged = options.onKnowledgeTopicsChanged
  }

  // ── Read side ───────────────────────────────────────────────────────

  /** The map of every editable surface: size, anchors, backup availability. */
  async list(): Promise<TargetInfo[]> {
    const out: TargetInfo[] = []
    for (const target of KNOWLEDGE_TARGETS) {
      const spec = TARGETS[target]
      const abs = this.abs(target)
      const content = (await readText(abs)) ?? ''
      let updatedAt: string | null = null
      try {
        updatedAt = (await fs.stat(abs)).mtime.toISOString()
      } catch {
        updatedAt = null
      }
      out.push({
        target,
        rel: spec.rel,
        governs: spec.governs,
        everyPrompt: spec.everyPrompt,
        bytes: content.length,
        maxChars: spec.maxChars,
        sections: sectionsOf(content),
        entries: content.split(/\r?\n/).filter((l) => /^\s*[-*]\s+\S/.test(l)).length,
        updatedAt,
        hasBackup: await exists(`${abs}.bak`)
      })
    }
    return out
  }

  async read(target: KnowledgeTarget): Promise<{ rel: string; content: string }> {
    const spec = TARGETS[target]
    const content = (await readText(this.abs(target))) ?? ''
    return { rel: spec.rel, content }
  }

  // ── Write side ──────────────────────────────────────────────────────

  /**
   * Add one entry. Playbook entries are stamped `(source, YYYY-MM-DD)` in code
   * when the model omits it — the provenance the nightly merge reads to decide
   * decay is a mechanical invariant, not something to hope for in the prompt.
   */
  async add(
    target: KnowledgeTarget,
    entry: string,
    opts: { section?: string; source?: EntrySource } = {}
  ): Promise<KnowledgeResult> {
    const spec = TARGETS[target]
    const trimmed = entry.trim()
    if (!trimmed) return { ok: false, error: 'Provide `entry` — the line to add.' }

    return this.commit(target, 'add', (current) => {
      let section = opts.section?.trim() || ''
      if (spec.kind === 'playbook') {
        const resolved = PLAYBOOK_SECTIONS.find((s) => s.toLowerCase() === section.toLowerCase())
        if (!resolved) {
          return {
            error: `The playbook has exactly five sections — pass \`section\` as one of: ${PLAYBOOK_SECTIONS.join(', ')}.`
          }
        }
        section = resolved
      }

      // A sectioned knowledge file has no "end of file" that means anything:
      // a bullet appended after the last heading reads as belonging to THAT
      // topic, so an unsectioned add silently misfiles the fact under whoever
      // happens to be last. Ask instead of guessing. (memory_save's flat
      // append stays the unsectioned path; the nightly rewrite folds it in.)
      const existing = sectionsOf(current)
      if (spec.kind === 'knowledge' && !section && existing.length > 0) {
        return {
          error: `${spec.rel} is organized by topic — pass \`section\` (existing: ${existing.join(', ')}) or a new one.`
        }
      }

      const line = this.shapeEntry(spec.kind, trimmed, opts.source)

      // Dedup ignores the `(source, date)` stamp: the same lesson re-learned on
      // a later day is the SAME entry, and appending a second copy differing
      // only by date is how the pre-reflection knowledge files filled with 13
      // duplicates of one fact.
      const key = (s: string): string =>
        s
          .replace(/\((user-said|user-scored|inferred),\s*\d{4}-\d{2}-\d{2}\)\s*$/, '')
          .trim()
          .toLowerCase()
      if (key(line).length > 0 && current.split(/\r?\n/).some((l) => key(l) === key(line))) {
        return { unchanged: `Already in ${spec.rel} — nothing added.` }
      }

      return {
        next: insertEntry(current || this.seed(target), line, section, spec.kind),
        message: `Added to ${spec.rel}${section ? ` under “${section}”` : ''}.`
      }
    })
  }

  /**
   * Amend an existing entry in place. `find` must match exactly once — the
   * uniqueness guard is what keeps a sloppy anchor from rewriting the wrong
   * belief. Falls back to whitespace-insensitive whole-line matching before
   * giving up, and names near-misses when it does.
   */
  async edit(target: KnowledgeTarget, find: string, replace: string): Promise<KnowledgeResult> {
    const spec = TARGETS[target]
    return this.commit(target, 'edit', (current) => {
      if (!current) return { error: `${spec.rel} is empty — nothing to edit.` }
      const span = locate(current, find)
      if ('error' in span) return { error: span.error }
      const replacement = replace.trim()
      if (!replacement) {
        return { error: 'Empty `replace` — use knowledge_forget to remove an entry instead.' }
      }
      return {
        next: current.slice(0, span.start) + replacement + current.slice(span.end),
        message: `Amended ${spec.rel}.`
      }
    })
  }

  /**
   * Unlearn: delete the matching entry outright. Whole lines go, not just the
   * matched substring — "forget that she works at Acme" should not leave a
   * dangling half-bullet — and a knowledge section left with no facts is
   * pruned so the memory map stops advertising a topic that no longer exists.
   */
  async forget(target: KnowledgeTarget, find: string): Promise<KnowledgeResult> {
    const spec = TARGETS[target]
    return this.commit(target, 'forget', (current) => {
      if (!current) return { error: `${spec.rel} is empty — nothing to forget.` }
      const span = locate(current, find)
      if ('error' in span) return { error: span.error }

      // Targeting a `## Heading` means "forget this whole topic" — dropping the
      // heading alone would strand its facts under the PREVIOUS topic, which is
      // worse than not forgetting at all.
      const lines = expandToLines(current, span)
      const range = /^##\s/.test(current.slice(lines.start, lines.end).trimStart())
        ? expandThroughSection(current, lines)
        : lines
      const removed = current.slice(range.start, range.end).trim()
      let next = current.slice(0, range.start) + current.slice(range.end)
      if (spec.kind === 'knowledge') next = pruneEmptySections(next)

      if (stripStructure(next, spec).length === 0) {
        return {
          error: `That would empty ${spec.rel} completely. Use knowledge_rewrite if you really mean to clear it.`
        }
      }
      return { next, message: `Forgot from ${spec.rel}: ${oneLine(removed).slice(0, 160)}` }
    })
  }

  /** Full replacement — the restructuring path (merge duplicates, re-home entries). */
  async rewrite(target: KnowledgeTarget, content: string): Promise<KnowledgeResult> {
    const spec = TARGETS[target]
    const body = content.trim()
    return this.commit(target, 'rewrite', () => {
      if (!body) return { error: 'Empty `content` — refusing to blank the file.' }
      if (spec.header && !body.startsWith(spec.header)) {
        return {
          error: `${spec.rel} must start with "${spec.header}" — send the complete file, not a fragment.`
        }
      }
      return { next: body, message: `Rewrote ${spec.rel}.` }
    })
  }

  /**
   * Undo the last write by swapping the file with its `.bak`. A swap rather
   * than a one-way copy, so restore is itself undoable — the safety net for an
   * unlearn the user immediately regrets.
   */
  async restore(target: KnowledgeTarget): Promise<KnowledgeResult> {
    const spec = TARGETS[target]
    const abs = this.abs(target)
    let outcome: KnowledgeResult = { ok: false, error: `Could not restore ${spec.rel}.` }
    const swapped: { rec: WriteRecord | null } = { rec: null }

    try {
      // Same queue discipline as commit(): read the backup, read the current
      // bytes, and write both halves of the swap as one step. Reading either
      // side outside the queue can swap in a version a concurrent edit already
      // superseded.
      await diskWriter.update(abs, async (raw) => {
        const backup = await readText(`${abs}.bak`)
        if (!backup || !backup.trim()) {
          outcome = { ok: false, error: `No backup for ${spec.rel} — nothing to restore.` }
          return null
        }
        const current = raw ?? ''
        const body = this.normalize(spec, backup.trim())
        if (current.trim()) await diskWriter.update(`${abs}.bak`, () => current)
        swapped.rec = { body, previous: current }
        outcome = {
          ok: true,
          message: `Restored ${spec.rel} from backup (${body.length} chars). The version you replaced is now the backup — restore again to swap back.`
        }
        return `${body}\n`
      })
    } catch (err) {
      return { ok: false, error: `Could not restore ${spec.rel}: ${message(err)}` }
    }

    if (swapped.rec) this.announce(target, 'restore', swapped.rec.body, swapped.rec.previous)
    return outcome
  }

  // ── Shared write path ───────────────────────────────────────────────

  /**
   * Every mutation funnels here: normalize structure, enforce the ceiling,
   * back up the previous bytes, write atomically, announce. One chokepoint
   * means no operation can skip a guard by accident.
   */
  private async commit(
    target: KnowledgeTarget,
    op: 'add' | 'edit' | 'forget' | 'rewrite',
    plan: (current: string) => PlanOutcome
  ): Promise<KnowledgeResult> {
    const spec = TARGETS[target]
    const abs = this.abs(target)

    let outcome: KnowledgeResult = { ok: false, error: `Could not write ${spec.rel}.` }
    // A holder rather than a bare `let`: TypeScript's flow analysis does not
    // track assignments made inside a callback, and narrows a closure-assigned
    // variable to `never` at the use site. Property narrowing resets after a
    // call, so this reads back correctly.
    const wrote: { rec: WriteRecord | null } = { rec: null }

    try {
      // The ENTIRE decision runs inside the file's write queue: the read the
      // plan is computed from, the dedup probe, the ceiling check and the write
      // are one atomic step. Reading outside the queue is the classic
      // two-writers clobber — and with concurrent conversations, two turns can
      // genuinely amend the same knowledge file in the same instant, so the
      // second edit would silently erase the first.
      await diskWriter.update(abs, async (raw) => {
        const previous = raw ?? ''
        const planned = plan(previous)
        if ('error' in planned) {
          outcome = { ok: false, error: planned.error }
          return null
        }
        if ('unchanged' in planned) {
          outcome = { ok: true, message: planned.unchanged }
          return null
        }

        const body = this.normalize(spec, planned.next)
        if (body.trim() === previous.trim()) {
          outcome = { ok: true, message: `No change — ${spec.rel} already reads that way.` }
          return null
        }
        // Shrinking an already-oversized file must always be allowed; only
        // growth past the ceiling is refused, or an over-budget file would be
        // permanently unfixable.
        if (body.length > spec.maxChars && body.length > previous.length) {
          outcome = {
            ok: false,
            error: `${spec.rel} would be ${body.length} chars, over its ${spec.maxChars} ceiling${
              spec.everyPrompt ? ' (this file rides in every prompt)' : ''
            }. Compress or remove weaker entries first.`
          }
          return null
        }

        // `.bak` is a different path, so a different write queue — awaiting it
        // from inside this one cannot deadlock.
        if (previous.trim()) await diskWriter.update(`${abs}.bak`, () => previous)

        wrote.rec = { body, previous }
        const warning = this.warn(spec, body)
        outcome = warning
          ? { ok: true, message: planned.message, warning }
          : { ok: true, message: planned.message }
        return `${body}\n`
      })
    } catch (err) {
      return { ok: false, error: `Could not write ${spec.rel}: ${message(err)}` }
    }

    // Announce AFTER the queue releases: a corpus listener that turns around
    // and reads the file must not do so while the write is still in flight.
    if (wrote.rec) this.announce(target, op, wrote.rec.body, wrote.rec.previous)
    return outcome
  }

  /** Structure invariants applied in code — the same ones the nightly passes enforce. */
  private normalize(spec: TargetSpec, draft: string): string {
    let body = tidy(draft)
    if (spec.header && !body.startsWith('#')) body = `${spec.header}\n\n${body}`
    if (spec.kind === 'knowledge') body = Hippocampus.normalizeKnowledgeStructure(body)
    return body.trim()
  }

  /** Non-blocking structural notes the model should see but that must not fail a write. */
  private warn(spec: TargetSpec, body: string): string | undefined {
    if (spec.kind === 'playbook') {
      const have = new Set(sectionsOf(body).map((s) => s.toLowerCase()))
      const missing = PLAYBOOK_SECTIONS.filter((s) => !have.has(s.toLowerCase()))
      if (missing.length > 0) return `Playbook is missing section(s): ${missing.join(', ')}.`
      const extra = sectionsOf(body).filter(
        (s) => !PLAYBOOK_SECTIONS.some((p) => p.toLowerCase() === s.toLowerCase())
      )
      if (extra.length > 0) {
        return `Playbook has non-standard section(s): ${extra.join(', ')} — the nightly merge will re-home them.`
      }
    }
    if (spec.everyPrompt && body.length > spec.maxChars * 0.85) {
      return `${body.length}/${spec.maxChars} chars — close to the ceiling for a file that rides in every prompt.`
    }
    return undefined
  }

  private announce(target: KnowledgeTarget, op: string, body: string, previous: string): void {
    const spec = TARGETS[target]
    this.corpus?.emit('knowledge.edited', { target, rel: spec.rel, op, bytes: body.length })
    if (spec.kind === 'knowledge' && sectionsOf(body).join(' ') !== sectionsOf(previous).join(' ')) {
      this.onTopicsChanged?.()
    }
  }

  private shapeEntry(kind: TargetKind, entry: string, source?: EntrySource): string {
    // Prose files (identity, custom instructions) take the text as written —
    // forcing a bullet onto a paragraph of voice guidance mangles it.
    if (kind === 'identity' || kind === 'instructions') return entry
    const bullet = /^([-*]|\d+\.)\s/.test(entry) ? entry : `- ${entry}`
    if (kind !== 'playbook') return bullet
    // `(source, YYYY-MM-DD)` is what the nightly decay pass reads. Stamp it
    // when absent rather than trusting the caller to remember the contract.
    if (/\((user-said|user-scored|inferred),\s*\d{4}-\d{2}-\d{2}\)\s*$/.test(bullet)) return bullet
    return `${bullet} (${source ?? 'user-said'}, ${today()})`
  }

  /** Minimal valid file for a target that doesn't exist yet. */
  private seed(target: KnowledgeTarget): string {
    const spec = TARGETS[target]
    if (spec.kind === 'playbook') {
      return `# Playbook\n\n${PLAYBOOK_SECTIONS.map((s) => `## ${s}`).join('\n\n')}\n`
    }
    return spec.header ? `${spec.header}\n` : ''
  }

  private abs(target: KnowledgeTarget): string {
    return path.join(this.workspaceRoot, TARGETS[target].rel)
  }
}

// ── Text mechanics ────────────────────────────────────────────────────

/**
 * Find `needle` in `content` and demand exactly one hit. Exact substring
 * first; then whitespace-insensitive whole-line matching, because a model
 * re-typing a bullet from memory gets the words right and the spacing wrong.
 * Anything else is an error that names the ambiguity instead of guessing.
 */
export function locate(
  content: string,
  needle: string
): { start: number; end: number } | { error: string } {
  const find = needle.trim()
  if (!find) return { error: 'Provide `find` — an excerpt of the entry to target.' }

  const hits: number[] = []
  for (let i = content.indexOf(find); i !== -1; i = content.indexOf(find, i + 1)) {
    hits.push(i)
    if (hits.length > 1) break
  }
  if (hits.length === 1) return { start: hits[0], end: hits[0] + find.length }
  if (hits.length > 1) {
    return { error: `“${clip(find)}” matches more than once — pass a longer, unique excerpt.` }
  }

  const norm = (s: string): string => s.replace(/\s+/g, ' ').trim().toLowerCase()
  const target = norm(find)
  const lines = content.split('\n')
  const matches: Array<{ start: number; end: number }> = []
  let offset = 0
  for (const line of lines) {
    if (target.length > 0 && norm(line).includes(target)) {
      matches.push({ start: offset, end: offset + line.length })
    }
    offset += line.length + 1
  }
  if (matches.length === 1) return matches[0]
  if (matches.length > 1) {
    return {
      error: `“${clip(find)}” matches ${matches.length} lines — pass a longer, unique excerpt.`
    }
  }

  const near = nearest(lines, target)
  return {
    error:
      `No entry matches “${clip(find)}”.` +
      (near.length > 0 ? ` Closest lines: ${near.map((l) => `“${clip(l)}”`).join('; ')}` : '') +
      ' Read the file first (knowledge_read) and copy the entry verbatim.'
  }
}

/** Grow a span to cover the whole lines it touches, including the trailing newline. */
export function expandToLines(
  content: string,
  span: { start: number; end: number }
): { start: number; end: number } {
  let start = content.lastIndexOf('\n', span.start - 1) + 1
  let end = content.indexOf('\n', span.end)
  end = end === -1 ? content.length : end + 1
  // A bullet's continuation lines (indented, no bullet marker) belong to it.
  while (end < content.length) {
    const nextEnd = content.indexOf('\n', end)
    const line = content.slice(end, nextEnd === -1 ? content.length : nextEnd)
    if (!/^\s+\S/.test(line)) break
    end = nextEnd === -1 ? content.length : nextEnd + 1
  }
  if (start > 0 && start === end) start -= 1
  return { start, end }
}

/**
 * Grow a heading's span to cover its whole section — the heading line plus
 * every line up to the next `#`/`##` heading. "Forget Omar" has to take Omar's
 * facts with him; leaving them behind re-homes them under the previous person.
 */
export function expandThroughSection(
  content: string,
  span: { start: number; end: number }
): { start: number; end: number } {
  let end = span.end
  while (end < content.length) {
    const nl = content.indexOf('\n', end)
    const line = content.slice(end, nl === -1 ? content.length : nl)
    if (/^#{1,2}\s/.test(line)) break
    end = nl === -1 ? content.length : nl + 1
  }
  return { start: span.start, end }
}

/**
 * Insert an entry under `section`, creating the section when missing. Lands at
 * the END of the section's existing entries so ordering stays chronological
 * and an append never splits a bullet from its continuation lines.
 */
export function insertEntry(
  content: string,
  line: string,
  section: string,
  kind: TargetKind
): string {
  // Prose files (identity, custom instructions) have no topic structure to
  // respect — a paragraph goes at the end, separated by a blank line.
  if (kind === 'identity' || kind === 'instructions') {
    return `${content.replace(/\s+$/, '')}\n\n${line}\n`
  }
  // Everything sectioned shares ONE placement rule with memory_save and the
  // nightly promotions, so a note and a filed add can never disagree about
  // where an entry belongs.
  return Hippocampus.fileEntry(content, line, section)
}

/** Drop `## Section` headings whose body has no content left under them. */
export function pruneEmptySections(content: string): string {
  const lines = content.split('\n')
  const out: string[] = []
  for (let i = 0; i < lines.length; i += 1) {
    if (!/^##\s+\S/.test(lines[i])) {
      out.push(lines[i])
      continue
    }
    let j = i + 1
    let hasBody = false
    for (; j < lines.length; j += 1) {
      if (/^#{1,2}\s/.test(lines[j])) break
      if (lines[j].trim() !== '') hasBody = true
    }
    if (hasBody) {
      out.push(...lines.slice(i, j))
    }
    i = j - 1
  }
  return out.join('\n')
}

/** Collapse runs of blank lines and normalize the file ending. */
export function tidy(content: string): string {
  return content
    .replace(/\r\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/\s+$/, '')
}

/** `##` headings in order. */
export function sectionsOf(content: string): string[] {
  return [...content.matchAll(/^##\s+(.+\S)\s*$/gm)].map((m) => m[1])
}

/** File content minus its headings — "is there anything left to believe?" */
function stripStructure(content: string, spec: TargetSpec): string {
  return content
    .split('\n')
    .filter((l) => !/^#{1,6}\s/.test(l) && !/^<!--/.test(l.trim()))
    .join('')
    .trim()
    .replace(spec.header, '')
    .trim()
}

function nearest(lines: string[], target: string): string[] {
  const words = target.split(' ').filter((w) => w.length > 3)
  if (words.length === 0) return []
  return lines
    .map((line) => ({
      line: line.trim(),
      score: words.filter((w) => line.toLowerCase().includes(w)).length
    }))
    .filter((c) => c.score > 0 && c.line.length > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3)
    .map((c) => c.line)
}

async function readText(abs: string): Promise<string | null> {
  try {
    return await fs.readFile(abs, 'utf8')
  } catch {
    return null
  }
}

async function exists(abs: string): Promise<boolean> {
  try {
    await fs.access(abs)
    return true
  } catch {
    return false
  }
}

function today(): string {
  const d = new Date()
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

function clip(text: string, max = 60): string {
  const one = oneLine(text)
  return one.length <= max ? one : `${one.slice(0, max - 1)}…`
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
