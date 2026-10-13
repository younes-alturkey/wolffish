# Wolffish browser extension

Manifest V3 extension (Chrome, Brave, Edge, Chromium) that gives the Wolffish agent control of the user's real browser — navigate, click, fill forms, read pages, screenshot, manage tabs, run JavaScript — inside their own session with their cookies and logins.

It lives here, in the desktop app repo, as a pnpm + turbo workspace. The built output is bundled into the app; there is no separate repo, release pipeline, or store listing.

## Workflow

```bash
pnpm install     # once
pnpm dev         # watch build into dist/ — load dist/ unpacked while iterating
pnpm bundle      # bump patch version, production build, copy into the app
```

`pnpm bundle` (or `npm run extension:bundle` from the repo root) is the whole release:

1. Bumps the patch version in every `package.json` in this workspace (the manifest reads its version from `chrome-extension/package.json`).
2. Runs a clean production build into `dist/`.
3. Wipes `src/defaults/workspace/extension/` in the app and copies `dist/` there, minus sourcemaps and dev-only files.

Commit the bumped `package.json` files together with the new bundle. On every launch the app syncs the bundled folder to `~/.wolffish/workspace/extension/` and, when a connected extension reports an older version, tells it to reload — so users pick up the new build with the next app update.

Other scripts: `type-check`, `lint`, `lint:fix`, `format`, `clean`. To force a locale while developing, set `CEB_DEV_LOCALE=ar` in `.env` (created by `pnpm install`).

## How it works

The extension connects to the desktop app over a local WebSocket (port 23151 by default). The agent sends a command, the extension executes it and replies.

```
Wolffish app ←→ WebSocket (localhost:23151) ←→ service worker ←→ content script / Chrome APIs
```

| Layer | Where | What it does |
| --- | --- | --- |
| Service worker | `chrome-extension/src/background/` | Holds the socket, dispatches commands, drives tabs, CDP, screenshots, cookies |
| Content script | `pages/content/` | Injected into pages; DOM interaction — click, type, read, scroll, wait |
| Side panel | `pages/side-panel/` | Connection status, live event feed per conversation |
| Options page | `pages/options/` | Overlay switch and site access |
| Shared | `packages/shared/` | Wire protocol types, constants, command list, bridge helpers |
| Storage | `packages/storage/` | `chrome.storage` wrappers (port, overlay flag) |
| i18n | `packages/i18n/` | Message catalogs — English, Arabic |

Command flow: agent calls an `ext_*` tool → the cerebellum plugin maps it to a `browser_*` command and sends it over the socket → the service worker runs it directly (navigate, tabs, cookies, screenshots) or relays it to the content script (click, type, read) → the result flows back the same way.

## Where it lives in the app

Core plumbing, in the app's main process:

| File | Purpose |
| --- | --- |
| `src/main/channels/extension/server.ts` | WebSocket server, connections, heartbeat, version check, command routing |
| `src/main/channels/extension/log.ts` | Per-conversation event log under `logs/extension/` |
| `src/main/channels/extension/doctor.ts` | Diagnostics and the `resync_extension` repair |

Agent-facing tools, as a cerebellum capability users can edit in their workspace:

| File | Purpose |
| --- | --- |
| `src/defaults/workspace/brain/cerebellum/browser-extension/SKILL.md` | Tool definitions, triggers, safety patterns, instructions |
| `src/defaults/workspace/brain/cerebellum/browser-extension/plugin/index.mjs` | Tool execution — sends commands, post-processes screenshots |

Connection management is core; what the agent can do with the connection is a plugin.

## Loading it in a browser

1. Wolffish → Settings → Services → Browser Extension → Reveal in Finder (it opens `~/.wolffish/workspace/extension/`).
2. `chrome://extensions` → Developer mode → Load unpacked → pick that folder.
3. It connects on its own. The same folder can be loaded into several browsers at once.

## Commands

70 commands, all listed in `packages/shared/lib/wolffish/commands.ts`:

