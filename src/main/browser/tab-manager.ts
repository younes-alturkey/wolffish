/**
 * Tabs for the in-app browser.
 *
 * One `WebContentsView` per tab, attached to the main window for its whole
 * life and never detached to hide — mode is purely WHERE the view sits:
 *
 *   CARD     parked at the window's bottom-end corner with exactly one pixel
 *            inside the content bounds — under the rounded corner on macOS
 *   EXPANDED moved over the sheet's stage rect and raised topmost, native input
 *
 * Why a corner and not z-order: a child of a BrowserWindow's contentView is
 * ALWAYS painted above the window's own UI, whatever index it is added at
 * (measured with OS screenshots — a view added at index 0 covered the app),
 * so "under the UI" does not exist without a BaseWindow refactor. Why one
 * pixel and not fully outside: views' NativeViewHost hides the native widget
 * the moment its visible bounds are empty, and a hidden renderer reports
 * `visibilityState: hidden` and throttles (Electron #44590). With 1px inside
 * the page reports `visible`, runs requestAnimationFrame at 60/s and the
 * screencast emits live frames — measured, spike C. `setVisible(false)` is
 * NOT an alternative either: it throttles the renderer to ~2 timer ticks/s.
 *
 * The lifecycle below is lifted from electron-browser-shell's tabs.js with
 * three corrections it earned the hard way — see the comments on destroy(),
 * the bound-once resize handler, and the use of close() over destroy().
 */
import { WebContentsView, shell, type BrowserWindow, type WebContents } from 'electron'
import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { workspaceRoot } from '@main/workspace/workspace'
import { wlog } from '@main/workspace/logger'
import { CdpSession } from '@main/browser/cdp'
import { FrameStreamer, type FrameSink } from '@main/browser/frames'
import { configureBrowserSession } from '@main/browser/session'
import {
  createSnapshotSession,
  currentLoaderId,
  enableDomains,
  handleSessionEvent
} from '@main/browser/snapshot/session'
import type { SnapshotSession } from '@main/browser/snapshot/types'
import {
  BROWSER_PARTITION,
  type BrowserCloseReason,
  type BrowserFps,
  type BrowserPartition,
  type BrowserInputEvent,
  type BrowserStripEntry,
  type BrowserRect,
  type BrowserTabMode,
  type BrowserTabSnapshot
} from '@main/browser/types'

const TAG = 'browser'

/** The page's viewport before any card or sheet has sized it. In card mode
 *  only the SIZE is used — the position is the parking corner (see the header
 *  comment); a view parked fully outside the window reports innerWidth 0 and
 *  reflows the page to garbage (Electron #44590). */
const DEFAULT_STAGE: BrowserRect = { x: 0, y: 0, width: 1024, height: 700 }

export type TabEvents = {
  /** Every state change, for the post-turn fold (browser:changed) and, while
   *  the opening turn is live, for the `browser` segment in its transcript. */
  onChanged: (snapshot: BrowserTabSnapshot) => void
  onClosed: (tabId: string, reason: BrowserCloseReason) => void
  onFrame: FrameSink
  /** Whether this tab is the one its conversation's browser is showing. */
  isActive: (tabId: string) => boolean
  /** The conversation's tabs in strip order (see BrowserTabSnapshot.strip). */
  strip: (conversationId: string | null) => BrowserStripEntry[]
  /** Whether anyone wants still frames right now (a phone is paired). */
  wantsStill: () => boolean
  /** A window.open guest, adopted into an app-owned tab rather than a naked
   *  BrowserWindow. Returns the adopted contents, which is what Electron's
   *  createWindow callback must hand back. */
  adopt: (opener: Tab, adopted: WebContents | undefined) => WebContents
}

