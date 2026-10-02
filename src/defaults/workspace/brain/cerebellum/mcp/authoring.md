# Building an MCP Server

An MCP server is a small program that hands *other* clients — Claude Desktop, Cursor,
an IDE, another Wolffish — a set of tools. Its quality is measured by one thing: can a
model that has never seen its source finish a real task with it, alone, first try.

## 1. First decide you need one

There are two ways to give yourself a new tool, and picking the wrong one wastes the
whole build.

| Situation | Use |
|---|---|
| **You** want a new ability | `skill_create` — a capability, in-process, callable this turn |
| Another app or another person's agent needs it | An MCP server |
| A service the user wants wired into Wolffish, and a server already exists | `mcp_add` — do not rebuild it |

Say which fork you took and why, in one line, before you start building. Writing an MCP
server so that Wolffish can call it is the long way round a `skill_create`.

## 2. Design the tool surface before the code

- **Prefer covering the API to inventing workflows.** A model can compose `list_issues`
  + `get_issue` + `comment` into any flow you would have hard-coded; it cannot
  decompose `triage_and_notify` when the task is slightly different. Add a workflow
  tool only where a sequence is genuinely fixed and tedious — and keep the primitives.
- **Name them `<service>_<verb>_<object>`**: `linear_create_issue`, `linear_list_teams`.
  The prefix tells a model which server owns the tool when thirty are loaded.
- **The description is the interface.** A model never reads your code. Say what the
  tool does, what each parameter means, what comes back, and — the line most
  descriptions omit — *when to use this one instead of the neighbouring one*.
- **Budget the schema.** Every tool's schema is spent on every request whether it is
  called or not. Forty thin tools cost more than the twelve that matter.

## 3. Output discipline — where most servers actually fail

A tool that returns a 40,000-token JSON blob has not helped; it has moved the problem
into the context window and made the next three calls worse.

- **Return what was asked for, not what the endpoint happened to send.** Strip the
  fields no caller reads. If the API returns 60 fields and the task needs 6, return 6
  and mention the rest exist.
- **Paginate, and say so in the result.** Every list tool takes a limit and a cursor,
  and every truncated result ends with the cursor and the count withheld — never a
  silent cut. A model that cannot tell a complete list from a truncated one will
  confidently answer from half the data.
- **Give the model a filter instead of the whole table.** A `query`/`since`/`fields`
  parameter is cheaper than any amount of post-hoc summarising.
- **Shape output for reading.** Markdown or terse text for anything a person will see
  through the model; structured JSON when the caller will compute on it. Pick one per
  tool and be consistent.

## 4. Errors are instructions

An error is a tool call that gets a second chance only if it says how.

- Name what failed, why, and the next action: *"No workspace selected. Call
  `linear_list_teams` and pass a `team_id`."*
- Distinguish **retry** (rate limit, timeout — say how long), **fix the arguments**
  (bad id, missing field — say which), and **stop** (no permission, not found — say
  so plainly so nothing loops).
- Never return a raw stack trace or a bare `{"error": true}`.

## 5. Shape and transport

- **stdio** for anything running on the user's machine — simplest to launch, no ports,
  no auth. This is the default.
- **Streamable HTTP, stateless** for a remote or shared server: one request in, one
  response out, no session to keep alive, which is what makes it survivable to deploy.
- Never log to stdout on a stdio server — stdout *is* the protocol. Use stderr.
- Mark each tool honestly: read-only, destructive, idempotent. Clients gate
  confirmation on those hints and a wrong one costs a user real data.
- Secrets come from the environment, never from a parameter and never from a file the
  server writes.

## 6. The build loop

Wolffish is an MCP client, so it can test the server it just wrote — use that.

1. `mcp_scaffold` — writes a runnable stdio server with one example tool, its
   package.json, and a README. It runs before you edit anything.
2. Implement the tools. One at a time, each with its description and error paths.
3. `mcp_add` with the command the scaffold prints. Its tools arrive on the next turn.
4. `mcp_test` to confirm it connects and enumerate what it exposes.
5. **Call the tools for real.** A server that connects is not a server that works.
6. Broken? Fix, then `mcp_remove` and `mcp_add` again to reload.
7. `mcp_remove` when you are done testing, unless the user wants it kept.

## 7. Before you call it done

Connecting proves nothing. Write **five to ten realistic questions** the server should
be able to answer, then answer them yourself using only its tools:

- **Realistic** — a thing a person would actually ask, not a tool-call demo.
- **Multi-step** — needing two or three calls and a decision between them.
- **Read-only** — nothing that mutates the user's data.
- **Verifiable** — one correct answer you can check.

Every question that needed a step you only knew from having written the code is a
missing or badly-described tool. That is the finding; fix it and re-run. Report how
many passed, and what the failures told you.

## 8. Failure catalog

1. **The context bomb** — a list tool with no limit that returns every record.
2. **The silent truncation** — a capped result that does not say it was capped.
3. **The mystery error** — `{"error": "failed"}`, with no cause and no next step.
4. **The one-word description** — `"Gets data."` The model guesses, and guesses wrong.
5. **The workflow monolith** — one `do_everything` tool with fourteen parameters, and
   no way to do thirteen of the fifteen things a user asks for.
6. **The stdout log** — a `console.log` that corrupts the stdio stream, which presents
   as the client failing to connect for no visible reason.
7. **The untested server** — connected, enumerated, never called.
