# Navigating Wolffish — A Guide for AI Assistants

**You are reading this because someone pointed you at their `~/.wolffish/` folder.**

This file is your map. It explains what Wolffish is, exactly what lives where in
this folder, how the system works, and how to help the user read, repair, extend,
and get the most out of their agent. Everything described here is on disk right
next to this file — open it and look. When in doubt, **read the markdown**: in
Wolffish, the markdown files *are* the source of truth.

> This is an orientation guide for a *visiting* assistant (you). It is **not**
> the Wolffish agent's own core contract — that lives in
> `workspace/brain/prefrontal/agents.core.md`. Don't confuse the two.

---

## Table of contents

1. [The idea](#1-the-idea)
2. [The stack](#2-the-stack)
3. [The `.wolffish` folder — complete map](#3-the-wolffish-folder--complete-map)
4. [Where everything lives — quick reference](#4-where-everything-lives--quick-reference)
5. [The brain — 15 modules](#5-the-brain--15-modules)
6. [Available tools (capabilities)](#6-available-tools-capabilities)
7. [How things work](#7-how-things-work)
8. [File-format reference](#8-file-format-reference)
9. [How to help the user navigate — recipes](#9-how-to-help-the-user-navigate--recipes)
10. [How to write good prompts for Wolffish](#10-how-to-write-good-prompts-for-wolffish)
11. [Safety & control](#11-safety--control)
12. [Golden rules for working inside `.wolffish`](#12-golden-rules-for-working-inside-wolffish)

---

## 1. The idea

**Wolffish is a brain you own, not a chatbot you rent.**

It's a local-first, markdown-powered personal AI desktop agent. It runs natively
on macOS, Windows, and Linux — thinking, acting, and learning on the user's own
machine. The core experience works fully offline through Ollama; cloud models
(Claude, GPT, DeepSeek, …) are optional quality upgrades, never requirements.

Three ideas hold the whole design together:

- **Markdown is truth.** Every fact the agent knows — its personality, its
  memory, its skills, its schedule — lives in plain markdown files you can open
  in any text editor. To change what the agent does, you *edit a file*, not
  redeploy code. The SQLite index (`cortex.db`) is a derived cache; delete it and
  it rebuilds from the markdown.
- **A brain, not a loop.** The runtime is modeled on human neuroanatomy: 15
  specialized modules (thalamus, hippocampus, amygdala, …), each with one job,
  wired together by an event bus. Every message follows the *same* deterministic
  path through the *same* gates. The LLM is creative at exactly one point; the
  structure around it is predictable. Trust comes from that predictability.
- **You own all of it.** Everything Wolffish is lives in this one folder,
  `~/.wolffish/`. Back it up by copying a folder. Version it with git. Uninstall
  with `rm -rf ~/.wolffish/`. There is no hidden cloud state, no opaque embedding
  store, no vendor lock-in.

Built by Younes Alturkey. Tagline: *Wolffish. Bite through anything.* 🐺

---

## 2. The stack

| Layer | Technology |
|---|---|
| Desktop shell | Electron 39, `electron-vite` (three processes: **main** = Node, **preload** = bridge, **renderer** = React) |
| Frontend | React 19, TypeScript 5.9, Tailwind CSS 4 |
| Build | Vite 7, electron-builder |
| Search index | SQLite (`better-sqlite3`) with FTS5 full-text search |
| Event bus | `mitt` (typed pub/sub) |
| LLM providers | Pure `fetch()`, no vendor SDKs — Anthropic (Claude), OpenAI (GPT), DeepSeek & other OpenAI-compatible clouds, Ollama (local) |
| Messaging channels | `grammy` (Telegram), Baileys (WhatsApp) |
| File processing | Sharp (images), pdf-parse, mammoth (docx), xlsx |
| Speech | Whisper (speech-to-text), neural TTS (text-to-speech) |
| i18n | i18next — English + Arabic (full RTL) |
| Logging | Pino |
| Scheduling | node-cron (driven by `heartbeat.md`) |

The **application code** lives in a separate repo (`wolffish-app`), under
`src/main/runtime/` (the brain), `src/renderer/` (the UI), etc. **This folder
(`~/.wolffish/`) is the runtime data** the installed app reads and writes. You
generally help the user here, in their data — not in the app source.

---

## 3. The `.wolffish` folder — complete map

`~/.wolffish/` is the app's entire footprint — delete it and you're back to a fresh
install. It has three top-level subfolders plus this guide. Below, **every folder is
listed and explained, nested ones included.** Folders that are pure machine state are
flagged disposable; everything else is human-readable content you can open and edit.

### Root of `~/.wolffish/`

```
~/.wolffish/
├── AGENTS.md     This guide. App-managed — rewritten from the bundle on every launch.
├── logs/         Reserved Electron app-logs path (app.setAppLogsPath). Usually EMPTY;
│                 the live dated logs actually live under workspace/logs/ (see below).
├── runtime/      Chromium/Electron user-data (app.setPath 'userData'). Engine state.
└── workspace/    ★ Everything the agent knows. All the human-meaningful content. ★
```

### `runtime/` — Chromium engine state (disposable, never hand-edit)

The embedded browser's own storage. You never need to read or edit it; it lives here
only so `rm -rf ~/.wolffish` wipes browser state too. Every subfolder is Chromium-managed
and self-regenerates — the exact set varies by OS and version.

```
runtime/
├── Cache/                 HTTP response cache
│   ├── Cache_Data/            cached entries
│   └── No_Vary_Search/        cache-key metadata
├── Code Cache/            compiled-script cache
│   ├── js/                    V8 bytecode
│   └── wasm/                  compiled WebAssembly
├── GPUCache/              GPU shader/program cache
├── DawnGraphiteCache/     Dawn (WebGPU) Graphite backend cache
├── DawnWebGPUCache/       Dawn WebGPU pipeline cache
├── Local Storage/
│   └── leveldb/               window.localStorage, stored as LevelDB
├── Session Storage/       window.sessionStorage (cleared each session)
├── Shared Dictionary/
│   └── cache/                 shared compression dictionaries
├── blob_storage/
│   └── <uuid>/                in-flight Blob/File data, one folder per session
└── (loose files: Preferences, Network Persistent State, Trust Tokens, SharedStorage,
     DIPS, .updaterId — Chromium + auto-updater bookkeeping)
```

### `workspace/` — the agent's world (top level)

```
workspace/
├── .lock              Single-instance guard (holds the running PID). Don't touch.
├── config.json        All app config + provider API keys (schema in §8). Holds secrets.
├── brain/             The 15-module brain state — detailed next.
├── extension/         The bundled browser extension the ext_* tools drive (multi-browser).
├── usage/             Token & cost accounting.
├── logs/              Live application + extension logs.
├── files/             Working files the agent reads/writes during tasks.
├── uploads/           Files you handed the agent to process (docs, images, audio).
├── screenshots/       Screenshots captured by computer-use / browser tools.
├── speech/            Speech-to-text scratch (incoming audio being transcribed).
└── voice/             Text-to-speech output (generated voice memos).
```

### `workspace/brain/` — every module, every nested folder

```
brain/
├── identity/              WHO. Read into every prompt.
│   ├── soul.md                the agent's character: tone, humor, hard limits
│   └── user.md                who you are: name, work, prefs, goals, boundaries
│
├── prefrontal/            PLANNING. The core contract + per-turn prompt dumps.
│   ├── agents.core.md         shipped core procedures (app-managed, overwritten)
│   ├── agents.md              YOUR overrides (never overwritten; wins on conflict)
│   └── .debug/                one timestamped dump per turn of the exact system
│                              prompt that was built — the best "why did it…?" source
│
├── cerebellum/            CAPABILITIES (tools/skills). One DOT-prefixed folder per
│   ├── .shell/                capability (hidden — `ls -a`). Each has a SKILL.md and an
│   ├── .filesystem/           optional plugin/ folder of code. Full catalog in §6.
│   ├── .web-search/           A capability's plugin/node_modules/ (when present) is its
│   └── …  (24 total)          installed npm deps — machine state, safe to ignore.
│
├── hippocampus/           MEMORY (three tiers, all markdown).
│   ├── episodes/              YYYY-MM-DD.md — daily turn-by-turn log (instant, no LLM)
│   ├── consolidated/          YYYY-WNN.md — weekly summaries from nightly compaction
│   │                          (this folder only appears after the first run)
│   └── knowledge/             durable facts: projects / people / preferences /
│                              technical / decisions.md
│
├── conversations/         One JSON per chat: conv-YYYY-MM-DD_HH-MM-SS.json
│                          (messages, segments, timeline, contextMeter — see §8).
│
├── motor/                 EXECUTION.
│   └── tasks/                 TASK-<id>.md (human transcript) + TASK-<id>-detail.log
│                              (verbose). Written live, so a crash still leaves a trail.
│
├── basalganglia/          TELEMETRY. YYYY-MM-DD.md — raw per-tool-call outcome log.
│                          Indexed for recall + insula stats; the LEARNED lessons
│                          live in reflection/ (below), not here.
│
├── reflection/            LEARNING.
│   ├── playbook.md            THE distillate: what worked, what failed, what the
│   │                          user likes/dislikes, task recipes. Rewritten (never
│   │                          appended) after every reflection run; injected into
│   │                          EVERY system prompt. playbook.md.bak = previous
│   │                          version, the one-copy restore if a merge degrades it.
│   ├── YYYY-MM-DD.md          per-conversation review blocks written by the nightly
│   │                          reflection (the model's own review + self-score).
│   └── reviewed.json          which conversations were reviewed (+ self-scores) —
│                              the nightly job's bookkeeping; 7-day rolling window.
│
├── brainstem/             SCHEDULING.
│   └── heartbeat.md           cron-like jobs; each `##` heading is one scheduled task.
│
├── corpus/                EVENT-BUS LOG. YYYY-MM-DD.log.md — every tool call with its
│                          args and raw output, in order. Best file for forensics.
│
└── cortex.db              SQLite FTS5 search index (+ cortex.db-shm, cortex.db-wal).
                           DISPOSABLE — rebuilt from the markdown on launch; don't edit.
```

### `workspace/extension/` — the browser extension (bundled, app-managed)

The unpacked extension loaded into the user's browser(s); the `ext_*` tools talk to it.
The same folder can be loaded into several browsers at once (Chrome + Edge + Brave …)
and each maintains its own connection to the app.
App-managed (refreshed from the bundle), so treat it as read-only.

```
extension/
├── manifest.json          the extension manifest
├── background.js          background / service-worker script
├── content/               content scripts injected into visited pages
├── side-panel/            the in-browser side-panel UI
│   ├── assets/                its compiled JS/CSS
│   └── fonts/                 its fonts
├── offscreen/             offscreen document for background DOM work
│   └── assets/
├── _locales/              i18n message catalogs
│   ├── en/
│   └── ar/
└── icon*.png              toolbar / store icons
```

### `workspace/usage/` — token & cost accounting

```
usage/
├── daily/                 YYYY-MM-DD.md — one line per model call (tokens + $ cost)
└── providers/             <provider>.md — the same lines grouped per provider
                           (anthropic, openai, deepseek, kimi, mimo, minimax, ollama, …)
```

### `workspace/logs/` — runtime logs

```
logs/
├── YYYY-MM-DD.log         Pino app log (updater, extension socket, errors)
└── extension/             browser-extension event stream
    ├── YYYY-MM-DD_HH-MM-SS.jsonl   one JSON line per browser event (navigate/click/…)
    └── .debug/                     extra extension debug dumps
```

> **Reality vs. older diagrams.** `conversations/` and `cortex.db` live **under `brain/`**
> (not at the workspace root); capabilities are **dot-prefixed**; and
> `hippocampus/consolidated/` only exists after the first consolidation. Trust the disk.

---

## 4. Where everything lives — quick reference

When the user asks "where is …", this is your lookup table.

| The user wants to… | Look at / edit |
|---|---|
| Change the agent's **personality / tone / rules** | `workspace/brain/identity/soul.md` |
| Update **facts about themselves** (name, job, prefs) | `workspace/brain/identity/user.md` |
| Add **custom agent procedures / overrides** | `workspace/brain/prefrontal/agents.md` (yours; wins on conflict) |
| See the agent's **built-in procedures** | `workspace/brain/prefrontal/agents.core.md` (read-only) |
| Read past **conversations** | `workspace/brain/conversations/conv-*.json` |
| See **daily activity at a glance** | `workspace/brain/hippocampus/episodes/YYYY-MM-DD.md` |
| Find **long-term knowledge** the agent holds | `workspace/brain/hippocampus/knowledge/*.md` |
| Teach the agent a **durable fact** | edit the right `knowledge/*.md` file |
| See **what tools exist / add a tool** | `workspace/brain/cerebellum/.<name>/SKILL.md` |
| Trace **exactly what a tool did** (args + output) | `workspace/brain/corpus/YYYY-MM-DD.log.md` |
| Inspect a **multi-step task run** | `workspace/brain/motor/tasks/TASK-*.md` |
| Understand **why the agent decided X** | `workspace/brain/prefrontal/.debug/*.md` (the assembled prompt) |
| Schedule a **recurring background job** | ask the agent — automation operations go through the `automation_*` tools (see §6), which manage `workspace/brain/brainstem/heartbeat.md` |
| Check **token spend / costs** | `workspace/usage/daily/*.md` and `workspace/usage/providers/*.md` |
| Change **providers, API keys, model, theme, locale, safety** | `workspace/config.json` |
| Debug **app crashes / updater / extension** | `workspace/logs/*.log` and `workspace/logs/extension/*.jsonl` |
| See **what the agent learned worked/failed** | `workspace/brain/basalganglia/YYYY-MM-DD.md` |
| Find generated files / screenshots / voice memos | `workspace/files/`, `screenshots/`, `voice/` |
| **Reset** to factory state | `rm -rf ~/.wolffish/` (nukes everything — last resort) |
| **Repair** a slow/odd search index | delete `workspace/brain/cortex.db*` — it rebuilds |
| **Back up** the whole brain | copy `~/.wolffish/workspace/` (skip `runtime/`) |

---

## 5. The brain — 15 modules

Each module maps a brain region to one runtime responsibility and (usually) one
place on disk. This is the mental model behind the folder layout.

| Module | Job | On-disk home |
|---|---|---|
| **Thalamus** | Resolve the selected Brain model and stream from it (no cascade) | — (talks to providers) |
| **RAS** | Score relevance, allocate the token budget | — (pure heuristic) |
| **Prefrontal** | Assemble the system prompt + plan the approach | `brain/prefrontal/` |
| **Cortex** | Fast full-text retrieval over all markdown | `brain/cortex.db` |
| **Hippocampus** | 3-tier memory: episodes → consolidated → knowledge | `brain/hippocampus/` |
| **Cerebellum** | Load & match capabilities (skills + plugins) | `brain/cerebellum/` |
| **Wernicke** | Parse LLM output into text + tool calls | — (pure parser) |
| **Broca** | Assemble & stream the final response to the UI | — (pure composer) |
| **Amygdala** | Safety-gate every tool call (safe/confirm/block) | — (uses SKILL patterns) |
| **Motor** | Execute tools, retry, log each step | `brain/motor/tasks/` |
| **Basal ganglia** | Record raw tool outcomes (telemetry; recall + insula stats) | `brain/basalganglia/` |
| **Reflection** | Nightly self-review of finished conversations → playbook distillate in every prompt; monthly deep-reflection audit of playbook + knowledge | `brain/reflection/` |
| **Hypothalamus** | Monitor vitals (context, tokens, RAM, disk) | — (samples runtime) |
| **Brainstem** | Run cron jobs + watch files for the index | `brain/brainstem/heartbeat.md` |
| **Corpus** | Typed event bus connecting every module | `brain/corpus/` (daily log) |
| **Insula** | Self-awareness / introspection on demand | reads motor + basalganglia + hippocampus |

The per-turn pipeline (same order every time):

```
thalamus → ras → prefrontal → cortex → hippocampus → cerebellum
   → [LLM CALL] → wernicke → amygdala → motor → broca
      → hippocampus (save episode) → basalganglia (record outcome)
```

…with `corpus` emitting events throughout, `hypothalamus` monitoring, `brainstem`
running independently, and `insula` available on demand.

---

## 6. Available tools (capabilities)

A **capability** is a self-contained folder in `brain/cerebellum/` (dot-prefixed,
so hidden — `ls -a` to see them). Drop a folder in, and the agent learns a skill.

**Two kinds:**
- **Pure skill** — just a `SKILL.md` (instructions for the LLM using existing
  tools). Example here: `.git`.
- **Plugin capability** — `SKILL.md` **+** `plugin/index.mjs` exporting executable
  tools. Most capabilities are plugins.

### The catalog (42 capabilities; the table names the main ones)

| Category | Capability | What it gives the agent (representative tools) |
|---|---|---|
| **System** | `.shell` | Run shell commands — `shell_exec` (working-folder cwd, tail-biased output spilled to a log, watcher guard, auto-elevation; `background:true` for servers), `shell_jobs`, `shell_stop` |
| | `.filesystem` | `file_read` (line-numbered), `file_edit` (exact-match edit with diff), `file_write`, `file_grep`, `file_glob` (ripgrep), `image_view`; `file_patch` is a deprecated alias |
| | *(in-process)* `todo` | The model's task list — `todo_write` renders a checklist card |
| | *(in-process)* `changes` | Undo for file edits — `changes_list`, `changes_revert` |
| | `.node` | Node.js runtime + npm — `node_check`, `node_install` |
| | `.python` | Hermetic uv-managed CPython for native Python plugins — `python_check`, `python_install` |
| | `.package-manager` | Cross-platform packages (brew/winget/apt/dnf) — `pkg_install`, `pkg_check` |
| | `.system` | Apps & power — `app_open`, `app_quit`, `app_list`, `open_path`, `system_power` |
| **Web** | `.web-search` | `web_search` (Brave), `web_fetch` (read a page) |
| | `.browser` | Headless Playwright automation — `browser_launch`, `browser_navigate`, `browser_click`, … |
| | `.browser-extension` | Drive the user's **real, logged-in** browsers (Chrome, Edge, Brave, Firefox — several can be connected at once) via the extension — ~60 `ext_*` tools (`ext_navigate`, `ext_click`, `ext_set_value`, `ext_read_page`, `ext_screenshot`, `ext_wait`, …; `ext_browsers` lists connections, `ext_use_browser` picks one per conversation) |
| | `.cloudflared` | Expose a local service — `cloudflared_tunnel` |
| **Documents** | `.document` | docx/html/md — `document_read/create/modify/convert/merge` |
| | `.pdf` | `pdf_read/create/merge/split/modify/form/secure/compress` |
| | `.spreadsheet` | xlsx/csv — `spreadsheet_read/create/modify/formula/chart/pivot/analyze`; formulas are written with computed cached values so the file reads back as numbers |
| | `.presentation` | pptx/potx — `deck_design` (the deck design manual), `presentation_read/create/modify/validate/render`. `presentation_create` is a layout engine: the model picks a layout per slide and supplies content, the engine owns geometry, type and colour |
| **Media** | `.ffmpeg` | Audio/video — `ffmpeg_run` |
| | `.speech-to-text` | Whisper, offline — `stt_transcribe`, `stt_transcribe_voice_memo`; owns its own settings — `stt_settings_get/set` (model, language), `stt_engine_install` |
| | `.text-to-speech` | Neural TTS — `voice_generate`, `voice_respond`; owns its own settings — `voice_settings_get/set` (voice, speed), `voice_engine_install` |
| | `.memes` | `meme_generate`, `meme_templates`, `gif_search`, `gif_trending` |
| **Code / services** | `.git` | Git conventions on top of `.shell` (pure skill) |
| | `.github` | GitHub API — ~60 `github_*` tools (repos, issues, PRs, Actions, releases, gists, …) |
| | `.google` | Workspace — `google_gmail_*`, `google_drive_*`, `google_calendar_*`, `google_sheets_*`, contacts, tasks |
| | `.notion` | Pages, databases, blocks — `notion_search/read_page/create_page/…` |
| **Desktop** | `.computer-use` | Screen control with a verified-aim loop, pointer-free background input and an element route — `computer_screenshot`, `computer_window_screenshot`, `computer_find`, `computer_click_element`, `computer_mouse_click`, `computer_keyboard_type`, `computer_wait_for`, `computer_check_access`, … |
| **Meta** | `.skills` | The agent manages/authors its own capabilities — `skill_list`, `skill_search`, `skill_read_source`, `skill_enable`, `skill_disable`, `skill_delete`, `skill_create`, `skill_reload` |
| | `.automations` | The agent manages its scheduled heartbeat jobs — `automation_list`, `automation_create`, `automation_edit`, `automation_delete`, `automation_check`, `automation_run` |
| | `.introspect` | The agent inspects itself — `wolffish_status`, `channel_status`, `wolffish_performance`, `wolffish_memory`, `wolffish_recall`, `wolffish_list_files` |
| | `.secrets` | Save/list the user's variables & secrets — `add_secret`, `list_secrets` |
| | `.ask` | Ask the user one or more multiple-choice questions via an in-app card — `ask_user` |
| | `.options` | Offer the user several alternative snippets — code, commands, config, drafts — as one tabbed card they can read and copy — `offer_options` |
| | `.utilities` | Small built-ins — `send_file` (deliver a file to the user as an attachment) |

> `.browser` vs `.browser-extension`: the **extension** acts inside the user's
> existing, authenticated browser session (great for sites the user is logged into);
> **`.browser`** spins up a fresh headless browser (not logged in). Picking the
> wrong one is a classic failure — logged-in sites reject the headless session.

### Anatomy of a `SKILL.md`

```yaml
---
name: shell
description: Execute shell commands on the local system
triggers:            # words in a message that surface this skill to the planner
  - run
  - execute
  - terminal
tools:               # the tool schema(s) the plugin exposes
  - name: shell_exec
    description: Run a shell command and return its output…
    parameters:
      command: { type: string, description: The command to execute }
      cwd:     { type: string, required: false }
      timeout: { type: number, required: false }
danger_patterns:     # amygdala BLOCKS these outright
  - { pattern: 'rm\s+-rf\s+/', level: destructive, reason: Wipes the filesystem }
confirm_patterns:    # amygdala asks the user first
  - { pattern: '/etc/', reason: Modifying system configuration }
---

# Shell
…markdown body: detailed usage notes the agent reads when the skill matches…
```

**To add a capability:** create `brain/cerebellum/.<name>/SKILL.md` (and, for code,
`plugin/index.mjs`). On next launch the cerebellum loads it; its `triggers` make it
discoverable and its `tools` become callable. No app rebuild needed — that's the
markdown-as-truth payoff.

---

## 7. How things work

**The agent loop.** A message (from the desktop UI, Telegram, or WhatsApp) enters
the pipeline in §5. The prefrontal reads `soul.md`, `user.md`, the agent
procedures, matched skills, and relevant memory, and assembles one system prompt.
The model streams a response; tool calls are parsed out, safety-checked, executed
with retries, and the result is streamed back. The turn is saved to an episode and
the outcome recorded.

**Single Brain.** The thalamus resolves exactly one user-chosen model — the
Brain (`llm.brain`, a `{ providerId, model }` set on the Brain settings page) —
or the local Ollama model when the chat switcher is in local-only mode
(`llm.localOnly`). There is no cascade and no automatic substitution: the chosen
model runs and retries itself on transient failures (429/5xx/timeouts), or the
turn fails honestly. Switching cloud↔local is a manual, explicit act via the
chat switcher.

**Three-tier memory (+ the learning tier).**
- *Episodes* (`hippocampus/episodes/`) — appended every turn, zero-latency, no LLM.
- *Consolidated* (`hippocampus/consolidated/`) — daily compaction summaries collected
  per week (configured in Settings → Knowledge → Compaction, not in `heartbeat.md`).
- *Knowledge* (`hippocampus/knowledge/`) — durable facts about the user and their
  world. The nightly compaction REWRITES these files as a curator (one `## Entity`
  section per person/project/topic, merged and contradiction-free, never
  append-only) — hand edits remain first-class and survive curation. Each rewrite
  keeps the previous version as `<file>.md.bak`.
- *Reflection* (`brain/reflection/`) — behavioural lessons, kept separate from facts:
  the nightly reflection reviews finished conversations (the user's own words in the
  transcript are the signal), writes dated review blocks, and rewrites
  `playbook.md` — the distillate injected into EVERY system prompt. A monthly
  deep-reflection pass audits playbook + knowledge adversarially (Settings →
  Knowledge → Reflection).

**Safety (amygdala).** Every tool call is classified using the `danger_patterns` /
`confirm_patterns` in each `SKILL.md`: *safe* runs immediately, *confirm* needs user
approval, *destructive* is blocked. `config.json → safety.bypassPermissions` can
auto-approve confirms; heartbeat (scheduled) jobs auto-approve by design.

**Background jobs (brainstem + `heartbeat.md`).** Each `##` heading in
`heartbeat.md` is a scheduled job; its body is the instruction, fed to the full
pipeline as if the user typed it. Schedule kinds: `Startup`, `Every (Nm)`,
`Every (Nh)`, `Hourly (mm)`, `Daily`/`Nightly (HH:MM)`, `Weekday (HH:MM)`,
`Weekly (Day HH:MM)`, `Monthly (DD HH:MM)`, and raw `Cron (expr)`. In a fresh
install every example is commented out — uncomment a block to activate it.
**Managing a job always goes through the `.automations` tools.** The
`automation_*` tools validate the schedule and reload the scheduler live; a job
written into the file by hand skips both and is overwritten by the next writer.
The file itself stays an ordinary file — fine to read, and fine to edit when the
file is what you're working on — but it is not how an automation gets managed.

**Channels.** The desktop app, Telegram, and WhatsApp all share one brain. A
`TurnRunner` serializes turns (FIFO) so the channels don't collide; a `TurnRouter`
sends approval prompts back to whichever channel owns the active turn.

**Conversations & the context meter.** Each conversation JSON carries a
`contextMeter` (`contextTokens` vs `contextBudget`, e.g. 108 867 / 1 000 000) and a
`timeline` of structured events (`context.built`, `llm.response`, `safety.allowed`,
`segment.*`, `task.*`). Assistant messages are split into typed `segments`
(`text`, `tool_call`, `tool_result`, `active_model`, `turn_end`).

**Usage accounting.** Every model call appends a line to `usage/daily/<today>.md`
and to `usage/providers/<provider>.md` — timestamp, model, token counts
(`in` / `out` / `cw`=cache-write / `cr`=cache-read), and dollar cost. This is the
ground truth for "what am I spending?"

---

## 8. File-format reference

Reading these confidently lets you answer almost any question about the agent.

### `config.json` (workspace root)
```jsonc
{
  "version": 1,
  "launchAtStartup": false,
  "llm": {
    "local":   { "enabled": false, "provider": "ollama", "model": "", "endpoint": "http://localhost:11434" },
    "providers": [
      { "id": "deepseek", "model": "deepseek-v4-pro", "apiKey": "***", "models": ["deepseek-v4-flash", "deepseek-v4-pro"] }
    ],
    "brain": { "providerId": "deepseek", "model": "deepseek-v4-pro" },  // the single chosen cloud model
    "localOnly": false,                     // chat switcher: cloud (false) vs local-only (true)
    "restrictPowerfulModels": true,
    "thinkingModes": { "deepseek-v4-pro": "max" }
  },
  "safety": { "bypassPermissions": true, "blockCredentials": false },
  "updates": { "enabled": true },
  "weekStartsOn": 1,
  "locale": "en",                            // en | ar
  "theme": "light",                          // light | dark | system
  "onboardingCompleted": true,
  "lastSettingsState": { … },                // UI state, safe to ignore
  "brave": { "enabled": true, "apiKey": "***" }
}
```
> ⚠️ `apiKey` fields are **live secrets**. Never print them, paste them into chats,
> commit them, or send them anywhere. When showing this file, redact the keys.

### Conversation — `brain/conversations/conv-*.json`
Top-level keys: `id`, `title`, `model`, `messages[]`, `createdAt`, `updatedAt`,
`stats { allTime, lastTurn, meter }`, `timeline[]`. `stats.allTime` holds the
conversation's lifetime totals (processingMs, turns, apiCalls, toolCalls,
token splits, cost); `stats.lastTurn` the previous turn's roll-up;
`stats.meter {contextTokens, contextBudget, compactionAt, model}` the context
meter reading. Older files may carry the legacy
`contextMeter {contextTokens, contextBudget}` instead.
- user message: `{ role, content, timestamp }`
- assistant message: `{ role, content, segments[], toolTimings, stopReason, timestamp }`
- segment kinds: `text`, `tool_call`, `tool_result`, `active_model`, `turn_end`.

### Episode — `brain/hippocampus/episodes/YYYY-MM-DD.md`
```markdown
# 2026-06-14

## 23:26 — <truncated first line of the user's message>
- **User:** <the full prompt>
- **Tools:** tool_a (success), tool_b (success), …
- **Response:** <the agent's final reply, truncated>
```

### Event log — `brain/corpus/YYYY-MM-DD.log.md`
```markdown
- 18:47 | ext_navigate | success
  - Args: `{"url":"https://old.reddit.com"}`
  - Output: `{"url":"…","title":"…","tabId":2109153710}`
```
This is the most useful file for forensics: every tool call, its arguments, and its
raw output, in order.

### Task — `brain/motor/tasks/TASK-<id>.md`
```markdown
# Task: <the originating instruction>
- **ID:** TASK-mqe81hqsfh4c
- **Status:** SUCCEEDED          # PENDING | RUNNING | SUCCEEDED | FAILED | STOPPED
- **Created:** 2026-06-14T20:13:03Z
- **Steps:** 101/101 succeeded

## Steps
### Step 1: ext_navigate ✅
- **Args:** `{ … }`
- **Duration:** 1.90s   **Attempts:** 1
- **Output:** { … }
- **Result:** succeeded
```
The companion `TASK-<id>-detail.log` holds the verbose version. Motor writes these
*as it runs*, so even after a crash the transcript shows exactly where it stopped.

### Usage — `usage/daily/<date>.md` and `usage/providers/<provider>.md`
```
- 2026-06-14 19:59:33 | deepseek-v4-pro | in:452044 out:36522 cw:0 cr:9575168 | $0.311717
```
`in`/`out` = prompt/completion tokens, `cw`/`cr` = cache write/read tokens.

### Heartbeat — `brain/brainstem/heartbeat.md`
```markdown
## Daily (08:00)
Good morning routine. Summarize overnight messages, list today's calendar
events, and highlight the top 3 priorities.

## Every (15m)
Poll the deployment pipeline. If any stage is stuck or failed, summarize and notify me.
```

---

## 9. How to help the user navigate — recipes

Concrete playbooks for the things users actually ask.

**"Change how my agent talks / behaves."**
Edit `brain/identity/soul.md` (personality, tone, humor, hard rules). For one-off
procedural rules, add them to `brain/prefrontal/agents.md` (your overrides win over
the core procedures). Changes take effect on the next turn — no restart needed.

**"Remember this about me / my project."**
Put durable facts in the right `brain/hippocampus/knowledge/*.md`
(`people`, `projects`, `preferences`, `technical`, `decisions`) or in
`brain/identity/user.md`. Hand-edited knowledge is first-class — the agent reads it
exactly like promoted memories.

**"Why did the agent do that?"**
1. Open today's `brain/corpus/YYYY-MM-DD.log.md` → see every tool call + output.
2. For a specific run, open the matching `brain/motor/tasks/TASK-*.md`.
3. To see *what the model was actually told*, read the timestamped dump in
   `brain/prefrontal/.debug/`. Cross-reference with the conversation JSON.

**"Add a new tool / skill."**
Create `brain/cerebellum/.<name>/SKILL.md` (+ `plugin/index.mjs` for code). Give it
`triggers` and `tools`, plus `danger_patterns`/`confirm_patterns` if it can do harm.
Reloads on next launch.

**"Run something on a schedule."**
Have the agent do it with the `.automations` capability's `automation_*` tools —
`automation_create` / `automation_edit` / `automation_delete` / `automation_run`,
with pausing and resuming a job being `automation_edit` with `enabled` — which
validate the schedule, reload the scheduler live and keep the Automations page in
step. Every operation on a job goes through them; that is the rule, not
the shortcut. The file they manage is `brain/brainstem/heartbeat.md` (schedule
kinds in §7): read it to see what is scheduled, and edit it directly when the file
itself is what you are working on — just not as a way to change a job, since a
hand-written change skips validation, the live reload and the page's bookkeeping
and gets silently overwritten.

**"What am I spending?"**
Sum `usage/daily/*.md`, or read a single provider's ledger in
`usage/providers/<provider>.md`. Each line already has the dollar cost.

**"It's acting weird / search seems stale."**
Delete `brain/cortex.db*` (the index rebuilds from markdown on launch). If a turn
half-wrote something, the markdown files are still the truth — fix them directly.

**"Switch model / add an API key / go fully offline."**
Edit `config.json → llm`. Add a provider object (with `id`, `model`, `apiKey`),
point `llm.brain` at the `{ providerId, model }` you want, or set
`llm.local.enabled = true` and `llm.localOnly = true` to run on Ollama only.
**Redact keys when you echo this file.**

**"Back up / move my agent to another machine."**
Copy `~/.wolffish/workspace/`. Skip `runtime/` (disposable Chromium state) and
`cortex.db*` (regenerates). The brain is just files.

**"Start over."**
`rm -rf ~/.wolffish/` returns a clean slate. There is nothing stored anywhere else.

---

## 10. How to write good prompts for Wolffish

Wolffish is an *agent with memory and tools*, not a stateless chatbot. Prompt it
accordingly.

**For everyday asks, just talk.** Natural language is enough — `triggers` route the
request to the right capability ("summarize this PDF", "commit my changes", "what's
on my calendar tomorrow"). Don't name tools; describe the outcome.

**Teach once, in markdown — don't repeat yourself every chat.** A standing
preference belongs in `soul.md` / `user.md` / `knowledge/*.md`, not re-pasted into
each prompt. The brain is editable for exactly this reason.

**For autonomous / long-running tasks, give it a spec.** The pattern that works
well here (visible across this user's real task history):

1. **ROLE** — the mode and hard environment constraints
   ("work only through the `ext_*` extension tools in my logged-in tab; never use a
   headless browser").
2. **MISSION** — the single, concrete goal.
3. **RULES** — the failure modes to avoid, stated as imperatives. Be explicit about
   what *counts as done* vs. what merely *looks* done.
4. **ENVIRONMENT** — exact tools/sites/selectors to use or avoid.
5. **PHASES / PER-ITEM LOOP** — break the work into ordered steps; finish one item
   fully before the next.
6. **EXIT CONDITION** — the precise, checkable state that ends the run.
7. **FINAL OUTPUT** — the shape of the deliverable (e.g. "a table with X, Y, Z").

**Bake in verification.** "Never assume success — confirm it." Tell it the *signal*
that proves a step worked (a URL containing `/comments/`, a file that now exists, an
HTTP 200), not just a tool returning `{"success":true}`. Many real failures are
"the tool said OK but nothing happened."

**Constrain the toolset when it matters.** If only one capability is valid, say so
and name what's forbidden — picking `.browser` (headless, logged-out) instead of
`.browser-extension` (the real session) is a recurring, expensive mistake.

**Make waits real.** If a task needs pacing (rate limits, polling), instruct an
explicit `ext_wait`/sleep — and say "a real pause, never simulated." The agent will
otherwise try to fast-forward.

**Right-size effort.** "Quick check" → terse, one pass. "Be thorough / autonomous /
don't stop until done" → it will plan, loop, and self-verify. The agent has loop-
awareness (it can detect dead loops), but a clear EXIT CONDITION is what keeps a long
run from spinning.

---

## 11. Safety & control

- **Amygdala gating.** Each tool call is *safe* (runs), *confirm* (asks first), or
  *destructive* (blocked), per the `danger_patterns`/`confirm_patterns` in each
  `SKILL.md`. There are no hidden guardrails beyond this — the rules are readable.
- **`config.json → safety`.** `bypassPermissions: true` auto-approves *confirm*-level
  calls (convenience vs. caution — know which the user wants). `blockCredentials`
  toggles credential-pattern protection.
- **Scheduled jobs auto-approve.** Heartbeat tasks run unattended, so they don't
  pause for confirmation — be deliberate about the instruction you give an
  automation, and set it up with the `automation_*` tools as always.
- **No artificial timeouts.** Tools run until they finish (except OOM protection);
  long-running commands are normal. Use `background:true` for servers/watchers.
- **Secrets live in `config.json`** (provider keys) and in OAuth/token state for
  `.google`, `.github`, `.notion`. Treat all of it as sensitive: never print,
  commit, or transmit it.

---

## 12. Golden rules for working inside `.wolffish`

1. **Markdown is truth; the DB is cache.** Fix behavior by editing markdown. Never
   hand-edit `cortex.db` — delete it to rebuild instead.
2. **Stay inside `~/.wolffish/`.** The whole agent is here by design. Don't scatter
   state elsewhere; uninstall must remain `rm -rf ~/.wolffish/`.
3. **Capability folders are dot-prefixed (hidden).** Use `ls -a` in
   `brain/cerebellum/`.
4. **`agents.md` ≠ `agents.core.md`.** Put user customizations in `agents.md` (never
   overwritten, wins on conflict); leave `agents.core.md` alone.
5. **Don't touch `runtime/` or `.lock`.** Chromium plumbing and the single-instance
   guard — editing them only breaks things.
6. **Protect secrets.** Redact `apiKey`/token values whenever you display
   `config.json` or service state.
7. **Prefer reading before writing.** The corpus log, task transcripts, and
   `.debug/` prompt dumps usually answer "why" before you change anything.
8. **This guide is orientation, not the agent's manual.** For how the agent itself
   should behave, see `brain/prefrontal/agents.core.md`.

---

*Wolffish — a brain you own. Everything it is lives in this folder. Read it, edit
it, own it.* 🐺
