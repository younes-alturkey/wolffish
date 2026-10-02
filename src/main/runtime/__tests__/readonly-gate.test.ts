/**
 * The read-only classification behind plan mode and explore agents:
 * Cerebellum.isReadOnlyTool / isReadOnlyCall over frontmatter flags and the
 * plugin's per-call hook, plus the shell plugin's own judgement.
 *
 * Run:
 *   TSX_TSCONFIG_PATH=tsconfig.node.json npx tsx src/main/runtime/__tests__/readonly-gate.test.ts
 */
import Module from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const loader = Module as unknown as { _load: (...a: unknown[]) => unknown }
const origLoad = loader._load
loader._load = function (this: unknown, ...args: unknown[]): unknown {
  if (args[0] === 'electron') {
    return {
      app: { isPackaged: false, getAppPath: () => process.cwd(), getPath: () => os.tmpdir() },
      net: { isOnline: () => true }
    }
  }
  return origLoad.apply(this, args)
}

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

async function main(): Promise<void> {
  const { Cerebellum } = await import('../cerebellum')
  const cerebellum = new Cerebellum({ workspaceRoot: os.tmpdir() })
  // loadAll registers the built-in in-process capabilities (tool-discovery, todo).
  await cerebellum.loadAll()
  cerebellum.registerInProcessCapability(
    {
      name: 'probe',
      dir: '',
      description: 'test',
      triggers: { keywords: [] },
      tools: [
        { name: 'probe_read', readOnly: true, description: 'r', parameters: {} },
        { name: 'probe_write', description: 'w', parameters: {} },
        { name: 'probe_judged', description: 'j', parameters: {} }
      ],
      body: '',
      hasPlugin: true,
      status: 'ok',
      requires: [],
      packages: {},
      npmDependencies: {}
    },
    {
      name: 'probe',
      tools: [],
      execute: async () => ({ success: true, output: '' }),
      isReadOnlyCall: (tool, args) => tool === 'probe_judged' && args.mode === 'look'
    }
  )

  console.log('cerebellum')
  ok('frontmatter readOnly flag → read-only', cerebellum.isReadOnlyTool('probe_read'))
  ok('no flag → mutating by default', !cerebellum.isReadOnlyTool('probe_write'))
  ok('unknown tool → mutating', !cerebellum.isReadOnlyTool('nope'))
  ok('flagged tool is read-only per call too', await cerebellum.isReadOnlyCall('probe_read', {}))
  ok(
    'the plugin hook judges per call: look',
    await cerebellum.isReadOnlyCall('probe_judged', { mode: 'look' })
  )
  ok(
    'the plugin hook judges per call: touch',
    !(await cerebellum.isReadOnlyCall('probe_judged', { mode: 'touch' }))
  )
  ok(
    'a tool without flag or hook verdict is mutating',
    !(await cerebellum.isReadOnlyCall('probe_write', {}))
  )
  ok(
    'the built-in todo tool is read-only (plan mode may keep its list)',
    cerebellum.isReadOnlyTool('todo_write')
  )
  ok('in-process tools are ready without a dependency pass', cerebellum.isToolReady('todo_write'))

  console.log('shell plugin hook')
  const shell = (
    await import(
      pathToFileURL(
        path.join(process.cwd(), 'src/defaults/workspace/brain/cerebellum/shell/plugin/index.mjs')
      ).href
    )
  ).default as { isReadOnlyCall: (t: string, a: Record<string, unknown>) => boolean }
  const ro = (command: string): boolean => shell.isReadOnlyCall('shell_exec', { command })
  ok('git status is read-only', ro('git status'))
  ok('git log/diff are read-only', ro('git log --oneline -5 && git diff'))
  ok('rg + cat are read-only', ro('rg -n foo src | head -20; cat package.json'))
  ok('git push is not', !ro('git push origin main'))
  ok('npm test IS allowed (a check reproduces the failure)', ro('npm test'))
  ok('npx tsc --noEmit and npm run lint are allowed', ro('npx tsc --noEmit') && ro('npm run lint'))
  ok('npm run build is not', !ro('npm run build'))
  ok('a check with a mutating redirect is not', !ro('npm test > out.txt'))
  ok('a check chained with a mutation is not', !ro('npm test && git push'))
  ok(
    'an inline node probe without writes is allowed',
    ro('node -e "console.log([...\'🌍\'].length)"')
  )
  ok(
    'node --input-type=module -e is allowed',
    ro('node --input-type=module -e \'import {x} from "./src/x.js"; console.log(x(1))\'')
  )
  ok('node -p is allowed', ro('node -p "1+1"'))
  ok('a python -c probe is allowed', ro('python3 -c "print(len(\'abc\'))"'))
  ok('an inline probe that writes is not', !ro("node -e \"require('fs').writeFileSync('x','1')\""))
  ok(
    'an inline probe that spawns is not',
    !ro("node -e \"require('child_process').execSync('rm -rf x')\"")
  )
  ok('running a script file is not a probe', !ro('node scripts/migrate.js'))
  // The write detector looks at how an API is reached, not at bare words: a
  // probe that defines or imports its own `truncate`/`rename` is still a probe.
  ok(
    'a probe that defines a function named like a write API is allowed',
    ro('node -e "function truncate(s,m){return s.slice(0,m)}; console.log(truncate(\'abc\',2))"')
  )
  ok('regex .exec() is not a spawn', ro("node -e \"console.log(/a/.exec('a'), 'rename')\""))
  ok(
    'a heredoc-fed interpreter is a probe when its body only reads',
    ro(
      "node --input-type=module <<'EOF'\nimport { slugify, truncate } from './src/index.js'\nconsole.log(slugify('x'))\nEOF"
    )
  )
  ok(
    'a heredoc-fed interpreter that writes is not',
    !ro(
      "node --input-type=module <<'EOF'\nimport { writeFile } from 'node:fs/promises'\nawait writeFile('a','b')\nEOF"
    )
  )
  ok(
    'a python heredoc that only prints is a probe',
    ro("python3 - <<EOF\nimport json\nprint(json.dumps({'a':1}))\nEOF")
  )
  ok('a here-string program is a probe', ro('node <<< "console.log(1)"'))
  ok('a heredoc with an output redirect is not', !ro('node <<EOF > out.txt\nconsole.log(1)\nEOF'))
  ok(
    'destructured fs writes are caught',
    !ro("node -e \"const {rm}=require('node:fs/promises'); await rm('x')\"")
  )
  ok(
    'bracket-looked-up fs writes are caught',
    !ro("node -e \"require('fs')['writeFileSync']('a','b')\"")
  )
  ok('python open() for reading is a probe', ro('python3 -c "print(open(\'x\').read())"'))
  ok('python open() for writing is not', !ro("python3 -c \"open('x','w').write('hi')\""))
  ok('python shutil is not', !ro('python3 -c "import shutil; shutil.rmtree(\'x\')"'))
  ok('a probe that fetches is not', !ro('node -e "fetch(\'https://x\')"'))
  ok('php free-function writes are caught', !ro('php -r "unlink(\'x\');"'))
  ok('a probe built from a substitution is not inspectable', !ro('node -e "$(cat evil.js)"'))
  ok('a redirect makes it mutating', !ro('ls > out.txt'))
  ok('a mutating segment in a chain taints it', !ro('ls && rm -rf dist'))
  ok('sudo is never read-only', !ro('sudo cat /etc/hosts'))
  ok(
    'background runs are never read-only',
    !shell.isReadOnlyCall('shell_exec', { command: 'ls', background: true })
  )
  ok('shell_jobs is read-only', shell.isReadOnlyCall('shell_jobs', {}))
  ok('shell_stop is not', !shell.isReadOnlyCall('shell_stop', { pid: 1 }))

  // Three ways a write used to reach a read-only turn through the
  // INVESTIGATION pass (checks a plan may run), all fixed in tokenize.mjs.
  ok('a bare redirect is not an investigation', !ro('> ~/.zshrc'))
  ok('a bare redirect after a read is not either', !ro('ls && > /tmp/wiped'))
  ok('eslint --fix is a write, not a check', !ro('eslint --fix .'))
  ok('so is it behind npx', !ro('npx eslint --fix src'))
  ok('ruff check --fix is a write', !ro('ruff check --fix .'))
  ok('cargo clippy --fix is a write', !ro('cargo clippy --fix'))
  ok('prettier --write is a write', !ro('prettier --write .'))
  ok('a lint:fix script is a write', !ro('npm run lint:fix'))
  ok('node -r runs a FILE, so it is not an inline probe', !ro('node -r ./script.js'))
  // …while the checks a plan actually needs still pass.
  ok('npm test is still an investigation', ro('npm test'))
  ok('a plain lint is still an investigation', ro('eslint .'))
  ok('npm run lint is still an investigation', ro('npm run lint'))
  ok('typecheck is still an investigation', ro('npm run typecheck'))
  ok('eslint --fix-dry-run writes nothing', ro('eslint --fix-dry-run .'))
  ok('php -r is still an inline probe', ro('php -r "echo 1;"'))
  // A test run that rewrites its snapshots is the same class as `eslint --fix`.
  ok('jest -u overwrites snapshots', !ro('npx jest -u'))
  ok('so does --updateSnapshot', !ro('npx jest --updateSnapshot'))
  ok('and vitest -u', !ro('npx vitest run -u'))
  ok('and pytest --snapshot-update', !ro('pytest --snapshot-update'))
  // …but the short flags that merely change HOW a check runs must not be
  // mistaken for it: -i is jest's --runInBand, -w is a watch flag.
  ok('jest -i is --runInBand, not in-place', ro('npx jest -i'))
  ok('jest -i keeps working with other flags', ro('npx jest --ci -i'))
  ok('npm test -- -i still runs', ro('npm test -- -i'))
  ok('go test -i still runs', ro('go test -i ./...'))
  ok('a fixtures script is not a fix script', ro('npm run test:fixtures'))

  console.log(`\n${passed} passed, ${failed} failed`)
  process.exit(failed ? 1 : 0)
}

void main()
