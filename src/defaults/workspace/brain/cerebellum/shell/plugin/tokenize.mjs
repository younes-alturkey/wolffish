/**
 * Shell-command tokenizer + classifier for the shell capability.
 *
 * Replaces OpenCode's tree-sitter parse for three consumers:
 *   1. approval-card verb labels          → describeCommand()
 *   2. the read-only gate (plan mode)     → isReadOnly() / isReadOnlyCommand()
 *   3. session allow-prefixes             → arityPrefix()
 * plus looksLikeWatcher() for "this will not exit on its own" hints.
 *
 * Plain ESM, no dependencies, no node: imports needed. Everything is a pure
 * function of the command string.
 *
 * Design notes
 * - The tokenizer is deliberately conservative: anything it cannot classify
 *   as read-only is mutating. Unknown heads, `sudo`-elevated commands,
 *   `curl`/`wget` (network side effects), `tee`, and anything with a `>` or
 *   `>>` redirect (other than to /dev/null or an fd dup like `2>&1`) count
 *   as mutating for the plan-mode gate.
 * - `$(...)`, backticks, `<(...)` and `>(...)` are kept as one opaque word
 *   in the outer command AND their contents are split and appended to the
 *   result (`fromSubstitution: true`) because `echo $(rm -rf x)` mutates.
 * - `{ ...; }` and `( ... )` group delimiters are stripped and the inside is
 *   split like any other list.
 * - `arityPrefix()` is a faithful port of OpenCode's permission/arity.ts:
 *   longest matching prefix wins, flags are not skipped, unknown → arity 1.
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Heads that change the cwd (OpenCode parity; a `cd` never earns an allow-prefix). */
export const CWD_HEADS = new Set(['cd', 'chdir', 'popd', 'pushd', 'push-location', 'set-location'])

/** Heads whose path arguments OpenCode resolves against the project root. */
export const FILE_HEADS = new Set([
  ...CWD_HEADS,
  'rm',
  'cp',
  'mv',
  'mkdir',
  'touch',
  'chmod',
  'chown',
  'cat',
  'get-content',
  'set-content',
  'add-content',
  'copy-item',
  'move-item',
  'remove-item',
  'new-item',
  'rename-item'
])

/** cmd.exe builtins that take path arguments. */
export const CMD_FILE_HEADS = new Set([
  'copy',
  'del',
  'dir',
  'erase',
  'md',
  'mkdir',
  'move',
  'rd',
  'ren',
  'rename',
  'rmdir',
  'type'
])

const ENV_ASSIGN_RE = /^[A-Za-z_][A-Za-z0-9_]*(\[[^\]]*\])?\+?=/
const MAX_SUBSTITUTION_DEPTH = 8

// ---------------------------------------------------------------------------
// POSIX sh tokenizer
// ---------------------------------------------------------------------------

/** Consume a balanced `(...)` starting at `open` (index of '('), honoring quotes. Returns index after ')'. */
function skipBalancedParens(s, open) {
  let depth = 0
  let i = open
  while (i < s.length) {
    const ch = s[i]
    if (ch === '\\') {
      i += 2
      continue
    }
    if (ch === "'") {
      const end = s.indexOf("'", i + 1)
      i = end === -1 ? s.length : end + 1
      continue
    }
    if (ch === '"') {
      i++
      while (i < s.length && s[i] !== '"') {
        if (s[i] === '\\') i++
        i++
      }
      i++
      continue
    }
    if (ch === '(') depth++
    else if (ch === ')') {
      depth--
      if (depth === 0) return i + 1
    }
    i++
  }
  return s.length
}

/** Consume a backtick substitution starting at `open` (index of '`'). Returns index after the closing backtick. */
function skipBackticks(s, open) {
  let i = open + 1
  while (i < s.length) {
    if (s[i] === '\\') {
      i += 2
      continue
    }
    if (s[i] === '`') return i + 1
    i++
  }
  return s.length
}

/**
 * Tokenize a POSIX-ish shell string into simple commands.
 * Returns { commands: [{ words: [{text, quoted}], redirects, background, raw }], subs: string[] }.
 */
function scanSh(input) {
  const s = String(input)
  const commands = []
  const subs = []

  let words = []
  let redirects = []
  let background = false
  let cmdStart = 0

  let cur = ''
  let curQuoted = false
  let hasWord = false
  let pendingRedirect = null // { op }
  const pendingHeredocs = []

  const flushWord = () => {
    if (!hasWord) return
    const text = cur
    const quoted = curQuoted
    cur = ''
    curQuoted = false
    hasWord = false
    if (pendingRedirect) {
      const op = pendingRedirect.op
      pendingRedirect = null
      const redirect = { op, target: text }
      if (op === '<<' || op === '<<-') pendingHeredocs.push({ delim: text, redirect })
      redirects.push(redirect)
      return
    }
    if (!quoted && (text === '{' || text === '}')) {
      endCommand()
      return
    }
    words.push({ text, quoted })
  }

  let i = 0
  const endCommand = () => {
    flushWord()
    pendingRedirect = null
    if (words.length || redirects.length) {
      commands.push({ words, redirects, background, raw: s.slice(cmdStart, i).trim() })
    }
    words = []
    redirects = []
    background = false
    cmdStart = i
  }

  const addSubstitution = (rawText, inner, recurse) => {
    cur += rawText
    hasWord = true
    if (recurse) subs.push(inner)
  }

  while (i < s.length) {
    const ch = s[i]
    const next = s[i + 1]

    // Backslash outside quotes
    if (ch === '\\') {
      if (next === '\n') {
        i += 2
        continue
      }
      if (next === undefined) {
        i++
        continue
      }
      cur += next
      hasWord = true
      curQuoted = true
      i += 2
      continue
    }

    // Single quotes: literal to the next '
    if (ch === "'") {
      const end = s.indexOf("'", i + 1)
      const stop = end === -1 ? s.length : end
      cur += s.slice(i + 1, stop)
      hasWord = true
      curQuoted = true
      i = stop + 1
      continue
    }

    // Double quotes: backslash escapes for " \ $ ` and newline; substitutions still expand
    if (ch === '"') {
      i++
      hasWord = true
      curQuoted = true
      while (i < s.length && s[i] !== '"') {
        const c = s[i]
        const n = s[i + 1]
        if (c === '\\') {
          if (n === '"' || n === '\\' || n === '$' || n === '`') {
            cur += n
            i += 2
          } else if (n === '\n') {
            i += 2
          } else {
            cur += c
            i++
          }
          continue
        }
        if (c === '$' && n === '(') {
          const end = skipBalancedParens(s, i + 1)
          const raw = s.slice(i, end)
          const arithmetic = s[i + 2] === '('
          addSubstitution(raw, s.slice(i + 2, Math.max(i + 2, end - 1)), !arithmetic)
          i = end
          continue
        }
        if (c === '`') {
          const end = skipBackticks(s, i)
          addSubstitution(s.slice(i, end), s.slice(i + 1, Math.max(i + 1, end - 1)), true)
          i = end
          continue
        }
        cur += c
        i++
      }
      i++ // closing quote
      continue
    }

    // $(...) and $((...))
    if (ch === '$' && next === '(') {
      const end = skipBalancedParens(s, i + 1)
      const arithmetic = s[i + 2] === '('
      addSubstitution(s.slice(i, end), s.slice(i + 2, Math.max(i + 2, end - 1)), !arithmetic)
      i = end
      continue
    }

    // `...`
    if (ch === '`') {
      const end = skipBackticks(s, i)
      addSubstitution(s.slice(i, end), s.slice(i + 1, Math.max(i + 1, end - 1)), true)
      i = end
      continue
    }

    // Process substitution <(...) / >(...)
    if ((ch === '<' || ch === '>') && next === '(') {
      const end = skipBalancedParens(s, i + 1)
      addSubstitution(s.slice(i, end), s.slice(i + 2, Math.max(i + 2, end - 1)), true)
      i = end
      continue
    }

    // Comment (only at the start of a word)
    if (ch === '#' && !hasWord) {
      while (i < s.length && s[i] !== '\n') i++
      continue
    }

    // Whitespace
    if (ch === ' ' || ch === '\t' || ch === '\r') {
      flushWord()
      i++
      continue
    }

    // Newline: ends the command, then swallows any pending heredoc bodies
    if (ch === '\n') {
      endCommand()
      i++
      while (pendingHeredocs.length) {
        const { delim, redirect } = pendingHeredocs.shift()
        const body = []
        while (i < s.length) {
          let eol = s.indexOf('\n', i)
          if (eol === -1) eol = s.length
          const line = s.slice(i, eol)
          i = eol + 1
          if (line.trim() === delim) break
          body.push(redirect.op === '<<-' ? line.replace(/^\t+/, '') : line)
        }
        // The body is kept on the redirect so an interpreter fed by heredoc
        // (`node <<'EOF' … EOF`) can be inspected like an inline `-e` program.
        redirect.body = body.join('\n')
      }
      cmdStart = i
      continue
    }

    // Redirections: [fd]>, >>, >|, >&, <, <<, <<<, <&, <>, &>, &>>
    if (ch === '>' || ch === '<' || (ch === '&' && next === '>')) {
      let fd = ''
      if (hasWord && !curQuoted && /^\d+$/.test(cur)) {
        fd = cur
        cur = ''
        hasWord = false
      } else {
        flushWord()
      }
      let op = ''
      if (ch === '&') {
        op = '&>'
        i += 2
        if (s[i] === '>') {
          op = '&>>'
          i++
        }
      } else if (ch === '>') {
        op = '>'
        i++
        if (s[i] === '>') {
          op = '>>'
          i++
        } else if (s[i] === '|') {
          op = '>|'
          i++
        } else if (s[i] === '&') {
          op = '>&'
          i++
        }
      } else {
        op = '<'
        i++
        if (s[i] === '<') {
          op = '<<'
          i++
          if (s[i] === '<') {
            op = '<<<'
            i++
          } else if (s[i] === '-') {
            op = '<<-'
            i++
          }
        } else if (s[i] === '&') {
          op = '<&'
          i++
        } else if (s[i] === '>') {
          op = '<>'
          i++
        }
      }
      pendingRedirect = { op: fd + op }
      continue
    }

    // List operators
    if (ch === '&' && next === '&') {
      endCommand()
      i += 2
      cmdStart = i
      continue
    }
    if (ch === '|' && next === '|') {
      endCommand()
      i += 2
      cmdStart = i
      continue
    }
    if (ch === '|') {
      endCommand()
      i += next === '&' ? 2 : 1
      cmdStart = i
      continue
    }
    if (ch === ';') {
      endCommand()
      i += next === ';' ? 2 : 1
      cmdStart = i
      continue
    }
    if (ch === '&') {
      background = true
      endCommand()
      i++
      cmdStart = i
      continue
    }

    // Groups: ( ... ) — strip the delimiters, split inside
    if (ch === '(' && !hasWord) {
      endCommand()
      i++
      cmdStart = i
      continue
    }
    if (ch === ')') {
      endCommand()
      i++
      cmdStart = i
      continue
    }

    cur += ch
    hasWord = true
    i++
  }
  endCommand()

  return { commands, subs }
}

