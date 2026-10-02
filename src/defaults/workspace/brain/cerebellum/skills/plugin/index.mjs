import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

/**
 * skills — Wolffish manages its own capabilities.
 *
 * Tools to introspect and reshape the cerebellum at runtime: list every
 * skill, search by keyword, enable/disable one, delete a non-official one,
 * and — the headline — author a brand-new skill (pure-procedure, plugin, or
 * plugin+npm) and load it live.
 *
 * Everything that touches shared state (the disabled list in config.json,
 * the official-capability guard, the live reload) is routed through the
 * `host` bridge injected at init, NOT done by hand here. That bridge is the
 * same code path the Cerebellum settings panel uses, so there is exactly one
 * implementation of "disable a skill" / "delete a skill" / "reload from
 * disk", and the agent and the UI can never drift apart.
 */

// The capability's own name — guarded against self-disable / self-delete so
// Wolffish can't strand itself without the very tools it needs to recover.
const SELF = 'skills'

// Capability-management bridge, injected at init by the main process. Every
// shared-state mutation (config writes, official guards, live reload) goes
// through it so the agent and the settings UI never diverge.
let host

const toolDefinitions = [
  {
    name: 'skill_list',
    description:
      'List every skill (capability) Wolffish currently has — name, description, whether it is enabled, official (built-in, undeletable), and how many tools it exposes. Use this to see what you can already do before deciding to build something new.',
    parameters: { type: 'object', properties: {}, required: [] }
  },
  {
    name: 'skill_search',
    description:
      'Search your skills by keyword. Matches against each skill name, description, trigger keywords, and tool names. Use this to check whether a capability for some task already exists before creating a new one.',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Keyword(s) to look for, case-insensitive (e.g. "pdf", "screenshot", "weather").'
        }
      },
      required: ['query']
    }
  },
  {
    name: 'skill_read_source',
    description:
      "Read a skill's source code — its SKILL.md, plugin/index.mjs, package.json, and any bundled files (e.g. a Python worker). Use this to understand how a skill is written before amending it, or to learn from an official skill (e.g. read speech-to-text to see the Python-worker pattern). Call with just `name` for an overview (file tree + key files), or add `file` to read one file in full.",
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Exact skill name (as shown by skill_list).' },
        file: {
          type: 'string',
          description:
            'Optional. A specific file to read in full, relative to the skill folder (e.g. "plugin/index.mjs", "plugin/worker.py", "SKILL.md"). Omit for an overview of the whole skill.'
        }
      },
      required: ['name']
    }
  },
  {
    name: 'skill_enable',
    description:
      'Re-enable a previously disabled skill. Persists across restarts and takes effect on your next turn.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The exact skill name (as shown by skill_list).' }
      },
      required: ['name']
    }
  },
  {
    name: 'skill_disable',
    description:
      "Disable a skill so its tools are hidden from you and stop executing. Reversible with skill_enable. Works on official skills too (to mute a capability), but you cannot disable the 'skills' capability itself.",
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The exact skill name (as shown by skill_list).' }
      },
      required: ['name']
    }
  },
  {
    name: 'skill_delete',
    description:
      'Permanently delete a NON-OFFICIAL skill — removes its folder from disk. Official (built-in) skills are protected and cannot be deleted. Irreversible; prefer skill_disable if you only want to mute it.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The exact name of the user/agent-created skill to delete.' }
      },
      required: ['name']
    }
  },
  {
    name: 'skill_create',
    description:
      'Author a brand-new skill for yourself and load it live — anything from a pure procedure (SKILL.md only) to plugin tools (index.mjs), npm dependencies (package.json), and bundled workers in other languages (extra_files). Read skill_read_source("skills") FIRST for the exact format and golden rules. The skill is validated, written under brain/cerebellum/, stamped author: wolffish, and reloaded — its tools are callable on your very next step, and it stays marked UNTESTED until one of them succeeds for real: test every tool in this same turn (fix + skill_reload until it passes) before telling the user it is ready.',
    parameters: {
      type: 'object',
      properties: {
        skill_md: {
          type: 'string',
          description:
            'The complete SKILL.md file contents: a YAML frontmatter block (--- delimited) with at least `name` and `description`, followed by a markdown body. Declare any `tools:` here — that is what you (the model) will see.'
        },
        plugin_code: {
          type: 'string',
          required: false,
          description:
            'Optional. Full contents of plugin/index.mjs — an ES module that `export default`s a plugin object { name, tools, execute }. REQUIRED whenever the frontmatter declares any tools, since tools cannot fire without code to back them.'
        },
        package_json: {
          type: 'string',
          required: false,
          description:
            'Optional. Full contents of package.json declaring npm dependencies (e.g. {"name":"wolffish-x","type":"module","dependencies":{"dayjs":"^1"}}). Installed lazily into the skill folder on first tool use. Only needed if your plugin imports npm packages.'
        },
        extra_files: {
          type: 'array',
          required: false,
          description:
            'Optional. Additional files to bundle in the skill folder, as an array of { "path": "<relative path>", "content": "<text>" }. Use for non-JS workers (e.g. {"path":"plugin/worker.py","content":"..."}), shell scripts, templates, or data. Paths are relative to the skill root; no absolute paths or "..". This is how you build complex, multi-language skills like the Python-backed speech tools.'
        }
      },
      required: ['skill_md']
    }
  },
  {
    name: 'skill_reload',
    description:
      'Re-scan brain/cerebellum/ from disk and reload all skills. Call this after editing an existing skill on disk (its SKILL.md or plugin code) so the changes take effect without an app restart. skill_create and skill_delete already reload for you.',
    parameters: { type: 'object', properties: {}, required: [] }
  }
]

