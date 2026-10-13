# wolffish

**A brain you own, not a chatbot you rent.**

Wolffish is a local-first, markdown-powered personal AI desktop agent built with Electron. It runs natively on macOS, Windows, and Linux — thinking, acting, and learning entirely on your machine. No black boxes. No cloud dependencies. Full system access.

Built around a 15-module runtime modeled after the human brain, from memory consolidation to safety gating. Every piece of state lives in readable markdown files. To change what the agent does, you edit markdown — not code.

> **Status: no longer maintained.** Wolffish is not under active development. There is no website, no app-store listing, no hosted relay and no support channel. The code and the [documentation](docs/README.md) stay here, under the MIT license, for anyone who wants a battle-tested, working agent harness to build on top of or run as is. Fork it and make it yours. Issues and pull requests on this repository are not actively reviewed.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Release](https://img.shields.io/github/v/release/younes-alturkey/wolffish)](https://github.com/younes-alturkey/wolffish/releases/latest)
[![Platform](https://img.shields.io/badge/platform-macOS%20%7C%20Windows%20%7C%20Linux-lightgrey.svg)]()

---

## Install

One line, on macOS, Linux or Windows (Git Bash / WSL). It picks the right package for the machine, verifies it against the release manifest, installs it, and tells you the three commands that follow:

```bash
curl -fsSL https://github.com/younes-alturkey/wolffish/releases/latest/download/install.sh | sh
```

Windows, from PowerShell:

```powershell
irm https://github.com/younes-alturkey/wolffish/releases/latest/download/install.ps1 | iex
```

Both scripts live in [`install/`](install/) and are attached to every GitHub release, so the URL above always serves the current one. On a server, follow with `wolffish service install` (keeps the agent up across reboots) and `wolffish web password` (the master password for the Web UI, which is on from the first launch at `http://<ip>:8787`); `wolffish web https enable` gets a trusted certificate for the bare IP.

Or download the installer for your platform from the [latest release](https://github.com/younes-alturkey/wolffish/releases/latest):

| Platform | File                                           |
| -------- | ---------------------------------------------- |
| macOS    | `.dmg` (universal: Apple Silicon + Intel)      |
| Windows  | `-setup.exe` (NSIS installer)                  |
| Linux    | `.AppImage` (self-updating), `.deb`, or `.rpm` |

Builds are unsigned. macOS will say the app cannot be verified on first launch: open **System Settings → Privacy & Security** and choose **Open Anyway**, or clear the quarantine flag:

```bash
xattr -d com.apple.quarantine /Applications/Wolffish.app
```

The app checks GitHub Releases for updates on launch. Windows and the AppImage update themselves in place. macOS downloads the new disk image to `~/.wolffish/updates/` and, on **Open installer**, opens it and quits so you can drag the new app into Applications (an unsigned app cannot replace itself). `.deb` and `.rpm` installs update by reinstalling.

To build from source instead, see [Getting Started](#getting-started).

---

## Features

- **Brain-inspired architecture** — 15 specialized runtime modules modeled after human neuroanatomy
- **Local-first** — runs fully offline with Ollama; cloud providers (Claude, GPT) are optional quality enhancers
- **Markdown is truth** — all behavior, memory, and configuration lives in readable, editable, versionable markdown
- **Three-tier memory** — episodes, consolidated summaries, and long-term knowledge that grows with you
- **20+ built-in capabilities** — shell, filesystem, git, browser automation, document processing, speech, and more
- **Multi-channel** — desktop app, terminal client, Web UI, Telegram, or WhatsApp
- **Safety-gated** — destructive operations require explicit approval through the amygdala module
- **Provider cascade** — Claude → GPT → Ollama fallback chain
- **Bilingual** — English and Arabic with full RTL support
- **Self-contained** — everything lives in `~/.wolffish/`. Delete it and you're back to factory defaults

---

## Architecture

Wolffish maps human brain regions to software modules. Each module handles exactly one function and communicates through a typed event bus called the **corpus** (modeled after the corpus callosum).

| Module            | Function                                                   | Brain Analogy               |
| ----------------- | ---------------------------------------------------------- | --------------------------- |
| **Thalamus**      | Routes input to LLM providers                              | Sensory gateway             |
| **Prefrontal**    | Assembles context for the LLM                              | Executive function          |
| **RAS**           | Filters relevant content by attention                      | Reticular Activating System |
| **Cortex**        | Fast retrieval index (SQLite FTS5)                         | Pattern matching            |
| **Hippocampus**   | Memory storage and consolidation                           | Memory center               |
| **Cerebellum**    | Discovers and loads capabilities                           | Motor coordination          |
| **Wernicke**      | Parses LLM output and extracts tool calls                  | Language comprehension      |
| **Broca**         | Streams responses to the UI                                | Language production         |
| **Amygdala**      | Safety gate for dangerous operations                       | Threat detection            |
| **Motor**         | Executes tasks with retry logic                            | Motor cortex                |
| **Basal Ganglia** | Records raw tool outcomes (telemetry)                      | Reward processing           |
| **Reflection**    | Nightly self-review + playbook distilled into every prompt | Sleep consolidation         |
| **Hypothalamus**  | Monitors system health (RAM, disk, CPU)                    | Homeostasis                 |
| **Brainstem**     | Runs background processes and cron jobs                    | Autonomic functions         |
| **Corpus**        | Event bus connecting all modules                           | Corpus callosum             |
| **Insula**        | Self-awareness and introspection                           | Interoception               |

> See [ARCH.md](ARCH.md) for the full architectural deep dive.

### The agent pipeline

Every message follows a deterministic path through the brain:

```
User message
  → prefrontal.buildContext()       read markdown, query memory, score relevance
    → thalamus.stream()             call LLM with assembled context
      → broca.streamToUI()          stream response in real-time
        → wernicke.parse()          extract tool calls from output
          → amygdala.classify()     check against danger patterns
            → motor.execute()       run tools with retry logic
              → hippocampus.appendEpisode()    save to memory
                → basalganglia.recordOutcome() record success/failure
```

The LLM adds creativity at exactly one point (`thalamus.stream()`). Everything else is predictable code.

### Memory

All memory lives as markdown files in `~/.wolffish/workspace/brain/hippocampus/`:

| Tier             | Location                   | How It Works                                                                                     |
| ---------------- | -------------------------- | ------------------------------------------------------------------------------------------------ |
| **Episodes**     | `episodes/YYYY-MM-DD.md`   | Daily conversation logs, appended every turn. No LLM call — instant, zero latency.               |
| **Consolidated** | `consolidated/YYYY-WNN.md` | Weekly summaries generated by nightly compaction. LLM-powered compression into patterns.         |
| **Knowledge**    | `knowledge/*.md`           | Long-term facts about people, projects, preferences. Promoted from episodes or manually created. |

The prefrontal cortex pulls memory candidates from all three tiers, passes them through the RAS for relevance scoring, and includes only what matters for the current message.

---

## Capabilities

A capability is a self-contained folder in `brain/cerebellum/` that gives wolffish new abilities. Drop a folder in, and the agent learns a new skill.

- **Pure skills** — a `SKILL.md` file with instructions for the LLM using existing tools (no code needed)
- **Plugin capabilities** — `SKILL.md` + executable code in `plugin/index.mjs` for complex logic

| Category      | Capabilities                                                                |
| ------------- | --------------------------------------------------------------------------- |
| **System**    | Shell, Filesystem, Package Manager, Node.js                                 |
| **Web**       | Web Search, Browser (headless automation)                                   |
| **Documents** | Word (.docx), PDF, Spreadsheet (.xlsx/.csv)                                 |
| **Media**     | FFmpeg, Speech-to-Text (Whisper), Text-to-Speech                            |
| **Code**      | Git, GitHub (OAuth API)                                                     |
| **Services**  | Google (Gmail, Drive, Calendar, Sheets), Notion                             |
| **Desktop**   | Computer Use (screenshots, mouse, keyboard)                                 |
| **Fun**       | Memes, GIF Search                                                           |
| **Meta**      | Introspect, Skills (self-extension), Automations (scheduled heartbeat jobs) |

Integrations (Google Workspace, GitHub, Notion, Brave Search) are plugin capabilities. All are optional and store their credentials locally in `config.json`.

---

## Channels

Every channel shares the same brain state. A `TurnRunner` serializes turns across channels, and a `TurnRouter` routes approval requests to whichever channel owns the active turn.

| Channel      | Interface                                                           | Approvals               |
| ------------ | ------------------------------------------------------------------- | ----------------------- |
| **Electron** | Native desktop UI with real-time streaming and rich markdown        | Dialog-based            |
| **Terminal** | `wolffish`, a compiled TUI that talks to the running app            | Cards in the session    |
| **Web UI**   | The same desktop UI, served to any browser at the machine's address | Same cards as Electron  |
| **Telegram** | Personal bot with inline buttons                                    | Inline button callbacks |
| **WhatsApp** | Direct messaging via WhatsApp Web protocol                          | Text-based replies      |
| **Mobile**   | The companion phone app, built from source, over an E2E tunnel      | Cards on the phone      |

**Terminal.** `wolffish` ships inside the app (Bun + OpenTUI) and talks to the running daemon over the local socket, so it holds no agent state of its own: close the terminal and the turn keeps running.

```
wolffish                     the session screen: streaming feed, cards, live context meter
wolffish -p "…" [-f file]    one shot — print and exit (pipes: cat log | wolffish -p "why?")
wolffish resume [id]         continue a conversation
wolffish conversations …     the app's screens as verbs, with --json for scripts
wolffish settings …          every setting, and every action the app has
wolffish status | usage | service | path | pair | web
```

**Web UI.** Settings → Channels → Web UI serves the renderer bundle over HTTP(S), with the preload bridge replaced by a WebSocket into the same IPC handlers (`src/main/channels/web/`). On by default, behind a master passphrase Wolffish generates at first launch — twelve random words; `wolffish web password` prints it on a box with no screen, and `wolffish web` carries the rest of the card (on/off, signed-in browsers, a test notification, a restart). It never runs without a password. HTTPS is one button: Wolffish checks ports, privileges and firewall, asks Let's Encrypt for a 6-day IP certificate (or a 90-day domain one) with its built-in ACME client, serves it on 443 beside the plain app port, renews it every few days and keeps the history (`docs/channels/https.mdx`). Self-signed and your own PEM files remain as modes. Signed-in browsers can receive Web Push notifications, and the layout adapts to a phone. Everything it serves is behind the sign-in except what the agent publishes on purpose: `public_link` puts a file, a folder (as a static site) or a local port (reverse-proxied) at `/p/<token>` with no sign-in, for the people a result is meant for; the panel and `wolffish web public` list and revoke those links.

**Mobile.** [`apps/mobile`](apps/mobile) is the companion phone app (iOS and Android, Expo): the same conversations and settings, paired once by QR and connected through an end-to-end encrypted tunnel that a relay forwards without being able to read. It is no longer in the app stores and there is no hosted relay. If you want it, you deploy the relay in [`packages/relay`](packages/relay) to your own Cloudflare account (or anywhere that runs Node), enter its address in Settings → Channels → Mobile, build the app from source with your own Expo account and install it on your phone. The Mobile panel lists the steps; both folders' READMEs walk through them.

---

## Tech Stack

| Layer               | Technology                                                                 |
| ------------------- | -------------------------------------------------------------------------- |
| **Desktop**         | Electron 39, electron-vite                                                 |
| **Frontend**        | React 19, TypeScript 5.9, Tailwind CSS 4                                   |
| **Build**           | Vite 7, electron-builder                                                   |
| **Database**        | SQLite (better-sqlite3) with FTS5 full-text search                         |
| **Event Bus**       | mitt (typed event emitter)                                                 |
| **LLM Providers**   | Pure `fetch()` — no SDKs. Anthropic (Claude), OpenAI (GPT), Ollama (local) |
| **Messaging**       | grammy (Telegram), Baileys (WhatsApp)                                      |
| **File Processing** | Sharp (images), pdf-parse, mammoth (docx), xlsx                            |
| **i18n**            | i18next (English, Arabic)                                                  |
| **Logging**         | Pino                                                                       |
| **Scheduling**      | node-cron                                                                  |

---

## Project Structure

```
src/
├── main/                        Electron main process (Node.js)
│   ├── index.ts                 Entry point — IPC handlers
│   ├── runtime/                 The 15-module brain (one folder per region)
│   │   └── providers/           LLM adapters (anthropic/, openai/, local/)
│   ├── channels/                Electron, CLI, Web UI, Telegram, WhatsApp adapters
│   ├── conversations/           Chat storage & management
│   ├── workspace/               ~/.wolffish init, config, purge
│   ├── services/                GitHub, Google, Notion, Brave
│   └── uploads/                 File processing
├── cli/                         The `wolffish` terminal client — Bun + OpenTUI, compiled per platform
├── preload/                     contextBridge (IPC types)
├── renderer/src/                React frontend
│   ├── pages/                   Chat, Settings, History, ModelPicker, Onboarding, ...
│   ├── components/              core/ (primitives) + common/ (composed)
│   ├── providers/               Theme, Locale, Flow (navigation)
│   ├── hooks/                   Custom React hooks
│   └── lib/                     i18n, utilities
├── defaults/workspace/          Bundled brain (copied on first launch)
└── changelog/                   Version history

apps/mobile/                     The companion phone app (Expo) — build from source, see its README
packages/relay/                  The rendezvous relay (Cloudflare Worker) — deploy your own, see its README
packages/extension/              The browser extension source; bundled into src/defaults/workspace/extension/
resources/                       Icons, fonts, images
```

**Convention:** one thing per folder, file matches folder name. No barrel exports — imports use explicit alias paths (`@main/*`, `@components/*`, `@hooks/*`, etc.). See [AGENTS.md](AGENTS.md) for the full guide.

---

## Getting Started

### Prerequisites

- **Node.js 24+** and **npm 11+**
- **[Ollama](https://ollama.ai)** — for local LLM inference
- **Cloud API keys** (optional) — Anthropic (Claude) or OpenAI (GPT) for higher quality
- **macOS permissions** (optional) — Accessibility + Screen Recording for the computer-use capability

### Build from source

```bash
git clone https://github.com/younes-alturkey/wolffish.git
cd wolffish
npm install
npm run dev
```

On first launch, wolffish creates `~/.wolffish/workspace/` with the default brain modules. Everything lives in that one folder.

---

## Configuration

All configuration lives in `~/.wolffish/workspace/config.json`:

```json
{
  "llm": {
    "local": { "enabled": false, "provider": "ollama", "model": null },
    "providers": [],
    "allowLocalFallback": false,
    "restrictPowerfulModels": true
  },
  "safety": { "bypassPermissions": true, "blockCredentials": false },
  "locale": "en",
  "theme": "system",
  "onboardingCompleted": false
}
```

### Brain files

| File                           | Purpose                                                      |
| ------------------------------ | ------------------------------------------------------------ |
| `brain/identity/soul.md`       | Agent personality — tone, verbosity, behavioral guidelines   |
| `brain/identity/user.md`       | About you — name, role, tech stack, projects, preferences    |
| `brain/prefrontal/agents.md`   | Operational manual — tool rules, procedures, constraints     |
| `brain/brainstem/heartbeat.md` | Scheduled background jobs (managed by the Automations skill) |

Edit any of these markdown files to change how your agent behaves.

### Workspace

```
~/.wolffish/workspace/
├── brain/
│   ├── identity/            Who you are and who the agent is
│   ├── prefrontal/          Operational procedures
│   ├── cerebellum/          Capabilities (skills + plugins)
│   ├── hippocampus/         Memory (episodes, consolidated, knowledge)
│   ├── motor/tasks/         Task execution logs
│   ├── basalganglia/        Daily feedback logs
│   ├── brainstem/           Cron schedule
│   └── corpus/              Daily event logs
├── conversations/           Chat history
├── cortex.db                Search index (disposable — rebuilds from markdown)
└── config.json              App configuration
```

**Markdown is truth, SQLite is cache.** Delete `cortex.db` and it rebuilds from markdown on next launch. Delete `~/.wolffish/` entirely and you're back to a fresh install.

---

## Development

```bash
npm run dev            # Start with HMR (hot module replacement)
npm run typecheck      # TypeScript validation (main, renderer, CLI)
npm run lint           # ESLint check
npm run build          # Typecheck + build all targets
npm run build:mac      # macOS DMG (universal: x64 + arm64)
npm run build:win      # Windows NSIS installer
npm run build:linux    # Linux AppImage, deb, rpm
```

### Releasing

```bash
npm run release        # npm version patch, then push main + tags
```

Pushing a `v*` tag runs [the release workflow](.github/workflows/release.yml), which builds the macOS, Windows, and Linux installers and attaches them to a GitHub Release along with the update manifests the app reads. No secrets are required: every build is unsigned (macOS is ad-hoc signed so it launches on Apple Silicon).

---

## Safety & Control

The **amygdala** module gates every tool call using patterns defined in each capability's `SKILL.md`:

| Classification       | Behavior                                                  |
| -------------------- | --------------------------------------------------------- |
| **Danger patterns**  | Blocked completely — regex-matched destructive operations |
| **Confirm patterns** | Requires explicit user approval before execution          |
| **Safe**             | Executes immediately                                      |

No hard-coded guardrails beyond this system. No artificial timeouts (except OOM protection). Tools run until they complete naturally. The LLM decides when to set limits.

---

## License

MIT License — Copyright (c) 2026 Younes Alturkey

See [LICENSE](LICENSE) for the full text.
