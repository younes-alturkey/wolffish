// Post-edit formatting, ported in spirit from OpenCode's format/formatter.ts:
// after file_edit / file_write, run the PROJECT'S OWN formatter on the file
// when the project demonstrably uses one, so the diff the model and the user
// see is the formatted result and a later lint pass has nothing to flag.
//
// Conservative by design — a formatter runs only when the project declares
// it (prettier in package.json AND a config file, biome.json, a ruff
// section, …) or the language has one canonical formatter on PATH (gofmt,
// rustfmt). Failures are silent: formatting is a courtesy, never a gate.
import { execFile } from 'node:child_process'
import { access, readFile } from 'node:fs/promises'
import path from 'node:path'

const FORMAT_TIMEOUT_MS = 20_000

const PRETTIER_EXTS = new Set([
  '.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.mts', '.cts', '.html', '.htm', '.css', '.scss',
  '.sass', '.less', '.vue', '.svelte', '.json', '.jsonc', '.yaml', '.yml', '.md', '.mdx',
  '.graphql', '.gql'
])
const BIOME_EXTS = new Set(['.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.mts', '.cts', '.json', '.jsonc', '.css'])
const PRETTIER_CONFIGS = [
  '.prettierrc', '.prettierrc.json', '.prettierrc.yaml', '.prettierrc.yml', '.prettierrc.js',
  '.prettierrc.cjs', '.prettierrc.mjs', '.prettierrc.toml', 'prettier.config.js',
  'prettier.config.cjs', 'prettier.config.mjs'
]

async function exists(p) {
  try {
    await access(p)
    return true
  } catch {
    return false
  }
}

async function findUp(start, names, stopAt) {
  let dir = start
  for (let i = 0; i < 64; i++) {
    for (const name of names) {
      const candidate = path.join(dir, name)
      if (await exists(candidate)) return candidate
    }
    if (stopAt && dir === stopAt) return null
    const parent = path.dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
  return null
}

const whichCache = new Map()
function which(bin) {
  if (whichCache.has(bin)) return whichCache.get(bin)
  const p = new Promise((resolve) => {
    execFile(process.platform === 'win32' ? 'where' : 'which', [bin], { timeout: 3000 }, (err, out) => {
      const line = err ? '' : String(out).split(/\r?\n/)[0].trim()
      resolve(line || null)
    })
  })
  whichCache.set(bin, p)
  return p
}

function run(cmd, args, cwd) {
  return new Promise((resolve) => {
    try {
      execFile(cmd, args, { cwd, timeout: FORMAT_TIMEOUT_MS, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (err) =>
        resolve(!err)
      )
    } catch {
      resolve(false)
    }
  })
}

async function readJson(p) {
  try {
    return JSON.parse(await readFile(p, 'utf8'))
  } catch {
    return null
  }
}

/**
 * Pick the formatter command for `file`, or null. Returns
 * `{ name, cmd, args, cwd }`.
 */
export async function resolveFormatter(file, rootHint) {
  const ext = path.extname(file).toLowerCase()
  const dir = path.dirname(file)

  if (PRETTIER_EXTS.has(ext) || BIOME_EXTS.has(ext)) {
    const pkgPath = await findUp(dir, ['package.json'], rootHint)
    if (pkgPath) {
      const pkgDir = path.dirname(pkgPath)
      const pkg = (await readJson(pkgPath)) ?? {}
      const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) }
      const bin = (name) => path.join(pkgDir, 'node_modules', '.bin', process.platform === 'win32' ? `${name}.cmd` : name)
      if ('@biomejs/biome' in deps && BIOME_EXTS.has(ext)) {
        const cfg = await findUp(dir, ['biome.json', 'biome.jsonc'], pkgDir)
        if (cfg && (await exists(bin('biome')))) {
          return { name: 'biome', cmd: bin('biome'), args: ['format', '--write', file], cwd: pkgDir }
        }
      }
      if ('prettier' in deps && PRETTIER_EXTS.has(ext)) {
        const cfg = (await findUp(dir, PRETTIER_CONFIGS, pkgDir)) || (pkg.prettier ? pkgPath : null)
        if (cfg && (await exists(bin('prettier')))) {
          return { name: 'prettier', cmd: bin('prettier'), args: ['--write', '--log-level', 'silent', file], cwd: pkgDir }
        }
      }
    }
    return null
  }

  if (ext === '.py' || ext === '.pyi') {
    const pyproject = await findUp(dir, ['pyproject.toml', 'ruff.toml', '.ruff.toml'], rootHint)
    if (!pyproject) return null
    const declares =
      pyproject.endsWith('ruff.toml') || (await readFile(pyproject, 'utf8').catch(() => '')).includes('[tool.ruff')
    if (!declares) return null
    const ruff = await which('ruff')
    if (!ruff) return null
    return { name: 'ruff', cmd: ruff, args: ['format', file], cwd: path.dirname(pyproject) }
  }

  if (ext === '.go') {
    const gofmt = await which('gofmt')
    return gofmt ? { name: 'gofmt', cmd: gofmt, args: ['-w', file], cwd: dir } : null
  }
  if (ext === '.rs') {
    const rustfmt = await which('rustfmt')
    return rustfmt ? { name: 'rustfmt', cmd: rustfmt, args: ['--edition', '2021', file], cwd: dir } : null
  }
  if (ext === '.sh' || ext === '.bash') {
    const shfmt = await which('shfmt')
    return shfmt ? { name: 'shfmt', cmd: shfmt, args: ['-w', file], cwd: dir } : null
  }
  if (ext === '.tf' || ext === '.tfvars') {
    const terraform = await which('terraform')
    return terraform ? { name: 'terraform', cmd: terraform, args: ['fmt', file], cwd: dir } : null
  }
  return null
}

/**
 * Format `file` in place with the project's formatter, if any. Returns the
 * formatter name when one ran successfully, else null. Never throws.
 */
export async function formatFile(file, rootHint) {
  if (process.env.WOLFFISH_FORMAT_ON_EDIT === '0') return null
  try {
    const formatter = await resolveFormatter(file, rootHint)
    if (!formatter) return null
    const ok = await run(formatter.cmd, formatter.args, formatter.cwd)
    return ok ? formatter.name : null
  } catch {
    return null
  }
}