// ---------------------------------------------------------------------------
// skill_list
// ---------------------------------------------------------------------------

async function listSkills() {
  if (!host) return missingHost()
  const caps = await host.listCapabilities()
  if (caps.length === 0) return { success: true, output: 'No skills are loaded.' }

  // Show user/agent-created skills first (the ones you can manage freely),
  // official ones after — same ordering the settings panel uses.
  const sorted = [...caps].sort((a, b) => {
    if (a.official !== b.official) return a.official ? 1 : -1
    return a.name.localeCompare(b.name)
  })

  const lines = [`## Skills (${caps.length})`, '']
  for (const c of sorted) {
    const tags = []
    if (c.official) tags.push('official')
    else if (c.wolffish) tags.push('wolffish-authored')
    else tags.push('custom')
    if (c.core) tags.push('core')
    if (c.wolffish && c.tested === false) tags.push('UNTESTED')
    if (!c.enabled) tags.push('disabled')
    if (c.status !== 'ok') tags.push(`error: ${c.error ?? 'unknown'}`)
    const toolCount = c.tools.length
    const toolNote = c.hasPlugin ? `${toolCount} tool${toolCount === 1 ? '' : 's'}` : 'no tools (procedure only)'
    lines.push(`- **${c.name}** [${tags.join(', ')}] — ${c.description || '(no description)'} · ${toolNote}`)
  }
  lines.push('')
  lines.push(
    'Legend: *custom* skills can be disabled or deleted; *official* skills can be disabled but not deleted; *core* skills are load-bearing and can be neither disabled nor deleted; *wolffish-authored* skills are ones you created yourself. UNTESTED marks a wolffish-authored skill that has not passed a real tool call since it was created or last edited — call its tools (fix + skill_reload until they succeed) to clear it.'
  )
  return { success: true, output: lines.join('\n') }
}

// ---------------------------------------------------------------------------
// skill_search
// ---------------------------------------------------------------------------

async function searchSkills(args) {
  if (!host) return missingHost()
  const query = typeof args?.query === 'string' ? args.query.trim().toLowerCase() : ''
  if (!query) return { success: false, error: 'skill_search: provide a non-empty query.' }
  const terms = query.split(/\s+/).filter(Boolean)

  const caps = await host.listCapabilities()
  const hits = []
  for (const c of caps) {
    const haystack = [
      c.name,
      c.description,
      c.triggers.join(' '),
      c.tools.map((t) => `${t.name} ${t.description}`).join(' ')
    ]
      .join(' ')
      .toLowerCase()
    if (terms.every((t) => haystack.includes(t))) hits.push(c)
  }

  if (hits.length === 0) {
    return {
      success: true,
      output: `No skill matches "${args.query}". You may need to create one — see the "skills" procedure, then call skill_create.`
    }
  }

  const lines = [`## ${hits.length} skill(s) matching "${args.query}"`, '']
  for (const c of hits) {
    const status = c.official ? 'official' : c.wolffish ? 'wolffish-authored' : 'custom'
    const en = c.enabled ? '' : ', disabled'
    lines.push(`- **${c.name}** [${status}${en}] — ${c.description || '(no description)'}`)
    const matchedTools = c.tools.filter((t) =>
      terms.every((term) => `${t.name} ${t.description}`.toLowerCase().includes(term))
    )
    for (const t of matchedTools.slice(0, 6)) {
      lines.push(`    - \`${t.name}\` — ${t.description}`)
    }
  }
  return { success: true, output: lines.join('\n') }
}