export class Tab {
  readonly id = randomUUID()
  readonly view: WebContentsView
  readonly cdp: CdpSession
  readonly streamer: FrameStreamer
  readonly partition: BrowserPartition
  /** The snapshot layer's state: uid maps, console ring, current loaderId. */
  readonly session: SnapshotSession
  conversationId: string | null
  /** The turn that opened it — the one whose transcript carries its card. */
  turnId: string | null = null
  /** False until createTab has loaded and attached; no card is emitted before
   *  that, so a failed open leaves nothing in the chat. */
  ready = false
  mode: BrowserTabMode = 'card'
  /** Latest still frame, workspace-relative — see BrowserTabSnapshot.still. */
  still: string | null = null
  private stillSeq = 0
  private stillTimer: ReturnType<typeof setTimeout> | null = null
  generation = 0
  error: { code: string; message: string } | null = null
  loadState: BrowserTabSnapshot['loadState'] = 'idle'
  private destroyed = false
  private window: BrowserWindow | null
  private stage: BrowserRect = DEFAULT_STAGE
  private readonly events: TabEvents
  /** Bound ONCE. `window.off(event, fn)` only unhooks an identical reference,
   *  so an inline .bind() at subscribe time leaks the whole view graph for
   *  the window's lifetime and fires a dead handler on every resize. */
  private readonly onWindowResize = (): void => this.applyBounds()

  constructor(opts: {
    window: BrowserWindow
    conversationId: string | null
    turnId: string | null
    partition: BrowserPartition
    events: TabEvents
    adopted?: WebContents
  }) {
    this.window = opts.window
    this.conversationId = opts.conversationId
    this.turnId = opts.turnId
    this.partition = opts.partition
    this.events = opts.events

    configureBrowserSession(opts.partition)

    this.view = new WebContentsView(
      opts.adopted
        ? { webContents: opts.adopted }
        : {
            webPreferences: {
              partition: opts.partition,
              sandbox: true,
              contextIsolation: true,
              nodeIntegration: false,
              nodeIntegrationInSubFrames: false,
              webviewTag: false,
              safeDialogs: true,
              spellcheck: false
            }
          }
    )

    this.cdp = new CdpSession(this.view.webContents)
    this.session = createSnapshotSession((method, params) => this.cdp.send(method, params))
    this.streamer = new FrameStreamer(this.id, this.cdp, (frame) => this.events.onFrame(frame))

    // Attach once, park immediately in the corner.
    opts.window.contentView.addChildView(this.view)
    this.applyBounds()
    opts.window.on('resize', this.onWindowResize)

    this.wireContents()
  }

  get webContents(): WebContents {
    return this.view.webContents
  }

  get isAlive(): boolean {
    return !this.destroyed && !this.view.webContents.isDestroyed()
  }

  /** Attach the debugger and enable the domains the snapshot layer relies on. */
  async attachDebugger(): Promise<void> {
    this.cdp.attach()
    this.cdp.on((method, params) => handleSessionEvent(this.session, method, params))
    await enableDomains(this.session.send)
    this.session.loaderId = await currentLoaderId(this.session.send)
  }

  private wireContents(): void {
    const wc = this.view.webContents

    // A guest popup never becomes a naked BrowserWindow. Same-ish rule as the
    // app's <webview> guests, but here the right answer is an app-owned tab
    // rather than the system browser: this IS a browser, and a link that opens
    // a login popup has to stay inside the session the user signed into.
    wc.setWindowOpenHandler(({ disposition }) => {
      if (
        disposition === 'foreground-tab' ||
        disposition === 'background-tab' ||
        disposition === 'new-window'
      ) {
        // Adopting the guest Electron already created keeps the opener
        // relationship intact — window.open() returns a real handle and a
        // form POST target still works. Denying and opening our own tab
        // breaks both. The options bag is typed as window options but carries
        // the pre-created guest empirically; only middle-click hands it back
        // present-but-undefined, which the adopt hook tolerates.
        return {
          action: 'allow',
          outlivesOpener: true,
          createWindow: (options) => {
            const bag = options as unknown as { webContents?: WebContents }
            return this.events.adopt(this, bag.webContents)
          }
        }
      }
      return { action: 'deny' }
    })

    const bump = (): void => {
      this.generation += 1
      this.emit()
    }
    wc.on('did-start-loading', () => {
      this.loadState = 'loading'
      this.error = null
      this.emit()
    })
    wc.on('did-stop-loading', () => {
      this.scheduleStill()
      this.loadState = this.error ? 'error' : 'ready'
      this.emit()
    })
    // A document change invalidates every uid minted under the old one. The
    // snapshot layer guards on loaderId too (Page.frameNavigated); bumping
    // here is what lets a tool refuse a stale ref with a message instead of a
    // wrong click.
    wc.on('did-navigate', bump)
    wc.on('did-navigate-in-page', () => this.emit())
    wc.on('page-title-updated', () => this.emit())
    wc.on('did-fail-load', (_e, code, description, _url, isMainFrame) => {
      if (!isMainFrame || code === -3 /* ERR_ABORTED: a navigation superseded this one */) return
      this.error = { code: String(code), message: description }
      this.loadState = 'error'
      this.emit()
    })
    // The app has no crash instrumentation at all today; a browser tab is
    // exactly where it starts to matter. A dead renderer leaves CDP pending
    // forever, so the card must say so rather than freeze silently.
    wc.on('render-process-gone', (_e, details) => {
      this.error = {
        code: details.reason,
        message: `The page stopped responding (${details.reason}).`
      }
      this.loadState = 'error'
      this.streamer.dispose()
      this.emit()
    })
  }

