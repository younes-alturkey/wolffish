import { diskWriter } from '@main/io/diskWriter'
import { workspaceRoot } from '@main/workspace/root'
import fs from 'node:fs/promises'
import path from 'node:path'

/**
 * The conversations most recently OPENED, newest first — the "Recently opened"
 * section the conversations sheet and the History page pin above the list.
 *
 * Kept in main rather than in the renderer's localStorage because the Web UI
 * is the same renderer in a browser: a per-browser list would show the desktop
 * window and a phone browser two different "last opened" sets for one user.
 * Main is the one place every surface opens through, and broadcasting the list
 * keeps them in step live.
 *
 * More ids are kept than any surface shows, so deleting one (or a project
 * filter hiding it) leaves the section full instead of a slot short.
 */
const MAX_KEPT = 12

const ID_PATTERN = /^[A-Za-z0-9_.:-]{1,128}$/

function storePath(): string {
  return path.join(workspaceRoot(), 'brain', 'recent-conversations.json')
}

function parse(raw: string | null): string[] {
  if (!raw) return []
  try {
    const data = JSON.parse(raw) as unknown
    if (!Array.isArray(data)) return []
    return data.filter((id): id is string => typeof id === 'string' && ID_PATTERN.test(id))
  } catch {
    return []
  }
}

export async function listRecentConversations(): Promise<string[]> {
  return parse(await fs.readFile(storePath(), 'utf8').catch(() => null))
}

async function rewrite(
  change: (ids: string[]) => string[] | null
): Promise<{ ids: string[]; changed: boolean }> {
  let result: string[] = []
  let changed = false
  await diskWriter.update(storePath(), (raw) => {
    const current = parse(raw)
    const next = change(current)
    result = next ?? current
    changed = next !== null
    return next === null ? null : JSON.stringify(next)
  })
  return { ids: result, changed }
}

/** Move `id` to the front. No write when it is already there. */
export function markConversationOpened(id: string): Promise<{ ids: string[]; changed: boolean }> {
  if (!ID_PATTERN.test(id))
    return listRecentConversations().then((ids) => ({ ids, changed: false }))
  return rewrite((ids) =>
    ids[0] === id ? null : [id, ...ids.filter((x) => x !== id)].slice(0, MAX_KEPT)
  )
}

export function forgetRecentConversation(id: string): Promise<{ ids: string[]; changed: boolean }> {
  return rewrite((ids) => (ids.includes(id) ? ids.filter((x) => x !== id) : null))
}
