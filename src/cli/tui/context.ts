/**
 * The one context every screen reads: the store, the daemon client, the
 * keymap, the dialog manager, toasts, and the action layer (sync.ts).
 */
import type { CliRenderer, KeyEvent } from '@opentui/core'
import { createContext, useContext, type Accessor } from 'solid-js'
import type { DaemonClient } from '../lib/client'
import type { CommandRegistry } from './commands'
import type { Keymap } from './keymap'
import type { Store } from './store'
import type { Actions } from './sync'
import type { DialogManager } from './ui/Dialog'
import type { ToastManager } from './ui/Toast'

/** Who owns the keyboard right now. Only the top scope's handlers fire. */
export type Scope = 'session' | 'card' | 'dialog' | 'legacy'

export type PromptHandle = {
  getText: () => string
  setText: (text: string) => void
  insert: (text: string) => void
  focus: () => void
  clear: () => void
}

export type AppContext = {
  renderer: CliRenderer
  client: DaemonClient
  store: Store
  keymap: Keymap
  dialog: DialogManager
  toast: ToastManager
  actions: Actions
  commands: CommandRegistry
  scope: Accessor<Scope>
  /** Persisted client preferences (theme, history…), via the daemon. */
  kv: {
    get: <T>(key: string, fallback: T) => T
    set: (key: string, value: unknown) => void
  }
  exit: (reason?: string) => void
  /** Mutable slots the active card / prompt register their key handlers in. */
  cardKeys: ((key: KeyEvent) => boolean) | null
  promptKeys: ((key: KeyEvent) => boolean) | null
  prompt: PromptHandle | null
  /** Scroll the feed by a page or to an edge. */
  scroll: ((how: 'up' | 'down' | 'top' | 'bottom') => void) | null
  /** Suspend the renderer around a classic line-mode flow. */
  suspend: <T>(run: () => Promise<T>) => Promise<T>
}

export const Context = createContext<AppContext>()

export function useApp(): AppContext {
  const ctx = useContext(Context)
  if (!ctx) throw new Error('useApp outside the app context')
  return ctx
}
