/**
 * After-edit diagnostics for the filesystem capability
 * (src/defaults/workspace/brain/cerebellum/filesystem/plugin/diagnostics.mjs):
 * the long-lived tsserver client (open → sync diagnostics, reload on re-check,
 * error-only mapping with 1-based line/col and a string code, the 20-error
 * cap), the eslint runner through the project's own bin, the applicability
 * gates (no tsconfig → null, unknown extension → null, no eslint config → no
 * eslint half), formatDiagnostics' block shape, and shutdownDiagnostics
 * leaving no child behind. ruff is exercised only when it is on PATH.
 *
 * Fixtures live in a temp dir and SYMLINK typescript / eslint from this repo's
 * node_modules so no install is needed.
 *
 * Standalone — no vitest/jest in this repo.
 * Run:
 *   TSX_TSCONFIG_PATH=tsconfig.node.json npx tsx src/main/runtime/__tests__/filesystem-diagnostics.test.ts
 */
import { execSync } from 'node:child_process'
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

type DiagError = { line: number; col: number; message: string; code?: string }
type DiagResult = { tool: string; errors: DiagError[]; truncated: boolean; total?: number } | null
type Diagnostics = {
  diagnoseFile: (file: string, rootHint?: string) => Promise<DiagResult>
  formatDiagnostics: (file: string, result: DiagResult) => string
  shutdownDiagnostics: () => Promise<void>
  MAX_ERRORS: number
}

const REPO = path.resolve(__dirname, '../../../..')
const PLUGIN = path.join(
  REPO,
  'src/defaults/workspace/brain/cerebellum/filesystem/plugin/diagnostics.mjs'
)

function write(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, content)
}

function linkDep(fixture: string, name: string): void {
  const target = path.join(REPO, 'node_modules', name)
  if (!fs.existsSync(target)) throw new Error(`repo is missing node_modules/${name}`)
  const link = path.join(fixture, 'node_modules', name)
  fs.mkdirSync(path.dirname(link), { recursive: true })
  fs.symlinkSync(target, link, 'dir')
}

function tsserverProcessesMentioning(needle: string): string[] {
  let ps = ''
  try {
    ps = execSync('ps -axo pid=,command=', { encoding: 'utf8' })
  } catch {
    return []
  }
  return ps.split('\n').filter((l) => l.includes('tsserver.js') && l.includes(needle))
}

