import { Client } from '@notionhq/client'
import fs from 'node:fs/promises'
import path from 'node:path'

let workspaceRoot = null
let cachedClient = null
let cachedToken = null

const NOTION_VERSION = '2022-06-28'
// Raw escape-hatch config. notion_api talks to Notion over native fetch (not
// the SDK client) so it can reach endpoints the pinned SDK/Notion-Version
// doesn't know about and set a per-call Notion-Version.
const NOTION_API_BASE = 'https://api.notion.com/v1/'
const RAW_TIMEOUT_MS = 30_000
const RAW_ALLOWED_METHODS = ['GET', 'POST', 'PATCH', 'DELETE']

// Read every labeled Notion connection from config.json. The user can link
// several Notion workspaces (each with a user-assigned label like "Personal"
// or "Wolffish"); the model picks one per call via the `connection` param.
// Tolerates the legacy single-token shape so a call right after an update —
// before migrateConnections() rewrites config.json — still resolves.
async function readConnections() {
  if (!workspaceRoot) return []
  try {
    const raw = await fs.readFile(path.join(workspaceRoot, 'config.json'), 'utf8')
    const cfg = JSON.parse(raw)
    const notion = cfg?.notion
    if (Array.isArray(notion?.connections)) {
      return notion.connections
        .map((c) => ({
          label: String(c?.label ?? '').trim() || 'Default',
          token: String(c?.token ?? '').trim(),
          name: String(c?.name ?? ''),
          email: String(c?.email ?? '')
        }))
        .filter((c) => c.token)
    }
    // Legacy single-token shape.
    const token = String(notion?.token ?? '').trim()
    if (token) {
      return [
        {
          label: String(notion?.label ?? '').trim() || 'Default',
          token,
          name: String(notion?.name ?? ''),
          email: String(notion?.email ?? '')
        }
      ]
    }
    return []
  } catch {
    return []
  }
}

// Resolve which connection a tool call should use. Returns { connection } or
// { error } (a ready-to-return tool failure). Rules: 0 connections → not
// configured; explicit `connection` label → exact (case-insensitive) match or
// an error listing the available labels; no label with exactly one connection
// → use it; no label with several → force the model to disambiguate.
function resolveConnection(connections, args) {
  if (connections.length === 0) {
    return {
      error: {
        success: false,
        error:
          'Notion is not configured. Go to Settings → Services → Notion and add a connection (a label plus an integration token).'
      }
    }
  }
  const wanted = String(args?.connection ?? '').trim()
  if (wanted) {
    const matches = connections.filter((c) => c.label.toLowerCase() === wanted.toLowerCase())
    if (matches.length === 0) {
      const labels = connections.map((c) => `"${c.label}"`).join(', ')
      return {
        error: {
          success: false,
          error: `No Notion connection labeled "${wanted}". Available connections: ${labels}. Pass one of these labels as \`connection\`.`
        }
      }
    }
    if (matches.length > 1) {
      // Never silently pick one of two same-labeled connections for a write.
      return {
        error: {
          success: false,
          error: `More than one Notion connection is labeled "${wanted}". Labels must be unique — rename them in Settings → Services → Notion so this one can be selected unambiguously.`
        }
      }
    }
    return { connection: matches[0] }
  }
  if (connections.length === 1) return { connection: connections[0] }
  const labels = connections.map((c) => `"${c.label}"`).join(', ')
  return {
    error: {
      success: false,
      error: `Multiple Notion connections are configured: ${labels}. Specify which one to use by passing its label as the \`connection\` parameter.`
    }
  }
}

// Build (or reuse) a Notion client for the connection selected by `args`.
// Returns { client } or { error }. The client is cached per token so repeated
// calls to the same connection don't rebuild it.
async function getClientFor(args) {
  const connections = await readConnections()
  const resolved = resolveConnection(connections, args)
  if (resolved.error) return { error: resolved.error }
  const token = resolved.connection.token
  if (cachedClient && cachedToken === token) return { client: cachedClient }
  cachedClient = new Client({ auth: token, notionVersion: NOTION_VERSION })
  cachedToken = token
  return { client: cachedClient }
}

function normalizeId(id) {
  if (!id || typeof id !== 'string') return id
  return id.replace(/-/g, '')
}

// Resolve the parent object for a page/database create, tolerating the common
// shape mistakes models make. Canonical form is { database_id } or { page_id };
// we also accept a top-level database_id/page_id (the shape sibling tools like
// notion_read_database and notion_update_page use, which is the most frequent
// slip) and pass through any other non-empty object verbatim so Notion can
// validate exotic/newer parent types (e.g. { workspace: true }). Returns the
// parent object or null when there's nothing usable to build one from.
function resolveParent(args) {
  const p = args?.parent
  if (p && typeof p === 'object' && !Array.isArray(p)) {
    if (typeof p.database_id === 'string' && p.database_id.trim()) {
      return { database_id: normalizeId(p.database_id) }
    }
    if (typeof p.page_id === 'string' && p.page_id.trim()) {
      return { page_id: normalizeId(p.page_id) }
    }
    if (Object.keys(p).length > 0) return p
  }
  if (typeof args?.database_id === 'string' && args.database_id.trim()) {
    return { database_id: normalizeId(args.database_id) }
  }
  if (typeof args?.page_id === 'string' && args.page_id.trim()) {
    return { page_id: normalizeId(args.page_id) }
  }
  return null
}

