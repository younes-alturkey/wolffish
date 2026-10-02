import { cn } from '@lib/utils/cn'
import { useMemo } from 'react'

/**
 * Renders a unified diff as red/green lines with old/new line numbers.
 * Pure: the patch text on the tool_result segment's `meta.diff` is the
 * only input, so a live card and a card reopened from history are the
 * same pixels. Header lines (`--- a/…`, `+++ b/…`) are dropped — the card
 * already names the file; hunk headers keep their range for orientation.
 */

type DiffLine = {
  kind: 'add' | 'del' | 'ctx' | 'hunk'
  text: string
  oldNo?: number
  newNo?: number
}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/

function parseUnifiedDiff(patch: string): DiffLine[] {
  const out: DiffLine[] = []
  let oldNo = 0
  let newNo = 0
  // The `--- a/…` / `+++ b/…` header only exists BEFORE the first hunk. Past
  // that point a line starting with those characters is real content — a
  // deleted `-- comment` (SQL, Lua, Haskell) arrives as `--- comment` — and
  // dropping it would silently remove a changed line from the diff the user
  // is reading to check the edit.
  let inHunk = false
  for (const raw of patch.split('\n')) {
    if (!inHunk && (raw.startsWith('--- ') || raw.startsWith('+++ '))) continue
    const hunk = HUNK_RE.exec(raw)
    if (hunk) {
      inHunk = true
      oldNo = Number(hunk[1])
      newNo = Number(hunk[3])
      out.push({ kind: 'hunk', text: raw })
      continue
    }
    if (raw.startsWith('+')) {
      out.push({ kind: 'add', text: raw.slice(1), newNo })
      newNo++
    } else if (raw.startsWith('-')) {
      out.push({ kind: 'del', text: raw.slice(1), oldNo })
      oldNo++
    } else if (raw.startsWith(' ')) {
      out.push({ kind: 'ctx', text: raw.slice(1), oldNo, newNo })
      oldNo++
      newNo++
    } else if (raw === '' && out.length > 0 && out[out.length - 1].kind !== 'hunk') {
      // A bare empty line inside a hunk is a context line whose content is empty.
      out.push({ kind: 'ctx', text: '', oldNo, newNo })
      oldNo++
      newNo++
    }
  }
  return out
}

const LINE_CLASS: Record<DiffLine['kind'], string> = {
  add: 'bg-emerald-500/10 text-emerald-800 dark:text-emerald-200',
  del: 'bg-red-500/10 text-red-800 dark:text-red-200',
  ctx: 'text-fg/80',
  hunk: 'text-muted bg-muted/10'
}

const MARK: Record<DiffLine['kind'], string> = { add: '+', del: '-', ctx: ' ', hunk: '' }

export function DiffView({
  patch,
  maxH = 'max-h-96',
  className
}: {
  patch: string
  maxH?: string
  className?: string
}): React.JSX.Element {
  const lines = useMemo(() => parseUnifiedDiff(patch), [patch])
  const width = useMemo(() => {
    let max = 1
    for (const l of lines) max = Math.max(max, l.oldNo ?? 0, l.newNo ?? 0)
    return String(max).length
  }, [lines])
  return (
    <div
      dir="ltr"
      className={cn(
        'border-border bg-surface-2 overflow-auto rounded-lg border font-mono text-xs leading-5',
        maxH,
        className
      )}
    >
      <table className="w-full border-collapse">
        <tbody>
          {lines.map((line, i) => (
            <tr key={i} className={LINE_CLASS[line.kind]}>
              <td
                className="text-muted/70 select-none pe-1 ps-2 text-end align-top tabular-nums"
                style={{ width: `${width + 1}ch` }}
              >
                {line.kind === 'add' || line.kind === 'hunk' ? '' : line.oldNo}
              </td>
              <td
                className="text-muted/70 select-none pe-2 text-end align-top tabular-nums"
                style={{ width: `${width + 1}ch` }}
              >
                {line.kind === 'del' || line.kind === 'hunk' ? '' : line.newNo}
              </td>
              <td className="select-none pe-1 align-top">{MARK[line.kind]}</td>
              <td className="whitespace-pre pe-3 align-top">{line.text}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
