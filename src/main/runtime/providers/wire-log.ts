import { WORKSPACE_ROOT } from '@main/workspace/root'
import fs from 'node:fs/promises'
import path from 'node:path'

/**
 * Opt-in wire log for diagnosing tool loops: one JSONL line per request (the
 * shape of every input item, in order) and one per response (the shape of
 * every output item, usage, status). Item SHAPES only — roles, types,
 * phases, tool names, call ids — never prompt text, tool payloads or keys,
 * so the file is safe to attach to a bug report.
 *
 * Toggle: `"diagnostics": { "wireLog": true }` in ~/.wolffish/workspace/
 * config.json. Read per request, so flipping it needs no restart. Written to
 * ~/.wolffish/logs/llm-wire-<date>.jsonl.
 */

const CONFIG_PATH = path.join(WORKSPACE_ROOT, 'config.json')
const LOGS_DIR = path.join(path.dirname(WORKSPACE_ROOT), 'logs')

export async function wireLogEnabled(): Promise<boolean> {
  try {
    const raw = await fs.readFile(CONFIG_PATH, 'utf8')
    const config = JSON.parse(raw) as { diagnostics?: { wireLog?: unknown } }
    return config.diagnostics?.wireLog === true
  } catch {
    return false
  }
}

export function wireShape(item: unknown): string {
  if (!item || typeof item !== 'object') return typeof item
  const i = item as Record<string, unknown>
  const kind = typeof i.type === 'string' ? i.type : typeof i.role === 'string' ? i.role : '?'
  if (kind === 'message' || (kind !== i.type && typeof i.role === 'string')) {
    const role = typeof i.role === 'string' ? i.role : 'assistant'
    return typeof i.phase === 'string' ? `${role}:${i.phase}` : role
  }
  if (kind === 'function_call') return `function_call:${String(i.name)}#${String(i.call_id)}`
  if (kind === 'function_call_output') return `function_call_output#${String(i.call_id)}`
  if (kind === 'reasoning') return i.encrypted_content ? 'reasoning(enc)' : 'reasoning'
  return kind
}

export function writeWireLog(entry: Record<string, unknown>): void {
  const now = new Date()
  const day = now.toISOString().slice(0, 10)
  const line = JSON.stringify({ ts: now.toISOString(), ...entry }) + '\n'
  void fs
    .mkdir(LOGS_DIR, { recursive: true })
    .then(() => fs.appendFile(path.join(LOGS_DIR, `llm-wire-${day}.jsonl`), line))
    .catch(() => undefined)
}
