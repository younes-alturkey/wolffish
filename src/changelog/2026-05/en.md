## v1.0.100 — 2026-05-29

### Close to Tray

Clicking the close button no longer quits the app — it hides the window to the system tray instead. A tray icon sits in the menu bar (macOS) or system tray (Windows/Linux) with options to show the window or quit. Double-clicking the tray icon restores the window. On macOS, the tray icon follows Apple's template image guidelines and adapts to the menu bar theme automatically. To actually quit, right-click the tray icon and choose Quit, or use the standard keyboard shortcut (Cmd+Q / Alt+F4).

---

## v1.0.89 — 2026-05-25

### DeepSeek Billing Fix

The 16.6% billing offset (calibrated for Anthropic) is no longer applied to DeepSeek usage. DeepSeek costs now reflect the raw token math.

### DeepSeek Promoted in Settings

DeepSeek now appears above Anthropic and OpenAI in the provider list.

---

## v1.0.88 — 2026-05-25

### Ollama Is Now Optional

The app no longer blocks you at the Ollama setup screen if Ollama isn't installed or running. You land directly in the chat, and a small notice tells you no model is configured with a link to Settings → Models. The send button is disabled until a local model or cloud provider is available. A "Skip for now" link on the Ollama setup page lets you bypass it at any time.

### Code Editor Placeholder

The chat input now shows placeholder text when empty, using CodeMirror's built-in placeholder extension.

---

## v1.0.82 — 2026-05-23

### Sidebar Navigation

The chat navigation buttons (workspace, heartbeat, history, settings) have moved from a horizontal toolbar into a collapsible sidebar on the left edge. Click the toggle icon to switch between icon-only and icon-with-label modes — the preference is persisted across restarts. This replaces the previous platform-split layout where macOS used a floating title-bar strip and Windows/Linux used an inline header row. All three platforms now share the same sidebar.

---

## v1.0.80 — 2026-05-23

### New Conversation Clears Context Meter

Starting a new conversation now resets the context meter and token counters. Previously, the meter kept showing the previous conversation's values until the first message was sent.

### Microphone Permission Prompt

The app now checks system-level microphone permission before attempting to record. On macOS, the system prompt is shown if access hasn't been determined. On Windows, the permission status is checked against system privacy settings. If access was denied on either platform, a toast directs you to your system settings. Previously, clicking the mic button would silently fail on a fresh install or after permission was revoked.

---

## v1.0.79 — 2026-05-23

### Instant Conversation Titles

Conversation titles are now generated instantly from the first message using local NLP instead of calling the local LLM. The previous approach depended on Ollama being reachable with a model configured — if either failed, the conversation stayed "Untitled" permanently. Titles now appear immediately across all channels (app, Telegram, WhatsApp) with no network dependency.

---

## v1.0.76 — 2026-05-22

### What's New After Update

When the app restarts after installing an update, it now opens directly to the changelog so you can see what changed. This only happens once — the next launch goes straight to chat as usual. If the app needs to show a setup screen (Ollama not running, no model selected, onboarding incomplete), that takes priority and the changelog redirect is skipped.

---

## v1.0.73 — 2026-05-20

### Expanded Prompt Editor

A new expand button inside the chat text input opens a full-screen code editor for composing longer messages in Markdown. The button is vertically centered inside the input and uses absolute positioning so it doesn't shift the input or surrounding elements out of alignment.

---

## v1.0.71 — 2026-05-20

### Settings Tab Persistence

The settings page now remembers exactly where you left off — the active tab and every sub-tab (provider, channel, service, hippocampus tab) are saved to config.json and restored on the next visit. A module-level cache provides instant restoration within the same session without re-reading the config, while config.json persistence survives app restarts. Navigation from other pages (e.g. the changelog back button) can now target a specific settings tab instead of always landing on the default models page.

### Settings Panel Flash Fixes

Three visual glitches that caused brief flashes or layout jumps when opening settings panels:

- **Services tab flash**: The selected service fell back to the first available while capabilities were still loading, causing a visible tab swap. The fallback now waits until capabilities have loaded before applying.
- **WhatsApp opacity flash**: The connection status section briefly appeared at full opacity before snapping to its disabled state. The initial render now defaults to disabled until the connection check resolves.
- **Telegram layout jump**: The auto-refresh interval selector was hidden during loading because the state started as null. The gate condition was changed so the selector renders immediately, matching its final layout.

### Button Label & Toggle Cleanup

