/**
 * Frames in, actions out.
 *
 * Every socket frame lands in a queue that flushes once per animation frame
 * inside one Solid batch — the first frame after quiet flushes immediately,
 * so a token stream costs at most one render per 16 ms and never adds
 * latency. Actions are the verbs the screens call: send, cancel, approve,
 * answer, open, withdraw.
 *
 * There is no prompt queue. A message typed while a turn runs goes to the
 * daemon NOW (`cli:interject`) and the running agent reads it at its next
 * stop point — see runtime/agent/interjection.ts for the contract and the
 * `user_message` segment that marks where it landed.
 */
import { batch } from 'solid-js'
import { produce } from 'solid-js/store'
import type { DaemonClient, EventFrame, TurnFrame } from '../lib/client'
import {
  applySegment,
  endAssistant,
  ensureAssistant,
  loadConversation,
  mintId,
  patchAssistant,
  type AskQuestion,
  type ChatMode,
  type PendingCard,
  type PendingMessage,
  type Segment,
  type Store,
  type StoredMessage,
  type ThinkingMode
} from './store'

export type SendOptions = {
  attachmentPaths?: string[]
  planMode?: boolean
}

export type Actions = {
  bootstrap: () => Promise<void>
  refreshSnapshot: () => Promise<void>
  openConversation: (id: string | null) => Promise<void>
  newConversation: () => void
  /** Starts a turn — or, while one runs, hands the text to it mid-turn. */
  send: (text: string, options?: SendOptions) => Promise<void>
  /**
   * Take a still-unread mid-turn message back into the prompt: the given
   * one, or the last one this terminal sent. Nothing happens once the agent
   * has read it — the inline user row is history.
   */
  withdrawPending: (id?: string) => Promise<void>
  cancel: () => Promise<void>
  respondApproval: (id: string, decision: 'approved' | 'denied', always?: boolean) => Promise<void>
  respondAsk: (id: string, response: unknown) => Promise<void>
  setThinking: (mode: ThinkingMode, persist: boolean) => Promise<void>
  setChatMode: (mode: ChatMode) => Promise<void>
  setPlanMode: (on: boolean) => Promise<void>
  setProject: (id: string | null, title: string | null) => void
  setVerbose: (on: boolean) => Promise<void>
  setBrain: (provider: string, model: string) => Promise<void>
  loadPending: () => Promise<void>
  answerParked: (card: PendingCard) => void
  compact: () => Promise<void>
  dispose: () => void
}

type Deps = {
  client: DaemonClient
  store: Store
  notify: (message: string, variant?: 'info' | 'success' | 'warning' | 'error') => void
}

const alwaysApproved = new Set<string>()

/** The daemon's MessageAttachment[] as the paths a pending row carries. */
function attachmentPaths(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  return raw
    .map((a) =>
      a && typeof a === 'object' ? String((a as { filePath?: string }).filePath ?? '') : ''
    )
    .filter(Boolean)
}