// ---------------------------------------------------------------------------
// skill_read_source
// ---------------------------------------------------------------------------

// Per-file cap when reading one file in full; smaller cap for files inlined in
// the overview so a big skill doesn't blow up a single response.
const SOURCE_FILE_CAP = 64 * 1024
const SOURCE_INLINE_CAP = 24 * 1024
const SOURCE_TREE_MAX = 200
// Key files surfaced inline in the overview, in priority order.
const SOURCE_KEY_FILES = [
  'SKILL.md',
  'plugin/index.mjs',
  'plugin/index.js',
  'plugin/index.cjs',
  'package.json'
]

async function readCapped(filePath, cap) {
  const buf = await fs.readFile(filePath)
  if (buf.length <= cap) return { text: buf.toString('utf8'), truncated: false }
  return { text: buf.subarray(0, cap).toString('utf8'), truncated: true }
}

function fenceLang(file) {
  if (file.endsWith('.md')) return 'markdown'
  if (file.endsWith('.json')) return 'json'
  if (file.endsWith('.py')) return 'python'
  if (file.endsWith('.sh')) return 'bash'
  return 'js'
}

async function readSource(args) {
  if (!host) return missingHost()
  const name = typeof args?.name === 'string' ? args.name.trim() : ''
  if (!name) return { success: false, error: 'skill_read_source: provide a skill name.' }
  const file = typeof args?.file === 'string' ? args.file.trim() : ''

  const caps = await host.listCapabilities()
  const cap = caps.find((c) => c.name === name)
  if (!cap) {
    return { success: false, error: `No skill named "${name}". Run skill_list to see exact names.` }
  }
  if (!cap.dir) {
    return {
      success: false,
      error: `"${name}" is a built-in in-process capability with no on-disk source to read.`
    }
  }

  // Confine every read to the skill's own folder — realpath both sides so an
  // in-folder symlink can't leak files from elsewhere.
  let root
  try {
    root = await fs.realpath(cap.dir)
  } catch {
    return { success: false, error: `Cannot access the source folder for "${name}".` }
  }

  // --- Single-file read --------------------------------------------------
  if (file) {
    if (path.isAbsolute(file) || file.split(/[\\/]/).includes('..')) {
      return {
        success: false,
        error: `skill_read_source: "file" must be a relative path inside the skill, with no "..".`
      }
    }
    let real
    try {
      real = await fs.realpath(path.join(root, file))
    } catch {
      return { success: false, error: `Not found in "${name}": ${file}` }
    }
    if (real !== root && !real.startsWith(root + path.sep)) {
      return { success: false, error: `skill_read_source: "${file}" escapes the skill folder.` }
    }
    const st = await fs.stat(real).catch(() => null)
    if (!st || !st.isFile()) return { success: false, error: `Not a file: ${file}` }
    const { text, truncated } = await readCapped(real, SOURCE_FILE_CAP)
    const note = truncated ? `\n\n(truncated at ${SOURCE_FILE_CAP / 1024}KB)` : ''
    return {
      success: true,
      output: `## ${name}/${file}\n\nPath (edit with file_write): ${real}\n\n\`\`\`${fenceLang(file)}\n${text}\n\`\`\`${note}`
    }
  }

  // --- Overview: file tree + key files inline ----------------------------
  const tree = []
  let count = 0
  async function walk(dir, prefix) {
    if (count >= SOURCE_TREE_MAX) return
    let entries
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    entries.sort((a, b) => {
      if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1
      return a.name.localeCompare(b.name)
    })
    for (const e of entries) {
      if (count >= SOURCE_TREE_MAX) {
        tree.push(`${prefix}… (more)`)
        return
      }
      // node_modules is lazily installed and huge — never list it. The
      // tested-state marker is runtime bookkeeping, not source.
      if (e.name === 'node_modules' || e.name === '.DS_Store' || e.name === '.wolffish-tested')
        continue
      const full = path.join(dir, e.name)
      if (e.isDirectory()) {
        tree.push(`${prefix}${e.name}/`)
        count++
        await walk(full, prefix + '  ')
      } else {
        let size = ''
        try {
          size = ` (${(await fs.stat(full)).size} B)`
        } catch {
          // size optional
        }
        tree.push(`${prefix}${e.name}${size}`)
        count++
      }
    }
  }
  await walk(root, '- ')

  const lines = [
    `## Source of skill "${name}"${cap.official ? ' (official — re-synced on launch; copy it, don\'t rely on edits)' : ''}`,
    '',
    `Folder (edit files here with file_write, then skill_reload): ${root}`,
    '',
    '### Files',
    ...tree
  ]

  for (const kf of SOURCE_KEY_FILES) {
    const p = path.join(root, kf)
    const st = await fs.stat(p).catch(() => null)
    if (!st || !st.isFile()) continue
    const { text, truncated } = await readCapped(p, SOURCE_INLINE_CAP)
    const note = truncated ? `\n(truncated — read in full with file: "${kf}")` : ''
    lines.push('', `### ${kf}`, '```' + fenceLang(kf), text, '```' + note)
  }

  lines.push(
    '',
    'Read any other file in full with `skill_read_source(name, file: "<relative path>")`. To amend a custom skill: `file_write` the change into its folder, then `skill_reload` and re-test.'
  )
  return { success: true, output: lines.join('\n') }
}

