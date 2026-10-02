/**
 * Ripgrep-backed content search + file globbing for the filesystem
 * capability, with a pure-JavaScript fallback when no ripgrep binary can be
 * found. Mirrors OpenCode's `grep` / `glob` tools: same ripgrep argv, same
 * JSON-line parsing, same exit-code contract (0 = matches, 1 = none,
 * 2 = partial or bad pattern), same 2000-char match-text cap, same
 * 100-result limit, and byte-identical output formatting.
 *
 * Plain ESM for the Electron main-process plugin loader: only `node:`
 * builtins at import time; `@vscode/ripgrep` is resolved lazily and is
 * optional.
 *
 * Engines
 *   ripgrep — spawned via execFile-style `spawn` on the RESOLVED BINARY PATH
 *             (never through a shell, so shell functions/aliases named `rg`
 *             cannot intercept it).
 *   js      — recursive walk from `cwd` that mirrors what ripgrep would do
 *             with the argv we use: hidden files included, `.git` pruned,
 *             top-level `.gitignore` honored ONLY when the directory is
 *             inside a git repo (ripgrep's own rule: no `.git` in cwd or an
 *             ancestor → .gitignore is not consulted), an explicit glob /
 *             include whitelisting a path over .gitignore exactly as
 *             ripgrep's --glob does (see walkFiles), `node_modules` always
 *             pruned as an extra guard, binary files (NUL in the first 4 KB)
 *             and files over 2 MB skipped, symlinks not followed.
 *
 * Result ordering: both engines sort results by (path, line) after the
 * limit is applied, so the two engines are directly comparable and the
 * formatted output is deterministic. Ripgrep's own output order is
 * thread-dependent.
 *
 * `truncated` is true only when MORE than `limit` results exist (we read
 * limit + 1 and then stop / kill the child), so a directory with exactly
 * `limit` hits is reported as complete.
 */
