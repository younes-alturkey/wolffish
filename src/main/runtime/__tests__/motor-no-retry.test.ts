/**
 * Motor must never auto-retry a tool that declares its failure non-retryable.
 *
 * Pins the fix for the 2026-08-08 triple notification. One deliberate
 * notify_phone call put THREE identical notifications on the user's phone,
 * and the model was not involved: the transcript holds exactly one tool call.
 * The desktop log holds three frames —
 *
 *   13:16:58.325  notify …A0JN sent (completed, run hb_mske7wml)
 *   13:17:08.328  notification …A0JN → dropped (the relay did not answer)
 *   13:17:10.369  notify …ACB0 sent (completed, run hb_mske7wml)   ← +2s
 *   13:17:20.376  notification …ACB0 → dropped (the relay did not answer)
 *   13:17:24.418  notify …AT21 sent (completed, run hb_mske7wml)   ← +4s
 *   13:17:24.864  notification …AT21 → inband
 *
 * — spaced at exactly DEFAULT_BACKOFF_MS[0] and [1] after each 10 s timeout.
 * That is this retry loop, re-firing a tool whose side effect leaves the
 * machine. Each attempt minted a fresh notificationId, so neither the relay's
 * idempotency record nor the phone's seen-set could fold them, and all three
 * were delivered while the desktop believed none had been.
 *
 * The general rule this pins: a tool that cannot distinguish "not delivered"
 * from "delivered, confirmation lost" reports `retryable: false`, and motor
 * honours it ahead of its own error-text heuristics.
 *
 * Run: npx tsx --tsconfig tsconfig.node.json src/main/runtime/__tests__/motor-no-retry.test.ts
 */
import type { Cerebellum, ToolExecutionResult } from '../cerebellum'
import { Motor } from '../motor'

let passed = 0
let failed = 0

function ok(label: string, cond: boolean, detail?: string): void {
  if (cond) {
    passed++
    return
  }
  failed++
  console.error(`FAIL ${label}${detail ? `: ${detail}` : ''}`)
}

/** A motor wired to a cerebellum that counts calls and returns a fixed result.
 *  No workspaceRoot: transcripts are skipped, so nothing touches disk. Backoff
 *  is zeroed — this asserts call COUNTS, and real delays would only add ~6 s. */
function motorReturning(result: ToolExecutionResult): { motor: Motor; calls: () => number } {
  let calls = 0
  const cerebellum = {
    executeTool: async (): Promise<ToolExecutionResult> => {
      calls += 1
      return result
    }
  } as unknown as Cerebellum
  return {
    motor: new Motor({ cerebellum, maxRetries: 3, retryDelaysMs: [0, 0, 0] }),
    calls: () => calls
  }
}

async function main(): Promise<void> {
  // The regression itself: the notify_phone failure, verbatim from the run.
  // Nothing in it matches a non-retryable pattern — "the relay did not answer"
  // is not a permission, validation or not_found phrasing — so before the fix
  // it classified as retryable/unknown and burned every attempt.
  {
    const notifyFailure =
      "the notification's delivery is UNCONFIRMED: the relay did not answer within 10s, so " +
      'delivery is unknown — the notification may have reached the phone anyway.'
    const { motor, calls } = motorReturning({
      success: false,
      error: notifyFailure,
      retryable: false
    })
    const task = await motor.createTask('notify')
    const step = await motor.executeStep(task.id, { id: 'c1', name: 'notify_phone', args: {} })
    ok('a non-retryable failure is attempted exactly once', calls() === 1, `${calls()} attempts`)
    ok('…and reports one attempt to the agent loop', step.attempts === 1, String(step.attempts))
    ok('…and still surfaces as a failure', step.ok === false)
    ok(
      "…carrying the tool's own message, marked non-retryable",
      step.output.includes('non-retryable') && step.output.includes('UNCONFIRMED'),
      step.output
    )
  }

  // The control: the SAME message without the flag is retried to exhaustion.
  // This is what shipped, and it is why the phone buzzed three times.
  {
    const { motor, calls } = motorReturning({
      success: false,
      error: 'the relay did not answer — it may be unreachable'
    })
    const task = await motor.createTask('notify')
    await motor.executeStep(task.id, { id: 'c2', name: 'notify_phone', args: {} })
    ok(
      'without the flag the same failure is retried — the bug, pinned',
      calls() === 3,
      `${calls()} attempts`
    )
  }

  // The flag must not leak into the success path or suppress ordinary retries.
  {
    const { motor, calls } = motorReturning({ success: true, output: 'done' })
    const task = await motor.createTask('fine')
    const step = await motor.executeStep(task.id, { id: 'c3', name: 'shell', args: {} })
    ok('a success still runs once', calls() === 1 && step.ok === true)
  }
  {
    const { motor, calls } = motorReturning({
      success: false,
      error: 'fetch failed',
      retryable: true
    })
    const task = await motor.createTask('net')
    await motor.executeStep(task.id, { id: 'c4', name: 'shell', args: {} })
    ok('a genuinely transient failure still retries', calls() === 3, `${calls()} attempts`)
  }

  console.log(`\n${passed} passed, ${failed} failed`)
  if (failed > 0) process.exit(1)
}

void main()
