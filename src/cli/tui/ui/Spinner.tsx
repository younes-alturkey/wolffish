/**
 * Two spinners: the braille dot for inline "still working" rows, and the
 * eight-cell scanner the prompt's hint row uses while a turn runs.
 */
import { createSignal, onCleanup, type JSX } from 'solid-js'
import { theme } from '../theme'

const BRAILLE = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']

export function Spinner(props: {
  children?: JSX.Element
  color?: ReturnType<typeof theme>['accent']
}): JSX.Element {
  const [frame, setFrame] = createSignal(0)
  const timer = setInterval(() => setFrame((f) => (f + 1) % BRAILLE.length), 80)
  onCleanup(() => clearInterval(timer))
  return (
    <text fg={props.color ?? theme().accent}>
      {BRAILLE[frame()]}
      {props.children ? ' ' : ''}
      {props.children}
    </text>
  )
}

/** The scanner: a bright cell sweeping over eight dim cells, bouncing. */
export function Scanner(): JSX.Element {
  const width = 8
  const [pos, setPos] = createSignal(0)
  let dir = 1
  const timer = setInterval(() => {
    setPos((p) => {
      const next = p + dir
      if (next >= width - 1 || next <= 0) dir = -dir
      return Math.max(0, Math.min(width - 1, next))
    })
  }, 70)
  onCleanup(() => clearInterval(timer))
  return (
    <text>
      {Array.from({ length: width }, (_, i) => {
        const d = Math.abs(i - pos())
        const color = d === 0 ? theme().accent : d === 1 ? theme().muted : theme().dim
        return <span style={{ fg: color }}>{d === 0 ? '■' : '⬝'}</span>
      })}
    </text>
  )
}
