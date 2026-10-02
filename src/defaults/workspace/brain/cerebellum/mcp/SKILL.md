---
name: mcp
description: "Manage Wolffish's MCP (Model Context Protocol) server connections — list, add, test, enable, disable, remove, and sign in to the external tool servers whose tools become available to you — and BUILD new MCP servers, scaffolding a runnable one and testing it through this same client. Changes reflect live in Settings → MCP."
triggers:
  - mcp
  - model context protocol
  - mcp server
  - mcp servers
  - connect a server
  - add a server
  - tool server
  - connect mcp
  - remove mcp
  - list mcp
  - external tools
  - build an mcp server
  - create an mcp server
  - write an mcp server
  - mcp server for
  - expose to claude desktop
  - expose tools to
  - tools for cursor
  - scaffold mcp
  - mcp sdk
  - model context protocol server
tools:
  - name: mcp_build
    readOnly: true
    description: "Load the MCP server authoring guide into context. Call this BEFORE writing any MCP server — it covers the fork that decides the whole build (a tool for YOURSELF is skill_create, not a server), tool-surface design, the output discipline that decides whether a server is usable (cap, cursor, filter, never truncate silently), errors that name the next action, transport choice, the scaffold-add-test loop, and the evaluation to run before declaring it done."
    parameters:
      server:
        type: string
        required: false
        description: "One line naming the server you are about to build — stating it commits you to following the guide."
  - name: mcp_scaffold
    description: "Write a runnable stdio MCP server project to disk — server.mjs on the official SDK, package.json, README, .gitignore — in a new folder named after the server. It runs before you edit it, and its one example tool is complete on purpose (described schema, capped and cursored list that never truncates silently, an error that names the next action) so you copy the right shape. Then implement the real tools, mcp_add it by the printed command, mcp_test it, and CALL the tools for real. Call mcp_build first."
    parameters:
      directory:
        type: string
        description: Absolute path to the PARENT directory; the project folder is created inside it, named after the server slug.
      name:
        type: string
        description: "Human name for the server, e.g. \"Acme Billing\". The folder and package name are slugified from it."
      description:
        type: string
        required: false
        description: One line saying what the server is for. Goes into package.json and the README.
      tool_prefix:
        type: string
        required: false
        description: "Prefix for the tool names, e.g. \"acme\" gives acme_list_items. Defaults to the slug."
  - name: mcp_list
    readOnly: true
    description: List every configured MCP server — its name, whether it's a local command (stdio) or a remote URL, its live status (connected, connecting, needs sign-in, offline, disabled), and how many tools it currently exposes. Call this first so you can reference a server by name or number for the other tools.
    parameters: {}
  - name: mcp_add
    description: Add and immediately connect a new MCP server. Give a command for a server that runs on this machine (e.g. "uvx tafsir-mcp", "npx -y some-server") or an http(s) URL for a remote one. Transport is auto-detected. Its tools become available to you (and to workflow agents) on the next turn, namespaced by the server. If the remote server needs sign-in, the result says so — then call mcp_authorize.
    parameters:
      target:
        type: string
        description: The stdio command line (e.g. "uvx tafsir-mcp") or the remote http(s) URL (e.g. "https://mcp.example.com/mcp").
      name:
        type: string
        required: false
        description: Optional display name. When omitted, one is derived from the command's binary or the URL host.
      env:
        type: object
        required: false
        description: 'Optional environment variables for a stdio server, as a flat object of string values (e.g. { "API_KEY": "…" }). Ignored for remote URLs.'
  - name: mcp_test
    description: Re-check a server right now — the way to verify it works or to kick a stuck one back into connecting. On a connected server it pings and reports the tool count and latency; on an offline one it retries the connection immediately. Identify the server by its name, slug, or the number from mcp_list.
    parameters:
      server:
        type: string
        description: The server to test — its name, slug, or 1-based number from mcp_list.
  - name: mcp_enable
    description: Enable a previously disabled server so it connects again. Identify it by name, slug, or number from mcp_list.
    parameters:
      server:
        type: string
        description: The server to enable — its name, slug, or 1-based number from mcp_list.
  - name: mcp_disable
    description: Disable a server without deleting it — its tools drop out of availability and it stops reconnecting until re-enabled. Its configuration (and any sign-in) is kept. Identify it by name, slug, or number from mcp_list.
    parameters:
      server:
        type: string
        description: The server to disable — its name, slug, or 1-based number from mcp_list.
  - name: mcp_remove
    description: Permanently remove a server connection and everything it owns (config entry, any stored sign-in tokens). Its tools drop out of availability. Identify it by name, slug, or number from mcp_list.
    parameters:
      server:
        type: string
        description: The server to remove — its name, slug, or 1-based number from mcp_list.
  - name: mcp_authorize
    description: Start the sign-in (OAuth) flow for a remote server that reports it needs authorization. This opens the user's browser for them to approve; it does NOT complete on its own — tell the user to finish signing in, then confirm with mcp_test or mcp_list. Only for remote (URL) servers.
    parameters:
      server:
        type: string
        description: The server to sign in to — its name, slug, or 1-based number from mcp_list.
