/**
 * projects — Wolffish manages the user's projects.
 *
 * A project = shared instructions + a referenced file list that fresh
 * conversations start from (the chat's "project mode"). These tools reach the
 * very same store the Projects page reads and writes, through the `projects`
 * host bridge injected at init (PluginContext.projects) — so the agent's view
 * can never drift from the user's. File CONTENT is never returned here:
 * projects reference files model-led; read them with pdf/file/image tools.
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'

// Project-management bridge, injected at init by the main process.
let projects

const toolDefinitions = [
  {
    name: 'project_list',
    description:
      'List every project: number, icon, title, file count, and last-edited time. Use this before viewing, editing, or deleting one so you reference it by the correct number, title, or id.',
    parameters: { type: 'object', properties: {}, required: [] }
  },
  {
    name: 'project_view',
    description:
      "Show one project in full: icon, title, complete instructions, its file list with per-file existence and size, and its working folders. Identify it by the number from project_list, its exact title, or its id.",
    parameters: {
      type: 'object',
      properties: {
        identifier: {
          type: 'string',
          description:
            'The project — its 1-based number from project_list, its exact title, or its id.'
        }
      },
      required: ['identifier']
    }
  },
  {
    name: 'project_create',
    description:
      'Create a new project with a title, an optional emoji icon, and optional instructions. Returns the created project and its id.',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Project title' },
        icon: { type: 'string', description: 'Emoji icon (one emoji), e.g. "📚"' },
        instructions: {
          type: 'string',
          description: 'Instructions every conversation in this project starts from'
        }
      },
      required: ['title']
    }
  },
  {
    name: 'project_update',
    description:
      'Edit a project’s title, emoji icon, or instructions (omitted fields are kept). For files use project_add_files / project_remove_file.',
    parameters: {
      type: 'object',
      properties: {
        identifier: {
          type: 'string',
          description: 'The project — number from project_list, exact title, or id.'
        },
        title: { type: 'string', description: 'New title' },
        icon: { type: 'string', description: 'New emoji icon' },
        instructions: { type: 'string', description: 'New instructions (replaces the old text)' }
      },
      required: ['identifier']
    }
  },
  {
    name: 'project_add_files',
    description:
      'Attach files to a project by absolute path (or ~ prefix). Each source is COPIED into the project’s workspace folder (uploads/project-<id>/), so the project owns its files — the original stays where it was. Missing sources are refused; an already-attached name is skipped.',
    parameters: {
      type: 'object',
      properties: {
        identifier: {
          type: 'string',
          description: 'The project — number from project_list, exact title, or id.'
        },
        paths: {
          type: 'array',
          items: { type: 'string' },
          description: 'Absolute file paths to attach'
        }
      },
      required: ['identifier', 'paths']
    }
  },
  {
    name: 'project_remove_file',
    description:
      'Detach one file from a project by its path or file name. The project’s own workspace copy is deleted; the user’s original outside the workspace is never touched.',
    parameters: {
      type: 'object',
      properties: {
        identifier: {
          type: 'string',
          description: 'The project — number from project_list, exact title, or id.'
        },
        file: { type: 'string', description: 'The attached file’s path or name to remove' }
      },
      required: ['identifier', 'file']
    }
  },
  {
    name: 'project_delete',
    description:
      'Permanently delete a project. Its past conversations stay in history (they simply lose the project context on future turns). Requires user approval.',
    parameters: {
      type: 'object',
      properties: {
        identifier: {
          type: 'string',
          description: 'The project — number from project_list, exact title, or id.'
        }
      },
      required: ['identifier']
    }
  },
  {
    name: 'project_conversations',
    description:
      'List every conversation belonging to a project (search by project): title, id, message count, last activity — newest first. Follow up with conversation_read on an id to revisit what was discussed there.',
    parameters: {
      type: 'object',
      properties: {
        identifier: {
          type: 'string',
          description: 'The project — number from project_list, exact title, or id.'
        }
      },
      required: ['identifier']
    }
  }
]

function requireHost() {
  if (!projects) {
    throw new Error(
      'Project management is unavailable in this context (no host bridge). This should not happen inside the app — report it.'
    )
  }
  return projects
}

function resolveUserPath(input) {
  if (typeof input !== 'string' || input.length === 0) throw new Error('path is required')
  if (input === '~') return os.homedir()
  if (input.startsWith('~/') || input.startsWith('~\\')) {
    return path.join(os.homedir(), input.slice(2))
  }
  return path.resolve(input)
}

/** Resolve a project by 1-based list number, exact title (case-insensitive), or id. */
async function resolveProject(identifier) {
  const all = await requireHost().list()
  const raw = String(identifier ?? '').trim()
  if (!raw) throw new Error('identifier is required')
  const byId = all.find((p) => p.id === raw)
  if (byId) return byId
  const byTitle = all.filter((p) => p.title.trim().toLowerCase() === raw.toLowerCase())
  if (byTitle.length === 1) return byTitle[0]
  if (byTitle.length > 1) {
    throw new Error(`Multiple projects titled "${raw}" — use the id from project_list.`)
  }
  const num = /^\d+$/.test(raw) ? parseInt(raw, 10) : NaN
  if (Number.isFinite(num) && num >= 1 && num <= all.length) return all[num - 1]
  throw new Error(
    `No project matches "${raw}". project_list shows ${all.length} project${all.length === 1 ? '' : 's'} — reference one by number, exact title, or id.`
  )
}

