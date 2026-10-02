import { diskWriter } from '@main/io/diskWriter'
import { spillToolOutput } from '@main/runtime/tool-output'
import type { Cerebellum, ToolExecutionResult } from '@main/runtime/cerebellum'
import type { Corpus } from '@main/runtime/corpus'
import type { ToolCall } from '@main/runtime/wernicke'
import fs from 'node:fs/promises'
import path from 'node:path'

/**
 * Motor is the resilient execution layer.
 *
 * Maps to: the motor cortex — the strip along the back of the frontal
 * lobe that turns intention into movement. The premotor area plans the
 * action, the primary motor cortex fires the muscles, and the cerebellum
 * smooths it all out. Without the motor cortex you can want to move all
 * day; nothing happens.
 *
 * In Wolffish, Motor takes approved tool calls and runs them via the
 * cerebellum. Every task is persisted to motor/tasks/TASK-{id}.md as it
 * executes, so a crash mid-task leaves a recoverable record. Failed
 * steps retry with exponential backoff up to three times. Every task is
 * abortable via an AbortController.
 */

export type TaskId = string
export type TaskStatus = 'running' | 'succeeded' | 'failed' | 'stopped'
export type TaskStepStatus = 'pending' | 'running' | 'succeeded' | 'failed' | 'stopped'

export type TaskStep = {
  call: ToolCall
  status: TaskStepStatus
  attempts: number
  output: string | null
  error: string | null
  startedAt: number | null
  finishedAt: number | null
}

export type Task = {
  id: TaskId
  description: string
  createdAt: number
  updatedAt: number
  status: TaskStatus
  steps: TaskStep[]
  transcriptPath: string
}

export type StepResult = {
  ok: boolean
  output: string
  attempts: number
  images?: Array<{ mediaType: string; data: string }>
  // The raw, unclassified failure text — full captured stdout+stderr (or the
  // plugin's error when no output was produced), without the
  // "tool failed (category, non-retryable):" wrapper the model needs. Routed
  // to the tool_result segment's UI-only `error` field so the user sees the
  // original error as-is in a scrollable block, while `output` (the classified
  // message) stays the only thing replayed into model context. Undefined on
  // success and on failures with nothing extra to surface.
  verbose?: string
  /** UI-only structured facts from the tool (diff, exit code…); see ToolExecutionResult.meta. */
  meta?: Record<string, unknown>
}

export type MotorOptions = {
  workspaceRoot?: string
  maxRetries?: number
  retryDelaysMs?: number[]
  cerebellum?: Cerebellum
  corpus?: Corpus
}

const DEFAULT_RETRIES = 10
// Backoff between retries — gives transient failures (network blips,
// container restarts, race conditions) time to clear before re-firing.
const DEFAULT_BACKOFF_MS = [2000, 4000, 8000, 15000, 30000, 60000, 60000, 60000, 60000, 60000]
// Heuristic for "this failed because the tool's timeout hit" — the shell
// plugin emits "Command timed out after Nms" and most other plugins use
// the same phrasing. When matched, the retry doubles the original
// `timeout` arg instead of replaying the same value, so a too-tight
// budget doesn't deterministically retry into the same wall.
const TIMEOUT_ERROR_RE = /timed out|timeout/i

export type ErrorCategory =
  | 'permission'
  | 'network'
  | 'timeout'
  | 'not_found'
  | 'validation'
  | 'unknown'

export type ToolError = {
  message: string
  retryable: boolean
  category: ErrorCategory
}

// "no new privileges" — a process under a no_new_privs sandbox (e.g. the
//   packaged Electron app) where the kernel ignores the setuid bit, so sudo and
//   pkexec can never elevate; retrying the install just re-fires the same wall.
// "dismissed the password" / "password prompt cancelled" — the user declined
//   the elevation dialog; a blind retry can't change that decision.
const PERMISSION_RE =
  /permission denied|access denied|need sudo|not permitted|not authorized|EACCES|EPERM|requires admin|requires root|operation not permitted|insufficient privileges|Failed to get sources|assistive access|HTTP 401\b|HTTP 403\b|HTTP 451\b|\bForbidden\b|\bUnauthorized\b|a terminal is required|no tty present|no new privileges|dismissed the password|password prompt cancelled|password prompt\b/i