// ---------------------------------------------------------------------------
// skill_enable / skill_disable
// ---------------------------------------------------------------------------

async function setEnabled(args, enabled) {
  if (!host) return missingHost()
  const name = typeof args?.name === 'string' ? args.name.trim() : ''
  if (!name) return { success: false, error: `${enabled ? 'skill_enable' : 'skill_disable'}: provide a skill name.` }

  if (!enabled && name === SELF) {
    return {
      success: false,
      error: `Refusing to disable "${SELF}" — that would remove the very tools you use to manage skills. Disable individual skills instead.`
    }
  }

  const caps = await host.listCapabilities()
  const cap = caps.find((c) => c.name === name)
  if (!cap) {
    return {
      success: false,
      error: `No skill named "${name}". Run skill_list to see exact names.`
    }
  }
  if (!enabled && cap.core) {
    return {
      success: false,
      error: `"${name}" is a core capability and can't be disabled — it's load-bearing for Wolffish and stays on. Disable a non-core skill instead.`
    }
  }
  if (cap.enabled === enabled) {
    return { success: true, output: `Skill "${name}" is already ${enabled ? 'enabled' : 'disabled'}.` }
  }

  await host.setCapabilityEnabled(name, enabled)
  return {
    success: true,
    output: `Skill "${name}" ${enabled ? 'enabled' : 'disabled'}. ${
      enabled ? 'Its tools are available on your next turn.' : 'Its tools are now hidden.'
    }`
  }
}

// ---------------------------------------------------------------------------
// skill_delete
// ---------------------------------------------------------------------------

async function deleteSkill(args) {
  if (!host) return missingHost()
  const name = typeof args?.name === 'string' ? args.name.trim() : ''
  if (!name) return { success: false, error: 'skill_delete: provide a skill name.' }

  if (name === SELF) {
    return { success: false, error: `Refusing to delete "${SELF}" — it is a core capability.` }
  }

  const caps = await host.listCapabilities()
  const cap = caps.find((c) => c.name === name)
  if (!cap) {
    return { success: false, error: `No skill named "${name}". Run skill_list to see exact names.` }
  }
  if (cap.official) {
    return {
      success: false,
      error: `"${name}" is an official (built-in) skill and cannot be deleted. Use skill_disable to mute it instead.`
    }
  }

  const outcome = await host.deleteCapability(name)
  if (!outcome.ok) {
    return { success: false, error: outcome.error ?? `Failed to delete "${name}".` }
  }
  return { success: true, output: `Deleted skill "${name}" and reloaded. Its tools are gone.` }
}

// ---------------------------------------------------------------------------
// skill_create
// ---------------------------------------------------------------------------

