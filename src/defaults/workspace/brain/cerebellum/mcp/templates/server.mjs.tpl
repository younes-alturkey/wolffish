#!/usr/bin/env node
// __TITLE__ — an MCP server over stdio.
//
// stdout IS the protocol: never console.log in this file. Diagnostics go to
// stderr. A stray log here presents to the client as "failed to connect", with
// nothing in any error message to say why.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'

const server = new McpServer({ name: '__SLUG__', version: '0.1.0' })

const MAX_LIMIT = 100
const TOKEN_ENV = '__ENV__'

server.registerTool(
  '__PREFIX___list_items',
  {
    title: 'List items',
    // The description IS the interface — a caller never reads this file. Say
    // what comes back, and when to use this tool rather than its neighbour.
    description:
      'List items, newest first. Returns id, name and updated date for each. ' +
      'Use this to find an item id; use __PREFIX___get_item for one item in full.',
    inputSchema: {
      limit: z.number().int().min(1).max(MAX_LIMIT).default(25)
        .describe('How many to return (1-100). Default 25.'),
      cursor: z.string().optional()
        .describe('Continue a previous page — pass the next_cursor a prior call returned.'),
      query: z.string().optional()
        .describe('Case-insensitive substring filter on the item name.')
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }
  },
  async ({ limit, cursor, query }) => {
    try {
      const { items, nextCursor, total } = await listItems({ limit, cursor, query })
      const lines = items.map((i) => '- ' + i.id + '  ' + i.name + '  (updated ' + i.updated + ')')
      // Never truncate silently. A caller that cannot tell a complete list from
      // a partial one will answer confidently from half the data.
      const tail = nextCursor
        ? '\n\n' + (total - items.length) + ' more not shown. Call again with cursor: ' + nextCursor
        : ''
      const text = items.length + ' of ' + total + ' items\n' + lines.join('\n') + tail
      return { content: [{ type: 'text', text }] }
    } catch (err) {
      // An error is the tool call's second chance, so it must name the RIGHT
      // next action — the three cases a caller can actually act on.
      return { isError: true, content: [{ type: 'text', text: explain(err) }] }
    }
  }
)

/**
 * Turn a thrown error into the one sentence the caller needs. Three cases,
 * because they lead to three different next moves:
 *   fix-args  — the call was wrong; changing a parameter fixes it
 *   retry     — transient; say roughly how long to wait
 *   stop      — permission, missing config; retrying will never work
 */
function explain(err) {
  if (err.kind === 'fix-args') {
    return 'Could not list items: ' + err.message + '. Fix that argument and call again.'
  }
  if (err.kind === 'retry') {
    return 'Could not list items: ' + err.message + '. Wait ' + (err.retryAfter || 30) + 's and retry.'
  }
  if (err.kind === 'stop') {
    return 'Could not list items: ' + err.message + '. This will not succeed on retry — ' +
      'set ' + TOKEN_ENV + ' and reconnect the server, or tell the user what is missing.'
  }
  return 'Could not list items: ' + err.message + '. Cause unknown — do not retry blindly; ' +
    'check the arguments first, then whether ' + TOKEN_ENV + ' is set.'
}

/** Tag an error so explain() can route it. */
function fail(kind, message, extra) {
  return Object.assign(new Error(message), { kind }, extra || {})
}

/**
 * Replace this with the real call. Kept async and kept returning
 * { items, nextCursor, total } so the tool above does not change shape.
 */
async function listItems({ limit, cursor, query }) {
  const all = [
    { id: 'itm_1', name: 'First item', updated: '2026-01-04' },
    { id: 'itm_2', name: 'Second item', updated: '2026-01-03' },
    { id: 'itm_3', name: 'Third item', updated: '2026-01-02' }
  ]
  const filtered = query
    ? all.filter((i) => i.name.toLowerCase().includes(query.toLowerCase()))
    : all
  const start = cursor ? Number(cursor) : 0
  if (!Number.isFinite(start) || start < 0) {
    throw fail('fix-args', 'cursor "' + cursor + '" is not one this server issued')
  }
  // A real implementation reaches the API here, and tags what comes back:
  //   if (res.status === 401) throw fail('stop', 'the API rejected the credentials')
  //   if (res.status === 429) throw fail('retry', 'rate limited', { retryAfter: 60 })
  const page = filtered.slice(start, start + limit)
  const next = start + limit < filtered.length ? String(start + limit) : null
  return { items: page, nextCursor: next, total: filtered.length }
}

const transport = new StdioServerTransport()
await server.connect(transport)
process.stderr.write('__SLUG__ ready on stdio\n')
