## v1.0.200 — 2026-06-30

### Files Show Up Once, Not Twice

A file Wolffish hands you in chat now appears a single time, never doubled. When a task produced a file with one tool and then delivered it with another — say a page printed to PDF and then attached for you — the in-app chat could render the same document twice, stacking two identical viewers in the feed. Now every file shows once no matter how many steps touched it, matching how WhatsApp and Telegram already behaved. Wolffish also leans on its file-producing tools to deliver their own output rather than re-sending it, so the agent spends fewer steps double-handling a file that's already on screen.

---

## v1.0.199 — 2026-06-30

### Local Models Always Run at Their Real Context Window

Wolffish now reads a local model's true context window straight from Ollama right before each conversation, so you always get the full window the model was built for instead of a cautious 16k stand-in. Before, if Ollama wasn't running the moment you picked a model, Wolffish settled on that fallback size and kept using it even after Ollama came back — the context meter stuck at 16k until you switched models or restarted the app. Now the window is read fresh at the start of every message and is never pinned to a stale guess: the instant Ollama is up, your model runs at its real window and the chat's context meter shows the true number. The same freshness fix covers whether a local model counts as vision- or reasoning-capable, so those are no longer mislabeled when Ollama happens to start late. And the lookup can't stall a reply waiting on an unreachable server — it gives up quickly and falls back rather than hanging.

---

## v1.0.198 — 2026-06-30

### Local Models as Plain, Fast Chatbots

Local (Ollama) models now run **stateless** by default: each message is answered fresh, with no conversation history and none of the agent scaffolding — no stored memory, no procedures manual, no tools — just a small identity prompt that tells the model who it is. The payoff is speed and simplicity. Instead of straining to be an agent through a context it can't afford, a local model replies like a plain, fast LLM, and its prompt stays a couple of thousand tokens instead of tens of thousands. Wolffish still records your full conversation as always — the model simply doesn't carry it, so every reply starts clean.

You'll find the new **Stateless local models** toggle in **Settings → Wolffish**, on by default. While it's on, tools for local models stay off and can't be switched on — turn stateless off first to give a capable local model its history back and the option to enable tools. Cloud models are unaffected throughout.

---

## v1.0.197 — 2026-06-30

### Local Models Now Converse Without Tools by Default

When your Brain is a local (Ollama) model, Wolffish now hands it no tools — the full ~20k-token tool catalog is left out of the prompt entirely, so a small local model isn't drowned by a context it can't fit. The model still answers, explains, writes, and brainstorms as itself, and when something genuinely needs tools — running a command, editing a file, browsing, sending a channel message — it tells you plainly that tool use is off for local models and that you can turn it back on in **Settings → Wolffish → Restrict local models**. It's on by default; flip it off only for a capable local model with a large context window, and it gets the full toolset like a cloud model.

### Local Models That Actually Finish

Local models no longer stall out or spew one-token gibberish. Wolffish now runs each Ollama model at its real context window — read from the model itself instead of Ollama's tiny 4096-token default, which the system prompt alone used to overflow, leaving room for a single token before the model gave up and the agent retried that stall forever. A matching guard now ends a turn cleanly when the input truly fills the window, instead of looping. The chat's context meter also reflects the real local window the instant you switch models.

### A Steadier Chat Feed

Opening a conversation now lands on the newest message instantly, with no flash of the top before it snaps down, and stays pinned there as images, file viewers, and code highlighting settle in. File and folder cards — and tool cards — paint their final state on the very first frame instead of popping in one by one. Tool cards now stay open once they finish, so completed work stays visible without a click. And in Orchestrator mode, each worker's report stays above the orchestrator's closing summary, so the synthesis reads last — right where it belongs.

---

## v1.0.196 — 2026-06-29

### Orchestrator Mode: Workers That Run in Parallel

Wolffish can now split a hard task across several workers at once. Turn on **Orchestrator mode** in the new Modes settings, and the agent you talk to becomes a coordinator: it spins up live worker sessions on a separate model, hands each one an independent piece — research one angle, draft another, check a third — runs them concurrently, then folds everything into a single answer. You still see one agent replying; the parallelism happens underneath. Single mode stays the default and remains the cheaper, faster choice for small or step-by-step tasks. Orchestrator mode earns its keep on work that genuinely splits apart — research, analysis, batch jobs — where running the pieces side by side is faster, and a coordinator that reviews each result before using it lifts the quality.

Workers run the full toolset minus two things they shouldn't touch — they can't delegate further or message you on a channel — so the orchestrator stays the single voice to you, and the work stays bounded.

### A New "Modes" Page, and One Brain Instead of a Fallback Chain

Model setup has moved to a dedicated **Modes** tab — now the first thing you land on in Settings — and it replaces the old fallback-order list with something simpler: you pick one model. That model is your **Brain**, and it's the one that runs. The previous design let you stack providers in priority order ("try this API, then that one, then local") and quietly slid down the list when one was slow or down; that's gone. One model runs, and you always know which. Your existing setup migrates on its own — whatever was your top provider becomes your Brain, and the dead settings are cleaned out — so there's nothing to redo.

Choosing a model is now drag-and-drop, with click as a shortcut. Connected providers are listed in collapsible sections — your Brain's provider opens expanded so it's easy to re-pick — and you drag a model into the Brain slot, or just click it. When Orchestrator mode is on, the page shows two slots side by side, the Orchestrator and the Worker, and clicking alternates between them so you can fill both quickly; the worker defaults to your Brain's model when no worker has been set yet, until you choose otherwise.

The old **Models** tab stays for what it's good at — entering provider keys and basic setup — but the fallback-order dropdown and priority numbers are gone, with a note pointing to Modes for model and orchestration choices. The chat's model chip now shows both provider logos side by side when you're in Orchestrator mode with a worker set.

### Two Ways to Shape How Hard the Agent Works

Two new toggles in the Modes page let you tune behavior without changing your prompt. **Greedy effort** tells the agent that persistence beats speed and cost — retry up to about ten times instead of giving up at three, explore several genuinely different approaches instead of settling on one, and verify thoroughly before calling something done. **Autonomy** tells it to act with high agency — ask you as little as possible, make the call itself, and drive a task to the finish rather than checking in at every step. Both are independent of Orchestrator mode and apply to every turn, single, orchestrator, or worker alike.

### See Exactly What Each Worker Did

