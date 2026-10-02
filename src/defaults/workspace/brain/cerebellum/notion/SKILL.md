---
name: notion
description: Read, create, update, and manage Notion pages, databases, and blocks
triggers:
  - notion
  - workspace
  - wiki
  - knowledge base
  - database
  - page
  - note
  - document
  - kanban
  - board
  - table
  - task tracker
  - project management
  - block
  - property
  - relation
  - rollup
  - filter
  - sort
  - view
  - gallery
  - list
  - timeline
  - calendar
  - template
  - backlink
  - comment
  - mention
  - bookmark
  - embed
  - toggle
  - callout
  - heading
  - bullet
  - checkbox
  - todo
  - sprint
  - roadmap
  - docs
  - meeting notes
  - standup
  - content
  - notion page
  - notion database
  - notion workspace
  - notion api
  - create page
  - update page
  - delete page
  - add block
  - edit block
  - search notion
  - find in notion
  - note taking
  - notes
  - journal
  - daily log
  - weekly review
  - retro
  - retrospective
  - planning
  - backlog
  - epic
  - user story
  - acceptance criteria
  - status
  - priority
  - assignee
  - due date
  - formula
  - linked database
  - synced block
  - table of contents
  - divider
  - quote
  - code block
  - equation
  - breadcrumb
  - sub page
  - nested page
  - team wiki
  - company wiki
  - documentation
  - onboarding
  - runbook
  - sop
requires:
  - node