// ---------------------------------------------------------------------------
// PowerShell / cmd.exe scanners (lighter: quotes + separators + redirects)
// ---------------------------------------------------------------------------

function scanPowerShell(input) {
  const s = String(input)
  const commands = []
  const subs = []
  let words = []
  let redirects = []
  let cmdStart = 0
  let cur = ''
  let curQuoted = false
  let hasWord = false
  let pendingRedirect = null

  const flushWord = () => {
    if (!hasWord) return
    const text = cur
    const quoted = curQuoted
    cur = ''
    curQuoted = false
    hasWord = false
    if (pendingRedirect) {
      redirects.push({ op: pendingRedirect.op, target: text })
      pendingRedirect = null
      return
    }
    words.push({ text, quoted })
  }
  let i = 0
  const endCommand = () => {
    flushWord()
    pendingRedirect = null
    if (words.length || redirects.length) {
      commands.push({ words, redirects, background: false, raw: s.slice(cmdStart, i).trim() })
    }
    words = []
    redirects = []
    cmdStart = i
  }

  while (i < s.length) {
    const ch = s[i]
    const next = s[i + 1]
    if (ch === '`') {
      if (next === '\n') {
        i += 2
        continue
      }
      if (next !== undefined) {
        cur += next
        hasWord = true
        curQuoted = true
      }
      i += 2
      continue
    }
    if (ch === "'") {
      i++
      hasWord = true
      curQuoted = true
      while (i < s.length) {
        if (s[i] === "'") {
          if (s[i + 1] === "'") {
            cur += "'"
            i += 2
            continue
          }
          break
        }
        cur += s[i]
        i++
      }
      i++
      continue
    }
    if (ch === '"') {
      i++
      hasWord = true
      curQuoted = true
      while (i < s.length) {
        if (s[i] === '`' && i + 1 < s.length) {
          cur += s[i + 1]
          i += 2
          continue
        }
        if (s[i] === '"') {
          if (s[i + 1] === '"') {
            cur += '"'
            i += 2
            continue
          }
          break
        }
        if (s[i] === '$' && s[i + 1] === '(') {
          const end = skipBalancedParens(s, i + 1)
          cur += s.slice(i, end)
          subs.push(s.slice(i + 2, Math.max(i + 2, end - 1)))
          i = end
          continue
        }
        cur += s[i]
        i++
      }
      i++
      continue
    }
    if ((ch === '$' || ch === '@') && next === '(') {
      const end = skipBalancedParens(s, i + 1)
      cur += s.slice(i, end)
      subs.push(s.slice(i + 2, Math.max(i + 2, end - 1)))
      hasWord = true
      i = end
      continue
    }
    if (ch === '(') {
      const end = skipBalancedParens(s, i)
      cur += s.slice(i, end)
      subs.push(s.slice(i + 1, Math.max(i + 1, end - 1)))
      hasWord = true
      i = end
      continue
    }
    if (ch === '{') {
      // script block: opaque word, contents recursed
      let depth = 0
      let j = i
      while (j < s.length) {
        if (s[j] === '{') depth++
        else if (s[j] === '}') {
          depth--
          if (depth === 0) break
        }
        j++
      }
      const end = Math.min(s.length, j + 1)
      cur += s.slice(i, end)
      subs.push(s.slice(i + 1, Math.max(i + 1, end - 1)))
      hasWord = true
      i = end
      continue
    }
    if (ch === '#' && !hasWord) {
      while (i < s.length && s[i] !== '\n') i++
      continue
    }
    if (ch === ' ' || ch === '\t' || ch === '\r') {
      flushWord()
      i++
      continue
    }
    if (ch === '\n' || ch === ';') {
      endCommand()
      i++
      cmdStart = i
      continue
    }
    if ((ch === '&' && next === '&') || (ch === '|' && next === '|')) {
      endCommand()
      i += 2
      cmdStart = i
      continue
    }
    if (ch === '|') {
      endCommand()
      i++
      cmdStart = i
      continue
    }
    if (ch === '>' || ch === '<') {
      let fd = ''
      if (hasWord && !curQuoted && /^(\d+|\*)$/.test(cur)) {
        fd = cur
        cur = ''
        hasWord = false
      } else {
        flushWord()
      }
      let op = ch
      i++
      if (ch === '>' && s[i] === '>') {
        op = '>>'
        i++
      }
      if (s[i] === '&') {
        op += '&'
        i++
      }
      pendingRedirect = { op: fd + op }
      continue
    }
    cur += ch
    hasWord = true
    i++
  }
  endCommand()
  return { commands, subs }
}

function scanCmd(input) {
  const s = String(input)
  const commands = []
  let words = []
  let redirects = []
  let cmdStart = 0
  let cur = ''
  let curQuoted = false
  let hasWord = false
  let pendingRedirect = null

  const flushWord = () => {
    if (!hasWord) return
    const text = cur
    const quoted = curQuoted
    cur = ''
    curQuoted = false
    hasWord = false
    if (pendingRedirect) {
      redirects.push({ op: pendingRedirect.op, target: text })
      pendingRedirect = null
      return
    }
    words.push({ text, quoted })
  }
  let i = 0
  const endCommand = () => {
    flushWord()
    pendingRedirect = null
    if (words.length || redirects.length) {
      commands.push({ words, redirects, background: false, raw: s.slice(cmdStart, i).trim() })
    }
    words = []
    redirects = []
    cmdStart = i
  }

  while (i < s.length) {
    const ch = s[i]
    const next = s[i + 1]
    if (ch === '^') {
      if (next !== undefined && next !== '\n') {
        cur += next
        hasWord = true
        curQuoted = true
      }
      i += 2
      continue
    }
    if (ch === '"') {
      i++
      hasWord = true
      curQuoted = true
      while (i < s.length && s[i] !== '"') {
        cur += s[i]
        i++
      }
      i++
      continue
    }
    if (ch === ' ' || ch === '\t' || ch === '\r') {
      flushWord()
      i++
      continue
    }
    if (ch === '\n') {
      endCommand()
      i++
      cmdStart = i
      continue
    }
    if ((ch === '&' && next === '&') || (ch === '|' && next === '|')) {
      endCommand()
      i += 2
      cmdStart = i
      continue
    }
    if (ch === '&' || ch === '|') {
      endCommand()
      i++
      cmdStart = i
      continue
    }
    if (ch === '(' && !hasWord) {
      endCommand()
      i++
      cmdStart = i
      continue
    }
    if (ch === ')') {
      endCommand()
      i++
      cmdStart = i
      continue
    }
    if (ch === '>' || ch === '<') {
      let fd = ''
      if (hasWord && !curQuoted && /^\d+$/.test(cur)) {
        fd = cur
        cur = ''
        hasWord = false
      } else {
        flushWord()
      }
      let op = ch
      i++
      if (ch === '>' && s[i] === '>') {
        op = '>>'
        i++
      }
      if (s[i] === '&') {
        op += '&'
        i++
      }
      pendingRedirect = { op: fd + op }
      continue
    }
    cur += ch
    hasWord = true
    i++
  }
  endCommand()
  return { commands, subs: [] }
}