// Windows cmd.exe and PowerShell both emit "syntax is incorrect" when a
// command line is malformed (typically unresolved %ENV% expansion or
// quoting errors). Treat the same way as EINVAL — retrying the exact
// same call will produce the exact same error.
// PDF/filesystem plugin phrasings we deliberately add — all deterministic:
//   * "beyond the …MB read limit" / "exceeds the …MB limit" — file-size caps;
//     the file will be exactly as big on retry (observed live: a 248MB PDF
//     burned 4 tool calls × 3 attempts × ~6s = ~24s of pure retry waste).
//   * "invalid page selection" — malformed page range, same on retry.
//   * "could not decode" — corrupt/undecodable image, same bytes on retry.
// Kept as exact plugin wordings (never a bare "limit", which would collide
// with retryable rate-limit errors).
const VALIDATION_RE =
  /invalid argument|missing required|EINVAL|bad request|HTTP 400\b|HTTP 422\b|syntax is incorrect|incorrect parameter|is not a valid selector|beyond the \d+MB read limit|exceeds the \d+MB limit|invalid page selection|could not decode/i
// Windows phrasings we deliberately add:
//   * "is not recognized as" — cmd.exe and PowerShell's CommandNotFoundException
//   * "CommandNotFoundException" — PowerShell typed error name
//   * "cannot find the file specified" / "cannot find the path specified" —
//     Win32 GetLastError 2/3, surfaced verbatim by cmd.exe
// These are the most common deterministic shell errors on Windows; without
// them the motor retries 10x on a typo and burns ~5 minutes per failure.
// "unknown tool: <name>" / "no such tool" come from the cerebellum when the
// model hallucinates a tool name (e.g. a browser_* twin of an ext_* tool).
// That is deterministic — the tool will never exist on retry — so classify it
// as not_found and fail fast instead of burning three attempts.
// "No tab with id: N" / "No window with id: N" come from the browser
// extension when the model passes a guessed or stale id. Deterministic — that
// id will never exist on retry — so fail fast instead of burning three
// attempts (observed live: `ext_get_url {tabId:1}` retried 3× for 6s before
// surfacing). The extension also now falls back to the active tab in
// resolveTabId, so this mainly catches the tab-taking commands that don't.
const NOT_FOUND_RE =
  /command not found|not found|no .+ found|ENOENT|no such file|is not installed|unknown tool|no such tool|HTTP 404\b|HTTP 410\b|is not recognized as|CommandNotFoundException|cannot find the (?:file|path) specified|no tab with id|no window with id/i
const NETWORK_RE =
  /ECONNREFUSED|ETIMEDOUT|ECONNRESET|network error|fetch failed|DNS resolution|could not resolve host|connection refused|connection reset|connection timed out|temporary failure in name resolution/i
const TIMEOUT_RE = /timed out|timeout|SIGTERM/i

/**
 * Classify a tool's error string so the retry loop knows whether to keep
 * trying. Permission/validation/not_found errors are deterministic — the
 * same call will produce the same failure on retry, so we fail fast and
 * surface the error to the LLM. Network/timeout errors are worth retrying
 * since they often resolve on their own.
 */
