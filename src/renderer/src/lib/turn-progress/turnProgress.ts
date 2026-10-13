import type { Segment } from '@preload/index'

/**
 * What a running turn is doing right now, for the clean feed's live status
 * line. A model told to work silently (an automation, a long research run)
 * writes no prose between tool calls, and with tool cards hidden the feed
 * showed nothing but a rotating placeholder word for the whole turn.
 *
 * The newest of two signals wins: the title of the latest reasoning summary
 * (OpenAI streams summaries that open with a bold `**Title**` line, the
 * same headings ChatGPT shows while it works), or the latest tool call,
 * described by its main target.
 */
export type TurnProgress =
  | { kind: 'thought'; text: string }
  | { kind: 'tool'; verb: 'visit' | 'search' | 'run' | 'file' | 'load' | 'use'; target: string }

const TITLE_RE = /\*\*([^*\n]{3,120})\*\*/g

export function turnProgress(segments: Segment[]): TurnProgress | null {
  for (let i = segments.length - 1; i >= 0; i--) {
    const seg = segments[i]
    if (seg.kind === 'reasoning' && !seg.worker) {
      const title = lastTitle(seg.delta)
      if (title) return { kind: 'thought', text: title }
      continue
    }
    if (seg.kind === 'tool_call' && !seg.worker) return describeCall(seg.name, seg.args)
  }
  return null
}

function lastTitle(text: string): string | null {
  let last: string | null = null
  for (const m of text.matchAll(TITLE_RE)) last = m[1].trim()
  return last
}

function describeCall(name: string, args: Record<string, unknown> | undefined): TurnProgress {
  const a = args ?? {}
  const str = (k: string): string | null =>
    typeof a[k] === 'string' && (a[k] as string).trim() ? (a[k] as string).trim() : null
  const url = str('url')
  if (url) return { kind: 'tool', verb: 'visit', target: hostOf(url) }
  const query = str('query') ?? str('q')
  if (query) return { kind: 'tool', verb: 'search', target: clip(query) }
  const command = str('command')
  if (command) return { kind: 'tool', verb: 'run', target: clip(command.split('\n')[0]) }
  const capability = str('capability')
  if (capability) return { kind: 'tool', verb: 'load', target: capability.replace(/-/g, ' ') }
  const path = str('path') ?? str('file') ?? str('output_path')
  if (path) return { kind: 'tool', verb: 'file', target: clip(path.split('/').pop() || path) }
  return { kind: 'tool', verb: 'use', target: name.replace(/_/g, ' ') }
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return clip(url)
  }
}

function clip(text: string): string {
  return text.length > 60 ? `${text.slice(0, 59)}…` : text
}
