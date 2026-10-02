---
name: introspect
description: Check Wolffish's own status, performance, and memory
triggers:
  - status
  - health
  - performance
  - how are you
  - what do you know
  - what do you remember
  - uptime
  - stats
  - memory usage
  - how many
  - diagnostics
  - system info
  - capabilities
  - loaded
  - active
  - running
  - wolffish
  - self
  - about
  - version
  - provider
  - model
  - configuration
  - settings
  - error rate
  - success rate
  - tool usage
  - what can you do
  - what tools
  - how many tools
  - how many capabilities
  - list capabilities
  - list tools
  - available tools
  - enabled
  - disabled
  - plugin
  - installed
  - which model
  - which provider
  - current model
  - current provider
  - api key
  - token count
  - context window
  - latency
  - response time
  - are you working
  - are you ok
  - are you alive
  - check yourself
  - self test
  - debug mode
  - verbose
  - log level
  - tell me about yourself
  - who are you
  - what are you
  - recall
  - remember when
  - what did we
  - what did i
  - what did you
  - last time
  - earlier
  - yesterday
  - previously
  - look up
  - search memory
  - find in memory
  - dig up
  - list files
  - what files
  - which files
  - show files
  - files exist
  - what's on disk
  - workspace files
  - find file
  - locate file
tools:
  - name: wolffish_status
    readOnly: true
    description: Get current Wolffish status including uptime, active provider, loaded capabilities, and system health
    parameters: {}
  - name: channel_status
    readOnly: true
    description: Check whether each chat channel (Telegram, WhatsApp, in-app) is currently connected, with reconnect steps for any that are down
    parameters: {}
  - name: wolffish_performance
    readOnly: true
    description: Get performance stats including task success rates, most used tools, and error rates
    parameters: {}
  - name: wolffish_memory
    readOnly: true
    description: Get a summary of what Wolffish remembers — recent conversation topics and knowledge areas
    parameters:
      days:
        type: number
        required: false
        description: Number of days to look back (default 7)
  - name: wolffish_recall
    readOnly: true
    description: Precisely retrieve something from your own memory that is NOT in your current context — what you did on a date, the steps of a past task, an earlier conversation, a learned fact, or a past tool outcome. Search by keyword and/or date. Use this instead of guessing or saying you don't remember.
    parameters:
      query:
        type: string
        required: false
        description: Keywords to search for (case-insensitive). Optional if date is given.
      date:
        type: string
        required: false
        description: Pin results to a single day, format YYYY-MM-DD. Optional.
      source:
        type: string
        required: false
        enum: [episodes, tasks, feedback, knowledge, conversations, all]
        description: 'Where to look: episodes, tasks, feedback, knowledge, conversations, or all (default).'
      limit:
        type: number
        required: false
        description: Max matches to return (default 8, max 30)
  - name: memory_search
    readOnly: true
    description: 'Ranked full-text search across EVERYTHING you know: past conversations (including tool calls and outputs), episodes, long-term knowledge, weekly digests, task runs, tool-outcome feedback, usage/cost records, event logs, and generated files. Returns snippets with refs — follow up with memory_get or conversation_read for full content. Try 2-3 different phrasings before concluding something was never recorded.'
    parameters:
      query:
        type: string
        required: true
        description: Keywords to search (exact-word matching, OR-combined)
      sources:
        type: string
        required: false
        description: 'Optional comma-separated subset of: episode, knowledge, consolidated, conversation, task, feedback, usage, corpus, log, artifact, doc. Default: all.'
      after:
        type: string
        required: false
        description: Only records from this day on (YYYY-MM-DD)
      before:
        type: string
        required: false
        description: Only records up to this day (YYYY-MM-DD)
      limit:
        type: number
        required: false
        description: Max hits (default 15, max 50)
  - name: memory_get
    readOnly: true
    description: 'Fetch the FULL content behind a memory_search ref: a whole episode day, a knowledge file, a task transcript with its detail log, or all records of a conversation. file: refs return the actual file; conversation:/task: refs return the stored records in order.'
    parameters:
      ref:
        type: string
        required: true
        description: 'A ref from memory_search, e.g. "conversation:<id>#3", "task:<id>", "file:brain/hippocampus/episodes/2026-07-01.md"'
      limit:
        type: number
        required: false
        description: Max records for prefix refs (default 50)
  - name: conversation_list
    readOnly: true
    description: 'Enumerate your past conversations, newest first: id, channel (electron/telegram/whatsapp/heartbeat/procedure), title, message count, last-updated. Optionally rank by a content query. Use when the user refers to a past chat you cannot see.'
    parameters:
      channel:
        type: string
        required: false
        description: Filter to one channel
      query:
        type: string
        required: false
        description: Rank conversations by content matches for these keywords
      after:
        type: string
        required: false
        description: Only conversations updated on/after this day (YYYY-MM-DD)
      before:
        type: string
        required: false
        description: Only conversations updated on/before this day (YYYY-MM-DD)
      limit:
        type: number
        required: false
        description: Max conversations (default 20, max 100)
  - name: conversation_read
    readOnly: true
    description: 'Read a specific past conversation — messages and the tool calls/results inside it — with pagination. Recovers turns of the CURRENT conversation summarized out of your context. Returns excerpts; detail: full raises the caps, and memory_get on the printed file ref returns the complete untruncated bytes.'
    parameters:
      id:
        type: string
        required: true
        description: Conversation id (a unique suffix is enough) from conversation_list or a conversation ref
      from:
        type: number
        required: false
        description: 'First message index to show (default: last 15 messages)'
      to:
        type: number
        required: false
        description: Last message index to show
      what:
        type: string
        required: false
        enum: [messages, tools, all]
        description: messages = text only; tools = tool calls/results only; all (default)
      detail:
        type: string
        required: false
        enum: [brief, full]
        description: brief (default) or full — full raises per-item excerpt caps
  - name: memory_save
    description: 'Durably save one self-contained fact to your long-term knowledge (deduplicated) — the quick note you can take from anywhere, no discovery hop. Use for preferences, decisions, project facts, or people details worth remembering across conversations, not for transient task state. Pass `topic` whenever you know the subject it belongs to. This tool only ADDS: to correct a fact you already saved, or to forget one that is no longer true, use the `knowledge` capability (knowledge_edit / knowledge_forget).'
    parameters:
      fact:
        type: string
        required: true
        description: One durable, self-contained sentence
      type:
        type: string
        required: false
        enum: [projects, people, preferences, technical, decisions]
        description: Which knowledge file it belongs in (default technical)
      topic:
        type: string
        required: false
        description: 'Subject this fact is about — the person, project or area it belongs under. Created if new. Strongly preferred: an unattributed fact waits for the nightly curator to be filed.'
  - name: usage_report
    readOnly: true
    description: 'Your own LLM spend from the usage ledger: requests, tokens (in/out/cache), and cost, total and per model, for a period.'
    parameters:
      period:
        type: string
        required: false
        enum: [today, yesterday, week, month, all]
        description: Shortcut range (default today)
      after:
        type: string
        required: false
        description: Explicit start day YYYY-MM-DD (overrides period)
      before:
        type: string
        required: false
        description: Explicit end day YYYY-MM-DD
  - name: wolffish_list_files
    readOnly: true
    description: List files inside the Wolffish workspace ONLY (~/.wolffish/workspace — your memory, generated files, capabilities, logs) as a structured tree with sizes. This is NOT a general file browser; it refuses paths outside the workspace. For the user's own files anywhere else (Desktop, Documents, projects, any absolute path), use the filesystem tools or shell instead.
    parameters:
      dir:
        type: string
        required: false
        description: Subdirectory relative to the workspace root (e.g. 'files'). Defaults to the workspace root.
      depth:
        type: number
        required: false
        description: How many levels deep to descend (default 2, max 5)
      pattern:
        type: string
        required: false
        description: Only include files whose name contains this substring (case-insensitive)