export function classifyError(error: string, exitCode?: number | null): ToolError {
  const message = error || 'unknown error'

  // Exit-code classification runs first — more reliable than text matching
  // when stderr was suppressed (2>/dev/null) and the diagnostic is dominated
  // by successful stdout from earlier commands in a && chain.
  if (exitCode != null) {
    // 127: command not found (POSIX sh, bash, zsh — universal across Unix)
    // 9009: "is not recognized as an internal or external command" (Windows cmd.exe)
    if (exitCode === 127 || exitCode === 9009) {
      return { message, retryable: false, category: 'not_found' }
    }
    // macOS: launchctl returns 113 for "service not loaded" — deterministic.
    // Linux: 113 can mean EHOSTUNREACH (transient) — leave to text matching.
    if (exitCode === 113 && process.platform === 'darwin') {
      return { message, retryable: false, category: 'not_found' }
    }
    // 126: command found but not executable (POSIX)
    if (exitCode === 126) {
      return { message, retryable: false, category: 'permission' }
    }
    // 5: access denied (Windows only — on Unix exit code 5 is tool-specific
    // and means different things: curl uses it for proxy errors, wget for
    // SSL failures. Only Windows reliably maps 5 to ACCESS_DENIED.)
    if (exitCode === 5 && process.platform === 'win32') {
      return { message, retryable: false, category: 'permission' }
    }
    // 128+N: killed by signal N (POSIX). Non-retryable unless the signal
    // could be a timeout (SIGALRM=14, SIGTERM=15) — those fall through to
    // the TIMEOUT_RE regex below.
    if (exitCode > 128 && exitCode <= 165) {
      const signal = exitCode - 128
      if (signal !== 14 && signal !== 15) {
        return { message, retryable: false, category: 'unknown' }
      }
    }
  }

  if (PERMISSION_RE.test(message)) {
    return { message, retryable: false, category: 'permission' }
  }
  if (VALIDATION_RE.test(message)) {
    return { message, retryable: false, category: 'validation' }
  }
  if (NOT_FOUND_RE.test(message)) {
    return { message, retryable: false, category: 'not_found' }
  }
  if (NETWORK_RE.test(message)) {
    return { message, retryable: true, category: 'network' }
  }
  if (TIMEOUT_RE.test(message)) {
    return { message, retryable: true, category: 'timeout' }
  }
  // A process that exited non-zero without any transient signature (network /
  // timeout, both handled above) is deterministic: the same args against the
  // same machine state reproduce it exactly. Retrying just burns backoff and
  // hands the model the same blind "(unknown)" three times — observed live on
  // `grep`/`find`/`ls` inventory probes that exit 1 to mean "no match". Fail
  // fast so the model can adjust the command instead. Only shell-style tools
  // report an exitCode; tool errors without one keep the retryable default
  // below, so non-shell behaviour is unchanged.
  if (exitCode != null && exitCode !== 0) {
    return { message, retryable: false, category: 'unknown' }
  }
  return { message, retryable: true, category: 'unknown' }
}

export class Motor {
  private tasks = new Map<TaskId, Task>()
  private abortControllers = new Map<TaskId, AbortController>()
  /**
   * Turn-level signals already linked to a task controller. A turn reuses
   * one signal across every tool call, so we wire the mirror once per signal
   * — re-adding a listener per step would pile up abort listeners on the
   * same signal and trip Node's EventTarget memory-leak warning on long
   * tasks. WeakSet so finished turns' signals are collected automatically.
   */
  private linkedSignals = new WeakSet<AbortSignal>()
  private readonly workspaceRoot: string | null
  private readonly maxRetries: number
  private readonly backoff: number[]
  private readonly corpus: Corpus | null
  private cerebellum: Cerebellum | null

  constructor(options: MotorOptions = {}) {
    this.workspaceRoot = options.workspaceRoot ?? null
    this.maxRetries = options.maxRetries ?? DEFAULT_RETRIES
    this.backoff = options.retryDelaysMs ?? DEFAULT_BACKOFF_MS
    this.corpus = options.corpus ?? null
    this.cerebellum = options.cerebellum ?? null
  }

  setCerebellum(cerebellum: Cerebellum): void {
    this.cerebellum = cerebellum
  }

