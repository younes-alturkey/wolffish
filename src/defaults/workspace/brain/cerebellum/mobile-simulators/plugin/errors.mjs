// Typed, recoverable errors: the model can fix these by calling something
// else, so each one names its code, says what happened, and ends with the
// one call that repairs it. They ship as `retryable: false` so the harness
// shows them immediately instead of retrying the same call three times.
//
// Infrastructure failures (a missing binary, a timeout, a crashed helper)
// use `infra()` and stay retryable where a second attempt could plausibly
// succeed.

export const CODES = {
  NO_DEVICE: 'NO_DEVICE',
  DEVICE_NOT_FOUND: 'DEVICE_NOT_FOUND',
  NOT_BOOTED: 'NOT_BOOTED',
  BOOT_FAILED: 'BOOT_FAILED',
  APP_NOT_INSTALLED: 'APP_NOT_INSTALLED',
  APP_NOT_RUNNING: 'APP_NOT_RUNNING',
  SNAPSHOT_MISSING: 'SNAPSHOT_MISSING',
  SNAPSHOT_EXPIRED: 'SNAPSHOT_EXPIRED',
  REF_NOT_FOUND: 'REF_NOT_FOUND',
  TARGET_AMBIGUOUS: 'TARGET_AMBIGUOUS',
  TARGET_NOT_ACTIONABLE: 'TARGET_NOT_ACTIONABLE',
  FRAME_MISSING: 'FRAME_MISSING',
  OUT_OF_FRAME: 'OUT_OF_FRAME',
  WAIT_TIMEOUT: 'WAIT_TIMEOUT',
  CHARSET_UNSUPPORTED: 'CHARSET_UNSUPPORTED',
  AXE_UNAVAILABLE: 'AXE_UNAVAILABLE',
  INDICATOR_REQUIRED: 'INDICATOR_REQUIRED',
  UNSUPPORTED: 'UNSUPPORTED',
  INVALID_ARGUMENT: 'INVALID_ARGUMENT',
  TOOLCHAIN_MISSING: 'TOOLCHAIN_MISSING',
  RECORDING_ACTIVE: 'RECORDING_ACTIVE',
  NO_RECORDING: 'NO_RECORDING'
}

/**
 * A model-fixable failure. `hint` is the repair call, written as an
 * instruction ("call mobile_snapshot again"), never as an apology.
 */
export function fail(code, message, hint, extra = {}) {
  const text = `${code}: ${message}${hint ? ` — ${hint}` : ''}`
  return { success: false, error: text, retryable: false, meta: { code, ...extra } }
}

/** An infrastructure failure. Retryable unless told otherwise. */
export function infra(message, { retryable = true, output, code = 'INFRA' } = {}) {
  const r = { success: false, error: message, retryable, meta: { code } }
  if (output) r.output = output
  return r
}

export function invalid(what, hint) {
  return fail(CODES.INVALID_ARGUMENT, what, hint)
}

/** Text of a command failure, tail-biased, without the noise of a whole log. */
export function stderrOf(r, fallback = 'command failed') {
  const s = (r?.err || r?.out || '').trim()
  if (!s) return fallback
  const lines = s.split('\n').filter(Boolean)
  return lines.slice(-6).join('\n').slice(-800)
}
