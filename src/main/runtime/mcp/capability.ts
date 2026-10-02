/**
 * Bridges an MCP server's tool surface into a cerebellum capability.
 * Pure data-shaping — no SDK, no Electron imports (cerebellum types are
 * type-only) — so the whole conversion layer is testable with `npx tsx`.
 */
import type {
  Capability,
  SkillToolDescriptor,
  ToolExecutionResult,
  ToolParameterSpec,
  WolffishPlugin
} from '@main/runtime/cerebellum'
import { mcpCapabilityName, namespaceToolNames } from '@main/runtime/mcp/naming'

/**
 * How much of a server's `instructions` blob rides along in the
 * capability description (and therefore in every turn's <tools> block,
 * for Brain and workflow agents alike). Servers ship multi-KB display charters;
 * beyond this cap the token cost outweighs the guidance.
 */
const INSTRUCTIONS_MAX_CHARS = 2_000

/** Shape of a tool as returned by the MCP tools/list call. */
export type McpToolInfo = {
  name: string
  description?: string
  inputSchema?: Record<string, unknown>
}

/** Minimal shape of an MCP tools/call result (SDK CallToolResult). */
export type McpCallResult = {
  content?: Array<Record<string, unknown>>
  structuredContent?: unknown
  isError?: boolean
}

/**
 * The error the MCP plugin returns while its server is between
 * connections. Wording is load-bearing twice over: "network error"
 * lands it in the motor's retryable network bucket (NETWORK_RE), so a
 * mid-turn blip gets a bounded retry window instead of a fail-fast; and
 * only the slug (sanitized at add time) is interpolated so a
 * user-chosen display name can never steer the error classifier.
 */
export function unreachableError(slug: string): string {
  return `MCP server ${slug} is temporarily unreachable (network error). Wolffish reconnects to it automatically in the background — retry shortly or continue without it.`
}

/**
 * Convert an MCP tool list into cerebellum tool descriptors. Property
 * schemas pass through verbatim via ToolParameterSpec.raw; only the
 * top-level required array is translated (cerebellum defaults params to
 * required, MCP defaults them to optional — the explicit boolean bridges
 * the two).
 */
export function toolsToDescriptors(
  slug: string,
  tools: McpToolInfo[]
): { descriptors: SkillToolDescriptor[]; nameMap: Map<string, string> } {
  const nameMap = namespaceToolNames(
    slug,
    tools.map((t) => t.name)
  )
  const bySourceName = new Map(tools.map((t) => [t.name, t]))
  const descriptors: SkillToolDescriptor[] = []
  for (const [namespaced, original] of nameMap) {
    const tool = bySourceName.get(original)
    if (!tool) continue
    const schema = tool.inputSchema ?? {}
    const props = (schema.properties ?? {}) as Record<string, unknown>
    const requiredKeys = Array.isArray(schema.required) ? (schema.required as string[]) : []
    const parameters: Record<string, ToolParameterSpec> = {}
    for (const [key, sub] of Object.entries(props)) {
      parameters[key] = {
        raw: (sub ?? { type: 'string' }) as Record<string, unknown>,
        required: requiredKeys.includes(key)
      }
    }
    descriptors.push({
      name: namespaced,
      description:
        sanitizeToolDescription(tool.description) || `${original} (no description provided)`,
      parameters
    })
  }
  return { descriptors, nameMap }
}

/** Longest per-tool description an MCP server may inject into requests. */
const TOOL_DESCRIPTION_MAX_CHARS = 400

/**
 * MCP tool descriptions pass into every request once the capability is
 * activated — and servers ship whatever they like (one live server embedded
 * multi-heading markdown charters that rendered as fake capability headers
 * inside the prompt). Neutralize prompt-structure forgery (markdown headings,
 * XML-ish tags) and cap the length so one server can't reintroduce catalog
 * bloat.
 */
export function sanitizeToolDescription(raw: string | undefined): string {
  if (!raw) return ''
  let text = raw.trim()
  // Strip heading markers at line starts and flatten structural newlines —
  // a description is a sentence, not a document.
  text = text
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/<\/?[a-zA-Z][^>]*>/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  if (text.length > TOOL_DESCRIPTION_MAX_CHARS) {
    text = text.slice(0, TOOL_DESCRIPTION_MAX_CHARS - 1) + '…'
  }
  return text
}

/**
 * Compose the capability description the model reads in <tools>:
 * a one-line identity, then the server's own instructions (capped).
 */