function sizeLabel(bytes) {
  const mb = bytes / 1024 / 1024
  return mb >= 1 ? `${mb.toFixed(1)}MB` : `${Math.ceil(bytes / 1024)}KB`
}

function headerLine(p) {
  return `${p.icon || '📁'} ${p.title.trim() || 'Untitled'} (id: ${p.id})`
}

async function listTool() {
  const all = await requireHost().list()
  if (all.length === 0) {
    return { success: true, output: 'No projects yet. project_create makes one.' }
  }
  const lines = all.map((p, i) => {
    const edited = new Date(p.updatedAt).toISOString().slice(0, 16).replace('T', ' ')
    return `${i + 1}. ${headerLine(p)} — ${p.files.length} file${p.files.length === 1 ? '' : 's'}, edited ${edited}`
  })
  return { success: true, output: lines.join('\n') }
}

async function viewTool(args) {
  const p = await resolveProject(args.identifier)
  const lines = [headerLine(p)]
  lines.push('')
  lines.push(p.instructions.trim() ? `Instructions:\n${p.instructions.trim()}` : '(no instructions yet)')
  lines.push('')
  if (p.files.length === 0) {
    lines.push('Files: none')
  } else {
    lines.push(`Files (${p.files.length}) — content is never auto-loaded; read via pdf/file/image tools:`)
    for (const f of p.files) {
      let fact = 'missing from disk'
      try {
        fact = sizeLabel((await fs.stat(f.path)).size)
      } catch {
        // keep "missing from disk"
      }
      lines.push(`- ${f.name} (${fact}) at ${f.path}`)
    }
  }
  // Working folders are part of what a project IS — every turn inside it gets a
  // fresh listing of each one — so a view that hid them would misdescribe it.
  // They are attached in the app, not from here.
  if ((p.directories ?? []).length > 0) {
    lines.push('')
    lines.push(`Working folders (${p.directories.length}) — every turn gets a fresh listing:`)
    for (const dir of p.directories) lines.push(`- ${dir}`)
  }
  return { success: true, output: lines.join('\n') }
}

async function createTool(args) {
  const title = String(args.title ?? '').trim()
  if (!title) return { success: false, error: 'title is required and must be non-empty' }
  const created = await requireHost().create({
    title,
    icon: typeof args.icon === 'string' && args.icon.trim() ? args.icon.trim() : undefined,
    instructions: typeof args.instructions === 'string' ? args.instructions : undefined
  })
  return { success: true, output: `Created ${headerLine(created)}.` }
}

async function updateTool(args) {
  const p = await resolveProject(args.identifier)
  const patch = {}
  if (typeof args.title === 'string' && args.title.trim()) patch.title = args.title.trim()
  if (typeof args.icon === 'string' && args.icon.trim()) patch.icon = args.icon.trim()
  if (typeof args.instructions === 'string') patch.instructions = args.instructions
  if (Object.keys(patch).length === 0) {
    return { success: false, error: 'Nothing to update — pass title, icon, or instructions.' }
  }
  const updated = await requireHost().update(p.id, patch)
  return {
    success: true,
    output: `Updated ${headerLine(updated)} (${Object.keys(patch).join(', ')}). Applies to the NEXT turn of its conversations.`
  }
}