With Orchestrator mode on and verbose chat enabled, workers are no longer a black box. Each worker's text and every tool call it makes render inline, set off by an accent rail and a small uppercase label naming the worker — whatever the orchestrator called it, like **RESEARCH-PRICING** or **DRAFT-EMAIL** — so you can follow the split, learn from a worker's approach, or debug one that went sideways. With verbose off — the default — none of that shows: you get only the orchestrator's final synthesis, and the feed stays clean.

### Run an Automation Right Now

The Heartbeat page has a new **Run now** button beside each active automation, so you can fire one off immediately instead of waiting for its next scheduled time — handy for testing a job you just wrote, or running something time-sensitive on demand. You'll get a quick toast either way: it started, it's queued behind a job already running, or it couldn't run. While any automation runs, a live overlay takes over the screen with its name, a running timer, and a color-coded log of tool calls, results, and the finish — then steps aside when the job is done.

### Save a File to Your Computer

You can now save a copy of any file Wolffish has read or written on your machine — wherever it lives — to a spot you choose, through a normal save dialog. If you pick the file's own location, it skips the needless copy.

### Sturdier Writes That Survive a Crash

Every config, conversation, channel-state, and log file Wolffish writes now goes through one ordered, crash-resistant path. Whole-file state — your config, conversations, channel state — is written to a temporary file, flushed to disk, then swapped into place: a crash or hard quit can't leave a half-written file behind, so you always have the complete old version or the complete new one, never a corrupted middle. Logs go through the same serialized layer, so concurrent writes never interleave into a tangled file. (Files owned by third-party libraries or native modules — like WhatsApp's auth state — and large binary streams are out of scope by design.) It's invisible day to day, and that's the point.

---

## v1.0.195 — 2026-06-28

### Delete an Automation in One Click

The Heartbeat page now has a trash button beside each automation's On/Off switch. The switch only pauses a job — leaving it in place to flip back on later — while the trash button removes it for good: the job is deleted from heartbeat.md and unscheduled on the spot, after a quick confirmation so nothing goes by accident. No more hand-editing the file to clear out an automation you're done with. Removal is surgical — only the job you chose is taken out, and the commented examples below your active jobs are always left perfectly intact.

---

## v1.0.194 — 2026-06-27

### Update Failures Now Explain Themselves

When an update can't be installed, Wolffish now tells you exactly why, in plain language. A failed download is sorted into a real reason — the file arrived corrupted (a checksum mismatch), the update server couldn't be reached, the transfer timed out, or it couldn't be saved to disk — each shown as a clear inline alert with a **Retry** button, in place of the old one-size-fits-all "Update failed. Please try again." The underlying technical detail is still there for diagnostics, just trimmed so a verification error no longer dumps a wall of unreadable hashes.

Two rough edges went with it: a checksum failure used to spill a huge expected-vs-got digest into a toast that ran off the edge of the window — long messages now wrap and stay inside their card, and those raw 88-character hashes are shortened to a readable prefix.

---

## v1.0.193 — 2026-06-27

### Wolffish Runs on Its Own Schedule

Wolffish now manages its own scheduled jobs — its heartbeat — entirely through conversation. Say "every morning brief me on my calendar," "in 2 days remind me to renew the lease," or "check the build every hour," and it creates the automation; ask it to list, change, delete, or test one and it does. One-time jobs fire once and remove themselves; recurring ones keep going. Jobs never overlap — one that comes due while another is running waits its turn instead of being dropped — and anything missed while the app was closed runs once, collapsed, on the next launch.

### Read a WhatsApp Chat

A new **whatsapp_read** tool lets Wolffish catch up on the latest messages in any WhatsApp contact or group, returned oldest-first. It covers traffic seen while Wolffish is connected — not older history from before it started — and that buffer now survives restarts, so it no longer resets every launch.

---

## v1.0.192 — 2026-06-26

### A Per-Model Reasoning Brain Button

The thinking-mode dropdown is now a single brain icon beside the send button. One click cycles only the reasoning levels the current model actually honors — **off**, **on**, **high**, or **max** — and it lights up by tier (gray off, accent when thinking, purple at max). Models that can't be turned down (always-on reasoners) or don't reason at all show the button locked rather than hidden, so its place never shifts as you switch models.

Under the hood, two separate knobs control reasoning: **thinking** — whether the model reasons at all before answering — and **effort** — how hard it reasons when it does. Different providers expose one, the other, or both, each in their own wording. The brain button folds both into one escalating scale, so you just dial intelligence up or down on demand — off for a fast, direct answer; up through higher effort for deeper reasoning — without needing to know which knob a given model uses.

Every cloud and local provider was verified against its live API so the button never offers a level the model will reject: Claude Haiku stops at high while Opus and Sonnet reach max, Grok 4 and the QwQ/QvQ models reason always-on, GLM-5 takes effort levels while GLM-4 is a plain on/off, and so on across all twelve providers.

### Right Logo for Every Provider

The active-model chip now shows each provider's own logo — xAI, Qwen, Stepfun, and OpenRouter included — instead of a generic cloud icon.

---

## v1.0.191 — 2026-06-26

### Wolffish Asks You — With Real Choices

When a decision is genuinely yours to make, Wolffish now shows an interactive question card — a clear question, 2–5 options, and a free-text "something else" box — and waits for your pick instead of guessing or burying the ask in prose. On Telegram and WhatsApp you just reply with the option number, or type your own instructions.

### Wolffish Manages Its Own Skills

A new **skills** capability lets Wolffish list, search, enable, disable, delete, and even author its own capabilities at runtime. Say "do this every time" and it can write itself a reusable skill; say "turn off the browser" and it can disable that capability — built-ins included. It's how Wolffish extends itself without a code change.

### Channels Are Connections, Not Apps

Asked to message you on Telegram or WhatsApp, Wolffish used to try launching or clicking a phantom "Telegram"/"WhatsApp" desktop app that doesn't exist — wasting the whole turn. It now knows channels are reached only through their own send tools, and a new **channel_status** tool reports which channels are connected and the exact steps to reconnect one that isn't, so it fails gracefully instead of guessing.

### Openable Path Cards

File and folder paths Wolffish mentions in a reply now render as a card with a one-click "open in file manager" button — folders open directly, files reveal in their parent. Paths are verified against your disk first, so only real locations get a card; invented or deleted ones show nothing.

