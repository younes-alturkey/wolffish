<picture>
  <img src="https://cdn.wolffi.sh/generic/banner.jpg" alt="wolffish" />
</picture>

# wolffish-app

**A brain you own, not a chatbot you rent.**

Wolffish is a local-first, markdown-powered personal AI desktop agent built with Electron. It runs natively on macOS, Windows, and Linux — thinking, acting, and learning entirely on your machine. No black boxes. No cloud dependencies. Full system access.

Built around a 15-module runtime modeled after the human brain, from memory consolidation to safety gating. Every piece of state lives in readable markdown files. To change what the agent does, you edit markdown — not code.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE.md)
[![Version](https://img.shields.io/badge/version-1.0.318-green.svg)](https://wolffi.sh)
[![Platform](https://img.shields.io/badge/platform-macOS%20%7C%20Windows%20%7C%20Linux-lightgrey.svg)]()

---

## Requirements

| Tool    | Minimum |
| ------- | ------- |
| Node.js | 24+     |
| npm     | 11+     |

---

## Watch

<table>
  <tr>
    <td align="center">
      <a href="https://www.youtube.com/watch?v=oog1q7T8H-s"><img src="https://cdn.wolffi.sh/generic/demo_walkthrough.jpg" width="360" alt="Demo walkthrough" /></a>
      <br /><b>Demo walkthrough</b>
    </td>
    <td align="center">
      <a href="https://www.youtube.com/watch?v=XZdBttn-99E"><img src="https://cdn.wolffi.sh/generic/cinematic_launch.jpg" width="360" alt="Cinematic launch" /></a>
      <br /><b>Cinematic launch</b>
    </td>
    <td align="center">
      <a href="https://www.youtube.com/watch?v=TKdTWd6BXR8"><img src="https://cdn.wolffi.sh/generic/cinematic_reveal.jpg" width="360" alt="Cinematic reveal" /></a>
      <br /><b>Cinematic reveal</b>
    </td>
  </tr>
</table>

---

## Install

**macOS / Linux / Windows:**

```bash
curl -fsSL https://releases.wolffi.sh/install.sh | sh
```

**Windows (PowerShell):**

```powershell
irm https://releases.wolffi.sh/install.ps1 | iex
```

Or download the latest release directly from [wolffi.sh](https://wolffi.sh).

---

## Get the mobile app

Wolffish Mobile is the companion phone app — pair it to your desktop once by scanning a QR code, then reach your agent from anywhere over an end-to-end encrypted tunnel.

<table>
  <tr>
    <td align="center">
      <a href="https://apps.apple.com/us/app/wolffish/id6792797989"><img src="https://cdn.wolffi.sh/generic/app-store.svg" width="168" height="56" alt="Download on the App Store" /></a>
    </td>
    <td align="center">
      <a href="https://play.google.com/store/apps/details?id=sh.wolffi.mobile"><img src="https://cdn.wolffi.sh/generic/google-play.svg" width="189" height="56" alt="Get it on Google Play" /></a>
    </td>
  </tr>
</table>

Source: [thewolffish/wolffish-mobile](https://github.com/thewolffish/wolffish-mobile)

---

## Table of Contents

- [Install](#install)
- [Get the mobile app](#get-the-mobile-app)
- [Features](#features)
- [Architecture](#architecture)
- [The Agent Pipeline](#the-agent-pipeline)
- [Memory System](#memory-system)
- [Capabilities](#capabilities)
- [Channels](#channels)
- [Integrations](#integrations)
- [Tech Stack](#tech-stack)
- [Project Structure](#project-structure)
- [Getting Started](#getting-started)
- [Configuration](#configuration)
- [Development](#development)
- [Safety & Control](#safety--control)
- [Links](#links)
- [License](#license)

---

## Features

- **Brain-inspired architecture** — 15 specialized runtime modules modeled after human neuroanatomy
- **Local-first** — runs fully offline with Ollama; cloud providers (Claude, GPT) are optional quality enhancers
- **Markdown is truth** — all behavior, memory, and configuration lives in readable, editable, versionable markdown
- **Three-tier memory** — episodes, consolidated summaries, and long-term knowledge that grows with you
- **20+ built-in capabilities** — shell, filesystem, git, browser automation, document processing, speech, memes, and more
- **Multi-channel** — talk to your agent via the desktop app, Telegram, or WhatsApp
- **Safety-gated** — destructive operations require explicit approval through the amygdala module
- **Provider cascade** — Claude → GPT → Ollama fallback chain for maximum reliability
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

---

## The Agent Pipeline

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

The pipeline is deterministic — the LLM adds creativity at exactly one point (`thalamus.stream()`). Everything else is predictable code.

---

## Memory System

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

**Two types:**

- **Pure Skills** — a `SKILL.md` file with instructions for the LLM using existing tools (no code needed)
- **Plugin Capabilities** — `SKILL.md` + executable code in `plugin/index.mjs` for complex logic

**Built-in capabilities (20+):**

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

---

## Channels

Wolffish communicates through three channels, all sharing the same brain state:

| Channel      | Interface                                                    | Approvals               |
| ------------ | ------------------------------------------------------------ | ----------------------- |
| **Electron** | Native desktop UI with real-time streaming and rich markdown | Dialog-based            |
| **Telegram** | Personal bot with inline buttons                             | Inline button callbacks |
| **WhatsApp** | Direct messaging via WhatsApp Web protocol                   | Text-based replies      |

A `TurnRunner` serializes turns across channels (FIFO queue). A `TurnRouter` routes approval requests to whichever channel owns the active turn.

### The terminal

`wolffish` is a full terminal client, built for a monitorless box as much as for a laptop next to the app. It is a compiled binary (Bun + OpenTUI) that ships inside the app and talks to the running daemon over the local socket, so it holds no agent state of its own: close the terminal and the turn keeps running.

```
wolffish                     the session screen: streaming feed, cards, live context meter
wolffish -p "…" [-f file]    one shot — print and exit (pipes: cat log | wolffish -p "why?")
wolffish resume [id]         continue a conversation
wolffish conversations …     the app's screens as verbs, with --json for scripts
wolffish settings …          every setting, and every action the app has
wolffish status | usage | service | path | pair
```

While `npm run dev` is running, the `wolffish` command runs the client straight from `src/cli` under Bun, so every launch is the code on disk. Inside the session: `ctrl+p` opens the command palette, `/` completes slash commands, `@path` attaches a file, `shift+enter` inserts a newline, `esc esc` interrupts, and the footer shows the model, mode, thinking effort, plan mode, project, elapsed time, context used and cost. Approvals, questions, todos, diffs, tasks and countdowns render as cards. Settings open as a page → card → row browser with search across every row; the few flows that need a terminal conversation (pairing, key tests) run on the plain terminal and hand back.

---

## Integrations

Integrations are plugin capabilities that connect to external services. All are stateless, optional, and store credentials locally in `config.json`.

| Service              | Features                                                               |
| -------------------- | ---------------------------------------------------------------------- |
| **Google Workspace** | Gmail, Drive, Calendar, Contacts, Tasks, Sheets (OAuth)                |
| **GitHub**           | Repos, issues, PRs, workflows, releases, gists (personal access token) |
| **Notion**           | Pages, databases, search, create/query (API token)                     |
| **Brave Search**     | Web search API                                                         |

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
│   ├── runtime/                 The 15-module brain
│   │   ├── thalamus/            LLM provider routing
│   │   ├── prefrontal/          Context assembly
│   │   ├── hippocampus/         Memory storage
│   │   ├── cerebellum/          Capability loading
│   │   ├── amygdala/            Safety gating
│   │   ├── motor/               Task execution
│   │   ├── wernicke/            Output parsing
│   │   ├── broca/               Response streaming
│   │   ├── cortex/              Search index
│   │   ├── corpus/              Event bus
│   │   ├── ras/                 Attention filtering
│   │   ├── basalganglia/        Outcome telemetry
│   │   ├── reflection/          Nightly self-review, playbook, monthly deep reflection
│   │   ├── hypothalamus/        System health
│   │   ├── brainstem/           Background processes
│   │   ├── insula/              Self-awareness
│   │   └── providers/           LLM adapters (anthropic/, openai/, local/)
│   ├── channels/                Electron, Telegram, WhatsApp adapters
│   ├── conversations/           Chat storage & management
│   ├── workspace/               ~/.wolffish init, config, purge
│   ├── services/                GitHub, Google, Notion, Brave
│   └── uploads/                 File processing
├── cli/                         The `wolffish` terminal client — Bun + OpenTUI, compiled per platform
│   ├── index.ts                 Entry: TUI, one-shot (-p / piped), and the classic verbs
│   ├── tui/                     Screens, dialogs, keymap, store (Solid)
│   ├── commands/, lib/          Classic line-mode verbs and helpers (still used for scripts)
│   └── build.ts                 `bun build --compile` per target (electron-builder beforePack)
├── preload/                     contextBridge (IPC types)
├── renderer/src/                React frontend
│   ├── pages/                   Chat, Settings, History, ModelPicker, Onboarding, ...
│   ├── components/              core/ (primitives) + common/ (composed)
│   ├── providers/               Theme, Locale, Flow (navigation)
│   ├── hooks/                   Custom React hooks
│   └── lib/                     i18n, utilities
├── defaults/workspace/          Bundled brain (copied on first launch)
└── changelog/                   Version history

resources/                       Icons, fonts, images
```

**Convention:** one thing per folder, file matches folder name. No barrel exports — imports use explicit alias paths (`@main/*`, `@components/*`, `@hooks/*`, etc.).

---

## Getting Started

### Prerequisites

- **[Ollama](https://ollama.ai)** — required for local LLM inference
- **Cloud API keys** (optional) — Anthropic (Claude) or OpenAI (GPT) for higher quality
- **macOS permissions** (optional) — Accessibility + Screen Recording for computer-use capability

### Install

Download the latest release for your platform from [wolffi.sh](https://wolffi.sh) or build from source:

```bash
# Clone the repo
git clone https://github.com/thewolffish/wolffish-app.git
cd wolffish-app

# Install dependencies
npm install

# Run in development mode
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

### Brain Files

| File                           | Purpose                                                      |
| ------------------------------ | ------------------------------------------------------------ |
| `brain/identity/soul.md`       | Agent personality — tone, verbosity, behavioral guidelines   |
| `brain/identity/user.md`       | About you — name, role, tech stack, projects, preferences    |
| `brain/prefrontal/agents.md`   | Operational manual — tool rules, procedures, constraints     |
| `brain/brainstem/heartbeat.md` | Scheduled background jobs (managed by the Automations skill) |

Edit any of these markdown files to change how your agent behaves.

---

## Development

```bash
npm run dev            # Start with HMR (hot module replacement)
npm run build          # Typecheck + build all targets
npm run build:mac      # macOS DMG (universal: x64 + arm64)
npm run build:win      # Windows NSIS installer
npm run build:linux    # Linux AppImage
npm run typecheck      # TypeScript validation
npm run lint           # ESLint check
npm run release        # npm version patch + push
```

### Path Aliases

```
@main/*         → src/main/*
@preload/*      → src/preload/*
@renderer/*     → src/renderer/src/*
@components/*   → src/renderer/src/components/*
@hooks/*        → src/renderer/src/hooks/*
@lib/*          → src/renderer/src/lib/*
@pages/*        → src/renderer/src/pages/*
@providers/*    → src/renderer/src/providers/*
@resources/*    → resources/*
```

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

## Workspace

Everything wolffish knows lives in `~/.wolffish/workspace/`:

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

## Links

- **Website** — [wolffi.sh](https://wolffi.sh)
- **App Store** — [Wolffish for iOS](https://apps.apple.com/us/app/wolffish/id6792797989)
- **Google Play** — [Wolffish for Android](https://play.google.com/store/apps/details?id=sh.wolffi.mobile)
- **Documentation** — [docs.wolffi.sh](https://docs.wolffi.sh/)
- **Discord** — [Join the community](https://discord.com/invite/F5Ue36PzQ)
- **X** — [@younesbites](https://x.com/younesbites)

---

## License

MIT License — Copyright (c) 2026 [Younes Alturkey](mailto:younes@wolffi.sh)

See [LICENSE.md](LICENSE.md) for the full text.