// ---------------------------------------------------------------------------
// Simple-command builder: env assignments, wrapper prefixes, head
// ---------------------------------------------------------------------------

// wrapper → { argFlags: flags that consume the next token, stopOnDashDash }
const SUDO_ARG_FLAGS = new Set(['-u', '-g', '-p', '-C', '-r', '-t', '-U', '-D', '-T', '-h'])
const DOAS_ARG_FLAGS = new Set(['-u', '-C'])
const ENV_ARG_FLAGS = new Set(['-u', '-C', '-S', '--unset', '--chdir', '--split-string'])
const NICE_ARG_FLAGS = new Set(['-n', '--adjustment'])
const TIME_ARG_FLAGS = new Set(['-f', '-o', '--format', '--output'])
const TIMEOUT_ARG_FLAGS = new Set(['-s', '-k', '--signal', '--kill-after'])
const XARGS_ARG_FLAGS = new Set(['-n', '-I', '-i', '-L', '-P', '-s', '-d', '-E', '-a', '-l', '-J', '-R', '-S'])

/** Drop `flags` (and their argument when in argFlags) from the front of `words`; returns the rest. */
function dropFlags(words, argFlags) {
  let j = 0
  while (j < words.length) {
    const w = words[j]
    if (w === '--') {
      j++
      break
    }
    if (!w.startsWith('-') || w === '-') break
    if (argFlags.has(w) && !w.includes('=')) j += 2
    else j++
  }
  return words.slice(j)
}

function dropEnvAssignments(words, env) {
  let j = 0
  while (j < words.length && ENV_ASSIGN_RE.test(words[j])) {
    env.push(words[j])
    j++
  }
  return words.slice(j)
}

/** Strip leading env assignments and wrapper commands. Returns { tokens, env, elevated }. */
function unwrap(words) {
  const env = []
  let elevated = false
  let rest = dropEnvAssignments(words, env)
  for (let guard = 0; guard < 8 && rest.length; guard++) {
    const head = rest[0]
    let next = null
    switch (head) {
      case 'sudo':
        next = dropFlags(rest.slice(1), SUDO_ARG_FLAGS)
        elevated = true
        break
      case 'doas':
        next = dropFlags(rest.slice(1), DOAS_ARG_FLAGS)
        elevated = true
        break
      case 'env':
        next = dropEnvAssignments(dropFlags(rest.slice(1), ENV_ARG_FLAGS), env)
        break
      case 'nohup':
      case 'exec':
      case 'builtin':
        next = rest.slice(1)
        break
      case 'command':
        // `command -v foo` is a query, not a wrapper
        if (rest[1] && rest[1].startsWith('-') && /[vV]/.test(rest[1])) next = null
        else next = dropFlags(rest.slice(1), new Set())
        break
      case 'time':
        next = dropFlags(rest.slice(1), TIME_ARG_FLAGS)
        break
      case 'nice':
        next = dropFlags(rest.slice(1), NICE_ARG_FLAGS)
        break
      case 'timeout': {
        const afterFlags = dropFlags(rest.slice(1), TIMEOUT_ARG_FLAGS)
        next = afterFlags.length && /^\d+(\.\d+)?[smhd]?$/.test(afterFlags[0]) ? afterFlags.slice(1) : null
        break
      }
      case 'xargs':
        next = dropFlags(rest.slice(1), XARGS_ARG_FLAGS)
        break
      default:
        next = null
    }
    if (next === null) break
    if (next.length === 0) break // `sudo` alone, `env`, `xargs` (defaults to echo): keep the wrapper as head
    rest = dropEnvAssignments(next, env)
    if (rest.length === 0) {
      rest = next
      break
    }
  }
  return { tokens: rest, env, elevated }
}

const DUP_TARGET_RE = /^(\d+|-)$/

function isMutatingRedirect(r) {
  if (!r.op.includes('>')) return false
  if (r.op.startsWith('<')) return false // <> is read-write; treat as read for the open, rare
  if (r.op.endsWith('&') && DUP_TARGET_RE.test(r.target)) return false // 2>&1
  if (r.target === '/dev/null') return false
  return true
}

function buildCommand(scanned, shell, fromSubstitution) {
  const words = scanned.words.map((w) => w.text)
  let tokens
  let env = []
  let elevated = false
  if (shell === 'sh') {
    const u = unwrap(words)
    tokens = u.tokens
    env = u.env
    elevated = u.elevated
  } else if (shell === 'powershell') {
    tokens = words.slice()
    if (tokens[0] === '&' || tokens[0] === '.') tokens = tokens.slice(1)
    tokens = tokens.map((t, idx) => (idx === 0 ? t.toLowerCase() : t))
  } else {
    tokens = words.slice()
    if (tokens[0] && tokens[0].startsWith('@') && tokens[0].length > 1) tokens[0] = tokens[0].slice(1)
    if (tokens[0] && tokens[0].toLowerCase() === 'call') tokens = tokens.slice(1)
    tokens = tokens.map((t, idx) => (idx === 0 ? t.toLowerCase() : t))
  }
  const head = tokens[0] ?? ''
  return {
    raw: scanned.raw,
    words,
    tokens,
    head,
    args: tokens.slice(1),
    env,
    elevated,
    redirects: scanned.redirects,
    mutatingRedirect: scanned.redirects.some(isMutatingRedirect),
    background: scanned.background,
    fromSubstitution
  }
}

// ---------------------------------------------------------------------------
// splitCommands
// ---------------------------------------------------------------------------

/**
 * Split a command line into simple commands.
 * @param {string} command
 * @param {{ shell?: 'sh'|'powershell'|'cmd' }} [opts]
 * @returns {Array<{ raw: string, words: string[], tokens: string[], head: string, args: string[], env: string[], elevated: boolean, redirects: Array<{op: string, target: string, body?: string}>, mutatingRedirect: boolean, background: boolean, fromSubstitution: boolean }>}
 */
export function splitCommands(command, opts = {}) {
  const shell = opts.shell === 'powershell' || opts.shell === 'cmd' ? opts.shell : 'sh'
  return splitDepth(String(command ?? ''), shell, 0, false)
}