export function createActions({ client, store, notify }: Deps): Actions {
  const [get, set] = store

  /* ───────────── frame queue ───────────── */
  type Queued = { kind: 'turn'; frame: TurnFrame } | { kind: 'event'; frame: EventFrame }
  let queue: Queued[] = []
  let timer: ReturnType<typeof setTimeout> | null = null
  let lastFlush = 0

  const flush = () => {
    timer = null
    lastFlush = Date.now()
    const items = queue
    queue = []
    batch(() => {
      for (const item of items) {
        try {
          if (item.kind === 'turn') applyTurn(item.frame)
          else applyEvent(item.frame)
        } catch (error) {
          notify(`frame error: ${(error as Error).message}`, 'error')
        }
      }
    })
  }
  const push = (item: Queued) => {
    queue.push(item)
    if (timer) return
    if (Date.now() - lastFlush >= 16) flush()
    else timer = setTimeout(flush, 16)
  }

  /* ───────────── turn frames ───────────── */
  /**
   * Frames that arrive while our own send is still in flight (turnId not yet
   * known). This socket carries every conversation's turns — a Telegram
   * reply, another terminal — so nothing is rendered until the turn id is
   * known; then the buffer is replayed and filtered.
   */
  let preSend: TurnFrame[] | null = null

  const applyTurn = (frame: TurnFrame) => {
    const turnId = typeof frame.turnId === 'string' ? frame.turnId : null
    const conversationId = typeof frame.conversationId === 'string' ? frame.conversationId : null
    if (preSend) {
      preSend.push(frame)
      return
    }
    // Only our own turn renders. With no turn of our own in flight, a frame
    // for the open conversation means a run started elsewhere (the app, a
    // channel) on the same transcript: adopt it. Anything else is ignored.
    if (get.turnId) {
      if (turnId !== get.turnId) return
    } else {
      if (!conversationId || conversationId !== get.conversationId) return
    }

    switch (frame.t) {
      case 'segment':
        if (!get.working) {
          // A turn this client did not start (a resumed run): adopt it.
          set({ working: true, turnId, sendAt: get.sendAt ?? Date.now() })
        }
        applySegment(store, frame.segment as Segment, { live: true })
        return
      case 'turnEvent': {
        const type = String(frame.type)
        const payload = (frame.payload ?? {}) as Record<string, unknown>
        if (type === 'context.built') {
          set('meter', {
            tokens: Number(payload.tokenCount ?? 0),
            budget: Number(payload.tokenBudget ?? get.meter.budget),
            compactionAt:
              typeof payload.compactionAt === 'number'
                ? payload.compactionAt
                : get.meter.compactionAt,
            model: get.brain.model
          })
        } else if (type === 'turn.usage') {
          if (payload.role === 'brain') {
            set('turnUsage', {
              input: Number(payload.inputTokens ?? 0),
              output: Number(payload.outputTokens ?? 0),
              cacheRead: Number(payload.cacheReadTokens ?? 0),
              cacheWrite: Number(payload.cacheCreationTokens ?? 0)
            })
          }
          set('cost', (c) => c + Number(payload.cost ?? 0))
        } else if (type === 'llm.retry') {
          set('activity', `Retrying (attempt ${Number(payload.attempt ?? 1)})`)
        } else if (type === 'llm.fallback') {
          notify(`fell back from ${String(payload.from)} to ${String(payload.to)}`, 'warning')
        } else if (type === 'safety.blocked') {
          notify(`blocked: ${String(payload.tool)} — ${String(payload.reason ?? '')}`, 'warning')
        } else if (type === 'compaction.applied') {
          notify(`compacted: ${Number(payload.tokensSaved ?? 0)} tokens reclaimed`, 'info')
        }
        return
      }
      case 'approvalRequest': {
        const tool = String(frame.tool ?? '')
        if (alwaysApproved.has(tool)) {
          void client.invoke('cli:approvalRespond', { id: frame.id, decision: 'approved' })
          return
        }
        set('card', {
          kind: 'approval',
          id: String(frame.id),
          turnId: turnId ?? '',
          tool,
          args: (frame.args as Record<string, unknown>) ?? {},
          reason: String(frame.reason ?? ''),
          level: String(frame.level ?? ''),
          description: frame.description
        })
        set('activity', `waiting for approval: ${tool}`)
        return
      }
      case 'askRequest': {
        set('card', {
          kind: 'ask',
          id: String(frame.id),
          turnId: turnId ?? '',
          questions: (Array.isArray(frame.questions) ? frame.questions : []) as AskQuestion[]
        })
        set('activity', 'waiting for your answer')
        return
      }
      case 'credentialBlocked':
        notify(`message discarded — it looked like a ${String(frame.type)}`, 'warning')
        return
      case 'done':
        finishTurn()
        return
      case 'error':
        finishTurn(String(frame.error ?? 'the turn failed'))
        return
      default:
        return
    }
  }

  const finishTurn = (error?: string) => {
    endAssistant(store, error)
    const started = get.sendAt
    set({ working: false, activity: null, card: null, turnId: null, sendAt: null })
    if (error) set('lastError', error)
    if (started && get.turnUsage) {
      set('lastTurn', {
        durationMs: Date.now() - started,
        input: get.turnUsage.input,
        output: get.turnUsage.output,
        cost: get.cost
      })
    }
    void refreshStats()
    void flushAfterTurn()
  }

  /* ───────────── app-wide events ───────────── */
  const applyEvent = (frame: EventFrame) => {
    const payload = (frame.payload ?? {}) as Record<string, unknown>
    switch (frame.channel) {
      case 'chat:turnState': {
        const id = String(payload.conversationId ?? '')
        // The runner's TurnLifecycleEvent names it `phase`; `state`/`status`
        // stay for any older shape. Reading only the latter left this empty
        // for every real event, so `runs` never gained a live entry.
        const state = String(payload.phase ?? payload.state ?? payload.status ?? '')
        if (!id) return
        const running = state === 'started' || state === 'running' || state === 'streaming'
        set(
          'runs',
          produce((runs) => {
            const i = runs.findIndex((r) => r.conversationId === id)
            if (running) {
              const entry = {
                conversationId: id,
                channel: typeof payload.channel === 'string' ? payload.channel : undefined,
                title: typeof payload.title === 'string' ? payload.title : undefined,
                state
              }
              if (i >= 0) runs[i] = entry
              else runs.push(entry)
            } else if (i >= 0) runs.splice(i, 1)
          })
        )
        // A run ending on the open conversation refreshes its title/stats.
        if (id === get.conversationId && !(state === 'started')) void refreshTitle()
        // A run this terminal ADOPTED (no turn id of its own) ends here: the
        // CLI channel only streams `done` for its own turns, so this
        // broadcast is the only end an app- or channel-started run sends
        // us. Left unsealed, `working` stuck and every later message went
        // mid-turn to a turn that no longer existed.
        if (id === get.conversationId && !running && get.working && !get.turnId && !preSend)
          finishTurn()
        return
      }
      case 'chat:interjection': {
        if (String(payload.conversationId ?? '') !== get.conversationId) return
        const id = String(payload.messageId ?? '')
        const phase = String(payload.state ?? '')
        if (!id) return
        if (phase === 'pending') {
          // Ours is already on screen (pushed before the invoke); another
          // surface's shows up here for the first time.
          if (!get.pending.some((row) => row.id === id)) {
            set('pending', (rows) => [
              ...rows,
              {
                id,
                text: String(payload.text ?? ''),
                attachments: attachmentPaths(payload.attachments),
                mine: false
              }
            ])
          }
          return
        }
        // delivered (the user_message segment retires ours too — belt and
        // braces) or withdrawn: the row leaves either way.
        const entry = takePending(id)
        if (phase !== 'withdrawn' || !entry?.mine) return
        const reason = String(payload.reason ?? '')
        if (reason === 'user' || reason === 'canceled') restoreDraft(entry.text, entry.attachments)
        else {
          // turn_ended / error: the turn finished before reading it, so it
          // becomes the next turn — once the open one is sealed locally.
          // This event usually beats the `done` frame (the runner sweeps in
          // its finally; the sink's done rides an async persist).
          afterTurn.push({ text: entry.text, attachments: entry.attachments })
          if (!get.working && !get.card) void flushAfterTurn()
        }
        return
      }
      case 'cli:configChange':
        if (typeof payload.verbose === 'boolean') set('verbose', payload.verbose)
        return
      case 'preferences:changed': {
        const tm = payload.thinkingMode as { model?: string; mode?: string } | undefined
        if (tm && tm.model === get.brain.model && typeof tm.mode === 'string')
          set('thinking', tm.mode as ThinkingMode)
        return
      }
      case 'provider:updated':
        void refreshSnapshot()
        return
      case 'chat:planMode':
        if (
          payload.conversationId === get.conversationId &&
          typeof payload.planMode === 'boolean'
        ) {
          set('planMode', payload.planMode)
        }
        return
      case 'conversation:changed':
        if (!get.working) void refreshTitle()
        return
      case 'telegram:statusChange':
      case 'whatsapp:statusChange':
      case 'mobile:statusChange':
        void refreshStatus()
        return
      default:
        return
    }
  }

  /* ───────────── loaders ───────────── */
  const refreshSnapshot = async () => {
    try {
      const snapshot = (await client.invoke<Record<string, any>>('cli:snapshot')) ?? {}
      const llm = snapshot.llm ?? {}
      const cli = snapshot.channels?.cli ?? {}
      const provider = llm.brainProvider || null
      const model = llm.brainModel || null
      set({
        brain: { provider, model },
        chatMode: llm.chatMode === 'workflow' ? 'workflow' : 'single',
        localOnly: llm.localOnly === true,
        verbose: cli.verbose === true
      })
      if (provider && model) {
        const modes = await client
          .invoke<{
            modes: string[]
            current: string
          }>('runtime:reasoningModes', { provider, model })
          .catch(() => null)
        if (modes) {
          set('thinkingModes', modes.modes as ThinkingMode[])
          set('thinking', (modes.current || 'off') as ThinkingMode)
        }
      } else {
        set('thinkingModes', [])
      }
      const caps = await client
        .invoke<{ contextWindow: number; compactionAt: number }>('model:capabilities')
        .catch(() => null)
      if (caps?.contextWindow) {
        set('contextWindow', caps.contextWindow)
        if (!get.meter.budget)
          set('meter', {
            ...get.meter,
            budget: caps.contextWindow,
            compactionAt: caps.compactionAt ?? null
          })
      }
    } catch (error) {
      notify(`could not read settings: ${(error as Error).message}`, 'error')
    }
  }

  const refreshStatus = async () => {
    const status = await client
      .invoke<Record<string, any>>('cli:status', process.env.PATH ?? null)
      .catch(() => null)
    if (!status) return
    set({
      version: status.version ?? get.version,
      daemonPid: status.cli?.pid ?? null,
      headless: status.headless === true,
      channels: Array.isArray(status.channels) ? status.channels : [],
      runs: Array.isArray(status.activeRuns)
        ? status.activeRuns
            .filter((r: any) => r.conversationId)
            .map((r: any) => ({
              conversationId: r.conversationId,
              channel: r.channel,
              title: r.title,
              state: 'running'
            }))
        : get.runs
    })
  }

  const refreshTitle = async () => {
    if (!get.conversationId) return
    const conv = await client
      .invoke<Record<string, any>>('conversation:load', get.conversationId)
      .catch(() => null)
    if (!conv) return
    if (typeof conv.title === 'string') set('title', conv.title)
    applyStats(conv)
  }

  const applyStats = (conv: Record<string, any>) => {
    const meter = conv.stats?.meter ?? conv.contextMeter ?? null
    if (meter?.contextTokens !== undefined) {
      set('meter', {
        tokens: Number(meter.contextTokens ?? 0),
        budget: Number(meter.contextBudget ?? get.contextWindow ?? 0),
        compactionAt:
          typeof meter.compactionAt === 'number' ? meter.compactionAt : get.meter.compactionAt,
        model: meter.model ?? get.brain.model
      })
    }
    const all = conv.stats?.allTime
    if (all) {
      set('allTime', {
        cost: Number(all.cost ?? 0),
        turns: Number(all.turns ?? 0),
        inputTokens: Number(all.inputTokens ?? 0),
        outputTokens: Number(all.outputTokens ?? 0)
      })
      set('cost', Number(all.cost ?? 0))
    }
    const last = conv.stats?.lastTurn
    if (last) {
      set('lastTurn', {
        durationMs: Number(last.processingMs ?? last.durationMs ?? 0),
        input: Number(last.inputTokens ?? 0),
        output: Number(last.outputTokens ?? 0),
        cost: Number(last.cost ?? 0)
      })
    }
  }

  const refreshStats = async () => {
    if (!get.conversationId) return
    const conv = await client
      .invoke<Record<string, any>>('conversation:load', get.conversationId)
      .catch(() => null)
    if (conv) {
      if (typeof conv.title === 'string') set('title', conv.title)
      applyStats(conv)
    }
  }

  const openConversation = async (id: string | null) => {
    if (!id) {
      newConversation()
      return
    }
    const conv = await client.invoke<Record<string, any>>('conversation:load', id).catch(() => null)
    if (!conv) {
      notify('could not load that conversation', 'error')
      return
    }
    // Re-opening the same conversation (a reconnect) must not forget which
    // pending rows are ours — Escape and the draft restore depend on it, and
    // the daemon's copy only knows the channel, not the terminal.
    const ours = new Map(
      get.conversationId === id
        ? get.pending.filter((row) => row.mine).map((row) => [row.id, row] as const)
        : []
    )
    batch(() => {
      set({
        conversationId: id,
        title: typeof conv.title === 'string' ? conv.title : null,
        working: false,
        turnId: null,
        sendAt: null,
        activity: null,
        card: null,
        pending: [],
        cost: 0,
        turnUsage: null,
        lastTurn: null,
        allTime: null,
        meter: {
          tokens: 0,
          budget: get.contextWindow ?? 0,
          compactionAt: null,
          model: get.brain.model
        },
        projectId: typeof conv.projectId === 'string' ? conv.projectId : null,
        lastError: null
      })
      loadConversation(store, (conv.messages ?? []) as StoredMessage[])
      applyStats(conv)
    })
    const plan = await client.invoke<boolean>('chat:planModeGet', id).catch(() => false)
    set('planMode', plan === true)
    if (get.projectId) {
      const projects = await client
        .invoke<Array<{ id: string; title: string }>>('projects:list')
        .catch(() => [])
      set('projectTitle', projects.find((p) => p.id === get.projectId)?.title ?? null)
    } else set('projectTitle', null)
    // If a turn is running on this conversation elsewhere, adopt its state —
    // and the mid-turn messages already parked on it, so the rows below the
    // reply are complete from the first paint.
    if (get.runs.some((r) => r.conversationId === id)) {
      set({ working: true, sendAt: Date.now() })
      const parked = await client
        .invoke<
          Array<{ messageId: string; text: string; attachments?: unknown }>
        >('cli:pendingInterjections', id)
        .catch(() => [])
      if (get.conversationId !== id) return
      set(
        'pending',
        parked.map((item) => {
          const own = ours.get(String(item.messageId))
          return {
            id: String(item.messageId),
            text: String(item.text ?? ''),
            attachments: own?.attachments ?? attachmentPaths(item.attachments),
            mine: own !== undefined
          }
        })
      )
    }
  }

  const newConversation = () => {
    batch(() => {
      set({
        conversationId: null,
        title: null,
        feed: [],
        files: [],
        stagedAttachments: [],
        pending: [],
        working: false,
        turnId: null,
        sendAt: null,
        activity: null,
        card: null,
        cost: 0,
        turnUsage: null,
        lastTurn: null,
        allTime: null,
        planMode: false,
        meter: {
          tokens: 0,
          budget: get.contextWindow ?? 0,
          compactionAt: null,
          model: get.brain.model
        },
        lastError: null
      })
    })
  }

  /* ───────────── verbs ───────────── */
  /**
   * Our own send still in flight. A second Enter before the daemon has
   * registered the first turn must wait for it: its interject would find no
   * live turn yet and fall through to a normal send, which PREEMPTS the very
   * turn it was meant to steer.
   */
  let inflight: Promise<void> | null = null
  /**
   * Messages that become a fresh turn once the open one is sealed locally:
   * a mid-turn message the daemon handed back with `turn_ended`/`error`, or
   * one it refused with `no_live_turn` while our `done` frame was still on
   * the wire. Not a queue the user sees — the sliver between the agent's
   * last drain and the lane closing, made safe.
   */
  const afterTurn: Array<{ text: string; attachments: string[] }> = []

  const flushNow = () => {
    if (!timer) return
    clearTimeout(timer)
    flush()
  }

  const takePending = (id: string): PendingMessage | null => {
    const entry = get.pending.find((row) => row.id === id) ?? null
    if (entry) set('pending', (rows) => rows.filter((row) => row.id !== id))
    return entry
  }

  /** Text back to the prompt (appended on its own line), files back to staging. */
  const restoreDraft = (text: string, attachments: string[]) => {
    if (text) set('restoreDraft', (draft) => (draft ? `${draft}\n${text}` : text))
    if (attachments.length > 0)
      set('stagedAttachments', (s) => [...s, ...attachments.filter((a) => !s.includes(a))])
  }

  const send = async (text: string, options: SendOptions = {}) => {
    const trimmed = text.trim()
    const attachments = options.attachmentPaths ?? get.stagedAttachments
    if (!trimmed && attachments.length === 0) return
    if (inflight) await inflight
    if (get.working || get.card) {
      set('stagedAttachments', [])
      await interject(trimmed, attachments)
      return
    }
    const run = startTurn(trimmed, attachments, options)
    inflight = run
    try {
      await run
    } finally {
      if (inflight === run) inflight = null
    }
  }

  /**
   * Hand a message to the running turn. The pending row goes up before the
   * round trip (the daemon's own `pending` event finds it already there);
   * `no_live_turn` takes it down again and the text becomes a normal turn —
   * now if the turn is sealed locally, otherwise the moment it is.
   */
  const interject = async (text: string, attachments: string[]) => {
    const conversationId = get.conversationId
    if (!conversationId) {
      restoreDraft(text, attachments)
      return
    }
    const id = mintId('i')
    set('pending', (rows) => [...rows, { id, text, attachments, mine: true }])
    let result: { status?: string } | null = null
    try {
      result = await client.invoke<{ status?: string }>('cli:interject', {
        conversationId,
        messageId: id,
        text,
        attachmentPaths: attachments
      })
    } catch (error) {
      takePending(id)
      restoreDraft(text, attachments)
      notify(
        (error as Error).message === 'not connected'
          ? 'not connected to the daemon — reconnecting'
          : (error as Error).message,
        'error'
      )
      return
    }
    if (result?.status === 'pending') return
    takePending(id)
    flushNow()
    if (get.working || get.card) afterTurn.push({ text, attachments })
    else await send(text, { attachmentPaths: attachments })
  }

  const flushAfterTurn = async () => {
    // Sequential on purpose: the first becomes the turn, every later one
    // goes to it mid-turn through send()'s own branch.
    for (const next of afterTurn.splice(0))
      await send(next.text, { attachmentPaths: next.attachments })
  }

  const startTurn = async (trimmed: string, attachments: string[], options: SendOptions) => {
    batch(() => {
      set('feed', (feed) => [
        ...feed,
        {
          kind: 'user',
          id: mintId('u'),
          text: trimmed,
          attachments: attachments.map((p) => ({ name: p.split(/[\\/]/).pop() ?? p, path: p })),
          timestamp: Date.now()
        }
      ])
      set({
        working: true,
        sendAt: Date.now(),
        activity: 'Thinking',
        turnUsage: null,
        stagedAttachments: [],
        lastError: null
      })
      ensureAssistant(set, get, null)
    })
    preSend = []
    try {
      const started = await client.invoke<{ turnId: string; conversationId: string }>('cli:send', {
        text: trimmed,
        conversationId: get.conversationId,
        attachmentPaths: attachments,
        projectId: get.projectId,
        thinkingMode: get.thinking,
        planMode: options.planMode ?? get.planMode
      })
      batch(() => {
        set('turnId', started.turnId)
        set('conversationId', started.conversationId)
        const index = get.feed.length - 1
        const last = get.feed[index]
        if (last && last.kind === 'assistant' && !last.turnId)
          patchAssistant(set, index, { turnId: started.turnId })
      })
      if (get.planMode && get.conversationId) {
        void client
          .invoke('chat:planModeSet', { conversationId: get.conversationId, planMode: true })
          .catch(() => undefined)
      }
      const buffered = preSend ?? []
      preSend = null
      batch(() => {
        for (const frame of buffered) applyTurn(frame)
      })
    } catch (error) {
      preSend = null
      // The send never reached the daemon: drop the empty assistant shell
      // rather than sealing it, and say why.
      let index = get.feed.length - 1
      const last = get.feed[index]
      if (last && last.kind === 'assistant' && last.parts.length === 0) {
        set('feed', (feed) => feed.slice(0, index))
        index -= 1
      }
      const user = get.feed[index]
      if (user && user.kind === 'user' && user.text === trimmed) {
        set('feed', (feed) => feed.slice(0, index))
        set('restoreDraft', trimmed)
        if (attachments.length > 0) set('stagedAttachments', attachments)
      }
      set({ working: false, activity: null, turnId: null, sendAt: null })
      notify(
        (error as Error).message === 'not connected'
          ? 'not connected to the daemon — reconnecting'
          : (error as Error).message,
        'error'
      )
    }
  }

  const withdrawPending = async (id?: string) => {
    const conversationId = get.conversationId
    const entry = id
      ? get.pending.find((row) => row.id === id)
      : [...get.pending].reverse().find((row) => row.mine)
    if (!entry || !conversationId) return
    const result = await client
      .invoke<{ ok: boolean }>('cli:withdrawInterjection', { conversationId, messageId: entry.id })
      .catch(() => ({ ok: false }))
    // The daemon's `withdrawn` event may have beaten this reply and already
    // restored the draft; taking the row is what makes the two idempotent.
    // `ok: false` means the agent read it — the inline row is on its way.
    if (result?.ok && takePending(entry.id)) restoreDraft(entry.text, entry.attachments)
  }

  const cancel = async () => {
    if (!get.working && !get.card) return
    set('activity', 'stopping')
    await client.invoke('cli:cancel', get.conversationId).catch(() => undefined)
  }

  const respondApproval = async (id: string, decision: 'approved' | 'denied', always = false) => {
    const card = get.card
    if (always && card?.kind === 'approval') alwaysApproved.add(card.tool)
    set('card', null)
    set('parked', (p) => p.filter((c) => c.id !== id))
    set('activity', 'Thinking')
    await client
      .invoke('cli:approvalRespond', { id, decision })
      .catch((e) => notify(String(e), 'error'))
  }

  const respondAsk = async (id: string, response: unknown) => {
    set('card', null)
    set('parked', (p) => p.filter((c) => c.id !== id))
    set('activity', 'Thinking')
    await client.invoke('cli:askRespond', { id, response }).catch((e) => notify(String(e), 'error'))
  }

  const setThinking = async (mode: ThinkingMode, persist: boolean) => {
    set('thinking', mode)
    if (persist && get.brain.model) {
      await client
        .invoke('runtime:setThinkingMode', get.brain.model, mode)
        .catch((e) => notify(String(e), 'error'))
    }
  }

  const setChatMode = async (mode: ChatMode) => {
    set('chatMode', mode)
    await client.invoke('cli:setSetting', { id: 'model.mode', value: mode }).catch(async () => {
      await client.invoke('provider:setMode', mode).catch((e) => notify(String(e), 'error'))
    })
  }

  const setPlanMode = async (on: boolean) => {
    set('planMode', on)
    if (get.conversationId) {
      await client
        .invoke('chat:planModeSet', { conversationId: get.conversationId, planMode: on })
        .catch(() => undefined)
    }
  }

  const setProject = (id: string | null, title: string | null) =>
    set({ projectId: id, projectTitle: title })

  const setVerbose = async (on: boolean) => {
    set('verbose', on)
    await client.invoke('cli:setConfig', { verbose: on }).catch(() => undefined)
  }

  const setBrain = async (provider: string, model: string) => {
    await client.invoke('provider:setBrain', { providerId: provider, model })
    await refreshSnapshot()
  }

  const loadPending = async () => {
    const rows = await client
      .invoke<
        Array<{ kind: 'approval' | 'ask'; frame: Record<string, any> }>
      >('cli:pendingRequests')
      .catch(() => [])
    const parked: PendingCard[] = rows.map((row) =>
      row.kind === 'ask'
        ? {
            kind: 'ask',
            id: String(row.frame.id),
            turnId: String(row.frame.turnId ?? ''),
            questions: (row.frame.questions ?? []) as AskQuestion[],
            parked: true
          }
        : {
            kind: 'approval',
            id: String(row.frame.id),
            turnId: String(row.frame.turnId ?? ''),
            tool: String(row.frame.tool ?? ''),
            args: row.frame.args ?? {},
            reason: String(row.frame.reason ?? ''),
            level: String(row.frame.level ?? ''),
            parked: true
          }
    )
    set('parked', parked)
    if (parked.length > 0)
      notify(
        `${parked.length} approval${parked.length === 1 ? '' : 's'} waiting — /pending`,
        'warning'
      )
  }

  const answerParked = (card: PendingCard) => set('card', card)

  const compact = async () => {
    if (!get.conversationId) {
      notify('nothing to compact yet', 'info')
      return
    }
    await send('/compact', {})
  }

  /* ───────────── bootstrap ───────────── */
  const offTurn = client.onTurn((frame) => push({ kind: 'turn', frame }))
  const offEvent = client.onEvent((frame) => push({ kind: 'event', frame }))
  const offState = client.onState((state) => {
    set('connection', state)
    if (state === 'connected' && get.version) {
      // Reconnected: re-hydrate whatever was open.
      notify('reconnected to the daemon', 'success')
      void (async () => {
        await refreshSnapshot()
        await refreshStatus()
        if (get.conversationId) await openConversation(get.conversationId)
      })()
    }
  })

  const bootstrap = async () => {
    set('connection', client.state)
    set('version', client.hello?.version ?? null)
    await Promise.all([refreshSnapshot(), refreshStatus(), loadPending()])
  }

  const dispose = () => {
    offTurn()
    offEvent()
    offState()
    if (timer) clearTimeout(timer)
  }

  return {
    bootstrap,
    refreshSnapshot,
    openConversation,
    newConversation,
    send,
    withdrawPending,
    cancel,
    respondApproval,
    respondAsk,
    setThinking,
    setChatMode,
    setPlanMode,
    setProject,
    setVerbose,
    setBrain,
    loadPending,
    answerParked,
    compact,
    dispose
  }
}
