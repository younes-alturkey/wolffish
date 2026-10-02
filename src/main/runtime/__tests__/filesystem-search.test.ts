/**
 * Filesystem search module (ripgrep-backed grep/glob with a JS fallback)
 * against a real fixture tree: engine resolution, include filters,
 * .gitignore + node_modules exclusion, binary + long-line handling, the
 * 100-result limit and truncated flag, invalid-regex errors, byte-exact
 * OpenCode output formatting, glob `**` and brace patterns — and the same
 * suite run twice, once per engine, with a cross-engine equality check.
 *
 * Ripgrep engine: `resolveRipgrep()` is tried first (capability
 * node_modules, then `rg` on PATH via `which`). On this machine `rg` on the
 * interactive PATH is a shell FUNCTION (Claude Code's snapshot), invisible
 * to `which`, so when auto-resolution yields null the test falls back to a
 * real ripgrep binary shipped inside an installed editor and forces it via
 * `setRipgrepOverride`. If none is found the ripgrep half FAILS loudly
 * rather than silently skipping.
 *
 * Standalone — no vitest/jest in this repo.
 * Run: TSX_TSCONFIG_PATH=tsconfig.node.json npx tsx src/main/runtime/__tests__/filesystem-search.test.ts
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  formatGlob,
  formatGrep,
  glob,
  grep,
  matchGlob,
  resolveRipgrep,
  setRipgrepOverride
} from '../../../defaults/workspace/brain/cerebellum/filesystem/plugin/search.mjs'

let passed = 0
let failed = 0

function ok(label: string, cond: boolean, detail?: string): void {
  if (cond) {
    passed++
    return
  }
  failed++
  console.error(`FAIL ${label}${detail ? `\n     ${detail}` : ''}`)
}

type Match = { path: string; line: number; text: string }
type GrepResult = { matches: Match[]; truncated: boolean; engine: 'ripgrep' | 'js' }
type GlobResult = { files: string[]; truncated: boolean; engine: 'ripgrep' | 'js' }

const EDITOR_RG_CANDIDATES = [
  '/Applications/Visual Studio Code.app/Contents/Resources/app/node_modules/@vscode/ripgrep/bin/rg',
  '/Applications/Cursor.app/Contents/Resources/app/node_modules/@vscode/ripgrep/bin/rg',
  '/usr/local/bin/rg',
  '/opt/homebrew/bin/rg'
]

// ── Fixture ──────────────────────────────────────────────────────────────
function write(root: string, rel: string, content: string | Buffer): void {
  const abs = path.join(root, rel)
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, content)
}

const LONG_LINE = 'needle ' + 'x'.repeat(5000)
const BULK_LINES = 120

function buildFixture(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wolffish-search-'))
  // ripgrep only consults .gitignore inside a git repo; an empty .git dir is enough.
  fs.mkdirSync(path.join(root, '.git'))
  write(root, '.gitignore', '# build output\n\ndist/\nnode_modules/\n*.log\n')
  write(root, 'README.md', '# Fixture\nneedle in readme\n')
  write(root, 'src/index.ts', 'export const needle = 1\nconst other = 2\n')
  write(root, 'src/util/deep.ts', '// needle deep\nfunction needleFn() {}\nplain line\n')
  write(root, 'src/app.tsx', "const x = 'needle'\n")
  write(root, 'src/notes.md', 'needle md\n')
  write(root, 'crlf.txt', 'needle\r\nsecond\r\n')
  write(root, 'dist/out.ts', 'needle in dist\n')
  write(root, 'dist/notes.md', 'needle in dist md\n')
  write(root, 'node_modules/pkg/index.js', 'needle in node_modules\n')
  write(root, 'debug.log', 'needle in a log\n')
  write(root, '.hidden/secret.ts', 'needle hidden\n')
  write(
    root,
    'bin.dat',
    Buffer.concat([Buffer.from('needle '), Buffer.from([0, 1, 2, 0]), Buffer.from('tail')])
  )
  write(root, 'long.txt', `${LONG_LINE}\n`)
  write(
    root,
    'many.txt',
    Array.from({ length: BULK_LINES }, (_, i) => `bulk ${i + 1}`).join('\n') + '\n'
  )
  return root
}

const rel = (root: string, m: Match | string): string =>
  path
    .relative(root, typeof m === 'string' ? m : m.path)
    .split(path.sep)
    .join('/')

// ── Per-engine suite ─────────────────────────────────────────────────────
async function suite(
  engine: 'ripgrep' | 'js',
  root: string
): Promise<{ needle: GrepResult; ts: GlobResult; bulk: GrepResult; all: GlobResult }> {
  const tag = `[${engine}]`

  // grep: gitignore / node_modules / binary / hidden handling
  const needle = (await grep({ cwd: root, pattern: 'needle' })) as GrepResult
  ok(`${tag} engine reported`, needle.engine === engine, `got ${needle.engine}`)
  const needlePaths = new Set(needle.matches.map((m) => rel(root, m)))
  ok(`${tag} match in README.md`, needlePaths.has('README.md'))
  ok(`${tag} match in nested src/util/deep.ts`, needlePaths.has('src/util/deep.ts'))
  ok(`${tag} match in hidden file (--hidden)`, needlePaths.has('.hidden/secret.ts'))
  ok(
    `${tag} gitignored dist/ excluded`,
    !needlePaths.has('dist/out.ts'),
    [...needlePaths].join(',')
  )
  ok(`${tag} node_modules excluded`, !needlePaths.has('node_modules/pkg/index.js'))
  ok(`${tag} gitignored *.log excluded`, !needlePaths.has('debug.log'))
  ok(`${tag} binary file skipped`, !needlePaths.has('bin.dat'))
  ok(`${tag} .git contents never searched`, ![...needlePaths].some((p) => p.startsWith('.git/')))
  ok(`${tag} not truncated`, needle.truncated === false)
  ok(
    `${tag} paths are absolute`,
    needle.matches.every((m) => path.isAbsolute(m.path))
  )
  const deep = needle.matches.filter((m) => rel(root, m) === 'src/util/deep.ts')
  ok(
    `${tag} two matches in deep.ts with 1-based line numbers`,
    deep.length === 2 && deep[0].line === 1 && deep[1].line === 2,
    JSON.stringify(deep)
  )
  ok(
    `${tag} match text is the line (no trailing newline)`,
    deep[0]?.text === '// needle deep',
    JSON.stringify(deep[0]?.text)
  )
  const crlf = needle.matches.find((m) => rel(root, m) === 'crlf.txt')
  ok(`${tag} CRLF line trimmed`, crlf?.text === 'needle', JSON.stringify(crlf?.text))
  const long = needle.matches.find((m) => rel(root, m) === 'long.txt')
  ok(
    `${tag} long line capped at 2000 + "..."`,
    long !== undefined &&
      long.text.length === 2003 &&
      long.text.endsWith('...') &&
      long.text.startsWith('needle '),
    `len=${long?.text.length}`
  )
  ok(
    `${tag} results sorted by path then line`,
    needle.matches.every(
      (m, i) =>
        i === 0 ||
        needle.matches[i - 1].path < m.path ||
        (needle.matches[i - 1].path === m.path && needle.matches[i - 1].line < m.line)
    )
  )

  // include filters
  const tsOnly = (await grep({ cwd: root, pattern: 'needle', include: '*.ts' })) as GrepResult
  const tsPaths = new Set(tsOnly.matches.map((m) => rel(root, m)))
  ok(
    `${tag} include *.ts keeps only .ts`,
    [...tsPaths].every((p) => p.endsWith('.ts')) &&
      tsPaths.has('src/index.ts') &&
      tsPaths.has('.hidden/secret.ts'),
    [...tsPaths].join(',')
  )
  ok(`${tag} include *.ts excludes .tsx`, !tsPaths.has('src/app.tsx'))
  const brace = (await grep({ cwd: root, pattern: 'needle', include: '*.{ts,tsx}' })) as GrepResult
  const bracePaths = new Set(brace.matches.map((m) => rel(root, m)))
  ok(
    `${tag} include *.{ts,tsx} adds .tsx`,
    bracePaths.has('src/app.tsx') && bracePaths.has('src/index.ts') && !bracePaths.has('README.md')
  )
  const anchored = (await grep({
    cwd: root,
    pattern: 'needle',
    include: 'src/**/*.ts'
  })) as GrepResult
  const anchoredPaths = new Set(anchored.matches.map((m) => rel(root, m)))
  ok(
    `${tag} include src/**/*.ts is anchored`,
    anchoredPaths.has('src/index.ts') &&
      anchoredPaths.has('src/util/deep.ts') &&
      !anchoredPaths.has('.hidden/secret.ts'),
    [...anchoredPaths].join(',')
  )

  // limit + truncated
  const bulk = (await grep({ cwd: root, pattern: 'bulk' })) as GrepResult
  ok(`${tag} default limit 100`, bulk.matches.length === 100, `got ${bulk.matches.length}`)
  ok(`${tag} truncated flag set past the limit`, bulk.truncated === true)
  ok(
    `${tag} first 100 lines of many.txt`,
    bulk.matches[0].line === 1 && bulk.matches[99].line === 100
  )
  const five = (await grep({ cwd: root, pattern: 'bulk', limit: 5 })) as GrepResult
  ok(`${tag} custom limit honored`, five.matches.length === 5 && five.truncated === true)
  const exact = (await grep({ cwd: root, pattern: 'bulk', limit: BULK_LINES })) as GrepResult
  ok(
    `${tag} exactly-at-limit is NOT truncated`,
    exact.matches.length === BULK_LINES && exact.truncated === false
  )

  // no matches / invalid regex
  const none = (await grep({ cwd: root, pattern: 'zzz-no-such-thing' })) as GrepResult
  ok(
    `${tag} no matches → empty, not truncated`,
    none.matches.length === 0 && none.truncated === false
  )
  ok(
    `${tag} formatGrep empty → "No files found"`,
    formatGrep(none, { pattern: 'zzz' }) === 'No files found'
  )
  let regexErr: unknown = null
  try {
    await grep({ cwd: root, pattern: '(' })
  } catch (err) {
    regexErr = err
  }
  ok(
    `${tag} invalid regex throws "Invalid regex pattern:"`,
    regexErr instanceof Error && regexErr.message.startsWith('Invalid regex pattern:'),
    String((regexErr as Error)?.message)
  )

  // grep formatting — byte exact against the OpenCode layout
  const md = (await grep({ cwd: root, pattern: 'needle', include: '*.md' })) as GrepResult
  const expectedGrep = [
    'Found 2 matches',
    `${path.join(root, 'README.md')}:`,
    '  Line 2: needle in readme',
    '',
    `${path.join(root, 'src', 'notes.md')}:`,
    '  Line 1: needle md'
  ].join('\n')
  ok(
    `${tag} formatGrep byte-exact`,
    formatGrep(md, { pattern: 'needle' }) === expectedGrep,
    JSON.stringify(formatGrep(md, { pattern: 'needle' }))
  )
  const bulkOut = formatGrep(bulk, { pattern: 'bulk' })
  ok(
    `${tag} formatGrep truncated header`,
    bulkOut.startsWith('Found 100 matches (more matches available)\n')
  )
  ok(
    `${tag} formatGrep truncated footer`,
    bulkOut.endsWith(
      '\n  Line 100: bulk 100\n\n(Results truncated. Consider using a more specific path or pattern.)'
    )
  )

  // glob
  const ts = (await glob({ cwd: root, pattern: '**/*.ts' })) as GlobResult
  ok(`${tag} glob engine reported`, ts.engine === engine)
  const tsFiles = ts.files.map((f) => rel(root, f))
  ok(
    `${tag} glob **/*.ts`,
    JSON.stringify(tsFiles) ===
      JSON.stringify(['.hidden/secret.ts', 'src/index.ts', 'src/util/deep.ts']),
    tsFiles.join(',')
  )
  const braceGlob = (await glob({ cwd: root, pattern: '*.{md,tsx}' })) as GlobResult
  ok(
    `${tag} glob brace *.{md,tsx}`,
    JSON.stringify(braceGlob.files.map((f) => rel(root, f))) ===
      JSON.stringify(['README.md', 'src/app.tsx', 'src/notes.md']),
    braceGlob.files.map((f) => rel(root, f)).join(',')
  )
  const srcGlob = (await glob({ cwd: root, pattern: 'src/*.ts' })) as GlobResult
  ok(
    `${tag} glob src/*.ts anchored, one level`,
    JSON.stringify(srcGlob.files.map((f) => rel(root, f))) === JSON.stringify(['src/index.ts'])
  )
  // gitignore vs an explicit glob: ripgrep gives --glob precedence over ignore
  // files. A gitignored dir whose own path matches the glob is descended; one
  // that does not match is pruned even when files inside would match.
  const mdGlob = (await glob({ cwd: root, pattern: '*.md' })) as GlobResult
  ok(
    `${tag} glob *.md: gitignored dist/ pruned (dir does not match the glob)`,
    JSON.stringify(mdGlob.files.map((f) => rel(root, f))) ===
      JSON.stringify(['README.md', 'src/notes.md']),
    mdGlob.files.map((f) => rel(root, f)).join(',')
  )
  const all = (await glob({ cwd: root, pattern: '*' })) as GlobResult
  const allFiles = all.files.map((f) => rel(root, f))
  ok(
    `${tag} glob *: explicit glob whitelists gitignored paths (ripgrep precedence rule)`,
    allFiles.includes('dist/out.ts') && allFiles.includes('debug.log'),
    allFiles.join(',')
  )
  if (engine === 'js') {
    ok(
      `${tag} glob *: node_modules still pruned (JS-engine guard, deliberate divergence)`,
      !allFiles.some((f) => f.startsWith('node_modules/'))
    )
  } else {
    ok(
      `${tag} glob *: ripgrep lists node_modules once whitelisted (documented divergence)`,
      allFiles.includes('node_modules/pkg/index.js')
    )
  }
  ok(
    `${tag} glob * lists hidden + .gitignore itself`,
    allFiles.includes('.gitignore') && allFiles.includes('.hidden/secret.ts')
  )
  ok(`${tag} glob * never lists .git contents`, !allFiles.some((f) => f.startsWith('.git/')))
  ok(
    `${tag} glob paths absolute + not truncated`,
    all.files.every((f) => path.isAbsolute(f)) && all.truncated === false
  )
  const three = (await glob({ cwd: root, pattern: '*', limit: 3 })) as GlobResult
  ok(`${tag} glob limit + truncated`, three.files.length === 3 && three.truncated === true)
  ok(
    `${tag} formatGlob truncated byte-exact`,
    formatGlob(three) ===
      `${three.files.join('\n')}\n\n(Results are truncated: showing first 3 results. Consider using a more specific path or pattern.)`
  )
  ok(`${tag} formatGlob plain`, formatGlob(ts) === ts.files.join('\n'))
  const nothing = (await glob({ cwd: root, pattern: '*.nothing' })) as GlobResult
  ok(`${tag} glob no match`, nothing.files.length === 0 && formatGlob(nothing) === 'No files found')
  let globErr: unknown = null
  try {
    await glob({ cwd: root, pattern: '[' })
  } catch (err) {
    globErr = err
  }
  ok(
    `${tag} invalid glob throws "Invalid glob pattern:"`,
    globErr instanceof Error && globErr.message.startsWith('Invalid glob pattern:'),
    String((globErr as Error)?.message)
  )

  return { needle, ts, bulk, all }
}

