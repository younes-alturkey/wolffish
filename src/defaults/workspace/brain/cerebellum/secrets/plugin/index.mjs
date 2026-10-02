import fs from 'node:fs/promises'
import path from 'node:path'
import { randomBytes } from 'node:crypto'

// Secrets are the user's named variables (Settings > Variables), stored in
// config.json under the `variables` array as { name, value, sensitive }. This
// plugin reads and writes that same store so the agent can save a key the user
// pastes in chat without hand-editing config.json — and the value then shows up
// in the Settings UI and in the agent's <variables> context block exactly like
// one added from the UI.

let workspaceRoot = ''

const toolDefinitions = [
  {
    name: 'add_secret',
    description:
      "Save a secret or variable to the user's store (Settings > Variables) — the same place the user adds them from the UI. Use when the user shares an API key, token, password, or any reusable value and wants it saved. If a secret with the same name exists, its value is replaced. Never echo the value back in your reply.",
    parameters: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description:
            'Variable name the value is referenced by, e.g. "OPENAI_API_KEY", "BASE_URL".'
        },
        value: { type: 'string', description: 'The secret/value to store.' },
        sensitive: {
          type: 'boolean',
          description:
            'Only affects how the Settings UI displays it (masked vs plain) — you always get the real value either way. Defaults to true; pass false for non-secret config like a base URL.'
        }
      },
      required: ['name', 'value']
    }
  },
  {
    name: 'list_secrets',
    description:
      'List the saved secrets/variables (Settings > Variables) with their actual values, so you can use a stored value directly instead of asking the user for it. Each entry is tagged sensitive or not. Call this before asking the user for any key/token/value — it may already be saved.',
    parameters: { type: 'object', properties: {}, required: [] }
  }
]

// ---------------------------------------------------------------------------
// Config I/O
// ---------------------------------------------------------------------------

function configPath() {
  return path.join(workspaceRoot, 'config.json')
}

async function readConfig() {
  const raw = await fs.readFile(configPath(), 'utf8')
  return JSON.parse(raw)
}

// Atomic write: stream to a sibling temp file, fsync, then rename(2) over the
// target. Mirrors the main process's writeConfigAtomic so a concurrent write or
// a crash can never leave a half-written config.json.
async function writeConfigAtomic(config) {
  const data = JSON.stringify(config, null, 2)
  const target = configPath()
  const tmp = path.join(
    workspaceRoot,
    `config.json.${process.pid}.${randomBytes(6).toString('hex')}.tmp`
  )
  let handle
  try {
    handle = await fs.open(tmp, 'w')
    await handle.writeFile(data, 'utf8')
    await handle.sync()
  } finally {
    if (handle) await handle.close()
  }
  await fs.rename(tmp, target)
}

// ---------------------------------------------------------------------------
// add_secret
// ---------------------------------------------------------------------------

async function addSecret(args) {
  const name = typeof args?.name === 'string' ? args.name.trim() : ''
  const value = typeof args?.value === 'string' ? args.value : ''
  // "add_secret" defaults to sensitive; only an explicit false opts out.
  const sensitive = !(args?.sensitive === false || args?.sensitive === 'false')

  if (!name) return { success: false, error: 'add_secret: name is required.' }
  if (value.trim().length === 0) return { success: false, error: 'add_secret: value is required.' }

  let config
  try {
    config = await readConfig()
  } catch (err) {
    return { success: false, error: `add_secret: could not read config.json: ${errText(err)}` }
  }
  if (!config || typeof config !== 'object') {
    return { success: false, error: 'add_secret: config.json is not a valid object.' }
  }

  const variables = Array.isArray(config.variables) ? config.variables : []
  const idx = variables.findIndex((v) => v && v.name === name)
  const existed = idx >= 0
  const entry = { name, value, sensitive }
  if (existed) variables[idx] = entry
  else variables.push(entry)
  config.variables = variables

  try {
    await writeConfigAtomic(config)
  } catch (err) {
    return { success: false, error: `add_secret: could not write config.json: ${errText(err)}` }
  }

  const tag = sensitive ? 'sensitive' : 'plain'
  const verb = existed ? 'Updated' : 'Saved'
  const note = existed ? ' (previous value replaced)' : ''
  return {
    success: true,
    output: `${verb} ${tag} secret \`${name}\`${note}. It's now in Settings > Variables and available to you (via list_secrets and your <variables> block).`
  }
}

// ---------------------------------------------------------------------------
// list_secrets
// ---------------------------------------------------------------------------

async function listSecrets() {
  let config
  try {
    config = await readConfig()
  } catch (err) {
    return { success: false, error: `list_secrets: could not read config.json: ${errText(err)}` }
  }
  const variables = Array.isArray(config?.variables) ? config.variables : []
  if (variables.length === 0) {
    return { success: true, output: 'No secrets or variables saved yet.' }
  }

  // Return the real values — this output is for YOU (the agent), so you can use
  // a stored value directly instead of asking the user for it. The `sensitive`
  // tag only tells you which ones not to print back into the user-facing chat.
  const lines = [`## Secrets & variables (${variables.length})`, '']
  for (const v of variables) {
    if (!v || typeof v.name !== 'string') continue
    const tag = v.sensitive ? ' (sensitive)' : ''
    lines.push(`- \`${v.name}\` = ${String(v.value ?? '')}${tag}`)
  }
  return { success: true, output: lines.join('\n') }
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function errText(err) {
  if (!err) return 'unknown error'
  return err.message ? String(err.message).split(/\r?\n/)[0] : String(err)
}

// ---------------------------------------------------------------------------
// Plugin export
// ---------------------------------------------------------------------------

const plugin = {
  name: 'secrets',
  tools: toolDefinitions,
  async init(context) {
    workspaceRoot = context?.workspaceRoot ?? ''
  },
  async execute(toolName, args) {
    switch (toolName) {
      case 'add_secret':
        return addSecret(args ?? {})
      case 'list_secrets':
        return listSecrets()
      default:
        return { success: false, error: `secrets: unknown tool ${toolName}` }
    }
  }
}

export default plugin
