/**
 * One toast slot, top right, five seconds. A new toast replaces the old one
 * and restarts the timer — the same rule OpenCode uses; a queue of stale
 * notices is worse than the latest one.
 */
import { createSignal, Show, type JSX } from 'solid-js'
import { useTerminalDimensions } from '@opentui/solid'
import { theme } from '../theme'

export type ToastVariant = 'info' | 'success' | 'warning' | 'error'
export type ToastItem = { title?: string; message: string; variant: ToastVariant }

export type ToastManager = {
  show: (input: ToastItem & { duration?: number }) => void
  info: (message: string, title?: string) => void
  success: (message: string, title?: string) => void
  warning: (message: string, title?: string) => void
  error: (input: unknown, title?: string) => void
  current: () => ToastItem | null
}

export function createToastManager(): ToastManager {
  const [current, setCurrent] = createSignal<ToastItem | null>(null)
  let timer: ReturnType<typeof setTimeout> | null = null
  const show: ToastManager['show'] = (input) => {
    setCurrent({ title: input.title, message: input.message, variant: input.variant })
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => setCurrent(null), input.duration ?? 5000)
    timer.unref?.()
  }
  return {
    show,
    info: (message, title) => show({ message, title, variant: 'info' }),
    success: (message, title) => show({ message, title, variant: 'success' }),
    warning: (message, title) => show({ message, title, variant: 'warning' }),
    error: (input, title) =>
      show({
        message: input instanceof Error ? input.message : String(input ?? 'Something went wrong'),
        title,
        variant: 'error'
      }),
    current
  }
}

export function ToastView(props: { manager: ToastManager }): JSX.Element {
  const dims = useTerminalDimensions()
  const color = () => {
    const t = props.manager.current()
    const p = theme()
    if (!t) return p.accent
    return t.variant === 'error'
      ? p.bad
      : t.variant === 'warning'
        ? p.warn
        : t.variant === 'success'
          ? p.good
          : p.accent
  }
  return (
    <Show when={props.manager.current()}>
      {(toast) => (
        <box
          position="absolute"
          top={1}
          right={2}
          zIndex={4000}
          maxWidth={Math.min(60, dims().width - 6)}
          backgroundColor={theme().panel}
          border={['left']}
          borderColor={color()}
          paddingLeft={2}
          paddingRight={2}
          paddingTop={0}
          paddingBottom={0}
          flexDirection="column"
        >
          <Show when={toast().title}>
            <text fg={theme().text} attributes={1}>
              {toast().title}
            </text>
          </Show>
          <text fg={theme().text} wrapMode="word">
            {toast().message}
          </text>
        </box>
      )}
    </Show>
  )
}