function ok(data) {
  return { success: true, output: JSON.stringify(data) }
}

// Pull a human-readable message out of a thrown error's body. @notionhq/client's
// APIResponseError leaves err.body as a raw JSON string (and already mirrors the
// hint onto err.message); the notion_api raw tool reshapes a non-2xx response
// into { body: { message } }. Handle both shapes.
function bodyMessageOf(err) {
  if (typeof err?.body === 'string') {
    try {
      return JSON.parse(err.body)?.message
    } catch {
      return undefined
    }
  }
  return err?.body?.message
}

function fail(err) {
  // err.message FIRST: for SDK errors this is exactly the original behavior
  // (err.body was a string, so the old err?.body?.message term was always
  // undefined and it fell through to err.message). bodyMessageOf is the
  // fallback that lets notion_api's { body: { message } } object surface its
  // message — it has no err.message. So existing tools are byte-for-byte
  // unchanged and the raw tool still gets Notion's guidance.
  const message = err?.message ?? bodyMessageOf(err) ?? String(err)
  const code = err?.code ?? err?.status
  return { success: false, error: code ? `Notion API error (${code}): ${message}` : message }
}

// Combined message + body text, used to detect Notion's page-vs-database hints
// so a read of the "wrong" id kind can self-heal to the right endpoint.
function errorDetail(err) {
  const parts = []
  if (err?.message) parts.push(String(err.message))
  const bm = bodyMessageOf(err)
  if (bm) parts.push(String(bm))
  return parts.join(' ')
}

// --- Tool implementations ---

async function executeSearch(args) {
  const { client, error } = await getClientFor(args)
  if (error) return error

  try {
    const params = { query: args?.query ?? '' }
    if (args?.filter != null && args.filter !== '') {
      if (args.filter !== 'page' && args.filter !== 'database') {
        return {
          success: false,
          error: 'filter must be "page" or "database" (or omit it to search both).'
        }
      }
      params.filter = { value: args.filter, property: 'object' }
    }
    // Apply the documented default of 10 even when page_size is omitted —
    // otherwise Notion's own default returns up to 100 results, ~10x the
    // intended payload (and the context this app tries to keep lean).
    params.page_size = Math.min(Number(args?.page_size) || 10, 100)
    if (args?.sort_direction) {
      params.sort = { direction: args.sort_direction, timestamp: 'last_edited_time' }
    }
    const response = await client.search(params)
    return ok(response)
  } catch (e) {
    return fail(e)
  }
}

async function executeReadPage(args) {
  const { client, error } = await getClientFor(args)
  if (error) return error

  const pageId = normalizeId(args?.page_id)
  if (!pageId) return { success: false, error: 'page_id is required' }

  try {
    const response = await client.pages.retrieve({ page_id: pageId })
    return ok(response)
  } catch (e) {
    // Self-heal the classic page-vs-database mixup. Notion page and database
    // IDs are indistinguishable UUIDs, so a database id lands here and Notion
    // responds "…is a database, not a page. Use the retrieve database API
    // instead." Do exactly that transparently — "read this id" should just
    // work whether it turns out to be a page or a database. The returned
    // object carries `"object": "database"`, so the caller can still tell.
    if (/is a database/i.test(errorDetail(e))) {
      try {
        const db = await client.databases.retrieve({ database_id: pageId })
        return ok(db)
      } catch {
        // fall through to the original page error below
      }
    }
    return fail(e)
  }
}

async function executeReadBlocks(args) {
  const { client, error } = await getClientFor(args)
  if (error) return error

  const blockId = normalizeId(args?.block_id)
  if (!blockId) return { success: false, error: 'block_id is required' }

  try {
    const params = { block_id: blockId }
    if (args?.page_size) params.page_size = Math.min(Number(args.page_size) || 100, 100)
    if (args?.start_cursor) params.start_cursor = args.start_cursor
    const response = await client.blocks.children.list(params)
    return ok(response)
  } catch (e) {
    return fail(e)
  }
}