import { execFile, spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import readline from 'node:readline'
import { fileURLToPath } from 'node:url'

export const DEFAULT_LIMIT = 100
const MAX_MATCH_TEXT = 2000
const MAX_JS_FILE_BYTES = 2 * 1024 * 1024
const NUL_PROBE_BYTES = 4096
const WHICH_TIMEOUT_MS = 3000
const STDERR_CAP_BYTES = 8 * 1024
const ALWAYS_PRUNED_DIRS = new Set(['.git', 'node_modules'])

// ───────────────────────────── ripgrep resolution ─────────────────────────────

/** undefined = no override; string = forced binary; null = forced JS engine. */
let override = undefined
/** undefined = not resolved yet; string | null once resolved (process lifetime). */
let cached = undefined
let inflight = null

/**
 * Force a specific binary (absolute path), force the JS engine (`null`), or
 * clear the override (`undefined`) and fall back to auto-resolution.
 */
export function setRipgrepOverride(binaryPath) {
  override = binaryPath
}

/**
 * Absolute path of a ripgrep binary, or null. Resolution order:
 *   (a) `@vscode/ripgrep` installed in the capability's own node_modules
 *       (`<capabilityDir>/node_modules/@vscode/ripgrep/bin/rg[.exe]`, then
 *       the package's exported `rgPath`);
 *   (b) `rg` on PATH via `which` / `where` (3 s timeout);
 *   (c) null.
 * The answer is cached for the process lifetime. `WOLFFISH_FORCE_JS_SEARCH=1`
 * short-circuits to null; `setRipgrepOverride` beats everything.
 */
export async function resolveRipgrep() {
  if (override !== undefined) return override
  if (process.env.WOLFFISH_FORCE_JS_SEARCH === '1') return null
  if (cached !== undefined) return cached
  if (!inflight) {
    inflight = resolveUncached().then(
      (found) => {
        cached = found
        inflight = null
        return found
      },
      () => {
        cached = null
        inflight = null
        return null
      }
    )
  }
  return inflight
}

async function resolveUncached() {
  const binName = process.platform === 'win32' ? 'rg.exe' : 'rg'
  try {
    // import.meta.url may carry a `?v=N` cache-buster from the loader;
    // fileURLToPath ignores the query.
    const pluginDir = path.dirname(fileURLToPath(import.meta.url))
    const capabilityDir = path.dirname(pluginDir)
    const local = path.join(capabilityDir, 'node_modules', '@vscode', 'ripgrep', 'bin', binName)
    if (await isExecutableFile(local)) return local
  } catch {
    /* not a file URL — skip the local probe */
  }
  try {
    const require = createRequire(import.meta.url)
    const mod = require('@vscode/ripgrep')
    const rgPath = mod && typeof mod.rgPath === 'string' ? mod.rgPath : null
    if (rgPath && (await isExecutableFile(rgPath))) return rgPath
  } catch {
    /* package not installed — fine, it is optional */
  }
  return whichRipgrep()
}

async function isExecutableFile(p) {
  try {
    const st = await fsp.stat(p)
    if (!st.isFile()) return false
    await fsp.access(p, fs.constants.X_OK)
    return true
  } catch {
    return false
  }
}

function whichRipgrep() {
  const cmd = process.platform === 'win32' ? 'where' : 'which'
  return new Promise((resolve) => {
    let settled = false
    const done = (v) => {
      if (!settled) {
        settled = true
        resolve(v)
      }
    }
    try {
      execFile(cmd, ['rg'], { timeout: WHICH_TIMEOUT_MS, windowsHide: true }, (err, stdout) => {
        if (err) return done(null)
        const line = String(stdout)
          .split(/\r?\n/)
          .map((s) => s.trim())
          .find(Boolean)
        if (!line || !path.isAbsolute(line)) return done(null)
        isExecutableFile(line).then((ok) => done(ok ? line : null))
      })
    } catch {
      done(null)
    }
  })
}

// ───────────────────────────────── public API ─────────────────────────────────

/**
 * Search file contents for a regex.
 * @returns {{ matches: {path:string,line:number,text:string}[], truncated: boolean, engine: 'ripgrep'|'js' }}
 * Throws `Error("Invalid regex pattern: …")` for a pattern the engine rejects.
 */
export async function grep({ cwd, pattern, include, limit = DEFAULT_LIMIT } = {}) {
  const root = requireDir(cwd)
  if (typeof pattern !== 'string' || pattern.length === 0) throw new Error('pattern is required')
  const max = normalizeLimit(limit)
  const rg = await resolveRipgrep()
  const result = rg
    ? await grepRipgrep(rg, { cwd: root, pattern, include, limit: max })
    : await grepJs({ cwd: root, pattern, include, limit: max })
  result.matches.sort(compareMatches)
  return result
}

/**
 * List files whose path (relative to cwd) matches a glob.
 * @returns {{ files: string[], truncated: boolean, engine: 'ripgrep'|'js' }}
 */
export async function glob({ cwd, pattern, limit = DEFAULT_LIMIT } = {}) {
  const root = requireDir(cwd)
  if (typeof pattern !== 'string' || pattern.length === 0) throw new Error('pattern is required')
  const max = normalizeLimit(limit)
  const rg = await resolveRipgrep()
  const result = rg
    ? await globRipgrep(rg, { cwd: root, pattern, limit: max })
    : await globJs({ cwd: root, pattern, limit: max })
  result.files.sort(comparePaths)
  return result
}

/** OpenCode grep tool output, byte for byte. `opts.pattern` is accepted for parity; the text does not use it. */
export function formatGrep(result, _opts = {}) {
  const matches = result?.matches ?? []
  const truncated = Boolean(result?.truncated)
  if (matches.length === 0) return 'No files found'
  const out = [`Found ${matches.length} matches${truncated ? ' (more matches available)' : ''}`]
  let current = ''
  for (const m of matches) {
    if (current !== m.path) {
      if (current !== '') out.push('')
      current = m.path
      out.push(`${m.path}:`)
    }
    out.push(`  Line ${m.line}: ${m.text}`)
  }
  if (truncated) {
    out.push('')
    out.push('(Results truncated. Consider using a more specific path or pattern.)')
  }
  return out.join('\n')
}

/** OpenCode glob tool output, byte for byte. */
export function formatGlob(result) {
  const files = result?.files ?? []
  const truncated = Boolean(result?.truncated)
  if (files.length === 0) return 'No files found'
  const out = [...files]
  if (truncated) {
    out.push('')
    out.push(
      `(Results are truncated: showing first ${files.length} results. Consider using a more specific path or pattern.)`
    )
  }
  return out.join('\n')
}

/**
 * Gitignore / ripgrep `--glob` matching of a cwd-relative path (forward
 * slashes). A pattern without a slash matches the basename at any depth;
 * a pattern with a slash (or a leading `/`) is anchored at cwd. Supports
 * `**`, `*`, `?`, `{a,b}`, `[abc]` / `[!abc]`, and `\` escapes.
 * Throws `Error("Invalid glob pattern: …")` on an unclosed `{` or `[`.
 */
export function matchGlob(relPath, pattern) {
  return compileGlob(pattern)(relPath)
}

// ─────────────────────────────── ripgrep engine ───────────────────────────────

const isInvalidPattern = (stderr) =>
  stderr.includes('regex parse error') || stderr.includes('error parsing regex')

async function grepRipgrep(rg, { cwd, pattern, include, limit }) {
  const args = [
    '--no-config',
    '--json',
    '--hidden',
    '--no-messages',
    ...(include ? [`--glob=${include}`] : []),
    '--glob=!**/.git/**',
    '--',
    pattern,
    '.'
  ]
  const run = await runRipgrep(rg, args, cwd, limit, parseMatchLine)
  if (!run.truncated) {
    if (run.code === 2 && isInvalidPattern(run.stderr)) {
      throw new Error(`Invalid regex pattern: ${run.stderr.trim()}`)
    }
    if (run.code === 2 && run.items.length === 0 && /error parsing glob/i.test(run.stderr)) {
      throw new Error(`Invalid glob pattern: ${run.stderr.trim()}`)
    }
    if (run.code !== 0 && run.code !== 1 && run.code !== 2) {
      throw new Error(run.stderr.trim() || `ripgrep failed with code ${run.code}`)
    }
  }
  const matches = run.items.map((m) => ({
    path: path.resolve(cwd, stripDotSlash(m.path)),
    line: m.line,
    text: m.text
  }))
  return { matches, truncated: run.truncated, engine: 'ripgrep' }
}

async function globRipgrep(rg, { cwd, pattern, limit }) {
  const args = ['--no-config', '--files', '--hidden', `--glob=${pattern}`, '--glob=!**/.git/**', '.']
  const run = await runRipgrep(rg, args, cwd, limit, (line) => (line.length > 0 ? line : undefined))
  if (!run.truncated) {
    if (run.code === 2 && run.items.length === 0 && run.stderr.trim()) {
      // `--files` has no --no-messages; a bad glob is the only exit-2 with
      // zero rows AND a message that we should surface as an error.
      const msg = run.stderr.trim()
      throw new Error(/error parsing glob/i.test(msg) ? `Invalid glob pattern: ${msg}` : msg)
    }
    if (run.code !== 0 && run.code !== 1 && run.code !== 2) {
      throw new Error(run.stderr.trim() || `ripgrep failed with code ${run.code}`)
    }
  }
  const files = run.items.map((rel) => path.resolve(cwd, stripDotSlash(rel)))
  return { files, truncated: run.truncated, engine: 'ripgrep' }
}

/**
 * Spawn ripgrep, feed each stdout line through `parse`, keep at most
 * limit + 1 parsed rows (killing the child once that many are in hand), and
 * collect a capped stderr. Resolves `{ items, truncated, code, stderr }`;
 * rejects only if the process cannot be started.
 */
function runRipgrep(rg, args, cwd, limit, parse) {
  return new Promise((resolve, reject) => {
    let child
    try {
      child = spawn(rg, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    } catch (err) {
      reject(new Error(`ripgrep failed to start: ${err?.message ?? String(err)}`))
      return
    }
    const items = []
    let truncated = false
    let stderr = ''
    let stderrBytes = 0
    let spawnError = null
    let closed = false

    child.on('error', (err) => {
      spawnError = err
    })
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk) => {
      if (stderrBytes >= STDERR_CAP_BYTES) return
      stderrBytes += Buffer.byteLength(chunk, 'utf8')
      stderr += chunk
    })

    const rl = readline.createInterface({ input: child.stdout, crlfDelay: Infinity })
    rl.on('line', (line) => {
      if (truncated || line.length === 0) return
      const item = parse(line)
      if (item === undefined) return
      items.push(item)
      if (items.length > limit) {
        truncated = true
        items.length = limit
        rl.close()
        child.stdout.destroy()
        child.kill()
      }
    })

    child.on('close', (code) => {
      if (closed) return
      closed = true
      if (spawnError && !truncated && items.length === 0) {
        reject(new Error(`ripgrep failed to start: ${spawnError.message}`))
        return
      }
      resolve({ items, truncated, code, stderr })
    })
  })
}

