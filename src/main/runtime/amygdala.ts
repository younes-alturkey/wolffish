import type { ApprovalDescription } from '@main/runtime/cerebellum'
import type { Corpus } from '@main/runtime/corpus'
import type { ToolCall } from '@main/runtime/wernicke'

/**
 * Amygdala is the safety gate. It can stop any action before it executes.
 *
 * Maps to: the amygdala — two almond-shaped clusters in the temporal
 * lobes that handle threat detection and the fear response. The amygdala
 * fires before conscious thought catches up: you flinch from the snake,
 * then you realize it's a stick. It can override anything the cortex was
 * about to do.
 *
 * In Wolffish, Amygdala classifies every tool call before the motor
 * cortex runs it. Safe operations pass through. Confirm-level calls
 * bounce through an approval bridge (IPC to the renderer). Block-level
 * calls halt the pipeline outright. The pattern table is empty until
 * capabilities register their own — the core knows nothing about
 * specific tools.
 */

export type DangerLevel = 'safe' | 'warn' | 'confirm' | 'destructive' | 'block'

export type DangerPattern = {
  match: RegExp
  level: DangerLevel
  reason: string
  /**
   * Restrict the pattern to these argument names instead of the whole
   * serialized call. A path pattern like `\.\./` belongs on `path` alone:
   * matched against every argument it also fires on a `file_edit` whose
   * replacement text merely contains `../lib/x`, raising "Path traversal
   * attempt" over an ordinary relative import. Omit to match the tool name
   * plus all arguments, which is what a command pattern (shell) wants.
   */
  args?: string[]
}

export type ApprovalRequest = {
  toolCall: ToolCall
  level: DangerLevel
  reason: string
  description?: ApprovalDescription
  /**
   * Scope for "Allow for this conversation": a rule the user grants on this
   * request auto-approves later matching calls carrying the same key. The
   * Agent passes the conversation id (turn id for conversation-less runs).
   */
  sessionKey?: string
}

/**
 * `approved_session` is "approve, and keep approving the same kind of call
 * for the rest of this conversation" — the rule lives in memory only (see
 * Amygdala.sessionAllow) and never touches block-level patterns.
 */
export type ApprovalDecision = 'approved' | 'denied' | 'approved_session'

export type ApprovalBridge = (
  request: ApprovalRequest & { id: string }
) => Promise<ApprovalDecision>

export type AmygdalaOptions = {
  corpus?: Corpus
  approvalBridge?: ApprovalBridge
}

const APPROVAL_DENIED: ApprovalDecision = 'denied'

/**
 * Command heads whose FIRST argument is part of the identity of the action
 * (`git push` vs `git status`), so a session rule for one never covers the
 * other. Everything else is keyed on the head alone — the same shape
 * OpenCode's arity table produces for the common cases.
 */
const TWO_TOKEN_HEADS = new Set([
  'git',
  'npm',
  'pnpm',
  'yarn',
  'bun',
  'npx',
  'pip',
  'pip3',
  'docker',
  'cargo',
  'go',
  'brew',
  'apt',
  'apt-get',
  'dnf',
  'kubectl',
  'gh',
  'make',
  'python',
  'python3',
  'node',
  'uv',
  'poetry'
])

/**
 * Does this pattern fire on this call? An unscoped pattern tests the whole
 * haystack (tool name + serialized args) as it always has. A pattern with
 * `args` tests ONLY those arguments' own string values — so `\.\./` on
 * `path` catches `file_write` to `../../../etc/hosts` and stays quiet on a
 * `file_edit` whose replacement text happens to contain a relative import.
 * A scoped pattern whose arguments are all absent simply does not fire.
 */
function patternHits(pattern: DangerPattern, call: ToolCall, haystack: string): boolean {
  if (!pattern.args || pattern.args.length === 0) return pattern.match.test(haystack)
  return pattern.args.some((name) => {
    const value = call.args?.[name]
    return typeof value === 'string' && pattern.match.test(value)
  })
}

/**
 * Every way one command line can carry a second command: the boolean and
 * sequencing operators, a pipe, a background `&`, and a bare newline. Ordered
 * so the two-character forms win over their one-character prefixes.
 */