tools:
  - name: notion_connections
    description: 'List the configured Notion connections (their labels and connected account) so you know which `connection` to pass on other notion_* tools. Never exposes tokens.'
    parameters: {}
  - name: notion_search
    readOnly: true
    description: Search across all pages and databases the integration can access. Returns page/database titles, IDs, and snippets.
    parameters:
      connection:
        type: string
        required: false
        description: 'Which linked Notion connection to use, by its label (e.g. "Personal", "Wolffish"). Optional when only one connection is configured; required to disambiguate when several exist. Call notion_connections to list the labels.'
      query:
        type: string
        description: Search query text
      filter:
        type: string
        required: false
        description: '"page" or "database" to limit result type. Omit for both.'
      page_size:
        type: number
        required: false
        description: Max results (default 10, max 100)
      sort_direction:
        type: string
        required: false
        description: '"ascending" or "descending" by last_edited_time. Default descending.'
  - name: notion_read_page
    readOnly: true
    description: Retrieve a page's properties (title, status, dates, relations, etc). Returns the full property object as raw Notion JSON.
    parameters:
      connection:
        type: string
        required: false
        description: 'Which linked Notion connection to use, by its label (e.g. "Personal", "Wolffish"). Optional when only one connection is configured; required to disambiguate when several exist. Call notion_connections to list the labels.'
      page_id:
        type: string
        description: The page ID (UUID, with or without dashes)
  - name: notion_read_blocks
    readOnly: true
    description: Read the block content (body) of a page or block. Returns an array of block objects. Use the page ID to read the top-level content, or a block ID for children of a specific block.
    parameters:
      connection:
        type: string
        required: false
        description: 'Which linked Notion connection to use, by its label (e.g. "Personal", "Wolffish"). Optional when only one connection is configured; required to disambiguate when several exist. Call notion_connections to list the labels.'
      block_id:
        type: string
        description: Page or block ID to read children of
      page_size:
        type: number
        required: false
        description: Max blocks per request (default 100, max 100)
      start_cursor:
        type: string
        required: false
        description: Cursor for pagination (from a previous response)
  - name: notion_create_page
    description: Create a new page. You MUST specify a parent (a database or a page) — there is no default location, so every call needs one. Provide properties, and optionally block children for the body. To create several pages, call this once per page, each with its own parent.
    parameters:
      connection:
        type: string
        required: false
        description: 'Which linked Notion connection to use, by its label (e.g. "Personal", "Wolffish"). Optional when only one connection is configured; required to disambiguate when several exist. Call notion_connections to list the labels.'
      parent:
        type: object
        required: true
        description: 'REQUIRED — where the new page goes. Either { "database_id": "<id>" } to add a row to a database, or { "page_id": "<id>" } to create a subpage under an existing page. There is no default or "current" page; every create must include this. Get the id from notion_search, notion_get_database, or the Notion URL. When creating several pages in the same place, pass the same parent on every call.'
      properties:
        type: object
        required: true
        description: 'REQUIRED. Page properties as Notion property-value objects. For a database parent, the keys must match the database columns (read them with notion_get_database first); at minimum set the title column. For a page parent, use { "title": { "title": [{ "text": { "content": "Page Title" } }] } }.'
      children:
        type: array
        required: false
        description: Array of block objects for the page body
      icon:
        type: object
        required: false
        description: 'Icon object, e.g. { "emoji": "🚀" } or { "external": { "url": "..." } }'
      cover:
        type: object
        required: false
        description: 'Cover image, e.g. { "external": { "url": "..." } }'
  - name: notion_update_page
    description: Update a page's properties, icon, cover, or archive status. Cannot change the page body — use notion_append_blocks, notion_update_block, or notion_delete_block for that.
    parameters:
      connection:
        type: string
        required: false
        description: 'Which linked Notion connection to use, by its label (e.g. "Personal", "Wolffish"). Optional when only one connection is configured; required to disambiguate when several exist. Call notion_connections to list the labels.'
      page_id:
        type: string
        description: The page ID to update
      properties:
        type: object
        required: false
        description: Properties to update (same format as create)
      icon:
        type: object
        required: false
        description: New icon object
      cover:
        type: object
        required: false
        description: New cover image object
      archived:
        type: boolean
        required: false
        description: Set to true to archive (soft-delete) the page
  - name: notion_append_blocks
    description: Append new block children to a page or block. Use this to add content to existing pages.
    parameters:
      connection:
        type: string
        required: false
        description: 'Which linked Notion connection to use, by its label (e.g. "Personal", "Wolffish"). Optional when only one connection is configured; required to disambiguate when several exist. Call notion_connections to list the labels.'
      block_id:
        type: string
        required: true
        description: Parent page or block ID to append to. REQUIRED on every call — this is the destination the blocks are added to; omitting it fails the append. Pass the page ID here to add to the top of a page, or a block ID to nest under an existing block.
      children:
        type: array
        required: true
        description: Array of block objects to append
  - name: notion_read_database
    readOnly: true
    description: Query a database with optional filters and sorts. Returns an array of page objects (database rows).
    parameters:
      connection:
        type: string
        required: false
        description: 'Which linked Notion connection to use, by its label (e.g. "Personal", "Wolffish"). Optional when only one connection is configured; required to disambiguate when several exist. Call notion_connections to list the labels.'
      database_id:
        type: string
        description: The database ID to query
      filter:
        type: object
        required: false
        description: Notion filter object (see Notion API filter docs)
      sorts:
        type: array
        required: false
        description: 'Array of sort objects, e.g. [{ "property": "Name", "direction": "ascending" }]'
      page_size:
        type: number
        required: false
        description: Max results (default 100, max 100)
      start_cursor:
        type: string
        required: false
        description: Cursor for pagination
  - name: notion_get_database
    readOnly: true
    description: "Retrieve a database's metadata and property SCHEMA (column names/types), title, description, icon/cover, and parent. Use this — NOT notion_read_database, which queries rows — to learn a database's columns before creating or updating a row, and to inspect an empty database. Notion page and database IDs look identical; if notion_read_page reports that an ID is a database, read it here. Returns raw Notion JSON."
    parameters:
      connection:
        type: string
        required: false
        description: 'Which linked Notion connection to use, by its label (e.g. "Personal", "Wolffish"). Optional when only one connection is configured; required to disambiguate when several exist. Call notion_connections to list the labels.'
      database_id:
        type: string
        description: The database ID (UUID, with or without dashes)
  - name: notion_update_block
    description: Update an existing block's content or archive it. Only the block type's own content field can be updated.
    parameters:
      connection:
        type: string
        required: false
        description: 'Which linked Notion connection to use, by its label (e.g. "Personal", "Wolffish"). Optional when only one connection is configured; required to disambiguate when several exist. Call notion_connections to list the labels.'
      block_id:
        type: string
        description: The block ID to update
      type:
        type: string
        required: false
        description: The block type (e.g. "paragraph", "heading_1", "to_do"). Required when updating content.
      content:
        type: object
        required: false
        description: The block type's content object (e.g. for paragraph, the rich_text array)
      archived:
        type: boolean
        required: false
        description: Set to true to archive (delete) the block
  - name: notion_delete_block
    description: Delete (archive) a block by ID. This removes the block from the page.
    parameters:
      connection:
        type: string
        required: false
        description: 'Which linked Notion connection to use, by its label (e.g. "Personal", "Wolffish"). Optional when only one connection is configured; required to disambiguate when several exist. Call notion_connections to list the labels.'
      block_id:
        type: string
        description: The block ID to delete
  - name: notion_create_database
    description: Create a new database as a child of an existing page. Define the schema with properties.
    parameters:
      connection:
        type: string
        required: false
        description: 'Which linked Notion connection to use, by its label (e.g. "Personal", "Wolffish"). Optional when only one connection is configured; required to disambiguate when several exist. Call notion_connections to list the labels.'
      parent:
        type: object
        description: '{ "page_id": "..." } — the parent page for the new database'
      title:
        type: array
        description: 'Rich text array for the database title, e.g. [{ "text": { "content": "My Database" } }]'
      properties:
        type: object
        description: 'Database property schema. Keys are property names, values are property config objects. E.g. { "Name": { "title": {} }, "Status": { "select": { "options": [{ "name": "Todo" }, { "name": "Done" }] } } }'
      icon:
        type: object
        required: false
        description: 'Icon object'
      cover:
        type: object
        required: false
        description: 'Cover image object'
  - name: notion_update_database
    description: Update a database's title, description, or property schema.
    parameters:
      connection:
        type: string
        required: false
        description: 'Which linked Notion connection to use, by its label (e.g. "Personal", "Wolffish"). Optional when only one connection is configured; required to disambiguate when several exist. Call notion_connections to list the labels.'
      database_id:
        type: string
        description: The database ID to update
      title:
        type: array
        required: false
        description: New rich text title
      description:
        type: array
        required: false
        description: Rich text description
      properties:
        type: object
        required: false
        description: Property schema updates. To rename, include both old key with null and new key with config. To add, include the new property. To remove, set property value to null.
  - name: notion_list_users
    readOnly: true
    description: List all users in the workspace (members and bots).
    parameters:
      connection:
        type: string
        required: false
        description: 'Which linked Notion connection to use, by its label (e.g. "Personal", "Wolffish"). Optional when only one connection is configured; required to disambiguate when several exist. Call notion_connections to list the labels.'
      page_size:
        type: number
        required: false
        description: Max results (default 100, max 100)
      start_cursor:
        type: string
        required: false
        description: Cursor for pagination
  - name: notion_get_user
    readOnly: true
    description: Get details about a specific user by ID.
    parameters:
      connection:
        type: string
        required: false
        description: 'Which linked Notion connection to use, by its label (e.g. "Personal", "Wolffish"). Optional when only one connection is configured; required to disambiguate when several exist. Call notion_connections to list the labels.'
      user_id:
        type: string
        description: The user ID
  - name: notion_add_comment
    description: Add a comment to a page or existing discussion thread.
    parameters:
      connection:
        type: string
        required: false
        description: 'Which linked Notion connection to use, by its label (e.g. "Personal", "Wolffish"). Optional when only one connection is configured; required to disambiguate when several exist. Call notion_connections to list the labels.'
      parent:
        type: object
        required: false
        description: '{ "page_id": "..." } to comment on a page'
      discussion_id:
        type: string
        required: false
        description: Discussion thread ID to reply to (alternative to parent)
      rich_text:
        type: array
        description: Rich text content of the comment
  - name: notion_list_comments
    readOnly: true
    description: List comments on a block or page.
    parameters:
      connection:
        type: string
        required: false
        description: 'Which linked Notion connection to use, by its label (e.g. "Personal", "Wolffish"). Optional when only one connection is configured; required to disambiguate when several exist. Call notion_connections to list the labels.'
      block_id:
        type: string
        description: The block or page ID to list comments for
      page_size:
        type: number
        required: false
        description: Max results (default 100, max 100)
      start_cursor:
        type: string
        required: false
        description: Cursor for pagination
  - name: notion_api
    description: 'Escape hatch: make a raw authenticated request to ANY Notion REST endpoint (https://api.notion.com/v1). Use ONLY when no dedicated notion_* tool covers the need — e.g. retrieve a single block (GET "blocks/{id}"), read a paginated page property (GET "pages/{id}/properties/{prop_id}"), or reach newer-API surfaces like data sources (pass notion_version). Prefer the dedicated tools when they exist — they are simpler and safer. Method defaults to GET; writes (POST create / PATCH / DELETE) require approval. Returns the raw Notion JSON response.'
    parameters:
      connection:
        type: string
        required: false
        description: 'Which linked Notion connection to use, by its label (e.g. "Personal", "Wolffish"). Optional when only one connection is configured; required to disambiguate when several exist. Call notion_connections to list the labels.'
      method:
        type: string
        required: false
        description: 'HTTP method: GET, POST, PATCH, or DELETE. Defaults to GET. Reads that use POST: "databases/{id}/query", "data_sources/{id}/query", "search".'
      path:
        type: string
        description: 'Endpoint path relative to the API root, e.g. "databases/{id}" (DB metadata/schema), "blocks/{id}", "pages/{id}/properties/{prop_id}", "comments", "data_sources/{id}". A leading "/v1/" or a full https://api.notion.com/... URL is also accepted and normalized. IDs may include or omit dashes.'
      query:
        type: object
        required: false
        description: 'Optional query-string params (mainly GET), e.g. { "page_size": 50, "start_cursor": "..." }. Array values are repeated.'
      body:
        type: object
        required: false
        description: Optional JSON body for POST/PATCH (the endpoint payload). Ignored for GET and DELETE.
      notion_version:
        type: string
        required: false
        description: 'Optional Notion-Version header override (default "2022-06-28"). Set a newer date only when an endpoint requires it, e.g. "2025-09-03" for data sources.'
