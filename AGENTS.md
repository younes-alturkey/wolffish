# Wolffish — Agent Guide

Personal AI desktop app. Electron + React + TypeScript. The runtime is modeled as a 15-module brain — see `ARCH.md` for the full mapping.

## Stack

- Electron via `electron-vite`. Three processes: **main** (Node), **preload** (bridge), **renderer** (React).
- Tailwind v4, i18next (en / ar), Ollama for local inference.
- IPC is the only main↔renderer channel. Never import main code from the renderer or vice versa — go through `preload`.

## Project layout

```
src/
├── main/            Electron main process (Node)
│   ├── index.ts     entry — IPC handlers live here
│   ├── ollama/      Ollama HTTP client + install detection
│   ├── workspace/   ~/.wolffish init, config, purge
│   ├── lockfile/    single-instance guard
│   ├── system/      OS info (platform, RAM, disk)
│   └── runtime/     the brain — one folder per region
│       ├── thalamus/, prefrontal/, hippocampus/, ...
│       └── providers/  LLM provider adapters (anthropic/, openai/, local/)
├── cli/             the `wolffish` terminal client (Bun + OpenTUI + Solid, compiled per platform)
│   ├── index.ts     entry: TUI vs one-shot vs classic verbs
│   ├── tui/         screens, dialogs, keymap, store — typecheck with `npm run cli:typecheck`, test with `npm run cli:test`
│   ├── commands/, lib/  classic line-mode verbs (.mjs) reused by the binary
│   └── build.ts     `bun build --compile` (CI beforePack; `npm run cli:build` to check the artifact)
│                    DEV: `npm run dev` writes a `wolffish` shim that runs src/cli/index.ts under Bun —
│                    every launch is the source on disk, no build; relaunch + `wolffish resume` after edits
├── preload/         contextBridge — types in index.d.ts
├── renderer/src/
│   ├── App.tsx, main.tsx, env.d.ts, assets/
│   ├── components/  common/ (composed) and core/ (primitives)
│   ├── pages/       one folder per screen
│   ├── providers/   React context providers
│   ├── hooks/       custom hooks
│   └── lib/         i18n, utils
└── defaults/workspace/  bundled into the app, copied to ~/.wolffish on first launch

resources/   fonts/, icons/, images/  (use @resources alias)
scripts/     build helpers (one folder each)
```

## Folder convention — one thing per folder

Every module lives in its own kebab-case folder, and the file inside matches the folder name:

```
components/core/copy-button/CopyButton.tsx
hooks/use-online/useOnline.ts
pages/model-picker/ModelPicker.tsx
main/runtime/hippocampus/hippocampus.ts
```

When a file has both a component and a hook (Fast Refresh requires single-purpose files), split them:

```
providers/flow/FlowProvider.tsx   ← component only
providers/flow/useFlow.ts         ← context + hook + types
```

Same pattern for `Toast`, `Theme`, `Locale`. The hook file holds the `Context`, the `useX` hook, and any related types.

## Path aliases — always use these, never relative across folders

| Alias                                                             | Target                      |
| ----------------------------------------------------------------- | --------------------------- |
| `@main/*`                                                         | `src/main/*`                |
| `@preload/*`                                                      | `src/preload/*`             |
| `@renderer/*`                                                     | `src/renderer/src/*`        |
| `@components/*`, `@hooks/*`, `@lib/*`, `@pages/*`, `@providers/*` | matching renderer subfolder |
| `@resources/*`                                                    | `resources/*`               |

Configured in `electron.vite.config.ts`, `tsconfig.web.json`, `tsconfig.node.json`. Inside one folder, use `./` only for files in the same folder. Cross-folder = always alias.

## Data location — `~/.wolffish/` is the entire footprint

Hard rule: **uninstall must be `rm -rf ~/.wolffish/`**. Every byte the app writes goes there:

- `~/.wolffish/workspace/` — user data (config.json + brain/ folders)
- `~/.wolffish/runtime/` — Chromium state (cookies, localStorage, GPU cache, ...) via `app.setPath('userData', ...)`
- `~/.wolffish/logs/` — via `app.setAppLogsPath(...)`
- `~/.wolffish/bin/` — every managed binary: `gog`, `ffmpeg`, the voice engines, and the `wolffish` CLI shim. One directory on every platform, and one PATH entry that covers all of them (`google.ts:ensureInUserPath` writes it).

Do not write outside this tree. Do not introduce keytar / electron-store / safeStorage / OS keychains. The Snap target in `electron-builder.yml` is the one known exception (Snap confines writes to `~/snap/`); flag it before shipping a Snap.

**When a location is a free choice, it is `~/.wolffish/`.** Convention is not a reason to leave the tree: the CLI shim briefly lived in `~/.local/bin` because that is the XDG norm and "already on PATH" — but it is _not_ in macOS's default PATH (`/etc/paths` lists only `/usr/local/bin` and the system dirs), so the convenience was imaginary on one platform and the file survived `rm -rf ~/.wolffish` on all of them.

The exception is a location the OS _owns_, where a file elsewhere would simply never be read. Those are unavoidable, and today they are exactly the autostart registrations — `~/Library/LaunchAgents/`, `~/.config/systemd/user/`, `~/.config/autostart/`, the Windows registry PATH entry, Task Scheduler. Each is written only on an explicit user action, each is removed by its own uninstall path, and `src/main/autostart/` is the only place any of them appear. Adding a new one needs the same justification: a service manager that reads nowhere else.

Workspace init runs **only when `~/.wolffish/workspace/` does not exist** — see `workspace/workspace.ts:ensureWorkspace`. Never overwrite an existing workspace.

## Commands

```bash
npm run dev          # electron-vite dev (HMR for renderer, restart for main)
npm run typecheck    # node + web tsc
npm run lint         # eslint
npm run build        # typecheck + build
npm run build:mac    # produce a .dmg (similar: build:win, build:linux)
```

Always run `npm run typecheck` after structural changes — Vite's HMR can mask type errors that break a production build.

## Conventions to preserve

- **No comments unless the _why_ is non-obvious.** Don't narrate what the code does; identifiers do that.
- **No barrel `index.ts` files** unless we adopt them globally — current style is explicit file paths via aliases.
- **Default to terse responses, no scope creep.** A bug fix is a bug fix.
- **Frontend changes need a browser check**, not just typecheck — `npm run dev` and exercise the path.

## Brain mapping (cheat sheet)

Renderer triggers a turn → `agent.ts` orchestrates: `thalamus` (route to provider) → `prefrontal` (build system prompt from `brain/identity`, `brain/prefrontal`, recent episodes) → provider streams tokens → `hippocampus` archives the episode. `amygdala` gates dangerous tool calls; `basalganglia` records feedback; `brainstem` is the heartbeat. Full reasoning in `ARCH.md`.

## Known gotchas

- Page files moved one folder deeper — relative `../../resources/...` imports break. Use `@resources/*`.
- React Fast Refresh fails when a file exports a component **and** a non-component runtime value. Split them (see provider/hook pattern above).