- **Navigation** — `navigate`, `back`, `forward`, `reload`, `wait_for_navigation`
- **Interaction** — `click`, `type`, `fill`, `fill_form`, `submit_form`, `select`, `set_value`, `hover`, `focus`, `keypress`, `scroll`, `drag_drop`, `file_upload`, `handle_dialog`
- **Mouse (CDP)** — `mouse_move`, `mouse_down`, `mouse_up`, `mouse_click`, `mouse_drag`, `humanize`
- **Reading** — `read_page`, `take_snapshot`, `find`, `query_selector`, `get_interactive_elements`, `element_from_point`, `resolve_uid`, `get_attribute`, `get_value`, `get_url`, `get_page_info`
- **Tabs & windows** — `tabs_list`, `tab_open`, `tab_close`, `tab_switch`, `tab_duplicate`, `tab_move`, `windows_list`, `window_open`, `window_close`, `window_resize`
- **Capture** — `screenshot`, `pdf`
- **DevTools** — `debugger_attach`, `debugger_detach`, `debugger_status`, `emulate`, `list_console_messages`, `list_network_requests`, `get_network_request`
- **State** — `cookies_get`, `cookies_set`, `cookies_remove`, `storage_get`, `storage_set`, `clipboard_read`, `clipboard_write`, `download`
- **Scripts & waiting** — `execute_js`, `wait`, `wait_for`, `wait_for_network_idle`
- **Misc** — `notify`, `set_activity`, `doctor`

All names carry the `browser_` prefix on the wire.

## Adding a command

1. Implement the handler in the service worker (`chrome-extension/src/background/index.ts`) or the content script (`pages/content/src/matches/all/index.ts`).
2. Register it in `SERVICE_WORKER_COMMANDS` or `CONTENT_SCRIPT_COMMANDS` in `packages/shared/lib/wolffish/commands.ts`.
3. Add the tool to the capability's `SKILL.md` and the execute switch in `plugin/index.mjs`.
4. `pnpm bundle`.

## Wire protocol

Server → extension:

| Message | Purpose |
| --- | --- |
| `{ id, type, params }` | Execute a command |
| `{ type: 'pong' }` | Heartbeat reply |
| `{ type: 'event', event: 'extension_reload' }` | Run `chrome.runtime.reload()` (sent on version mismatch) |
| `{ type: 'event', event: 'port_update', data: { port } }` | Port changed — reconnect |
| `{ type: 'event', event: 'overlay_config', data }` | Overlay settings |
| `{ type: 'event', event: 'events_sync' \| 'event_logged', data }` | Conversation events for the side panel |
| `{ type: 'event', event: 'conversations_list' \| 'conversation_events', data }` | Replies to the side panel's requests |

Extension → server:

| Message | Purpose |
| --- | --- |
| `{ type: 'ping' }` | Heartbeat, every 15 s |
| `{ type: 'extension_info', version, ... }` | Sent on connect; identifies browser, profile and version |
| `{ id, success, data?, error? }` | Command response |
| `{ type: 'get_conversations' }` | Side panel asks for the conversation list |
| `{ type: 'get_conversation_events', conversationId }` | Side panel asks for one conversation's events |

## Layout

```
packages/extension/
├── chrome-extension/      manifest.ts, service worker, icons
├── pages/
│   ├── content/           content script
│   ├── side-panel/        side panel UI
│   └── options/           options page
├── packages/
│   ├── shared/            protocol types, constants, commands, bridge
│   ├── storage/           chrome.storage wrappers
│   ├── i18n/              locales (en, ar)
│   ├── ui/                shared components
│   ├── env/ hmr/ vite-config/ tailwindcss-config/ tsconfig/   build tooling
├── scripts/
│   ├── bundle.mjs         version bump + build + copy into the app
│   └── env.sh             writes .env for build/dev
└── dist/                  build output (gitignored)
```

Supported: Chromium, Chrome, Brave, Edge. Not supported: Safari, Firefox.