/** One ripgrep --json line → { path, line, text } for `type: "match"` rows; undefined otherwise. */
function parseMatchLine(line) {
  let json
  try {
    json = JSON.parse(line)
  } catch {
    return undefined
  }
  if (!json || typeof json !== 'object' || json.type !== 'match') return undefined
  const data = json.data
  if (!data || typeof data !== 'object') return undefined
  const filePath = textOf(data.path)
  const lineText = textOf(data.lines)
  const lineNumber = data.line_number
  if (filePath == null || lineText == null || typeof lineNumber !== 'number') return undefined
  return { path: filePath, line: lineNumber, text: capMatchText(stripEol(lineText)) }
}

/** ripgrep emits `{text}` for valid UTF-8 and `{bytes}` (base64) otherwise. */
function textOf(obj) {
  if (!obj || typeof obj !== 'object') return null
  if (typeof obj.text === 'string') return obj.text
  if (typeof obj.bytes === 'string') return Buffer.from(obj.bytes, 'base64').toString('utf8')
  return null
}

// ────────────────────────────────── JS engine ─────────────────────────────────

async function grepJs({ cwd, pattern, include, limit }) {
  let re
  try {
    re = new RegExp(pattern)
  } catch (err) {
    throw new Error(`Invalid regex pattern: ${err?.message ?? String(err)}`)
  }
  const includeMatch = include ? compileGlob(include) : null
  const ignored = await loadGitignore(cwd)
  const matches = []
  let truncated = false
  outer: for await (const rel of walkFiles(cwd, ignored, includeMatch)) {
    if (includeMatch && !includeMatch(rel)) continue
    const abs = path.join(cwd, rel)
    const text = await readTextFile(abs)
    if (text == null) continue
    const lines = splitLines(text)
    for (let i = 0; i < lines.length; i++) {
      if (!re.test(lines[i])) continue
      if (matches.length >= limit) {
        truncated = true
        break outer
      }
      matches.push({ path: abs, line: i + 1, text: capMatchText(lines[i]) })
    }
  }
  return { matches, truncated, engine: 'js' }
}