### grep Counts No Longer Read as Errors

A `grep -c` that finds zero matches exits with code 1 and prints "0" — which used to reach the model as a failed command and trigger needless retries. That tally is now read as the valid zero-count it is.

---

## v1.0.190 — 2026-06-25

### Local Voice Now Works on More Windows PCs

On some Windows machines the local voice engines wouldn't start — text-to-speech failed to load and speech-to-text crashed — because the PC's Microsoft Visual C++ runtime was older than the engines' native components required. Wolffish now detects this and sets up a compatible runtime right beside the engine, inside its own folder: no admin rights, no system-wide installer, and nothing for you to download or click. PCs that already have a current runtime are left untouched, and macOS and Linux were never affected. If the automatic setup ever can't run, the error now spells out the real cause and the one-line fix instead of a cryptic DLL message.

---

## v1.0.189 — 2026-06-25

### HTML Files Render In-Chat

HTML files you receive or attach now open in a clean, minimal viewer with syntax-highlighted source — and an expandable preview that renders the page itself, just like Markdown already does. The preview is safely sandboxed and shows the page's structure and styling; flip between the rendered **Preview** and the **Source** whenever you like.

### Cleaner Feed: Model Chip Is Now Verbose-Only

The little chip showing which model or provider answered now appears only when verbose mode is on. With verbose off — the default — the feed stays focused on replies, files, and errors.

### The Agent Narrates Its Work

No more staring at a silent spinner during long tasks. The agent now gives you a warm, plain-language heads-up before it starts and at each milestone, so you always know what it's doing — without narrating every single step.

### Simpler File & Code Cards

File and code cards no longer need a click to expand. They open at full height by default so you can read the content right away. The full-screen expand button is still there when you want it.

---

## v1.0.188 — 2026-06-25

### ARM64 Linux Builds Dropped

The experimental ARM64 Linux build has been removed. It's a niche desktop target whose packaging kept breaking on dependencies that don't ship ARM64 binaries, and the upkeep wasn't worth it for the handful of users it reached. macOS (Intel and Apple Silicon), Windows, and standard x86-64 Linux are all unaffected.

---

## v1.0.187 — 2026-06-25

### Linux ARM64 Builds Fixed

Wolffish now packages cleanly for **ARM64 Linux**. A leftover, unused build-time dependency was pulling in a native library with no ARM64 binary, which failed to compile from source and broke that build. It's been removed — nothing in the app ever used it — so ARM64 Linux builds now ship alongside every other platform.

---

## v1.0.186 — 2026-06-25

### Your Voice, Now Fully Local

Text-to-speech and speech-to-text no longer touch the cloud. Wolffish now speaks with **Kokoro**, a local neural voice engine, and listens with **faster-whisper** — both running entirely on your machine, with no API keys and nothing sent to Microsoft or anyone else. Voice memos work fully offline after a one-time setup. The default voice is **Bella** (English, US), and every voice in the picker is labeled with its accent so you know exactly what you're choosing.

### Install Voice Engines On Demand — With a Real Preview

Settings → **Text-to-Speech** and **Speech-to-Text** now have an **Install** button with a live progress bar, so you can set the engine up whenever you like instead of waiting on your first voice memo. Until it's installed, the voice and model pickers stay disabled — no picking something that isn't ready yet. And the **Preview** button plays the *actual* Kokoro voice you selected, not a browser stand-in, so what you hear is what you'll get.

### Progress That Survives Navigation

Start an install — or a Google Workspace setup or update — then switch to another tab or reload the window, and it keeps right on going. Come back and the progress bar picks up exactly where the real work is, instead of resetting to the start. The status reads "Installing" with a pulsing indicator while it runs, and the button no longer flickers as you move around the app.

### One Voice Memo Per Reply

Sending a voice note used to occasionally come back as a cluttered stack — two generated memos plus a copy of your own recording echoed back. Now you get **exactly one** voice memo in reply. If your message asked Wolffish to actually do something, it does that work first, then closes with a single spoken answer. This applies everywhere — the desktop app, Telegram, and WhatsApp.

---

## v1.0.185 — 2026-06-24

### Select & Copy in the Markdown Viewer

Rendered markdown that Wolffish shows you now has a right-click menu — **Select all** and **Copy** — in both the inline chat card and the full-size expanded view. It's the same menu you already get in every text field, trimmed to the two actions that make sense for read-only content (no paste or clear). Grab the whole document in a click, or copy just the lines you highlighted.

---

## v1.0.184 — 2026-06-24

### Markdown Renders Right in the Chat

When Wolffish generated a markdown file and handed it to you, it arrived as a plain "open me" file card — the headings, tables, and lists rendered nowhere, even though the chat already knew how to display markdown beautifully. The catch was that a generated file delivered through the catch-all attachment path skipped the markdown renderer entirely. Now any generated `.md` renders inline as rich markdown in a tidy, scrollable card — the same way a README you attach yourself already looked.

### Open Any File at Full Size

Every markdown and code card now has an **expand** button that opens its contents in a large, centered sheet — 90% of the window — so you can read a long document in comfort instead of squinting at a thumbnail-sized card. Copy, download, and reveal-in-folder sit in the header alongside a close button, and a stray click on the backdrop won't dismiss it — only the ✕ or the Escape key — so you never lose your place mid-read.

### Tidier Copy Buttons

The copy control in every viewer is now a clean icon that matches the reveal, download, and expand buttons beside it. The "Copy" label moved into a hover tooltip, and a checkmark still flashes to confirm — same action, less clutter.

---

## v1.0.183 — 2026-06-24

### Sending Media on WhatsApp Stops Freezing — and Reaches Anyone

Asking Wolffish to send a meme or file to someone on WhatsApp could lock it up completely. To attach an image it had to encode the entire file into its own working memory and hand that back as text — and on anything bigger than a thumbnail that overflowed and froze the turn outright, with no error and no recovery. The WhatsApp image, document, and voice-note tools now take a file path and read it off disk themselves, exactly the way Telegram already did, so sending media is instant and can't freeze. A new lookup also lets Wolffish confirm any phone number is registered on WhatsApp and resolve it before sending — so "send this to my wife on WhatsApp" works for any contact or group, not just people who've messaged first.

### Memes Always Pick the Right Source