const COMMAND_SEPARATORS = /\s*(?:&&|\|\||;|\||&|\r?\n)\s*/
/** `2>&1`, `>&2`, `<&0` — an `&` that belongs to a redirect, not a separator. */
const REDIRECT_AMP = /(\d*[<>])&/g
/** A substitution runs a command this function cannot see: `$(…)`, `${…}`, backticks. */
const SUBSTITUTION = /\$\(|\$\{|`/
/** `> file` / `>> file` — writes a file the head alone says nothing about. `2>&1` is not one. */
const WRITE_REDIRECT = />(?!&)/

/**
 * The rule a "Allow for this conversation" grant records for a call: the
 * tool name, and for the shell the leading token(s) of EVERY command in the
 * line, wrappers (sudo, env, nohup…) stripped, joined in order.
 *
 * Every segment, not just the first: keying on the head alone meant one grant
 * for `npm install` silently covered `npm install && rm -rf ~/Documents` later
 * in the same conversation, because the two produced the same rule. A chain
 * keys as `npm install && rm`, which matches no grant made for the plain
 * command, so the second call asks again. `&`, a newline and a pipe are
 * separators for exactly the same reason — each one hides a second command.
 *
 * A command substitution defeats head-listing entirely (`npm install $(rm -rf
 * ~/Documents)` has one head and runs two commands), so a line carrying one
 * keys on its whole collapsed text: granting it allows that exact line again
 * and nothing else.
 */
export function sessionAllowRule(call: ToolCall): string {
  if (call.name !== 'shell_exec') return call.name
  const command = typeof call.args?.command === 'string' ? call.args.command.trim() : ''
  if (!command) return 'shell_exec'
  if (SUBSTITUTION.test(command)) return `shell_exec=${command.replace(/\s+/g, ' ')}`
  const segments = command
    .replace(REDIRECT_AMP, '$1 ')
    .split(COMMAND_SEPARATORS)
    .filter((s) => s.trim().length > 0)
  const heads = segments.map((segment) => {
    const words = segment.split(/\s+/).filter((w) => w.length > 0)
    while (words.length > 0 && /^(sudo|doas|env|nohup|time|nice)$/.test(words[0])) words.shift()
    while (words.length > 0 && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0])) words.shift()
    const head = words[0] ?? ''
    if (!head) return ''
    const sub =
      words[1] && !words[1].startsWith('-') && TWO_TOKEN_HEADS.has(head) ? ` ${words[1]}` : ''
    return `${head}${sub}`
  })
  const rule = heads.filter((h) => h.length > 0).join(' && ')
  if (!rule) return 'shell_exec'
  // A redirect writes a file of the command's choosing — `npm install > ~/.zshrc`
  // shares every head with `npm install` — so it cannot ride that grant either.
  return `shell_exec:${rule}${WRITE_REDIRECT.test(command) ? ' >' : ''}`
}

export class Amygdala {
  /** "Allow for this conversation" grants: session key → rules. Memory only. */
  private sessionAllow = new Map<string, Set<string>>()
  private patterns: DangerPattern[] = []
  private approvalBridge: ApprovalBridge | null
  private bypassPermissions = false

  constructor(private options: AmygdalaOptions = {}) {
    this.approvalBridge = options.approvalBridge ?? null
  }

  /**
   * Wire the approval bridge after construction. Used by main, where the
   * Electron IPC channels aren't available when the Agent is built.
   */
  setApprovalBridge(bridge: ApprovalBridge | null): void {
    this.approvalBridge = bridge
  }

  /**
   * Toggle auto-approval mode. When true, every `confirm`/`destructive`
   * call resolves to approved without prompting the user. `block`-class
   * calls remain hard-blocked — bypass mode is for skipping the dialog,
   * not for overriding hard safety stops.
   */
  setBypassPermissions(value: boolean): void {
    this.bypassPermissions = value
  }

  isBypassingPermissions(): boolean {
    return this.bypassPermissions
  }

  /**
   * Register danger patterns contributed by a capability. Capabilities
   * call this when they load so amygdala can refuse the operations they
   * own (shell knows what `rm -rf` is; the core does not). With zero
   * capabilities, no patterns are registered and every tool call
   * classifies as `safe`.
   */
  registerPatterns(patterns: DangerPattern[]): void {
    this.patterns.push(...patterns)
  }

  /**
   * Classify a tool call by matching its serialized arguments against
   * every registered pattern. The first match wins; with no registered
   * patterns the call is `safe`.
   */
  classify(call: ToolCall): DangerLevel {
    let haystack: string
    try {
      haystack = JSON.stringify(call.args)
    } catch {
      return 'safe'
    }
    for (const pattern of this.patterns) {
      if (patternHits(pattern, call, haystack)) return pattern.level
    }
    return 'safe'
  }

  /**
   * Find the first matching pattern (or null if none). Useful when callers
   * need both the level and the reason in a single pass.
   */
  match(call: ToolCall): DangerPattern | null {
    let argsString: string
    try {
      argsString = JSON.stringify(call.args)
    } catch {
      argsString = ''
    }
    // Match against the tool name AND the stringified args, so a pattern
    // can target either side. Without the name, a danger pattern that names
    // a specific tool (e.g. `test_dangerous_action`) would never fire.
    const haystack = `${call.name} ${argsString}`
    for (const pattern of this.patterns) {
      if (patternHits(pattern, call, haystack)) return pattern
    }
    return null
  }

  /**
   * Bounce a request to the renderer for the user's approval and resolve
   * with their decision. Without a bridge wired, fails closed (denied) so
   * a misconfigured runtime never executes a confirm-level call. When
   * bypass mode is on the user dialog is skipped and approval is granted
   * automatically — `safety.autoApproved` is logged so the audit trail
   * is intact.
   */
  async requestApproval(req: ApprovalRequest): Promise<ApprovalDecision> {
    const id = generateApprovalId()
    // A description may declare the unit of consent itself (computer use:
    // the app the action resolved to); otherwise the call decides.
    const rule = req.description?.scope ?? sessionAllowRule(req.toolCall)
    if (req.sessionKey && this.sessionAllow.get(req.sessionKey)?.has(rule)) {
      this.options.corpus?.emit('safety.autoApproved', {
        id,
        tool: req.toolCall.name,
        args: req.toolCall.args,
        level: req.level,
        reason: `allowed for this conversation (${rule})`
      })
      return 'approved'
    }
    if (this.bypassPermissions) {
      this.options.corpus?.emit('safety.autoApproved', {
        id,
        tool: req.toolCall.name,
        args: req.toolCall.args,
        level: req.level,
        reason: req.reason
      })
      return 'approved'
    }
    this.options.corpus?.emit('safety.confirmNeeded', {
      id,
      tool: req.toolCall.name,
      args: req.toolCall.args,
      reason: req.reason
    })
    if (!this.approvalBridge) {
      this.options.corpus?.emit('safety.denied', { id })
      return APPROVAL_DENIED
    }
    let decision: ApprovalDecision
    try {
      decision = await this.approvalBridge({ ...req, id })
    } catch {
      decision = APPROVAL_DENIED
    }
    if (decision === 'approved_session') {
      if (req.sessionKey) {
        let rules = this.sessionAllow.get(req.sessionKey)
        if (!rules) {
          rules = new Set()
          this.sessionAllow.set(req.sessionKey, rules)
        }
        rules.add(rule)
      }
      this.options.corpus?.emit('safety.approved', { id })
      return 'approved'
    }
    if (decision === 'approved') {
      this.options.corpus?.emit('safety.approved', { id })
    } else {
      this.options.corpus?.emit('safety.denied', { id })
    }
    return decision
  }

  /** The rules "Allow for this conversation" has granted, per session key. */
  sessionAllowRules(sessionKey: string): string[] {
    return [...(this.sessionAllow.get(sessionKey) ?? [])]
  }

  /** Drop a conversation's session rules (on delete / reset). */
  clearSessionAllow(sessionKey: string): void {
    this.sessionAllow.delete(sessionKey)
  }

  /**
   * Convenience boolean — anything that isn't `safe` deserves a second look.
   */
  isDangerous(call: ToolCall): boolean {
    return this.classify(call) !== 'safe'
  }

  /**
   * Hard-stop: emit a safety.blocked event and surface a recoverable error
   * so the agent loop can hand the reason back to the LLM and continue
   * the conversation.
   */
  block(call: ToolCall, reason: string): never {
    this.options.corpus?.emit('safety.blocked', {
      tool: call.name,
      args: call.args,
      reason
    })
    throw new SafetyBlockedError(call.name, reason)
  }
}

export class SafetyBlockedError extends Error {
  readonly toolName: string
  readonly reason: string
  constructor(toolName: string, reason: string) {
    super(`safety.blocked: ${toolName} — ${reason}`)
    this.name = 'SafetyBlockedError'
    this.toolName = toolName
    this.reason = reason
  }
}

function generateApprovalId(): string {
  return `apr_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}
