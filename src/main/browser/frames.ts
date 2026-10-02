/**
 * Screencast → chat card.
 *
 * Every number in here was measured, not reasoned about. The spike ran four
 * frame mechanisms against five visibility states in Electron 39.8.9:
 *
 *   z-parked at index 0 / CDP screencast   60.2 live fps   setInterval 100/s
 *   view.setVisible(false)                  0.0 live fps   setInterval   2/s
 *   never attached to a window              0.0 live fps   innerWidth 0
 *
 * So the card streams from a view that is genuinely composited and merely
 * covered by the app UI.
 *
 * The rate limit is OURS, not Chromium's. `everyNthFrame` counts compositor
 * frames, so on the spike's 60fps canvas page everyNthFrame:12 measured a
 * clean 5.0 fps — and on a real page, which repaints only when something
 * changes, a scroll's two or three frames never reach the twelfth and the
 * card stays blank forever (the first live turn). So every damage frame is
 * requested and delivery is throttled here: a frame inside the interval is
 * dropped, never queued — for live video the newest frame is the only one
 * that matters — and every frame is acked, because the ack is Chromium's
 * backpressure, not its clock.
 */
import type { BrowserFps, BrowserFrame } from '@main/browser/types'
import type { CdpSession } from '@main/browser/cdp'
import { wlog } from '@main/workspace/logger'

const TAG = 'browser'

/** Minimum gap between frames handed to the card, per rate. */
const INTERVAL_MS: Record<BrowserFps, number> = { 5: 200, 30: 33 }

/** JPEG quality. 60 is the knee: visibly fine in a ~650px card, ~35KB/frame. */
const QUALITY = 60

type ScreencastFrameParams = {
  data: string
  sessionId: number
  metadata?: {
    offsetTop?: number
    pageScaleFactor?: number
    deviceWidth?: number
    deviceHeight?: number
    scrollOffsetX?: number
    scrollOffsetY?: number
  }
}

export type FrameSink = (frame: BrowserFrame) => void

/**
 * One streamer per tab. Refcounted by viewer: a card that scrolls out of the
 * chat viewport detaches, the stream stops, and the tab stays alive holding
 * its last frame as a still. That refcount is the whole cost story — parking a
 * composited page that nobody is streaming is close to free, encoding and
 * shipping frames is not.
 */
export class FrameStreamer {
  private readonly cdp: CdpSession
  private readonly tabId: string
  private readonly sink: FrameSink
  private viewers = 0
  private running = false
  private fps: BrowserFps = 5
  private size = { width: 650, height: 400 }
  private seq = 0
  private lastSentAt = 0
  private unsubscribe: (() => void) | null = null
  /** Set the moment a start is issued, so two concurrent attaches cannot
   *  both call startScreencast — Chromium throws "already active". */
  private starting = false

  constructor(tabId: string, cdp: CdpSession, sink: FrameSink) {
    this.tabId = tabId
    this.cdp = cdp
    this.sink = sink
  }

  get isStreaming(): boolean {
    return this.running
  }

  get viewerCount(): number {
    return this.viewers
  }

  async attachViewer(size: { width: number; height: number }, fps: BrowserFps): Promise<void> {
    this.size = size
    this.fps = fps
    this.viewers += 1
    if (this.viewers === 1) await this.start()
  }

  async detachViewer(): Promise<void> {
    this.viewers = Math.max(0, this.viewers - 1)
    if (this.viewers === 0) await this.stop()
  }

  /** Hover raises the rate; leaving drops it. The throttle is ours, so this
   *  takes effect on the next frame with no restart. */
  async setFps(fps: BrowserFps): Promise<void> {
    this.fps = fps
  }

  async setSize(size: { width: number; height: number }): Promise<void> {
    if (size.width === this.size.width && size.height === this.size.height) return
    this.size = size
    if (this.running) {
      await this.stop()
      await this.start()
    }
  }

