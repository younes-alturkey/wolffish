/**
 * Tests for the shell capability's tokenizer/classifier
 * (src/defaults/workspace/brain/cerebellum/shell/plugin/tokenize.mjs):
 * splitCommands quoting/substitution/group/prefix/redirect handling,
 * arityPrefix parity with OpenCode's permission/arity.ts, the read-only
 * gate, describeCommand labels + risk, and looksLikeWatcher.
 *
 * Standalone — no vitest/jest in this repo.
 * Run: TSX_TSCONFIG_PATH=tsconfig.node.json npx tsx src/main/runtime/__tests__/shell-tokenize.test.ts
 */
import path from 'node:path'
import { pathToFileURL } from 'node:url'

let passed = 0
let failed = 0

function ok(label: string, cond: boolean): void {
  if (cond) {
    passed++
  } else {
    failed++
    console.error(`FAIL ${label}`)
  }
}

function eq<T>(label: string, actual: T, expected: T): void {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a === e) {
    passed++
  } else {
    failed++
    console.error(`FAIL ${label}\n  expected ${e}\n  actual   ${a}`)
  }
}

type Redirect = { op: string; target: string; body?: string }
type Simple = {
  raw: string
  words: string[]
  tokens: string[]
  head: string
  args: string[]
  env: string[]
  elevated: boolean
  redirects: Redirect[]
  mutatingRedirect: boolean
  background: boolean
  fromSubstitution: boolean
}
type Shell = 'sh' | 'powershell' | 'cmd'
type Mod = {
  splitCommands: (command: string, opts?: { shell?: Shell }) => Simple[]
  arityPrefix: (tokens: string[]) => string
  isReadOnlyCommand: (cmd: Simple | string) => boolean
  isReadOnly: (command: string, opts?: { shell?: Shell }) => boolean
  describeCommand: (command: string) => {
    label: string
    risk: 'low' | 'medium' | 'high'
    impact?: string
    heads: string[]
  }
  looksLikeWatcher: (command: string) => boolean
}