  /**
   * Persist a new task file under motor/tasks/ and return its handle.
   * The task starts in `running` state with no steps; callers add steps
   * as they execute.
   */
  async createTask(description: string): Promise<Task> {
    const id = generateTaskId()
    const now = Date.now()
    const transcriptPath = this.taskPath(id)
    const task: Task = {
      id,
      description: description.trim() || 'Tool execution',
      createdAt: now,
      updatedAt: now,
      status: 'running',
      steps: [],
      transcriptPath
    }
    this.tasks.set(id, task)
    this.abortControllers.set(id, new AbortController())
    await this.writeTranscript(task)
    this.corpus?.emit('task.created', {
      taskId: id,
      name: task.description,
      stepsTotal: 0
    })
    return task
  }

  /**
   * Run one tool call as the next step on this task. Calls cerebellum
   * to dispatch, retries on failure with backoff, logs each attempt to
   * the transcript, and returns a structured result. The agent loop
   * decides whether to keep going.
   */
  async executeStep(
    taskId: TaskId,
    call: ToolCall,
    signal?: AbortSignal,
    // A per-call signal (runtime/check-in.ts): the ONLY way to stop one call
    // without stopping the task. When given, it — not the task signal — is
    // what the plugin sees; the agent links the turn's Stop into it while the
    // call is in flight and aborts it alone when the model says call_stop.
    stepSignal?: AbortSignal
  ): Promise<StepResult> {
    const task = this.tasks.get(taskId)
    if (!task) throw new Error(`unknown task: ${taskId}`)
    if (!this.cerebellum) {
      throw new Error('Motor.executeStep called before cerebellum was wired')
    }

    const abort = this.abortControllers.get(taskId)
    // Mirror a turn-level abort into this task's controller so stopping the
    // run also interrupts an in-flight tool, even on channels that abort the
    // turn without calling stopTask. The per-task signal is what flows down
    // to the plugin, so this keeps a single source of truth for "stop".
    // Wired once per turn signal (see linkedSignals).
    if (signal && abort && !this.linkedSignals.has(signal)) {
      this.linkedSignals.add(signal)
      if (signal.aborted) abort.abort()
      else signal.addEventListener('abort', () => abort.abort(), { once: true })
    }
    const step: TaskStep = {
      call,
      status: 'running',
      attempts: 0,
      output: null,
      error: null,
      startedAt: Date.now(),
      finishedAt: null
    }
    task.steps.push(step)
    task.updatedAt = Date.now()
    await this.writeTranscript(task)
    this.corpus?.emit('tool.called', { taskId, tool: call.name, args: call.args })

    const execSignal = stepSignal ?? abort?.signal
    let attemptArgs = call.args
    for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
      if (abort?.signal.aborted || execSignal?.aborted) {
        step.status = 'stopped'
        step.finishedAt = Date.now()
        step.error = 'aborted'
        task.updatedAt = Date.now()
        await this.writeTranscript(task)
        return { ok: false, output: 'Stopped by user.', attempts: attempt - 1 }
      }

      step.attempts = attempt
      const startedAt = Date.now()

      let result: ToolExecutionResult
      try {
        result = await this.cerebellum.executeTool(call.name, attemptArgs, execSignal, call.id)
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        result = { success: false, error: message }
      }

      // If the tool failed because its own timeout fired, double the
      // budget on the next attempt. Without this, a too-tight timeout
      // just retries into the same wall — same value, same wall, same
      // failure. We only mutate when the call already carries a numeric
      // `timeout`; the per-tool default applies otherwise. The mutation
      // is local to the retry loop so step.call.args still reflects
      // what the model originally requested.
      if (
        !result.success &&
        attempt < this.maxRetries &&
        TIMEOUT_ERROR_RE.test(result.error ?? '')
      ) {
        // Plugins name their timeout arg differently — the shell plugin uses
        // `timeout`, the playwright browser tools use `timeout_ms`. Double
        // whichever one the call actually carries so a too-tight budget
        // doesn't just retry into the same wall with the same value.
        const timeoutKey =
          typeof attemptArgs.timeout === 'number' && attemptArgs.timeout > 0
            ? 'timeout'
            : typeof attemptArgs.timeout_ms === 'number' && attemptArgs.timeout_ms > 0
              ? 'timeout_ms'
              : null
        if (timeoutKey) {
          attemptArgs = { ...attemptArgs, [timeoutKey]: (attemptArgs[timeoutKey] as number) * 2 }
        }
      }

      const durationMs = Date.now() - startedAt

      if (result.success) {
        step.status = 'succeeded'
        step.output = await this.bound(
          result.output ?? '',
          call.name,
          result.meta?.outputBounded === true
        )
        step.error = null
        step.finishedAt = Date.now()
        task.updatedAt = Date.now()
        this.corpus?.emit('tool.completed', { taskId, tool: call.name, durationMs })
        await this.writeTranscript(task)
        this.corpus?.emit('task.stepCompleted', {
          taskId,
          step: task.steps.length,
          total: task.steps.length
        })
        return {
          ok: true,
          output: step.output ?? '',
          attempts: attempt,
          images: result.images,
          meta: result.meta
        }
      }

      step.error = result.error ?? 'unknown error'
      // Plugins (e.g. shell) attach captured stderr/stdout on failure.
      // Without surfacing it the model sees only "exited with code N" and
      // has to re-run the command just to learn the cause.
      const failureOutput = result.output
        ? await this.bound(result.output, call.name, result.meta?.outputBounded === true)
        : ''
      if (failureOutput) step.output = failureOutput
      this.corpus?.emit('tool.failed', {
        taskId,
        tool: call.name,
        error: step.error,
        attempt
      })

      const classified = classifyError(step.error, result.exitCode)
      // A tool that declares its own failure non-retryable outranks the text
      // heuristics below it — the tool KNOWS, the regexes guess. This is the
      // only signal that can stop a retry whose danger is that it would
      // succeed a second time (see ToolExecutionResult.retryable).
      if (result.retryable === false || !classified.retryable) {
        // Deterministic failure — same call, same args, same wall. Stop now
        // instead of burning two more retries on identical permission /
        // validation / not_found errors.
        step.status = 'failed'
        step.finishedAt = Date.now()
        task.updatedAt = Date.now()
        const errorPart = `tool failed (${classified.category}, non-retryable): ${classified.message}`
        const finalMessage = failureOutput ? `${errorPart}\n${failureOutput}` : errorPart
        step.error = finalMessage
        await this.writeTranscript(task)
        return {
          ok: false,
          output: finalMessage,
          attempts: attempt,
          verbose: failureOutput || result.error || 'unknown error'
        }
      }

      // Partial success with an unclassified error — useful output was
      // produced before failure, and the error doesn't match any known
      // transient pattern (network, timeout). Surface immediately so the
      // LLM sees the data instead of retrying a deterministic chain.
      if (result.partial && classified.category === 'unknown') {
        step.status = 'failed'
        step.finishedAt = Date.now()
        task.updatedAt = Date.now()
        const errorPart = `partial failure (non-retryable): ${classified.message}`
        const finalMessage = failureOutput ? `${errorPart}\n${failureOutput}` : errorPart
        step.error = finalMessage
        await this.writeTranscript(task)
        return {
          ok: false,
          output: finalMessage,
          attempts: attempt,
          verbose: failureOutput || result.error || 'unknown error'
        }
      }

      // Unknown, timeout, and network errors get a shorter leash — 3
      // attempts is enough to distinguish a transient blip from a dead
      // endpoint, and backoff beyond that just burns wall time.
      if (
        (classified.category === 'unknown' ||
          classified.category === 'timeout' ||
          classified.category === 'network') &&
        attempt >= 3
      ) {
        step.status = 'failed'
        step.finishedAt = Date.now()
        task.updatedAt = Date.now()
        const errorPart = `tool failed after ${attempt} attempts (${classified.category}): ${classified.message}`
        const finalMessage = failureOutput ? `${errorPart}\n${failureOutput}` : errorPart
        step.error = finalMessage
        await this.writeTranscript(task)
        return {
          ok: false,
          output: finalMessage,
          attempts: attempt,
          verbose: failureOutput || result.error || 'unknown error'
        }
      }

      if (attempt < this.maxRetries) {
        await this.writeTranscript(task)
        const delay = this.backoff[Math.min(attempt - 1, this.backoff.length - 1)]
        if (await this.sleep(delay, abort?.signal)) continue
        // sleep returned false => aborted during backoff
        step.status = 'stopped'
        step.finishedAt = Date.now()
        task.updatedAt = Date.now()
        await this.writeTranscript(task)
        return { ok: false, output: 'Stopped by user.', attempts: attempt }
      }
    }

