/**
 * Edit-tool matching engine tests — the port of OpenCode's edit.ts replacer
 * pipeline (src/defaults/workspace/brain/cerebellum/filesystem/plugin/replacers.mjs)
 * and the dependency-free unified diff beside it (unified-diff.mjs).
 *
 * Covers: every OpenCode edit.test.ts case that exercises `replace` (the
 * Effect/filesystem/LSP/permission cases are skipped), each of the nine
 * replacers on its own, the three terminal error messages verbatim,
 * replaceAll, the disproportionate-match guard, CRLF preservation through the
 * line-ending helpers, trimDiff, and the unified diff (hand-checked hunks,
 * change counts, trailing-newline exactness, a randomized reconstruction
 * invariant, and the large-file fallback).
 *
 * Standalone — no vitest/jest in this repo.
 * Run: TSX_TSCONFIG_PATH=tsconfig.node.json npx tsx src/main/runtime/__tests__/edit-replacers.test.ts
 */
import path from 'node:path'
import { pathToFileURL } from 'node:url'

let passed = 0
let failed = 0

function ok(name: string, cond: boolean, detail?: string): void {
  if (cond) {
    passed++
    return
  }
  failed++
  console.error(`FAIL ${name}${detail ? `: ${detail}` : ''}`)
}

const PLUGIN_DIR = 'src/defaults/workspace/brain/cerebellum/filesystem/plugin'

// The three terminal messages of replace(), verbatim from OpenCode edit.ts.
const MSG_IDENTICAL = 'No changes to apply: oldString and newString are identical.'
const MSG_EMPTY =
  'oldString cannot be empty when editing an existing file. Provide the exact text to replace, or use write for an intentional full-file replacement.'
const MSG_NOT_FOUND =
  'Could not find oldString in the file. It must match exactly, including whitespace, indentation, and line endings.'
const MSG_MULTIPLE =
  'Found multiple matches for oldString. Provide more surrounding context to make the match unique.'
const MSG_DISPROPORTIONATE =
  'Refusing replacement because the matched span is much larger than oldString. Re-read the file and provide the full exact oldString for the intended replacement.'

function thrown(fn: () => unknown): string | null {
  try {
    fn()
    return null
  } catch (err) {
    return err instanceof Error ? err.message : String(err)
  }
}