async function executeCreatePage(args) {
  const { client, error } = await getClientFor(args)
  if (error) return error

  const parent = resolveParent(args)
  if (!parent) {
    return {
      success: false,
      error:
        'parent is required — say where the page goes. Pass parent: { "database_id": "<id>" } to add a row to a database, or parent: { "page_id": "<id>" } to create a subpage under a page. There is no default or "current" page; every create needs its own parent. Don\'t have the id? Find it first with notion_search, or read a database with notion_get_database. (A top-level database_id/page_id is also accepted.)'
    }
  }
  if (!args?.properties) {
    return {
      success: false,
      error:
        'properties is required. For a database parent, the keys must match the database columns — at minimum set the title column; read the schema with notion_get_database if unsure. For a page parent, use { "title": { "title": [{ "text": { "content": "Page Title" } }] } }.'
    }
  }

  try {
    const params = { parent, properties: args.properties }
    if (args?.children) params.children = args.children
    if (args?.icon) params.icon = args.icon
    if (args?.cover) params.cover = args.cover
    const response = await client.pages.create(params)
    return ok(response)
  } catch (e) {
    return fail(e)
  }
}

async function executeUpdatePage(args) {
  const { client, error } = await getClientFor(args)
  if (error) return error

  const pageId = normalizeId(args?.page_id)
  if (!pageId) return { success: false, error: 'page_id is required' }

  try {
    const params = { page_id: pageId }
    if (args?.properties) params.properties = args.properties
    if (args?.icon) params.icon = args.icon
    if (args?.cover) params.cover = args.cover
    if (typeof args?.archived === 'boolean') params.archived = args.archived
    const response = await client.pages.update(params)
    return ok(response)
  } catch (e) {
    return fail(e)
  }
}

async function executeAppendBlocks(args) {
  const { client, error } = await getClientFor(args)
  if (error) return error

  const blockId = normalizeId(args?.block_id)
  if (!blockId) return { success: false, error: 'block_id is required' }
  if (!args?.children || !Array.isArray(args.children)) {
    return { success: false, error: 'children array is required' }
  }

  try {
    const response = await client.blocks.children.append({
      block_id: blockId,
      children: args.children
    })
    return ok(response)
  } catch (e) {
    return fail(e)
  }
}

async function executeReadDatabase(args) {
  const { client, error } = await getClientFor(args)
  if (error) return error

  const databaseId = normalizeId(args?.database_id)
  if (!databaseId) return { success: false, error: 'database_id is required' }

  try {
    const params = { database_id: databaseId }
    if (args?.filter) params.filter = args.filter
    if (args?.sorts) params.sorts = args.sorts
    if (args?.page_size) params.page_size = Math.min(Number(args.page_size) || 100, 100)
    if (args?.start_cursor) params.start_cursor = args.start_cursor
    const response = await client.databases.query(params)
    return ok(response)
  } catch (e) {
    return fail(e)
  }
}

async function executeUpdateBlock(args) {
  const { client, error } = await getClientFor(args)
  if (error) return error

  const blockId = normalizeId(args?.block_id)
  if (!blockId) return { success: false, error: 'block_id is required' }

  // Guard the silent no-op: blocks.update({ block_id }) with nothing else
  // returns 200 with the UNCHANGED block, which would falsely report success.
  // Content edits need BOTH type and content; archiving needs the boolean.
  const hasType = typeof args?.type === 'string' && args.type.trim().length > 0
  const hasContent = args?.content != null && typeof args.content === 'object'
  const hasArchived = typeof args?.archived === 'boolean'
  if (hasType !== hasContent) {
    return {
      success: false,
      error:
        'notion_update_block needs BOTH `type` and `content` to change block content (got only one).'
    }
  }
  if (!hasType && !hasArchived) {
    return {
      success: false,
      error: 'Nothing to update: pass `type` + `content` to change content, or `archived: true` to delete.'
    }
  }

  try {
    const params = { block_id: blockId }
    if (hasType && hasContent) {
      params[args.type] = args.content
    }
    if (hasArchived) params.archived = args.archived
    const response = await client.blocks.update(params)
    return ok(response)
  } catch (e) {
    return fail(e)
  }
}

async function executeGetDatabase(args) {
  const { client, error } = await getClientFor(args)
  if (error) return error

  const databaseId = normalizeId(args?.database_id)
  if (!databaseId) return { success: false, error: 'database_id is required' }

  try {
    const response = await client.databases.retrieve({ database_id: databaseId })
    return ok(response)
  } catch (e) {
    // Symmetric self-heal: a page id handed to the schema tool still resolves
    // in one hop instead of dead-ending on "…is a page, not a database."
    if (/is a page/i.test(errorDetail(e))) {
      try {
        const page = await client.pages.retrieve({ page_id: databaseId })
        return ok(page)
      } catch {
        // fall through to the original database error below
      }
    }
    return fail(e)
  }
}

async function executeDeleteBlock(args) {
  const { client, error } = await getClientFor(args)
  if (error) return error

  const blockId = normalizeId(args?.block_id)
  if (!blockId) return { success: false, error: 'block_id is required' }

  try {
    const response = await client.blocks.delete({ block_id: blockId })
    return ok(response)
  } catch (e) {
    return fail(e)
  }
}

