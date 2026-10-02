/**
 * Scoped danger patterns (amygdala.ts `DangerPattern.args`): a pattern that
 * names its arguments is tested against THOSE values only, so the filesystem
 * capability's path rules stop firing on code that merely contains a path.
 *
 * The bug this pins: patterns were matched against the whole serialized call,
 * so `\.\./` on a `file_edit` whose replacement text held `../lib/x` raised a
 * DESTRUCTIVE "Path traversal attempt" card over an ordinary relative import,
 * and `/usr/` did the same for a `#!/usr/bin/env` shebang. `file_edit` ships
 * multi-line code through those arguments, so this fired constantly.
 *
 * Run:
 *   TSX_TSCONFIG_PATH=tsconfig.node.json npx tsx src/main/runtime/__tests__/danger-pattern-scope.test.ts
 */
import { Amygdala, type DangerLevel } from '../amygdala'

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

function main(): void {
  const amygdala = new Amygdala({})
  // Exactly what src/defaults/.../filesystem/SKILL.md declares.
  amygdala.registerPatterns([
    { match: /\.\.\//i, level: 'destructive', reason: 'Path traversal attempt', args: ['path'] },
    {
      match: /\/etc\//i,
      level: 'confirm',
      reason: 'Modifying system configuration',
      args: ['path']
    },
    { match: /\/usr\//i, level: 'confirm', reason: 'Modifying system files', args: ['path'] }
  ])
  // …and an UNSCOPED pattern, the shape every command capability uses.
  amygdala.registerPatterns([
    { match: /rm\s+-rf/i, level: 'destructive', reason: 'Recursive delete' }
  ])

  const classify = (name: string, args: Record<string, unknown>): DangerLevel =>
    amygdala.classify({ id: 'c1', name, args })

  console.log('scoped patterns ignore everything but their arguments')
  ok(
    'a relative import in an edit is not a traversal',
    classify('file_edit', {
      path: '/repo/src/a.ts',
      old: "import x from '../lib/x'",
      new: "import x from '../lib/y'"
    }) === 'safe'
  )
  ok(
    'a shebang in written content is not a system write',
    classify('file_write', { path: '/repo/run.sh', content: '#!/usr/bin/env node\n' }) === 'safe'
  )
  ok(
    'an /etc/ path inside a code comment is not a system write',
    classify('file_edit', { path: '/repo/a.ts', old: 'a', new: '// see /etc/hosts' }) === 'safe'
  )

  console.log('…while the real thing still fires')
  ok(
    'a traversal in the path is destructive',
    classify('file_write', { path: '../../../etc/hosts', content: 'x' }) === 'destructive'
  )
  ok(
    'an /etc/ path confirms',
    classify('file_write', { path: '/etc/hosts', content: 'x' }) === 'confirm'
  )
  ok(
    'a /usr/ path confirms',
    classify('file_write', { path: '/usr/local/bin/x', content: 'x' }) === 'confirm'
  )
  ok(
    'a missing path argument simply does not fire',
    classify('file_grep', { pattern: '../lib' }) === 'safe'
  )

  console.log('unscoped patterns are untouched')
  ok(
    'a command pattern still matches the whole call',
    classify('shell_exec', { command: 'rm -rf /tmp/x' }) === 'destructive'
  )
  ok('a harmless command is still safe', classify('shell_exec', { command: 'ls -la' }) === 'safe')

  console.log(`\n${passed} passed, ${failed} failed`)
  process.exit(failed ? 1 : 0)
}

main()
