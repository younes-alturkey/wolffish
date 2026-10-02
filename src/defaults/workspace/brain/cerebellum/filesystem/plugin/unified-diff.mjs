// Dependency-free unified diff for the edit tool. Plain ESM — runs inside the
// Electron main-process plugin loader with no bundler and no node_modules.
//
// Line-based Myers O(ND) diff (Myers 1986, "An O(ND) Difference Algorithm and
// Its Variations") over tokens that RETAIN their line terminator, so a final
// line without "\n" is a different token from the same line with one: the
// diff shows "-b" / "+b" for "a\nb" → "a\nb\n" instead of inventing a phantom
// empty line, and identical texts produce no hunk. Common prefix and suffix
// are stripped before Myers runs, so an ordinary edit costs O(changed region).
//
// Guards: if either side exceeds MAX_LINES, or the Myers edit distance would
// exceed MAX_EDIT_DISTANCE (memory for the trace is O(D²)), the changed middle
// is emitted as one delete-all / insert-all replace hunk instead.

const MAX_LINES = 20_000
const MAX_EDIT_DISTANCE = 2_000

/**
 * @typedef {{ type: '=' | '-' | '+', line: string }} Op
 */

/**
 * Split text into lines that keep their trailing "\n" (the last line keeps
 * whatever it had — possibly nothing). "" → [].
 * @param {string} text
 * @returns {string[]}
 */
export function splitLines(text) {
  if (text === '') return []
  return text.match(/[^\n]*\n|[^\n]+$/g) ?? []
}

/**
 * Myers O(ND) diff over two token arrays. Returns null when the edit distance
 * exceeds `maxD` (caller falls back).
 * @param {string[]} a
 * @param {string[]} b
 * @param {number} maxD
 * @returns {Op[] | null}
 */
function myers(a, b, maxD) {
  const N = a.length
  const M = b.length
  const MAX = N + M
  if (MAX === 0) return []
  const limit = Math.min(MAX, maxD)

  // v[k + OFF] = furthest x on diagonal k, for k in [-MAX-1, MAX+1] (the
  // loop reads k±1 at the edges, so one diagonal of slack on each side).
  // trace[d] = copy of the k-range [-d-1, d+1] as it stood at the START of
  // iteration d (i.e. after d-1 edits).
  const OFF = MAX + 1
  const v = new Int32Array(2 * MAX + 3)
  /** @type {Int32Array[]} */
  const trace = []
  v[OFF + 1] = 0

  let found = -1
  for (let d = 0; d <= limit; d++) {
    // slice covers k = -d-1 .. d+1 → index (k + d + 1); never negative
    // because OFF - d - 1 >= OFF - MAX - 1 = 0.
    trace.push(v.slice(OFF - d - 1, OFF + d + 2))
    for (let k = -d; k <= d; k += 2) {
      let x
      if (k === -d || (k !== d && v[OFF + k - 1] < v[OFF + k + 1])) {
        x = v[OFF + k + 1]
      } else {
        x = v[OFF + k - 1] + 1
      }
      let y = x - k
      while (x < N && y < M && a[x] === b[y]) {
        x++
        y++
      }
      v[OFF + k] = x
      if (x >= N && y >= M) {
        found = d
        break
      }
    }
    if (found >= 0) break
  }
  if (found < 0) return null

  // Backtrack from (N, M) to (0, 0), emitting ops in reverse.
  /** @type {Op[]} */
  const reversed = []
  let x = N
  let y = M
  for (let d = found; d >= 0; d--) {
    const vPrev = trace[d]
    const at = (k) => vPrev[k + d + 1]
    const k = x - y
    let prevK
    if (d === 0) {
      prevK = 0
    } else if (k === -d || (k !== d && at(k - 1) < at(k + 1))) {
      prevK = k + 1
    } else {
      prevK = k - 1
    }
    const prevX = d === 0 ? 0 : at(prevK)
    const prevY = prevX - prevK

    // The diagonal snake we walked after the edit.
    while (x > prevX && y > prevY) {
      x--
      y--
      reversed.push({ type: '=', line: a[x] })
    }
    if (d > 0) {
      if (x === prevX) {
        // vertical step: insertion of b[prevY]
        y--
        reversed.push({ type: '+', line: b[y] })
      } else {
        // horizontal step: deletion of a[prevX]
        x--
        reversed.push({ type: '-', line: a[x] })
      }
    }
  }
  return reversed.reverse()
}

/**
 * Line-level diff of two texts as a flat op list ('=' kept, '-' removed,
 * '+' added). Invariant: the '='+'-' lines concatenate to `oldText`, the
 * '='+'+' lines concatenate to `newText`.
 * @param {string} oldText
 * @param {string} newText
 * @returns {Op[]}
 */