async function executeCreateDatabase(args) {
  const { client, error } = await getClientFor(args)
  if (error) return error

  if (!args?.parent) return { success: false, error: 'parent is required' }
  if (!args?.title) return { success: false, error: 'title is required' }
  if (!args?.properties) return { success: false, error: 'properties is required' }

  try {
    const params = {
      parent: args.parent,
      title: args.title,
      properties: args.properties
    }
    if (args?.icon) params.icon = args.icon
    if (args?.cover) params.cover = args.cover
    const response = await client.databases.create(params)
    return ok(response)
  } catch (e) {
    return fail(e)
  }
}

async function executeUpdateDatabase(args) {
  const { client, error } = await getClientFor(args)
  if (error) return error

  const databaseId = normalizeId(args?.database_id)
  if (!databaseId) return { success: false, error: 'database_id is required' }

  try {
    const params = { database_id: databaseId }
    if (args?.title) params.title = args.title
    if (args?.description) params.description = args.description
    if (args?.properties) params.properties = args.properties
    const response = await client.databases.update(params)
    return ok(response)
  } catch (e) {
    return fail(e)
  }
}

async function executeListUsers(args) {
  const { client, error } = await getClientFor(args)
  if (error) return error

  try {
    const params = {}
    if (args?.page_size) params.page_size = Math.min(Number(args.page_size) || 100, 100)
    if (args?.start_cursor) params.start_cursor = args.start_cursor
    const response = await client.users.list(params)
    return ok(response)
  } catch (e) {
    return fail(e)
  }
}

async function executeGetUser(args) {
  const { client, error } = await getClientFor(args)
  if (error) return error

  if (!args?.user_id) return { success: false, error: 'user_id is required' }

  try {
    const response = await client.users.retrieve({ user_id: args.user_id })
    return ok(response)
  } catch (e) {
    return fail(e)
  }
}

async function executeAddComment(args) {
  const { client, error } = await getClientFor(args)
  if (error) return error

  if (!args?.rich_text) return { success: false, error: 'rich_text is required' }
  if (!args?.parent && !args?.discussion_id) {
    return { success: false, error: 'Either parent or discussion_id is required' }
  }

  try {
    const params = { rich_text: args.rich_text }
    if (args?.parent) params.parent = args.parent
    if (args?.discussion_id) params.discussion_id = args.discussion_id
    const response = await client.comments.create(params)
    return ok(response)
  } catch (e) {
    return fail(e)
  }
}

async function executeListComments(args) {
  const { client, error } = await getClientFor(args)
  if (error) return error

  if (!args?.block_id) return { success: false, error: 'block_id is required' }

  try {
    const params = { block_id: normalizeId(args.block_id) }
    if (args?.page_size) params.page_size = Math.min(Number(args.page_size) || 100, 100)
    if (args?.start_cursor) params.start_cursor = args.start_cursor
    const response = await client.comments.list(params)
    return ok(response)
  } catch (e) {
    return fail(e)
  }
}

async function executeConnections() {
  const connections = await readConnections()
  const payload = {
    connections: connections.map((c) => ({
      label: c.label,
      name: c.name || null,
      email: c.email || null
    })),
    note:
      connections.length === 0
        ? 'No Notion connections are configured. Ask the user to add one in Settings → Services → Notion (each has a label and an integration token).'
        : 'Each connection is one Notion workspace the user linked, identified by a user-assigned label (e.g. "Personal", "Wolffish"). Pass the matching label as the `connection` parameter on every notion_* tool call. You may omit it only when exactly one connection exists. Match the label to the user\'s intent — e.g. "my personal notion" → the connection labeled "Personal".'
  }
  return ok(payload)
}

// Normalize a caller-supplied path into a path relative to the /v1 API root,
// pinning the host. Accepts "databases/{id}", "/v1/databases/{id}", a bare
// "v1/…", or a full https://api.notion.com/… URL. Returns { path } or { error }.
function normalizeApiPath(rawPath) {
  let p = String(rawPath ?? '').trim()
  if (!p) {
    return { error: 'path is required (e.g. "databases/{id}", "blocks/{id}", "users/me").' }
  }
  if (/^https?:\/\//i.test(p)) {
    let url
    try {
      url = new URL(p)
    } catch {
      return { error: `Invalid URL in path: ${p}` }
    }
    if (url.host !== 'api.notion.com') {
      return { error: `notion_api only calls api.notion.com — refusing host "${url.host}".` }
    }
    // Keep url.search — a full URL may carry its own query (e.g. ?start_cursor=…);
    // dropping it would silently page the first page instead of the cursor page.
    p = url.pathname + url.search
  }
  p = p.replace(/^\/+/, '').replace(/^v1\//i, '').replace(/^\/+/, '')
  if (!p) return { error: 'path resolved to empty after normalization.' }
  if (p.split('/').some((seg) => seg === '..')) {
    return { error: 'path may not contain ".." segments.' }
  }
  return { path: p }
}

function buildQueryString(query) {
  if (!query || typeof query !== 'object' || Array.isArray(query)) return ''
  const usp = new URLSearchParams()
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null) continue
    if (Array.isArray(value)) {
      for (const v of value) usp.append(key, String(v))
    } else {
      usp.append(key, String(value))
    }
  }
  const s = usp.toString()
  return s ? `?${s}` : ''
}

