/**
 * Private previews — how the Web UI shows an .html file the way the desktop's
 * <webview> does: live, scripts running, relative assets resolving, and none
 * of it able to touch the app.
 *
 * A browser has no <webview>. Its nearest thing is an <iframe>, and the
 * obvious source, /files/…, fails twice: served from the app's own origin,
 * the page's scripts would BE the app (a page the agent wrote could open /ws
 * with the user's cookie and drive the agent), and sandboxed into an opaque
 * origin to stop that, its own requests no longer carry the SameSite=Strict
 * cookie, so every relative asset answers 401.
 *
 * So a preview is a grant: an unguessable token naming the file's folder,
 * minted for one signed-in session over the socket and served at
 * /preview/<token>/… with no cookie — always under a CSP sandbox, so the page
 * runs in an opaque origin whether the chat card frames it or a tab opens it.
 * Grants live in memory only: they slide while the page is in use and die
 * with their session, the process, or a long idle.
 */
import { forbiddenRoots, isWithin } from '@main/channels/web/public'
import { randomBytes } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'

export const PREVIEW_PATH_PREFIX = '/preview/'

/**
 * The page's powers: everything a page needs to run, never its real origin
 * (no allow-same-origin) and never the app's tab (no top navigation). The
 * renderer's iframe carries the same tokens (HtmlPreview).
 */
export const PREVIEW_CSP =
  'sandbox allow-scripts allow-forms allow-modals allow-popups ' +
  'allow-popups-to-escape-sandbox allow-pointer-lock allow-downloads'

const TOKEN_BYTES = 24
const IDLE_MS = 6 * 3_600_000
const MAX_GRANTS = 256

/** Past this a page is streamed as it is, without STORAGE_SHIM. */
export const PREVIEW_SHIM_MAX_BYTES = 16 * 1024 * 1024

/**
 * Storage for a page that has none. An opaque origin has no localStorage or
 * sessionStorage — touching either throws — so a page that reads its saved
 * state as it loads (a game's high score, a to-do list) dies before it draws.
 * This stands in for both, in memory, only where the real one throws: what
 * the desktop's preview keeps across reloads, the Web UI keeps until one.
 */
const STORAGE_SHIM =
  '<script>(()=>{const m=()=>{const s=new Map();const a={get length(){return s.size},' +
  'key:(i)=>[...s.keys()][i]??null,getItem:(k)=>(s.has(String(k))?s.get(String(k)):null),' +
  'setItem:(k,v)=>{s.set(String(k),String(v))},removeItem:(k)=>{s.delete(String(k))},' +
  'clear:()=>s.clear()};return new Proxy(a,{get:(t,p)=>(p in t?t[p]:s.get(String(p))),' +
  'set:(t,p,v)=>(p in t?false:(s.set(String(p),String(v)),true)),' +
  'deleteProperty:(t,p)=>s.delete(String(p))||true,has:(t,p)=>p in t||s.has(String(p)),' +
  'ownKeys:()=>[...s.keys()],getOwnPropertyDescriptor:(t,p)=>(s.has(String(p))?' +
  '{value:s.get(String(p)),writable:true,enumerable:true,configurable:true}:undefined)})};' +
  "for(const n of['localStorage','sessionStorage']){try{window[n]}catch{" +
  'try{Object.defineProperty(window,n,{value:m(),configurable:true})}catch{}}}})()</script>'

/**
 * The page with STORAGE_SHIM as its first script: after <head>, else <html>,
 * else the doctype — never before the doctype, which would drop the page
 * into quirks mode.
 */
export function withStorageShim(html: string): string {
  const anchor =
    /<head(?:\s[^>]*)?>/i.exec(html) ??
    /<html(?:\s[^>]*)?>/i.exec(html) ??
    /^\s*<!doctype[^>]*>/i.exec(html)
  const at = anchor ? anchor.index + anchor[0].length : 0
  return html.slice(0, at) + STORAGE_SHIM + html.slice(at)
}