Generating a meme could fail when a template from one library was handed to another — the meme services speak different "id" languages, and a template found in one wouldn't render in the other. Wolffish now routes every template to the service that can actually produce it, based on the template id itself, so a template you found always generates. Three more rough edges are gone too: meme and GIF lookups have real timeouts now, so a slow service can't hang a request; blank caption boxes keep their position instead of shifting the text; and an empty Imgflip search explains itself and points you to the larger library instead of coming back silently empty.

---

## v1.0.182 — 2026-06-23

### Big Prompts No Longer Freeze It

Pasting a very large prompt — a multi-page brief, a giant instruction block — could lock Wolffish up for minutes with no sign of life. The cause was in how it searched its own memory before answering: it turned your entire message into a thousand-term query and generated highlighted excerpts it never actually used, then ran the whole thing synchronously. That work is now bounded — the memory search drops the unused excerpt step entirely and caps the query to the salient keywords, and every other step that scans your message is capped too. A huge paste that used to freeze the app for minutes is handled in milliseconds now, and the search results are sharper for it.

### A Clear "Rebuilding Memory" Screen

After an update, Wolffish rebuilds the search index over its memory — and on a large workspace that can take a moment. Instead of an unexplained pause, you now get a clean full-screen notice with a live elapsed timer and progress while it works, in the same style as a running heartbeat job, so a normal rebuild never reads as a hang. It only appears when the rebuild is actually slow, and chat resumes automatically the moment it's done.

---

## v1.0.181 — 2026-06-23

### Recall — Ask Wolffish What It Did

Wolffish can now pull a specific detail out of its own past instead of guessing. A new **wolffish_recall** capability searches its episodes, past tasks, tool-outcome history, knowledge files, and full conversation transcripts by keyword and/or date — so "what did we do on the 18th?" or "did that World Cup task finish?" gets a real answer drawn from disk, not a shrug. A companion **wolffish_list_files** tool returns a structured, sized tree of Wolffish's own workspace — its memory, generated files, logs, and capabilities (workspace-only; your own files anywhere else are read with the regular filesystem tools). When the agent is about to say "I don't remember," it recalls instead.

### A Leaner, Faster Brain

The system prompt rebuilt on every step of a task no longer carries Wolffish's entire history. Three things used to bloat it, and each is now bounded: the raw tool-outcome day files — tens of thousands of tokens re-sent every iteration — collapse into a compact **learned-preferences digest** (reliability stats, habitual tools, recent corrections) instead of the full firehose; only static device facts go in the cached prefix, so live RAM/disk readouts no longer change the prompt every turn; and any single oversized file is trimmed to a head-and-tail with a pointer to `wolffish_recall` for the rest. The whole assembly budget is now capped to a lean ceiling regardless of how large the model's context window is. The result is dramatically smaller prompts, a stable prefix the provider can cache, and much faster, cheaper follow-up messages — with the full detail still on disk, reachable via recall.

### Open & Control Your Machine

A new **system** capability lets Wolffish drive your computer with native OS commands — no browser or screen automation needed. It can open and quit apps, list what's running, open a file, folder, or URL in its default handler (or reveal it in the file manager), and control power: restart, shut down, sleep, lock, or log out. Destructive power actions (restart, shutdown, logout) and force-quitting an app ask for confirmation first; sleep and lock just run.

### Save a Key by Just Asking

A new **secrets** capability lets Wolffish save and look up your variables — API keys, tokens, base URLs — in the very same **Settings > Variables** store you use from the UI. Paste a key and say "save this" and it's stored (and appears in Settings); ask "what keys do I have?" and it lists them. Wolffish now uses a stored value directly instead of asking you for it again, and writes it atomically rather than hand-editing `config.json`.

### A Sturdier Updater

The Updates panel no longer loses an in-progress download when you navigate away and back — the main process owns the progress now, and the panel restores the live phase, version, and percent on return. After the bytes land, a new **Verifying update** phase covers the post-download work (on Windows, signature checks and antivirus retries that run after 100%), backed by a watchdog: if it hangs, you get a clear, retryable error instead of an eternal "Downloading 100%." Updates now always fetch the full artifact (the differential/blockmap path — a known source of stalled Windows downloads — is disabled), a manual **Check** during an active download is a safe no-op instead of snapping the bar back to 0%, and a missing or failed artifact surfaces an error with a **Retry** button rather than force-quitting with nothing to install.

---

## v1.0.180 — 2026-06-22

### Voice Notes on WhatsApp

WhatsApp now handles push-to-talk voice notes the same way Telegram does: the clip is downloaded, transcribed, and answered as a normal turn — and the audio is saved so you can replay it in the in-app history. Across every channel (in-app, Telegram, WhatsApp), Wolffish also replies in the language it actually heard now — Whisper's detected language is passed straight to the model, so a short English voice note no longer drifts into your native tongue.

### A Cleaner Telegram & WhatsApp Feed

By default, Telegram and WhatsApp now relay only what matters — the agent's replies, the files it produces, and any errors — instead of narrating every tool call and intermediate step. A new **Verbose task results** toggle in each channel's settings turns the full play-by-play back on. History and ordering are unchanged; this only gates what gets sent to the chat.

### Wolffish Hands You the File

When a task produces a file, you now actually receive it. A new **send_file** capability delivers any file — document, image, audio, video, archive, code — as a native attachment in the conversation you're in: a download card in the app, a real upload on WhatsApp and Telegram (up to 50 MB). No more "saved to …/report.pdf" with nothing attached.

### Voice Transcription Self-Heals

Transcription needs FFmpeg, which previously dead-ended with a manual install message on a fresh machine. Now the in-app mic, Telegram, and WhatsApp all install FFmpeg silently the first time you send a voice note, then carry on — no setup, no restart. If it genuinely can't, you get a single friendly line instead of a wall of shell commands.

### Your Configured Voice, Respected

Voice replies now use the voice you picked in **Settings → Text-to-Speech** and stop there. Previously the agent could substitute its own same-language voice and override your choice — which is how a configured female voice could come out sounding male. It still switches voices when it's deliberately replying in another language.

### Settings Polish

**Save vs. Test connection.** Brave and GitHub now pair a plain **Save** button with a separate **Test connection** link, so you can store a key you trust without spending an API call (or quota) to verify it. Buttons grey out when nothing has changed. **Drag-and-drop Google credentials.** Drop your OAuth JSON straight onto the Google panel instead of click-to-browse only. **Quick links out.** The Brave, GitHub, and Google panels gained a header link to the provider's console.

