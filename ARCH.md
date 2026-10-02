# Wolffish Architecture

Wolffish is a personal AI desktop app built around a 15-module brain. This
document explains how the human brain works, how Wolffish maps each
region to a runtime module, and why I believe this architecture will
produce personal agents that genuinely grow with their users.

It has three sections:

1. **The Human Brain** — how the biology works.
2. **How Wolffish Implements the Brain** — how each module mirrors a
   region.
3. **Why This Architecture Will Produce Great Personal Agents** — what
   I'm betting on.

---

## 1. The Human Brain

Most of what makes the brain remarkable isn't any single region — it's
the way they specialize and cooperate. Evolution didn't design the brain
top-down; each region appeared because it solved a specific survival
problem, and the regions stuck around because the cooperation worked.
Understanding which region does what makes it much easier to understand
how thinking happens at all.

Here's the rough flow when a signal enters your head.

A sound reaches your ear or a sentence lands in your inbox, and the
signal is routed by the **thalamus**. The thalamus is the brain's
sensory gateway. It sits on top of the brainstem and relays almost every
incoming signal — sight, sound, touch, taste, pretty much everything
except smell — up to the rest of the cortex. Nothing makes it to
conscious processing without being routed by the thalamus first. It also
does triage: it tags the signal so downstream regions can decide how
much of their time it deserves.

Before the signal reaches the part of the brain that "thinks" about it,
the **reticular activating system** — the RAS — filters out the noise.
Your skin is being touched in a hundred places right now and you don't
notice any of them; the RAS made that decision. It controls arousal and
attention, gating which signals are loud enough to deserve cognitive
work. Without it, the cortex would be drowning in irrelevant input.