// Generic raw request to any Notion REST endpoint. Reuses only the token
// resolution (readConnections/resolveConnection), not the cached SDK client,
// so the Notion-Version header can be overridden per call. Response shaping is
// byte-for-byte identical to ok()/fail() so the model can't tell a raw call
// from a dedicated one and error hints (e.g. object_not_found) still surface.
async function executeApi(args) {
  const connections = await readConnections()
  const resolved = resolveConnection(connections, args)
  if (resolved.error) return resolved.error
  const token = resolved.connection.token

  // Canonicalize by case ONLY — deliberately do NOT trim surrounding
  // whitespace. The approval gate (amygdala) matches the RAW, un-normalized
  // args via a regex anchored to "delete"/"post"/"patch"; if the executor
  // silently repaired " DELETE " into a valid verb, a padded method would
  // execute a raw write while slipping past that gate. Rejecting non-canonical
  // methods here keeps the value that reaches Notion identical to the value the
  // gate inspected, so writes/deletes can never run unprompted.
  const method = String(args?.method ?? '').toUpperCase() || 'GET'
  if (!RAW_ALLOWED_METHODS.includes(method)) {
    return {
      success: false,
      error: `method must be exactly one of ${RAW_ALLOWED_METHODS.join(', ')} (no surrounding spaces); got ${JSON.stringify(args?.method ?? '')}.`
    }
  }

  const normalized = normalizeApiPath(args?.path)
  if (normalized.error) return { success: false, error: normalized.error }

  let version = NOTION_VERSION
  const rawVersion = args?.notion_version != null ? String(args.notion_version).trim() : ''
  if (rawVersion) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(rawVersion)) {
      return { success: false, error: 'notion_version must be a date like "2022-06-28".' }
    }
    version = rawVersion
  }

  // Join the explicit `query` object onto the path. If the path already carries
  // an inline query (from a full-URL input), switch the separator to '&' so we
  // never emit a malformed "path?a=1?b=2".
  const qs = buildQueryString(args?.query)
  const joinedQs = qs && normalized.path.includes('?') ? '&' + qs.slice(1) : qs
  const url = NOTION_API_BASE + normalized.path + joinedQs
  const headers = {
    Authorization: `Bearer ${token}`,
    'Notion-Version': version
  }
  const init = { method, headers }
  const sendsBody =
    (method === 'POST' || method === 'PATCH') &&
    args?.body != null &&
    typeof args.body === 'object'
  if (sendsBody) {
    headers['Content-Type'] = 'application/json'
    init.body = JSON.stringify(args.body)
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), RAW_TIMEOUT_MS)
  init.signal = controller.signal
  let response
  try {
    response = await fetch(url, init)
  } catch (err) {
    const aborted = err?.name === 'AbortError'
    return { success: false, error: aborted ? 'Request timed out' : (err?.message ?? String(err)) }
  } finally {
    clearTimeout(timer)
  }

  const text = await response.text().catch(() => '')
  let json = {}
  if (text) {
    try {
      json = JSON.parse(text)
    } catch {
      json = { raw: text }
    }
  }

  if (!response.ok) {
    const code = json?.code ?? `http_${response.status}`
    const message = json?.message ?? response.statusText ?? 'Request failed'
    return fail({ code, status: response.status, body: { message } })
  }
  return ok(json)
}

// --- Tool descriptors ---

const CONNECTION_PARAM = {
  type: 'string',
  description:
    'Which linked Notion connection to use, by its user-assigned label (e.g. "Personal", "Wolffish"). Optional when only one connection is configured; required to disambiguate when several exist. Call notion_connections to list labels.'
}