### Fixes & Polish

Dropping a file anywhere outside a dropzone no longer navigates the window away and blanks the app. A voice memo no longer renders a second, broken "video" card next to its player. Saving only a Telegram preference (verbose, auto-refresh) no longer needlessly restarts the bot. The bundled starter identity file now ships as a fill-in-the-blanks template instead of placeholder data, with guidance that costs zero context. Several laggy opacity/colour transitions were trimmed across menus, cards, and settings for a snappier feel.

---

## v1.0.179 — 2026-06-21

### Z.ai Logo Adapts to the Theme

The Z.ai provider logo now renders as a single-color "Z" mark that tints to match light and dark mode, matching the other provider logos.

---

## v1.0.177 — 2026-06-21

### New Cloud Provider: Z.ai (GLM)

Z.ai joins the cloud lineup — its panel sits above DeepSeek in Settings. It streams responses, calls tools, and reports cache hits, with binary thinking (**Off / Think**) across the full GLM family, from `glm-4.5` and `glm-4.5-air` through `glm-5.2`. Context windows (128K–1M) and per-model pricing are tracked for accurate usage and cost. Add your API key in Settings and pick a model — everything else works like the existing providers.

---

## v1.0.176 — 2026-06-20

### FFmpeg Installs Even When Windows' Package Manager Is Broken

When Windows' `winget` is corrupted, FFmpeg now installs anyway: Wolffish downloads a standalone build directly into `~/.wolffish/bin/ffmpeg` and uses it immediately — no app restart needed. More broadly, a tool you've just installed (FFmpeg, or anything added from the shell) is found right away, because Wolffish refreshes its view of your system PATH after an install instead of waiting for a restart. Works on Windows, macOS, and Linux.

---

## v1.0.175 — 2026-06-20

### Right-Click Menu in Every Field

Every text field, box, and editor now has a right-click menu with **Select all**, **Copy**, **Paste**, and **Clear** — so you can edit with the mouse anywhere in the app, not just in the chat composer.

---

## v1.0.174 — 2026-06-20

### Telegram Recovers Faster After a Reboot

Telegram no longer lingers in "Starting" for minutes when the app launches before the network is ready — a common situation right after a reboot. The connection now retries on a tight, steady cadence and keeps trying until it succeeds, so it settles into "Running" within seconds of connectivity returning instead of up to several minutes. A stalled handshake — network up, but no real route yet — is bounded by a timeout and retried instead of left to hang, and the channel never gives up on a network outage, so it always heals itself without you having to re-save.

**Clearer "working on it" cue.** While the channel is starting or retrying, the status dot and "Starting" label now pulse, so it's obvious the app is actively connecting rather than frozen.

---

## v1.0.173 — 2026-06-20

### WhatsApp Auto-Refresh Conversations

WhatsApp now starts a fresh conversation after a period of inactivity, the same way Telegram already does. Once a chat has been idle past the configured timeout, the next incoming message rolls over to a new conversation — your previous one stays intact and is reachable with `/resume`. A new "Auto-refresh conversations" toggle and an idle-timeout selector (1–24 hours, default 3) appear in WhatsApp settings; both save instantly and the channel reads them per message, so no reconnect is needed. Previously this idle window was hard-coded to 3 hours and couldn't be turned off.

### Telegram Connected-Bot Card

Telegram settings now show a connected-bot card — the bot's name and `@username` next to the Telegram logo — mirroring the connected-account card WhatsApp already had. It stays visible (dimmed) while the channel is off, so you can always see which bot is configured, and clears only when you disconnect.

### Disconnect, on Both Channels

WhatsApp's "Logout" is now called "Disconnect", and Telegram gained a matching button. Both are styled as a clear destructive action and cleanly clear the connection — WhatsApp unpairs and wipes its session, Telegram stops the bot and clears the saved token. The button stays available even when the channel is switched off, so you can clear a stored connection at any time.

### Clearer Off-State for Channel Settings

When a channel is switched off, its settings are now disabled in place rather than hidden — the bot token, allowed users / phone numbers, auto-refresh controls, and Save button grey out instead of disappearing, so the panel layout stays stable and it's obvious what's inactive.

---

## v1.0.171 — 2026-06-19

### Quieter WhatsApp Reconnect Screen

When WhatsApp drops and reconnects on an account that's already linked — a brief network blip, or a fresh app launch of a paired session — the settings screen no longer shows the large QR-code panel. It now just pulses the status dot and shows "Connecting", since there's nothing to scan. The QR panel still appears for genuine first-time pairing, where you actually need it.

---

## v1.0.170 — 2026-06-19

### Telegram Reconnects on Its Own

The Telegram connection status now settles by itself on startup — you no longer have to open Settings and re-save to push it from "Starting…" to "Connected".

**Root cause.** The settings panel only read the connection status when it first opened or right after you saved. But the bot's startup handshake finishes a moment later in the background, and nothing told the panel — so a bot that had actually come up still read "Starting…" indefinitely, until a manual save happened to re-fetch the real state. Telegram now pushes every status change to the panel the instant it occurs, the same way WhatsApp already did.

**More resilient startup, too.** If the network isn't ready at the exact moment the app launches, Telegram now retries the connection handshake with backoff and resolves to "Running" on its own — instead of landing in an error you had to clear by hand. The whole start/stop/reconnect path was reworked so a retry in flight can never resurrect a channel you've turned off.

### Calmer, More Resilient WhatsApp Reconnection

A brief network blip no longer makes WhatsApp look broken. A routine reconnect — one that recovers on its own — used to flash red "error" text and an "attempt 1… 2… 3…" counter, as though something had failed. Now it shows a calm amber "Connecting…" spinner with no error, and only a genuine give-up (after the full retry budget is spent) is surfaced as an actual error.

**Hardened against reconnection races.** A connection that drops, gets swapped out, or is set up while offline can no longer leave behind a phantom reconnect or act on a stale event. Every socket listener now ignores activity from a connection that's already been replaced or torn down — so stopping the channel, re-linking it, riding out a blip, or launching with no network all behave predictably, with no orphaned turns, stale credential writes, or self-resurrecting connections.

---

## v1.0.169 — 2026-06-19

### Settings No Longer Reset Themselves