async function main(): Promise<void> {
  const mod = (await import(pathToFileURL(PLUGIN).href)) as Diagnostics
  const { diagnoseFile, formatDiagnostics, shutdownDiagnostics, MAX_ERRORS } = mod

  // realpath: macOS tmp is a symlink, and the ps-needle assertions below
  // must match the spelling the plugin spawns tsserver with.
  const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wolffish-diag-')))
  const tsRoot = path.join(TMP, 'tsproj')
  const eslintRoot = path.join(TMP, 'lintproj')
  const bareRoot = path.join(TMP, 'bareproj')
  const src = path.join(tsRoot, 'src')

  // --- TypeScript fixture: tsconfig + package.json declaring typescript (and
  // eslint, but WITHOUT an eslint config, so only the tsserver half applies).
  write(
    path.join(tsRoot, 'package.json'),
    JSON.stringify({
      name: 'fixture-ts',
      private: true,
      devDependencies: { typescript: '*', eslint: '*' }
    })
  )
  write(
    path.join(tsRoot, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: {
        strict: true,
        noEmit: true,
        target: 'es2022',
        module: 'esnext',
        types: [],
        skipLibCheck: true
      },
      include: ['src/**/*']
    })
  )
  linkDep(tsRoot, 'typescript')
  linkDep(tsRoot, 'eslint')

  const cleanFile = path.join(src, 'clean.ts')
  const typeErrFile = path.join(src, 'type-error.ts')
  const syntaxFile = path.join(src, 'syntax.ts')
  const manyFile = path.join(src, 'many.ts')
  const txtFile = path.join(src, 'notes.txt')
  write(cleanFile, 'export const answer: number = 42\n')
  write(typeErrFile, 'export const x: number = "s"\n')
  write(syntaxFile, 'export const = ;\n')
  write(
    manyFile,
    Array.from({ length: MAX_ERRORS + 5 }, (_, i) => `export const a${i}: number = "s"`).join(
      '\n'
    ) + '\n'
  )
  write(txtFile, 'not code\n')

  console.log('tsserver: clean file (cold)')
  const t0 = Date.now()
  const clean = await diagnoseFile(cleanFile, tsRoot)
  const coldMs = Date.now() - t0
  ok('clean file → result (not null)', clean !== null, clean)
  ok('clean file → tool tsserver only (no eslint config)', clean?.tool === 'tsserver', clean?.tool)
  ok('clean file → zero errors', clean?.errors.length === 0, clean?.errors)
  ok('clean file → not truncated', clean?.truncated === false)
  ok('formatDiagnostics(clean) is empty string', formatDiagnostics(cleanFile, clean) === '')

  console.log('tsserver: clean file (warm)')
  const t1 = Date.now()
  const cleanAgain = await diagnoseFile(cleanFile, tsRoot)
  const warmMs = Date.now() - t1
  ok('warm re-check still clean', cleanAgain?.errors.length === 0, cleanAgain)
  console.log(`  timing: cold ${coldMs} ms, warm ${warmMs} ms`)
  ok('warm call is faster than cold', warmMs < coldMs, { coldMs, warmMs })
  ok(
    'exactly one tsserver spawned for the project',
    tsserverProcessesMentioning(tsRoot).length === 1
  )

  console.log('tsserver: type error')
  const typeErr = await diagnoseFile(typeErrFile, tsRoot)
  ok('type error → one error', typeErr?.errors.length === 1, typeErr)
  const e = typeErr?.errors[0]
  ok('type error → line 1', e?.line === 1, e)
  ok('type error → col 14 (1-based, at `x`)', e?.col === 14, e)
  ok(
    'type error → message mentions the types',
    /string.*number/i.test(e?.message ?? ''),
    e?.message
  )
  ok('type error → code is TS2322 as a string', e?.code === '2322', e?.code)
  ok('type error → tool tsserver', typeErr?.tool === 'tsserver')

  console.log('tsserver: edit that fixes it is seen on re-check (reload)')
  write(typeErrFile, 'export const x: number = 1\n')
  const fixed = await diagnoseFile(typeErrFile, tsRoot)
  ok('after fix → zero errors', fixed?.errors.length === 0, fixed)
  write(typeErrFile, 'export const x: number = "s"\nexport const y: string = 2\n')
  const broken = await diagnoseFile(typeErrFile, tsRoot)
  ok('after re-break → two errors', broken?.errors.length === 2, broken)
  ok('after re-break → second error on line 2', broken?.errors[1]?.line === 2, broken?.errors)

  console.log('tsserver: syntax error')
  const syntax = await diagnoseFile(syntaxFile, tsRoot)
  ok('syntax error → at least one error', (syntax?.errors.length ?? 0) >= 1, syntax)
  ok(
    'syntax error → 1-based positions',
    syntax?.errors.every((x) => x.line >= 1 && x.col >= 1)
  )
  ok(
    'syntax error → every error has a code',
    syntax?.errors.every((x) => typeof x.code === 'string')
  )

  console.log('tsserver: 20-error cap')
  const many = await diagnoseFile(manyFile, tsRoot)
  ok(`many → capped at ${MAX_ERRORS}`, many?.errors.length === MAX_ERRORS, many?.errors.length)
  ok('many → truncated', many?.truncated === true)
  ok('many → total is the uncapped count', many?.total === MAX_ERRORS + 5, many?.total)

  console.log('formatDiagnostics shape')
  const block = formatDiagnostics(manyFile, many)
  ok(
    'block starts with the two newlines + header',
    block.startsWith(`\n\nErrors detected in this file (tsserver), please fix:\n`)
  )
  ok('block opens <diagnostics file="...">', block.includes(`<diagnostics file="${manyFile}">\n`))
  ok(
    'block lines are ERROR [line:col] message',
    /\nERROR \[1:14\] Type 'string' is not assignable to type 'number'\.\n/.test(block),
    block.slice(0, 300)
  )
  ok(
    'block ends with "... and 5 more" then closing tag',
    block.endsWith('\n... and 5 more\n</diagnostics>'),
    block.slice(-60)
  )
  ok(
    `block carries ${MAX_ERRORS} ERROR lines`,
    (block.match(/\nERROR \[/g) ?? []).length === MAX_ERRORS
  )
  ok('formatDiagnostics(null) is empty', formatDiagnostics(cleanFile, null) === '')
  const single = formatDiagnostics(typeErrFile, {
    tool: 'tsserver',
    errors: [{ line: 3, col: 7, message: 'boom' }],
    truncated: false
  })
  ok(
    'single-error block exact',
    single ===
      `\n\nErrors detected in this file (tsserver), please fix:\n<diagnostics file="${typeErrFile}">\nERROR [3:7] boom\n</diagnostics>`,
    single
  )

  console.log('applicability gates')
  ok('.txt → null', (await diagnoseFile(txtFile, tsRoot)) === null)
  ok('missing file → null', (await diagnoseFile(path.join(src, 'nope.ts'), tsRoot)) === null)
  // typescript declared + linked, but no tsconfig anywhere → tsserver half
  // skipped; no eslint config either → nothing applies.
  write(
    path.join(bareRoot, 'package.json'),
    JSON.stringify({ name: 'bare', devDependencies: { typescript: '*' } })
  )
  linkDep(bareRoot, 'typescript')
  const bareFile = path.join(bareRoot, 'a.ts')
  write(bareFile, 'export const x: number = "s"\n')
  ok('no tsconfig → null', (await diagnoseFile(bareFile, bareRoot)) === null)
  // rootHint below the package.json: the walk stops before finding typescript.
  ok('rootHint that excludes package.json → null', (await diagnoseFile(cleanFile, src)) === null)

  console.log('eslint')
  write(
    path.join(eslintRoot, 'package.json'),
    JSON.stringify({ name: 'fixture-lint', private: true, devDependencies: { eslint: '*' } })
  )
  linkDep(eslintRoot, 'eslint')
  fs.mkdirSync(path.join(eslintRoot, 'node_modules', '.bin'), { recursive: true })
  fs.symlinkSync(
    path.join(REPO, 'node_modules', 'eslint', 'bin', 'eslint.js'),
    path.join(eslintRoot, 'node_modules', '.bin', 'eslint')
  )
  write(
    path.join(eslintRoot, 'eslint.config.mjs'),
    `export default [
  {
    files: ['**/*.js'],
    languageOptions: { ecmaVersion: 2022, sourceType: 'module', globals: {} },
    rules: { 'no-undef': 'error' }
  }
]
`
  )
  const lintBad = path.join(eslintRoot, 'bad.js')
  const lintGood = path.join(eslintRoot, 'good.js')
  write(lintBad, 'export const x = undefinedVar\n')
  write(lintGood, 'export const x = 1\n')
  const lint = await diagnoseFile(lintBad, eslintRoot)
  ok('eslint → tool eslint', lint?.tool === 'eslint', lint)
  ok('eslint → one error', lint?.errors.length === 1, lint?.errors)
  ok('eslint → no-undef code', lint?.errors[0]?.code === 'no-undef', lint?.errors[0])
  ok(
    'eslint → 1:18 position',
    lint?.errors[0]?.line === 1 && lint?.errors[0]?.col === 18,
    lint?.errors[0]
  )
  ok('eslint → mentions the identifier', /undefinedVar/.test(lint?.errors[0]?.message ?? ''))
  const lintOk = await diagnoseFile(lintGood, eslintRoot)
  ok('eslint clean → empty errors', lintOk?.tool === 'eslint' && lintOk.errors.length === 0, lintOk)
  ok(
    'eslint fixture never spawned a tsserver',
    tsserverProcessesMentioning(eslintRoot).length === 0
  )

  console.log('ruff')
  let ruffPath = ''
  try {
    ruffPath = execSync('which ruff', { encoding: 'utf8' }).trim()
  } catch {
    /* not installed */
  }
  if (!ruffPath) {
    console.log('  ruff not installed — skipped')
  } else {
    const pyRoot = path.join(TMP, 'pyproj')
    write(path.join(pyRoot, 'pyproject.toml'), '[project]\nname = "fixture"\n')
    const pyBad = path.join(pyRoot, 'bad.py')
    write(pyBad, 'import os\nprint(undefined_name)\n')
    const py = await diagnoseFile(pyBad, pyRoot)
    ok(
      'ruff → tool includes ruff',
      typeof py?.tool === 'string' && py.tool.split('+').includes('ruff'),
      py
    )
    ok(
      'ruff → F821 undefined name reported',
      py?.errors.some((x) => x.code === 'F821'),
      py?.errors
    )
    ok(
      'ruff → 1-based line/col',
      py?.errors.every((x) => x.line >= 1 && x.col >= 1)
    )
  }

  console.log('shutdown')
  ok('tsserver alive before shutdown', tsserverProcessesMentioning(tsRoot).length === 1)
  await shutdownDiagnostics()
  ok(
    'shutdownDiagnostics leaves no tsserver for the fixture',
    tsserverProcessesMentioning(tsRoot).length === 0
  )
  ok(
    'diagnoseFile after shutdown respawns and still works',
    (await diagnoseFile(cleanFile, tsRoot))?.errors.length === 0
  )
  await shutdownDiagnostics()
  ok('second shutdown is clean', tsserverProcessesMentioning(tsRoot).length === 0)

  fs.rmSync(TMP, { recursive: true, force: true })
  console.log(`\n${passed} passed, ${failed} failed`)
  process.exit(failed ? 1 : 0)
}

main().catch(async (err) => {
  console.error('test harness crashed:', err)
  // Never leave a fixture tsserver behind, even on a crash.
  try {
    const mod = (await import(pathToFileURL(PLUGIN).href)) as Diagnostics
    await mod.shutdownDiagnostics()
  } catch {
    /* best effort */
  }
  process.exit(1)
})