async function addFilesTool(args) {
  const p = await resolveProject(args.identifier)
  const rawPaths = Array.isArray(args.paths) ? args.paths : []
  if (rawPaths.length === 0) return { success: false, error: 'paths must be a non-empty array' }
  // Copy-on-attach happens host-side (single chokepoint shared with the
  // app's picker): sources are COPIED into uploads/project-<id>/, so the
  // project owns its files and never dangles on a moved original.
  const result = await requireHost().attachFiles(
    p.id,
    rawPaths.map((raw) => resolveUserPath(String(raw)))
  )
  const lines = []
  if (result.added.length > 0) {
    lines.push(
      `Attached ${result.added.map((f) => f.name).join(', ')} to ${headerLine(p)} — copied into the project's workspace folder.`
    )
  }
  if (result.skipped.length > 0) {
    lines.push(`Already attached (same name, not copied again): ${result.skipped.join(', ')}`)
  }
  if (result.missing.length > 0) {
    lines.push(`Not found on disk (NOT attached): ${result.missing.join(', ')}`)
  }
  if (result.added.length === 0 && result.missing.length > 0 && result.skipped.length === 0) {
    return { success: false, error: lines.join('\n') }
  }
  return { success: true, output: lines.join('\n') }
}

async function removeFileTool(args) {
  const p = await resolveProject(args.identifier)
  const raw = String(args.file ?? '').trim()
  if (!raw) return { success: false, error: 'file is required' }
  const target =
    p.files.find((f) => f.path === raw) ??
    p.files.find((f) => f.name === raw) ??
    p.files.find((f) => f.name.toLowerCase() === raw.toLowerCase())
  if (!target) {
    return {
      success: false,
      error: `No attached file matches "${raw}". project_view shows the current list.`
    }
  }
  await requireHost().update(p.id, { files: p.files.filter((f) => f.path !== target.path) })
  return { success: true, output: `Detached ${target.name} from ${headerLine(p)}. The file on disk is untouched.` }
}

async function deleteTool(args) {
  const p = await resolveProject(args.identifier)
  const result = await requireHost().delete(p.id)
  if (result && result.ok === false) {
    return { success: false, error: result.error ?? 'Delete failed.' }
  }
  return {
    success: true,
    output: `Deleted ${headerLine(p)}. Its conversations remain in history without the project context.`
  }
}

async function conversationsTool(args) {
  const p = await resolveProject(args.identifier)
  const rows = await requireHost().conversationsFor(p.id)
  if (rows.length === 0) {
    return { success: true, output: `${headerLine(p)} has no conversations yet.` }
  }
  const lines = [`Conversations in ${headerLine(p)} (${rows.length}):`]
  rows.forEach((c, i) => {
    const at = new Date(c.updatedAt).toISOString().slice(0, 16).replace('T', ' ')
    lines.push(
      `${i + 1}. ${c.title || 'Untitled'} — ${c.messageCount} message${c.messageCount === 1 ? '' : 's'}, last activity ${at} (id: ${c.id})`
    )
  })
  lines.push('')
  lines.push('conversation_read with an id revisits what was discussed there.')
  return { success: true, output: lines.join('\n') }
}

function describeAction(toolName, args) {
  const ident = String(args?.identifier ?? args?.title ?? '')
  switch (toolName) {
    case 'project_list':
      return { title: 'List projects', description: 'List all projects', risk: 'low' }
    case 'project_view':
      return { title: 'View project', description: `View project ${ident}`, risk: 'low' }
    case 'project_conversations':
      return { title: 'List project chats', description: `Conversations of ${ident}`, risk: 'low' }
    case 'project_create':
      return { title: 'Create project', description: `Create project "${ident}"`, risk: 'medium' }
    case 'project_update':
      return { title: 'Edit project', description: `Edit project ${ident}`, risk: 'medium' }
    case 'project_add_files':
      return { title: 'Attach files', description: `Attach files to ${ident}`, risk: 'medium' }
    case 'project_remove_file':
      return { title: 'Detach file', description: `Detach a file from ${ident}`, risk: 'medium' }
    case 'project_delete':
      return { title: 'Delete project', description: `Delete project ${ident}`, risk: 'high' }
    default:
      return null
  }
}

const plugin = {
  name: 'projects',
  tools: toolDefinitions,
  describeAction,
  async init(context) {
    projects = context?.projects
  },
  async execute(toolName, args) {
    try {
      switch (toolName) {
        case 'project_list':
          return await listTool()
        case 'project_view':
          return await viewTool(args ?? {})
        case 'project_create':
          return await createTool(args ?? {})
        case 'project_update':
          return await updateTool(args ?? {})
        case 'project_add_files':
          return await addFilesTool(args ?? {})
        case 'project_remove_file':
          return await removeFileTool(args ?? {})
        case 'project_delete':
          return await deleteTool(args ?? {})
        case 'project_conversations':
          return await conversationsTool(args ?? {})
        default:
          return { success: false, error: `projects: unknown tool ${toolName}` }
      }
    } catch (err) {
      return { success: false, error: err?.message ?? String(err) }
    }
  }
}

export default plugin