Fixed a bug that could wipe `config.json` back to defaults — erasing your cloud providers, API keys, and preferences — when two config writes happened at nearly the same moment. Starting a new chat from a Telegram-started conversation was a common trigger, but any overlapping writes could do it: a mode toggle, a provider save, or a Telegram `/local` / `/cloud` command racing a background write.

**Root cause.** The config file was written non-atomically — truncated to empty, then rewritten — and any read that landed in that brief window saw a blank file. The reader treated "blank" as "no config" and rebuilt from defaults, then saved that over your real settings. Under contention this reproduced in roughly 95% of attempts.

**The fix, in three layers.** Writes are now **atomic**: the new config is written to a temporary file and renamed into place, so a reader always sees a complete file — the old one or the new one, never a half-written one. All writes are **serialized** through a single in-process queue, so two changes can no longer interleave and clobber each other. And the read-modify-write step **refuses to fall back to defaults** when the file exists but can't be read — it recovers the last-known-good config instead, or fails that one write, rather than ever overwriting everything. The worst case is now "a single setting didn't save," not "all my settings are gone."

**Self-healing backup.** Every successful save now also refreshes a `config.json.bak` snapshot in your workspace folder. If the live config is ever found corrupt — including from edits made outside the app — the next write transparently restores from it.

---

## v1.0.151 — 2026-06-15

### Reveal & Open Files from Any Card

Every file Wolffish shows you — PDFs, images, videos, audio, spreadsheets, Word documents, code, and generic attachments, plus files in the workspace viewer — now has a **Reveal** button that jumps straight to it in your operating system's file manager (Finder on macOS, Explorer on Windows, your file manager on Linux), with the file highlighted. It sits next to the existing download button, mirroring the "Reveal in Finder" action already used for the browser-extension folder.

**Open in the default app.** Image and video cards also gain an **Open** button that launches the file in whatever app your system uses by default — Preview or Photos for an image, your media player for a video. Both actions are best-effort across macOS, Windows, and Linux, and fail quietly when the OS can't service them.

**Generated images are proper cards now.** A meme or image the agent creates renders in the same bordered card as every other attachment — filename plus open, reveal, and download in a tidy footer — instead of a bare floating photo.

---

## v1.0.149 — 2026-06-15

### Import Your Own Capabilities

The Cerebellum settings panel now lets you add your own skills, plugins, and tools to Wolffish. Drag a `SKILL.md`, a capability folder, or a `.zip` onto the new import dropzone — or click to browse — and it becomes a first-class capability alongside the bundled ones, with the same trigger matching, tools, and dependency handling.

Three shapes are accepted: a single **`SKILL.md`** (a pure skill — a markdown procedure with a YAML frontmatter block, no tools to run), a **capability folder** (a `SKILL.md` next to an optional `plugin/index.mjs` and `package.json` — the full skill, its executable tools, and any declared dependencies, all in one drop), or a **`.zip`** of that folder (unpacked to a temporary location and validated exactly like a folder).

**Validated before anything touches disk.** Every drop is staged in a throwaway temp directory and checked hard before a single byte reaches `brain/cerebellum/`, so a failed import can never corrupt or half-install your existing capabilities. The checks mirror the loader exactly — valid YAML frontmatter with a `name`, well-formed `triggers`/`requires`/`tools`, a real entry file (`index.mjs`, `.js`, or `.cjs`) in any `plugin/` folder, and declared tools only where a plugin exists to back them — and reject early anything the loader would otherwise choke on silently. Names must be unique across all capabilities, and any npm or system dependencies install automatically the first time the capability runs.

**Safe by construction.** Zip extraction is guarded against path traversal (zip-slip), generous size and file-count caps stop a pathological archive from hanging the import (1 MB per `SKILL.md`; 50 MB and 5,000 files in total), and junk (`node_modules`, `.git`, `__MACOSX`, `.DS_Store`) is stripped on the way in. Every validation failure surfaces as a plain-language message in the panel instead of a silent no-op.

**Removable too.** Capabilities you imported can be deleted from the panel, with a confirmation step before the folder is removed. Bundled (official) and built-in capabilities are refused — a stray click can't wipe a core feature — and a path-containment guard ensures only a direct child of `brain/cerebellum/` is ever removed.

### Shell "No Match" No Longer Looks Like a Failure

A shell command that finds nothing — `grep` with no matching lines, `find`/`ls`/`test` on a path that isn't there — exits with code 1 and no output. That is the universal "nothing found" signal, not an error, but Wolffish previously reported it as a failure. The motor then retried the same deterministic command three times and handed the model a blind `(unknown)` error with zero signal. Now an exit code of 1 with no output at all is surfaced as a clean empty result, so the agent reads "no matches" and moves on. Exit codes of 2 or higher still mean a real error (for example, `grep` 2 = read error) and are reported as failures.

**No more retrying deterministic failures.** A command that exits non-zero without a transient (network or timeout) signature reproduces the same result every time — retrying just burns backoff and shows the model the same blind error three times over. The error classifier now treats these as deterministic and fails fast, so the agent adjusts the command instead of waiting through three identical attempts. Genuinely transient failures still retry: network-error detection was widened to cover `could not resolve host`, `connection refused`/`reset`/`timed out`, and `temporary failure in name resolution`, and those checks run first, so a flaky `curl` or `git` keeps its retries.

**Clearer failures.** When a command does fail with no captured output, the error now points at the usual cause — a `2>/dev/null` redirect swallowing stderr — and suggests dropping it so the real reason is visible.

---

## v1.0.148 — 2026-06-15

### Admin Password Asked Once Per Session

Privileged (`sudo`) commands no longer prompt for your administrator password on every run. Wolffish now captures it once, holds it in memory for as long as the app is open, and reuses it silently for the rest of the session — a task that runs ten privileged commands shows one dialog instead of ten.

**What changed:** previously every elevated command leaned on the operating system's own ~5-minute credential cache, so once that expired the password dialog reappeared mid-task. The password is now held in the main process for the app's lifetime and handed to `sudo` through an askpass helper that never writes it to disk. The command's input stream is left untouched, so chained commands (`sudo a && sudo b`), piped commands (`echo x | sudo tee f`), and anything that reads stdin keep working exactly as before. Quitting Wolffish clears the password from memory — you're asked once again on the next launch.

