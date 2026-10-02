/**
 * The filesystem capability's tool contract (src/defaults/workspace/brain/
 * cerebellum/filesystem/plugin/index.mjs): line-numbered reads with
 * offset/limit, directory listing, binary refusal, did-you-mean misses;
 * file_edit with the matcher chain, its diff/meta, CRLF + BOM preservation
 * and its error contract; file_write diffs; the file_patch alias; and the
 * grep/glob tools through the plugin surface.
 *
 * Run:
 *   TSX_TSCONFIG_PATH=tsconfig.node.json npx tsx src/main/runtime/__tests__/filesystem-tools.test.ts
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

let passed = 0
let failed = 0
function ok(name: string, cond: unknown, detail?: unknown): void {
  if (cond) {
    passed++
    console.log(`  ✓ ${name}`)
  } else {
    failed++
    console.log(`  ✗ ${name}`)
    if (detail !== undefined)
      console.log('    ', typeof detail === 'string' ? detail : JSON.stringify(detail))
  }
}

type Result = {
  success: boolean
  output?: string
  error?: string
  retryable?: boolean
  meta?: {
    diff?: { file: string; patch: string; additions: number; deletions: number; kind: string }
    label?: string
  }
}
type Plugin = {
  init: (ctx: unknown) => Promise<void>
  execute: (name: string, args: Record<string, unknown>) => Promise<Result>
}

async function main(): Promise<void> {
  const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wolffish-fstools-'))
  const ROOT = fs.realpathSync(TMP)
  const write = (rel: string, content: string | Buffer): void => {
    const p = path.join(ROOT, rel)
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.writeFileSync(p, content)
  }
  write(
    'src/a.ts',
    'const a = 1\nconst b = 2\nfunction hello() {\n  return a + b\n}\nexport { hello }\n'
  )
  write('src/b.ts', 'export const b = 2\n')
  write('notes.md', '# notes\nhello world\n')
  write('long.txt', Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join('\n') + '\n')
  write('wide.txt', 'x'.repeat(2500) + '\nshort\n')
  write('image.png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3]))
  write('empty.txt', '')
  write('.gitignore', 'dist/\n')
  write('dist/out.ts', 'const hello = "built"\n')
  fs.mkdirSync(path.join(ROOT, '.git'))

  const fsPlugin = (
    await import(
      pathToFileURL(
        path.join(
          process.cwd(),
          'src/defaults/workspace/brain/cerebellum/filesystem/plugin/index.mjs'
        )
      ).href
    )
  ).default as Plugin
  await fsPlugin.init({ getWorkingFolders: () => [ROOT] })
  const run = (name: string, args: Record<string, unknown>): Promise<Result> =>
    fsPlugin.execute(name, args)

  console.log('file_read')
  {
    const r = await run('file_read', { path: 'src/a.ts' })
    ok('lines are numbered', r.success && r.output?.startsWith('1: const a = 1\n2: const b = 2'), r)
    ok(
      'footer says end of file with the count',
      r.output?.includes('(End of file — 6 lines)'),
      r.output
    )

    const w = await run('file_read', { path: 'long.txt', offset: 10, limit: 5 })
    ok(
      'offset/limit window',
      w.success &&
        w.output?.startsWith('10: line 10') &&
        w.output.includes('14: line 14') &&
        !w.output.includes('15: line 15'),
      w.output
    )
    ok(
      'window footer tells how to continue',
      w.output?.includes('(Showing lines 10-14 of 30. Use offset=15 to continue.)'),
      w.output
    )

    const alias = await run('file_read', { path: 'long.txt', startLine: 28, endLine: 30 })
    ok(
      'startLine/endLine aliases still work',
      alias.success &&
        alias.output?.startsWith('28: line 28') &&
        alias.output.includes('30: line 30'),
      alias.output
    )
    ok(
      'a window ending at EOF says so',
      alias.output?.includes('(End of file — lines 28-30 of 30)'),
      alias.output
    )

    const wide = await run('file_read', { path: 'wide.txt' })
    ok(
      'a 2500-char line is clipped with a suffix',
      wide.success &&
        wide.output?.includes('... (line truncated to 2000 chars)') &&
        !wide.output.includes('x'.repeat(2001)),
      wide.output?.slice(-120)
    )

    const dir = await run('file_read', { path: 'src' })
    ok(
      'a directory lists its entries',
      dir.success &&
        dir.output?.includes('Directory ') &&
        dir.output.includes('a.ts') &&
        dir.output.includes('b.ts'),
      dir.output
    )
    const rootDir = await run('file_read', { path: '.' })
    ok(
      'subdirectories carry a trailing slash',
      rootDir.output?.includes('src/') && rootDir.output?.includes('dist/'),
      rootDir.output
    )

    const miss = await run('file_read', { path: 'src/a.tsx' })
    ok(
      'a miss suggests nearby names',
      !miss.success &&
        miss.error?.includes('File not found') &&
        miss.error.includes('Did you mean') &&
        miss.error.includes('a.ts'),
      miss.error
    )

    const bin = await run('file_read', { path: 'image.png' })
    ok(
      'binary files are refused with guidance',
      !bin.success &&
        bin.error?.includes('Cannot read binary file') &&
        bin.error.includes('image_view'),
      bin.error
    )

    const empty = await run('file_read', { path: 'empty.txt' })
    ok('an empty file says so', empty.success && empty.output?.includes('is empty'), empty)

    const range = await run('file_read', { path: 'long.txt', offset: 99 })
    ok(
      'an out-of-range offset is an error naming the length',
      !range.success && range.error?.includes('out of range') && range.error.includes('30 lines'),
      range.error
    )
  }

  console.log('file_edit')
  {
    const r = await run('file_edit', {
      path: 'src/a.ts',
      old: '  return a + b',
      new: '  return a * b'
    })
    ok('a unique edit applies', r.success, r)
    ok(
      'output reports counts and the changed region with new line numbers',
      r.output?.includes('(+1 −1)') &&
        r.output?.includes('Changed region') &&
        r.output?.includes('4:   return a * b'),
      r.output
    )
    ok(
      'meta carries a unified diff with red/green lines',
      r.meta?.diff?.patch.includes('-  return a + b') &&
        r.meta?.diff?.patch.includes('+  return a * b') &&
        r.meta?.diff?.kind === 'edit',
      r.meta
    )
    ok(
      'meta counts match',
      r.meta?.diff?.additions === 1 && r.meta?.diff?.deletions === 1,
      r.meta?.diff
    )
    ok(
      'diff header uses the display path, not a double-slash absolute',
      r.meta?.diff?.patch.startsWith('--- a/src/a.ts'),
      r.meta?.diff?.patch.split('\n')[0]
    )
    ok(
      'the file changed on disk',
      fs.readFileSync(path.join(ROOT, 'src/a.ts'), 'utf8').includes('return a * b')
    )

    const lenient = await run('file_edit', {
      path: 'src/a.ts',
      old: 'return a * b',
      new: 'return a - b'
    })
    ok(
      'a trimmed old still matches (line-trimmed replacer)',
      lenient.success &&
        fs.readFileSync(path.join(ROOT, 'src/a.ts'), 'utf8').includes('  return a - b'),
      lenient
    )

    const missing = await run('file_edit', { path: 'src/a.ts', old: 'nothing like this', new: 'x' })
    ok(
      'not found is a clear non-retryable error',
      !missing.success &&
        missing.retryable === false &&
        missing.error?.includes('Could not find old'),
      missing.error
    )

    write('dup.ts', 'const x = 1\nconst x = 1\n')
    const dup = await run('file_edit', { path: 'dup.ts', old: 'const x = 1', new: 'const y = 1' })
    ok(
      'an ambiguous match is refused',
      !dup.success && dup.error?.includes('Found multiple matches'),
      dup.error
    )
    const all = await run('file_edit', {
      path: 'dup.ts',
      old: 'const x = 1',
      new: 'const y = 1',
      replaceAll: true
    })
    ok(
      'replaceAll changes every occurrence',
      all.success &&
        fs.readFileSync(path.join(ROOT, 'dup.ts'), 'utf8') === 'const y = 1\nconst y = 1\n' &&
        all.output?.includes('2 occurrences'),
      all
    )

    const same = await run('file_edit', { path: 'dup.ts', old: 'const y = 1', new: 'const y = 1' })
    ok(
      'identical old/new is refused',
      !same.success && same.error?.includes('identical'),
      same.error
    )

    const create = await run('file_edit', {
      path: 'src/new.ts',
      old: '',
      new: 'export const fresh = true\n'
    })
    ok(
      'empty old on a missing path creates the file',
      create.success &&
        fs.existsSync(path.join(ROOT, 'src/new.ts')) &&
        create.meta?.diff?.kind === 'create',
      create
    )
    const noCreate = await run('file_edit', { path: 'src/new.ts', old: '', new: 'x' })
    ok(
      'empty old on an existing file is refused',
      !noCreate.success && noCreate.error?.includes('cannot be empty'),
      noCreate.error
    )

    write('crlf.txt', 'one\r\ntwo\r\nthree\r\n')
    const crlf = await run('file_edit', { path: 'crlf.txt', old: 'two\nthree', new: 'TWO\nTHREE' })
    const crlfText = fs.readFileSync(path.join(ROOT, 'crlf.txt'), 'utf8')
    ok(
      'CRLF files keep their line endings after an LF-normalised edit',
      crlf.success && crlfText === 'one\r\nTWO\r\nTHREE\r\n',
      JSON.stringify(crlfText)
    )

    write('bom.txt', '﻿hello\nworld\n')
    const bom = await run('file_edit', { path: 'bom.txt', old: 'world', new: 'there' })
    const bomText = fs.readFileSync(path.join(ROOT, 'bom.txt'), 'utf8')
    ok(
      'a BOM survives the edit',
      bom.success && bomText.startsWith('﻿') && bomText.includes('there'),
      JSON.stringify(bomText)
    )

    const dirEdit = await run('file_edit', { path: 'src', old: 'a', new: 'b' })
    ok('editing a directory is refused', !dirEdit.success, dirEdit)
  }

  console.log('file_write + file_patch')
  {
    const create = await run('file_write', { path: 'gen/out.txt', content: 'a\nb\n' })
    ok(
      'write creates with a create diff',
      create.success &&
        create.meta?.diff?.kind === 'create' &&
        create.meta.diff.additions === 2 &&
        create.output?.includes('Created'),
      create
    )
    const over = await run('file_write', { path: 'gen/out.txt', content: 'a\nc\n' })
    ok(
      'overwrite reports the change',
      over.success &&
        over.meta?.diff?.kind === 'overwrite' &&
        over.meta.diff.additions === 1 &&
        over.meta.diff.deletions === 1 &&
        over.output?.includes('Overwrote'),
      over
    )
    const app = await run('file_write', { path: 'gen/out.txt', content: 'd\n', mode: 'append' })
    ok(
      'append reports bytes and a diff',
      app.success && app.output?.includes('Appended') && app.meta?.diff?.additions === 1,
      app
    )

    write('patch.txt', 'foo bar foo\nfoo\n')
    const patch = await run('file_patch', { path: 'patch.txt', find: 'foo', replace: 'baz' })
    ok(
      'file_patch replaces every occurrence through file_edit',
      patch.success &&
        fs.readFileSync(path.join(ROOT, 'patch.txt'), 'utf8') === 'baz bar baz\nbaz\n' &&
        !!patch.meta?.diff,
      patch
    )
  }

  console.log('file_grep + file_glob')
  {
    const g = await run('file_grep', { pattern: 'hello' })
    ok(
      'grep defaults to the working folder and groups by file',
      g.success &&
        g.output?.includes('Found ') &&
        g.output.includes(path.join(ROOT, 'src/a.ts') + ':') &&
        g.output.includes('Line 3:'),
      g.output
    )
    ok('grep honours .gitignore (dist/ excluded)', !g.output?.includes('dist/out.ts'), g.output)
    const inc = await run('file_grep', { pattern: 'hello', include: '*.md' })
    ok(
      'include narrows by file glob',
      inc.success && inc.output?.includes('notes.md') && !inc.output.includes('a.ts'),
      inc.output
    )
    const none = await run('file_grep', { pattern: 'zzz_never_here' })
    ok('no matches is a clean empty result', none.success && none.output === 'No files found', none)
    const bad = await run('file_grep', { pattern: '(' })
    ok(
      'an invalid regex is an error, not a crash',
      !bad.success && typeof bad.error === 'string',
      bad
    )
    const single = await run('file_grep', { pattern: 'const', path: 'src/b.ts' })
    ok(
      'a file path searches just that file',
      single.success && single.output?.includes('b.ts') && !single.output.includes('a.ts'),
      single.output
    )

    const files = await run('file_glob', { pattern: '**/*.ts' })
    ok(
      'glob returns absolute paths',
      files.success &&
        files.output?.includes(path.join(ROOT, 'src/a.ts')) &&
        files.output.includes(path.join(ROOT, 'src/b.ts')),
      files.output
    )
    ok('glob is gitignore-aware too', !files.output?.includes('dist/out.ts'), files.output)
    const globFile = await run('file_glob', { pattern: '*', path: 'src/a.ts' })
    ok(
      'glob on a file path is refused',
      !globFile.success && globFile.error?.includes('must be a directory'),
      globFile
    )
  }

  fs.rmSync(TMP, { recursive: true, force: true })
  console.log(`\n${passed} passed, ${failed} failed`)
  process.exit(failed ? 1 : 0)
}

void main()