danger_patterns:
  - pattern: '"archived"\s*:\s*true'
    level: destructive
    reason: Archiving (soft-deleting) a page or block
  - pattern: '"in_trash"\s*:\s*true'
    level: destructive
    reason: Moving a Notion page or block to trash
  - pattern: 'notion_delete_block'
    level: destructive
    reason: Deleting a block from a page
  - pattern: 'notion_update_database.*"properties".*:\s*null'
    level: destructive
    reason: Removing a database property (column) and its data
  - pattern: 'notion_api[\s\S]*"method"\s*:\s*"delete"'
    level: destructive
    reason: Raw Notion DELETE request
confirm_patterns:
  - pattern: 'notion_create_page'
    reason: Creating a new page in Notion
  - pattern: 'notion_update_page'
    reason: Updating page properties
  - pattern: 'notion_append_blocks'
    reason: Adding content to a page
  - pattern: 'notion_update_block'
    reason: Modifying block content
  - pattern: 'notion_create_database'
    reason: Creating a new database
  - pattern: 'notion_update_database'
    reason: Modifying database schema
  - pattern: 'notion_add_comment'
    reason: Adding a comment
  - pattern: 'notion_api[\s\S]*"method"\s*:\s*"(post|patch)"'
    reason: Raw Notion write (POST/PATCH)