---

# Introspection

## When to use

- When the user asks about Wolffish's status, health, or capabilities
- When the user asks what Wolffish remembers or knows
- When the user asks about performance or task history
- When the user asks "how are you" in a way that expects real data, not pleasantries

## Tools

- `memory_search` — THE primary retrieval tool: ranked full-text search across
  everything you know (conversations incl. tool outputs, episodes, knowledge,
  digests, tasks, feedback, usage, logs, generated files). Returns refs.
- `memory_get` — full content behind a ref (whole episode, task transcript,
  knowledge file, conversation records).
- `conversation_list` / `conversation_read` — enumerate past conversations and
  read one verbatim (messages + tool activity, paginated). conversation_read
  also recovers turns of the CURRENT conversation that were summarized away.
- `memory_save` — durably save a fact to long-term knowledge (deduplicated).
  Append-only. To **correct or forget** a fact — or to amend your playbook,
  standing instructions, or identity — reach for the `knowledge` capability
  (`knowledge_read` / `knowledge_edit` / `knowledge_forget`).
- `usage_report` — your own LLM spend (requests, tokens, cost, per model).
- `wolffish_recall` — stable alias over the same index (query/date/source);
  memory_search offers richer filters.
- `wolffish_status` — uptime, provider, capabilities, RAM, disk, index size
- `wolffish_performance` — task counts, success rate, most used / denied tools
- `wolffish_memory` — episode topics, knowledge file coverage, feedback counts
- `wolffish_list_files` — structured tree of **your own workspace** files
  (`~/.wolffish/workspace`) with sizes. Workspace-only — not a general file
  browser (see Rules).

## Recall vs. summary

Your context window carries a **lean working set**, not your whole history —
everything you have ever done, said, produced, or spent lives on disk, indexed,
one tool call away:

- "Send me the flight plan" → `memory_search` `query: "flight plan"` → follow
  the ref with `conversation_read` or `memory_get`.
- "What did Sana say on WhatsApp?" → `memory_search` — inbound channel
  messages are indexed too (whatsapp read-history).
- "What did we do on the 18th?" → `wolffish_recall` with `date: "2026-06-18"`.
- "Did that World Cup task finish?" → `memory_search` `query: "world cup"`,
  `sources: "task"`.
- "What's the file you made yesterday?" → `memory_search` `sources: "artifact"`
  or `wolffish_list_files` with `dir: "files"`.
- "What did today cost?" → `usage_report`.
- "What was the confirmation number I gave you earlier?" (long conversation) →
  `conversation_read` on the current conversation.

Reach for `memory_search` the moment you're about to say "I don't remember" or
guess — and search 2-3 different phrasings before concluding it was never
recorded. A miss is not evidence of absence.

## Rules

- These tools are read-only — they never modify the workspace.
- Prefer the tool over guessing. The numbers come from real files on disk.
- If the user only asked a casual "how are you?", a friendly answer is fine
  too — only call the tool when they want real data.
- **`wolffish_list_files` lists ONLY the Wolffish workspace** (your own memory,
  generated files, logs, capabilities). It is not a general file browser and
  refuses paths outside the workspace. For the user's files anywhere else —
  Desktop, Documents, a project folder, an attachment path, any absolute path —
  use the filesystem tools (`file_read`, etc.) or `shell_exec` (`ls`/`find`)
  instead.
