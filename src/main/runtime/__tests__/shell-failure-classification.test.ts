/**
 * Shell failure-classification tests — pins the fix for the "many unknown
 * failures" seen in the 2026-06-15 Adobe-removal run, where inventory probes
 * that exit 1 to mean "no match" (grep/find/ls and pipelines ending in them)
 * were misreported as failures, retried 3x, and surfaced to the model as
 * "tool failed after 3 attempts (unknown): Command exited with code 1".
 *
 * Two layers:
 *   1. classifyError() — a deterministic non-zero process exit with no
 *      transient (network/timeout) signature is now non-retryable.
 *   2. The real shell plugin — exit code 1 with no output is surfaced as a
 *      clean empty result, not a failure. Driven through actual commands so
 *      the assertions track real shell behaviour, not a mock.
 *
 * Every "real run" case below is a verbatim error string or command from the
 * captured run (brain/conversations/conv-2026-06-15_05-36-40.json).
 *
 * Run: npx tsx src/main/runtime/__tests__/shell-failure-classification.test.ts
 */

import { classifyError } from '../motor'
import shellPlugin from '../../../defaults/workspace/brain/cerebellum/shell/plugin/index.mjs'

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

// ---------------------------------------------------------------------------
// Layer 1 — classifyError (pure function, exact strings from the real run)
// ---------------------------------------------------------------------------

function testClassifier(): void {
  // --- The core fix: blind deterministic shell exits stop being retryable ---
  // These three are the exact (message, exitCode) pairs the motor fed to the
  // classifier during the run; previously all → { retryable: true } → 3 attempts.
  const blindExit1 = classifyError('Command exited with code 1', 1)
  ok('blind exit 1 is non-retryable', blindExit1.retryable === false, JSON.stringify(blindExit1))
  ok('blind exit 1 category unknown', blindExit1.category === 'unknown')

  // #8 in the run: `ps … | grep adobe; echo "---"; launchctl … | grep adobe`
  const dashOutput = classifyError('Command exited with code 1: ---', 1)
  ok('exit 1 with "---" output is non-retryable', dashOutput.retryable === false)

  // #4 in the run: a find -exec du that found Adobe data but tripped exit 1 on
  // one unreadable sub-path — deterministic, must not retry.
  const partialFind = classifyError(
    'Command exited with code 1: 4.0K\t/Users/younes/Library/HTTPStorages/com.adobe.acc.AdobeCreativeCloud',
    1
  )
  ok('exit 1 with partial output is non-retryable', partialFind.retryable === false)

  // exit code 2 with no recognizable signature is also deterministic.
  ok(
    'exit 2 blind is non-retryable',
    classifyError('Command exited with code 2', 2).retryable === false
  )

  // --- Additive guarantee: tool errors WITHOUT an exitCode are unchanged ---
  // Non-shell tools (browser, http, etc.) report no exitCode, so they must keep
  // the retryable "unknown" default — the fix must not touch them.
  const noCodeNull = classifyError('some opaque tool error', null)
  ok(
    'no exitCode stays retryable (null)',
    noCodeNull.retryable === true && noCodeNull.category === 'unknown'
  )
  const noCodeUndef = classifyError('some opaque tool error')
  ok('no exitCode stays retryable (undefined)', noCodeUndef.retryable === true)

  // --- Regression guard: genuinely transient failures STILL retry ---
  // Network/timeout signatures are matched before the new exit-code branch, so
  // even with a non-zero exitCode they remain retryable.
  const curlDns = classifyError(
    'Command exited with code 6: curl: (6) Could not resolve host: example.com',
    6
  )
  ok(
    'curl DNS failure stays retryable',
    curlDns.retryable === true && curlDns.category === 'network',
    JSON.stringify(curlDns)
  )
  const connRefused = classifyError(
    'Command exited with code 7: Failed to connect: Connection refused',
    7
  )
  ok(
    'connection refused stays retryable',
    connRefused.retryable === true && connRefused.category === 'network'
  )
  const econn = classifyError('ECONNRESET while reading', 1)
  ok(
    'ECONNRESET stays retryable even with exit 1',
    econn.retryable === true && econn.category === 'network'
  )
  const timedOut = classifyError('Command timed out after 5000ms')
  ok('timeout stays retryable', timedOut.retryable === true && timedOut.category === 'timeout')

  // --- Regression guard: pre-existing deterministic classes are unchanged ---
  // #9/#10 in the run: `ls <absent path>` — already fast-failed as not_found.
  const lsAbsent = classifyError('Command exited with code 1: ls: /x: No such file or directory', 1)
  ok(
    'ls No such file stays not_found',
    lsAbsent.retryable === false && lsAbsent.category === 'not_found'
  )
  // #11 in the run: the one genuine failure — rm blocked by SIP/TCC.
  const rmPerm = classifyError('Command exited with code 1: rm: /x: Operation not permitted', 1)
  ok(
    'Operation not permitted stays permission',
    rmPerm.retryable === false && rmPerm.category === 'permission'
  )
  const cmdNotFound = classifyError('bash: foo: command not found', 127)
  ok(
    'exit 127 stays not_found',
    cmdNotFound.retryable === false && cmdNotFound.category === 'not_found'
  )
}