---

# Notion

## Connections

Notion access is organized into **connections**. Each connection is one Notion workspace the user linked, identified by a **label** they chose (for example `Personal` or `Wolffish`). The label is how you — and the user — tell one workspace apart from another.

- Call `notion_connections` to see the configured labels and which account each points to. It never returns tokens.
- Pass the chosen label as the `connection` parameter on every other `notion_*` tool call.
- You may omit `connection` only when exactly one connection is configured. When several exist and you don't pass one, the tool returns an error listing the available labels — read it and retry with the right label.
- Match the label to the user's intent: "my personal notion" → the connection labeled `Personal`; "the Wolffish workspace" → `Wolffish`. If it is genuinely ambiguous which the user means, ask them before acting.

## Content model

Notion's API uses a block-based content model:

- **Pages** are the primary unit. A page has **properties** (metadata like title, status, dates, people, relations) and a **body** made of **blocks**.
- **Databases** are collections of pages. Each page in a database has properties matching the database schema (columns). Databases can be queried with filters and sorts.
- **Blocks** are content elements: paragraphs, headings, lists, to-dos, code, images, embeds, toggles, callouts, tables, columns, and more. Blocks can have **children** (nested blocks).

## How properties work

Properties are key-value pairs on a page. The key is the property name, the value is a typed object:

- `title` — the page name: `{ "title": [{ "text": { "content": "My Page" } }] }`
- `rich_text` — text field: `{ "rich_text": [{ "text": { "content": "some text" } }] }`
- `number` — `{ "number": 42 }`
- `select` — `{ "select": { "name": "Option A" } }`
- `multi_select` — `{ "multi_select": [{ "name": "Tag1" }, { "name": "Tag2" }] }`
- `date` — `{ "date": { "start": "2024-01-15", "end": "2024-01-20" } }`
- `checkbox` �� `{ "checkbox": true }`
- `url` — `{ "url": "https://example.com" }`
- `email` — `{ "email": "user@example.com" }`
- `phone_number` — `{ "phone_number": "+1234567890" }`
- `people` — `{ "people": [{ "id": "user-uuid" }] }`
- `relation` — `{ "relation": [{ "id": "page-uuid" }] }`
- `status` — `{ "status": { "name": "In Progress" } }`
- `formula`, `rollup`, `created_time`, `last_edited_time`, `created_by`, `last_edited_by` — read-only computed properties

## How blocks work

Each block has a `type` field and a corresponding content object. Common block types:

```
paragraph:     { "rich_text": [{ "text": { "content": "Hello" } }] }
heading_1:     { "rich_text": [{ "text": { "content": "Title" } }] }
heading_2:     { "rich_text": [{ "text": { "content": "Subtitle" } }] }
heading_3:     { "rich_text": [{ "text": { "content": "Section" } }] }
bulleted_list_item: { "rich_text": [{ "text": { "content": "Item" } }] }
numbered_list_item: { "rich_text": [{ "text": { "content": "Item" } }] }
to_do:         { "rich_text": [{ "text": { "content": "Task" } }], "checked": false }
toggle:        { "rich_text": [{ "text": { "content": "Toggle title" } }] }
code:          { "rich_text": [{ "text": { "content": "const x = 1" } }], "language": "javascript" }
quote:         { "rich_text": [{ "text": { "content": "Quote text" } }] }
callout:       { "rich_text": [{ "text": { "content": "Important!" } }], "icon": { "emoji": "⚠️" } }
divider:       {}
table_of_contents: {}
image:         { "external": { "url": "https://..." } }
bookmark:      { "url": "https://..." }
equation:      { "expression": "E = mc^2" }
```

When creating blocks, wrap the content under `{ "type": "<block_type>", "<block_type>": { ... } }`:

```json
{
  "type": "paragraph",
  "paragraph": {
    "rich_text": [{ "text": { "content": "Hello world" } }]
  }
}
```

## Rich text

Rich text is an array of text objects with optional annotations:

```json
[
  {
    "type": "text",
    "text": { "content": "Bold text", "link": null },
    "annotations": { "bold": true, "italic": false, "strikethrough": false, "underline": false, "code": false, "color": "default" }
  },
  {
    "type": "text",
    "text": { "content": " and normal text" }
  }
]
```

Annotations are optional — omit them for plain text. Available colors: `default`, `gray`, `brown`, `orange`, `yellow`, `green`, `blue`, `purple`, `pink`, `red`, and background variants like `gray_background`.

## Database filters

Filters are nested objects. Simple filter:
```json
{ "property": "Status", "status": { "equals": "Done" } }
```

Compound filter:
```json
{
  "and": [
    { "property": "Status", "status": { "equals": "In Progress" } },
    { "property": "Priority", "select": { "equals": "High" } }
  ]
}
```