**macOS and Linux:** both capture the password once and reuse it (macOS via the system dialog, Linux via zenity, kdialog, or ssh-askpass). If capture isn't possible — no graphical password tool, an unexpected error, or Windows, which has no `sudo` — Wolffish falls back to its previous elevation behavior, so nothing regresses.

**Localized dialog:** the password prompt now follows the app language — title, the prompt and Homebrew-install messages, and buttons — with English as the fallback.

---

## v1.0.141 — 2026-06-13

### Prompt Caching Across All Providers

Long agentic tasks are now dramatically cheaper and faster. Previously, every iteration of a tool-using task re-sent the entire conversation as uncached input — a 30-minute browser task consumed 28.8M input tokens with only a 5.5% cache hit rate. The same workload now runs at a 96–98% hit rate, making each model call roughly 36× cheaper and about twice as fast.

**What changed:** the system prompt and tool list are now pinned for the duration of a turn, so every byte upstream of the newest messages stays cache-stable across iterations. The live iteration counters that previously mutated the prompt on every call now travel as a tiny telemetry line at the very end of the request. Three prompt-churn bugs were fixed along the way: the memory system no longer re-ingests the running task's own transcript into the prompt (it grew the prompt on every tool step and was the single biggest cache killer), the behavioral feedback log is no longer included twice, and device stats no longer re-sample free RAM mid-task.

**Per-provider work:** Anthropic requests place moving cache breakpoints that extend the cached prefix each iteration, with an optional `cacheTtl: '1h'` setting for tasks whose steps outlast the 5-minute default. OpenAI requests carry a stable per-conversation `prompt_cache_key` so sustained tool loops stay on their warm cache shard. Claude models routed through OpenRouter now receive explicit cache_control blocks. Ollama holds the model and its KV cache in memory for 30 minutes between calls. The cascade also pins the provider and model that served the previous iteration, so a mid-task turn keeps hitting the same provider's cache — hard failures still fall through to the next provider as before.

### Outbound Context Truncation

The request sent to the provider is now a shaped copy of the conversation, not a verbatim dump. Older page reads that have been superseded by a newer read of the same browser session, byte-identical duplicate tool results, and stale screenshots collapse into short self-describing stubs — each stub names what it was, how large it was, and how to fetch it again. The newest page state, the newest screenshot, and every failed result always remain full, and internal conversation history, episodes, and task transcripts keep complete fidelity on disk — truncation exists only on the wire.

On a 184-iteration mission with 53 page reads, the context plateaued at ~130k tokens where it previously would have grown past 350k, with zero measurable overhead in uncached input and no change in task quality. Both behaviors ship enabled and can be disabled in config via `contextOptimization.enabled` and `contextOptimization.truncation`.

### Smarter Compaction Trigger

Context compaction now calibrates against the provider's actual reported token counts (including cache reads) instead of a worst-case character heuristic that overestimated real usage by ~2.5×. Previously this could fire compaction at 39% of the real window — one observed run stalled 45 seconds mid-task truncating a conversation that comfortably fit. Compaction is now reserved for genuine context pressure, and with outbound truncation keeping long tasks flat, it rarely needs to fire at all.

### Task Loop Reliability

Fixed a failure mode where the agent abandoned a long mission halfway: at a frustrating moment it would write a progress summary and plan to "continue in the next turn" — but ending a response without tool calls ends the task, so the mission silently died. The loop-awareness instructions, the batch-completion rule, and the new runtime telemetry line all now state the actual mechanic: there is no next turn; if the task is unfinished, keep calling tools; end with prose only when the work is complete or genuinely blocked. Long multi-phase missions now run to completion — verified on 80- and 184-iteration browser tasks that previously stalled.

### Per-Task Usage Summary

Every turn now emits a single roll-up event with iterations, tool calls, input/output tokens, cache hit rate, and cost — so a 200-iteration task leaves one line that says whether caching actually worked, alongside the existing per-call records.

### Extension — Generic Wait & Text Selectors

Two gaps observed in real runs, where the model reached for capabilities that didn't exist:

