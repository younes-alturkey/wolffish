import { app, type BrowserWindow } from 'electron'

/**
 * The OS's own "this app wants you" signal: a bouncing Dock icon on macOS, a
 * flashing taskbar button on Windows, an urgency hint on Linux.
 *
 * Exactly two moments earn it, and nothing else does — a turn that ended while
 * the user was somewhere else, and a card the turn cannot get past without them
 * (an approval gate, an ask_user question). Every extra trigger costs the signal
 * its meaning: an icon that jumps at everything is an icon the user stops
 * reading, which is the same as not having one.
 *
 * Only in-app turns reach here (the ElectronChannel is the only caller, and
 * only a chat:send creates one of its turns). A Telegram, WhatsApp, phone or
 * automation turn ending is not the user waiting at this window, and its own
 * surface already carries the news.
 */
export type AttentionReason =
  /** A turn finished — or failed — while the window was not focused. */
  | 'turn-ended'
  /** A card is blocking the turn on the user: an approval, an ask_user question. */
  | 'needs-user'

/**
 * Set by installAttention. Until then every request is a no-op, which is what
 * keeps this importable from the channel tests (they stub the electron module
 * down to `app` and never open a window).
 */
let resolveWindow: () => BrowserWindow | null = () => null

/** The live request, so a resolved blocker can retract its own signal. */
let active: AttentionReason | null = null
/** macOS bounce id — the only handle cancelBounce accepts. */
let bounceId: number | null = null

export function installAttention(getWindow: () => BrowserWindow | null): void {
  resolveWindow = getWindow
  // The user arriving IS the answer to every request there is. macOS retires
  // its own on activation; Windows stops flashing when the window reaches the
  // foreground; a Linux urgency hint can outlive both, so clear all three here.
  app.on('browser-window-focus', () => releaseAttention())
}

export function requestAttention(reason: AttentionReason): void {
  const win = resolveWindow()
  if (!win || win.isDestroyed()) return
  // Focused ⇒ the user is already reading it. macOS says this itself by
  // returning -1 from bounce(); the other two platforms would flash at someone
  // looking straight at the window.
  if (win.isFocused()) return
  // A blocker outranks news. A sibling conversation finishing must not replace
  // a standing "come answer this" with a one-second glance and leave the card
  // that is actually holding a turn up with no signal at all.
  if (active === 'needs-user' && reason === 'turn-ended') return
  try {
    if (process.platform === 'darwin') {
      // The two levels macOS offers, used for what each is for: 'critical'
      // bounces until the app is activated or the request is canceled — a turn
      // that cannot proceed without the user has earned that. 'informational'
      // bounces for one second, which is the right weight for news: a finished
      // turn is worth a glance, not a demand.
      const id = app.dock?.bounce(reason === 'needs-user' ? 'critical' : 'informational')
      if (typeof id !== 'number' || id < 0) return
      if (bounceId !== null) app.dock?.cancelBounce(bounceId)
      bounceId = id
      active = reason
      return
    }
    // Windows flashes the taskbar button (the orange highlight) until the
    // window comes to the foreground. Most X11 window managers light the
    // launcher entry the same way from the urgency hint this sets; a Wayland
    // compositor may ignore it, so Linux is best-effort by nature.
    win.flashFrame(true)
    active = reason
  } catch {
    // An attention request is decoration on top of the real work. It never
    // gets to break the end of a turn or an approval prompt.
  }
}

/**
 * Retract the signal. With a reason, only a request made for THAT reason is
 * retracted: an approval answered elsewhere clears its own critical bounce
 * without eating the one-second bounce a turn ending fired a moment later.
 */
export function releaseAttention(only?: AttentionReason): void {
  if (active === null) return
  if (only && active !== only) return
  active = null
  try {
    if (bounceId !== null) {
      app.dock?.cancelBounce(bounceId)
      bounceId = null
    }
    const win = resolveWindow()
    if (win && !win.isDestroyed() && process.platform !== 'darwin') win.flashFrame(false)
  } catch {
    // Same reason as above.
  }
}