async function createSkill(args) {
  if (!host) return missingHost()
  let skillMd = typeof args?.skill_md === 'string' ? args.skill_md : ''
  const pluginCode = typeof args?.plugin_code === 'string' ? args.plugin_code : ''
  const packageJsonRaw = args?.package_json
  const extraFiles = normalizeExtraFiles(args?.extra_files)
  if (extraFiles.error) return { success: false, error: extraFiles.error }

  if (!skillMd.trim()) {
    return { success: false, error: 'skill_create: skill_md is required (the full SKILL.md contents).' }
  }
  if (!skillMd.trimStart().startsWith('---')) {
    return {
      success: false,
      error:
        'skill_create: skill_md must begin with a YAML frontmatter block delimited by --- on its own lines (name + description at minimum).'
    }
  }

  // Every skill created through this tool is authored by Wolffish itself —
  // stamp the frontmatter so it shows the Wolffish badge (not Unknown) and
  // enters tested-state tracking (untested until its first successful call).
  // The stamp is the source of truth: any hand-written author is replaced.
  skillMd = setFrontmatterAuthor(skillMd, 'wolffish')

  // Tools register from the SKILL.md frontmatter `tools:` block — the plugin
  // code alone registers nothing. Rather than make the model duplicate its
  // tools by hand (the #1 papercut), we AUTO-DERIVE the frontmatter tools from
  // the plugin below when they're missing. That requires importing the plugin,
  // which we can't do before its npm deps are installed — so for skills WITH a
  // package.json, the frontmatter tools must be declared explicitly.
  const declaredToolCount = countFrontmatterTools(skillMd)
  const wantsPackageJson = packageJsonRaw != null && `${packageJsonRaw}`.trim() !== ''
  if (pluginCode.trim() && declaredToolCount === 0 && wantsPackageJson) {
    return {
      success: false,
      error:
        'You provided plugin_code (with npm dependencies) but the SKILL.md frontmatter declares no tools. For skills with a package.json the plugin can\'t be inspected before install, so list each tool in the frontmatter `tools:` block (name + parameters) yourself, then try again.'
    }
  }

  // Stage the new skill in a throwaway temp dir, then hand it to the host's
  // importer, which validates frontmatter + plugin + uniqueness and copies it
  // into brain/cerebellum/. Nothing lands in the workspace unless it passes.
  let staging = ''
  let hasPackageJson = false
  try {
    staging = await fs.mkdtemp(path.join(os.tmpdir(), 'wolffish-skill-create-'))
    await fs.writeFile(path.join(staging, 'SKILL.md'), skillMd, 'utf8')

    if (pluginCode.trim()) {
      const pluginDir = path.join(staging, 'plugin')
      await fs.mkdir(pluginDir, { recursive: true })
      await fs.writeFile(path.join(pluginDir, 'index.mjs'), pluginCode, 'utf8')
    }

    if (packageJsonRaw !== undefined && packageJsonRaw !== null && `${packageJsonRaw}`.trim()) {
      const pkgText =
        typeof packageJsonRaw === 'string' ? packageJsonRaw : JSON.stringify(packageJsonRaw, null, 2)
      // Validate it parses so we never write a package.json that breaks
      // `npm install` later, on first use, far from this call.
      try {
        JSON.parse(pkgText)
      } catch (err) {
        return {
          success: false,
          error: `skill_create: package_json is not valid JSON: ${err instanceof Error ? err.message : String(err)}`
        }
      }
      await fs.writeFile(path.join(staging, 'package.json'), pkgText, 'utf8')
      hasPackageJson = true
    }

    // Bundle any extra files (Python workers, shell scripts, templates, data)
    // at their relative paths inside the skill folder. Guarded against path
    // traversal so a crafted path can never write outside the staging dir.
    for (const file of extraFiles.files) {
      const dest = path.join(staging, file.path)
      const rel = path.relative(staging, dest)
      if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) {
        return { success: false, error: `skill_create: unsafe extra_files path "${file.path}".` }
      }
      await fs.mkdir(path.dirname(dest), { recursive: true })
      await fs.writeFile(dest, file.content, 'utf8')
    }

    // Smoke-test the plugin BEFORE it lands in the workspace: import it and
    // verify it exports a usable shape, so a malformed plugin (the classic
    // `tools: { name: { handler } }` instead of `tools: [...] + execute()`, or
    // a syntax error) is rejected here with a precise message — not discovered
    // later as a cryptic "Failed to load plugin" on first call. Skipped when
    // there's a package.json, since its npm deps aren't installed yet and the
    // import would spuriously fail.
    let autoDerivedTools = 0
    if (pluginCode.trim() && !hasPackageJson) {
      const smoke = await smokeTestPlugin(path.join(staging, 'plugin', 'index.mjs'))
      if (!smoke.ok) {
        return { success: false, error: `skill_create: the plugin won't load — ${smoke.error}` }
      }
      // The plugin is the source of truth for the tool list. Whenever we can
      // read tools off it, DERIVE the frontmatter `tools:` from them and
      // REPLACE whatever the model hand-wrote (strip any existing block first).
      // This makes the frontmatter format the model's problem disappear — bare
      // strings, a duplicate `tools:` key, missing parameters all stop
      // mattering, because the canonical block is rebuilt from the code.
      const descriptors = (smoke.tools ?? []).map(deriveDescriptor).filter((d) => d.name)
      if (descriptors.length > 0) {
        skillMd = setFrontmatterTools(skillMd, descriptors)
        await fs.writeFile(path.join(staging, 'SKILL.md'), skillMd, 'utf8')
        autoDerivedTools = descriptors.length
      } else if (declaredToolCount === 0) {
        // Nothing to register: the plugin exposes no readable tools (e.g. a
        // switch-only execute) AND the frontmatter declares none either.
        return {
          success: false,
          error:
            'No tools found. Either give the plugin a `tools: [{ name, description, parameters }]` array (recommended — the frontmatter is then auto-derived), or declare each tool in the SKILL.md frontmatter `tools:` block as objects with a `name`.'
        }
      }
      // else: a switch-only execute whose tools we can't read, but the
      // frontmatter already declares them — trust the model's frontmatter.
    }

    const result = await host.importCapability(staging)
    if (!result.ok) {
      return { success: false, error: `skill_create failed: ${result.error ?? 'unknown error'}` }
    }

    // Discovered on the next scan — reload so the new skill (and its tools)
    // are live without an app restart.
    await host.reload()

    const toolNote =
      result.hasPlugin && result.toolCount
        ? `${result.toolCount} tool${result.toolCount === 1 ? '' : 's'} callable on your very next step`
        : 'a procedure-only skill (no tools) — read its body on demand with skill_read_source; to keep it standing, point to it from agents.md'
    const derivedNote =
      autoDerivedTools > 0
        ? ` (auto-added a frontmatter tools: block from your plugin — next time you can declare it yourself for full control)`
        : ''
    const depNote = hasPackageJson
      ? ' Its npm dependencies install automatically on the first tool call, so that call doubles as the install check.'
      : ''
    // A tool-bearing skill is born UNTESTED — the badge clears only when the
    // runtime observes a successful real call. Say so loudly: the model must
    // close the loop in this same turn, not report a half-finished skill.
    const testNote =
      result.hasPlugin && result.toolCount
        ? ` NOT DONE YET: it is marked UNTESTED until one of its tools succeeds for real. Call each new tool NOW with realistic input, inspect the output, fix + skill_reload until it passes — only then tell the user it is ready.`
        : ''
    return {
      success: true,
      output: `Created skill "${result.name}" — ${toolNote}${derivedNote}.${depNote}${testNote}`
    }
  } catch (err) {
    return { success: false, error: `skill_create error: ${err instanceof Error ? err.message : String(err)}` }
  } finally {
    if (staging) await fs.rm(staging, { recursive: true, force: true }).catch(() => {})
  }
}

