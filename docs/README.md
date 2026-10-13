# Wolffish Documentation

**The complete guide to owning your brain.**

Documentation for [Wolffish](https://github.com/younes-alturkey/wolffish) — the local-first, markdown-powered personal AI desktop agent. Fully bilingual (English + Arabic). Covers everything from first launch to writing custom brain modules.

> **Wolffish is no longer maintained.** There is no website, no hosted docs site, no app-store listing, no hosted relay and no support channel any more. The code and these docs remain here, under the MIT license, for anyone who wants a battle-tested, working agent harness to build on top of or run as is. Fork it, read on, and make it yours.

The pages are written as [Mintlify](https://mintlify.com)-flavored MDX. The prose, tables and code blocks render on GitHub directly; the `<Card>`, `<Note>` and `<Tabs>` components show as plain tags, and `docs.json` holds the navigation for anyone who wants to serve the site again.

---

## What's Inside

### Get Started

| Page                                                       | What You'll Learn                                              |
| ---------------------------------------------------------- | -------------------------------------------------------------- |
| [Overview](introduction/overview.mdx)                      | What wolffish is and how it works at a glance                  |
| [Philosophy](introduction/philosophy.mdx)                  | The 8 design principles that guide every decision              |
| [Installation](getting-started/installation.mdx)           | Download from GitHub Releases, prerequisites, build from source |
| [First Launch](getting-started/first-launch.mdx)           | What happens when you run wolffish for the first time          |
| [Quickstart](getting-started/quickstart.mdx)               | 5 steps to send your first message and inspect the internals   |
| [Terminal CLI](getting-started/cli.mdx)                    | Attach to the running agent from a terminal, even over SSH      |
| [Server Deployment](getting-started/server-deployment.mdx) | Run headless on a VPS as a background service                  |

### Core Concepts

| Page                                                       | What You'll Learn                                      |
| ---------------------------------------------------------- | ------------------------------------------------------ |
| [God's Creation](architecture/gods-creation.mdx)           | How 14 human brain regions map to software modules     |
| [Architecture Overview](architecture/overview.mdx)         | 15-module runtime, event bus, deterministic pipeline   |
| [Pipeline](architecture/pipeline.mdx)                      | Step-by-step message flow with token budget allocation |
| [Stateless Model](architecture/stateless-model.mdx)        | Why every LLM request is self-contained — no sessions, no server-side state |
| [Context Compaction](architecture/context-compaction.mdx)  | Lean start, rolling summaries and recovery stubs keep every conversation inside the window |
| [Lean Context](architecture/lean-context.mdx)              | Why a fresh request is ~9.4K tokens, not ~94K, and how the rest is retrieved on demand |
| [Waiting](architecture/waiting.mdx)                        | The wait tool, the card it draws, and the OS attention signal |
| [Brain Modules](architecture/brain-modules.mdx)            | Complete reference for all 15 modules                  |
| [Workspace](architecture/workspace.mdx)                    | The `~/.wolffish/` directory structure                 |
| [Event Bus](architecture/event-bus.mdx)                    | 30+ typed events, logging, cleanup                     |

### Capabilities

| Page                                                              | What You'll Learn                                          |
| ----------------------------------------------------------------- | ---------------------------------------------------------- |
| [Overview](capabilities/overview.mdx)                             | Pure skills vs plugins, discovery, relevance scoring       |
| [SKILL.md Reference](capabilities/skill-md-reference.mdx)         | Complete frontmatter format, tool schemas, safety patterns |
| [Creating Capabilities](capabilities/creating-capabilities.mdx)   | Step-by-step guide to building a new skill                 |
| [Writing Plugins](capabilities/writing-plugins.mdx)               | Build capabilities with executable code                    |
| [Self-Authoring Skills](capabilities/self-authoring-skills.mdx)   | How the agent writes, tests, edits and deletes its own skills at runtime |
| [Built-in Capabilities](capabilities/built-in-capabilities.mdx)   | The 20+ capabilities that ship with wolffish               |
| [Coding](capabilities/coding.mdx)                                 | Plan mode, surgical edits, diffs and task lists inside a code project |
| [Office Viewers](capabilities/office-viewers.mdx)                 | .pptx, .docx and .xlsx rendered as the document itself     |
| [Community Capabilities](capabilities/community-capabilities.mdx) | Install and share capabilities with the community          |

### Channels

| Page                              | What You'll Learn                                  |
| --------------------------------- | -------------------------------------------------- |
| [Overview](channels/overview.mdx) | Multi-channel architecture, TurnRunner, TurnRouter |
| [Telegram](channels/telegram.mdx) | Bot setup, inline buttons, HTML formatting         |
| [WhatsApp](channels/whatsapp.mdx) | Baileys integration, QR login, voice transcription |

### Integrations

| Page                                                    | What You'll Learn                                                |
| ------------------------------------------------------- | ---------------------------------------------------------------- |
| [Overview](integrations/overview.mdx)                   | Stateless architecture, credential handling                      |
| [Browser Extension](integrations/browser-extension.mdx) | Control your real browsers with 62 tools over WebSocket          |
| [Mobile App](integrations/mobile-app.mdx)               | The paired-phone channel; build the client from `apps/mobile/`   |
| [Google Workspace](integrations/google-workspace.mdx)   | Gmail, Drive, Calendar, Sheets (OAuth)                           |
| [GitHub](integrations/github.mdx)                       | Repos, issues, PRs, workflows (PAT)                              |
| [Notion](integrations/notion.mdx)                       | Pages, databases, search (API token)                             |
| [MCP](integrations/mcp.mdx)                             | Model Context Protocol servers                                   |
| [Notifications](integrations/notifications.mdx)         | One notification per turn with the real outcome; blockers interrupt mid-run |
| [Video Generation](integrations/video-generation.mdx)   | Make video with MiniMax — prompt written by your chat model, rendered asynchronously |

### Memory & Learning

| Page                                        | What You'll Learn                                 |
| ------------------------------------------- | ------------------------------------------------- |
| [Overview](memory/overview.mdx)             | Three-tier memory system and context budget       |
| [Episodes](memory/episodes.mdx)             | Daily logs — instant, no-LLM append               |
| [Consolidation](memory/consolidation.mdx)   | Nightly compaction into weekly summaries          |
| [Knowledge](memory/knowledge.mdx)           | Long-term facts and manual curation               |
| [Retrieval Tools](memory/retrieval-tools.mdx) | Model-callable tools for searching everything the agent has done, said or produced |
| [Reflection](memory/reflection.mdx)         | Nightly self-review and the playbook              |
| [Feedback Loop](memory/feedback-loop.mdx)   | How wolffish learns from approvals and rejections |

### Configuration

| Page                                             | What You'll Learn                                                           |
| ------------------------------------------------ | --------------------------------------------------------------------------- |
| [soul.md](configuration/soul-md.mdx)             | Agent personality — tone, verbosity, guidelines                             |
| [user.md](configuration/user-md.mdx)             | Your profile — name, role, stack, preferences                               |
| [agents.md](configuration/agents-md.mdx)         | Operational procedures and tool rules                                       |
| [config.json](configuration/config-json.mdx)     | App settings and provider configuration                                     |
| [Providers](configuration/providers.mdx)         | Every supported LLM provider, endpoints and setup                           |
| [Workflow Mode](configuration/workflow-mode.mdx) | The agent as master of a run it designs — phases, parallel agents, a model per agent |
| [Projects](configuration/projects.mdx)           | Standing instructions plus files that brief every conversation inside them  |
| [Procedures](configuration/procedures.mdx)       | Saved prompts run on demand — the counterpart to heartbeat jobs             |
| [Variables](configuration/variables.mdx)         | Secrets and environment-style values                                        |
| [Heartbeat](configuration/heartbeat.mdx)         | Cron-like scheduling for autonomous jobs                                    |
| [What to Schedule](configuration/what-to-schedule.mdx) | Ideas for heartbeat automations                                       |

Per-provider pages: [Anthropic](configuration/anthropic.mdx), [OpenAI](configuration/openai.mdx), [DeepSeek](configuration/deepseek.mdx), [Xiaomi MiMo](configuration/mimo.mdx), [Kimi](configuration/kimi.mdx), [MiniMax](configuration/minimax.mdx), [Qwen](configuration/qwen.mdx), [StepFun](configuration/stepfun.mdx), [xAI](configuration/xai.mdx), [Z.ai](configuration/zai.mdx), [OpenRouter](configuration/openrouter.mdx), [Ollama](configuration/ollama.mdx).

### Debugging

| Page                                                   | What You'll Learn                                       |
| ------------------------------------------------------ | ------------------------------------------------------- |
| [Overview](debugging/overview.mdx)                     | "If you can't debug it by reading markdown, it's a bug" |
| [Debug Snapshots](debugging/debug-snapshots.mdx)       | Exact context sent to the LLM                           |
| [Event Logs](debugging/event-logs.mdx)                 | Chronological system events                             |
| [Task Files](debugging/task-files.mdx)                 | Tool execution with args, output, duration              |
| [Diagnostic Export](debugging/diagnostic-export.mdx)   | One archive with everything needed to reproduce a turn  |
| [Troubleshooting](debugging/troubleshooting.mdx)       | Common issues and fixes                                 |

### Extending Wolffish

| Page                                               | What You'll Learn                          |
| -------------------------------------------------- | ------------------------------------------ |
| [agents.md](extending/agents-md.mdx)               | A drop-in guide that teaches any AI assistant to navigate ~/.wolffish |
| [Advanced Plugins](extending/advanced-plugins.mdx) | Complex logic, API calls, stateful plugins |
| [Adding Channels](extending/adding-channels.mdx)   | Build a new communication channel          |
| [Safety Patterns](extending/safety-patterns.mdx)   | Amygdala classification, confirm vs block  |

### Development

| Page                                                         | What You'll Learn                             |
| ------------------------------------------------------------ | --------------------------------------------- |
| [Setup](development/setup.mdx)                               | Dev environment, commands, path aliases       |
| [Project Structure](development/project-structure.mdx)       | Codebase layout and conventions               |
| [Contributing](development/contributing.mdx)                 | Working in your own fork                      |
| [Adding Brain Modules](development/adding-brain-modules.mdx) | Create new runtime modules                    |

### Changelog

[Release history](changelog/overview.mdx) — every version, in order.

---

## Key Concepts

### Markdown Is Truth

Every piece of agent state — personality, memory, capabilities, configuration, debug output — lives in readable, editable markdown files. The TypeScript code is pure plumbing: it reads markdown, calls LLMs, executes tools, and writes markdown back. To change what the agent does, you edit markdown.

### The Brain Architecture

Wolffish maps human brain regions to 15 specialized software modules. Each handles exactly one function and communicates through a typed event bus (the corpus). The pipeline is deterministic — the LLM adds creativity at exactly one point. Everything else is predictable code.

### Three-Tier Memory

| Tier         | Speed                 | Source                   | Lifespan  |
| ------------ | --------------------- | ------------------------ | --------- |
| Episodes     | Instant (no LLM)      | Appended every turn      | Days      |
| Consolidated | Nightly (LLM-powered) | Compressed from episodes | Weeks     |
| Knowledge    | Manual or promoted    | Curated facts            | Permanent |

### Safety by Design

The amygdala module gates every tool call against patterns defined in SKILL.md frontmatter. No hard-coded guardrails — the safety system is as transparent and editable as everything else. Destructive operations require explicit approval; outcomes feed back into the learning system.

### Local-First, Cloud-Enhanced

Can work 100% offline with Ollama, or cloud-only with no local models — your choice. All providers (DeepSeek, Xiaomi MiMo, Kimi, MiniMax, Anthropic, OpenAI, Ollama) are optional; configure any combination. You explicitly select one **Brain** model — the one you choose is the one that runs. There's no automatic cascade or fallback between providers; to run offline, pick Ollama as your Brain. We recommend starting with DeepSeek or MiMo — they handle complex agentic tasks well at a fraction of the cost. Upgrade to Anthropic or OpenAI only if execution isn't reliable enough for a specific workflow.

---

## Structure

```
docs/
├── introduction/          What wolffish is and why
├── getting-started/       Install, first launch, quickstart, CLI, server
├── architecture/          Brain modules, pipeline, event bus, workspace
├── capabilities/          Skills, plugins, built-in capabilities
├── channels/              Electron, Telegram, WhatsApp
├── integrations/          Browser extension, mobile, Google, GitHub, Notion, MCP
├── memory/                Episodes, consolidation, knowledge, reflection, feedback
├── configuration/         soul.md, user.md, agents.md, config.json, providers, heartbeat
├── debugging/             Snapshots, event logs, task files, diagnostics
├── extending/             Plugins, channels, safety
├── development/           Setup, structure, contributing
├── changelog/             Release history
├── ar/                    Full Arabic translation (parallel structure)
├── static/                Icons, favicon, CSS
└── docs.json              Navigation structure and site config
```

---

## Working on the Docs

Each `.mdx` file is self-contained — edit it directly in your fork.

To add a new page:

1. Create the `.mdx` file in the appropriate section folder
2. Add an entry to `docs.json` under the correct tab and section
3. If bilingual, create the parallel page in `ar/`

To preview the site locally, run `npx mintlify dev` inside `docs/`.

---

## License

MIT License — Copyright (c) 2026 Younes Alturkey. See [LICENSE](../LICENSE).
