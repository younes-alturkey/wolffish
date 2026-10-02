/**
 * Partition setup for the in-app browser.
 *
 * Everything a guest page is allowed to do is decided here, once per
 * partition, inside whenReady. The renderer never sees these knobs: main is
 * the only enforcement point a careless renderer cannot bypass.
 *
 * Note what this is NOT: there is no cookie snapshot, no vault, no replay. A
 * `persist:` partition already writes an encrypted Chromium profile to disk
 * and restores it on launch — `safeStorage` is literally the same OSCrypt key
 * the network service uses for the Cookies DB, so a second encrypted copy
 * would add risk (a stale replay can log the user out) and no protection. The
 * one real gap is the 30s/512-op commit window, which `flushStore()` on the
 * quit path closes; see flushBrowserCookies below.
 */
import { app, session, type Session } from 'electron'
import { wlog } from '@main/workspace/logger'
import {
  BROWSER_CLEAN_PARTITION,
  BROWSER_PARTITION,
  type BrowserPartition
} from '@main/browser/types'

const TAG = 'browser'

/**
 * Permissions a browsing guest may ask for. Fullscreen and pointer lock are
 * what a real browser grants on a click; everything a browser would PROMPT
 * for stays refused, because there is nowhere in a chat card to render that
 * prompt honestly. Mirrors the HTML-preview partition's posture.
 */
const ALLOWED_PERMISSIONS = new Set(['fullscreen', 'pointerLock'])

/**
 * Electron's default UA carries `Electron/39.x` and the app name, and Google
 * (among others) refuses to serve a sign-in page to it. Stripping those two
 * tokens leaves an ordinary Chrome UA for the bundled Chromium, which is what
 * the guest actually is.
 */
function browserUserAgent(): string {
  return app.userAgentFallback
    .replace(/\sElectron\/\S+/i, '')
    .replace(new RegExp(`\\s${app.getName()}\\/\\S+`, 'i'), '')
    .replace(/\s{2,}/g, ' ')
    .trim()
}

const configured = new Set<string>()

/** Idempotent: safe to call per tab creation, does its work once per partition. */
export function configureBrowserSession(partition: BrowserPartition): Session {
  const ses = session.fromPartition(partition)
  if (configured.has(partition)) return ses
  configured.add(partition)

  const ua = browserUserAgent()
  ses.setUserAgent(ua)
  // setUserAgent alone does not cover every request a page makes (workers and
  // some subresources still carry the default), so rewrite the header too.
  ses.webRequest.onBeforeSendHeaders((details, callback) => {
    const headers = { ...details.requestHeaders }
    if (typeof headers['User-Agent'] === 'string' && headers['User-Agent'].includes('Electron/')) {
      headers['User-Agent'] = ua
    }
    callback({ requestHeaders: headers })
  })

  ses.setPermissionRequestHandler((_contents, permission, callback) => {
    callback(ALLOWED_PERMISSIONS.has(permission))
  })
  // The synchronous sibling. Without it `navigator.permissions.query` and a
  // few capability checks answer from Electron's default instead of ours.
  ses.setPermissionCheckHandler((_contents, permission) => ALLOWED_PERMISSIONS.has(permission))
  // USB / HID / Serial device pickers.
  ses.setDevicePermissionHandler(() => false)
  // getDisplayMedia — a page in a chat card has no business capturing a
  // screen. An empty streams object is how Electron expresses "denied"; a
  // null handler would fall back to the default, which is not a refusal.
  ses.setDisplayMediaRequestHandler((_request, callback) => callback({}))

  // Downloads are refused by default. A download is a file landing on the
  // user's disk from a page the model may have navigated to on its own, so it
  // goes through a tool that names the file and the destination, not through
  // a page's own <a download>.
  ses.on('will-download', (event, item) => {
    event.preventDefault()
    wlog.info(TAG, `download refused: ${item.getFilename()} (${item.getURL()})`)
  })

  wlog.info(TAG, `partition ${partition} configured (ua: ${ua.slice(0, 60)}…)`)
  return ses
}

/**
 * Chromium batches cookie writes — every 30 seconds or 512 operations. A hard
 * exit inside that window loses a login the user just completed, which is the
 * ONE real persistence gap a `persist:` partition has. One await on the quit
 * path closes it.
 */
export async function flushBrowserCookies(): Promise<void> {
  for (const partition of configured) {
    try {
      await session.fromPartition(partition).cookies.flushStore()
    } catch (err) {
      wlog.warn(TAG, `cookie flush failed for ${partition}:`, err)
    }
  }
}

/** Sign out of one site: everything the partitions hold for that origin. */
export async function clearSiteData(origin: string): Promise<void> {
  for (const partition of configured) {
    try {
      await session.fromPartition(partition).clearData({ origins: [origin] })
    } catch (err) {
      wlog.warn(TAG, `clearData failed for ${origin} in ${partition}:`, err)
    }
  }
}

export { BROWSER_PARTITION, BROWSER_CLEAN_PARTITION }