// ── matchGlob unit cases (engine independent) ────────────────────────────
function matchGlobCases(): void {
  const cases: Array<[string, string, boolean]> = [
    ['a/b/c.ts', '*.ts', true],
    ['c.ts', '*.ts', true],
    ['a/b/c.tsx', '*.ts', false],
    ['a/b/c.ts', '**/*.ts', true],
    ['c.ts', '**/*.ts', true],
    ['src/x.ts', 'src/*.ts', true],
    ['src/a/x.ts', 'src/*.ts', false],
    ['lib/src/x.ts', 'src/*.ts', false],
    ['src/a/b/x.ts', 'src/**/*.ts', true],
    ['src/x.ts', 'src/**/*.ts', true],
    ['src/a/b', 'src/**', true],
    ['src', 'src/**', false],
    ['a.tsx', '*.{ts,tsx}', true],
    ['a.md', '*.{ts,tsx}', false],
    ['x.ts', '[a-x].ts', true],
    ['y.ts', '[a-x].ts', false],
    ['y.ts', '[!a-x].ts', true],
    ['ab.ts', '?b.ts', true],
    ['a/b.ts', '?/b.ts', true],
    ['ab/b.ts', '?/b.ts', false],
    ['a.ts', '/a.ts', true],
    ['d/a.ts', '/a.ts', false],
    ['x\\y\\z.ts', 'y/*.ts', false],
    ['x/y/z.ts', '**/y/*.ts', true],
    ['weird*.ts', 'weird\\*.ts', true],
    ['weirdX.ts', 'weird\\*.ts', false]
  ]
  for (const [p, g, expected] of cases) {
    ok(
      `matchGlob(${JSON.stringify(p)}, ${JSON.stringify(g)}) === ${expected}`,
      matchGlob(p, g) === expected
    )
  }
  let err: unknown = null
  try {
    matchGlob('a', '{a,b')
  } catch (e) {
    err = e
  }
  ok(
    'matchGlob unclosed brace throws',
    err instanceof Error && err.message.startsWith('Invalid glob pattern:')
  )
}