All "Test API" / "Test connection" / "Test API connection" buttons across settings panels have been relabeled to "Save" — the underlying handlers already validate-then-save, so "Test" was misleading. The cellebrum capability toggle has been changed from a sliding checkbox to a segmented Off/On control matching every other toggle in settings.

### Unified Resync Buttons

The resync/refresh buttons in Cellebrum, Usage, Data, and Heartbeat panels now match the viewer page pattern: a compact inline button with an icon and text label, disabled state with lowered opacity, and both success and error toasts. The compaction (hippocampus) panel gained a resync button where it previously had none. The spinning icon animation was removed from all resync buttons app-wide — the disabled opacity is sufficient feedback.

### Data Analytics Loaded at Startup

System info and data analytics are now fetched once during app boot in FlowProvider and served from context. The data panel reads them instantly on open instead of fetching on every visit. The refresh button still works, updating the shared context for all consumers.

---

## v1.0.70 — 2026-05-20

### API Cost Optimization: Prompt Cache Fix

The Anthropic provider was invalidating its entire prompt cache on every iteration of the agent loop. The cause: the `<runtime>` block — which carries a live iteration counter and tool count — was embedded in the middle of the system prompt, inside a single cached content block. Because Anthropic's prefix cache requires byte-exact matches, changing even one character in the runtime counter broke the cache chain for everything downstream — system instructions, tool definitions, and the message history prefix. Every API call rewrote the full context from scratch instead of reading it from cache.

The fix splits the Anthropic system parameter into two content blocks: a stable prefix (identity, instructions, tools, memory — everything before `<runtime>`) with a `cache_control` breakpoint, and the volatile runtime block without one. The stable prefix now stays cached across all iterations of a turn, and the runtime block sits outside the cache boundary where changes don't affect anything upstream.

On a real 66-iteration heartbeat run, this shifted 3.5 million tokens from cache writes ($6.25/MTok) to cache reads ($0.50/MTok) — cutting the dominant cost component by roughly 60%. This is the single largest cost reduction in this release. OpenAI's automatic prefix caching already handled this correctly since the runtime block was at the end of the system string, but the Anthropic provider needed the explicit two-block split.

### API Cost Optimization: Message History Compaction