  setStage(rect: BrowserRect | null): void {
    this.stage = rect ?? DEFAULT_STAGE
    this.applyBounds()
  }

  /**
   * Bounds come from the RENDERER, always. The reference shell mirrors its CSS
   * chrome height as a constant in main and that constant has already drifted
   * once, tuned by eye, in a commit that changed no CSS. This app's chrome is
   * React with variable-height chips and composer — measuring it in main would
   * be wrong by construction.
   */
  private applyBounds(): void {
    if (!this.isAlive || !this.window || this.window.isDestroyed()) return
    const content = this.window.getContentBounds()
    const width = Math.max(1, Math.min(Math.round(this.stage.width), content.width))
    const height = Math.max(1, Math.min(Math.round(this.stage.height), content.height))
    if (this.mode === 'card') {
      // Parked: one pixel of the page inside the window, at the corner.
      this.view.setBounds({ x: content.width - 1, y: content.height - 1, width, height })
      return
    }
    const x = Math.max(0, Math.min(Math.round(this.stage.x), Math.max(0, content.width - width)))
    const y = Math.max(0, Math.min(Math.round(this.stage.y), Math.max(0, content.height - height)))
    this.view.setBounds({ x, y, width, height })
  }

  setMode(mode: BrowserTabMode): void {
    if (!this.isAlive || !this.window || this.window.isDestroyed()) return
    if (this.mode === mode) return
    this.mode = mode
    // Expanding raises this tab above any other tab's view (re-adding an
    // existing child moves it to the top); parking is a move to the corner.
    if (mode === 'expanded') this.window.contentView.addChildView(this.view)
    this.applyBounds()
    this.emit()
  }

  snapshot(): BrowserTabSnapshot {
    const wc = this.isAlive ? this.view.webContents : null
    return {
      tabId: this.id,
      conversationId: this.conversationId,
      url: wc?.getURL() ?? '',
      title: wc?.getTitle() ?? '',
      loadState: this.loadState,
      canGoBack: wc?.navigationHistory.canGoBack() ?? false,
      canGoForward: wc?.navigationHistory.canGoForward() ?? false,
      mode: this.mode,
      frameSize: { width: this.stage.width, height: this.stage.height },
      generation: this.generation,
      error: this.error,
      active: this.events.isActive(this.id),
      strip: this.events.strip(this.conversationId),
      still: this.still
    }
  }

  /**
   * The phone's view of this tab: one JPEG per settled load (and per
   * activation), never a stream. Debounced so a page that fires several
   * did-stop-loading events in a row costs one capture; skipped entirely
   * when no phone is paired, so the desktop alone never writes a frame.
   */
  scheduleStill(delayMs = 1200): void {
    if (!this.events.wantsStill()) return
    if (this.stillTimer) clearTimeout(this.stillTimer)
    this.stillTimer = setTimeout(() => {
      this.stillTimer = null
      void this.captureStill()
    }, delayMs)
  }