export type PreviewGrant = {
  token: string
  sessionId: string
  /** The symlink-resolved folder the token serves. */
  root: string
  /** Set when only this one file may be served: its folder holds the app's secrets. */
  only: string | null
  expiresAt: number
}

export class PreviewGrants {
  private readonly grants = new Map<string, PreviewGrant>()

  constructor(private readonly now: () => number = Date.now) {}

  /**
   * The URL path that previews `file` for `sessionId`, or null when the file
   * may not be shown. The same session asking for the same folder gets the
   * same token back, so re-rendering a card never mints another.
   */
  async grant(sessionId: string, file: string): Promise<string | null> {
    let real: string
    try {
      real = await fs.realpath(file)
      if (!(await fs.stat(real)).isFile()) return null
    } catch {
      return null
    }
    const forbidden = await forbiddenRoots()
    if (forbidden.some((root) => isWithin(real, root))) return null
    const root = path.dirname(real)
    const name = path.basename(real)
    // A page sitting next to the app's secrets (the workspace root, the home
    // folder) previews alone: its folder is never handed out.
    const only = forbidden.some((f) => isWithin(f, root)) ? name : null
    this.sweep()
    const t = this.now()
    let grant = [...this.grants.values()].find(
      (g) => g.sessionId === sessionId && g.root === root && g.only === only
    )
    if (grant) {
      grant.expiresAt = t + IDLE_MS
    } else {
      grant = {
        token: randomBytes(TOKEN_BYTES).toString('base64url'),
        sessionId,
        root,
        only,
        expiresAt: t + IDLE_MS
      }
      this.grants.set(grant.token, grant)
      this.trim()
    }
    return `${PREVIEW_PATH_PREFIX}${grant.token}/${encodeURIComponent(name)}`
  }

  /** The live grant a token names, its idle clock reset; null when expired or unknown. */
  resolve(token: string): PreviewGrant | null {
    const grant = this.grants.get(token)
    if (!grant) return null
    const t = this.now()
    if (grant.expiresAt <= t) {
      this.grants.delete(token)
      return null
    }
    grant.expiresAt = t + IDLE_MS
    return grant
  }

  /** Drop every grant of the sessions `drop` names — a sign-out ends its previews. */
  revoke(drop: (sessionId: string) => boolean): void {
    for (const [token, grant] of this.grants) if (drop(grant.sessionId)) this.grants.delete(token)
  }

  private sweep(): void {
    const t = this.now()
    for (const [token, grant] of this.grants) if (grant.expiresAt <= t) this.grants.delete(token)
  }

  private trim(): void {
    if (this.grants.size <= MAX_GRANTS) return
    const oldest = [...this.grants.values()].sort((a, b) => a.expiresAt - b.expiresAt)
    for (const grant of oldest.slice(0, this.grants.size - MAX_GRANTS))
      this.grants.delete(grant.token)
  }
}

/**
 * The file a preview request names inside its grant, or null. `rest` is the
 * raw path after the token (`/index.html`, `/img/a%20b.png`). Only files are
 * served — no listings, no index fallback — and whatever a symlink points at
 * must sit inside the granted folder too.
 */
export async function previewFile(grant: PreviewGrant, rest: string): Promise<string | null> {
  let decoded: string
  try {
    decoded = decodeURIComponent(rest.replace(/^\/+/, ''))
  } catch {
    return null
  }
  if (!decoded || decoded.includes('\0') || decoded.split(/[\\/]/).includes('..')) return null
  if (grant.only !== null && decoded !== grant.only) return null
  const abs = path.join(grant.root, decoded)
  if (!isWithin(abs, grant.root) || abs === grant.root) return null
  try {
    const real = await fs.realpath(abs)
    if (!isWithin(real, grant.root) || real === grant.root) return null
    if (!(await fs.stat(real)).isFile()) return null
    return real
  } catch {
    return null
  }
}