Long-running agentic loops (like the heartbeat's computer-use posting phase) accumulate screenshots and tool results that are never referenced again. A 60-iteration session could carry 15 base64 screenshots (~100K tokens each) and dozens of web_fetch bodies (10-15K chars each) in every subsequent API call — all of it re-sent to the model on every iteration even though the model already analyzed and acted on it turns ago.

The agent loop now runs a compaction pass between iterations with two conservative rules:

1. **Screenshot eviction** — keeps the 5 most recent screenshots. Older ones have their binary image data removed and a text marker prepended. The model's own analysis of those screenshots is preserved in the adjacent assistant messages — only the raw pixels are dropped.

2. **Tool result truncation** — tool results older than 6 assistant turns that exceed 2,000 characters are trimmed to a 500-character prefix. Error results are never truncated, since the model may need them for retry logic.

All mutations are local to the in-flight message array inside the current turn. Nothing is persisted — the conversation file, hippocampus, and renderer history are unaffected. The thresholds are deliberately gentle: most short conversations never trigger compaction at all, and the preserved content (5 recent images, 500-char prefixes, all errors intact) is more than enough for the model to maintain context continuity.

### Heartbeat: Posting Phase Streamlined

The daily heartbeat's LinkedIn posting instructions were updated to prevent a scroll verification loop that dominated the run's cost. The model would paste the post into LinkedIn's rich-text composer, then try to scroll to the top to verify every line — but LinkedIn's composer ignores standard scroll-to-top commands. The model would escalate scroll amounts (10 → 50 → 200 units) across 11 consecutive screenshot-scroll-wait cycles, each a full API round-trip carrying the entire accumulated context.

The updated instructions tell the model to: save the post to a file first, copy it via `osascript` (which preserves formatting better than direct paste), take one spot-check screenshot after pasting, and post immediately without scrolling. The formatting is already correct in the source file — the scroll-to-verify loop added no value.

This eliminates roughly 11 API iterations and 11 screenshots from the run, saving both the direct cost of those calls and the cascading cost of carrying those screenshots in every subsequent iteration.

### Cost Tracking Accuracy

The cost calculation had three compounding errors:

1. **Wrong model pricing.** The pricing table had `claude-opus-4` at $15/$75/MTok (the deprecated Opus 4.0 rate). The actual model in use — `claude-opus-4-6` — costs $5/$25/MTok. The fuzzy model-name matcher (`startsWith`) matched `claude-opus-4-6` to the `claude-opus-4` entry, inflating every cost figure by 3x. Fixed by adding explicit entries for all current Opus 4.5/4.6/4.7 variants and sorting match keys longest-first so `claude-opus-4-6` matches before `claude-opus-4`.

2. **No cache cost distinction.** The old formula applied a flat input rate to all input tokens. Anthropic charges 1.25x for cache writes and 0.10x for cache reads; OpenAI gives a 50% discount on cached tokens. The new formula uses per-model multipliers from the pricing table: `cacheWrite` and `cacheRead` fields on every entry, applied as multipliers on the base input rate. Both providers now share the same unified formula.

3. **Dashboard gap.** Even with correct per-token rates, the raw calculation under-predicts the actual Anthropic dashboard charge by about 16.6% — likely from request-level rounding and cache-tier auto-promotion on long agentic loops. A calibrated billing offset (`CLOUD_BILLING_OFFSET = 0.166`) is applied on top of the fact-based token math so the UI never under-reports spending. The offset is documented with the exact calibration data point (dashboard $44.62 vs raw $38.28) and errs +$0.01 above actual.

Haiku 3.5 pricing was also corrected ($0.80/$4, was $1/$5), and local/Ollama models now correctly report $0 cost.

### OpenAI Cache Token Tracking

The OpenAI provider wasn't parsing cached token counts from the API response. OpenAI returns `prompt_tokens_details.cached_tokens` alongside the main usage fields, but the provider only read `prompt_tokens` and `completion_tokens` — cached tokens were invisible. This meant OpenAI cost calculations ignored the 50% cache discount entirely, and the usage dashboard showed no cache activity for OpenAI models.

The provider now extracts `cached_tokens`, subtracts it from `inputTokens` to get the uncached count (matching how Anthropic reports its split), and includes `cacheReadTokens` in the turn metadata. The cost formula picks up the discount automatically through the per-model `cacheRead: 0.50` multiplier in the pricing table.

---

## v1.0.69 — 2026-05-20

### Source Tree Cleanup

Flattened 56 single-file directories that wrapped one file in a redundant folder (e.g. `brave/brave.ts` → `brave.ts`). Import paths are shorter across the board — `@main/brave/brave` becomes `@main/brave`, `@components/core/button/Button` becomes `@components/core/Button`, and so on. No logic or behavior changes; purely structural.

---

## v1.0.68 — 2026-05-20

### Live Heartbeat Overlay

When a heartbeat job is running, the chat area now shows a live activity dashboard instead of just a static "read only" message. The overlay displays the running job's name, start time, a live elapsed timer, the full instruction body, and a streaming activity log. Each log entry is color-coded by type — blue for tool calls, violet for results, green for completions, red for failures, amber for skipped jobs. The log auto-scrolls and caps at 50 entries to keep memory usage bounded.

This was built because background automations were a black box during execution. You'd see the chat lock up with no indication of what was happening or how far along it was. Now you get a real-time view of every step the agent takes while the job runs.

### Single-Job Execution Queue

Heartbeat jobs now run strictly one at a time. If a scheduled job fires while another is already executing, it's skipped with a log entry explaining why — previously the brainstem only checked per-job concurrency, so two different schedules could overlap and compete for the same resources (model context, tool state). The running job's metadata (id, label, body, start time) is tracked and exposed to the renderer, which is what powers the overlay above.

### Computer-Use Coordinate Auto-Scaling

Screenshot coordinates are now automatically mapped to screen positions when clicking or moving the mouse. Previously, when a screenshot was resized from native resolution down to the max width (1280px), the model received image-pixel coordinates but mouse actions expected screen-space coordinates. On multi-monitor setups it was worse — the model had to manually add the display's global offset to every coordinate. A new `scaleToScreen()` function stores the scale factor and display offset after each screenshot and applies them transparently to all subsequent mouse actions. The screenshot output message was simplified accordingly — it no longer asks the model to do offset math.

---

## v1.0.60 — 2026-05-20

### Heartbeat Resync Fix

The Resync button on the Heartbeat page no longer flashes the editor. Previously, clicking it would unmount the entire editor and show a loading message while fetching — causing a visible flash even on fast connections. The editor now stays in place and updates silently when new data arrives, matching the behavior of the workspace viewer. Resync also shows a success or error toast now, same as the viewer page does.

### Default Heartbeat Examples No Longer Show as Jobs

The default `heartbeat.md` ships with a large commented-out example block demonstrating every schedule type. The sidebar was incorrectly parsing the `##` headings inside that block as real jobs, filling the list with dozens of phantom automations on first launch. The parser now skips raw comment blocks that don't use the single-job comment syntax (`<!-- ## Heading -->`).

---

## v1.0.59 — 2026-05-19

### Heartbeat Dashboard

You can now see exactly what your agent is doing in the background. The new **Heartbeat** page — accessible from the chat toolbar — gives you a live view of every scheduled automation running in the brainstem: startup tasks, intervals, hourly jobs, daily routines, and weekly schedules. Each job shows its type, cron expression, and when it fires next (with a live countdown). Click any job to inspect the full instruction body with syntax highlighting.

This was built because heartbeat automations were invisible before — you'd define schedules in `heartbeat.md` and just trust they were running. Now you can verify at a glance.

### Shell PATH Resolution

GUI apps on macOS and Linux don't inherit your terminal's PATH. That meant binaries installed via Homebrew, nvm, cargo, pyenv, and similar tools were invisible to the agent — shell commands would fail with "command not found" even though they worked fine in your terminal. Wolffish now spawns your login shell at startup to capture the real PATH and uses it for every child process. It also refreshes PATH after installing system dependencies, so newly installed binaries are immediately available without restarting.

### Better Shell Error Diagnostics

When a shell command fails, the error message now includes the first 500 characters of output alongside the exit code. Previously you'd just see "Command exited with code 1" with no hint about what went wrong. The agent can now read the actual error and act on it — no more blind retries.

### Workspace Viewer Refresh

The "Reset to Default" button has been removed from the workspace viewer. It was a footgun — one click would silently wipe any edits you'd made to a file, replacing it with the factory version. In its place, every file now has a **Resync** button that reloads the file from disk without overwriting anything. The tree-level resync button also got a text label so it's easier to find. Additionally, `heartbeat.md` is now read-only in the viewer to prevent accidental edits to live schedules.

---

## v1.0.47 — 2026-05-17

### Core Agent File is Now Read-Only

The `agents.core.md` file in the workspace viewer is now locked to preview-only mode. This file defines Wolffish's core agent procedures and is managed entirely by the system — manual edits were never intended and would be silently overwritten on the next update. The file is no longer editable in the built-in viewer.

---

## v1.0.46 — 2026-05-16

### Launch at Startup Toggle Fix

The "Launch at startup" toggle in Settings no longer flashes from off to on when you open the tab. Previously the toggle rendered in its default off state before the system check completed, causing a visible flicker. The toggle now waits for the actual OS status before appearing.

---

## v1.0.45 — 2026-05-16

### Sensitive Data Filter

Wolffish has always been able to detect and block messages that look like passwords, API keys, or private keys. That behaviour is now opt-in.

The filter is **off by default** — keeping it always-on turned out to limit what the agent could do, since discussing credentials is a normal part of many workflows (setting up integrations, debugging auth issues, explaining how to rotate keys). With it off, the agent handles those conversations naturally.

If you want the hard guard back — so that accidentally pasting a secret into chat discards the message entirely — go to **Settings → Wolffish** and turn on **Block sensitive data in messages**. When enabled, any message that appears to contain a password, API key, access token, or private key is rejected before it reaches the agent, is never stored anywhere, and you get a short notification explaining what happened. This applies across the desktop app, Telegram, and WhatsApp.

---

## v1.0.44 — 2026-05-16

### No More Arbitrary Limits

Wolffish capabilities used to enforce hard-coded timeouts and result caps that had nothing to do with what was actually possible — a 2-minute ceiling on shell commands, a 10-result cap on web search, a 30s limit on browser navigation, 8KB of tool output visible to the agent. These weren't safety measures; they were guesses baked in at development time that caused real failures in practice: `npm install` getting killed mid-way, `ffmpeg` encoding jobs timing out, large search results silently truncated before the agent could read them.

All of those limits are gone. Every capability now runs until it finishes. The agent decides whether to set a timeout — and when it does, it picks a value that actually matches the command. A quick `which ffmpeg` might get 5 seconds. A `brew install` from source gets as long as it needs.

**What changed:**

- **Shell** — no default or minimum timeout. Commands run to completion unless you explicitly set one.
- **Browser** — navigation and waits use Playwright's defaults; no hard ceiling on how long a page can take to load.
- **ffmpeg, package manager, speech-to-text, text-to-speech, Node.js, cloudflared** — all install and run operations are now timeout-free.
- **Web search** — the 10-result cap is removed. Ask for as many results as you need.
- **GitHub** — `per_page` cap raised from 30 to the API's actual maximum of 100.
- **Tool output** — the motor's result buffer grew from 8KB to 100KB, so the agent now sees the full output of a tool call instead of a truncated slice.
- **Retries** — the default retry limit increased from 3 to 10, with gradual backoff. Transient failures (network blips, slow starts) recover automatically instead of giving up after the third attempt.

The only limits that remain are memory-protection caps on file sizes (documents at 100MB, audio at 500MB) — those exist to protect your machine, not to second-guess the agent.

---

## v1.0.35 — 2026-05-15

### Signed & Notarized Updates

Wolffish builds are now code-signed and notarized by Apple. Auto-updates install cleanly on macOS without Gatekeeper warnings or signature validation failures. The full update pipeline — download, verify, quit, replace, relaunch — works end to end.

### Structured Logging

A new workspace logger writes daily log files to `~/.wolffish/workspace/logs/`. The entire updater lifecycle is instrumented: init, check, download progress, install, and quit. Log files are viewable in the built-in file viewer and are read-only.

### Monthly Changelog

The changelog is now organized by month instead of a single file. A sidebar lists months (newest first, localized), and clicking one loads that month's release notes. New version entries go at the top of each month's file. Each version header now shows its release date, and the current app version is displayed in the changelog header.

---

## v1.0.14 — 2026-05-08

### Auto-Update System

Wolffish can now update itself. When a new version is available, the app downloads it silently in the background and shows a small card in the chat area letting you know it's ready. Click **Update** to install, or dismiss it and it'll remind you next launch.

There's a new **Updates** tab in Settings where you can see your current version, toggle auto-updates on or off, manually check for new versions, and jump to this changelog.

### Localized Changelog

The changelog now ships in both English and Arabic. It automatically picks the right one based on your language setting.

### Workspace Migration

Updating Wolffish no longer risks losing your settings. When the app launches after an update, it merges any new default config keys into your existing `config.json` without touching your values, overwrites the core agent instructions (the ones Wolffish owns), version-checks each official capability and only updates the ones that are behind, and rebuilds the search index from scratch so it reflects the latest files.

### Custom Agent Instructions

The agent instructions file has been split in two. `agents.core.md` carries Wolffish's built-in behavior and gets overwritten on every update. `agents.md` is yours — write whatever you want in it, and Wolffish will never touch it. Your instructions take precedence over the core ones when they conflict.

---

## v1.0.0 — 2026-05-01

### Initial Release

The first public version of Wolffish, a local-first AI desktop agent built on Electron.

### Brain

The core of Wolffish is a pipeline of 23 brain modules inspired by neuroscience. The **prefrontal cortex** assembles a context-aware system prompt every turn, the **hippocampus** logs episodic memory, the **cortex** provides full-text search over the workspace, and the **cerebellum** loads tool-based capabilities on demand.

### Models

Out of the box, Wolffish works with local models through **Ollama** — it manages model downloads, pulls, and selection for you. For heavier tasks, it cascades to cloud providers (**Anthropic** and **OpenAI**) and falls back to local if the cloud is unreachable.

### Capabilities

The agent can run **shell commands**, read and write **files**, work with **git**, browse the web via **Brave Search**, manage **Notion** pages, interact with **GitHub** repos, and connect to **Google Workspace** (Docs, Sheets, Drive, Calendar, Tasks, Gmail). There's also **speech-to-text**, **text-to-speech**, and **computer use** for desktop automation.

### Safety

Every tool call goes through a safety gate. Depending on the danger level, the agent either runs it automatically, asks for your approval, or blocks it outright. You can tune this in Settings.

### Channels

Beyond the chat window, Wolffish can respond through **Telegram** and **WhatsApp**, so you can talk to your agent from your phone.

### Memory

The agent builds up knowledge over time. It logs conversation episodes daily, stores long-term knowledge files, and tracks your preferences so it adapts to how you work.

### Everything Else

**Context-aware compaction** keeps conversations from blowing up the context window. **Usage analytics** track token counts and costs across providers. A built-in **file viewer and editor** lets you browse and modify your workspace without leaving the app.
