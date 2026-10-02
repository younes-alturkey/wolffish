---
name: skills
description: Manage and create Wolffish's own skills (capabilities) — list, search, enable, disable, delete, and author brand-new skills at runtime
triggers:
  - skill
  - skills
  - capability
  - capabilities
  - create a skill
  - make a skill
  - new skill
  - build a skill
  - teach yourself
  - add a tool
  - new tool
  - new capability
  - list skills
  - search skills
  - disable skill
  - enable skill
  - delete skill
  - remove skill
  - what skills
  - what can you do
  - extend yourself
  - automate this
  - do this every time
  - reusable
tools:
  - name: skill_list
    readOnly: true
    description: List every skill Wolffish has — name, description, enabled/official status, tool count.
    parameters: {}
  - name: skill_search
    readOnly: true
    description: Search skills by keyword across name, description, triggers, and tool names.
    parameters:
      query:
        type: string
        description: Keyword(s) to search for, case-insensitive.
  - name: skill_read_source
    readOnly: true
    description: Read a skill's source (SKILL.md, plugin code, bundled files) to see how it's written before amending it, or to learn from an official skill.
    parameters:
      name:
        type: string
        description: Exact skill name (from skill_list).
      file:
        type: string
        required: false
        description: Optional specific file to read in full, relative to the skill folder (e.g. "plugin/index.mjs"). Omit for an overview.
  - name: skill_enable
    description: Re-enable a disabled skill. Persists and takes effect next turn.
    parameters:
      name:
        type: string
        description: Exact skill name (from skill_list).
  - name: skill_disable
    description: Disable ANY skill so its tools are hidden and stop executing — works on official/built-in skills too (e.g. to "turn off the browser"). Reversible via skill_enable. Only the 'skills' capability itself can't be disabled.
    parameters:
      name:
        type: string
        description: Exact skill name (from skill_list).
  - name: skill_delete
    description: Permanently delete a NON-OFFICIAL (custom) skill — removes its folder from disk. You CAN delete any skill you or the user created. Official/built-in skills are protected (disable them instead).
    parameters:
      name:
        type: string
        description: Exact name of the custom skill to delete.
  - name: skill_create
    description: 'Author a brand-new skill for yourself and load it live — from a pure procedure (SKILL.md only) to plugin tools (index.mjs), npm dependencies (package.json), and bundled workers in other languages (extra_files). Read skill_read_source("skills") FIRST for the format and golden rules. The created skill is stamped author wolffish and stays marked UNTESTED until one of its tools succeeds for real — test every tool in this same turn (fix + skill_reload until it passes) before telling the user it is ready.'
    parameters:
      skill_md:
        type: string
        description: Full SKILL.md contents — YAML frontmatter (--- delimited) with name + description (+ optional triggers), then a markdown body. Don't hand-write a tools block — it is derived from the plugin.
      plugin_code:
        type: string
        required: false
        description: Full plugin/index.mjs contents (ES module, `export default { name, tools, execute }`). Required if the skill exposes any tools.
      package_json:
        type: string
        required: false
        description: Full package.json contents declaring npm dependencies (installed automatically on first tool call). Only needed if the plugin imports npm packages; with one present, declare the frontmatter tools yourself.
      extra_files:
        type: array
        required: false
        description: 'Additional files to bundle, as [{ path, content }] (e.g. a Python worker at plugin/worker.py). Relative paths only. Enables complex, multi-language skills.'
  - name: skill_reload
    description: Re-scan brain/cerebellum/ from disk and reload all skills (after editing one on disk).
    parameters: {}
confirm_patterns:
  - pattern: 'skill_delete'
    reason: Permanently deleting a skill removes its folder from disk
---

# Skills — manage and create your own capabilities

A **skill** (a.k.a. capability) is a folder under `brain/cerebellum/`. It is
how every ability you have — shell, git, pdf, web-search — is defined. You can
read your skills, turn them on and off, remove the ones you made, and **write
new ones for yourself**. This procedure is the authoritative guide for doing
that correctly.

## Managing existing skills

You are allowed to reshape your own capabilities. Two permissions to be clear
about, because you have them and should use them when it helps:

- **You can disable ANY skill — official/built-in ones included.** Disabling
  just hides a skill's tools from you and stops them executing; it changes
  nothing on disk and is fully reversible with `skill_enable`. So if the user
  says "stop using the browser" or "turn off web search", do it with
  `skill_disable` — don't claim you can't. The one and only exception is the
  `skills` capability itself (disabling it would strand you without these very
  tools), which is refused.