async function run(): Promise<void> {
  const replacers = await import(
    pathToFileURL(path.join(process.cwd(), PLUGIN_DIR, 'replacers.mjs')).href
  )
  const udiff = await import(
    pathToFileURL(path.join(process.cwd(), PLUGIN_DIR, 'unified-diff.mjs')).href
  )
  const {
    replace,
    trimDiff,
    isDisproportionateMatch,
    normalizeLineEndings,
    detectLineEnding,
    convertToLineEnding,
    levenshtein,
    SimpleReplacer,
    LineTrimmedReplacer,
    BlockAnchorReplacer,
    WhitespaceNormalizedReplacer,
    IndentationFlexibleReplacer,
    EscapeNormalizedReplacer,
    TrimmedBoundaryReplacer,
    ContextAwareReplacer,
    MultiOccurrenceReplacer
  } = replacers
  const { createUnifiedDiff, countChanges, diffLines, splitLines } = udiff

  const yields = (r: (c: string, f: string) => Iterable<string>, c: string, f: string): string[] =>
    Array.from(r(c, f))

  // ── OpenCode edit.test.ts: editing existing files ─────────────────────
  ok(
    'replaces text in existing file',
    replace('old content here', 'old content', 'new content') === 'new content here'
  )
  ok(
    'throws when oldString equals newString',
    thrown(() => replace('content', 'same', 'same')) === MSG_IDENTICAL
  )
  ok(
    'throws when oldString not found in file',
    thrown(() => replace('actual content', 'not in file', 'replacement')) === MSG_NOT_FOUND
  )
  {
    const original = [
      'function configure() {',
      '  keepImportantState()',
      '  removeAllUserData()',
      '  archiveBackups()',
      '  auditLog()',
      '}'
    ].join('\n')
    ok(
      'rejects loose block-anchor matches (size delta beyond 25%)',
      thrown(() =>
        replace(
          original,
          ['function configure() {', '  const enabled = true', '}'].join('\n'),
          ['function configure() {', '  const enabled = false', '}'].join('\n')
        )
      ) === MSG_NOT_FOUND
    )
  }
  {
    const original = ['function configure() {', '  removeAllUserData()', '}'].join('\n')
    ok(
      'rejects block-anchor matches with unrelated middle content',
      thrown(() =>
        replace(
          original,
          ['function configure() {', '  const enabled = true', '}'].join('\n'),
          ['function configure() {', '  const enabled = false', '}'].join('\n')
        )
      ) === MSG_NOT_FOUND
    )
  }
  ok(
    'replaces all occurrences with replaceAll option',
    replace('foo bar foo baz foo', 'foo', 'qux', true) === 'qux bar qux baz qux'
  )

  // ── OpenCode edit.test.ts: edge cases ─────────────────────────────────
  ok(
    'handles multiline replacements',
    replace('line1\nline2\nline3', 'line2', 'new line 2\nextra line') ===
      'line1\nnew line 2\nextra line\nline3'
  )
  {
    // "handles CRLF line endings" — through the same helper pipeline edit.ts uses.
    const content = 'line1\r\nold\r\nline3'
    const ending = detectLineEnding(content)
    const out = replace(
      content,
      convertToLineEnding(normalizeLineEndings('old'), ending),
      convertToLineEnding(normalizeLineEndings('new'), ending)
    )
    ok('handles CRLF line endings', out === 'line1\r\nnew\r\nline3', JSON.stringify(out))
  }
  ok(
    'empty oldString AND empty newString → identical (identical check wins)',
    thrown(() => replace('content', '', '')) === MSG_IDENTICAL
  )
  ok(
    'rejects empty oldString on existing content',
    thrown(() => replace('﻿using System;\n', '', 'using Up;\n')) === MSG_EMPTY
  )
  {
    // "tracks file diff statistics"
    const before = 'line1\nline2\nline3'
    const after = replace(before, 'line2', 'new line a\nnew line b')
    const stats = countChanges(before, after)
    ok('diff statistics: additions > 0', stats.additions > 0, JSON.stringify(stats))
    ok(
      'diff statistics exact',
      stats.additions === 2 && stats.deletions === 1,
      JSON.stringify(stats)
    )
  }

  // ── OpenCode edit.test.ts: line endings (all ten cases) ───────────────
  {
    const old = 'alpha\nbeta\ngamma'
    const next = 'alpha\nbeta-updated\ngamma'
    const alt = 'alpha\nbeta\nomega'
    const normalize = (text: string, ending: '\n' | '\r\n'): string => {
      const normalized = text.replaceAll('\r\n', '\n')
      if (ending === '\n') return normalized
      return normalized.replaceAll('\n', '\r\n')
    }
    const count = (content: string): { crlf: number; lf: number } => {
      const crlf = content.match(/\r\n/g)?.length ?? 0
      const lf = content.match(/\n/g)?.length ?? 0
      return { crlf, lf: lf - crlf }
    }
    const isLf = (c: string): boolean => count(c).crlf === 0 && count(c).lf > 0
    const isCrlf = (c: string): boolean => count(c).lf === 0 && count(c).crlf > 0
    // Mirrors edit.ts execute(): detect the file's ending, coerce both strings to it.
    const apply = (
      content: string,
      oldString: string,
      newString: string,
      replaceAll?: boolean
    ): string => {
      const ending = detectLineEnding(content)
      return replace(
        content,
        convertToLineEnding(normalizeLineEndings(oldString), ending),
        convertToLineEnding(normalizeLineEndings(newString), ending),
        replaceAll
      )
    }

    let out = apply(normalize(old + '\n', '\n'), normalize(old, '\n'), normalize(next, '\n'))
    ok('preserves LF with LF multi-line strings', out === normalize(next + '\n', '\n') && isLf(out))

    out = apply(normalize(old + '\n', '\r\n'), normalize(old, '\r\n'), normalize(next, '\r\n'))
    ok(
      'preserves CRLF with CRLF multi-line strings',
      out === normalize(next + '\n', '\r\n') && isCrlf(out)
    )

    out = apply(normalize(old + '\n', '\n'), normalize(old, '\r\n'), normalize(next, '\r\n'))
    ok('preserves LF when old/new use CRLF', out === normalize(next + '\n', '\n') && isLf(out))

    out = apply(normalize(old + '\n', '\r\n'), normalize(old, '\n'), normalize(next, '\n'))
    ok('preserves CRLF when old/new use LF', out === normalize(next + '\n', '\r\n') && isCrlf(out))

    out = apply(normalize(old + '\n', '\n'), normalize(old, '\n'), normalize(next, '\r\n'))
    ok('preserves LF when newString uses CRLF', out === normalize(next + '\n', '\n') && isLf(out))

    out = apply(normalize(old + '\n', '\r\n'), normalize(old, '\r\n'), normalize(next, '\n'))
    ok(
      'preserves CRLF when newString uses LF',
      out === normalize(next + '\n', '\r\n') && isCrlf(out)
    )

    out = apply(normalize(old + '\n', '\n'), 'alpha\nbeta\r\ngamma', 'alpha\r\nbeta\nomega')
    ok(
      'preserves LF with mixed old/new line endings',
      out === normalize(alt + '\n', '\n') && isLf(out)
    )

    out = apply(normalize(old + '\n', '\r\n'), 'alpha\r\nbeta\ngamma', 'alpha\nbeta\r\nomega')
    ok(
      'preserves CRLF with mixed old/new line endings',
      out === normalize(alt + '\n', '\r\n') && isCrlf(out)
    )

    const blockOld = 'alpha\nbeta'
    const blockNew = 'alpha\nbeta-updated'
    out = apply(
      normalize(blockOld + '\n' + blockOld + '\n', '\n'),
      normalize(blockOld, '\n'),
      normalize(blockNew, '\n'),
      true
    )
    ok(
      'replaceAll preserves LF for multi-line blocks',
      out === normalize(blockNew + '\n' + blockNew + '\n', '\n') && isLf(out)
    )

    out = apply(
      normalize(blockOld + '\n' + blockOld + '\n', '\r\n'),
      normalize(blockOld, '\r\n'),
      normalize(blockNew, '\r\n'),
      true
    )
    ok(
      'replaceAll preserves CRLF for multi-line blocks',
      out === normalize(blockNew + '\n' + blockNew + '\n', '\r\n') && isCrlf(out)
    )
  }

  // ── Line-ending helpers on their own ──────────────────────────────────
  ok('normalizeLineEndings collapses CRLF', normalizeLineEndings('a\r\nb\r\nc') === 'a\nb\nc')
  ok('normalizeLineEndings leaves LF alone', normalizeLineEndings('a\nb') === 'a\nb')
  ok('detectLineEnding → CRLF', detectLineEnding('a\r\nb') === '\r\n')
  ok('detectLineEnding → LF', detectLineEnding('a\nb') === '\n')
  ok('detectLineEnding defaults to LF for one-liners', detectLineEnding('a') === '\n')
  ok('convertToLineEnding to CRLF', convertToLineEnding('a\nb', '\r\n') === 'a\r\nb')
  ok('convertToLineEnding to LF is identity', convertToLineEnding('a\nb', '\n') === 'a\nb')

  // ── The remaining terminal messages ───────────────────────────────────
  ok(
    'ambiguous match → multiple-matches message',
    thrown(() => replace('foo bar foo', 'foo', 'x')) === MSG_MULTIPLE
  )
  ok(
    'ambiguous match resolves with replaceAll',
    replace('foo bar foo', 'foo', 'x', true) === 'x bar x'
  )
  {
    // EscapeNormalized turns a one-line escaped find into a 4-line real span:
    // 4 ≥ max(1 + 3, 1 * 2) → disproportionate.
    const content = 'a\nb\nc\nd'
    const msg = thrown(() => replace(content, 'a\\nb\\nc\\nd', 'x'))
    ok(
      'disproportionate guard fires through the pipeline',
      msg === MSG_DISPROPORTIONATE,
      msg ?? 'no throw'
    )
  }

  // ── isDisproportionateMatch boundaries ────────────────────────────────
  ok(
    'disproportionate: 1 old line vs 4 matched lines',
    isDisproportionateMatch('a\nb\nc\nd', 'a') === true
  )
  ok(
    'not disproportionate: 1 old line vs 3 matched lines',
    isDisproportionateMatch('a\nb\nc', 'a') === false
  )
  ok(
    'not disproportionate: 1 old line, huge single line (line rule only)',
    isDisproportionateMatch('x'.repeat(5000), 'a') === false
  )
  ok(
    'disproportionate: 3 old vs 6 matched (2x)',
    isDisproportionateMatch('1\n2\n3\n4\n5\n6', '1\n2\n3') === true
  )
  ok(
    'not disproportionate: 3 old vs 5 matched',
    isDisproportionateMatch('1\n2\n3\n4\n5', '1\n2\n3') === false
  )
  ok(
    'disproportionate: multi-line char blowup (>+500)',
    isDisproportionateMatch('a\n' + 'x'.repeat(600), 'a\nb') === true
  )
  ok(
    'not disproportionate: multi-line, 4x rule not exceeded',
    isDisproportionateMatch('a\n' + 'x'.repeat(400), 'a\n' + 'y'.repeat(200)) === false
  )

  // ── Each replacer on its own ──────────────────────────────────────────
  ok(
    'SimpleReplacer yields find verbatim',
    yields(SimpleReplacer, 'anything', 'find').join('|') === 'find'
  )

  {
    const content = 'function f() {\n    return 1\n}\n'
    ok(
      'LineTrimmedReplacer matches ignoring per-line indentation',
      yields(LineTrimmedReplacer, content, 'return 1').join('|') === '    return 1'
    )
    ok(
      'LineTrimmedReplacer multi-line block, trailing newline in find dropped',
      yields(LineTrimmedReplacer, content, 'function f() {\nreturn 1\n}\n').join('|') ===
        'function f() {\n    return 1\n}'
    )
    ok(
      'replace() via LineTrimmed',
      replace(content, 'return 1', 'return 2') === 'function f() {\n    return 2\n}\n'
    )
  }

  {
    // BlockAnchor: first/last anchors exact, middle line similar (Levenshtein).
    const content = ['function configure() {', '  const enabled = true;', '}'].join('\n')
    const find = ['function configure() {', '  const enabled = true', '}'].join('\n')
    ok(
      'BlockAnchorReplacer accepts similar middle line',
      yields(BlockAnchorReplacer, content, find).join('|') === content
    )
    ok(
      'replace() via BlockAnchor',
      replace(content, find, 'function configure() {\n  const enabled = false\n}') ===
        'function configure() {\n  const enabled = false\n}'
    )
    ok(
      'BlockAnchorReplacer ignores < 3 line finds',
      yields(BlockAnchorReplacer, content, 'function configure() {\n}').length === 0
    )
    // Multiple candidates: picks the most similar one.
    const two = ['start', '  alpha one', 'end', 'other', 'start', '  alpha two', 'end'].join('\n')
    const got = yields(BlockAnchorReplacer, two, 'start\n  alpha two!\nend')
    ok(
      'BlockAnchorReplacer picks best of multiple candidates',
      got.length === 1 && got[0] === 'start\n  alpha two\nend',
      JSON.stringify(got)
    )
    // Size delta: block of 5 vs find of 3 → maxLineDelta = max(1, floor(0.75)) = 1 → rejected.
    ok(
      'BlockAnchorReplacer rejects block beyond maxLineDelta',
      yields(BlockAnchorReplacer, 'a\nb\nc\nd\ne', 'a\nb\ne').length === 0
    )
    ok(
      'BlockAnchorReplacer accepts block within maxLineDelta',
      yields(BlockAnchorReplacer, 'a\nb\nc\nd', 'a\nb\nd').join('|') === 'a\nb\nc\nd'
    )
  }

  {
    ok(
      'WhitespaceNormalizedReplacer full-line match',
      yields(WhitespaceNormalizedReplacer, 'let  x   =  1\n', 'let x = 1').join('|') ===
        'let  x   =  1'
    )
    ok(
      'WhitespaceNormalizedReplacer substring match',
      yields(WhitespaceNormalizedReplacer, 'const a = foo(  1,   2 )', 'foo( 1, 2 )').join('|') ===
        'foo(  1,   2 )'
    )
    ok(
      'WhitespaceNormalizedReplacer multi-line block',
      yields(WhitespaceNormalizedReplacer, 'a  b\nc   d\n', 'a b\nc d').includes('a  b\nc   d')
    )
    ok(
      'replace() via WhitespaceNormalized',
      replace('let  x   =  1', 'let x = 1', 'let x = 2') === 'let x = 2'
    )
  }

  {
    const content = 'if (x) {\n        foo()\n        bar()\n}'
    ok(
      'IndentationFlexibleReplacer matches with different base indent',
      yields(IndentationFlexibleReplacer, content, '  foo()\n  bar()').join('|') ===
        '        foo()\n        bar()'
    )
    ok(
      'replace() via IndentationFlexible',
      replace(content, '  foo()\n  bar()', '  baz()') === 'if (x) {\n  baz()\n}'
    )
  }

  {
    ok(
      'EscapeNormalizedReplacer unescapes \\n in find',
      yields(EscapeNormalizedReplacer, 'a\nb', 'a\\nb').includes('a\nb')
    )
    ok(
      'EscapeNormalizedReplacer matches escaped content block',
      yields(EscapeNormalizedReplacer, 'say \\"hi\\"', 'say "hi"').includes('say \\"hi\\"')
    )
    ok(
      'replace() via EscapeNormalized',
      replace('x = "a\tb"', 'x = "a\\tb"', 'x = "ab"') === 'x = "ab"'
    )
  }

  {
    ok(
      'TrimmedBoundaryReplacer yields trimmed find',
      yields(TrimmedBoundaryReplacer, 'foo bar', '  foo bar  ').includes('foo bar')
    )
    ok(
      'TrimmedBoundaryReplacer skips already-trimmed find',
      yields(TrimmedBoundaryReplacer, 'foo bar', 'foo bar').length === 0
    )
    ok(
      'TrimmedBoundaryReplacer yields the block whose trim matches (with its blank neighbours)',
      yields(TrimmedBoundaryReplacer, 'x\n\nfoo\n\ny', '\nfoo\n').includes('\nfoo\n')
    )
    ok(
      'replace() with an untrimmed find still lands',
      replace('a foo b', '\nfoo\n', 'bar') === 'a bar b'
    )
  }

  {
    // ContextAware: same line count, anchors exact, ≥50% middle lines match.
    const content = ['begin', '  one', '  two', '  three', 'end'].join('\n')
    const find = ['begin', '  one', '  TWO', '  three', 'end'].join('\n')
    ok(
      'ContextAwareReplacer accepts ≥50% middle match',
      yields(ContextAwareReplacer, content, find).join('|') === content
    )
    const bad = ['begin', '  ONE', '  TWO', '  three', 'end'].join('\n')
    ok(
      'ContextAwareReplacer rejects <50% middle match',
      yields(ContextAwareReplacer, content, bad).length === 0
    )
    ok(
      'ContextAwareReplacer needs ≥3 lines',
      yields(ContextAwareReplacer, content, 'begin\nend').length === 0
    )
    ok(
      'ContextAwareReplacer requires equal block length',
      yields(ContextAwareReplacer, content, 'begin\n  one\nend').length === 0
    )
  }

  {
    ok(
      'MultiOccurrenceReplacer yields once per occurrence',
      yields(MultiOccurrenceReplacer, 'ab ab ab', 'ab').length === 3
    )
    ok(
      'MultiOccurrenceReplacer yields nothing when absent',
      yields(MultiOccurrenceReplacer, 'ab ab ab', 'zz').length === 0
    )
  }

  ok(
    'levenshtein basics',
    levenshtein('', 'abc') === 3 &&
      levenshtein('kitten', 'sitting') === 3 &&
      levenshtein('same', 'same') === 0
  )

  // ── replaceAll replaces every occurrence of the first replacer's span ──
  ok(
    'replaceAll replaces every occurrence, indentation intact',
    replace('  x = 1\ny\n  x = 1\n', 'x = 1', 'x = 2', true) === '  x = 2\ny\n  x = 2\n'
  )

  // ── trimDiff ──────────────────────────────────────────────────────────
  {
    const diff = [
      '--- a/f.ts',
      '+++ b/f.ts',
      '@@ -1,3 +1,3 @@',
      '     keep()',
      '-    old()',
      '+    new()',
      '     keep2()'
    ].join('\n')
    const expected = [
      '--- a/f.ts',
      '+++ b/f.ts',
      '@@ -1,3 +1,3 @@',
      ' keep()',
      '-old()',
      '+new()',
      ' keep2()'
    ].join('\n')
    ok('trimDiff strips common indentation from content lines only', trimDiff(diff) === expected)
    const mixed = ['@@ -1,2 +1,2 @@', ' top', '-    old', '+    new'].join('\n')
    ok('trimDiff is a no-op when any content line has zero indent', trimDiff(mixed) === mixed)
    ok(
      'trimDiff returns input when there are no content lines',
      trimDiff('--- a\n+++ b') === '--- a\n+++ b'
    )
    const blank = ['@@ -1,2 +1,2 @@', '-    a', ' ', '+    b'].join('\n')
    ok(
      'trimDiff ignores blank content lines when computing the minimum',
      trimDiff(blank) === ['@@ -1,2 +1,2 @@', '-a', ' ', '+b'].join('\n')
    )
  }

  // ── Unified diff: splitLines exactness ────────────────────────────────
  ok(
    'splitLines keeps terminators',
    JSON.stringify(splitLines('a\nb\n')) === JSON.stringify(['a\n', 'b\n'])
  )
  ok(
    'splitLines: no trailing newline',
    JSON.stringify(splitLines('a\nb')) === JSON.stringify(['a\n', 'b'])
  )
  ok('splitLines: empty → []', splitLines('').length === 0)
  ok(
    'splitLines: lone newline is one empty line',
    JSON.stringify(splitLines('\n')) === JSON.stringify(['\n'])
  )

  // ── Unified diff: hand-checked hunks ──────────────────────────────────
  {
    const before = 'line1\nline2\nline3\n'
    const after = 'line1\nnew line 2\nextra line\nline3\n'
    const expected = [
      '--- a/f.txt',
      '+++ b/f.txt',
      '@@ -1,3 +1,4 @@',
      ' line1',
      '-line2',
      '+new line 2',
      '+extra line',
      ' line3'
    ].join('\n')
    const got = createUnifiedDiff('f.txt', before, after)
    ok('unified diff: single hunk, one line → two', got === expected, got)
  }
  {
    const got = createUnifiedDiff('f.txt', 'a\nb', 'a\nb\n')
    const expected = ['--- a/f.txt', '+++ b/f.txt', '@@ -1,2 +1,2 @@', ' a', '-b', '+b'].join('\n')
    ok(
      'unified diff: adding a trailing newline is a real change, no phantom empty line',
      got === expected,
      got
    )
    const stats = countChanges('a\nb', 'a\nb\n')
    ok(
      'countChanges: trailing newline change is 1/1',
      stats.additions === 1 && stats.deletions === 1
    )
  }
  {
    const got = createUnifiedDiff('new.txt', '', 'x\ny\n')
    const expected = ['--- a/new.txt', '+++ b/new.txt', '@@ -0,0 +1,2 @@', '+x', '+y'].join('\n')
    ok('unified diff: new file uses -0,0', got === expected, got)
    const del = createUnifiedDiff('gone.txt', 'x\ny\n', '')
    ok(
      'unified diff: emptied file uses +0,0',
      del === ['--- a/gone.txt', '+++ b/gone.txt', '@@ -1,2 +0,0 @@', '-x', '-y'].join('\n'),
      del
    )
  }
  ok(
    'unified diff: identical texts → header only',
    createUnifiedDiff('f', 'same\n', 'same\n') === '--- a/f\n+++ b/f'
  )
  {
    // Two changes far apart → two hunks with 3 lines of context each.
    const lines = Array.from({ length: 20 }, (_, i) => `L${i + 1}`)
    const before = lines.join('\n') + '\n'
    const changed = lines.slice()
    changed[1] = 'X'
    changed[17] = 'Y'
    const got = createUnifiedDiff('f', before, changed.join('\n') + '\n')
    const expected = [
      '--- a/f',
      '+++ b/f',
      '@@ -1,5 +1,5 @@',
      ' L1',
      '-L2',
      '+X',
      ' L3',
      ' L4',
      ' L5',
      '@@ -15,6 +15,6 @@',
      ' L15',
      ' L16',
      ' L17',
      '-L18',
      '+Y',
      ' L19',
      ' L20'
    ].join('\n')
    ok('unified diff: two distant changes → two hunks', got === expected, got)
    // Two changes 5 equal lines apart (≤ 2*context) → merged into one hunk.
    const near = lines.slice()
    near[1] = 'X'
    near[7] = 'Y'
    const merged = createUnifiedDiff('f', before, near.join('\n') + '\n')
    const expectedMerged = [
      '--- a/f',
      '+++ b/f',
      '@@ -1,11 +1,11 @@',
      ' L1',
      '-L2',
      '+X',
      ' L3',
      ' L4',
      ' L5',
      ' L6',
      ' L7',
      '-L8',
      '+Y',
      ' L9',
      ' L10',
      ' L11'
    ].join('\n')
    ok('unified diff: nearby changes merge into one hunk', merged === expectedMerged, merged)
    // Two changes 7 equal lines apart (> 2*context) → two hunks.
    const apart = lines.slice()
    apart[1] = 'X'
    apart[9] = 'Y'
    const split = createUnifiedDiff('f', before, apart.join('\n') + '\n')
    ok(
      'unified diff: gap of 2*context+1 splits hunks',
      (split.match(/^@@ /gm) ?? []).length === 2,
      split
    )
    // context = 0 → bare changes.
    const bare = createUnifiedDiff('f', before, apart.join('\n') + '\n', { context: 0 })
    ok(
      'unified diff: context 0',
      bare ===
        [
          '--- a/f',
          '+++ b/f',
          '@@ -2,1 +2,1 @@',
          '-L2',
          '+X',
          '@@ -10,1 +10,1 @@',
          '-L10',
          '+Y'
        ].join('\n'),
      bare
    )
  }
  {
    // Pure insertion in the middle and pure deletion — start numbers.
    const ins = createUnifiedDiff('f', 'a\nb\nc\n', 'a\nb\nNEW\nc\n', { context: 1 })
    ok(
      'unified diff: insertion',
      ins === ['--- a/f', '+++ b/f', '@@ -2,2 +2,3 @@', ' b', '+NEW', ' c'].join('\n'),
      ins
    )
    const del = createUnifiedDiff('f', 'a\nb\nc\n', 'a\nc\n', { context: 0 })
    ok(
      'unified diff: deletion with zero context uses -2,1 +1,0',
      del === ['--- a/f', '+++ b/f', '@@ -2,1 +1,0 @@', '-b'].join('\n'),
      del
    )
  }
  {
    // Counts agree with the rendered diff.
    const before = 'a\nb\nc\nd\ne\n'
    const after = 'a\nB\nc\nd2\nd3\ne\nf\n'
    const diff = createUnifiedDiff('f', before, after)
    const plus = diff.split('\n').filter((l) => l.startsWith('+') && !l.startsWith('+++')).length
    const minus = diff.split('\n').filter((l) => l.startsWith('-') && !l.startsWith('---')).length
    const stats = countChanges(before, after)
    ok(
      'countChanges matches rendered +/- lines',
      stats.additions === plus && stats.deletions === minus,
      JSON.stringify({ stats, plus, minus })
    )
    ok(
      'countChanges exact for the mixed edit',
      stats.additions === 4 && stats.deletions === 2,
      JSON.stringify(stats)
    )
  }

  // ── Unified diff: reconstruction invariant on random inputs ───────────
  {
    // Deterministic LCG so a failure is reproducible.
    let seed = 20260911
    const rnd = (n: number): number => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff
      return seed % n
    }
    let bad = 0
    for (let t = 0; t < 300; t++) {
      const n = rnd(12)
      const a: string[] = []
      for (let i = 0; i < n; i++) a.push('w' + rnd(5))
      const b = a.slice()
      const edits = rnd(6)
      for (let e = 0; e < edits; e++) {
        const kind = rnd(3)
        if (kind === 0 && b.length) b.splice(rnd(b.length), 1)
        else if (kind === 1) b.splice(rnd(b.length + 1), 0, 'w' + rnd(5))
        else if (b.length) b[rnd(b.length)] = 'w' + rnd(5)
      }
      const oldText = a.join('\n') + (rnd(2) ? '\n' : '')
      const newText = b.join('\n') + (rnd(2) ? '\n' : '')
      const ops = diffLines(oldText, newText) as Array<{ type: string; line: string }>
      const oldBack = ops
        .filter((o) => o.type !== '+')
        .map((o) => o.line)
        .join('')
      const newBack = ops
        .filter((o) => o.type !== '-')
        .map((o) => o.line)
        .join('')
      if (oldBack !== oldText || newBack !== newText) {
        bad++
        if (bad <= 3)
          console.error('reconstruction mismatch', JSON.stringify({ oldText, newText, ops }))
      }
    }
    ok('diffLines reconstructs both sides on 300 random edits', bad === 0, `${bad} mismatches`)
  }
  {
    // Myers minimality on a known case: LCS of ABCABBA / CBABAC is 4 → 3 del + 2 ins.
    const stats = countChanges('A\nB\nC\nA\nB\nB\nA\n', 'C\nB\nA\nB\nA\nC\n')
    ok(
      'Myers finds the minimal edit script (ABCABBA vs CBABAC)',
      stats.deletions === 3 && stats.additions === 2,
      JSON.stringify(stats)
    )
  }

  // ── Unified diff: large-file fallback ─────────────────────────────────
  {
    const big = Array.from({ length: 20_001 }, (_, i) => `row ${i}`)
    const before = big.join('\n') + '\n'
    const edited = big.slice()
    edited[10_000] = 'row changed'
    const after = edited.join('\n') + '\n'
    const started = Date.now()
    const diff = createUnifiedDiff('big.txt', before, after)
    const ms = Date.now() - started
    const stats = countChanges(before, after)
    ok(
      'fallback: > 20,000 lines still yields a replace hunk with the change',
      diff.includes('-row 10000') && diff.includes('+row changed')
    )
    ok(
      'fallback: counts stay exact for a one-line change (prefix/suffix strip)',
      stats.additions === 1 && stats.deletions === 1,
      JSON.stringify(stats)
    )
    ok('fallback: fast', ms < 2000, `${ms}ms`)
    // Edit-distance budget: two fully different 3,000-line middles → replace hunk, no hang.
    const left = Array.from({ length: 3000 }, (_, i) => `l${i}`).join('\n') + '\n'
    const right = Array.from({ length: 3000 }, (_, i) => `r${i}`).join('\n') + '\n'
    const t2 = Date.now()
    const s2 = countChanges(left, right)
    ok(
      'edit-distance budget: total rewrite counts every line',
      s2.additions === 3000 && s2.deletions === 3000
    )
    ok('edit-distance budget: fast', Date.now() - t2 < 2000, `${Date.now() - t2}ms`)
  }

  console.log(`${passed} passed, ${failed} failed`)
  process.exit(failed ? 1 : 0)
}

void run().catch((err) => {
  console.error('test harness crashed:', err)
  process.exit(1)
})