export function buildDescription(opts: {
  displayName: string
  serverName?: string
  instructions?: string
}): string {
  const identity =
    opts.serverName && opts.serverName !== opts.displayName
      ? `Tools from the connected MCP server "${opts.displayName}" (${opts.serverName}).`
      : `Tools from the connected MCP server "${opts.displayName}".`
  const lines = [
    identity,
    'Check connection state with mcp_list when a call fails — a server can drop and reconnect between turns.'
  ]
  const instructions = opts.instructions?.trim()
  if (instructions) {
    const capped =
      instructions.length > INSTRUCTIONS_MAX_CHARS
        ? instructions.slice(0, INSTRUCTIONS_MAX_CHARS) + '\n…(server instructions truncated)'
        : instructions
    lines.push('', 'Server instructions:', capped)
  }
  return lines.join('\n')
}

/**
 * Build the Capability + WolffishPlugin pair to register with the
 * cerebellum. `callTool` receives the ORIGINAL (server-side) tool name.
 * The plugin has deliberately NO destroy hook: the connection owns the
 * client lifecycle, and cerebellum reload/stop must never close a live
 * MCP connection as a side effect.
 */
export function buildMcpCapability(opts: {
  slug: string
  description: string
  descriptors: SkillToolDescriptor[]
  nameMap: Map<string, string>
  callTool: (
    originalName: string,
    args: Record<string, unknown>,
    signal?: AbortSignal
  ) => Promise<ToolExecutionResult>
}): { capability: Capability; plugin: WolffishPlugin } {
  const name = mcpCapabilityName(opts.slug)
  const capability: Capability = {
    name,
    dir: '<mcp>',
    description: opts.description,
    triggers: { keywords: [] },
    tools: opts.descriptors,
    body: '',
    hasPlugin: true,
    status: 'ok',
    requires: [],
    packages: {},
    npmDependencies: {}
  }
  const plugin: WolffishPlugin = {
    name,
    // Informational parity with cap.tools — the runtime reads schemas
    // from the capability descriptors, not from here.
    tools: opts.descriptors.map((d) => ({
      name: d.name,
      description: d.description,
      parameters: { type: 'object' }
    })),
    execute: async (toolName, args, signal) => {
      const original = opts.nameMap.get(toolName)
      if (!original) {
        return { success: false, error: `unknown tool: ${toolName}` }
      }
      return opts.callTool(original, args ?? {}, signal)
    }
  }
  return { capability, plugin }
}

/**
 * Flatten an MCP tools/call result into a ToolExecutionResult.
 * Text/resource/resource_link/audio blocks become text, image blocks map
 * to Wolffish tool-result images (mimeType → mediaType), and a result
 * that only carries structuredContent falls back to its JSON. isError
 * always produces a non-empty error string so the motor's classifier
 * never sees a blank failure.
 */
export function normalizeCallResult(result: McpCallResult, toolLabel: string): ToolExecutionResult {
  const textParts: string[] = []
  const images: Array<{ mediaType: string; data: string }> = []
  for (const block of result.content ?? []) {
    const type = block.type
    if (type === 'text' && typeof block.text === 'string') {
      textParts.push(block.text)
    } else if (type === 'image' && typeof block.data === 'string') {
      images.push({
        mediaType: typeof block.mimeType === 'string' ? block.mimeType : 'image/png',
        data: block.data
      })
    } else if (type === 'audio') {
      const mime = typeof block.mimeType === 'string' ? block.mimeType : 'audio'
      textParts.push(`[audio content (${mime}) — not displayable here]`)
    } else if (type === 'resource_link') {
      const bits = [block.uri, block.name, block.description].filter(
        (v): v is string => typeof v === 'string' && v.length > 0
      )
      textParts.push(`[resource link] ${bits.join(' — ')}`)
    } else if (type === 'resource') {
      const resource = (block.resource ?? {}) as Record<string, unknown>
      if (typeof resource.text === 'string') {
        textParts.push(resource.text)
      } else if (typeof resource.uri === 'string') {
        textParts.push(`[resource] ${resource.uri}`)
      }
    }
  }
  let text = textParts.join('\n\n')
  if (!text && result.structuredContent !== undefined) {
    try {
      text = JSON.stringify(result.structuredContent, null, 2)
    } catch {
      text = String(result.structuredContent)
    }
  }
  if (result.isError) {
    // A failure whose only detail is an image still carries diagnostic
    // signal — note it so the model isn't told "no message" when there was
    // one. (ToolExecutionResult errors are text-only; images ride the
    // success path.)
    const parts = [text, images.length > 0 ? `[${images.length} image(s) omitted]` : ''].filter(
      Boolean
    )
    return {
      success: false,
      error: parts.join(' ') || `${toolLabel} reported an error with no message`
    }
  }
  return {
    success: true,
    output: text,
    images: images.length > 0 ? images : undefined
  }
}