  private async captureStill(): Promise<void> {
    if (!this.isAlive || this.loadState === 'loading') return
    try {
      const image = await this.view.webContents.capturePage()
      if (image.isEmpty()) return
      const scaled = image.getSize().width > 800 ? image.resize({ width: 800 }) : image
      const safe = (this.conversationId ?? 'unknown').replace(/[^A-Za-z0-9._-]/g, '_')
      const relDir = path.posix.join('files', 'screenshots', `conv-${safe}`)
      const dir = path.join(workspaceRoot(), 'files', 'screenshots', `conv-${safe}`)
      await fs.mkdir(dir, { recursive: true })
      const name = `browser-${this.id.slice(0, 8)}-${++this.stillSeq}.jpg`
      await fs.writeFile(path.join(dir, name), scaled.toJPEG(68))
      if (!this.isAlive) return
      const prev = this.still
      this.still = path.posix.join(relDir, name)
      // A new name per capture so the phone's path-keyed cache refetches;
      // the previous frame goes so the folder never accumulates.
      if (prev) void fs.unlink(path.join(workspaceRoot(), prev)).catch(() => undefined)
      this.emit()
    } catch (err) {
      wlog.debug(TAG, `still capture failed for ${this.id}:`, err)
    }
  }

  emit(): void {
    if (this.destroyed || !this.ready) return
    this.events.onChanged(this.snapshot())
  }

  /**
   * Idempotent, and an arrow property so it can be handed straight to an
   * event. Order matters at every step: each one needs the previous object
   * still valid. Null the window before stopping the resize listener and the
   * listener stays attached, throwing inside the window's resize event for the
   * rest of its life.
   */
  readonly destroy = (reason: BrowserCloseReason): void => {
    if (this.destroyed) return
    this.destroyed = true

    if (this.window && !this.window.isDestroyed()) {
      this.window.off('resize', this.onWindowResize)
    }
    if (this.stillTimer) clearTimeout(this.stillTimer)
    this.streamer.dispose()
    this.cdp.detach()

    try {
      if (this.window && !this.window.isDestroyed()) {
        this.window.contentView.removeChildView(this.view)
      }
    } catch {
      // removeChildView is a no-op for a non-child; nothing to recover
    }
    this.window = null

    const wc = this.view.webContents
    try {
      if (!wc.isDestroyed()) {
        if (wc.isDevToolsOpened()) wc.closeDevTools()
        // close(), not destroy(). destroy() is not in Electron's public API
        // and does not reliably emit 'destroyed' — which is why the reference
        // shell has to FAKE that event with a synthetic emit under a
        // "why is this no longer called?" TODO. Faking an Electron lifecycle
        // event breaks silently on the next upgrade, with no compile error.
        wc.close()
      }
    } catch (err) {
      wlog.warn(TAG, `tab ${this.id} close failed:`, err)
    }

    this.events.onClosed(this.id, reason)
  }
}

export class BrowserTabManager {
  private readonly tabs = new Map<string, Tab>()
  private getWindow: () => BrowserWindow | null = () => null
  private onChangedCb: (snapshot: BrowserTabSnapshot) => void = () => {}
  private onClosedCb: (tabId: string, reason: BrowserCloseReason) => void = () => {}
  private onFrameCb: FrameSink = () => {}
  /**
   * Per-turn segment emitters, the countdown manager's pattern: while the
   * turn that opened a tab is live, every change also rides that turn's
   * broca as a `browser` segment (upserted by tabId), so the card sits in
   * the transcript at the position the page was opened. After the turn ends
   * the same snapshots reach the renderer through the browser:changed
   * broadcast and fold into the persisted segment.
   */
  private readonly turnEmitters = new Map<string, (snapshot: BrowserTabSnapshot) => void>()

  registerTurnEmitter(turnId: string, emit: (snapshot: BrowserTabSnapshot) => void): () => void {
    this.turnEmitters.set(turnId, emit)
    return () => this.turnEmitters.delete(turnId)
  }

  /** Mirrors attention.ts: a no-op resolver until installed, so this module
   *  stays importable from tests that never open a window, and headless boot
   *  (where there is permanently no window) is correct for free. */
  install(getWindow: () => BrowserWindow | null): void {
    this.getWindow = getWindow
  }

  setHandlers(handlers: {
    onChanged: (snapshot: BrowserTabSnapshot) => void
    onClosed: (tabId: string, reason: BrowserCloseReason) => void
    onFrame: FrameSink
  }): void {
    this.onChangedCb = handlers.onChanged
    this.onClosedCb = handlers.onClosed
    this.onFrameCb = handlers.onFrame
  }

