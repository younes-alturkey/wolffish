import { cn } from '@/lib/utils/cn'
import { useMemo } from 'react'
import { ScrollView, Text, View } from 'react-native'

/**
 * A unified diff as red/green lines with old/new line numbers — the mobile
 * twin of the desktop's DiffView. Pure: the patch text on the tool_result's
 * `meta.diff` is the only input, so a live card and a card reopened from the
 * stored transcript are the same pixels. File headers (`--- a/…`, `+++ b/…`)
 * are dropped — the row already names the file; hunk headers keep their range
 * for orientation.
 *
 * The block scrolls both ways inside its own frame: lines are never wrapped
 * (a wrapped diff misreads), so a wide hunk pans sideways, and a long one
 * scrolls within the cap rather than stretching the feed.
 */

export type DiffLine = {
  kind: 'add' | 'del' | 'ctx' | 'hunk'
  text: string
  oldNo?: number
  newNo?: number
}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/

export function parseUnifiedDiff(patch: string): DiffLine[] {
  const out: DiffLine[] = []
  let oldNo = 0
  let newNo = 0
  for (const raw of patch.split('\n')) {
    if (raw.startsWith('--- ') || raw.startsWith('+++ ')) continue
    const hunk = HUNK_RE.exec(raw)
    if (hunk) {
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

// Literal palette tones on purpose: an alpha modifier on a var() colour
// compiles to nothing (see global.css), and these are the desktop's exact
// diff tints.
const ROW_CLASS: Record<DiffLine['kind'], string> = {
  add: 'bg-emerald-500/10',
  del: 'bg-red-500/10',
  ctx: '',
  hunk: 'bg-border-soft'
}

const TEXT_CLASS: Record<DiffLine['kind'], string> = {
  add: 'text-emerald-800 dark:text-emerald-200',
  del: 'text-red-800 dark:text-red-200',
  ctx: 'text-fg',
  hunk: 'text-muted'
}

const MARK: Record<DiffLine['kind'], string> = { add: '+', del: '-', ctx: ' ', hunk: '' }

/** Digits in the widest line number, so the gutters line up. */
function gutterWidth(lines: DiffLine[]): number {
  let max = 1
  for (const line of lines) max = Math.max(max, line.oldNo ?? 0, line.newNo ?? 0)
  return String(max).length
}

function pad(value: number | undefined, width: number): string {
  return (value === undefined ? '' : String(value)).padStart(width, ' ')
}

export function DiffView({ patch }: { patch: string }): React.JSX.Element {
  const lines = useMemo(() => parseUnifiedDiff(patch), [patch])
  const width = useMemo(() => gutterWidth(lines), [lines])
  return (
    <ScrollView
      className="bg-bg border-border max-h-72 rounded-md border"
      nestedScrollEnabled
      showsVerticalScrollIndicator={false}
    >
      <ScrollView horizontal showsHorizontalScrollIndicator={false} nestedScrollEnabled>
        {/* One column of rows, each a fixed LTR line: the gutters are a
            numeric scale, so the whole block stays left-to-right in Arabic. */}
        <View className="flex-col py-1" style={{ direction: 'ltr' }}>
          {lines.map((line, index) => (
            <View
              key={index}
              className={cn('flex-row items-start px-2', ROW_CLASS[line.kind])}
              style={{ direction: 'ltr' }}
            >
              <Text
                className="text-muted pe-2 font-mono text-[11px] leading-4"
                style={{ writingDirection: 'ltr' }}
              >
                {line.kind === 'hunk'
                  ? ' '.repeat(width * 2 + 1)
                  : `${pad(line.kind === 'add' ? undefined : line.oldNo, width)} ${pad(
                      line.kind === 'del' ? undefined : line.newNo,
                      width
                    )}`}
              </Text>
              <Text
                className={cn('pe-1 font-mono text-[11px] leading-4', TEXT_CLASS[line.kind])}
                style={{ writingDirection: 'ltr' }}
              >
                {MARK[line.kind] || ' '}
              </Text>
              <Text
                className={cn('pe-3 font-mono text-[11px] leading-4', TEXT_CLASS[line.kind])}
                style={{ writingDirection: 'ltr' }}
              >
                {line.text}
              </Text>
            </View>
          ))}
        </View>
      </ScrollView>
    </ScrollView>
  )
}