confirm_patterns:
  - pattern: 'mcp_remove'
    reason: Permanently removes an MCP server connection and its stored sign-in
---

# MCP — manage your own tool servers

**MCP (Model Context Protocol)** servers are external tool providers the user
can connect to Wolffish. Each connected server contributes a group of tools —
namespaced by that server — that you can call like any other tool. This
capability lets you manage those connections yourself, entirely by conversation:
add one, check it, pause it, or remove it. Everything you do here is the exact
same operation the user could do by hand in **Settings → MCP**, so your changes
show up there live (status dots, tool counts, the connection list) and theirs
show up to you.

## Two kinds of server

- **Local (stdio)** — a command Wolffish runs on this machine, e.g.
  `uvx tafsir-mcp` or `npx -y @scope/some-server`. Pass the whole command line
  as `target`. If it needs secrets, pass them in `env`.
- **Remote (HTTP)** — a hosted server at an `http(s)://…` URL, e.g.
  `https://mcp.example.com/mcp`. Pass the URL as `target`. Some remote servers
  require sign-in (see below).

You never choose the transport — `mcp_add` detects it from the `target`.

## How connections behave (so you set the right expectations)

- **Adding connects immediately.** No restart. The server's tools become
  callable on your **next** turn — if the user asks you to use a just-added
  server in the same message, add it, tell them it's connected, and use it on
  your following turn.
- **Failures are silent and self-healing.** If a server crashes or a remote
  endpoint drops, Wolffish keeps running and reconnects it in the background with
  backoff; its tools quietly drop out until it's back. A tool call to a
  momentarily-unreachable server returns a retryable "temporarily unreachable"
  error — retry shortly or proceed without it. You don't need to babysit this.
- **`mcp_test` is your probe.** Use it to confirm a new server works, or to
  force an offline one to retry now. It also resets the retry backoff.

## Signing in (remote OAuth)

If `mcp_add` or `mcp_list` shows a server as **needs sign-in**, call
`mcp_authorize` — it opens the user's browser to approve access. It does **not**
finish by itself: tell the user to complete sign-in in the browser, and once
they're back, confirm with `mcp_test` or `mcp_list`. Never ask the user for
passwords or tokens to type to you; the browser flow is how they authenticate.

## Referring to a server

Every tool except `mcp_list` and `mcp_add` takes a `server` — pass the server's
**name**, its **slug**, or its **number** from the most recent `mcp_list`. When
in doubt, call `mcp_list` first and use the exact name it shows.

## Etiquette

- **`mcp_remove` is permanent** and deletes any stored sign-in — confirm with
  the user before removing a server they set up.
- Prefer **`mcp_disable`** when the user just wants to pause a server; it keeps
  the configuration and any sign-in for later.
- Don't add duplicate connections to the same server — check `mcp_list` first.