  /**
   * One browser per conversation, showing one tab: the active one. The model
   * opening or touching a tab makes it active (the user sees what the model
   * works on); the user picks one from the card's tab strip. Keyed by
   * conversation id, '' for the rare tab with none.
   */
  private readonly activeByConversation = new Map<string, string>()
  /** Set by index.ts: true while a phone is paired (Tab.scheduleStill). */
  private stillGate: () => boolean = () => false

  setStillGate(gate: () => boolean): void {
    this.stillGate = gate
  }

  private convKey(tab: Tab): string {
    return tab.conversationId ?? ''
  }

  isActive(tabId: string): boolean {
    const tab = this.tabs.get(tabId)
    return !!tab && this.activeByConversation.get(this.convKey(tab)) === tabId
  }

  activate(tabId: string): void {
    const tab = this.get(tabId)
    if (!tab) return
    const key = this.convKey(tab)
    const prevId = this.activeByConversation.get(key)
    if (prevId === tabId) return
    this.activeByConversation.set(key, tabId)
    if (prevId) this.tabs.get(prevId)?.emit()
    tab.emit()
    tab.scheduleStill(300)
  }

  private events(): TabEvents {
    return {
      onChanged: (s) => {
        const tab = this.tabs.get(s.tabId)
        if (tab?.turnId) this.turnEmitters.get(tab.turnId)?.(s)
        this.onChangedCb(s)
      },
      onClosed: (id, reason) => {
        const closing = this.tabs.get(id)
        this.tabs.delete(id)
        this.onClosedCb(id, reason)
        // The active tab went: the newest remaining one takes over so the
        // card never shows nothing while a page is still open.
        if (closing) {
          const key = this.convKey(closing)
          if (this.activeByConversation.get(key) === id) {
            this.activeByConversation.delete(key)
            const rest = [...this.tabs.values()].filter((t) => t.isAlive && this.convKey(t) === key)
            const next = rest[rest.length - 1]
            if (next) this.activate(next.id)
          }
        }
      },
      isActive: (tabId) => this.isActive(tabId),
      wantsStill: () => this.stillGate(),
      strip: (conversationId) =>
        [...this.tabs.values()]
          .filter((t) => t.isAlive && t.conversationId === conversationId)
          .map((t) => ({
            url: t.webContents.getURL(),
            title: t.webContents.getTitle(),
            active: this.isActive(t.id)
          })),
      onFrame: (f) => this.onFrameCb(f),
      adopt: (opener, adopted) => {
        const window = this.getWindow()
        if (!window) throw new Error('no window to host the adopted tab')
        const tab = new Tab({
          window,
          conversationId: opener.conversationId,
          turnId: opener.turnId,
          partition: opener.partition,
          events: this.events(),
          ...(adopted ? { adopted } : {})
        })
        this.tabs.set(tab.id, tab)
        // An adopted guest already has a renderer (Electron created it for the
        // window.open), so attaching now is safe; ready the moment it exists.
        tab.ready = true
        void tab
          .attachDebugger()
          .catch((err: unknown) => wlog.warn(TAG, 'adopted tab attach failed:', err))
        this.activate(tab.id)
        tab.emit()
        return tab.webContents
      }
    }
  }

  async createTab(input: {
    url: string
    conversationId: string | null
    turnId?: string | null
    partition?: BrowserPartition
  }): Promise<BrowserTabSnapshot> {
    const window = this.getWindow()
    if (!window) throw new Error('The app window is not open, so there is nowhere to show a page.')

    const tab = new Tab({
      window,
      conversationId: input.conversationId,
      turnId: input.turnId ?? null,
      partition: input.partition ?? BROWSER_PARTITION,
      events: this.events()
    })
    this.tabs.set(tab.id, tab)
    try {
      // Load FIRST, attach SECOND. A WebContents that has never navigated has
      // no renderer yet, and a debugger attached to it hangs on its first
      // command (Page.enable timed out at 30s, twice, in the first live turn)
      // and never recovers for that tab. The spike attached after loadURL and
      // every command answered. Load exactly once, with the real URL — the
      // reference shell loads a blank new-tab page and then every caller loads
      // the real one, which throws away a window.open's POST body.
      await tab.webContents.loadURL(input.url).catch((err: unknown) => {
        wlog.warn(TAG, `initial load failed for ${input.url}:`, err)
      })
      if (!tab.isAlive) throw new Error('The page closed before it finished opening.')
      await tab.attachDebugger()
    } catch (err) {
      // A half-made tab must not survive as a blank card: the first live turn
      // left six of them behind, one per failed open.
      tab.destroy('crashed')
      throw err
    }
    tab.ready = true
    this.activate(tab.id)
    tab.emit()
    return tab.snapshot()
  }

