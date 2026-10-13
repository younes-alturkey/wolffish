import { createContext, useContext } from 'react'

export type ToastTone = 'info' | 'success' | 'warning' | 'error'

export type ToastInput = {
  message: string
  tone?: ToastTone
  durationMs?: number
  /**
   * A sticky toast never auto-dismisses — it stays until the user taps it
   * (or its close button) or the creator dismisses it by id. For persistent
   * states like "network offline" that end at an unknown future moment.
   */
  sticky?: boolean
  /**
   * Where the toast stacks. 'bottom' (default) keeps the classic transient
   * position; 'top' is for ambient app-state notices (network status) that
   * must not sit over primary actions.
   */
  placement?: 'top' | 'bottom'
  /**
   * Invoked when the toast body is tapped, right before it dismisses —
   * turns a toast into a lightweight call to action ("tap to restart").
   * The close button always dismisses without invoking it.
   */
  onPress?: () => void
}

export type ToastContextValue = {
  /** Shows a toast and returns its id, for a later programmatic dismiss. */
  show: (input: ToastInput) => number
  dismiss: (id: number) => void
}

export const ToastContext = createContext<ToastContextValue | null>(null)

export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext)
  if (!ctx) throw new Error('useToast must be used within a ToastProvider')
  return ctx
}
