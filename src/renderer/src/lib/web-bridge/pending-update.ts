/**
 * Web only: the tab that clicked Update remembers it across the reload that
 * follows. Installing takes the app (and this socket) down; when it comes
 * back under a new pid, boot.ts reloads the page — and a desktop window, if
 * there is one, has usually already consumed the one-shot post-update flag
 * that sends it to the changelog. This tab keeps its own, keyed on the
 * version it left from, so it lands on the changelog exactly when the
 * version actually changed and stays put when the install fell through.
 */
const KEY = 'wf-web-update-from'

function read(): string | null {
  try {
    return sessionStorage.getItem(KEY)
  } catch {
    return null
  }
}

/** Call right before `updater.install()`; records the version being left. */
export async function markWebUpdatePending(): Promise<void> {
  const from = await window.api.updater.getVersion().catch(() => null)
  if (!from) return
  try {
    sessionStorage.setItem(KEY, from)
  } catch {
    // private mode or storage off: the page still reloads, just to chat
  }
}

export function isWebUpdatePending(): boolean {
  return read() !== null
}

/**
 * True once, on the first load whose app version differs from the one the
 * update left. A same-version load (a manual refresh before the app went
 * down, or an install that relaunched the old build) keeps the flag.
 */
export async function consumeWebUpdate(): Promise<boolean> {
  const from = read()
  if (from === null) return false
  const now = await window.api.updater.getVersion().catch(() => null)
  if (!now || now === from) return false
  try {
    sessionStorage.removeItem(KEY)
  } catch {
    // nothing to clear
  }
  return true
}