  get(tabId: string): Tab | null {
    const tab = this.tabs.get(tabId)
    // Defensive at read time: removal depends on an event that can be missed,
    // and a stale entry should read as absent rather than throw on use.
    if (!tab || !tab.isAlive) return null
    return tab
  }

  require(tabId: string): Tab {
    const tab = this.get(tabId)
    if (!tab) throw new Error(`No open page with id ${tabId}. It may have been closed.`)
    return tab
  }

  list(): BrowserTabSnapshot[] {
    return [...this.tabs.values()].filter((t) => t.isAlive).map((t) => t.snapshot())
  }

  listForConversation(conversationId: string | null): BrowserTabSnapshot[] {
    return this.list().filter((t) => t.conversationId === conversationId)
  }

  closeTab(tabId: string, reason: BrowserCloseReason = 'agent'): void {
    this.tabs.get(tabId)?.destroy(reason)
  }

  setStage(tabId: string, rect: BrowserRect | null): void {
    this.get(tabId)?.setStage(rect)
  }

  setMode(tabId: string, mode: BrowserTabMode): BrowserTabSnapshot {
    const tab = this.require(tabId)
    tab.setMode(mode)
    return tab.snapshot()
  }

  async attachViewer(
    tabId: string,
    size: { width: number; height: number },
    fps: BrowserFps
  ): Promise<void> {
    const tab = this.get(tabId)
    if (!tab) {
      wlog.debug(TAG, `attachViewer for unknown/closed tab ${tabId}`)
      return
    }
    wlog.debug(
      TAG,
      `attachViewer ${tabId} ${size.width}x${size.height} @${fps}fps (viewers before: ${tab.streamer.viewerCount})`
    )
    await tab.streamer.attachViewer(size, fps)
  }

  /**
   * Input from the card, forwarded as-is. The page viewport in card mode is
   * the card, so the card's CSS coordinates are the page's. Anything not in
   * the shape is dropped rather than passed to Electron.
   */
  sendInput(tabId: string, event: BrowserInputEvent): void {
    const tab = this.get(tabId)
    if (!tab) return
    const t = event.type
    const mouse = t === 'mouseDown' || t === 'mouseUp' || t === 'mouseMove' || t === 'mouseWheel'
    const key = t === 'keyDown' || t === 'keyUp' || t === 'char'
    if (!mouse && !key) return
    try {
      tab.webContents.sendInputEvent(
        event as
          | Electron.MouseInputEvent
          | Electron.MouseWheelInputEvent
          | Electron.KeyboardInputEvent
      )
    } catch (err) {
      wlog.debug(TAG, `sendInput ${t} failed:`, err)
    }
  }

  /** The card was resized: re-encode frames at its new device-pixel size. */
  async setViewerSize(tabId: string, size: { width: number; height: number }): Promise<void> {
    await this.get(tabId)?.streamer.setSize(size)
  }

  async detachViewer(tabId: string): Promise<void> {
    await this.get(tabId)?.streamer.detachViewer()
  }

  async setViewerFps(tabId: string, fps: BrowserFps): Promise<void> {
    await this.get(tabId)?.streamer.setFps(fps)
  }

  /** Every terminal path funnels here. Synchronous by design: will-quit will
   *  not await a promise, and app.exit() skips will-quit entirely. */
  destroyAll(reason: BrowserCloseReason = 'shutdown'): void {
    for (const tab of [...this.tabs.values()]) tab.destroy(reason)
    this.tabs.clear()
  }

  openExternal(url: string): void {
    void shell.openExternal(url)
  }
}

export const browserTabs = new BrowserTabManager()