- **You can delete any NON-OFFICIAL (custom) skill** — the ones you or the user
  created. This removes its folder from disk and is irreversible. Official
  (built-in) skills are protected and can't be deleted — if the user wants one
  "gone", disable it instead and explain it's built in.

The tools:

- `skill_list` — see everything you've got. Do this first when the user asks
  "what can you do" or before you consider building something new.
- `skill_search <query>` — check whether an ability already exists. **Always
  search before creating** — don't reinvent a skill that's already installed.
- `skill_read_source <name> [file]` — read a skill's actual source (SKILL.md,
  plugin code, bundled files). Use it before amending a skill, and to **learn
  from the official ones — they are your gold standard**: read `shell` for the
  canonical plugin shape, `speech-to-text` for the bundled-Python-worker and
  managed-venv pattern, and any official skill whose domain resembles what
  you're about to build. Match their structure, result shapes, and error
  handling rather than inventing your own.
- `skill_enable <name>` / `skill_disable <name>` — toggle a skill on/off.
  Reversible; works on official and custom skills alike (except `skills`).
- `skill_delete <name>` — permanently remove a **custom** skill. Official skills
  are refused — disable them instead. Prefer disabling over deleting unless the
  user clearly wants it gone for good.

## When to create a skill

Create one when a capability is **missing, repeated, and worth keeping**:

- The user asks you to "always", "every time", or "from now on" do something.
- You find yourself writing the same multi-step shell/script dance more than
  once.
- A task needs a real tool you don't have (call a specific API, transform a
  file format, drive a service) and it will come up again.

**Do not** create a skill for a one-off. If you can just run a shell command or
write a quick script for a single request, do that. A skill is for an ability
you'll reuse — it costs context (its description ships to the model) and adds
surface area. When in doubt, do the task directly first; promote it to a skill
once it's clearly recurring.

**Offer it.** The user may not know you can build permanent tools for
yourself. When you notice a recurring pattern — the third time you hand-roll
the same transformation, a workflow they clearly repeat — say so in one line
("I can make this a permanent skill so it's one call next time — want me to?")
and build it if they agree, or immediately when they ask outright.

## The three kinds of skill

Every skill is a folder with a `SKILL.md`. What you add beside it determines
the kind:

```
1. Pure skill (procedure only — no tools, no code)
   brain/cerebellum/<slug>/
     └── SKILL.md            # frontmatter + a markdown procedure

2. Plugin skill (tools backed by JavaScript)
   brain/cerebellum/<slug>/
     ├── SKILL.md            # frontmatter that DECLARES the tools
     └── plugin/
         └── index.mjs       # ES module that EXECUTES the tools

3. Plugin skill with npm dependencies
   brain/cerebellum/<slug>/
     ├── SKILL.md
     ├── package.json        # declares npm deps (installed lazily, on first use)
     └── plugin/
         └── index.mjs       # may `import` those npm packages
```