- **`ext_wait`** — a generic wait tool: sleeps for a duration, or waits for a CSS selector, navigation, or network idle, accepting the argument shapes models naturally produce. Previously the model guessed this name (mirroring the playwright capability's `browser_wait`) and lost a step to "unknown tool".
- **`text=` selectors** — `ext_click`, `ext_wait_for`, and every other selector-taking command now accept Playwright-style `text=<visible text>` selectors, resolving to the deepest visible element whose text matches. Invalid CSS selectors now fail instantly with a clear message instead of burning three retries on a syntax error that could never succeed.

---

## v1.0.129 — 2026-06-09

### Context Compaction Redesign

The context compaction system has been rebuilt from the ground up. The previous approach made one LLM call per message being compacted — a 9-target run required 9 separate API calls batched 7 at a time, taking roughly 6 minutes. The new system uses instant proportional truncation plus a single LLM summary call. Compaction that previously took 6 minutes now completes in under 30 seconds.

**How it works:** when the conversation reaches 75% of the model's context window (previously 100%), the compactor selects targets across all message types — tool results, assistant messages, and user messages — and truncates them in-place, keeping a generous head (15% of original, up to 6,000 chars) and tail (8% of original, up to 3,000 chars) with a clear label showing the original size and how much was omitted. It then makes one LLM call on the saved original content to produce a structured conversation summary covering the task, progress, remaining work, key data values, and decisions made. The summary and a continuation nudge are injected as a single message so the model knows exactly where it left off.

This fixes a critical reliability bug: after compaction, the model would sometimes treat the shorter context as "done" and skip remaining work in a multi-step task — for example, reading 30 of 43 emails and then producing a final summary, silently dropping the last 13. The new continuation nudge explicitly lists what has been completed and what remains, and instructs the model not to produce final output until all steps are complete.

**Protection rules:** the first user message (the original task prompt) and the 3 most recent messages per role are never compacted. Error tool results and messages under 500 characters are also skipped. Previously compacted summaries are not protected, allowing recursive compression across multiple compaction passes. Images are stripped from all tool results before anything else to reclaim space immediately.

**Fallback:** if the summary LLM call fails after 5 retries with escalating backoff (1s → 2s → 4s → 8s → 16s), the truncated versions remain in place and a fallback nudge is injected that tells the model to reconstruct context from the truncated head and tail excerpts.

### Planning Skill

A new built-in skill injects planning instructions into the system prompt on every turn. Before executing any multi-step task, the agent must state its understanding, lay out 2–5 phases with concrete verification criteria, and confirm each definition of done after execution. Single-step tasks skip planning automatically. The skill is implemented as a pure procedure (no tools) using the cerebellum's new wildcard trigger (`*`), which always injects regardless of keyword matching.

### Batch Completion Enforcement

A new runtime instruction ensures the agent completes every item in a batch operation. When a task requires calling a tool for each item in a set (e.g. reading N emails, fetching N pages), the agent must call the tool for every item before producing final output, batching 10–15 calls per response. This prevents the model from summarizing after a partial run and works alongside the compaction redesign to ensure long-running tasks finish reliably.

### Multi-Turn Tool History

Channel conversations (Telegram, WhatsApp) now reconstruct the full tool-call history from stored segments when building context for a new turn. Previously, assistant messages in follow-up turns included only the final text output — the model couldn't see which tools it had called or what they returned in earlier turns. The new `assistantSegmentsToHistory` function walks the stored segments and emits properly structured assistant messages with `toolUses` arrays and matching tool-result messages, preserving the complete interaction history.

### Provider Error Cards

The error detail view for provider failures now always shows structured diagnostic information — provider name, HTTP status, error reason, retry count, and duration — regardless of whether the API returned a detail string. Previously, the "View details" link only appeared when the raw API response included an error body, leaving users with no diagnostics on connection timeouts or empty failures.

### Conversation Timeline

Conversations now track a timeline of key events — tool calls, tool results, compaction passes, model switches, and provider changes. Timeline entries are persisted in the conversation file and restored when reopening a chat. The `ChatHistoryMessage` type has been extended to include tool-role messages with `toolUseId`, `toolName`, and `isError` fields, enabling full round-trip tool state.

### Tool Transcript Detail Logs

The motor now writes a separate `-detail.log` file alongside each tool transcript. The main transcript previews tool output (first 2,000 chars with a truncation notice), while the detail log captures the complete raw output for debugging. Neither file is indexed by the cortex or included in model context.

### Provider Failure Tracking

Wernicke now surfaces per-provider failure details when a stream errors mid-response, not just when all providers are exhausted. The new `providerFailures` field on `ParsedResponse` carries the same structured failure info (status code, error class, retry count, duration) that was previously only available in the `no_provider_available` path.

---

## v1.0.126 — 2026-06-08

### Extension — Screenshot & Download Management

Screenshots and downloads are now organized per conversation. Screenshots save to `workspace/screenshots/conv-{id}/` with timestamped filenames, and each screenshot result includes viewport coordinate ranges so the agent can reason about click targets more accurately. PDF downloads now save to `workspace/downloads/conv-{id}/` (previously `workspace/files/`) and return structured JSON with path and size instead of a plain string.

### Automatic Title Generation

Conversation titles are now generated automatically in the main process. When a conversation is saved as "Untitled" with user messages, a title is derived from the first message — stripped of Markdown headings, bold/italic markup, links, and list prefixes. Titles propagate in real time through the agent pipeline to the browser extension side panel, so you always see an up-to-date title without switching back to the desktop app.

### Extension — Debugger & Mouse Commands

Five new browser commands: `browser_debugger_attach`, `browser_debugger_detach`, `browser_debugger_status`, `browser_mouse_move`, and `browser_humanize`. The agent can now attach Chrome DevTools Protocol debugging sessions and perform precise mouse movements on the page. All events appear in the extension activity log with human-readable labels.

### Extension — Reliable Link Clicks

CDP-simulated clicks now detect anchor elements and perform a follow-up real `.click()` after the synthetic mouse events, ensuring link navigation fires reliably on pages where simulated input alone was not enough.

### Extension v0.1.46

Extension updated from v0.1.39 to v0.1.46 with rebuilt side panel and background scripts.

---

## v1.0.107 — 2026-06-05

### Browser Extension

Wolffish now ships with a browser extension. Install it in Chrome and it opens a side panel that connects directly to your running Wolffish instance — same agent, same capabilities, same conversation history, but accessible from any tab without switching to the desktop app. The extension has full permissions for tabs, scripting, cookies, clipboard, downloads, and navigation, so the agent can read and interact with the page you're looking at.

### New Cloud Providers: xAI, Qwen & Stepfun

Three new cloud providers join Anthropic, OpenAI, DeepSeek, Kimi, and MiniMax. Each one streams responses, supports tool calling, and tracks token usage (including cache reads where the API reports them).

- **xAI** — Grok 4, Grok Build, and Grok 3 models via `api.x.ai`. Reasoning models (Grok 4, Grok Build, Grok 3 Mini) support reasoning effort control.
- **Qwen** — Qwen 3.7, 3.6, 3.5, and legacy Qwen models via Alibaba's DashScope API. Qwen3+ and QwQ models support thinking budgets with configurable depth.
- **Stepfun** — Step 3, Step 2, and Step 1 models via `api.stepfun.ai`. Step 3 models always reason; reasoning tokens count toward the completion budget.

Add your API key in Settings and pick a model — everything else works the same as existing providers.

### Thinking Modes

A new mode selector in the chat input lets you control how much the model reasons before responding. The selector appears automatically when the active model supports it, and hides when it doesn't. Three levels are available:

- **None** — no reasoning, fastest responses
- **High** — moderate reasoning depth
- **Max** — maximum reasoning budget

Each provider maps these modes to its own API parameter: Anthropic uses extended thinking budgets, OpenAI uses reasoning effort, Qwen uses thinking budgets, xAI uses reasoning effort, and Mimo uses thinking mode flags. Models that don't support reasoning (older Qwen, base Grok 3) skip the selector entirely.

---

## v1.0.105 — 2026-06-01

### Available Models Scanner

Wolffish now scans your Ollama models folder on startup and shows every downloaded model in a new "Available" tab on the model picker. Pick any model already on disk and start chatting instantly — no re-download needed. The scanner reads Ollama's manifest files directly, so it works even if Ollama isn't running yet.

### Models Folder Picker

A new card above the model tabs displays the folder being scanned, with a copy-to-clipboard button and a "Choose folder" option to point Wolffish at a custom Ollama models directory.

### Model Details

Available model cards now show family, parameter size, quantization level, and format when Ollama can provide that information.