The signal that survives reaches the **prefrontal cortex** — the part
of you that plans. The prefrontal cortex is the front of the frontal
lobes, and it's the part of the brain that takes the longest to mature
(it isn't fully wired until your mid-twenties) and the first to decline
in dementia. It holds working memory, weighs trade-offs, suppresses the
impulse to do the dumb thing, and assembles a plan before you act on it.
When you stop yourself from sending an angry email, that's the
prefrontal cortex.

To plan, the prefrontal needs context, and that context comes from the
**cerebral cortex**'s associative regions. The cortex is the wrinkled
outer sheet of the brain, the part you'd recognize from any neuroscience
textbook. It does pattern matching at speed: when you hear a few notes
of a song you know, the cortex finishes the rest before you've thought
about it. It doesn't store the original sensory experience verbatim; it
stores compressed, queryable representations that can be regenerated
when you need them.

Some of those representations come from the **hippocampus**. The
hippocampus is a seahorse-shaped structure deep in the temporal lobe,
and it does memory in three stages. First, it captures _episodes_ — the
day-by-day stream of what happened. Then, mostly during sleep, it
_consolidates_ episodes into something more durable: the gist of the
week, the threads that mattered, the patterns. Finally, the most
important threads get _integrated_ into long-term knowledge — what you
know about your friends, your work, yourself. Damage the hippocampus
and you can still remember the past, but you can't form anything new.
This is what happened to the famous Patient H.M., and it's why the
three-stage architecture is so well understood: when one stage is
broken, the failure mode is unmistakable.

Skills don't live in the hippocampus. They live in the **cerebellum** —
the dense knot at the back of the brain. The cerebellum stores learned
procedures: riding a bike, signing your name, the perfectly-cadenced
apology you've given a hundred times. You don't think about how to do
any of those things; the cerebellum just runs them. This is why
practice changes you: you're slowly compiling deliberate, prefrontal
effort into automatic cerebellar routines.

When the prefrontal has decided what to do, the **motor cortex**
executes. The motor cortex is the strip along the back of the frontal
lobe that fires the muscles. The premotor area plans the movement, the
primary motor cortex actually triggers it, and the cerebellum smooths
it all out so your hand reaches the cup instead of knocking it over.
Without the motor cortex, intention has nowhere to go.

But before any action runs, the **amygdala** can stop it. The amygdala
is two almond-shaped clusters in the temporal lobes, and it handles
threat detection. It fires before conscious thought catches up: you
flinch from the snake, then you realize it's a stick. It can override
anything the cortex was about to do. This is a feature, not a bug —
some decisions are too important to wait on the slow deliberative
process.

Meanwhile, the **basal ganglia** is silently learning. The basal ganglia
is a cluster of nuclei deep in the brain that handles reward processing
and habit formation. Every time you take an action, the basal ganglia
compares the result to the prediction and nudges future behavior toward
what worked. This is why the second time you do something is easier
than the first, and the hundredth time is automatic. Reward, error
signal, slight reweighting, repeat — that's how growth happens.

Underneath all of this, the **brainstem** keeps you alive without
asking permission. The brainstem is the stalk that connects the brain
to the spinal cord, and it runs heart rate, breathing, blood pressure,
the sleep-wake cycle. You don't have to think about any of it. If the
brainstem stops, you stop.

Connecting it all is the **corpus callosum** — the thick band of fibers
that links the two hemispheres of the brain. It carries signals between
regions so perception, memory, planning, and motor control act in
concert without any region needing to know the others' internals. When
the corpus callosum is severed (the "split-brain" surgery sometimes
done for severe epilepsy), the two halves of the brain start operating
independently in eerie ways. The connection matters.

And quietly regulating the system is the **hypothalamus** — the brain's
homeostasis controller. It watches body temperature, hunger, thirst,
blood pressure, sleep pressure, and a dozen other variables, and
triggers corrective behavior the moment one drifts. You don't decide to
sweat; the hypothalamus decides for you. It keeps everything else in
the brain operating inside the range where it can do its job.

When it comes time to talk, two regions handle language. **Wernicke's
area**, in the left temporal lobe, comprehends incoming language —
parses it, decodes it, makes sense of it. Damage Wernicke's area and
you produce fluent but meaningless speech (Wernicke's aphasia): the
words come out, but you can't decode anyone else's. **Broca's area**,
in the left frontal lobe, produces outgoing language. Patients with
Broca's aphasia understand language fine, but struggle to produce it:
they know what they want to say, but the words come out halting and
broken. Comprehension and production are split because they're
different problems with different solutions.

Finally, the **insular cortex** — the insula — gives you self-awareness.
It's the region behind interoception: the felt sense of what's
happening inside the body. It's how you know you're tired, anxious,
or full without anyone telling you. It also underwrites metacognition:
noticing that you noticed something. Without the insula, you'd be a
process that runs without ever feeling like a self.

Fifteen regions. Each one with a clear job. Each one capable of
overriding or amplifying the others. The brain isn't one thing
thinking; it's a coalition.

---

## 2. How Wolffish Implements the Brain

Wolffish maps each of those fifteen regions to a runtime module under
`src/main/runtime/`. Each module is a TypeScript class with a clear
interface and a single responsibility. Every brain region in section 1
has a counterpart here.

The workspace lives at `~/.wolffish/workspace` and is the source of
truth for everything the agent knows. The agent reads markdown at
runtime instead of having logic baked into code. The cortex's SQLite
index is _derived_ from the markdown; if you delete it, it rebuilds
itself.

### thalamus.ts — sensory gateway

**Region:** Thalamus. **Job:** classify incoming messages and route LLM
calls through the provider cascade (Claude → OpenAI → Local Ollama).
**Reads/writes:** none directly — it talks to the providers in
`src/main/runtime/providers/`. **Interfaces:** `route()`, `classify()`,
`getActiveProvider()`, `healthCheck()`, plus the existing `streamChat()`
and `cascade()`. **Bus:** emits `input.received`, `input.classified`,
`input.routed`, `llm.error`.

### prefrontal.ts — executive function

**Region:** Prefrontal cortex. **Job:** read the workspace markdown
(soul, user, agents, tools, recent episodes) and assemble the system
prompt. Manage the context budget. Decide on an approach: direct
answer, tool use, multi-step task, or clarifying question.
**Reads:** `identity/soul.md`, `identity/user.md`,
`prefrontal/agents.md`, `prefrontal/tools.md`,
`hippocampus/episodes/*.md`. **Interfaces:** `buildContext()`,
`buildSystemPrompt()`, `plan()`, `getTokenBudget()`. **Bus:** emits
`context.built`, `context.trimmed`.

### ras.ts — attention filter

**Region:** Reticular activating system. **Job:** score the relevance of
candidate context fragments against the current message and allocate
the available token budget across categories (memory, skills,
knowledge, history, system). When the budget is tight, low-scoring
fragments get dropped before they hit the LLM. **Reads/writes:** none
— pure heuristic. **Interfaces:** `scoreRelevance()`,
`filterContext()`, `allocateBudget()`. **Bus:** consumes
`resource.low.context` to filter more aggressively.

### cortex.ts — fast retrieval index

**Region:** Cerebral cortex. **Job:** maintain `cortex.db` (SQLite +
FTS5) as a fast full-text index over every markdown file in the
workspace. **Reads:** every `.md` file in the workspace. **Writes:**
`cortex.db`. **Interfaces:** `search()`, `index()`, `reindex()`,
`rebuildFromMarkdown()`. **Bus:** consumes `watcher.changed` from the
brainstem; emits `cortex.reindexed`.

### hippocampus.ts — memory

**Region:** Hippocampus. **Job:** the three-stage memory system.
**Reads/writes:** `hippocampus/episodes/YYYY-MM-DD.md`,
`hippocampus/consolidated/YYYY-WNN.md`,
`hippocampus/knowledge/{projects,people,preferences,technical,decisions}.md`.
**Interfaces:** `appendEpisode()`, `getRecentEpisodes()`,
`searchMemory()`, `consolidate()`, `promoteToKnowledge()`. **Bus:**
emits `memory.saved`, `memory.consolidated`, `memory.promoted`.

### cerebellum.ts — skills + plugins

**Region:** Cerebellum. **Job:** load capabilities from
`cerebellum/<name>/`. Each capability folder has a `SKILL.md` (YAML
frontmatter + markdown body) and an optional `plugin/index.mjs` that
exports executable tools. Parse the frontmatter for triggers, tool
schemas, and danger/confirm patterns. Match incoming messages to
relevant skills.
**Reads:** `cerebellum/<capability>/**`.
**Interfaces:** `loadAll()`, `findRelevantSkills()`, `getPluginTools()`,
`registerPlugin()`. **Bus:** emits `skill.matched`, `plugin.loaded`,
`plugin.unloaded`.

### wernicke.ts — comprehend LLM output

**Region:** Wernicke's area. **Job:** parse the LLM's raw token stream
into structured output: final answer text, optional reasoning blocks,
tool calls. **Reads/writes:** none — pure parser. **Interfaces:**
`parse()`, `extractToolCalls()`, `extractThinking()`. **Bus:** emits
`tool.parsed`.

### broca.ts — produce response

**Region:** Broca's area. **Job:** assemble the final user-visible
response from parsed model output and tool results. Format tool results
into human-readable blocks. Stream tokens to the renderer.
**Reads/writes:** none — pure composition. **Interfaces:**
`assembleResponse()`, `formatToolResult()`, `streamToUI()`. **Bus:**
emits `llm.token` as it streams.

### amygdala.ts — safety gate

**Region:** Amygdala. **Job:** classify every tool call as safe, warn,
destructive, or block. Pattern-match dangerous commands (`rm -rf`,
`mkfs`, `curl | sh`, `DROP TABLE`, …). Request user approval for
dangerous operations via IPC to the renderer. Halt the pipeline on a
hard block. **Reads/writes:** none directly — talks to the renderer for
approvals. **Interfaces:** `classify()`, `requestApproval()`,
`isDangerous()`, `block()`. **Bus:** emits `safety.warned`,
`safety.blocked`, `safety.approved`, `safety.denied`.

### motor.ts — execute tasks

**Region:** Motor cortex. **Job:** create task files in
`motor/tasks/TASK-{id}.md`, execute tool calls through plugins, log
every step result to the markdown transcript in real time, retry
failed steps up to three times with exponential backoff, and abort on
signal. **Reads/writes:** `motor/tasks/TASK-*.md`. **Interfaces:**
`createTask()`, `executeTask()`, `stopTask()`, `getTaskState()`,
`listTasks()`. **Bus:** emits `task.created`, `task.started`,
`task.step.succeeded`, `task.step.failed`, `task.completed`,
`task.failed`, `task.stopped`.

### basalganglia.ts — learn from outcomes

**Region:** Basal ganglia. **Job:** track outcomes — what succeeded,
what failed, what the user approved, what the user rejected. Score
approaches across many runs. Provide learned preferences to the
prefrontal when building context. **Reads/writes:**
`basalganglia/feedback.md`. **Interfaces:** `recordOutcome()`,
`getPreferences()`, `scoreApproach()`, `getFeedbackSummary()`. **Bus:**
consumes `task.completed`, `task.failed`, `safety.approved`,
`safety.denied`; emits `outcome.recorded`, `preference.learned`.

### hypothalamus.ts — system health

**Region:** Hypothalamus. **Job:** monitor the agent's vital signs —
context window usage, token costs, disk space, RAM, model availability
— and broadcast state changes when something is out of range.
**Reads/writes:** none — samples runtime. **Interfaces:** `monitor()`,
`getHealth()`, `broadcastState()`, `getResourceUsage()`. **Bus:** emits
`health.ok`, `health.warning`, `health.critical`,
`resource.low.context`, `resource.low.memory`, `resource.low.disk`.

### brainstem.ts — background processes

**Region:** Brainstem. **Job:** parse cron-like schedules from
`brainstem/heartbeat.md` and run them. Watch the workspace with one
recursive `fs.watch` and notify the cortex when files change. Schedule
nightly memory consolidation. **Reads:** `brainstem/heartbeat.md`.
**Watches:** every file under the workspace. **Interfaces:**
`startScheduler()`, `startWatcher()`, `stopAll()`, `getActiveJobs()`.
**Bus:** emits `scheduler.tick`, `watcher.changed`.

### corpus.ts — event bus

**Region:** Corpus callosum. **Job:** typed pub/sub event bus that
every other module uses to communicate. No module imports another
module's class to call it directly. **Reads/writes:** none — in-memory.
**Interfaces:** `emit()`, `on()`, `off()`, `listEvents()`. The full
`CorpusEvent` enum is defined in `corpus.ts` and grows as new event
types are needed.

### insula.ts — self-awareness

**Region:** Insular cortex. **Job:** read from motor (task history),
basal ganglia (preferences), hippocampus (recent episodes), and
hypothalamus (current health) to answer questions like "what have I
been doing?", "what do I know about myself?", "how am I doing?". When
the LLM needs to introspect, it queries the insula. **Reads:**
`motor/tasks/`, `basalganglia/feedback.md`, `hippocampus/episodes/`.
**Interfaces:** `getStatus()`, `getPerformanceReport()`,
`getConversationSummary()`, `reflect()`. **Bus:** consumes everything
relevant for its summaries.

### The pipeline

The agent loop in `src/main/runtime/agent.ts` runs every turn through
the same gates, in the same order:

```
1.  thalamus     → classify + route input
2.  ras          → filter relevant context
3.  prefrontal   → build context + plan approach
4.  cortex       → search index for relevant memories
5.  hippocampus  → load recent episodes + knowledge
6.  cerebellum   → load matching skills
7.  [LLM CALL]   → send assembled context to model
8.  wernicke     → parse response, extract tool calls
9.  amygdala     → safety check each tool call
10. motor        → execute approved tool calls
11. broca        → assemble final response
12. hippocampus  → save conversation to episode
13. basalganglia → record outcome
14. corpus       → emit events throughout
15. hypothalamus → monitor health throughout
16. brainstem    → background processes (independent)
17. insula       → available on-demand for introspection
```

### A worked example

The user types: **"Create a git commit for my current changes."**

1. **thalamus** classifies the input — kind: command, language: en,
   urgency: normal, complexity: low — and selects the active provider
   (Claude if there's a key, otherwise Ollama).
2. **ras** scores the candidate context fragments against the message.
   Skills tagged `git`, `commit`, or `version-control` score high.
   Knowledge files about decisions and preferences score moderately.
3. **prefrontal** assembles the system prompt: soul, user file, agent
   procedures, tool descriptors, and the top-scoring fragments from
   step 2.
4. **cortex** runs an FTS5 search for "git commit" against the
   workspace and surfaces any past episodes where the user discussed
   commit conventions.
5. **hippocampus** loads the last three days of episodes and the
   `preferences.md` knowledge file (where the user's
   "Conventional Commits" preference lives).
6. **cerebellum** matches the message against loaded skills, finds
   `git-commit.md`, and folds its procedure into the prompt.
7. The assembled prompt goes to the LLM. It returns a response that
   includes a tool call: `bash({command: "git status"})`.
8. **wernicke** parses the response, extracts the tool call, and
   separates it from the surrounding prose.
9. **amygdala** classifies `git status` as safe — it matches no danger
   patterns. The pipeline continues.
10. **motor** creates `motor/tasks/TASK-2026-04-26-1234.md`, runs
    `git status`, logs the output. The model takes another turn,
    proposes `git add .` and a `git commit -m "..."`. **amygdala**
    classifies `git add .` as safe and the `git commit` as safe; both
    execute. Motor logs each step.
11. **broca** assembles the final response: the model's prose plus the
    formatted tool results, streamed to the UI.
12. **hippocampus** appends a one-line entry to today's episode:
    "2026-04-26 14:32 — created commit abc1234 for current changes."
13. **basalganglia** records the outcome. The user accepted the commit
    message without edits, so the "Conventional Commits" approach gets
    one more positive data point.
14. **corpus** has emitted events at each stage: `input.classified`,
    `context.built`, `tool.parsed`, `safety.approved`, `task.created`,
    `task.completed`, `memory.saved`, `outcome.recorded`.
15. **hypothalamus** has been sampling the whole time. Context budget
    was fine, no warnings raised.
16. **brainstem** is unaffected — it'll run its nightly consolidation
    at 23:00 regardless.
17. **insula** is available if the user follows up with "what did you
    just do?" — it'll summarize from the task transcript and the new
    episode entry.

### Why markdown is the source of truth

Every fact the agent knows lives in a markdown file. You can open any
of them with any text editor. You can fix the agent's understanding by
editing a file. You can version your agent's brain with git. You can
back it up by copying a folder. There's no proprietary database, no
opaque embedding store, no vendor lock-in. The cortex's SQLite index
exists for speed, but it's derived from the markdown — if you delete
`cortex.db`, the agent rebuilds it from the source on next startup.

### Why the LLM reads markdown instructions at runtime

Most agent frameworks bake instructions into Python or TypeScript. To
change behavior, you change code. Wolffish does the opposite: the
prefrontal reads markdown and assembles a system prompt every turn. To
change behavior, you edit a file. This is the difference between an
agent you have to redeploy and one you can teach.

### The 3-tier LLM cascade

The thalamus tries providers in order: Claude → OpenAI → Local Ollama.
If Claude is down, it falls back to OpenAI. If OpenAI is down, it falls
back to Ollama. Ollama is the floor — the user always has a working
agent, even with no network and no API keys. The cloud providers are
upgrades when available, not requirements.

### Resilient task execution

Motor persists every task to `motor/tasks/TASK-{id}.md` as it runs. If
Wolffish crashes mid-task, the markdown shows exactly where it stopped.
Failed steps retry up to three times with exponential backoff. Every
task is abortable via an `AbortController`. The transcript is the
source of truth for task state — not in-memory variables.

---

## 3. Why This Architecture Will Produce Great Personal Agents

I'm Younes Alturkey, the creator of Wolffish, and this is the section
where I tell you why I'm betting my time on this approach.

The brain didn't evolve randomly. Every region in section 1 exists
because it solved a specific survival problem, and the regions stayed
because the cooperation worked. The thalamus exists because something
had to triage sensory input. The amygdala exists because some decisions
are too important to wait on the slow deliberative process. The
hippocampus exists because an animal that can't form new memories
can't learn from yesterday. Two hundred million years of evolutionary
pressure produced a working architecture. I want to copy that
architecture, because the alternative is reinventing it from scratch
and hoping I get it right.

Most AI agents today are stateless freestyle loops: a prompt, a model
call, a tool call, repeat. The behavior emerges from whatever the model
felt like producing on that pass. There's no structural commitment to
_how_ the agent works. Wolffish goes the other way. The same input
follows the same path through the same gates every time. Determinism
comes from structure, not from constraining the LLM. The model is free
to be creative inside each gate; the gates are not negotiable. That
matters because trust matters, and trust comes from predictability.

Markdown as the source of truth is a quiet superpower. The agent's
brain is human-readable, git-versionable, and editable with any text
editor. You can open your agent's memory and read it. You can fix its
knowledge by editing a file. You can fork it, share it, diff it, blame
it. There's no black box. Compare that to an embedding store — you can
query an embedding store, but you can't _read_ it the way you can read
a markdown file with your morning coffee. The barrier to understanding
your own agent should be zero.

The three-stage memory system — episodes, consolidated, knowledge —
mirrors how the brain actually prevents information overload. Without
it, you have two bad options: keep everything (and drown in noise) or
forget everything (and lose context). The brain solved this with
nightly consolidation: the day's events get compressed into the gist of
the week, and the gist of the week compresses further into long-term
knowledge. Wolffish copies the answer because the answer is good.

The basal ganglia feedback loop is what turns Wolffish from "an agent
that helps you" into "an agent that grows with you". The agent doesn't
just remember facts — it remembers what _worked_. After months of use,
Wolffish knows your preferences not because you told it (though you
can), but because it tracked outcomes. The first time you reject a
generated commit message, that's a data point. The hundredth time you
accept one in a particular style, that's a learned preference. That's
growth.

The skill system means capabilities expand through markdown files, not
code changes. Anyone can teach Wolffish a new workflow by writing a
`skill.md`. The barrier to extending your agent is knowing how to
write plain text. That's it. No SDK, no plugin marketplace, no review
process. If you can describe a procedure, you can teach it. This is
what makes Wolffish _yours_ — your skills, your conventions, your way
of working.

Running locally with Ollama means your brain never leaves your
machine. Your memories, your skills, your feedback history — all in a
folder on your disk. No cloud dependency for the core experience.
Cloud models work too, when you want them, but they're an upgrade, not
a requirement. If Anthropic disappears tomorrow, your agent still
runs. If the internet goes out, your agent still runs. If you fly
across an ocean with no signal, your agent still runs. That's the kind
of agent I want to live with.

The 15-module architecture is complete in the sense that it covers
every core function of the human brain that maps meaningfully to an AI
agent. But like the real brain, it's not static. New modules can be
added when new problems appear. Existing modules can be upgraded
without breaking the others, because the corpus event bus decouples
them. Nothing has a hard reference to anything else's internals. The
architecture is designed to evolve.

I believe the future of personal AI isn't a chatbot you rent — it's a
brain you own. A brain that lives on your machine, that learns your
preferences from experience, that you can read and edit and grow.
Wolffish is that brain. It starts small and grows with you. Not
because of magic, but because the architecture follows a design
perfected by Allah — the one who shaped the human brain with a wisdom
no engineer can match. We just pay attention and build accordingly.

---

Wolffish. Bite through anything. 🐺
Built by Younes Alturkey.