async function globJs({ cwd, pattern, limit }) {
  const match = compileGlob(pattern)
  const ignored = await loadGitignore(cwd)
  const files = []
  let truncated = false
  for await (const rel of walkFiles(cwd, ignored, match)) {
    if (!match(rel)) continue
    if (files.length >= limit) {
      truncated = true
      break
    }
    files.push(path.join(cwd, rel))
  }
  return { files, truncated, engine: 'js' }
}

/**
 * Depth-first walk yielding cwd-relative file paths with forward slashes.
 * Prunes `.git` and `node_modules`, anything the gitignore predicate rejects,
 * and symlinks; unreadable directories are skipped silently (ripgrep's
 * --no-messages behavior).
 *
 * `whitelist` is the caller's `--glob` (glob pattern or grep `include`).
 * Ripgrep gives an explicit --glob precedence over ignore files, verified on
 * ripgrep 13: a gitignored directory whose own path matches the glob is
 * descended (so `*` lists `dist/out.ts` despite `dist/` in .gitignore), while
 * a gitignored directory that does not match is pruned even if files inside
 * would match (`*.md` never sees `dist/notes.md`). Children must still match
 * the glob themselves — that filtering is the caller's. The only deliberate
 * divergence is `node_modules`, which this engine prunes unconditionally.
 */
