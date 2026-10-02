/**
 * Tool-output spill: when a tool result is too big for the model's context,
 * keep a bounded preview and write the FULL text to disk so nothing is
 * lost — the model is told where the file is and can grep it or read it in
 * ranges. Ported from OpenCode's truncation service (2000 lines / 50 KB,
 * head or tail, seven-day retention); the previous behaviour here was a
 * silent 100 KB clamp that dropped the end of every long test run, which is
 * exactly where the failure lives.
 *
 * The shell plugin spills its own output tail-biased (a failing run's
 * assertion is at the bottom); every other tool goes through the motor
 * head-biased. Both write to the same directory so retention is one sweep.
 */
import fs from 'node:fs/promises'
import path from 'node:path'

export const TOOL_OUTPUT_DIR = 'tool-output'
export const TOOL_OUTPUT_MAX_LINES = 2000
export const TOOL_OUTPUT_MAX_BYTES = 50 * 1024
export const TOOL_OUTPUT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000

export type SpillOptions = {
  maxLines?: number
  maxBytes?: number
  direction?: 'head' | 'tail'
  /** Tool name, for the file name. */
  tool?: string
}

export type SpillResult = {
  content: string
  truncated: boolean
  outputPath?: string
}

let counter = 0
function spillName(tool?: string): string {
  counter = (counter + 1) % 1000
  const stamp = new Date()
    .toISOString()
    .replace(/[-:.TZ]/g, '')
    .slice(0, 14)
  const safe = (tool ?? 'tool').replace(/[^a-z0-9_-]/gi, '_').slice(0, 24)
  return `${stamp}-${safe}-${counter.toString().padStart(3, '0')}.log`
}

/**
 * Keep `maxLines`/`maxBytes` of `text` from the head or the tail. Pure —
 * the caller decides whether and where to write the rest.
 */
export function boundedPreview(
  text: string,
  {
    maxLines = TOOL_OUTPUT_MAX_LINES,
    maxBytes = TOOL_OUTPUT_MAX_BYTES,
    direction = 'head'
  }: SpillOptions = {}
): {
  preview: string
  removedLines: number
  removedBytes: number
  cut: boolean
  hitBytes: boolean
} {
  const lines = text.split('\n')
  const totalBytes = Buffer.byteLength(text, 'utf8')
  if (lines.length <= maxLines && totalBytes <= maxBytes) {
    return { preview: text, removedLines: 0, removedBytes: 0, cut: false, hitBytes: false }
  }
  const out: string[] = []
  let bytes = 0
  let hitBytes = false
  if (direction === 'head') {
    for (let i = 0; i < lines.length && out.length < maxLines; i++) {
      const size = Buffer.byteLength(lines[i], 'utf8') + (out.length > 0 ? 1 : 0)
      if (bytes + size > maxBytes) {
        hitBytes = true
        break
      }
      out.push(lines[i])
      bytes += size
    }
  } else {
    for (let i = lines.length - 1; i >= 0 && out.length < maxLines; i--) {
      const size = Buffer.byteLength(lines[i], 'utf8') + (out.length > 0 ? 1 : 0)
      if (bytes + size > maxBytes) {
        hitBytes = true
        break
      }
      out.unshift(lines[i])
      bytes += size
    }
  }
  return {
    preview: out.join('\n'),
    removedLines: lines.length - out.length,
    removedBytes: totalBytes - bytes,
    cut: true,
    hitBytes
  }
}

/**
 * Bound `text` for the model and, when it was cut, write the full text under
 * `<workspaceRoot>/tool-output/` and append the hint that names the file.
 * Never throws: a failed write degrades to a bounded preview with a plain
 * "truncated" note.
 */
export async function spillToolOutput(
  workspaceRoot: string | null,
  text: string,
  opts: SpillOptions = {}
): Promise<SpillResult> {
  const bounded = boundedPreview(text, opts)
  if (!bounded.cut) return { content: text, truncated: false }
  const unit = bounded.hitBytes ? `${bounded.removedBytes} bytes` : `${bounded.removedLines} lines`
  let outputPath: string | undefined
  if (workspaceRoot) {
    try {
      const dir = path.join(workspaceRoot, TOOL_OUTPUT_DIR)
      await fs.mkdir(dir, { recursive: true })
      const file = path.join(dir, spillName(opts.tool))
      await fs.writeFile(file, text, 'utf8')
      outputPath = file
    } catch {
      outputPath = undefined
    }
  }
  const hint = outputPath
    ? `The tool call succeeded but the output was truncated. Full output saved to: ${outputPath}\nUse file_grep to search it or file_read with startLine/endLine to view specific sections.`
    : 'The output was truncated and could not be saved to disk.'
  const direction = opts.direction ?? 'head'
  const content =
    direction === 'head'
      ? `${bounded.preview}\n\n...${unit} truncated...\n\n${hint}`
      : `...${unit} truncated...\n\n${hint}\n\n${bounded.preview}`
  return { content, truncated: true, outputPath }
}

/** Delete spill files older than the retention window. Idempotent, never throws. */
export async function cleanupToolOutput(
  workspaceRoot: string,
  retentionMs: number = TOOL_OUTPUT_RETENTION_MS
): Promise<number> {
  const dir = path.join(workspaceRoot, TOOL_OUTPUT_DIR)
  let removed = 0
  try {
    const entries = await fs.readdir(dir)
    const cutoff = Date.now() - retentionMs
    for (const name of entries) {
      if (!name.endsWith('.log')) continue
      const file = path.join(dir, name)
      try {
        const stat = await fs.stat(file)
        if (stat.mtimeMs < cutoff) {
          await fs.unlink(file)
          removed++
        }
      } catch {
        // already gone
      }
    }
  } catch {
    // no directory yet
  }
  return removed
}
