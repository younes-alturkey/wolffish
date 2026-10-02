export type PathInfo = { exists: boolean; isDirectory: boolean }

// Home directory, learned once (best-effort) so `~/x` and `/Users/me/x` can be
// folded to one canonical key for dedup. rootPath is `<home>/.wolffish/workspace`.
let homeDir: string | null = null
let homeRequested = false
function ensureHome(): void {
  if (homeRequested) return
  homeRequested = true
  try {
    void window.api?.workspace
      ?.getStatus?.()
      .then((s) => {
        const root = s?.rootPath?.replace(/[\\/]+$/, '')
        const m = root?.match(/^(.*)\/\.wolffish\/workspace$/)
        if (m) homeDir = m[1]
      })
      .catch(() => {})
  } catch {
    // window.api unavailable (e.g. tests) — dedup falls back to the raw string.
  }
}

/**
 * Canonical key for deduping paths: trailing slashes dropped, and `~` expanded
 * to the home dir once it's known so `~/x` and `/Users/me/x` collapse together.
 * Best-effort — before home loads (or if it can't be derived) `~/x` keys as-is,
 * which simply means that one rare cross-form duplicate isn't folded.
 */
export function canonicalPath(p: string): string {
  ensureHome()
  const s = p.trim().replace(/\/+$/, '')
  if (homeDir) {
    if (s === '~') return homeDir
    if (s.startsWith('~/')) return `${homeDir}/${s.slice(2)}`
  }
  return s
}

// The renderer is sandboxed — existence can only be answered by an async IPC to
// main. So we guard that cost with a tiny cache: a path is stat'd at most once
// per TTL window, concurrent cards for the same path share one request, and a
// path already verified this session renders with no flicker. A short TTL lets
// a path created after a negative check recover without a long-lived stale miss.
const TTL_MS = 30_000
const MAX_ENTRIES = 500
const NOT_FOUND: PathInfo = { exists: false, isDirectory: false }

const cache = new Map<string, { value: PathInfo; at: number }>()
const inflight = new Map<string, Promise<PathInfo>>()

/**
 * Synchronous read — returns a fresh cached result, or undefined when the path
 * hasn't been checked (or the entry has expired). Lets a card render its final
 * state on first paint instead of flashing empty while an IPC resolves.
 */
export function cachedPathInfo(path: string): PathInfo | undefined {
  const hit = cache.get(path)
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value
  return undefined
}

function remember(path: string, value: PathInfo): PathInfo {
  cache.set(path, { value, at: Date.now() })
  inflight.delete(path)
  // Map keeps insertion order — evict the oldest entry when over budget.
  if (cache.size > MAX_ENTRIES) {
    const oldest = cache.keys().next().value
    if (oldest !== undefined) cache.delete(oldest)
  }
  return value
}

/**
 * Resolve a path's existence/type, hitting main at most once per TTL window and
 * collapsing concurrent lookups of the same path into a single in-flight IPC.
 * Failures are cached too, so a junk path mentioned repeatedly costs one call.
 */
export function statPathOnce(path: string): Promise<PathInfo> {
  const fresh = cachedPathInfo(path)
  if (fresh) return Promise.resolve(fresh)
  const pending = inflight.get(path)
  if (pending) return pending
  const p = window.api.upload
    .statPath(path)
    .then((r) => remember(path, r))
    .catch(() => remember(path, NOT_FOUND))
  inflight.set(path, p)
  return p
}
