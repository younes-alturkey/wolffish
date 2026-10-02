/** Small formatting helpers shared by every screen. English only, by design. */

export function tokens(n: number | null | undefined): string {
  if (!n || !Number.isFinite(n)) return '0'
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 10_000) return `${Math.round(n / 1000)}k`
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`
  return String(Math.round(n))
}

export function money(n: number | null | undefined): string {
  if (!n || !Number.isFinite(n)) return '$0.00'
  if (n < 0.01) return `$${n.toFixed(4)}`
  return `$${n.toFixed(2)}`
}

/** `0:42`, `12:05`, `1:02:09` — a stopwatch reading. */
export function stopwatch(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const mm = h > 0 ? String(m).padStart(2, '0') : String(m)
  return `${h > 0 ? `${h}:` : ''}${mm}:${String(s).padStart(2, '0')}`
}

/** `840ms`, `4.1s`, `2m 3s`, `1h 2m` — a duration reading. */
export function duration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return ''
  if (ms < 1000) return `${Math.round(ms)}ms`
  const s = ms / 1000
  if (s < 60) return `${s.toFixed(1)}s`
  const m = Math.floor(s / 60)
  const rs = Math.round(s % 60)
  if (m < 60) return `${m}m ${rs}s`
  const h = Math.floor(m / 60)
  return `${h}h ${m % 60}m`
}

export function bytes(n: number | null | undefined): string {
  if (!n || !Number.isFinite(n)) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  let value = n
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit++
  }
  return `${unit === 0 ? value : value.toFixed(1)} ${units[unit]}`
}

export function relativeTime(ts: number | null | undefined): string {
  if (!ts) return ''
  const diff = Date.now() - ts
  const minutes = Math.round(diff / 60_000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.round(hours / 24)
  if (days < 30) return `${days}d ago`
  return new Date(ts).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

export function clock(ts: number): string {
  const d = new Date(ts)
  const today = new Date()
  const time = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
  if (d.toDateString() === today.toDateString()) return time
  return `${time} · ${d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`
}

export function truncate(text: string, max: number): string {
  if (text.length <= max) return text
  if (max <= 1) return '…'
  return text.slice(0, max - 1) + '…'
}

export function truncateMiddle(text: string, max: number): string {
  if (text.length <= max) return text
  if (max < 5) return truncate(text, max)
  const keep = max - 1
  const head = Math.ceil(keep / 2)
  const tail = Math.floor(keep / 2)
  return `${text.slice(0, head)}…${text.slice(text.length - tail)}`
}

export function shortPath(p: string): string {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? ''
  if (home && p.startsWith(home)) return `~${p.slice(home.length)}`
  return p
}

export function basename(p: string): string {
  const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'))
  return i >= 0 ? p.slice(i + 1) : p
}

export function titlecase(text: string): string {
  return text.length === 0 ? text : text[0].toUpperCase() + text.slice(1)
}

/** Compact one-line summary of tool arguments — never the whole payload. */
export function summarizeArgs(args: Record<string, unknown> | undefined, room = 60): string {
  if (!args || typeof args !== 'object') return ''
  const parts: string[] = []
  const keys = Object.keys(args)
  for (const [key, value] of Object.entries(args)) {
    if (value === undefined || value === null) continue
    let text: string
    if (typeof value === 'string') text = value
    else if (typeof value === 'number' || typeof value === 'boolean') text = String(value)
    else if (Array.isArray(value)) text = `[${value.length}]`
    else text = '{…}'
    text = text.replace(/\s+/g, ' ').trim()
    if (text.length > room) text = text.slice(0, room - 1) + '…'
    parts.push(parts.length === 0 && keys.length === 1 ? text : `${key}=${text}`)
    if (parts.length >= 3) break
  }
  return parts.join(' ')
}

/** Truncate tool output to a preview, code-point aware. */
export function collapseOutput(
  output: string,
  maxLines: number,
  maxChars: number
): { output: string; overflow: boolean } {
  const lines = output.split('\n')
  if (lines.length <= maxLines && Array.from(output).length <= maxChars) {
    return { output, overflow: false }
  }
  const preview = lines.slice(0, maxLines).join('\n')
  if (Array.from(preview).length > maxChars) {
    return {
      output:
        Array.from(preview)
          .slice(0, Math.max(0, maxChars - 1))
          .join('') + '…',
      overflow: true
    }
  }
  return { output: [...lines.slice(0, maxLines), '…'].join('\n'), overflow: true }
}

export function plural(n: number, word: string, pluralWord = `${word}s`): string {
  return `${n} ${n === 1 ? word : pluralWord}`
}