export function diffLines(oldText, newText) {
  const a = splitLines(oldText)
  const b = splitLines(newText)

  // Common prefix / suffix — cheap and covers the typical edit.
  let prefix = 0
  const maxPrefix = Math.min(a.length, b.length)
  while (prefix < maxPrefix && a[prefix] === b[prefix]) prefix++
  let suffix = 0
  const maxSuffix = maxPrefix - prefix
  while (suffix < maxSuffix && a[a.length - 1 - suffix] === b[b.length - 1 - suffix]) suffix++

  const midA = a.slice(prefix, a.length - suffix)
  const midB = b.slice(prefix, b.length - suffix)

  /** @type {Op[] | null} */
  let middle = null
  if (a.length <= MAX_LINES && b.length <= MAX_LINES) {
    middle = myers(midA, midB, MAX_EDIT_DISTANCE)
  }
  if (middle === null) {
    middle = [
      ...midA.map((line) => /** @type {Op} */ ({ type: '-', line })),
      ...midB.map((line) => /** @type {Op} */ ({ type: '+', line }))
    ]
  }

  /** @type {Op[]} */
  const ops = []
  for (let i = 0; i < prefix; i++) ops.push({ type: '=', line: a[i] })
  for (const op of middle) ops.push(op)
  for (let i = a.length - suffix; i < a.length; i++) ops.push({ type: '=', line: a[i] })
  return orderChanges(ops)
}

/**
 * Within each contiguous run of changes, emit deletions before insertions —
 * the git/jsdiff convention. Reordering inside a run cannot alter what either
 * side reconstructs to, since '-' lines belong only to old and '+' only to new.
 * @param {Op[]} ops
 * @returns {Op[]}
 */
function orderChanges(ops) {
  /** @type {Op[]} */
  const out = []
  let i = 0
  while (i < ops.length) {
    if (ops[i].type === '=') {
      out.push(ops[i])
      i++
      continue
    }
    let j = i
    while (j < ops.length && ops[j].type !== '=') j++
    for (let k = i; k < j; k++) if (ops[k].type === '-') out.push(ops[k])
    for (let k = i; k < j; k++) if (ops[k].type === '+') out.push(ops[k])
    i = j
  }
  return out
}

/**
 * Additions / deletions counted the same way the unified diff renders them.
 * @param {string} oldText
 * @param {string} newText
 * @returns {{ additions: number, deletions: number }}
 */
export function countChanges(oldText, newText) {
  let additions = 0
  let deletions = 0
  for (const op of diffLines(oldText, newText)) {
    if (op.type === '+') additions++
    else if (op.type === '-') deletions++
  }
  return { additions, deletions }
}

/** @param {string} line */
function stripNewline(line) {
  return line.endsWith('\n') ? line.slice(0, -1) : line
}

/**
 * Standard unified diff: `--- a/<path>`, `+++ b/<path>`, then
 * `@@ -start,count +start,count @@` hunks with `context` lines of context.
 * An empty range uses the line BEFORE it as its start (git convention:
 * `@@ -0,0 +1,3 @@` for a new file). Identical texts → header only.
 * @param {string} filePath
 * @param {string} oldText
 * @param {string} newText
 * @param {{ context?: number }} [options]
 */
export function createUnifiedDiff(filePath, oldText, newText, { context = 3 } = {}) {
  const ops = diffLines(oldText, newText)
  const ctx = Math.max(0, Math.floor(context))

  // Cursor arrays: number of old / new lines consumed BEFORE op i.
  const oldBefore = new Int32Array(ops.length + 1)
  const newBefore = new Int32Array(ops.length + 1)
  for (let i = 0; i < ops.length; i++) {
    const t = ops[i].type
    oldBefore[i + 1] = oldBefore[i] + (t === '+' ? 0 : 1)
    newBefore[i + 1] = newBefore[i] + (t === '-' ? 0 : 1)
  }

  const out = [`--- a/${filePath}`, `+++ b/${filePath}`]

  let i = 0
  while (i < ops.length) {
    if (ops[i].type === '=') {
      i++
      continue
    }
    // Hunk starts `ctx` equal lines before this change.
    const start = Math.max(0, i - ctx)
    // Extend over changes; swallow equal runs of length ≤ 2*ctx that are
    // followed by another change; stop after `ctx` equals otherwise.
    let j = i
    let end = i
    while (j < ops.length) {
      while (j < ops.length && ops[j].type !== '=') j++
      end = j
      let eq = 0
      while (j + eq < ops.length && ops[j + eq].type === '=') eq++
      const more = j + eq < ops.length
      if (more && eq <= 2 * ctx) {
        j += eq
        continue
      }
      end = j + Math.min(eq, ctx)
      break
    }

    let oldLines = 0
    let newLines = 0
    for (let k = start; k < end; k++) {
      const t = ops[k].type
      if (t !== '+') oldLines++
      if (t !== '-') newLines++
    }
    const oldStart = oldLines === 0 ? oldBefore[start] : oldBefore[start] + 1
    const newStart = newLines === 0 ? newBefore[start] : newBefore[start] + 1
    out.push(`@@ -${oldStart},${oldLines} +${newStart},${newLines} @@`)
    for (let k = start; k < end; k++) {
      const op = ops[k]
      out.push((op.type === '=' ? ' ' : op.type) + stripNewline(op.line))
    }
    i = end
  }

  return out.join('\n')
}