// ---------------------------------------------------------------------------
// Layer 2 — real shell plugin (drives actual commands)
// ---------------------------------------------------------------------------

type ExecResult = { success: boolean; output?: string; error?: string; exitCode?: number | null }

async function run(command: string): Promise<ExecResult> {
  return (await shellPlugin.execute('shell_exec', { command })) as ExecResult
}

async function testPlugin(): Promise<void> {
  // Portable reproduction of the run's no-match probes: grep over an empty file
  // exits 1 with no output. Must now be a clean success.
  const grepEmpty = await run('grep -i adobe /dev/null')
  ok('grep no-match → success', grepEmpty.success === true, grepEmpty.error)
  ok(
    'grep no-match → "no matches" note',
    !!grepEmpty.output && grepEmpty.output.includes('no matches')
  )

  // A pipeline that ends in grep finding nothing — the exact shape of the
  // run's failures (e.g. `… 2>/dev/null | grep -i adobe`).
  const pipeline = await run(
    "find /tmp -maxdepth 1 -name 'no-such-adobe-xyzzy' 2>/dev/null | grep adobe"
  )
  ok('empty find|grep pipeline → success', pipeline.success === true, pipeline.error)

  // The verbatim command #1 from the run. macOS-only (pkgutil); skip elsewhere.
  if (process.platform === 'darwin') {
    const realRunCmd = await run('pkgutil --pkgs 2>/dev/null | grep -i adobe')
    ok('real run command (pkgutil|grep) → success', realRunCmd.success === true, realRunCmd.error)
  }

  // Boundary: exit 1 WITH output is a real result the model must see, not a
  // masked "no match". Stays a failure so genuine errors aren't swallowed.
  const exit1WithOutput = await run("sh -c 'echo boom; exit 1'")
  ok('exit 1 with output stays failure', exit1WithOutput.success === false)
  ok('exit 1 with output preserves the output', (exit1WithOutput.output ?? '').includes('boom'))

  // grep -c prints a zero tally and exits 1 when nothing matched — the number
  // IS the result, not an error. Verbatim shape of the reported failure
  // (`grep -c '…' file.html` → "Command exited with code 1: 0"). Now a clean
  // success that returns the count instead of a masked "unknown" failure.
  const grepCount = await run('grep -c adobe /dev/null')
  ok('grep -c zero count → success', grepCount.success === true, grepCount.error)
  ok('grep -c zero count → returns the tally', (grepCount.output ?? '').trim() === '0')

  // The -r form prints "<file>:0" per file and still exits 1 when every count
  // is zero. All-zero counts are a clean no-match.
  const grepCountMulti = await run('sh -c \'printf "a.txt:0\\nb.txt:0\\n"; exit 1\'')
  ok('grep -c -r all-zero counts → success', grepCountMulti.success === true, grepCountMulti.error)

  // Guard: a non-zero number on exit 1 is NOT a zero count — must stay a
  // failure so genuine errors that happen to print a number aren't swallowed.
  const exit1NonZeroNumber = await run("sh -c 'echo 5; exit 1'")
  ok('exit 1 with non-zero number stays failure', exit1NonZeroNumber.success === false)

  // Boundary: exit code >= 2 is a real error (e.g. grep read error). Unchanged.
  const exit2 = await run("sh -c 'exit 2'")
  ok('exit 2 stays failure', exit2.success === false && exit2.exitCode === 2)
  ok('exit 2 blind failure carries the stderr hint', (exit2.error ?? '').includes('2>/dev/null'))

  // Sanity: ordinary success is untouched.
  const hello = await run('echo hello')
  ok('plain success unaffected', hello.success === true && (hello.output ?? '').includes('hello'))
}

async function main(): Promise<void> {
  testClassifier()
  await testPlugin()
  console.log(`\n${passed} passed, ${failed} failed`)
  if (failed > 0) process.exit(1)
}

void main()