async function* walkFiles(root, ignored, whitelist = null, relDir = '') {
  let entries
  try {
    entries = await fsp.readdir(relDir ? path.join(root, relDir) : root, { withFileTypes: true })
  } catch {
    return
  }
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue
    const rel = relDir ? `${relDir}/${entry.name}` : entry.name
    if (entry.isDirectory()) {
      if (ALWAYS_PRUNED_DIRS.has(entry.name)) continue
      if (ignored(rel, true) && !(whitelist && whitelist(rel))) continue
      yield* walkFiles(root, ignored, whitelist, rel)
    } else if (entry.isFile()) {
      if (ignored(rel, false) && !(whitelist && whitelist(rel))) continue
      yield rel
    }
  }
}

/**
 * Whole-file text read with the JS engine's guards: null for files over
 * 2 MB, files with a NUL byte in the first 4 KB, or anything unreadable.
 */
async function readTextFile(abs) {
  let buf
  try {
    const st = await fsp.stat(abs)
    if (!st.isFile() || st.size > MAX_JS_FILE_BYTES) return null
    buf = await fsp.readFile(abs)
  } catch {
    return null
  }
  if (buf.subarray(0, NUL_PROBE_BYTES).includes(0)) return null
  return buf.toString('utf8')
}

/** Split on `\n`, drop a trailing `\r`, and do not count the empty tail after a final newline as a line. */
function splitLines(text) {
  const lines = text.split('\n')
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop()
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].endsWith('\r')) lines[i] = lines[i].slice(0, -1)
  }
  return lines
}

/**
 * Minimal .gitignore reader — top-level `<cwd>/.gitignore` only, and only
 * when cwd is inside a git repo (a `.git` entry in cwd or an ancestor), which
 * is ripgrep's own gate. Returns `(relPath, isDir) => boolean`.
 *
 * Supported syntax (documented subset):
 *   - blank lines and `#` comments are skipped; trailing whitespace trimmed
 *   - `!pattern` negates; the last matching rule wins
 *   - a trailing `/` makes the rule match directories only
 *   - a leading `/`, or any `/` inside the pattern, anchors it at cwd;
 *     otherwise it matches at any depth (a double-star-slash prefix is
 *     prepended — spelled out here because the literal would close this comment)
 *   - `*`, `**`, `?`, `{a,b}`, `[abc]` via the shared glob compiler
 * Not supported: nested .gitignore files, .ignore, global excludes,
 * escaped trailing spaces.
 */
async function loadGitignore(cwd) {
  const never = () => false
  if (!isInsideGitRepo(cwd)) return never
  let source
  try {
    source = await fsp.readFile(path.join(cwd, '.gitignore'), 'utf8')
  } catch {
    return never
  }
  const rules = []
  for (const raw of source.split(/\r?\n/)) {
    let line = raw.replace(/\s+$/u, '')
    if (!line || line.startsWith('#')) continue
    let negate = false
    if (line.startsWith('!')) {
      negate = true
      line = line.slice(1)
    }
    let dirOnly = false
    if (line.endsWith('/')) {
      dirOnly = true
      line = line.replace(/\/+$/u, '')
    }
    if (!line) continue
    let anchored = false
    if (line.startsWith('/')) {
      anchored = true
      line = line.replace(/^\/+/u, '')
    } else if (line.includes('/')) {
      anchored = true
    }
    let test
    try {
      test = compileGlob(anchored ? `/${line}` : line)
    } catch {
      continue // an unparsable rule is ignored rather than breaking the search
    }
    rules.push({ test, negate, dirOnly })
  }
  if (rules.length === 0) return never
  return (rel, isDir) => {
    let ignored = false
    for (const rule of rules) {
      if (rule.dirOnly && !isDir) continue
      if (rule.test(rel)) ignored = !rule.negate
    }
    return ignored
  }
}

function isInsideGitRepo(start) {
  let dir = start
  for (;;) {
    if (fs.existsSync(path.join(dir, '.git'))) return true
    const parent = path.dirname(dir)
    if (parent === dir) return false
    dir = parent
  }
}

// ─────────────────────────────── glob compiler ────────────────────────────────