function splitDepth(command, shell, depth, fromSubstitution) {
  const scan = shell === 'sh' ? scanSh(command) : shell === 'powershell' ? scanPowerShell(command) : scanCmd(command)
  const out = scan.commands.map((c) => buildCommand(c, shell, fromSubstitution))
  if (depth < MAX_SUBSTITUTION_DEPTH) {
    for (const inner of scan.subs) {
      if (inner.trim()) out.push(...splitDepth(inner, shell, depth + 1, true))
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// Arity (faithful port of OpenCode permission/arity.ts)
// ---------------------------------------------------------------------------

/* Generated with following prompt:
You are generating a dictionary of command-prefix arities for bash-style commands.
This dictionary is used to identify the "human-understandable command" from an input shell command.### **RULES (follow strictly)**1. Each entry maps a **command prefix string → number**, representing how many **tokens** define the command.
2. **Flags NEVER count as tokens**. Only subcommands count.
3. **Longest matching prefix wins**.
4. **Only include a longer prefix if its arity is different from what the shorter prefix already implies**.   * Example: If `git` is 2, then do **not** include `git checkout`, `git commit`, etc. unless they require *different* arity.
5. The output must be a **single JSON object**. Each entry should have a comment with an example real world matching command. DO NOT MAKE ANY OTHER COMMENTS. Should be alphabetical
6. Include the **most commonly used commands** across many stacks and languages. More is better.### **Semantics examples*** `touch foo.txt` → `touch` (arity 1, explicitly listed)
* `git checkout main` → `git checkout` (because `git` has arity 2)
* `npm install` → `npm install` (because `npm` has arity 2)
* `npm run dev` → `npm run dev` (because `npm run` has arity 3)
* `python script.py` → `python script.py` (default: whole input, not in dictionary)### **Now generate the dictionary.**
*/
export const ARITY = {
  cat: 1, // cat file.txt
  cd: 1, // cd /path/to/dir
  chmod: 1, // chmod 755 script.sh
  chown: 1, // chown user:group file.txt
  cp: 1, // cp source.txt dest.txt
  echo: 1, // echo "hello world"
  env: 1, // env
  export: 1, // export PATH=/usr/bin
  grep: 1, // grep pattern file.txt
  kill: 1, // kill 1234
  killall: 1, // killall process
  ln: 1, // ln -s source target
  ls: 1, // ls -la
  mkdir: 1, // mkdir new-dir
  mv: 1, // mv old.txt new.txt
  ps: 1, // ps aux
  pwd: 1, // pwd
  rm: 1, // rm file.txt
  rmdir: 1, // rmdir empty-dir
  sleep: 1, // sleep 5
  source: 1, // source ~/.bashrc
  tail: 1, // tail -f log.txt
  touch: 1, // touch file.txt
  unset: 1, // unset VAR
  which: 1, // which node
  aws: 3, // aws s3 ls
  az: 3, // az storage blob list
  bazel: 2, // bazel build
  brew: 2, // brew install node
  bun: 2, // bun install
  'bun run': 3, // bun run dev
  'bun x': 3, // bun x vite
  cargo: 2, // cargo build
  'cargo add': 3, // cargo add tokio
  'cargo run': 3, // cargo run main
  cdk: 2, // cdk deploy
  cf: 2, // cf push app
  cmake: 2, // cmake build
  composer: 2, // composer require laravel
  consul: 2, // consul members
  'consul kv': 3, // consul kv get config/app
  crictl: 2, // crictl ps
  deno: 2, // deno run server.ts
  'deno task': 3, // deno task dev
  doctl: 3, // doctl kubernetes cluster list
  docker: 2, // docker run nginx
  'docker builder': 3, // docker builder prune
  'docker compose': 3, // docker compose up
  'docker container': 3, // docker container ls
  'docker image': 3, // docker image prune
  'docker network': 3, // docker network inspect
  'docker volume': 3, // docker volume ls
  eksctl: 2, // eksctl get clusters
  'eksctl create': 3, // eksctl create cluster
  firebase: 2, // firebase deploy
  flyctl: 2, // flyctl deploy
  gcloud: 3, // gcloud compute instances list
  gh: 3, // gh pr list
  git: 2, // git checkout main
  'git config': 3, // git config user.name
  'git remote': 3, // git remote add origin
  'git stash': 3, // git stash pop
  go: 2, // go build
  gradle: 2, // gradle build
  helm: 2, // helm install mychart
  heroku: 2, // heroku logs
  hugo: 2, // hugo new site blog
  ip: 2, // ip link show
  'ip addr': 3, // ip addr show
  'ip link': 3, // ip link set eth0 up
  'ip netns': 3, // ip netns exec foo bash
  'ip route': 3, // ip route add default via 1.1.1.1
  kind: 2, // kind delete cluster
  'kind create': 3, // kind create cluster
  kubectl: 2, // kubectl get pods
  'kubectl kustomize': 3, // kubectl kustomize overlays/dev
  'kubectl rollout': 3, // kubectl rollout restart deploy/api
  kustomize: 2, // kustomize build .
  make: 2, // make build
  mc: 2, // mc ls myminio
  'mc admin': 3, // mc admin info myminio
  minikube: 2, // minikube start
  mongosh: 2, // mongosh test
  mysql: 2, // mysql -u root
  mvn: 2, // mvn compile
  ng: 2, // ng generate component home
  npm: 2, // npm install
  'npm exec': 3, // npm exec vite
  'npm init': 3, // npm init vue
  'npm run': 3, // npm run dev
  'npm view': 3, // npm view react version
  nvm: 2, // nvm use 18
  nx: 2, // nx build
  openssl: 2, // openssl genrsa 2048
  'openssl req': 3, // openssl req -new -key key.pem
  'openssl x509': 3, // openssl x509 -in cert.pem
  pip: 2, // pip install numpy
  pipenv: 2, // pipenv install flask
  pnpm: 2, // pnpm install
  'pnpm dlx': 3, // pnpm dlx create-next-app
  'pnpm exec': 3, // pnpm exec vite
  'pnpm run': 3, // pnpm run dev
  poetry: 2, // poetry add requests
  podman: 2, // podman run alpine
  'podman container': 3, // podman container ls
  'podman image': 3, // podman image prune
  psql: 2, // psql -d mydb
  pulumi: 2, // pulumi up
  'pulumi stack': 3, // pulumi stack output
  pyenv: 2, // pyenv install 3.11
  python: 2, // python -m venv env
  rake: 2, // rake db:migrate
  rbenv: 2, // rbenv install 3.2.0
  'redis-cli': 2, // redis-cli ping
  rustup: 2, // rustup update
  serverless: 2, // serverless invoke
  sfdx: 3, // sfdx force:org:list
  skaffold: 2, // skaffold dev
  sls: 2, // sls deploy
  sst: 2, // sst deploy
  swift: 2, // swift build
  systemctl: 2, // systemctl restart nginx
  terraform: 2, // terraform apply
  'terraform workspace': 3, // terraform workspace select prod
  tmux: 2, // tmux new -s dev
  turbo: 2, // turbo run build
  ufw: 2, // ufw allow 22
  vault: 2, // vault login
  'vault auth': 3, // vault auth list
  'vault kv': 3, // vault kv get secret/api
  vercel: 2, // vercel deploy
  volta: 2, // volta install node
  wp: 2, // wp plugin install
  yarn: 2, // yarn add react
  'yarn dlx': 3, // yarn dlx create-react-app
  'yarn run': 3 // yarn run dev
}

/** OpenCode's `prefix(tokens)`: longest matching prefix wins; unknown → first token. */
export function arityTokens(tokens) {
  for (let len = tokens.length; len > 0; len--) {
    const key = tokens.slice(0, len).join(' ')
    const arity = ARITY[key]
    if (arity !== undefined) return tokens.slice(0, arity)
  }
  if (tokens.length === 0) return []
  return tokens.slice(0, 1)
}

/**
 * The always-allow prefix pattern for a token list, formatted the way
 * OpenCode stores it: `<prefix tokens> *` (e.g. `git commit *`, `npm run *`).
 * Pass a simple command's `tokens` (wrappers already stripped). Empty → ''.
 */
export function arityPrefix(tokens) {
  const list = Array.isArray(tokens) ? tokens : []
  const head = arityTokens(list)
  if (head.length === 0) return ''
  return head.join(' ') + ' *'
}

// ---------------------------------------------------------------------------
// Read-only classification (plan mode)
// ---------------------------------------------------------------------------

const READ_ONLY_HEADS = new Set([
  'ls',
  'pwd',
  'cat',
  'head',
  'tail',
  'less',
  'more',
  'wc',
  'echo',
  'printf',
  'true',
  'false',
  'test',
  '[',
  'file',
  'stat',
  'du',
  'df',
  'grep',
  'rg',
  'egrep',
  'fgrep',
  'ag',
  'ack',
  'cut',
  'tr',
  'diff',
  'cmp',
  'comm',
  'which',
  'whereis',
  'type',
  'printenv',
  'whoami',
  'uname',
  'id',
  'uptime',
  'ps',
  'nproc',
  'sw_vers',
  'jq',
  'od',
  'hexdump',
  'basename',
  'dirname',
  'realpath',
  'readlink',
  'sha256sum',
  'shasum',
  'md5',
  'md5sum',
  'sleep'
])

const GIT_READ_ONLY_SUBS = new Set([
  'status',
  'log',
  'diff',
  'show',
  'blame',
  'rev-parse',
  'rev-list',
  'ls-files',
  'ls-tree',
  'cat-file',
  'describe',
  'grep',
  'shortlog',
  'count-objects'
])
const GIT_GLOBAL_ARG_FLAGS = new Set(['-C', '-c', '--git-dir', '--work-tree', '--exec-path', '--namespace'])
const GIT_BRANCH_READ_FLAGS = new Set([
  '-a',
  '-r',
  '-v',
  '-vv',
  '-l',
  '--list',
  '--all',
  '--remotes',
  '--verbose',
  '--show-current',
  '--contains',
  '--no-contains',
  '--merged',
  '--no-merged',
  '--points-at',
  '--color',
  '--no-color',
  '--column',
  '--no-column',
  '-i',
  '--ignore-case'
])
const GIT_BRANCH_LIST_FLAGS = new Set(['-l', '--list', '--contains', '--no-contains', '--merged', '--no-merged', '--points-at'])

function positionals(args) {
  return args.filter((a) => !a.startsWith('-'))
}

function gitReadOnly(args) {
  // skip global options
  let j = 0
  while (j < args.length && args[j].startsWith('-')) {
    if (GIT_GLOBAL_ARG_FLAGS.has(args[j])) j += 2
    else j++
  }
  const sub = args[j]
  const rest = args.slice(j + 1)
  if (!sub) return false // bare `git` prints help; fine, but keep the allowlist tight
  if (GIT_READ_ONLY_SUBS.has(sub)) return true
  switch (sub) {
    case 'branch': {
      const hasList = rest.some((a) => GIT_BRANCH_LIST_FLAGS.has(a) || a.startsWith('--list=') || a.startsWith('--contains='))
      for (const a of rest) {
        if (a.startsWith('-')) {
          const bare = a.split('=')[0]
          if (!GIT_BRANCH_READ_FLAGS.has(bare) && !bare.startsWith('--format') && !bare.startsWith('--sort')) return false
        } else if (!hasList) {
          return false // `git branch foo` creates a branch
        }
      }
      return true
    }
    case 'remote': {
      if (rest.length === 0) return true
      const p = positionals(rest)
      if (p.length === 0) return rest.every((a) => a === '-v' || a === '--verbose')
      return p[0] === 'show' || p[0] === 'get-url'
    }
    case 'stash':
      return rest[0] === 'list' || rest[0] === 'show'
    case 'tag':
      return rest.every((a) => a === '-l' || a === '--list' || /^-n\d*$/.test(a) || a.startsWith('--contains') || a.startsWith('--sort'))
    case 'config': {
      if (rest.some((a) => /^--(unset|unset-all|add|edit|replace-all|rename-section|remove-section)$/.test(a) || a === '-e')) return false
      const query = rest.some((a) => a === '--get' || a === '--get-all' || a === '--get-regexp' || a === '--list' || a === '-l')
      return query
    }
    case 'worktree':
      return rest[0] === 'list'
    case 'reflog':
      return rest.length === 0 || rest[0] === 'show' || rest[0].startsWith('-')
    default:
      return false
  }
}

function versionOnly(args, flags) {
  return args.length === 1 && flags.has(args[0])
}

const VERSION_FLAGS = new Set(['-v', '--version', '-V'])

/**
 * Is one simple command read-only? Accepts a simple-command object from
 * splitCommands() or a string containing exactly one simple command.
 * Conservative: unknown heads, sudo/doas elevation, `>`/`>>` redirects (to
 * anything but /dev/null or an fd), and network clients (curl/wget: not
 * read-only — network side effects count as mutating in plan mode) → false.
 */
export function isReadOnlyCommand(cmd) {
  if (typeof cmd === 'string') {
    const list = splitCommands(cmd)
    if (list.length !== 1) return false
    cmd = list[0]
  }
  if (!cmd || !cmd.head) return false
  if (cmd.elevated) return false
  if (cmd.mutatingRedirect) return false
  const { head, args } = cmd
  const hasFlag = (re) => args.some((a) => re.test(a))

  // Plain allowlist (echo/printf included: their only mutating form is a `>` redirect, checked above)
  if (READ_ONLY_HEADS.has(head)) return true
  switch (head) {
    case 'find':
      return !hasFlag(/^-(delete|exec|execdir|ok|okdir|fprint|fprint0|fprintf|fls)$/)
    case 'awk':
    case 'gawk':
    case 'mawk':
    case 'nawk':
      return !args.some((a) => a.includes('system(') || a.includes('>') || a.includes('|'))
    case 'sed':
    case 'gsed':
      return !hasFlag(/^-[a-zA-Z]*i|^--in-place/)
    case 'sort':
      return !hasFlag(/^-o$|^--output/) && !args.some((a, k) => k > 0 && args[k - 1] === '-o')
    case 'uniq':
      return positionals(args).length <= 1
    case 'xxd':
      return positionals(args).length <= 1
    case 'yq':
      return !hasFlag(/^-i$|^--inplace$/)
    case 'tree':
      return !hasFlag(/^-o$/)
    case 'date':
      return positionals(args).every((a) => a.startsWith('+'))
    case 'hostname':
      return positionals(args).length === 0
    case 'env':
      return args.length === 0
    case 'top':
      return args.includes('-l')
    case 'git':
      return gitReadOnly(args)
    case 'node':
      return versionOnly(args, new Set(['-v', '--version']))
    case 'npm':
      return (
        versionOnly(args, VERSION_FLAGS) ||
        ['ls', 'list', 'll', 'la', 'view', 'info', 'show', 'outdated', 'explain', 'why'].includes(args[0])
      )
    case 'npx':
      return versionOnly(args, VERSION_FLAGS)
    case 'pnpm':
      return versionOnly(args, VERSION_FLAGS) || ['ls', 'list', 'outdated', 'why'].includes(args[0])
    case 'yarn':
      return versionOnly(args, VERSION_FLAGS)
    case 'bun':
      return versionOnly(args, VERSION_FLAGS)
    case 'python':
    case 'python3':
      return versionOnly(args, new Set(['--version', '-V']))
    case 'pip':
    case 'pip3':
      return versionOnly(args, VERSION_FLAGS) || ['list', 'show', 'freeze', 'check'].includes(args[0])
    case 'cargo':
      return versionOnly(args, VERSION_FLAGS) || ['metadata', 'tree'].includes(args[0])
    case 'go':
      return ['version', 'env', 'list'].includes(args[0])
    case 'rustc':
      return versionOnly(args, VERSION_FLAGS)
    case 'tsc':
      return versionOnly(args, new Set(['-v', '--version']))
    default:
      return false
  }
}

/**
 * Is the whole command line read-only? True only if it splits into at least
 * one simple command and every one of them (substitutions included) is
 * read-only. Empty input → false.
 */
/**
 * Investigation commands a READ-ONLY turn may still run: every simple
 * command is read-only OR a check (tests, type-check, lint — the commands a
 * plan needs to reproduce a failure), with no mutating redirect and no
 * elevation. `npm test` reproduces; `npm run build` and `git push` do not.
 */
const CHECK_LABELS = new Set(['Run tests', 'Type-check', 'Lint'])

/**
 * A check that also REWRITES the files it checks: `eslint --fix`,
 * `ruff check --fix`, `cargo clippy --fix`, `jest -u` (which overwrites every
 * `__snapshots__` file it disagrees with), or a package script whose name says
 * so (`npm run lint:fix`). The approval card still calls it "Lint" or "Run
 * tests" — that is what the command IS — but a read-only turn must not run it,
 * so the investigation gate asks this separately from the label.
 *
 * Spelled out rather than pattern-matched, because a short flag means different
 * things to different tools and a read-only turn still has to be able to run
 * ordinary checks: `-i` is jest's `--runInBand`, `-w` is a watch flag for tsc
 * and vitest. Neither writes anything, and neither belongs here.
 */
const FIX_FLAG_RE =
  /^(--fix|--fix-only|--fix-all|--unsafe-fixes|--apply|--write|--in-place|-u|--update|--update-snapshot|--update-snapshots|--updateSnapshot|--snapshot-update)$/
/** `fix`, `lint:fix`, `fix:all` — but not `fixtures` or `fixup`. */
const FIX_SCRIPT_RE = /(^|[:._-])(fix|write)([:._-]|$)/
function rewritesWhileChecking(cmd) {
  const tokens = unwrapRunner(cmd.tokens)
  const script = packageScript(tokens)
  if (script !== null && FIX_SCRIPT_RE.test(script)) return true
  return tokens.slice(1).some((a) => FIX_FLAG_RE.test(a))
}

// Inline evaluation probes (`node -e`, `node -p`, `python3 -c`, `ruby -e`,
// or an interpreter fed by heredoc / here-string) are how a plan reproduces
// a behaviour without touching the repo. They pass when the program text
// shows no sign of writing, deleting, spawning or networking; anything
// ambiguous stays mutating. Detection looks at HOW a write API is reached —
// a member access (`fs.writeFileSync`), a destructured import, a bracket
// lookup or a mutating module — so a program that merely mentions a word
// like `truncate` or `rename` (a function under test, a string) still counts
// as a probe.
const EVAL_HEADS = new Set(['node', 'nodejs', 'bun', 'deno', 'python', 'python3', 'ruby', 'php', 'perl'])
const EVAL_FLAGS = new Set(['-e', '--eval', '-p', '--print', '-c'])
/**
 * `-r` means "run this code" for php alone. For node and ruby it is a module
 * PRELOAD — `node -r ./setup.js` makes the interpreter execute that FILE — so
 * reading it as an inline probe would let a read-only turn run a script.
 */
const EVAL_FLAGS_BY_HEAD = { php: new Set(['-r']) }
const WRITE_API_NAMES =
  'writeFile|writeFileSync|appendFile|appendFileSync|unlink|unlinkSync|rm|rmSync|rmdir|rmdirSync|mkdir|mkdirSync|mkdtemp|mkdtempSync|rename|renameSync|copyFile|copyFileSync|cp|cpSync|createWriteStream|truncate|truncateSync|ftruncate|ftruncateSync|chmod|chmodSync|chown|chownSync|symlink|symlinkSync|link|linkSync|utimes|utimesSync|writeSync|openSync|execSync|execFile|execFileSync|spawn|spawnSync|fork|write_text|write_bytes|rmtree|removedirs|makedirs|touch|check_output|check_call|Popen'
// Modules whose destructured exports mutate; a bare `truncate(` or `rename(`
// imported from the project's own files is the code under test, not a write.
const WRITE_MODULES = '(?:node:)?(?:fs|fs/promises|child_process|fs-extra|graceful-fs|worker_threads)'
const EVAL_WRITE_RES = [
  // member access on any receiver: fs.writeFileSync, fsp.rm, Path(x).write_text, cp.execSync
  new RegExp(`\\.(?:${WRITE_API_NAMES})\\b`),
  // bracket lookup: fs['writeFileSync']
  new RegExp(`\\[\\s*['"](?:${WRITE_API_NAMES})['"]\\s*\\]`),
  // destructured from a mutating module: const { writeFileSync } = require('fs'); import { rm } from 'node:fs/promises'
  new RegExp(
    `\\{[^}]*\\b(?:${WRITE_API_NAMES})\\b[^}]*\\}\\s*(?:=\\s*(?:await\\s+)?(?:require|import)\\s*\\(\\s*['"]${WRITE_MODULES}['"]|from\\s*['"]${WRITE_MODULES}['"])`
  ),
  // python: from os import remove; from subprocess import run
  /\bfrom\s+(?:os|os\.path|shutil|subprocess|pathlib|socket|urllib[\w.]*|requests)\s+import\b/,
  // modules and globals that only exist to mutate, spawn or talk to the network
  /\b(?:child_process|worker_threads|subprocess|shutil|urllib|requests\.|socket\b|dgram|execa|shelljs|zx|cross-spawn|FileUtils|file_put_contents|passthru|shell_exec|proc_open)\b/,
  /\b(?:http|https|net|tls|http2)\s*\.\s*(?:request|get|post|createServer|createConnection|connect|Server)\b/,
  /\bfetch\s*\(/,
  /\bprocess\s*\.\s*kill\b/,
  /\bos\s*\.\s*(?:remove|rename|replace|unlink|rmdir|removedirs|mkdir|makedirs|system|popen|chmod|chown|symlink|link|truncate|kill|exec[lv]p?e?)\b/,
  /\bBun\s*\.\s*(?:write|spawn|spawnSync|\$)\b/,
  /\bDeno\s*\.\s*(?:write|writeFile|writeTextFile|remove|rename|mkdir|create|run|Command|open|chmod|symlink|link|truncate|copyFile)\w*\b/,
  /\b(?:File|IO|Dir)\s*\.\s*(?:write|delete|rename|open|unlink|mkdir|rmdir|binwrite)\b/,
  // python open() with a writing mode as the second argument
  /\bopen\s*\([^()]*,\s*(?:mode\s*=\s*)?['"][^'"]*[wax+][^'"]*['"]/,
  // a program assembled from a shell substitution cannot be inspected
  /\$\(/
]
// php and perl reach the filesystem and processes through free functions.
const EVAL_WRITE_FREE_FN = /(?<![.\w$])(?:unlink|mkdir|rmdir|rename|copy|system|exec|fwrite|fopen|popen|open|opendir|symlink|link|chmod|chown|touch|truncate|kill)\s*\(/
const FREE_FN_HEADS = new Set(['php', 'perl'])
function evalProgram(c) {
  const args = c.args ?? []
  const headFlags = EVAL_FLAGS_BY_HEAD[c.head]
  const idx = args.findIndex((a) => EVAL_FLAGS.has(a) || headFlags?.has(a) === true)
  if (idx !== -1) {
    // A script FILE argument before the flag (node script.js -e) is not a probe.
    if (args.slice(0, idx).some((a) => !a.startsWith('-') && /\.(js|mjs|cjs|ts|py|rb|php|pl)$/.test(a))) return null
    return args.slice(idx + 1).join(' ')
  }
  // No eval flag: the program may arrive on stdin (`node --input-type=module
  // <<'EOF'`, `python3 - <<EOF`, `node <<< 'code'`). Any positional other
  // than `-` is a script file, which is not a probe.
  if (args.some((a) => a !== '-' && !a.startsWith('-'))) return null
  const fed = (c.redirects ?? []).filter((r) => r.op === '<<' || r.op === '<<-' || r.op === '<<<')
  if (fed.length !== 1) return null
  const r = fed[0]
  return r.op === '<<<' ? r.target : typeof r.body === 'string' ? r.body : null
}
function isEvalProbe(c) {
  if (!EVAL_HEADS.has(c.head)) return false
  const program = evalProgram(c)
  if (program === null || !program.trim()) return false
  if (EVAL_WRITE_RES.some((re) => re.test(program))) return false
  return !(FREE_FN_HEADS.has(c.head) && EVAL_WRITE_FREE_FN.test(program))
}
export function isInvestigation(command, opts = {}) {
  const list = splitCommands(command, opts)
  if (list.length === 0) return false
  return list.every((c) => {
    // Elevation and a mutating redirect disqualify a segment BEFORE anything
    // else: a headless segment is still a write when it carries one, so
    // `> ~/.zshrc` and `ls && > file` must not reach the `!c.head` pass below.
    if (c.elevated || c.mutatingRedirect) return false
    if (!c.head) return true
    if (isReadOnlyCommand(c)) return true
    if (isEvalProbe(c)) return true
    if (rewritesWhileChecking(c)) return false
    return CHECK_LABELS.has(describeOne(c).label)
  })
}

export function isReadOnly(command, opts = {}) {
  const list = splitCommands(command, opts)
  if (list.length === 0) return false
  return list.every((c) => isReadOnlyCommand(c))
}

// ---------------------------------------------------------------------------
// describeCommand — labels for the approval card
// ---------------------------------------------------------------------------

// Semantics identical to the shell plugin's describeShellAction() — copied verbatim.
export const HIGH_RISK_RE =
  /\brm\s+(-rf|--recursive)|\bmkfs|\bdd\s+if=|chmod\s+777|curl[^|]*\|\s*(bash|sh|zsh)|:\(\)\s*\{\s*:\|:|shutdown|sudo\s+|git\s+push\s+.*--force|npm\s+publish/i
export const MEDIUM_RISK_RE = /\b(npm|pip|brew|apt|dnf|cargo|gem)\s+install\b|git\s+push\b|docker\s+rm\b|rm\s+/i

const RUNNER_HEADS = new Set(['npx', 'bunx', 'pnpx'])

/** `npx vite` → ['vite'], `pnpm dlx x` → ['x'], `pnpm exec x` → ['x']; otherwise tokens unchanged. */
function unwrapRunner(tokens) {
  const [head, second] = tokens
  if (RUNNER_HEADS.has(head)) {
    const rest = dropFlags(tokens.slice(1), new Set(['-p', '--package', '-c', '--call']))
    return rest.length ? rest : tokens
  }
  if ((head === 'pnpm' || head === 'yarn' || head === 'npm') && (second === 'dlx' || second === 'exec')) {
    return tokens.length > 2 ? tokens.slice(2) : tokens
  }
  if (head === 'bun' && second === 'x') return tokens.length > 2 ? tokens.slice(2) : tokens
  return tokens
}

const SCRIPT_RUNNERS = new Set(['npm', 'pnpm', 'yarn', 'bun'])

/** For `npm run X`, `npm test`, `pnpm X`, `yarn X`, `bun X` — the script name or null. */
function packageScript(tokens) {
  const [head, second, third] = tokens
  if (!SCRIPT_RUNNERS.has(head) || !second) return null
  if (second === 'run' || second === 'run-script') {
    if (!third) return null
    return third.startsWith('-') ? null : third
  }
  if (second === 'test' || second === 't' || second === 'tst') return 'test'
  if (second === 'start') return 'start'
  if (head !== 'npm' && !second.startsWith('-')) {
    // pnpm/yarn/bun run scripts without `run`; exclude their own subcommands
    const builtin = new Set([
      'install',
      'i',
      'add',
      'remove',
      'rm',
      'uninstall',
      'update',
      'up',
      'upgrade',
      'ls',
      'list',
      'why',
      'outdated',
      'dlx',
      'x',
      'exec',
      'create',
      'init',
      'link',
      'unlink',
      'publish',
      'pack',
      'cache',
      'config',
      'env',
      'setup',
      'store',
      'audit',
      'licenses',
      'workspace',
      'workspaces',
      'set',
      'version',
      'info',
      'bin',
      'global',
      'import',
      'patch',
      'patch-commit',
      'deploy',
      'fetch',
      'prune',
      'rebuild',
      'root',
      'server',
      'pm',
      'repl',
      'build',
      'test'
    ])
    if (!builtin.has(second)) return second
  }
  return null
}

const PRIORITY = {
  destructive: 5,
  elevated: 4,
  network: 3,
  family: 3, // test/typecheck/lint/format/build/dev/install
  file: 2,
  generic: 1,
  trivial: 0
}

/** Returns { label, priority, impact? } for one simple command. */
function describeOne(cmd) {
  const tokens = unwrapRunner(cmd.tokens)
  const [head, a1, a2] = tokens
  const args = tokens.slice(1)
  const lower = head.toLowerCase()
  const has = (name) => args.includes(name)
  const script = packageScript(tokens)

  if (lower === 'rm') {
    const recursive = args.some((a) => a === '--recursive' || /^-[a-zA-Z]*[rR]/.test(a))
    if (recursive) {
      return {
        label: 'Delete directory recursively',
        priority: PRIORITY.destructive,
        impact: 'Permanently deletes files. This cannot be undone.'
      }
    }
    return { label: 'Delete files', priority: PRIORITY.file }
  }

  // Package-script families
  if (script !== null) {
    if (/^test/.test(script) || script === 'tests') return { label: 'Run tests', priority: PRIORITY.family }
    if (/^(typecheck|type-check|tsc|check-types|types)/.test(script)) return { label: 'Type-check', priority: PRIORITY.family }
    if (/^lint/.test(script)) return { label: 'Lint', priority: PRIORITY.family }
    if (/^(format|fmt|prettier)/.test(script)) return { label: 'Format', priority: PRIORITY.family }
    if (/^build/.test(script)) return { label: 'Build', priority: PRIORITY.family }
    if (/^(dev|start|serve|preview)$/.test(script) || /^(dev|start|serve):/.test(script)) {
      return { label: 'Start dev server', priority: PRIORITY.family }
    }
    if (head === 'npm') return { label: 'Run npm script', priority: PRIORITY.generic }
    return { label: 'Run package script', priority: PRIORITY.generic }
  }

  // Install
  if (head === 'npm' && (a1 === 'install' || a1 === 'i' || a1 === 'ci' || a1 === 'add')) {
    return { label: 'Install npm dependencies', priority: PRIORITY.family }
  }
  if ((head === 'pnpm' || head === 'yarn' || head === 'bun') && ['install', 'i', 'add', 'ci'].includes(a1)) {
    return { label: 'Install dependencies', priority: PRIORITY.family }
  }
  if ((head === 'pip' || head === 'pip3') && a1 === 'install') return { label: 'Install Python packages', priority: PRIORITY.family }
  if ((head === 'python' || head === 'python3') && a1 === '-m' && a2 === 'pip' && tokens[3] === 'install') {
    return { label: 'Install Python packages', priority: PRIORITY.family }
  }
  if (head === 'brew' && a1 === 'install') return { label: 'Install with Homebrew', priority: PRIORITY.family }
  if (
    (head === 'cargo' && a1 === 'add') ||
    (head === 'go' && a1 === 'get') ||
    (head === 'poetry' && (a1 === 'add' || a1 === 'install')) ||
    (head === 'gem' && a1 === 'install') ||
    (head === 'bundle' && a1 === 'install') ||
    ((head === 'apt' || head === 'apt-get' || head === 'dnf' || head === 'yum') && a1 === 'install') ||
    (head === 'uv' && (a1 === 'add' || a1 === 'sync' || a1 === 'pip')) ||
    (head === 'composer' && (a1 === 'install' || a1 === 'require'))
  ) {
    return { label: 'Install dependencies', priority: PRIORITY.family }
  }

  // Tests
  if (
    head === 'vitest' ||
    head === 'jest' ||
    head === 'mocha' ||
    head === 'pytest' ||
    head === 'ava' ||
    head === 'tap' ||
    ((head === 'python' || head === 'python3') && a1 === '-m' && (a2 === 'pytest' || a2 === 'unittest')) ||
    (head === 'cargo' && a1 === 'test') ||
    (head === 'go' && a1 === 'test') ||
    (head === 'swift' && a1 === 'test') ||
    (head === 'xcodebuild' && has('test')) ||
    (head === 'dotnet' && a1 === 'test') ||
    (head === 'bun' && a1 === 'test') ||
    (head === 'deno' && a1 === 'test') ||
    (head === 'playwright' && a1 === 'test') ||
    (head === 'cypress' && a1 === 'run')
  ) {
    return { label: 'Run tests', priority: PRIORITY.family }
  }

  // Type-check
  if (head === 'tsc') {
    if (has('-b') || has('--build')) return { label: 'Build', priority: PRIORITY.family }
    return { label: 'Type-check', priority: PRIORITY.family }
  }
  if (head === 'mypy' || head === 'pyright') return { label: 'Type-check', priority: PRIORITY.family }

  // Lint
  if (
    head === 'eslint' ||
    head === 'flake8' ||
    head === 'golangci-lint' ||
    head === 'pylint' ||
    (head === 'biome' && a1 === 'lint') ||
    (head === 'ruff' && a1 === 'check') ||
    (head === 'cargo' && a1 === 'clippy') ||
    (head === 'go' && a1 === 'vet')
  ) {
    return { label: 'Lint', priority: PRIORITY.family }
  }

  // Format
  if (
    head === 'prettier' ||
    head === 'black' ||
    head === 'gofmt' ||
    head === 'rustfmt' ||
    head === 'isort' ||
    (head === 'ruff' && a1 === 'format') ||
    (head === 'cargo' && a1 === 'fmt') ||
    (head === 'go' && a1 === 'fmt') ||
    (head === 'biome' && a1 === 'format')
  ) {
    return { label: 'Format', priority: PRIORITY.family }
  }

  // Dev servers (checked before Build so `vite` alone lands here)
  if (
    (head === 'vite' && a1 !== 'build') ||
    (head === 'next' && (a1 === 'dev' || a1 === 'start')) ||
    head === 'nodemon' ||
    head === 'uvicorn' ||
    (head === 'flask' && a1 === 'run') ||
    (head === 'rails' && (a1 === 's' || a1 === 'server')) ||
    head === 'webpack-dev-server' ||
    (head === 'webpack' && (has('serve') || has('--watch') || has('-w'))) ||
    (head === 'ng' && a1 === 'serve') ||
    (head === 'expo' && a1 === 'start') ||
    (head === 'react-native' && a1 === 'start') ||
    head === 'http-server' ||
    head === 'live-server' ||
    ((head === 'python' || head === 'python3') && a1 === '-m' && (a2 === 'http.server' || a2 === 'SimpleHTTPServer'))
  ) {
    return { label: 'Start dev server', priority: PRIORITY.family }
  }

  // Build
  if (
    (head === 'cargo' && a1 === 'build') ||
    (head === 'go' && a1 === 'build') ||
    head === 'make' ||
    head === 'xcodebuild' ||
    (head === 'swift' && a1 === 'build') ||
    (head === 'dotnet' && a1 === 'build') ||
    head === 'gradle' ||
    head === './gradlew' ||
    head === 'gradlew' ||
    head === 'mvn' ||
    (head === 'vite' && a1 === 'build') ||
    (head === 'next' && a1 === 'build') ||
    head === 'webpack' ||
    head === 'esbuild' ||
    head === 'rollup' ||
    (head === 'turbo' && (a1 === 'build' || (a1 === 'run' && a2 === 'build'))) ||
    (head === 'nx' && a1 === 'build') ||
    head === 'cmake' ||
    head === 'ninja' ||
    (head === 'bazel' && a1 === 'build') ||
    (head === 'electron-vite' && a1 === 'build') ||
    (head === 'electron-builder')
  ) {
    return { label: 'Build', priority: PRIORITY.family }
  }

  // git
  if (head === 'git') {
    let j = 0
    while (j < args.length && args[j].startsWith('-')) j += GIT_GLOBAL_ARG_FLAGS.has(args[j]) ? 2 : 1
    const sub = args[j]
    const rest = args.slice(j + 1)
    switch (sub) {
      case 'status':
        return { label: 'Check git status', priority: PRIORITY.trivial }
      case 'diff':
        return { label: 'Show git diff', priority: PRIORITY.trivial }
      case 'log':
        return { label: 'Show git log', priority: PRIORITY.trivial }
      case 'push': {
        const force = rest.some((a) => a === '--force' || a === '-f' || a.startsWith('--force-with-lease'))
        return force
          ? {
              label: 'Push commits to remote',
              priority: PRIORITY.destructive,
              impact: 'Force-pushes the branch — may overwrite remote history.'
            }
          : { label: 'Push commits to remote', priority: PRIORITY.network }
      }
      case 'pull':
        return { label: 'Pull from remote', priority: PRIORITY.network }
      case 'fetch':
        return { label: 'Fetch from remote', priority: PRIORITY.network }
      case 'clone':
        return { label: 'Clone repository', priority: PRIORITY.network }
      case 'commit':
        return { label: 'Create git commit', priority: PRIORITY.file }
      case 'add':
        return { label: 'Stage changes', priority: PRIORITY.file }
      case 'checkout':
      case 'switch':
        return { label: 'Switch git branch', priority: PRIORITY.file }
      case 'stash':
        return { label: 'Stash changes', priority: PRIORITY.file }
      case 'reset':
        return { label: 'Reset git state', priority: PRIORITY.file }
      case 'rebase':
        return { label: 'Rebase branch', priority: PRIORITY.file }
      case 'merge':
        return { label: 'Merge branch', priority: PRIORITY.file }
      default:
        return { label: 'Run git command', priority: PRIORITY.generic }
    }
  }

  // Files / system (existing verb map)
  switch (lower) {
    case 'ls':
      return { label: 'List files', priority: PRIORITY.trivial }
    case 'pwd':
      return { label: 'Print working directory', priority: PRIORITY.trivial }
    case 'cat':
      return { label: 'Print file contents', priority: PRIORITY.trivial }
    case 'head':
    case 'tail':
    case 'less':
    case 'more':
      return { label: 'Print file contents', priority: PRIORITY.trivial }
    case 'echo':
    case 'printf':
      return { label: 'Print text', priority: PRIORITY.trivial }
    case 'open':
    case 'xdg-open':
    case 'start':
      return { label: 'Open file', priority: PRIORITY.file }
    case 'cd':
    case 'pushd':
    case 'popd':
      return { label: 'Change directory', priority: PRIORITY.trivial }
    case 'cp':
      return { label: 'Copy files', priority: PRIORITY.file }
    case 'mv':
      return { label: 'Move/rename files', priority: PRIORITY.file }
    case 'mkdir':
      return { label: 'Create directory', priority: PRIORITY.file }
    case 'touch':
      return { label: 'Create file', priority: PRIORITY.file }
    case 'chmod':
    case 'chown':
      return { label: 'Change file permissions', priority: PRIORITY.file }
    case 'grep':
    case 'rg':
    case 'ag':
    case 'ack':
      return { label: 'Search code', priority: PRIORITY.trivial }
    case 'find':
      return { label: 'Find files', priority: PRIORITY.trivial }
    case 'docker':
    case 'docker-compose':
    case 'podman':
      return { label: 'Run Docker command', priority: PRIORITY.generic }
    case 'curl':
    case 'wget':
      return { label: 'Make HTTP request', priority: PRIORITY.network }
    case 'kill':
    case 'killall':
    case 'pkill':
      return { label: 'Kill process', priority: PRIORITY.file }
    case 'ps':
      return { label: 'List processes', priority: PRIORITY.trivial }
    default:
      return { label: 'Run shell command', priority: PRIORITY.generic }
  }
}

/**
 * Describe a command line for the approval card.
 * @returns {{ label: string, risk: 'low'|'medium'|'high', impact?: string, heads: string[] }}
 */
export function describeCommand(command, opts = {}) {
  const cmd = String(command ?? '').trim()
  let risk = 'low'
  if (HIGH_RISK_RE.test(cmd)) risk = 'high'
  else if (MEDIUM_RISK_RE.test(cmd)) risk = 'medium'

  const list = splitCommands(cmd, opts)
  const heads = list.map((c) => c.head).filter(Boolean)

  const descs = list.filter((c) => c.head).map((c) => describeOne(c))
  let best = null
  for (const d of descs) if (!best || d.priority > best.priority) best = d
  const label = best ? best.label : 'Run shell command'

  // Impact precedence mirrors describeShellAction: rm -rf, then sudo, then force-push.
  const rmImpact = descs.find((d) => d.impact && d.label === 'Delete directory recursively')?.impact
  const forceImpact = descs.find((d) => d.impact && d.label === 'Push commits to remote')?.impact
  const elevated = /sudo\s+/.test(cmd) || list.some((c) => c.elevated)
  const impact =
    rmImpact ??
    (elevated ? 'Runs with elevated privileges (will prompt for your password via system dialog).' : undefined) ??
    forceImpact

  const out = { label, risk, heads }
  if (impact) out.impact = impact
  return out
}

// ---------------------------------------------------------------------------
// looksLikeWatcher — commands that do not exit on their own
// ---------------------------------------------------------------------------

const HELP_OR_VERSION = new Set(['--help', '-h', '--version'])

function watcherOne(cmd) {
  const tokens = unwrapRunner(cmd.tokens)
  const [head, a1, a2] = tokens
  const args = tokens.slice(1)
  if (!head) return false
  if (args.some((a) => HELP_OR_VERSION.has(a))) return false
  const has = (name) => args.includes(name)
  const script = packageScript(tokens)

  if (script !== null) {
    if (/^(dev|start|serve|preview)$/.test(script) || /^(dev|start|serve):/.test(script) || /^watch/.test(script)) return true
    if (head === 'bun' && (has('--watch') || has('--hot'))) return true
    return false
  }
  if (head === 'bun' && (has('--watch') || has('--hot'))) return true

  switch (head) {
    case 'vite':
      return a1 !== 'build' && a1 !== 'optimize'
    case 'next':
      return a1 === 'dev' || a1 === 'start'
    case 'nodemon':
    case 'webpack-dev-server':
    case 'uvicorn':
    case 'http-server':
    case 'serve':
    case 'live-server':
    case 'metro':
    case 'air':
    case 'ngrok':
    case 'gunicorn':
    case 'hypercorn':
      return true
    case 'webpack':
      return has('--watch') || has('-w') || has('serve')
    case 'tsc':
      return has('--watch') || has('-w')
    case 'vitest':
      // vitest defaults to watch mode outside CI; `run`/`--run` is the one-shot form
      return !(a1 === 'run' || a1 === 'list' || a1 === 'init' || has('--run') || has('--watch=false'))
    case 'jest':
      return has('--watch') || has('--watchAll') || args.some((a) => a.startsWith('--watch'))
    case 'flask':
      return a1 === 'run'
    case 'rails':
      return a1 === 's' || a1 === 'server'
    case 'python':
    case 'python3':
      return a1 === '-m' && (a2 === 'http.server' || a2 === 'SimpleHTTPServer')
    case 'ng':
      return a1 === 'serve'
    case 'expo':
      return a1 === 'start'
    case 'react-native':
      return a1 === 'start'
    case 'tail':
      return has('-f') || has('-F') || has('--follow') || args.some((a) => /^-[a-zA-Z]*[fF]/.test(a) && a !== '--')
    case 'watch':
      return true
    case 'docker':
      return a1 === 'compose' && a2 === 'up' && !has('-d') && !has('--detach')
    case 'docker-compose':
      return a1 === 'up' && !has('-d') && !has('--detach')
    case 'cargo':
      return a1 === 'watch'
    case 'cloudflared':
      return a1 === 'tunnel'
    case 'top':
      return !has('-l')
    case 'htop':
      return true
    default:
      return false
  }
}

/**
 * True when any simple command in the line is a server/watcher that does not
 * exit on its own. `--help` / `-h` / `--version` anywhere in that command → false.
 * Backgrounding (`&`) does not change the answer; check `.background` on the
 * split command if the caller cares.
 */
export function looksLikeWatcher(command, opts = {}) {
  const list = splitCommands(command, opts)
  return list.some((c) => !c.fromSubstitution && watcherOne(c))
}