Filter operators vary by property type:
- text/rich_text: `equals`, `does_not_equal`, `contains`, `does_not_contain`, `starts_with`, `ends_with`, `is_empty`, `is_not_empty`
- number: `equals`, `does_not_equal`, `greater_than`, `less_than`, `greater_than_or_equal_to`, `less_than_or_equal_to`
- checkbox: `equals`, `does_not_equal`
- select: `equals`, `does_not_equal`, `is_empty`, `is_not_empty`
- multi_select: `contains`, `does_not_contain`, `is_empty`, `is_not_empty`
- date: `equals`, `before`, `after`, `on_or_before`, `on_or_after`, `is_empty`, `is_not_empty`, `past_week`, `past_month`, `past_year`, `next_week`, `next_month`, `next_year`
- status: `equals`, `does_not_equal`
- people: `contains`, `does_not_contain`, `is_empty`, `is_not_empty`
- relation: `contains`, `does_not_contain`, `is_empty`, `is_not_empty`

## Database sorts

```json
[
  { "property": "Created", "direction": "descending" },
  { "property": "Name", "direction": "ascending" }
]
```

Or sort by timestamp: `{ "timestamp": "last_edited_time", "direction": "descending" }`

## IDs

Notion IDs are UUIDs. They can be formatted with or without dashes:
- `12345678-1234-1234-1234-123456789abc`
- `123456781234123412341234567890abc`

Both formats are accepted in all tools. You can extract page IDs from Notion URLs — the 32-character hex string after the last dash in the URL path.

## Pagination

List and query endpoints return `has_more` and `next_cursor`. When `has_more` is true, pass `next_cursor` as `start_cursor` in the next call to get the next page of results.

## Workflow patterns

### Read a page fully
1. `notion_read_page` — get properties (title, metadata)
2. `notion_read_blocks` — get the page body (content blocks)
3. For deeply nested content, call `notion_read_blocks` again with child block IDs

### Reading an ID that turns out to be a database
Notion page IDs and database IDs are indistinguishable UUIDs, so you often can't tell which kind an ID is up front.
- To read a **database's schema/columns** (or an empty database), use `notion_get_database`.
- To **query a database's rows**, use `notion_read_database`.
- If you call `notion_read_page` on an ID that is actually a database, it self-heals: it detects the case and returns the database object instead (look at the `object` field — `"page"` vs `"database"`). `notion_get_database` self-heals symmetrically for a page ID.

### Escape hatch — `notion_api`
`notion_api` makes a raw request to any Notion REST endpoint. Reach for it only when no dedicated `notion_*` tool covers what you need — for example a single block (`GET "blocks/{id}"`), a paginated page property with more than 25 relation/rollup values (`GET "pages/{id}/properties/{prop_id}"`), or a newer-API surface such as data sources (pass `notion_version: "2025-09-03"`). Prefer the dedicated tools when they exist — they are simpler, cheaper, and safer. Errors come back in the same `Notion API error (<code>): <message>` form as the other tools, so you can self-correct the same way.

### Add content to a page
1. Build block objects for the content
2. `notion_append_blocks`, passing the destination page (or block) ID as `block_id` and the block objects as `children`. `block_id` is required on every call — omitting it fails the append; there is no implicit "current page."
3. Building a large page in several appends? Keep each append well under the 2000-block limit, and after the final append read the page back with `notion_read_blocks` to confirm every planned section actually landed before telling the user it's done.

### Create a database entry
1. Use `notion_get_database` to read the schema (the columns and their types). `notion_read_database` returns rows, not the column schema — and returns nothing for an empty database.
2. Build properties matching the database columns
3. `notion_create_page` with `parent: { "database_id": "..." }`

### Creating several pages at once
Every `notion_create_page` needs its own `parent` — there is no implicit "current page," so omitting `parent` fails with `parent is required`. To create N pages in the same database (or under the same page), first obtain the destination id **once** (via `notion_search` or `notion_get_database`), then make N calls that each pass that same `parent: { "database_id": "<id>" }`. Don't fire off creates before you have a real parent id; resolve it first, then fan out.

### Update a database entry
1. `notion_update_page` with the page ID and updated properties

### Archive / soft-delete
- Pages: `notion_update_page` with `archived: true`
- Blocks: `notion_delete_block` or `notion_update_block` with `archived: true`

## Limitations

- The integration can only access pages and databases explicitly shared with it
- Rate limit: ~3 requests/second sustained
- Block content max: 2000 blocks per append
- Rich text max: 2000 characters per text block
- Cannot upload files — use external URLs for images and file blocks
- Cannot change page parent after creation
- Cannot reorder blocks — only append new ones