// ── Harness ──────────────────────────────────────────────────────────────
async function run(): Promise<void> {
  const root = buildFixture()
  try {
    matchGlobCases()

    // ripgrep resolution
    const t0 = Date.now()
    const auto = await resolveRipgrep()
    const t1 = Date.now()
    ok(
      'resolveRipgrep is cached (second call instant)',
      (await resolveRipgrep()) === auto && Date.now() - t1 < 50
    )
    ok('resolveRipgrep is absolute or null', auto === null || path.isAbsolute(auto), String(auto))
    console.log(`resolveRipgrep(): ${auto ?? 'null'} (${t1 - t0}ms)`)

    let rgPath = auto
    if (!rgPath) {
      rgPath =
        EDITOR_RG_CANDIDATES.find((p) => {
          try {
            return fs.statSync(p).isFile()
          } catch {
            return false
          }
        }) ?? null
      if (rgPath) {
        console.log(`no rg on PATH — forcing editor-bundled binary: ${rgPath}`)
        setRipgrepOverride(rgPath)
      }
    }
    ok(
      'a real ripgrep binary is available for the ripgrep-engine run',
      rgPath !== null && fs.statSync(rgPath).isFile()
    )
    ok('resolveRipgrep honors the override', (await resolveRipgrep()) === rgPath)

    let rg: Awaited<ReturnType<typeof suite>> | null = null
    if (rgPath) rg = await suite('ripgrep', root)

    // JS engine, forced via the env var the module honors (override cleared first).
    setRipgrepOverride(undefined)
    process.env.WOLFFISH_FORCE_JS_SEARCH = '1'
    ok('WOLFFISH_FORCE_JS_SEARCH=1 → resolveRipgrep null', (await resolveRipgrep()) === null)
    const js = await suite('js', root)

    // …and via the programmatic override, which must beat the env var.
    delete process.env.WOLFFISH_FORCE_JS_SEARCH
    setRipgrepOverride(null)
    ok('setRipgrepOverride(null) → resolveRipgrep null', (await resolveRipgrep()) === null)
    ok(
      'override(null) runs the js engine',
      ((await grep({ cwd: root, pattern: 'needle', include: '*.md' })) as GrepResult).engine ===
        'js'
    )

    // cross-engine equality
    if (rg) {
      ok(
        'engines agree on grep needle',
        JSON.stringify(rg.needle) === JSON.stringify({ ...js.needle, engine: 'ripgrep' }),
        diffSummary(rg.needle.matches, js.needle.matches, root)
      )
      ok(
        'engines agree on glob **/*.ts',
        JSON.stringify(rg.ts.files) === JSON.stringify(js.ts.files)
      )
      ok(
        'engines agree on truncated bulk grep',
        JSON.stringify(rg.bulk.matches) === JSON.stringify(js.bulk.matches) &&
          rg.bulk.truncated === js.bulk.truncated
      )
      const rgAllSansNodeModules = rg.all.files.filter(
        (f) => !rel(root, f).startsWith('node_modules/')
      )
      ok(
        'engines agree on glob * (modulo the JS node_modules guard)',
        JSON.stringify(rgAllSansNodeModules) === JSON.stringify(js.all.files),
        `rg=${rgAllSansNodeModules.map((f) => rel(root, f)).join(',')} js=${js.all.files.map((f) => rel(root, f)).join(',')}`
      )
    }
  } finally {
    setRipgrepOverride(undefined)
    fs.rmSync(root, { recursive: true, force: true })
  }

  console.log(`${passed} passed, ${failed} failed`)
  if (failed > 0) process.exit(1)
}

function diffSummary(a: Match[], b: Match[], root: string): string {
  const key = (m: Match): string => `${rel(root, m)}:${m.line}:${m.text.slice(0, 40)}`
  const as = new Set(a.map(key))
  const bs = new Set(b.map(key))
  const onlyA = [...as].filter((k) => !bs.has(k))
  const onlyB = [...bs].filter((k) => !as.has(k))
  return `only ripgrep: [${onlyA.join(' | ')}] only js: [${onlyB.join(' | ')}]`
}

void run().catch((err) => {
  console.error('test harness crashed:', err)
  process.exit(1)
})
