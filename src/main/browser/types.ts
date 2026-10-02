/**
 * The in-app browser's wire types — main's truth.
 *
 * Mirrored by hand into src/preload/index.ts, like every other config surface
 * in this app: the preload bundle must not pull main's module graph, so there
 * is no import across that line and the two copies are kept in step by
 * discipline. Forgetting the mirror is a typecheck failure in the RENDERER,
 * not in main, which is the usual way it gets noticed.
 */

/**
 * Storage partitions. Both are `persist:`, which is the entire session-
 * persistence story: Chromium writes a real profile (Cookies, Local Storage,
 * IndexedDB, Service Worker, Cache) under userData/Partitions/<name>, and the
 * cookie values on disk are already encrypted with the OS keychain. Logging in
 * once and quitting is enough; nothing snapshots or replays cookies.
 *
 * DEFAULT is the one localhost uses too, on purpose. A dev app's "Sign in with
 * Google" needs google.com cookies, and a second partition would hide them —
 * which would defeat the main reason this browser exists.
 */
export const BROWSER_PARTITION = 'persist:wolffish-browser'
/** Opt-in clean profile: testing a signup flow, or a second account. */
export const BROWSER_CLEAN_PARTITION = 'persist:wolffish-browser-clean'

export type BrowserPartition = typeof BROWSER_PARTITION | typeof BROWSER_CLEAN_PARTITION

/**
 * How big the tab is drawn. There is no invisible mode: opening a tab plants
 * its card in the conversation, so if this browser is working the user can see
 * it. `card` is z-parked beneath the app UI and streamed to a canvas;
 * `expanded` is the same view raised topmost with native OS input.
 */
export type BrowserTabMode = 'card' | 'expanded'

export type BrowserLoadState = 'idle' | 'loading' | 'ready' | 'error'

export type BrowserRect = { x: number; y: number; width: number; height: number }

export type BrowserTabError = { code: string; message: string }

export type BrowserTabSnapshot = {
  tabId: string
  conversationId: string | null
  url: string
  title: string
  loadState: BrowserLoadState
  canGoBack: boolean
  canGoForward: boolean
  mode: BrowserTabMode
  /** Device-pixel size of the frames currently being produced. */
  frameSize: { width: number; height: number }
  /** Rises on every document change; a uid minted under an older one is refused. */
  generation: number
  /** Set when the render process died or the debugger detached under us. */
  error: BrowserTabError | null
  /** The conversation's browser shows ONE tab at a time; this is it. */
  active: boolean
  /**
   * Every tab of this conversation's browser, in strip order, so the card's
   * persisted segment can bring the whole browser back — not just this tab.
   */
  strip: BrowserStripEntry[]
  /**
   * Workspace-relative path of the latest still frame of this tab (a JPEG
   * under files/screenshots/), for the phone's read-only card. Captured only
   * while a phone is paired; null until the first capture.
   */
  still: string | null
}

export type BrowserStripEntry = { url: string; title: string; active: boolean }

/**
 * Input the card forwards into the page (webContents.sendInputEvent shape).
 * Coordinates are CSS pixels of the page viewport, which in card mode IS the
 * card, so the card maps 1:1.
 */
export type BrowserInputEvent =
  | {
      type: 'mouseDown' | 'mouseUp' | 'mouseMove'
      x: number
      y: number
      button?: 'left' | 'middle' | 'right'
      clickCount?: number
      modifiers?: string[]
    }
  | {
      type: 'mouseWheel'
      x: number
      y: number
      deltaX: number
      deltaY: number
      modifiers?: string[]
    }
  | { type: 'keyDown' | 'keyUp' | 'char'; keyCode: string; modifiers?: string[] }

/**
 * One screencast frame. JPEG bytes, never base64 — CDP hands us base64, we
 * decode once in main and ship the buffer, which is a third smaller and skips
 * a decode in the renderer.
 */
export type BrowserFrame = {
  tabId: string
  data: Uint8Array
  width: number
  height: number
  /** CSS-pixel metadata, so a card click can be mapped back to the page. */
  page: {
    offsetTop: number
    pageScaleFactor: number
    deviceWidth: number
    deviceHeight: number
    scrollOffsetX: number
    scrollOffsetY: number
  }
  seq: number
}

/** 5 fps idle, 30 fps while the pointer is over the card. */
export type BrowserFps = 5 | 30

export type BrowserCloseReason = 'user' | 'agent' | 'crashed' | 'shutdown'