async function run(): Promise<void> {
  const modPath = path.resolve(
    process.cwd(),
    'src/defaults/workspace/brain/cerebellum/shell/plugin/tokenize.mjs'
  )
  const m = (await import(pathToFileURL(modPath).href)) as Mod
  const {
    splitCommands,
    arityPrefix,
    isReadOnlyCommand,
    isReadOnly,
    describeCommand,
    looksLikeWatcher
  } = m
  const heads = (c: string, shell?: Shell): string[] =>
    splitCommands(c, shell ? { shell } : undefined).map((x) => x.head)

  // ── splitCommands: quoting ───────────────────────────────────────────
  eq(
    'double quotes hide &&',
    splitCommands('echo "a && b"').map((c) => c.tokens),
    [['echo', 'a && b']]
  )
  eq(
    'single quotes hide ;',
    splitCommands("rm 'x;y'").map((c) => c.tokens),
    [['rm', 'x;y']]
  )
  eq(
    'backslash escape outside quotes',
    splitCommands('echo a\\ b').map((c) => c.tokens),
    [['echo', 'a b']]
  )
  eq(
    'backslash-escaped quote inside double quotes',
    splitCommands('echo "say \\"hi\\""').map((c) => c.tokens),
    [['echo', 'say "hi"']]
  )
  eq(
    'adjacent quoted + bare fragments form one word',
    splitCommands('echo \'a\'b"c"').map((c) => c.tokens),
    [['echo', 'abc']]
  )
  eq(
    'empty quotes yield an empty word',
    splitCommands("echo ''").map((c) => c.tokens),
    [['echo', '']]
  )
  eq('quoted pipe is not a separator', splitCommands('grep "a|b" f').length, 1)

  // ── splitCommands: separators ────────────────────────────────────────
  eq('&& || ; | split', heads('a && b || c; d | e'), ['a', 'b', 'c', 'd', 'e'])
  eq('newline splits', heads('ls\nrm x'), ['ls', 'rm'])
  eq('|& splits', heads('a |& b'), ['a', 'b'])
  const bg = splitCommands('npm run dev & echo done')
  eq(
    '& backgrounds and splits',
    bg.map((c) => c.head),
    ['npm', 'echo']
  )
  ok(
    'background flag recorded on the backgrounded command',
    bg[0].background === true && bg[1].background === false
  )
  eq('comment is dropped', heads('ls # rm -rf /'), ['ls'])
  eq(
    'raw preserves the simple command text',
    splitCommands('cd x && npm test').map((c) => c.raw),
    ['cd x', 'npm test']
  )

  // ── splitCommands: substitutions ─────────────────────────────────────
  const sub = splitCommands('echo $(rm -rf x)')
  eq('$() kept as one opaque outer token', sub[0].tokens, ['echo', '$(rm -rf x)'])
  eq('$() contents appended as inner command', sub[1].tokens, ['rm', '-rf', 'x'])
  ok(
    'inner command flagged fromSubstitution',
    sub[1].fromSubstitution === true && sub[0].fromSubstitution === false
  )
  eq('backtick substitution recursed', heads('echo `ls -la`'), ['echo', 'ls'])
  eq('$() inside double quotes recursed', heads('echo "$(rm x)"'), ['echo', 'rm'])
  eq('nested $() recursed to depth', heads('echo $(cat $(ls))'), ['echo', 'cat', 'ls'])
  eq('$(( )) arithmetic is not recursed', heads('echo $((1+2))'), ['echo'])
  eq('process substitution recursed', heads('diff <(ls a) <(ls b)'), ['diff', 'ls', 'ls'])

  // ── splitCommands: groups ────────────────────────────────────────────
  eq('{ ...; } group stripped and split', heads('{ ls; rm x; }'), ['ls', 'rm'])
  eq('( ... ) subshell stripped and split', heads('(cd y && make) && echo ok'), [
    'cd',
    'make',
    'echo'
  ])
  eq(
    'quoted braces stay words',
    splitCommands("echo '{'").map((c) => c.tokens),
    [['echo', '{']]
  )

  // ── splitCommands: prefixes ──────────────────────────────────────────
  const envCmd = splitCommands('FOO=bar BAZ=1 cmd --x')[0]
  eq('env assignments stripped to head', envCmd.head, 'cmd')
  eq('env assignments recorded', envCmd.env, ['FOO=bar', 'BAZ=1'])
  const sudoCmd = splitCommands('sudo -u root rm -rf /')[0]
  eq('sudo (with -u arg) stripped to head', sudoCmd.tokens, ['rm', '-rf', '/'])
  ok('sudo marks elevated', sudoCmd.elevated === true)
  ok('doas marks elevated', splitCommands('doas rm x')[0].elevated === true)
  ok('plain command is not elevated', splitCommands('rm x')[0].elevated === false)
  eq('env wrapper with assignments stripped', splitCommands('env FOO=1 ls -la')[0].tokens, [
    'ls',
    '-la'
  ])
  eq('bare env keeps env as head', splitCommands('env')[0].head, 'env')
  eq(
    'nohup/time/nice chain stripped',
    splitCommands('nohup time nice -n 5 node app.js')[0].head,
    'node'
  )
  eq('xargs strips to the command it runs', heads('find . | xargs rm'), ['find', 'rm'])
  eq('xargs -I {} strips flag and its arg', splitCommands('xargs -I {} cp {} /tmp')[0].head, 'cp')
  eq('bare xargs keeps xargs as head', splitCommands('xargs')[0].head, 'xargs')
  eq('sudo alone keeps sudo as head', splitCommands('sudo')[0].head, 'sudo')
  eq('words keep the full unstripped list', sudoCmd.words, ['sudo', '-u', 'root', 'rm', '-rf', '/'])

  // ── splitCommands: redirects ─────────────────────────────────────────
  const redir = splitCommands('ls > out.txt 2>&1')[0]
  eq('redirects removed from tokens', redir.tokens, ['ls'])
  eq('redirects recorded', redir.redirects, [
    { op: '>', target: 'out.txt' },
    { op: '2>&', target: '1' }
  ])
  ok('> makes mutatingRedirect true', redir.mutatingRedirect === true)
  ok('>> makes mutatingRedirect true', splitCommands('echo a >> f')[0].mutatingRedirect === true)
  ok('2>&1 alone is not mutating', splitCommands('ls 2>&1')[0].mutatingRedirect === false)
  ok('> /dev/null is not mutating', splitCommands('ls >/dev/null')[0].mutatingRedirect === false)
  ok('< input redirect is not mutating', splitCommands('wc -l < f')[0].mutatingRedirect === false)
  eq('attached >file target parsed', splitCommands('cmd >file')[0].redirects, [
    { op: '>', target: 'file' }
  ])
  eq('&> parsed', splitCommands('cmd &>log')[0].redirects, [{ op: '&>', target: 'log' }])
  eq('heredoc body is not split into commands', heads('cat <<EOF\nrm -rf /\nEOF\necho hi'), [
    'cat',
    'echo'
  ])
  eq('quoted > is a word, not a redirect', splitCommands("awk '$1 > 5' f")[0].redirects, [])
  eq(
    'heredoc body rides its redirect entry',
    splitCommands("node <<'EOF'\nconsole.log(1)\nconsole.log(2)\nEOF\necho hi")[0].redirects,
    [{ op: '<<', target: 'EOF', body: 'console.log(1)\nconsole.log(2)' }]
  )
  eq(
    'heredoc body attaches to the fed command, not the pipe tail',
    splitCommands('node <<-EOF | tail -1\n\tconsole.log(1)\n\tEOF').map((c) => [
      c.head,
      c.redirects
    ]),
    [
      ['node', [{ op: '<<-', target: 'EOF', body: 'console.log(1)' }]],
      ['tail', []]
    ]
  )

  // ── splitCommands: powershell + cmd ──────────────────────────────────
  eq(
    'powershell splits ; and | and lower-cases heads',
    heads('Get-Content x | Where-Object { $_ -match "a" }; Remove-Item y', 'powershell').slice(
      0,
      3
    ),
    ['get-content', 'where-object', 'remove-item']
  )
  eq('powershell && splits', heads('Get-ChildItem && Write-Host ok', 'powershell'), [
    'get-childitem',
    'write-host'
  ])
  eq(
    'powershell & call operator stripped',
    splitCommands('& "C:\\tools\\x.exe" -a', { shell: 'powershell' })[0].head,
    'c:\\tools\\x.exe'
  )
  eq('cmd splits & && || |', heads('dir & del x && type y || echo z | more', 'cmd'), [
    'dir',
    'del',
    'type',
    'echo',
    'more'
  ])
  eq('cmd quoted & is a word', splitCommands('echo "a & b"', { shell: 'cmd' }).length, 1)

  // ── arityPrefix (OpenCode parity) ───────────────────────────────────
  eq('git commit -m x → git commit *', arityPrefix(['git', 'commit', '-m', 'x']), 'git commit *')
  eq('cat foo → cat *', arityPrefix(['cat', 'foo']), 'cat *')
  eq('rm -rf x → rm *', arityPrefix(['rm', '-rf', 'x']), 'rm *')
  // OpenCode's table has "npm run": 3 and "docker compose": 3 — the script /
  // subcommand token is part of the prefix (its generating prompt says
  // `npm run dev → npm run dev`). A faithful port keeps that.
  eq(
    'npm run build → npm run build * (arity 3)',
    arityPrefix(['npm', 'run', 'build']),
    'npm run build *'
  )
  eq(
    'docker compose up → docker compose up * (arity 3)',
    arityPrefix(['docker', 'compose', 'up']),
    'docker compose up *'
  )
  eq('npm install → npm install *', arityPrefix(['npm', 'install', 'react']), 'npm install *')
  eq('git stash pop → git stash pop *', arityPrefix(['git', 'stash', 'pop']), 'git stash pop *')
  eq('unknown head defaults to arity 1', arityPrefix(['python3', 'script.py', '--x']), 'python3 *')
  eq('gh pr list → gh pr list *', arityPrefix(['gh', 'pr', 'list', '--limit', '5']), 'gh pr list *')
  eq('short token list under arity keeps what it has', arityPrefix(['git']), 'git *')
  eq('empty tokens → empty string', arityPrefix([]), '')
  eq(
    'arity from split tokens ignores stripped sudo',
    arityPrefix(splitCommands('sudo rm -rf /')[0].tokens),
    'rm *'
  )

  // ── read-only classification ─────────────────────────────────────────
  const ro = (c: string): boolean => isReadOnly(c)
  for (const c of [
    'ls -la',
    'pwd',
    'cat package.json',
    'head -n 20 f',
    'wc -l f',
    'echo hi',
    'printf "%s" x',
    'true',
    'test -f x',
    '[ -d x ]',
    'stat f',
    'du -sh .',
    'find . -name "*.ts"',
    'grep -rn foo src',
    'rg foo',
    "awk '{print $1}' f",
    "sed -n '1,5p' f",
    'sort f | uniq -c',
    'diff a b',
    'which node',
    'env',
    'date',
    'date +%Y',
    'whoami',
    'uname -a',
    'ps aux',
    'git status',
    'git log --oneline -5',
    'git diff HEAD~1',
    'git -C repo status',
    'git --no-pager log',
    'git branch',
    'git branch -a',
    'git branch --list "feat/*"',
    'git remote -v',
    'git stash list',
    'git tag',
    'git tag -l',
    'git config --get user.name',
    'git config --list',
    'git worktree list',
    'git rev-parse HEAD',
    'node -v',
    'node --version',
    'npm ls',
    'npm view react version',
    'npm outdated',
    'npx --version',
    'python3 --version',
    'pip list',
    'pip freeze',
    'cargo --version',
    'cargo metadata',
    'go version',
    'tsc --version',
    'jq .name package.json',
    'cat f | jq .',
    'xxd f',
    'basename /a/b',
    'realpath .',
    'tree src',
    'shasum -a 256 f',
    'sleep 1',
    'ls 2>&1',
    'ls > /dev/null',
    'ls && pwd',
    'cat a | grep b | wc -l',
    'echo $(git rev-parse HEAD)',
    '{ ls; pwd; }',
    'FOO=1 ls',
    'top -l 1'
  ]) {
    ok(`read-only: ${c}`, ro(c) === true)
  }
  for (const c of [
    "sed -i 's/a/b/' f",
    "sed -ni 's/a/b/' f",
    'find . -delete',
    'find . -exec rm {} \\;',
    'git branch -D foo',
    'git branch -d foo',
    'git branch -m old new',
    'git branch newbranch',
    'git remote add origin url',
    'git stash pop',
    'git tag v1.0',
    'git config user.name x',
    'git config --unset user.name',
    'git worktree add ../x',
    'git checkout main',
    'git push',
    'echo hi > f',
    'echo hi >> f',
    'cat a | tee b',
    'ls && rm x',
    'ls; rm x',
    'echo $(rm -rf x)',
    'echo `rm x`',
    'sudo ls',
    'sudo cat /etc/shadow',
    'rm x',
    'mv a b',
    'touch f',
    'mkdir d',
    'curl https://example.com',
    'wget https://example.com',
    'node -e "process.exit()"',
    'node script.js',
    'npm install',
    'npm run build',
    'npm version patch',
    'pip install x',
    'cargo build',
    'go build',
    'tsc -b',
    'python3 script.py',
    'sort -o out f',
    'uniq in out',
    'xxd in out',
    'yq -i ".a=1" f',
    'tree -o out.txt',
    'date 0101',
    'hostname newname',
    'env FOO=1',
    'awk \'{system("rm x")}\' f',
    'awk \'{print > "out"}\' f',
    'top',
    'bash -c "ls"',
    'eval ls',
    'xargs rm',
    'find . | xargs rm',
    'unknowncmd',
    ''
  ]) {
    ok(`mutating: ${JSON.stringify(c)}`, ro(c) === false)
  }
  ok(
    'isReadOnlyCommand accepts a split object',
    isReadOnlyCommand(splitCommands('ls -la')[0]) === true
  )
  ok(
    'isReadOnlyCommand accepts a string with one simple command',
    isReadOnlyCommand('git status') === true
  )
  ok(
    'isReadOnlyCommand rejects a string with several commands',
    isReadOnlyCommand('ls && pwd') === false
  )
  ok(
    'isReadOnlyCommand: elevated object is not read-only',
    isReadOnlyCommand(splitCommands('sudo ls')[0]) === false
  )
  ok(
    'isReadOnlyCommand: mutating redirect object is not read-only',
    isReadOnlyCommand(splitCommands('ls > f')[0]) === false
  )

  // ── describeCommand ──────────────────────────────────────────────────
  const label = (c: string): string => describeCommand(c).label
  // existing verb map (superset check)
  eq('ls label', label('ls -la'), 'List files')
  eq('pwd label', label('pwd'), 'Print working directory')
  eq('cat label', label('cat f'), 'Print file contents')
  eq('open label', label('open .'), 'Open file')
  eq('cd label', label('cd x'), 'Change directory')
  eq('cp label', label('cp a b'), 'Copy files')
  eq('mv label', label('mv a b'), 'Move/rename files')
  eq('rm -rf label', label('rm -rf x'), 'Delete directory recursively')
  eq('rm -fr label (flag order)', label('rm -fr x'), 'Delete directory recursively')
  eq('rm label', label('rm x'), 'Delete files')
  eq('mkdir label', label('mkdir d'), 'Create directory')
  eq('grep label', label('grep foo f'), 'Search code')
  eq('rg label', label('rg foo'), 'Search code')
  eq('find label', label('find . -name x'), 'Find files')
  eq('git status label', label('git status'), 'Check git status')
  eq('git diff label', label('git diff'), 'Show git diff')
  eq('git log label', label('git log'), 'Show git log')
  eq('git push label', label('git push origin main'), 'Push commits to remote')
  eq('git pull label', label('git pull'), 'Pull from remote')
  eq('git commit label', label('git commit -m x'), 'Create git commit')
  eq('npm install label', label('npm install'), 'Install npm dependencies')
  eq('npm run (other) label', label('npm run release'), 'Run npm script')
  eq('pip install label', label('pip install x'), 'Install Python packages')
  eq('docker label', label('docker ps'), 'Run Docker command')
  eq('brew install label', label('brew install node'), 'Install with Homebrew')
  eq('curl label', label('curl https://x'), 'Make HTTP request')
  eq('unknown label', label('somethingelse --x'), 'Run shell command')
  // new families
  for (const c of [
    'npm test',
    'npm t',
    'npm run test',
    'npm run test:unit',
    'pnpm test',
    'yarn test',
    'bun test',
    'vitest run',
    'npx vitest run',
    'jest',
    'mocha',
    'pytest -q',
    'python -m pytest',
    'cargo test',
    'go test ./...',
    'swift test',
    'xcodebuild test -scheme X',
    'dotnet test'
  ]) {
    eq(`Run tests: ${c}`, label(c), 'Run tests')
  }
  for (const c of [
    'tsc',
    'tsc --noEmit',
    'npx tsc --noEmit',
    'npm run typecheck',
    'npm run typecheck:node',
    'mypy .',
    'pyright'
  ]) {
    eq(`Type-check: ${c}`, label(c), 'Type-check')
  }
  for (const c of [
    'eslint .',
    'npm run lint',
    'npm run lint:fix',
    'ruff check .',
    'flake8',
    'cargo clippy',
    'golangci-lint run'
  ]) {
    eq(`Lint: ${c}`, label(c), 'Lint')
  }
  for (const c of [
    'prettier --write .',
    'ruff format .',
    'black .',
    'gofmt -w .',
    'rustfmt x.rs',
    'npm run format'
  ]) {
    eq(`Format: ${c}`, label(c), 'Format')
  }
  for (const c of [
    'npm run build',
    'npm run build:web',
    'tsc -b',
    'cargo build --release',
    'go build ./...',
    'make',
    'xcodebuild -scheme X',
    'swift build',
    'dotnet build',
    'gradle assemble',
    'mvn package'
  ]) {
    eq(`Build: ${c}`, label(c), 'Build')
  }
  for (const c of [
    'npm run dev',
    'npm start',
    'npm run start',
    'vite',
    'next dev',
    'nodemon app.js',
    'uvicorn app:app',
    'flask run',
    'rails s'
  ]) {
    eq(`Start dev server: ${c}`, label(c), 'Start dev server')
  }
  for (const c of [
    'pnpm install',
    'yarn add react',
    'bun add x',
    'bun install',
    'cargo add tokio',
    'go get x',
    'apt install x'
  ]) {
    eq(`Install dependencies: ${c}`, label(c), 'Install dependencies')
  }
  eq('npm ci keeps the npm label', label('npm ci'), 'Install npm dependencies')
  eq('chained: cd + test picks the significant command', label('cd app && npm test'), 'Run tests')
  eq(
    'chained: build then dev prefers neither over rm -rf',
    label('npm run build && rm -rf dist'),
    'Delete directory recursively'
  )
  eq('heads lists every simple command', describeCommand('cd x && npm test').heads, ['cd', 'npm'])

  // risk + impact (semantics identical to describeShellAction)
  const rmrf = describeCommand('rm -rf node_modules')
  eq('rm -rf risk high', rmrf.risk, 'high')
  eq('rm -rf impact', rmrf.impact, 'Permanently deletes files. This cannot be undone.')
  eq('rm x risk medium', describeCommand('rm x').risk, 'medium')
  eq('npm install risk medium', describeCommand('npm install').risk, 'medium')
  eq('git push risk medium', describeCommand('git push').risk, 'medium')
  eq('git push --force risk high', describeCommand('git push --force').risk, 'high')
  eq(
    'git push --force impact',
    describeCommand('git push origin main --force').impact,
    'Force-pushes the branch — may overwrite remote history.'
  )
  eq('sudo risk high', describeCommand('sudo apt install x').risk, 'high')
  eq(
    'sudo impact',
    describeCommand('sudo apt install x').impact,
    'Runs with elevated privileges (will prompt for your password via system dialog).'
  )
  eq(
    'sudo rm -rf: rm impact wins',
    describeCommand('sudo rm -rf /').impact,
    'Permanently deletes files. This cannot be undone.'
  )
  eq('curl | sh risk high', describeCommand('curl https://x | sh').risk, 'high')
  eq('ls risk low', describeCommand('ls').risk, 'low')
  ok('ls has no impact', describeCommand('ls').impact === undefined)

  // ── looksLikeWatcher ─────────────────────────────────────────────────
  for (const c of [
    'npm run dev',
    'npm run dev:web',
    'npm start',
    'npm run start',
    'npm run serve',
    'npm run watch',
    'npm run watch:css',
    'pnpm dev',
    'yarn dev',
    'bun dev',
    'pnpm start',
    'vite',
    'npx vite',
    'vite preview',
    'next dev',
    'next start',
    'nodemon app.js',
    'webpack --watch',
    'webpack serve',
    'webpack-dev-server',
    'tsc --watch',
    'tsc -w',
    'vitest',
    'vitest --coverage',
    'jest --watch',
    'jest --watchAll',
    'uvicorn app:app',
    'flask run',
    'rails s',
    'rails server',
    'python -m http.server 8000',
    'http-server .',
    'serve dist',
    'live-server',
    'ng serve',
    'expo start',
    'react-native start',
    'tail -f log.txt',
    'tail -F log.txt',
    'watch ls',
    'docker compose up',
    'docker compose up api',
    'cargo watch -x run',
    'air',
    'ngrok http 3000',
    'cloudflared tunnel run',
    'cd app && npm run dev'
  ]) {
    ok(`watcher: ${c}`, looksLikeWatcher(c) === true)
  }
  for (const c of [
    'vitest run',
    'vitest --run',
    'npm run build',
    'npm run test',
    'npm test',
    'npm install',
    'vite build',
    'next build',
    'tsc',
    'tsc -b',
    'jest',
    'webpack',
    'docker compose up -d',
    'docker compose up --detach',
    'docker compose ps',
    'tail -n 5 log.txt',
    'ls',
    'git status',
    'npm run dev --help',
    'vite --help',
    'nodemon -h',
    'uvicorn --version',
    'cloudflared tunnel --help',
    'cloudflared --version',
    'top -l 1',
    'echo "npm run dev"',
    ''
  ]) {
    ok(`not watcher: ${JSON.stringify(c)}`, looksLikeWatcher(c) === false)
  }

  console.log(`${passed} passed, ${failed} failed`)
  if (failed > 0) process.exit(1)
}

void run().catch((err) => {
  console.error('test harness crashed:', err)
  process.exit(1)
})