    step.status = 'failed'
    step.finishedAt = Date.now()
    task.updatedAt = Date.now()
    // Surface the exhaustion explicitly so the LLM (and the transcript)
    // see "tool failed after N attempts" instead of just the bare last
    // error or a generic "unknown" — without that context the model
    // can't tell whether to retry differently or give up entirely.
    const lastError = step.error ?? 'unknown error'
    const lastOutput = step.output ?? ''
    const errorPart = `tool failed after ${this.maxRetries} attempts: ${lastError}`
    const exhausted = lastOutput ? `${errorPart}\n${lastOutput}` : errorPart
    step.error = exhausted
    await this.writeTranscript(task)
    return {
      ok: false,
      output: exhausted,
      attempts: this.maxRetries,
      verbose: lastOutput || lastError
    }
  }

  /**
   * Record a step that the user denied at the safety gate. The step is
   * never executed, but it shows up in the transcript so the task file
   * surfaces the denial reason instead of an opaque "unknown" error.
   */
  async recordDeniedStep(taskId: TaskId, call: ToolCall, reason: string): Promise<void> {
    const task = this.tasks.get(taskId)
    if (!task) return
    const now = Date.now()
    const step: TaskStep = {
      call,
      status: 'failed',
      attempts: 0,
      output: null,
      error: reason,
      startedAt: now,
      finishedAt: now
    }
    task.steps.push(step)
    task.updatedAt = now
    await this.writeTranscript(task)
    this.corpus?.emit('tool.failed', {
      taskId,
      tool: call.name,
      error: reason,
      attempt: 0
    })
  }

  /**
   * Mark the task complete and rewrite the transcript header. Terminal
   * status is derived from per-step outcomes — any failed step ⇒ failed,
   * any stopped step ⇒ stopped, otherwise succeeded. Callers override
   * only when the truth lives outside the steps: a user abort
   * (`'stopped'`) or an LLM-side error that ended the turn before the
   * next step could run (`'failed'`). Idempotent.
   */
  async completeTask(taskId: TaskId, override?: 'stopped' | 'failed'): Promise<void> {
    const task = this.tasks.get(taskId)
    if (!task) return
    const status = override ?? deriveTerminalStatus(task.steps)
    task.status = status
    task.updatedAt = Date.now()
    await this.writeTranscript(task)
    if (status === 'succeeded') {
      this.corpus?.emit('task.completed', {
        taskId,
        durationMs: task.updatedAt - task.createdAt
      })
    } else if (status === 'failed') {
      // Report the error from the step that actually failed, not the last
      // step in the list — a trailing recovered step can leave the final
      // entry successful, which is what produced the bogus "unknown" reason.
      const lastFailedStep = [...task.steps].reverse().find((s) => s.status === 'failed')
      this.corpus?.emit('task.failed', {
        taskId,
        failedAt: task.updatedAt,
        error: lastFailedStep?.error ?? 'unknown'
      })
    } else if (status === 'stopped') {
      this.corpus?.emit('task.stopped', { taskId, stoppedAt: task.updatedAt })
    }
  }

  /**
   * Abort a running task. The currently-executing step is allowed to
   * finish; no further steps run.
   */
  async stopTask(taskId: TaskId): Promise<void> {
    const abort = this.abortControllers.get(taskId)
    abort?.abort()
    const task = this.tasks.get(taskId)
    if (!task) return
    if (task.status === 'running') {
      task.status = 'stopped'
      task.updatedAt = Date.now()
      await this.writeTranscript(task)
      this.corpus?.emit('task.stopped', { taskId, stoppedAt: task.updatedAt })
    }
  }

  getTask(taskId: TaskId): Task | undefined {
    return this.tasks.get(taskId)
  }

  /**
   * Read a task's current state from disk. The source of truth is the
   * markdown transcript, not in-memory state — when this returns the
   * caller has the same view they'd get from opening the file.
   */
  async getTaskState(taskId: TaskId): Promise<string> {
    const p = this.taskPath(taskId)
    try {
      return await fs.readFile(p, 'utf8')
    } catch {
      return ''
    }
  }

  /**
   * Enumerate every task in motor/tasks/, optionally filtering by status.
   */
  async listTasks(filter?: {
    status?: TaskStatus
  }): Promise<Array<{ id: string; status: string; description: string }>> {
    if (!this.workspaceRoot) return []
    const dir = path.join(this.workspaceRoot, 'brain', 'motor', 'tasks')
    let entries: string[]
    try {
      entries = await fs.readdir(dir)
    } catch {
      return []
    }
    const out: Array<{ id: string; status: string; description: string }> = []
    for (const name of entries) {
      if (!/^TASK-[A-Za-z0-9._-]+\.md$/.test(name)) continue
      const id = name.replace(/^TASK-/, '').replace(/\.md$/, '')
      const raw = await fs.readFile(path.join(dir, name), 'utf8').catch(() => '')
      const status = (/\*\*Status:\*\*\s*([A-Za-z]+)/i.exec(raw)?.[1] ?? '').toUpperCase()
      const description = (/^#\s*Task:\s*(.+)$/m.exec(raw)?.[1] ?? '').trim()
      if (filter?.status && status.toLowerCase() !== filter.status) continue
      out.push({ id, status, description })
    }
    return out
  }

  private taskPath(id: TaskId): string {
    const root = this.workspaceRoot ?? ''
    return path.join(root, 'brain', 'motor', 'tasks', `TASK-${id}.md`)
  }

  /**
   * Bound a tool's output for the model: head-biased 2000 lines / 50 KB,
   * the full text spilled to <workspace>/tool-output/ with a hint naming the
   * file (see tool-output.ts). Tools that already bounded their own output
   * (the shell, tail-biased) say so via meta.outputBounded and pass through.
   * NOT meta.truncated — that one only means "there was more", which a capped
   * `file_grep` also says while its text is still unbounded.
   */
  private async bound(text: string, tool: string, alreadyBounded = false): Promise<string> {
    if (alreadyBounded) return text
    const spilled = await spillToolOutput(this.workspaceRoot, text, { tool, direction: 'head' })
    return spilled.content
  }

  private async writeTranscript(task: Task): Promise<void> {
    if (!this.workspaceRoot) return
    const dir = path.dirname(task.transcriptPath)
    try {
      await fs.mkdir(dir, { recursive: true })
    } catch {
      return
    }
    const md = renderTranscript(task)
    try {
      await diskWriter.writeFileAtomic(task.transcriptPath, md)
    } catch {
      // best-effort: a transcript write failure must not abort execution
    }
    // Write full tool outputs to a separate detail log for debugging.
    // Never indexed by cortex, never included in context — just a
    // crash-recovery and debugging artifact.
    const detail = renderDetailLog(task)
    if (detail) {
      const detailPath = task.transcriptPath.replace('.md', '-detail.log')
      try {
        await diskWriter.writeFileAtomic(detailPath, detail)
      } catch {
        // best-effort
      }
    }
  }

  private async sleep(ms: number, signal?: AbortSignal): Promise<boolean> {
    if (signal?.aborted) return false
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        signal?.removeEventListener('abort', onAbort)
        resolve(true)
      }, ms)
      const onAbort = (): void => {
        clearTimeout(timer)
        resolve(false)
      }
      signal?.addEventListener('abort', onAbort, { once: true })
    })
  }
}