const toolDefinitions = [
  {
    name: 'notion_connections',
    description:
      'List the configured Notion connections (their labels and connected account) so you know which `connection` to pass on other notion_* tools. Does not expose tokens.',
    parameters: { type: 'object', properties: {}, required: [] }
  },
  {
    name: 'notion_search',
    description:
      'Search across all pages and databases the integration can access. Returns page/database titles, IDs, and snippets.',
    parameters: {
      type: 'object',
      properties: {
        connection: CONNECTION_PARAM,
        query: { type: 'string', description: 'Search query text' },
        filter: {
          type: 'string',
          description: '"page" or "database" to limit result type. Omit for both.'
        },
        page_size: { type: 'number', description: 'Max results (default 10, max 100)' },
        sort_direction: {
          type: 'string',
          description: '"ascending" or "descending" by last_edited_time'
        }
      },
      required: ['query']
    }
  },
  {
    name: 'notion_read_page',
    description:
      "Retrieve a page's properties (title, status, dates, relations, etc). Returns raw Notion JSON.",
    parameters: {
      type: 'object',
      properties: {
        connection: CONNECTION_PARAM,
        page_id: { type: 'string', description: 'The page ID (UUID)' }
      },
      required: ['page_id']
    }
  },
  {
    name: 'notion_read_blocks',
    description: 'Read block content (body) of a page or block. Returns array of block objects.',
    parameters: {
      type: 'object',
      properties: {
        connection: CONNECTION_PARAM,
        block_id: { type: 'string', description: 'Page or block ID to read children of' },
        page_size: { type: 'number', description: 'Max blocks per request (default 100)' },
        start_cursor: { type: 'string', description: 'Cursor for pagination' }
      },
      required: ['block_id']
    }
  },
  {
    name: 'notion_create_page',
    description:
      'Create a new page. You MUST specify a parent (a database or a page) — there is no default location. Provide properties, plus optional body blocks. To create several pages, call this once per page, each with its own parent.',
    parameters: {
      type: 'object',
      properties: {
        connection: CONNECTION_PARAM,
        parent: {
          type: 'object',
          description:
            'REQUIRED — where the page goes: { "database_id": "<id>" } to add a row to a database, or { "page_id": "<id>" } to create a subpage. No default/"current" page. Get the id from notion_search, notion_get_database, or the Notion URL.'
        },
        properties: {
          type: 'object',
          description:
            'REQUIRED. Notion property-value objects. For a database parent, keys must match the columns (read them with notion_get_database); at minimum set the title column. For a page parent: { "title": { "title": [{ "text": { "content": "Page Title" } }] } }.'
        },
        children: { type: 'array', description: 'Array of block objects for the page body' },
        icon: { type: 'object', description: 'Icon object' },
        cover: { type: 'object', description: 'Cover image object' }
      },
      required: ['parent', 'properties']
    }
  },
  {
    name: 'notion_update_page',
    description: "Update a page's properties, icon, cover, or archive status.",
    parameters: {
      type: 'object',
      properties: {
        connection: CONNECTION_PARAM,
        page_id: { type: 'string', description: 'The page ID to update' },
        properties: { type: 'object', description: 'Properties to update' },
        icon: { type: 'object', description: 'New icon' },
        cover: { type: 'object', description: 'New cover' },
        archived: { type: 'boolean', description: 'Set true to archive (soft-delete)' }
      },
      required: ['page_id']
    }
  },
  {
    name: 'notion_append_blocks',
    description: 'Append new block children to a page or block.',
    parameters: {
      type: 'object',
      properties: {
        connection: CONNECTION_PARAM,
        block_id: { type: 'string', description: 'Parent page or block ID' },
        children: { type: 'array', description: 'Array of block objects to append' }
      },
      required: ['block_id', 'children']
    }
  },
  {
    name: 'notion_read_database',
    description:
      'Query a database with optional filters and sorts. Returns array of page objects (rows).',
    parameters: {
      type: 'object',
      properties: {
        connection: CONNECTION_PARAM,
        database_id: { type: 'string', description: 'The database ID' },
        filter: { type: 'object', description: 'Notion filter object' },
        sorts: { type: 'array', description: 'Array of sort objects' },
        page_size: { type: 'number', description: 'Max results (default 100)' },
        start_cursor: { type: 'string', description: 'Cursor for pagination' }
      },
      required: ['database_id']
    }
  },
  {
    name: 'notion_get_database',
    description:
      "Retrieve a database's metadata and property SCHEMA (column names/types), title, description, icon/cover, and parent. Use this — NOT notion_read_database, which queries rows — to learn a database's columns before creating or updating a row, and to inspect empty databases. Returns raw Notion JSON.",
    parameters: {
      type: 'object',
      properties: {
        connection: CONNECTION_PARAM,
        database_id: { type: 'string', description: 'The database ID (UUID, with or without dashes)' }
      },
      required: ['database_id']
    }
  },
  {
    name: 'notion_update_block',
    description: "Update an existing block's content or archive it.",
    parameters: {
      type: 'object',
      properties: {
        connection: CONNECTION_PARAM,
        block_id: { type: 'string', description: 'The block ID' },
        type: { type: 'string', description: 'Block type (e.g. "paragraph", "heading_1")' },
        content: { type: 'object', description: "The block type's content object" },
        archived: { type: 'boolean', description: 'Set true to archive (delete)' }
      },
      required: ['block_id']
    }
  },
  {
    name: 'notion_delete_block',
    description: 'Delete (archive) a block by ID.',
    parameters: {
      type: 'object',
      properties: {
        connection: CONNECTION_PARAM,
        block_id: { type: 'string', description: 'The block ID to delete' }
      },
      required: ['block_id']
    }
  },
  {
    name: 'notion_create_database',
    description: 'Create a new database as a child of an existing page.',
    parameters: {
      type: 'object',
      properties: {
        connection: CONNECTION_PARAM,
        parent: { type: 'object', description: '{ "page_id": "..." }' },
        title: { type: 'array', description: 'Rich text title array' },
        properties: { type: 'object', description: 'Database property schema' },
        icon: { type: 'object', description: 'Icon object' },
        cover: { type: 'object', description: 'Cover image object' }
      },
      required: ['parent', 'title', 'properties']
    }
  },
  {
    name: 'notion_update_database',
    description: "Update a database's title, description, or property schema.",
    parameters: {
      type: 'object',
      properties: {
        connection: CONNECTION_PARAM,
        database_id: { type: 'string', description: 'The database ID' },
        title: { type: 'array', description: 'New rich text title' },
        description: { type: 'array', description: 'Rich text description' },
        properties: { type: 'object', description: 'Property schema updates' }
      },
      required: ['database_id']
    }
  },
  {
    name: 'notion_list_users',
    description: 'List all users in the workspace.',
    parameters: {
      type: 'object',
      properties: {
        connection: CONNECTION_PARAM,
        page_size: { type: 'number', description: 'Max results (default 100)' },
        start_cursor: { type: 'string', description: 'Cursor for pagination' }
      },
      required: []
    }
  },
  {
    name: 'notion_get_user',
    description: 'Get details about a specific user by ID.',
    parameters: {
      type: 'object',
      properties: {
        connection: CONNECTION_PARAM,
        user_id: { type: 'string', description: 'The user ID' }
      },
      required: ['user_id']
    }
  },
  {
    name: 'notion_add_comment',
    description: 'Add a comment to a page or discussion thread.',
    parameters: {
      type: 'object',
      properties: {
        connection: CONNECTION_PARAM,
        parent: { type: 'object', description: '{ "page_id": "..." }' },
        discussion_id: {
          type: 'string',
          description: 'Discussion thread ID (alternative to parent)'
        },
        rich_text: { type: 'array', description: 'Rich text content of the comment' }
      },
      required: ['rich_text']
    }
  },
  {
    name: 'notion_list_comments',
    description: 'List comments on a block or page.',
    parameters: {
      type: 'object',
      properties: {
        connection: CONNECTION_PARAM,
        block_id: { type: 'string', description: 'Block or page ID' },
        page_size: { type: 'number', description: 'Max results (default 100)' },
        start_cursor: { type: 'string', description: 'Cursor for pagination' }
      },
      required: ['block_id']
    }
  },
  {
    name: 'notion_api',
    description:
      'Escape hatch: make a raw authenticated request to ANY Notion REST endpoint (https://api.notion.com/v1). Use ONLY when no dedicated notion_* tool covers the need — e.g. retrieve a single block (GET "blocks/{id}"), read a paginated page property (GET "pages/{id}/properties/{prop_id}"), or reach newer-API surfaces like data sources (pass notion_version). Prefer the dedicated tools when they exist — they are simpler and safer. Method defaults to GET; writes (POST create / PATCH / DELETE) require approval. Returns the raw Notion JSON response.',
    parameters: {
      type: 'object',
      properties: {
        connection: CONNECTION_PARAM,
        method: {
          type: 'string',
          description:
            'HTTP method: GET, POST, PATCH, or DELETE. Defaults to GET. Reads that use POST: "databases/{id}/query", "data_sources/{id}/query", "search".'
        },
        path: {
          type: 'string',
          description:
            'Endpoint path relative to the API root, e.g. "databases/{id}" (DB metadata/schema), "blocks/{id}", "pages/{id}/properties/{prop_id}", "comments", "data_sources/{id}". A leading "/v1/" or a full https://api.notion.com/... URL is also accepted and normalized. IDs may include or omit dashes.'
        },
        query: {
          type: 'object',
          description:
            'Optional query-string params (mainly GET), e.g. { "page_size": 50, "start_cursor": "..." }. Array values are repeated.'
        },
        body: {
          type: 'object',
          description: 'Optional JSON body for POST/PATCH (the endpoint payload). Ignored for GET and DELETE.'
        },
        notion_version: {
          type: 'string',
          description:
            'Optional Notion-Version header override (default "2022-06-28"). Set a newer date only when an endpoint requires it, e.g. "2025-09-03" for data sources.'
        }
      },
      required: ['path']
    }
  }
]