Pick the smallest kind that does the job. A **pure skill** is just knowledge —
a checklist or procedure you load on demand with `skill_read_source` (and can
point to from `agents.md` so it's read for the tasks it applies to); reach for
it when the "ability" is really *knowing how*, and the doing is plain
shell/filesystem work you already have tools for. A **plugin skill** is for a
real new tool you can call. Add a **package.json** only when the plugin needs
an npm library.

## SKILL.md format

The file is a YAML frontmatter block delimited by `---`, then a markdown body.

```yaml
---
name: weather              # REQUIRED. Unique. Becomes the folder slug.
description: Look up current weather for a city   # REQUIRED. One line; ships to the model.
triggers:                  # Optional. Search keywords — they help tool_search and the
  - weather                # capability index surface this skill. They do NOT inject its
  - forecast               # body; load a pure skill's body on demand with skill_read_source
  - temperature            # (or point to it from agents.md so it's read at the right time).
tools:                     # Optional. Declare each callable tool here. THIS is what
  - name: weather_get      # the model sees, and how calls are routed — every tool the
    description: Get the current weather for a city.   # plugin handles MUST be listed.
    parameters:            # Map of paramName -> spec. Each param is REQUIRED unless
      city:                # you set `required: false`.
        type: string       # string | number | boolean | object | array
        description: City name, e.g. "Tokyo".
      units:
        type: string
        required: false
        enum: [metric, imperial]
        description: Defaults to metric.
requires: []               # Optional. Other capabilities to ensure first (e.g. [node],
                           # [ffmpeg]). They're checked/installed before your plugin loads.
---

# Weather

Markdown body: when and how to use the tool(s), edge cases, output rules.
For a pure skill (no tools) this body IS the skill — write a clear procedure.
```

Notes that matter:

- **`name` must be unique** and is slugified to the folder name (lowercase,
  letters/digits/`-`/`_`). `skill_create` rejects a name that already exists —
  to change an existing skill, edit it (see below), don't recreate it.
- **The frontmatter `tools` list is the source of truth.** It's both what the
  model sees and how a call is routed to your plugin. A tool the plugin's
  `execute` handles but the frontmatter omits will never be callable.
- **A skill that declares tools must ship a plugin.** Tools with no code to back
  them are rejected.
- Frontmatter parameters use the compact form above (`type`, `description`,
  `required`, `enum`). The plugin file repeats them as full JSON Schema (next
  section) — keep the two in sync.

## The plugin (plugin/index.mjs)

A plain **ES module** (`.mjs`) — plain JavaScript, not TypeScript. It must
`export default` an object shaped like this:

```js
import fs from 'node:fs/promises'   // Node builtins are always available.
import path from 'node:path'

// Full JSON Schema here (mirrors the SKILL.md frontmatter tools).
const tools = [
  {
    name: 'weather_get',
    description: 'Get the current weather for a city.',
    parameters: {
      type: 'object',
      properties: {
        city: { type: 'string', description: 'City name, e.g. "Tokyo".' },
        units: { type: 'string', enum: ['metric', 'imperial'], description: 'Defaults to metric.' }
      },
      required: ['city']
    }
  }
]

let workspaceRoot = ''

const plugin = {
  name: 'weather',            // MUST equal the SKILL.md `name`.
  tools,
  // Optional. Runs once, lazily, the first time any tool is called.
  async init(context) {
    workspaceRoot = context.workspaceRoot   // ~/.wolffish/workspace
    // context also gives: pluginDir, getCurrentConversationId(), sudo, host
  },
  // REQUIRED. Routes a tool call. `signal` aborts when the user stops a run —
  // honor it in long-running work. Return a ToolExecutionResult (below).
  async execute(toolName, args, signal) {
    switch (toolName) {
      case 'weather_get':
        return getWeather(args, signal)
      default:
        return { success: false, error: `weather: unknown tool ${toolName}` }
    }
  },
  // Optional. Cleanup on reload/shutdown (close handles, kill child processes).
  async destroy() {}
}

async function getWeather(args, signal) {
  // ... do the work ...
  return { success: true, output: 'Tokyo: 22°C, clear.' }
}

export default plugin
```

### Tool result shape

`execute` must return an object:

```js
{
  success: boolean,     // true = ok, false = error
  output?: string,      // text shown to you (and the user). Keep it tight.
  error?: string,       // why it failed, when success is false
  images?: [             // optional images to return to the model
    { mediaType: 'image/png', data: '<base64>' }
  ]
}
```

Never throw out of `execute` for an expected failure — return
`{ success: false, error }` so you can read it and recover. Uncaught throws are
caught by the runtime but give a worse message.

### Two rules that prevent almost every broken skill

1. **Put tools in the plugin's `tools` array; don't hand-write a frontmatter
   `tools:` block.** The frontmatter is auto-derived from your plugin, so a
   `tools:` you write yourself is redundant — and it's the single thing the
   model most often gets wrong (bare strings like `- coinflip_do`, a duplicate
   `tools:` key, names that don't match). Leave it out; let it be derived.
2. **`execute` returns `{ success, output }`** — the result text goes in
   **`output`** (a string). `{ result: … }` or a bare value works (it's
   coerced) but `output` is the real field; use it.

> **Wolffish is forgiving (Postel's law),** so a reasonable near-miss works
> instead of failing — the loader accepts `execute` OR an MCP-style
> `handleToolCall` OR per-tool `handler` functions; reads tools from `tools`,
> `toolDefinitions`, or per-tool objects; coerces `{ result }` / `{ content:
> [{ text }] }` returns onto `output`; and derives the frontmatter from your
> plugin. You don't have to thread the needle. **But** the canonical shape in
> the golden-rule example below is clearest and what the built-in skills use —
> prefer it.

### What the plugin can and can't do

- **It runs inside Wolffish's main process with full Node.js access** — `fs`,
  `child_process`, `crypto`, network, all builtins. That's powerful and
  trusted; only write code you'd be comfortable running yourself.
- **Write output files into the workspace `files/` directory**
  (`path.join(workspaceRoot, 'files', ...)`), never `/tmp`. That's where
  generated artifacts are delivered to the user from.
- **npm packages must be declared in the skill's own `package.json`** (kind 3).
  They install into the skill's own `node_modules` the first time a tool runs.
  You cannot rely on Wolffish-core's modules — only Node builtins and your own
  declared deps resolve.

## Skills can be as complex as you need — other languages, bundled files

Do not think of a skill as "a bit of JavaScript". The `index.mjs` is an
**orchestrator**: it can bundle and drive scripts in *any* language, call
native binaries, manage a venv, stream a subprocess — whatever the job needs.
Your built-in `speech-to-text` and `text-to-speech` skills are exactly this:
the plugin is thin JS that shells out to a bundled **Python** worker
(`transcribe.py` / `synth.py`) running heavy local ML. That is the model to
copy when a task is too big for JavaScript alone.

The pattern for a script-backed skill:

1. **Bundle the worker** beside `index.mjs` — pass it via `extra_files` to
   `skill_create` (e.g. `{ "path": "plugin/worker.py", "content": "..." }`).
2. **Find it at runtime** relative to the plugin file, never by guessing an
   absolute path:
   ```js
   import { fileURLToPath } from 'node:url'
   import path from 'node:path'
   import { spawn } from 'node:child_process'
   const PLUGIN_DIR = path.dirname(fileURLToPath(import.meta.url))
   const WORKER = path.join(PLUGIN_DIR, 'worker.py')
   ```
3. **Run it** and collect stdout/stderr, honoring the abort `signal`:
   ```js
   function runWorker(args, signal) {
     return new Promise((resolve) => {
       const child = spawn('python3', [WORKER, ...args], { stdio: ['ignore', 'pipe', 'pipe'] })
       let out = '', err = ''
       signal?.addEventListener('abort', () => child.kill('SIGKILL'))
       child.stdout.on('data', (d) => (out += d))
       child.stderr.on('data', (d) => (err += d))
       child.on('close', (code) =>
         resolve(code === 0
           ? { success: true, output: out.trim() }
           : { success: false, error: err.trim() || `worker exited ${code}` }))
     })
   }
   ```

Two ways to get a language runtime, simplest first:

- **Plain interpreter via the shell.** If the user already has `python3` /
  `node` / `bash` on PATH, just `spawn('python3', …)`. Good for lightweight
  scripts with no third-party packages. (You can probe with the `shell`
  capability first.)
- **A managed runtime + packages** for anything heavier. Wolffish ships a
  shared `python` capability that provisions an isolated interpreter and venv
  (this is what the speech skills use). Declare `requires: [python]` in your
  frontmatter so it's ensured before your plugin loads, then resolve the
  managed Python and create a venv with your pip packages. Read the
  `speech-to-text` skill's `plugin/index.mjs` as the worked reference for the
  venv dance — don't reinvent it, mirror it:
  `skill_read_source("speech-to-text", file: "plugin/index.mjs")`.

So: a skill can be a one-line procedure, or it can be a JS shell around a
Python ML pipeline with its own venv. Reach for the heavier shape only when the
task genuinely needs it — but know that it is fully available to you.

## Creating a skill with `skill_create`

`skill_create` takes the file contents directly, validates them, writes the
folder under `brain/cerebellum/`, and reloads. The new tools become callable
**on your very next step — in the same turn**, so you create and immediately
test without handing back to the user.

Provenance and the tested state, both automatic:

- Every skill you create is stamped `author: wolffish` in its frontmatter —
  don't write that key yourself, it's set for you. In Settings → Capabilities
  it shows a **Wolffish** badge (bundled skills show *Official*; hand-imported
  ones *Unknown*), and `skill_list` tags it *wolffish-authored*.
- A tool-bearing skill you create (or later edit) is **UNTESTED** until the
  runtime observes one of its tools succeed in a real call — an amber badge in
  the panel, an `UNTESTED` tag in `skill_list`. The first successful call
  clears it automatically; editing the SKILL.md or plugin re-arms it. You
  cannot clear it by claiming the skill works — only by a passing call.

Arguments:

- `skill_md` — the full SKILL.md text (required).
- `plugin_code` — the full `plugin/index.mjs` text (required for a tool-bearing skill).
- `package_json` — the full `package.json` text (only if the plugin imports npm packages).
- `extra_files` — `[{ path, content }]` to bundle other files (a Python worker,
  a script, a template). Relative paths only.

### The golden rule (do this and it works first try)

**Put the tools in the PLUGIN. Keep the frontmatter to `name` + `description` +
optional `triggers`.** Do **not** hand-write a `tools:` block in the
frontmatter — `skill_create` derives it from your plugin's `tools` array, so a
frontmatter `tools:` is at best redundant and at worst the thing you get wrong
(bare strings, a duplicate key, mismatched names). If you write one anyway,
it's replaced by the derived one — so just leave it out.

So a tool-bearing skill is exactly two arguments: a tiny `skill_md`, and a
`plugin_code` shaped like this. **Copy this structure exactly** — only change
the names and the body of `execute`:

`skill_md`:
```
---
name: coinflip
description: Flip a coin and return heads or tails.
triggers: [coin, flip, heads, tails]
---
# Coinflip
Use `coinflip_do` to flip a coin.
```

`plugin_code`:
```js
export default {
  name: 'coinflip',
  // Each tool: name, description, and JSON-Schema parameters. No-arg tools
  // use an empty object schema. (This array is what the frontmatter is
  // derived from — get it right here and the frontmatter takes care of itself.)
  tools: [
    {
      name: 'coinflip_do',
      description: 'Flip a coin and return heads or tails.',
      parameters: { type: 'object', properties: {}, required: [] }
    }
  ],
  // ONE dispatcher for every tool. `args` holds the call arguments. ALWAYS
  // return { success, output } — the result text goes in `output` (a string).
  async execute(toolName, args) {
    if (toolName === 'coinflip_do') {
      return { success: true, output: Math.random() < 0.5 ? 'heads' : 'tails' }
    }
    return { success: false, error: `unknown tool: ${toolName}` }
  }
}
```

A tool WITH arguments — note the `parameters` schema and reading `args`:
```js
export default {
  name: 'slugify',
  tools: [
    {
      name: 'slugify_text',
      description: 'Convert text to a URL-safe slug.',
      parameters: {
        type: 'object',
        properties: { text: { type: 'string', description: 'The text to slugify.' } },
        required: ['text']
      }
    }
  ],
  async execute(toolName, args) {
    if (toolName === 'slugify_text') {
      const slug = String(args.text || '').toLowerCase().trim()
        .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
      return { success: true, output: slug }
    }
    return { success: false, error: `unknown tool: ${toolName}` }
  }
}
```

### Pure skill (a procedure, no tools)

When the skill is just *knowledge*, pass only `skill_md` — no plugin, no
frontmatter `tools:`:
```
---
name: standup-notes
description: Format the user's daily standup into the team's template
triggers: [standup, daily update, what i did today]
---
# Standup notes
When the user dumps what they did, format it as:
**Yesterday:** …  **Today:** …  **Blockers:** …  — one line each, no preamble.
```

### With an npm dependency

Add `package_json`; the plugin keeps the same shape and may `import` the
package (installed automatically before first use):
```json
{ "name": "wolffish-qrcode", "private": true, "type": "module", "dependencies": { "qrcode": "^1.5.0" } }
```
```js
import QRCode from 'qrcode' // resolves after the lazy install on first tool use
export default {
  name: 'qrcode',
  tools: [{ name: 'qr_make', description: 'Make a QR PNG.', parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } }],
  async execute(toolName, args) { /* … write a PNG into workspaceRoot/files, return its path in output … */ }
}
```

### Checklist before you call `skill_create`

- [ ] `skill_md` frontmatter has **only** `name`, `description`, optional `triggers` — **no `tools:`**.
- [ ] `plugin_code` does `export default { name, tools: [ … ], async execute(toolName, args) { … } }`.
- [ ] every tool in `tools` is an **object** with `name`, `description`, `parameters` (JSON Schema; `{ type: 'object', properties: {}, required: [] }` for no args).
- [ ] `execute` returns `{ success: true, output: '<text>' }` (or `{ success: false, error }`).
- [ ] the tool names in `tools` match the ones `execute` handles.

## Editing an existing skill

Editing is fully available — you already have everything you need: read the
source, write the change, reload, re-test. `skill_create` is for *new* skills
only; to change one you already have:

1. `skill_read_source <name>` — see exactly how it's written, and note the
   **Folder** path it prints. Use that exact path (custom skills live at
   `brain/cerebellum/<slug>/`; official ones are dot-prefixed, e.g.
   `brain/cerebellum/.speech-to-text/` — never guess, use the printed path).
2. `file_write` (or `file_patch`) the changed `SKILL.md`, `plugin/index.mjs`,
   or bundled file at that path. (Writes inside your workspace are silent — no
   approval needed.)
3. `skill_reload` so the change takes effect — no app restart needed. The
   edited plugin code re-loads (it doesn't stay cached), so the next call runs
   your new version.
4. Re-test by calling the tool, and loop until it works.

You can edit custom skills freely. Editing an official skill's files works too,
but those files are re-synced from the app's bundled copy on the next launch,
so durable changes to official behavior belong upstream, not here.

## Always test before you conclude — create → load → test → edit → repeat

**A skill is not "done" when you create it. It's done when you've called it and
seen it work.** Plugin code is real code; it has bugs. Because a created or
edited skill becomes callable on your *next step in the same turn*, you can —
and must — close the loop yourself before telling the user it's ready. Never
hand back a freshly minted tool you haven't run.

The runtime enforces the honest version of this: your created skills carry an
**UNTESTED** marker that only a real successful tool call clears (and any edit
re-arms). So the test loop below isn't etiquette — it's how the skill reaches
its finished state at all. A skill still tagged UNTESTED at the end of your
turn is, visibly to the user, unfinished work.

The loop, all within one turn:

1. **Create** — `skill_create` with the SKILL.md (+ plugin, + extra files).
   Read the result: a clear error means it didn't even load — fix the inputs
   and call again.
2. **Test** — actually **call the new tool** with a realistic input. (It's in
   your tool list now; you don't need to wait for the user.) For a pure
   procedure skill there's no tool to call — instead re-read what you wrote and
   sanity-check the steps.
3. **Inspect the output** — did it return `success: true` with the right
   result? Did a file land where you expected? Compare against what you
   intended.
4. **Edit if wrong** — `file_write` the fix into
   `~/.wolffish/workspace/brain/cerebellum/<slug>/plugin/index.mjs` (or its
   `worker.py`, etc.), then `skill_reload`. The edited code re-loads — the next
   call runs the new version, not the old one.
5. **Re-test** — call it again. Loop steps 2–5 until it genuinely works.
6. **Only then conclude** — tell the user the skill exists, what it does, and
   that you verified it by running it.

Worked example — build and verify a `slugify` skill in one turn:

```
skill_create(skill_md=…, plugin_code=…)        → "Created skill \"slugify\" — 1 tool…"
slugify_text(text="Hello, World!")              → test it immediately
   → success:true, output:"hello-world"          ✓ correct → done, tell the user
   → success:false OR wrong output                ✗ then:
file_write(brain/cerebellum/slugify/plugin/index.mjs, …fixed…)
skill_reload()                                   → reloads the edited code
slugify_text(text="Hello, World!")              → re-test → now correct → done
```

If a tool needs setup (npm install, a venv, a model download) the first call
may take a while or surface an install — that's expected; let it finish, then
read the real result. A skill that errors on its first real call is a skill you
haven't finished. Keep iterating until the test passes.

## Rules & good practice

- **Search before you build.** `skill_search` first; extend or reuse over
  duplicating.
- **Name tools `<skill>_<verb>`** (e.g. `weather_get`, `slugify_text`) so it's
  obvious which skill owns them and they don't collide.
- **Keep descriptions tight and action-oriented** — they're spent on context
  every turn the skill is active.
- **Smallest kind that works.** Don't add a plugin to what a procedure can
  teach; don't add a package.json to what builtins can do.
- **Validate by reading the result.** `skill_create` returns a clear error if
  the frontmatter is malformed, the name is taken, or tools lack a plugin —
  fix and retry rather than guessing.
- **Test before you conclude.** Don't announce a skill as ready until you've
  called it and seen it work (see the test loop above). A created-but-untested
  skill is a half-finished one.
- After verifying, **tell the user what you made**, what it does, and that you
  confirmed it works by running it.
