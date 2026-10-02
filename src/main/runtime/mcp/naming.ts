/**
 * Pure naming helpers for MCP connections. No Electron, no SDK imports —
 * this module is directly testable with `npx tsx`.
 *
 * Namespacing contract: every MCP server gets a stable slug chosen at
 * add time. The cerebellum capability is registered as `mcp-<slug>` and
 * every tool the server exposes is advertised to the model as
 * `<slug_with_underscores>_<original_name>`. Distinct slugs therefore
 * guarantee two servers can never collide on a tool name, and the
 * `mcp-` capability prefix keeps server capabilities out of the bundled
 * capability namespace (shell, telegram, …).
 */

/** Providers enforce `^[a-zA-Z0-9_-]{1,64}$` on tool names. */
export const MAX_TOOL_NAME_LENGTH = 64

/**
 * Capability names an MCP slug must never take, even when the owner is
 * not currently registered: channel capabilities register only while
 * their bot is connected, so an add-time scan of loaded capabilities
 * cannot see them.
 */
export const RESERVED_SLUGS = new Set(['telegram', 'whatsapp', 'electron', 'wolffish', 'mcp'])

export function mcpCapabilityName(slug: string): string {
  // Hostname-derived slugs often already start with "mcp-" (mcp.zapier.com →
  // mcp-zapier-com); don't stack a second prefix onto those.
  return slug.startsWith('mcp-') ? slug : `mcp-${slug}`
}

/** Lowercase, alphanumeric + dashes, no leading/trailing/double dashes. */
export function slugify(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-')
    .slice(0, 24)
    .replace(/-+$/g, '')
  return slug || 'server'
}

/**
 * Pick a slug that collides with nothing: other MCP server slugs, loaded
 * capability names, and the reserved set. Appends -2, -3, … until free.
 */
export function deconflictSlug(base: string, taken: ReadonlySet<string>): string {
  const isTaken = (s: string): boolean =>
    taken.has(s) || taken.has(mcpCapabilityName(s)) || RESERVED_SLUGS.has(s)
  if (!isTaken(base)) return base
  for (let i = 2; ; i++) {
    const candidate = `${base}-${i}`
    if (!isTaken(candidate)) return candidate
  }
}

/**
 * Build the model-facing tool names for a server's tool list. Returns a
 * map of namespaced name → original name (the connection uses it to route
 * calls back) preserving the server's tool order. Illegal characters are
 * replaced, the 64-char provider cap is enforced, and truncation-induced
 * duplicates are disambiguated with a numeric suffix.
 */
export function namespaceToolNames(slug: string, originalNames: string[]): Map<string, string> {
  const prefix = slug.replace(/-/g, '_') + '_'
  const result = new Map<string, string>()
  const used = new Set<string>()
  for (const original of originalNames) {
    const sanitized = original.replace(/[^a-zA-Z0-9_-]/g, '_')
    let name = (prefix + sanitized).slice(0, MAX_TOOL_NAME_LENGTH)
    if (used.has(name)) {
      for (let i = 2; ; i++) {
        const suffix = `_${i}`
        const candidate = name.slice(0, MAX_TOOL_NAME_LENGTH - suffix.length) + suffix
        if (!used.has(candidate)) {
          name = candidate
          break
        }
      }
    }
    used.add(name)
    result.set(name, original)
  }
  return result
}

/** A target that parses as an http(s) URL is a remote server; anything else is a command. */
export function detectTransport(target: string): 'stdio' | 'http' {
  const trimmed = target.trim()
  if (/^https?:\/\//i.test(trimmed)) return 'http'
  return 'stdio'
}

/**
 * Quote-aware command-line tokenizer for stdio server commands the user
 * pastes into settings (e.g. `npx -y some-server --db "~/my data/db.sqlite"`).
 * Supports double quotes, single quotes, and backslash escapes outside
 * single quotes. No shell expansion — the command is spawned directly.
 */
export function parseCommandLine(line: string): string[] {
  const args: string[] = []
  let current = ''
  let hasToken = false
  let quote: '"' | "'" | null = null
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (quote === "'") {
      if (ch === "'") quote = null
      else current += ch
      continue
    }
    if (ch === '\\' && i + 1 < line.length) {
      const next = line[i + 1]
      // Only treat a backslash as an escape before a shell-significant
      // character (quote, whitespace, or another backslash). Otherwise keep
      // it literal so Windows paths like C:\Users\srv survive intact.
      if (next === '"' || next === "'" || next === '\\' || /\s/.test(next)) {
        current += next
        i++
        hasToken = true
        continue
      }
    }
    if (quote === '"') {
      if (ch === '"') quote = null
      else current += ch
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch as '"' | "'"
      hasToken = true
      continue
    }
    if (/\s/.test(ch)) {
      if (hasToken || current) {
        args.push(current)
        current = ''
        hasToken = false
      }
      continue
    }
    current += ch
    hasToken = true
  }
  if (hasToken || current) args.push(current)
  return args
}

/**
 * Default display name when the user leaves the name field empty:
 * the command's binary (skipping runner boilerplate like `npx -y` /
 * `uvx`) or the remote host.
 */
export function deriveDisplayName(target: string, kind: 'stdio' | 'http'): string {
  if (kind === 'http') {
    try {
      const url = new URL(target.trim())
      return url.hostname
    } catch {
      return target.trim()
    }
  }
  const argv = parseCommandLine(target)
  const runners = new Set(['npx', 'uvx', 'uv', 'pnpm', 'bunx', 'node', 'python', 'python3', 'deno'])
  for (const arg of argv) {
    if (arg.startsWith('-')) continue
    const base = arg.split('/').pop() ?? arg
    if (runners.has(base)) continue
    return base
  }
  const first = argv[0]
  return first ? (first.split('/').pop() ?? first) : 'server'
}
