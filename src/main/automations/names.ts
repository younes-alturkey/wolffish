import { nameAutomation, offlineAutomationName, type TitlerLLM } from '@main/conversation-titler'
import { diskWriter } from '@main/io/diskWriter'
import { workspaceRoot } from '@main/workspace/root'
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'

/**
 * The fixed name every run of one automation is titled under.
 *
 * Kept on disk, keyed by the instruction, because the name has to be the SAME
 * on every run: asking the model afresh each time rewords it ("Inbox Triage",
 * then "Email Triage"), which is exactly the drift that made a list of runs
 * hard to scan. heartbeat.md is the user's file and has no slot for a derived
 * value, so the cache lives beside it. Keyed by content rather than by the
 * heading because the heading IS the schedule — moving 08:00 to 09:00 is not a
 * new automation — while rewriting the instruction is, and earns a new name.
 */

type Entry = { key: string; name: string }

const MAX_ENTRIES = 300

function cachePath(): string {
  return path.join(workspaceRoot(), 'brain', 'brainstem', 'automation-names.json')
}

function keyFor(instruction: string): string {
  const normalized = instruction.replace(/\s+/g, ' ').trim()
  return createHash('sha256').update(normalized).digest('hex').slice(0, 16)
}

function parse(raw: string | null): Entry[] {
  if (!raw) return []
  try {
    const data = JSON.parse(raw) as unknown
    if (!Array.isArray(data)) return []
    return data.filter(
      (e): e is Entry =>
        !!e &&
        typeof (e as Entry).key === 'string' &&
        typeof (e as Entry).name === 'string' &&
        (e as Entry).name.trim().length > 0
    )
  } catch {
    return []
  }
}

async function cachedName(key: string): Promise<string | null> {
  const raw = await fs.readFile(cachePath(), 'utf8').catch(() => null)
  return parse(raw).find((e) => e.key === key)?.name ?? null
}

async function remember(key: string, name: string): Promise<void> {
  await diskWriter.update(cachePath(), (raw) => {
    const entries = parse(raw).filter((e) => e.key !== key)
    entries.push({ key, name })
    return JSON.stringify(entries.slice(-MAX_ENTRIES), null, 2)
  })
}

/**
 * The name to title this run under: the one the user gave it, else the one it
 * was given before, else a fresh one from the model (remembered), else its
 * instruction's first line (not remembered, so the next run asks again).
 */
export async function automationName(opts: {
  instruction: string
  givenName?: string
  llm: TitlerLLM
  signal?: AbortSignal
}): Promise<string> {
  const given = opts.givenName?.trim()
  if (given) return given
  const key = keyFor(opts.instruction)
  const cached = await cachedName(key)
  if (cached) return cached
  const fresh = await nameAutomation(opts.instruction, opts.llm, opts.signal)
  if (fresh) {
    await remember(key, fresh).catch(() => undefined)
    return fresh
  }
  return offlineAutomationName(opts.instruction)
}