  private async start(): Promise<void> {
    if (this.running || this.starting || !this.cdp.isAttached) {
      wlog.debug(
        TAG,
        `screencast start skipped for ${this.tabId}: running=${this.running} starting=${this.starting} attached=${this.cdp.isAttached}`
      )
      return
    }
    this.starting = true
    try {
      this.unsubscribe = this.cdp.on((method, params) => {
        if (method === 'Page.screencastVisibilityChanged') {
          // Chromium's own word on whether the parked view is composited.
          // `false` here means frames have stopped for a reason we did not
          // cause; it is the tripwire for the visibility-proof fallback.
          wlog.info(
            TAG,
            `screencast visibility for ${this.tabId}: ${String((params as { visible?: boolean }).visible)}`
          )
          return
        }
        if (method !== 'Page.screencastFrame') return
        if (this.seq === 0) wlog.debug(TAG, `first screencast frame for ${this.tabId}`)
        this.onFrame(params as unknown as ScreencastFrameParams)
      })
      await this.cdp.send('Page.enable')
      await this.cdp.send('Page.startScreencast', {
        format: 'jpeg',
        quality: QUALITY,
        // Cap at the source: Chromium never encodes bytes we would discard.
        maxWidth: Math.max(1, Math.round(this.size.width)),
        maxHeight: Math.max(1, Math.round(this.size.height)),
        // Every damage frame; the throttle is in onFrame (see the header).
        everyNthFrame: 1
      })
      this.lastSentAt = 0
      this.running = true
      wlog.debug(
        TAG,
        `screencast started for ${this.tabId} at ${this.fps}fps ${this.size.width}x${this.size.height}`
      )
      void this.primeFirstFrame()
    } catch (err) {
      this.unsubscribe?.()
      this.unsubscribe = null
      wlog.warn(TAG, `screencast start failed for ${this.tabId}:`, err)
    } finally {
      this.starting = false
    }
  }

  /**
   * A screencast emits only on DAMAGE — a repaint. A page that is done
   * loading and sits still (most pages, most of the time; the first live
   * turn's test page ticked its <title>, which repaints nothing) sends no
   * frame at all, and the card would say "waiting" over a page that is
   * perfectly fine. So every start is primed with one real capture.
   * `Page.captureScreenshot` is also the one capture path that pins a
   * capturer count, i.e. it answers even when Chromium would not composite
   * on its own — which makes it the visibility-proof floor as well.
   */
  private async primeFirstFrame(): Promise<void> {
    const startedAt = this.seq
    try {
      const res = await this.cdp.send<{ data: string }>('Page.captureScreenshot', {
        format: 'jpeg',
        quality: QUALITY,
        fromSurface: true
      })
      // A real screencast frame beat us: nothing to do.
      if (!this.running || this.seq !== startedAt || !res.data) return
      wlog.debug(TAG, `primed first frame for ${this.tabId} (${res.data.length} b64 chars)`)
      this.lastSentAt = Date.now()
      this.sink({
        tabId: this.tabId,
        data: Buffer.from(res.data, 'base64'),
        width: this.size.width,
        height: this.size.height,
        page: {
          offsetTop: 0,
          pageScaleFactor: 1,
          deviceWidth: this.size.width,
          deviceHeight: this.size.height,
          scrollOffsetX: 0,
          scrollOffsetY: 0
        },
        seq: this.seq++
      })
    } catch (err) {
      wlog.debug(TAG, `first-frame capture failed for ${this.tabId}:`, err)
    }
  }

  private async stop(): Promise<void> {
    this.unsubscribe?.()
    this.unsubscribe = null
    if (!this.running) return
    this.running = false
    this.cdp.sendSilent('Page.stopScreencast')
  }

  private onFrame(params: ScreencastFrameParams): void {
    const meta = params.metadata ?? {}
    try {
      if (!params.data) return
      // Rate limit by dropping. A frame that lands inside the interval is
      // discarded; the next one after the interval carries the newest pixels
      // anyway. The primed first frame and the first real frame always pass.
      const now = Date.now()
      if (this.seq > 0 && now - this.lastSentAt < INTERVAL_MS[this.fps]) return
      this.lastSentAt = now
      this.sink({
        tabId: this.tabId,
        data: Buffer.from(params.data, 'base64'),
        width: this.size.width,
        height: this.size.height,
        page: {
          offsetTop: meta.offsetTop ?? 0,
          pageScaleFactor: meta.pageScaleFactor ?? 1,
          deviceWidth: meta.deviceWidth ?? this.size.width,
          deviceHeight: meta.deviceHeight ?? this.size.height,
          scrollOffsetX: meta.scrollOffsetX ?? 0,
          scrollOffsetY: meta.scrollOffsetY ?? 0
        },
        seq: this.seq++
      })
    } catch (err) {
      // A sink that throws (an unclonable payload, a dead window) must not
      // kill the ack below — that would freeze the stream instead of logging.
      wlog.warn(TAG, `frame sink threw for ${this.tabId}:`, err)
    } finally {
      // Ack AFTER the consumer has taken the frame, never before. This is the
      // backpressure: Chromium will not capture the next frame while this one
      // is unacked. agent-browser acks first and so runs its producer flat out
      // regardless of consumer health — the bug worth not inheriting.
      this.cdp.sendSilent('Page.screencastFrameAck', { sessionId: params.sessionId })
    }
  }

  dispose(): void {
    this.viewers = 0
    void this.stop()
  }
}