const TOOL_MAP = {
  notion_connections: executeConnections,
  notion_search: executeSearch,
  notion_read_page: executeReadPage,
  notion_read_blocks: executeReadBlocks,
  notion_create_page: executeCreatePage,
  notion_update_page: executeUpdatePage,
  notion_append_blocks: executeAppendBlocks,
  notion_read_database: executeReadDatabase,
  notion_get_database: executeGetDatabase,
  notion_update_block: executeUpdateBlock,
  notion_delete_block: executeDeleteBlock,
  notion_create_database: executeCreateDatabase,
  notion_update_database: executeUpdateDatabase,
  notion_list_users: executeListUsers,
  notion_get_user: executeGetUser,
  notion_add_comment: executeAddComment,
  notion_list_comments: executeListComments,
  notion_api: executeApi
}

function describeActionBase(toolName, args) {
  switch (toolName) {
    case 'notion_connections':
      return {
        title: 'List Notion connections',
        description: 'Listing configured connections',
        risk: 'low'
      }
    case 'notion_search':
      return {
        title: 'Notion search',
        description: `Search: ${args?.query ?? '(empty)'}`,
        risk: 'low'
      }
    case 'notion_read_page':
      return {
        title: 'Read Notion page',
        description: `Page: ${args?.page_id ?? '?'}`,
        risk: 'low'
      }
    case 'notion_read_blocks':
      return {
        title: 'Read Notion blocks',
        description: `Block: ${args?.block_id ?? '?'}`,
        risk: 'low'
      }
    case 'notion_create_page':
      return { title: 'Create Notion page', description: 'Creating a new page', risk: 'medium' }
    case 'notion_update_page':
      return {
        title: 'Update Notion page',
        description: args?.archived ? 'Archiving page' : `Updating page ${args?.page_id ?? '?'}`,
        risk: args?.archived ? 'high' : 'medium'
      }
    case 'notion_append_blocks':
      return {
        title: 'Append to Notion page',
        description: `Adding blocks to ${args?.block_id ?? '?'}`,
        risk: 'medium'
      }
    case 'notion_read_database':
      return {
        title: 'Query Notion database',
        description: `Database: ${args?.database_id ?? '?'}`,
        risk: 'low'
      }
    case 'notion_get_database':
      return {
        title: 'Read Notion database schema',
        description: `Database: ${args?.database_id ?? '?'}`,
        risk: 'low'
      }
    case 'notion_update_block':
      return {
        title: 'Update Notion block',
        description: args?.archived ? 'Deleting block' : `Updating block ${args?.block_id ?? '?'}`,
        risk: args?.archived ? 'high' : 'medium'
      }
    case 'notion_delete_block':
      return {
        title: 'Delete Notion block',
        description: `Deleting block ${args?.block_id ?? '?'}`,
        risk: 'high'
      }
    case 'notion_create_database':
      return {
        title: 'Create Notion database',
        description: 'Creating a new database',
        risk: 'medium'
      }
    case 'notion_update_database':
      return {
        title: 'Update Notion database',
        description: `Updating database ${args?.database_id ?? '?'}`,
        risk: 'medium'
      }
    case 'notion_list_users':
      return { title: 'List Notion users', description: 'Listing workspace users', risk: 'low' }
    case 'notion_get_user':
      return { title: 'Get Notion user', description: `User: ${args?.user_id ?? '?'}`, risk: 'low' }
    case 'notion_add_comment':
      return { title: 'Add Notion comment', description: 'Adding a comment', risk: 'medium' }
    case 'notion_list_comments':
      return {
        title: 'List Notion comments',
        description: `Comments on: ${args?.block_id ?? '?'}`,
        risk: 'low'
      }
    case 'notion_api': {
      const method = String(args?.method ?? '').trim().toUpperCase() || 'GET'
      const path = String(args?.path ?? '?')
      let risk = 'low'
      if (method === 'DELETE') {
        risk = 'high'
      } else if (method === 'PATCH') {
        const bodyStr = args?.body ? JSON.stringify(args.body) : ''
        risk = /"(?:archived|in_trash)"\s*:\s*true/i.test(bodyStr) ? 'high' : 'medium'
      } else if (method === 'POST') {
        const lower = path.toLowerCase().replace(/\/+$/, '')
        risk = lower.endsWith('/query') || lower === 'search' ? 'low' : 'medium'
      }
      return { title: 'Notion API request', description: `${method} ${path}`, risk }
    }
    default:
      return null
  }
}

export default {
  name: 'notion',
  tools: toolDefinitions,

  async init(context) {
    workspaceRoot = context?.workspaceRoot ?? null
  },

  describeAction(toolName, args) {
    const base = describeActionBase(toolName, args)
    // Surface which connection the action targets on the approval card, so a
    // user with several linked workspaces can tell "Personal" from "Wolffish".
    if (base && args?.connection) {
      base.description = base.description
        ? `${base.description} · ${args.connection}`
        : String(args.connection)
    }
    return base
  },

  async execute(toolName, args) {
    const handler = TOOL_MAP[toolName]
    if (!handler) return { success: false, error: `notion: unknown tool ${toolName}` }
    return handler(args)
  }
}