function generateTaskId(): string {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
}

function deriveTerminalStatus(steps: TaskStep[]): TaskStatus {
  // A failed step the agent worked past — it retried, took another route, and
  // a later step succeeded — is a *recovered* failure, not a task failure.
  // Only an unrecovered outcome at the tail of the run is terminal. Judge by
  // the last step that actually ran: if the agent ended on (or after) a
  // success, the task succeeded regardless of mid-run stumbles.
  let lastSucceeded = -1
  let lastFailed = -1
  let lastStopped = -1
  steps.forEach((s, i) => {
    if (s.status === 'succeeded') lastSucceeded = i
    else if (s.status === 'failed') lastFailed = i
    else if (s.status === 'stopped') lastStopped = i
  })
  if (lastStopped > lastSucceeded && lastStopped > lastFailed) return 'stopped'
  if (lastFailed > lastSucceeded) return 'failed'
  return 'succeeded'
}

function renderTranscript(task: Task): string {
  const status = task.status.toUpperCase()
  const stepsDone = task.steps.filter((s) => s.status === 'succeeded').length
  const lines: string[] = [
    `# Task: ${task.description}`,
    '',
    `- **ID:** TASK-${task.id}`,
    `- **Status:** ${status}`,
    `- **Created:** ${new Date(task.createdAt).toISOString()}`,
    `- **Updated:** ${new Date(task.updatedAt).toISOString()}`,
    `- **Steps:** ${stepsDone}/${task.steps.length} succeeded`,
    '',
    '## Steps',
    ''
  ]

  task.steps.forEach((step, idx) => {
    const icon = stepIcon(step.status)
    lines.push(`### Step ${idx + 1}: ${step.call.name} ${icon}`)
    lines.push(`- **Args:** \`${jsonInline(step.call.args)}\``)
    if (step.startedAt) {
      lines.push(`- **Started:** ${new Date(step.startedAt).toISOString()}`)
    }
    if (step.finishedAt && step.startedAt) {
      const ms = step.finishedAt - step.startedAt
      lines.push(`- **Duration:** ${(ms / 1000).toFixed(2)}s`)
    }
    lines.push(`- **Attempts:** ${step.attempts}`)
    if (step.output) {
      const size = step.output.length
      const PREVIEW_LIMIT = 2000
      const preview = step.output.slice(0, PREVIEW_LIMIT).replace(/\n/g, ' ').trim()
      const truncated = size - PREVIEW_LIMIT
      if (truncated > 0) {
        lines.push(
          `- **Output:** (${size.toLocaleString()} chars) ${preview}… [${truncated.toLocaleString()} chars omitted]`
        )
      } else {
        lines.push(`- **Output:** ${preview}`)
      }
    }
    if (step.error) {
      lines.push(`- **Error:** ${step.error}`)
    }
    lines.push(`- **Result:** ${step.status}`)
    lines.push('')
  })

  return lines.join('\n')
}

/**
 * Render full tool outputs for debugging. Written alongside the summary
 * transcript as TASK-{id}-detail.log — never indexed by cortex, never
 * included in context. Preserves the full output for crash recovery and
 * post-mortem inspection.
 */
function renderDetailLog(task: Task): string | null {
  const stepsWithOutput = task.steps.filter((s) => s.output && s.output.length > 2000)
  if (stepsWithOutput.length === 0) return null
  const lines: string[] = [`# Task Detail Log: TASK-${task.id}`, '']
  task.steps.forEach((step, idx) => {
    if (!step.output || step.output.length <= 2000) return
    lines.push(`## Step ${idx + 1}: ${step.call.name}`)
    lines.push('```')
    lines.push(step.output)
    lines.push('```')
    lines.push('')
  })
  return lines.join('\n')
}

function stepIcon(status: TaskStepStatus): string {
  switch (status) {
    case 'succeeded':
      return '✅'
    case 'failed':
      return '❌'
    case 'stopped':
      return '⏹'
    case 'running':
      return '⏳'
    default:
      return ''
  }
}

function jsonInline(value: unknown): string {
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}