// ---------------------------------------------------------------------------
// skill_reload
// ---------------------------------------------------------------------------

async function reloadSkills() {
  if (!host) return missingHost()
  await host.reload()
  const caps = await host.listCapabilities()
  return { success: true, output: `Reloaded ${caps.length} skill(s) from disk.` }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function missingHost() {
  return {
    success: false,
    error:
      'Skill management is unavailable in this context (no host bridge). This should not happen inside the app — report it.'
  }
}

/**
 * Count the tools declared in a SKILL.md frontmatter `tools:` block. Crude but
 * sufficient: counts `- name:` items nested under a top-level `tools:` key,
 * stopping at the next top-level key. Used to catch "plugin_code provided but
 * no tools declared" before anything is written — the same structure the
 * cerebellum loader reads via YAML, just without a YAML dependency here.
 */
function countFrontmatterTools(skillMd) {
  const s = skillMd.trimStart()
  if (!s.startsWith('---')) return 0
  const end = s.indexOf('\n---', 3)
  const fm = end < 0 ? s.slice(3) : s.slice(3, end)
  const lines = fm.split('\n')
  let i = -1
  for (let j = 0; j < lines.length; j++) {
    if (/^tools:/.test(lines[j])) {
      i = j
      break
    }
  }
  if (i < 0) return 0
  if (/^tools:\s*\[\s*\]\s*$/.test(lines[i])) return 0 // inline empty list
  let count = 0
  for (let j = i + 1; j < lines.length; j++) {
    if (/^\S/.test(lines[j])) break // next top-level key ends the block
    if (/^\s*-\s*name:/.test(lines[j])) count++
  }
  return count
}

/**
 * Import a staged plugin file and verify it exports a usable Wolffish plugin
 * shape, returning { ok, tools } or { ok:false, error } with a precise,
 * actionable message for the exact mistake. `tools` is the plugin's own tool
 * definitions (for auto-deriving the frontmatter). Never throws.
 */
async function smokeTestPlugin(pluginPath) {
  let mod
  try {
    mod = await import(pathToFileURL(pluginPath).href)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return {
      ok: false,
      error: `it failed to import (${msg}). Fix syntax errors; if it imports an npm package, declare that package in package_json.`
    }
  }
  const p = mod?.default ?? mod
  if (!p || typeof p !== 'object') {
    return { ok: false, error: 'it must `export default` a plugin object: { name, tools: [...], execute }.' }
  }
  // The loader accepts `execute`, a top-level dispatcher alias (MCP-style
  // handleToolCall, run, …), OR per-tool inline handlers — mirror that here so
  // we don't reject a plugin the runtime would actually load (kept in sync
  // with synthesizeExecute in cerebellum.ts).
  const hasDispatcher = DISPATCHER_NAMES.some((k) => typeof p[k] === 'function') || hasPerToolHandlers(p.tools)
  if (!hasDispatcher) {
    return {
      ok: false,
      error:
        'no dispatcher found. Give each tool a `handler`, or export `async execute(toolName, args)` (an MCP-style `handleToolCall` also works). Canonical: export default { name, tools: [...], async execute(toolName, args) { switch (toolName) { ... } } }.'
    }
  }
  return { ok: true, tools: extractPluginTools(p) }
}

// Dispatcher names the loader will route tool calls to (execute first, then
// aliases from other tool frameworks). Kept in sync with importPlugin.
const DISPATCHER_NAMES = ['execute', 'handleToolCall', 'handle', 'run', 'call', 'invoke', 'onToolCall', 'dispatch']

/** True when a tools array/object has per-tool inline handler functions. */
function hasPerToolHandlers(tools) {
  const fnOf = (t) =>
    t && typeof t === 'object' ? (t.handler ?? t.run ?? t.fn ?? t.execute ?? t.callback) : undefined
  const sample = Array.isArray(tools)
    ? tools
    : tools && typeof tools === 'object'
      ? Object.values(tools)
      : []
  return sample.some((t) => typeof fnOf(t) === 'function')
}

/**
 * Pull a plugin's tool definitions out for auto-deriving the frontmatter.
 * Handles the Wolffish contract (an exported `tools` array) and, best-effort,
 * the register(toolbox) pattern some model-authored plugins use instead —
 * calling it with a capturing mock so `toolbox.addTools(defs)` is intercepted.
 * Never throws; returns [] when nothing usable is found.
 */
function extractPluginTools(p) {
  const valid = (arr) =>
    (Array.isArray(arr) ? arr : []).filter(
      (t) => t && typeof t === 'object' && typeof t.name === 'string' && t.name
    )
  if (Array.isArray(p.tools)) return valid(p.tools)
  if (Array.isArray(p.toolDefinitions)) return valid(p.toolDefinitions)
  // tools keyed by name: { coinflip_do: { description, parameters, handler } }
  if (p.tools && typeof p.tools === 'object') {
    return valid(
      Object.entries(p.tools).map(([name, def]) => ({
        name,
        ...(def && typeof def === 'object' ? def : {})
      }))
    )
  }
  if (typeof p.register === 'function') {
    const captured = []
    const push = (x) => {
      if (Array.isArray(x)) captured.push(...x)
      else if (x && typeof x === 'object') captured.push(x)
    }
    const toolbox = {
      addTools: push,
      addTool: push,
      add: push,
      register: push,
      registerTool: push,
      tool: push,
      tools: []
    }
    try {
      p.register(toolbox)
    } catch {
      // best-effort — the plugin may expect a richer toolbox; ignore
    }
    return valid(captured.length ? captured : toolbox.tools)
  }
  return []
}

/** Convert a tool's JSON-Schema `parameters` into the compact frontmatter form. */
function jsonSchemaToCompactParams(schema) {
  if (!schema || typeof schema !== 'object') return {}
  const props =
    schema.properties && typeof schema.properties === 'object' ? schema.properties : null
  if (!props) return {}
  const required = new Set(Array.isArray(schema.required) ? schema.required : [])
  const out = {}
  for (const [key, val] of Object.entries(props)) {
    if (!val || typeof val !== 'object') {
      out[key] = { type: 'string', required: false }
      continue
    }
    const spec = { type: typeof val.type === 'string' ? val.type : 'string' }
    if (typeof val.description === 'string') spec.description = val.description
    if (Array.isArray(val.enum)) spec.enum = val.enum
    if (val.items) spec.items = val.items
    if (val.properties) spec.properties = val.properties
    if (!required.has(key)) spec.required = false
    out[key] = spec
  }
  return out
}

/** Turn a plugin tool definition into a frontmatter tool descriptor. */
function deriveDescriptor(t) {
  return {
    name: t.name,
    description:
      typeof t.description === 'string' && t.description ? t.description : `${t.name} tool`,
    parameters: jsonSchemaToCompactParams(t.parameters)
  }
}

/**
 * Splice a `tools:` line into a SKILL.md's frontmatter using JSON flow style
 * (valid YAML, and JSON.stringify handles all escaping — no hand-rolled YAML).
 */
function injectFrontmatterTools(skillMd, descriptors) {
  const closeIdx = skillMd.indexOf('\n---', 3)
  const at = closeIdx < 0 ? skillMd.length : closeIdx
  return `${skillMd.slice(0, at)}\ntools: ${JSON.stringify(descriptors)}${skillMd.slice(at)}`
}

/**
 * Remove an existing top-level `<key>:` block from the frontmatter (the key's
 * line plus any indented children), so re-injecting a canonical value can't
 * create a duplicate mapping key. Only touches the frontmatter region.
 */
function stripFrontmatterKey(skillMd, key) {
  if (!skillMd.startsWith('---')) return skillMd
  const closeIdx = skillMd.indexOf('\n---', 3)
  if (closeIdx < 0) return skillMd
  const fm = skillMd.slice(3, closeIdx) // between opening --- and closing \n---
  const tail = skillMd.slice(closeIdx) // \n---\n...body
  const lines = fm.split('\n')
  const keyRe = new RegExp(`^${key}\\s*:`)
  const kept = []
  for (let i = 0; i < lines.length; i++) {
    if (keyRe.test(lines[i])) {
      // skip the key's line and any following indented (block items) lines
      while (i + 1 < lines.length && /^\s+\S/.test(lines[i + 1])) i++
      continue
    }
    kept.push(lines[i])
  }
  return `---${kept.join('\n')}${tail}`
}

/** Strip any model-written `tools:` block and inject the derived one. */
function setFrontmatterTools(skillMd, descriptors) {
  return injectFrontmatterTools(stripFrontmatterKey(skillMd, 'tools'), descriptors)
}

/**
 * Stamp the frontmatter `author:` (replacing any existing value) — the
 * provenance marker behind the Wolffish badge and tested-state tracking.
 */
function setFrontmatterAuthor(skillMd, author) {
  const stripped = stripFrontmatterKey(skillMd, 'author')
  const closeIdx = stripped.indexOf('\n---', 3)
  const at = closeIdx < 0 ? stripped.length : closeIdx
  return `${stripped.slice(0, at)}\nauthor: ${author}${stripped.slice(at)}`
}

/**
 * Coerce the `extra_files` arg into a validated [{ path, content }] list.
 * Accepts a JSON string or an already-parsed array. Returns { files } on
 * success or { error } with a clear message; never throws.
 */
function normalizeExtraFiles(raw) {
  if (raw === undefined || raw === null || raw === '') return { files: [] }
  let value = raw
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value)
    } catch (err) {
      return { error: `skill_create: extra_files is not valid JSON: ${err.message}` }
    }
  }
  if (!Array.isArray(value)) {
    return { error: 'skill_create: extra_files must be an array of { path, content } objects.' }
  }
  const files = []
  for (let i = 0; i < value.length; i++) {
    const entry = value[i]
    if (!entry || typeof entry !== 'object') {
      return { error: `skill_create: extra_files[${i}] must be an object with path and content.` }
    }
    if (typeof entry.path !== 'string' || !entry.path.trim()) {
      return { error: `skill_create: extra_files[${i}] is missing a "path".` }
    }
    const rel = entry.path.trim()
    // Must be a relative path that stays inside the skill folder — reject
    // absolute paths and any ".." segment up front with a clear message
    // (the write loop guards again as defense-in-depth).
    if (path.isAbsolute(rel) || rel.split(/[\\/]/).includes('..')) {
      return {
        error: `skill_create: extra_files[${i}] path "${entry.path}" must be relative with no ".." — it lives inside the skill folder.`
      }
    }
    if (typeof entry.content !== 'string') {
      return { error: `skill_create: extra_files[${i}] ("${entry.path}") is missing string "content".` }
    }
    files.push({ path: rel, content: entry.content })
  }
  return { files }
}

// ---------------------------------------------------------------------------
// Plugin export
// ---------------------------------------------------------------------------

const plugin = {
  name: 'skills',
  tools: toolDefinitions,
  async init(context) {
    host = context?.host
  },
  async execute(toolName, args) {
    switch (toolName) {
      case 'skill_list':
        return listSkills()
      case 'skill_search':
        return searchSkills(args ?? {})
      case 'skill_read_source':
        return readSource(args ?? {})
      case 'skill_enable':
        return setEnabled(args ?? {}, true)
      case 'skill_disable':
        return setEnabled(args ?? {}, false)
      case 'skill_delete':
        return deleteSkill(args ?? {})
      case 'skill_create':
        return createSkill(args ?? {})
      case 'skill_reload':
        return reloadSkills()
      default:
        return { success: false, error: `skills: unknown tool ${toolName}` }
    }
  }
}

export default plugin