const globCache = new Map()

/** Compile a gitignore-style glob into a predicate over cwd-relative paths. */
function compileGlob(pattern) {
  if (typeof pattern !== 'string' || pattern.length === 0) throw new Error('Invalid glob pattern: empty')
  const hit = globCache.get(pattern)
  if (hit) return hit
  let p = pattern.replace(/^\.\//u, '')
  if (p.startsWith('/')) p = p.replace(/^\/+/u, '')
  else if (!p.includes('/')) p = `**/${p}`
  if (p.endsWith('/')) p = `${p}**`
  const re = new RegExp(`^${globToRegExpSource(pattern, p)}$`)
  const test = (rel) => re.test(normalizeRel(rel))
  if (globCache.size > 500) globCache.clear()
  globCache.set(pattern, test)
  return test
}

function normalizeRel(rel) {
  return String(rel).replace(/\\/g, '/').replace(/^(?:\.\/)+/u, '').replace(/^\/+/u, '')
}

function escapeRe(ch) {
  return ch.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')
}

function globToRegExpSource(original, glob) {
  let i = 0
  const n = glob.length
  const parseSeq = (inBrace) => {
    let out = ''
    while (i < n) {
      const c = glob[i]
      if (inBrace && (c === ',' || c === '}')) return out
      if (c === '*') {
        let j = i
        while (glob[j] === '*') j++
        const doubled = j - i >= 2
        if (doubled) {
          const atSegmentStart = i === 0 || glob[i - 1] === '/'
          if (atSegmentStart && glob[j] === '/') {
            out += '(?:.*/)?' // `**/` — zero or more directories
            i = j + 1
            continue
          }
          out += '.*' // `/**` at end, or `**` embedded in a segment
          i = j
          continue
        }
        out += '[^/]*'
        i = j
        continue
      }
      if (c === '?') {
        out += '[^/]'
        i++
        continue
      }
      if (c === '{') {
        i++
        const alts = []
        for (;;) {
          alts.push(parseSeq(true))
          if (i >= n) throw new Error(`Invalid glob pattern: unclosed '{' in "${original}"`)
          if (glob[i] === ',') {
            i++
            continue
          }
          i++ // '}'
          break
        }
        out += `(?:${alts.join('|')})`
        continue
      }
      if (c === '[') {
        let j = i + 1
        let negate = false
        if (glob[j] === '!' || glob[j] === '^') {
          negate = true
          j++
        }
        if (glob[j] === ']') j++ // a leading `]` is literal
        const close = glob.indexOf(']', j)
        if (close < 0) throw new Error(`Invalid glob pattern: unclosed '[' in "${original}"`)
        const body = glob.slice(negate ? i + 2 : i + 1, close).replace(/[\\\]]/g, '\\$&')
        out += `[${negate ? '^' : ''}${body}]`
        i = close + 1
        continue
      }
      if (c === '\\' && i + 1 < n) {
        out += escapeRe(glob[i + 1])
        i += 2
        continue
      }
      out += escapeRe(c)
      i++
    }
    return out
  }
  return parseSeq(false)
}

// ─────────────────────────────────── helpers ──────────────────────────────────

function requireDir(cwd) {
  if (typeof cwd !== 'string' || cwd.length === 0) throw new Error('cwd is required')
  return path.resolve(cwd)
}

function normalizeLimit(limit) {
  const n = Number(limit)
  if (!Number.isFinite(n) || n < 1) return DEFAULT_LIMIT
  return Math.floor(n)
}

function stripDotSlash(p) {
  return String(p)
    .replace(/^(?:\.[\\/])+/u, '')
    .replace(/^[\\/]+/u, '')
}

function stripEol(text) {
  return text.replace(/\r?\n$/u, '')
}

function capMatchText(text) {
  if (text.length <= MAX_MATCH_TEXT) return text
  return text.slice(0, MAX_MATCH_TEXT).replace(/[\uD800-\uDBFF]$/u, '') + '...'
}

function comparePaths(a, b) {
  return a < b ? -1 : a > b ? 1 : 0
}

function compareMatches(a, b) {
  return comparePaths(a.path, b.path) || a.line - b.line
}
