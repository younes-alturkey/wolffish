/**
 * Builds the config snapshot the phone renders.
 *
 * The shape is `ConfigSnapshot` in wolffish-mobile (`src/state/demoConfig.ts`)
 * — the exact object demo mode already ingests. Serving the same shape live is
 * what lets every settings screen on the phone work in paired mode without a
 * single change: the phone calls `applySnapshot()` either way and cannot tell
 * a downloaded demo bundle from a live desktop.
 *
 * Every optional field in that contract is genuinely optional ("absent in
 * bundles published before X shipped"), so a section this builder cannot
 * resolve is omitted rather than faked, and the phone falls back to its
 * documented default instead of rendering an invented number.
 *
 * The reference artifact for the contract is the committed demo snapshot
 * (wolffish-mobile/demo-data/config-snapshot.json): every key below exists
 * there in the same shape. Field names come from WorkspaceConfig
 * (workspace/workspace.ts) — the real ones, not paraphrases: `defaultVoice`
 * not `voice`, `allowedPhoneNumbers` not `allowedNumbers`,
 * `hideAutomationsFromResume` not `hideAutomations`. Getting one wrong does
 * not error anywhere; it renders a silent default on the phone forever.
 */
import type { Agent } from '@main/runtime/agent'
import { readViewerFile } from '@main/viewer'
import { readConfig } from '@main/workspace/workspace'
import { reasoningModesFor } from '@main/runtime/reasoning'
import { app } from 'electron'

/** Mirrors wolffish-mobile's ConfigSnapshot. Kept structural on purpose: the
 * phone owns the canonical type, and over-typing it here would mean editing
 * two repos for every field the phone learns to render. */
export type ConfigSnapshot = Record<string, unknown>

/** Untyped JSON read from the workspace: every access goes through a coercion
 * helper below, so the shape is deliberately loose rather than a lie. */
type Cfg = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any

type CapabilitySerializer = () => Promise<
  Array<{
    name: string
    description: string
    enabled: boolean
    official: boolean
    core: boolean
    hasPlugin: boolean
    toolCount: number
    requires: string[]
  }>
>

export type SnapshotSources = {
  agent: Agent
  /** index.ts already has this closure for the settings IPC; reuse it rather
   * than reaching into cerebellum a second way. */
  serializeCapabilities: CapabilitySerializer
  /** Optional extras — omitted from the snapshot when they throw or are absent. */
  dataAnalytics?: () => Promise<Record<string, unknown>>
  usageDays?: () => Promise<unknown[]>
  ollamaRunning?: () => Promise<boolean>
  ollamaModels?: () => Promise<string[]>
  /** brain/projects.json — the store the Projects page edits, NOT config.json. */
  projects?: () => Promise<unknown[]>
  /** Brainstem last-run records, for the phone's Knowledge cards. */
  compactionRuns?: () => Promise<Record<string, unknown>>
  /** Live browser-extension server state — which browsers are connected now.
   * Structural (readonly unknown[]) so the server's own interface assigns
   * without an index signature; each row is coerced field by field below. */
  extensionStatus?: () => Promise<{
    status?: string
    port?: number
    extensionVersion?: string | null
    browsers?: readonly unknown[]
  }>
  /** The extension server's cheap readiness (cached doctor report, or a
   * probe-less compose) — the phone shows "ready / N blockers" without a
   * round-trip to the browser. */
  extensionReadiness?: () => Promise<{
    ready?: boolean
    tier?: string
    findings?: readonly unknown[]
    summary?: string
  }>
  /** Months this build's own release notes cover (src/changelog), newest
   * first. The list alone — bodies are served one at a time by
   * Rpc.changelogRead, because the full set is hundreds of KB. */
  changelogMonths?: () => Promise<string[]>
  /**
   * Whether autostart is ACTUALLY registered with the OS right now. Optional
   * because it shells out (systemctl / launchctl / schtasks) and a snapshot
   * must never fail on it — absent simply omits the field.
   */
  launchAtStartupActive?: () => Promise<boolean>
  /**
   * Can a shell on this machine actually resolve `wolffish`? Optional for the
   * same reason as the probe above: it reads the filesystem and walks PATH, so
   * a failure omits the field and the phone's card says nothing rather than
   * claiming the command is broken.
   */
  cliPathInstalled?: () => Promise<boolean>
  /**
   * What the CURRENT run mode registers on this machine — 'launchd',
   * 'systemd', 'schtasks'. A name, so the phone can say which mechanism is in
   * play instead of the generic word the desktop panel also refuses to use.
   */
  cliMechanism?: () => Promise<string>
}

const str = (value: unknown, fallback = ''): string =>
  typeof value === 'string' ? value : typeof value === 'number' ? String(value) : fallback

const bool = (value: unknown, fallback = false): boolean =>
  typeof value === 'boolean' ? value : fallback

const int = (value: unknown, fallback: number): number =>
  typeof value === 'number' && Number.isFinite(value) ? value : fallback

/** What the phone's Updates/Data cards print — a name, not a node constant. */
const platformLabel = (platform: NodeJS.Platform): string =>
  platform === 'darwin'
    ? 'macOS'
    : platform === 'win32'
      ? 'Windows'
      : platform === 'linux'
        ? 'Linux'
        : platform

/**
 * Enough of a key to recognise WHICH credential is installed, never enough to
 * authenticate. The demo ships full-length fakes; a live desktop ships this.
 */
const maskKey = (key: unknown): string | null =>
  typeof key === 'string' && key.length > 0 ? `${key.slice(0, 12)}…` : null

/** Never let one unavailable section fail the whole snapshot. */
async function attempt<T>(fn: (() => Promise<T>) | undefined): Promise<T | undefined> {
  if (!fn) return undefined
  try {
    return await fn()
  } catch {
    return undefined
  }
}

/**
 * Thinking modes the desktop stores per model. Exported because both
 * directions consult it: the snapshot below refuses to send a stored value
 * outside the set, and applyMobileSettings (index.ts) refuses to persist one
 * — so a phone and a desktop that disagree about what counts as a mode fail
 * loudly instead of storing junk.
 */
export const THINKING_MODES = new Set(['off', 'on', 'high', 'max'])

/**
 * The allowed-list fields travel to the phone as one comma-joined line (the
 * `allowedUserIds` / `allowedNumbers` strings the snapshot below mints) and
 * come back the same way through configSet. The parsers live beside the
 * joins so the round trip is one contract in one file — a format change that
 * touched only one direction would revert the field on every edit, silently.
 * Parsing is lenient (whitespace tolerated, junk entries dropped) because
 * the string arrives straight off a phone keyboard.
 */
export function parseAllowedUserIds(text: string): number[] {
  return text
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map(Number)
    .filter((id) => Number.isInteger(id) && id > 0)
}

export function parseAllowedNumbers(text: string): string[] {
  return text
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
}

/**
 * The three hand-written documents that shape the agent — the three tabs of
 * the desktop's Customization page (pages/Customization.tsx), which is one
 * markdown editor over one workspace file at a time.
 *
 * Declared once, here, because BOTH directions index into it: the snapshot
 * below reads these paths, and applyMobileSettings (index.ts) writes them from
 * the `<key>Markdown` config keys the phone sends. A path typo split across
 * two files would read one document and write another.
 *
 * The runtime only ever READS them (prefrontal.ts assembles them into the
 * system prompt) and the launch migrations deliberately skip them ("custom
 * agent instructions belong in brain/prefrontal/agents.md, which we never
 * overwrite"), so the desktop's editor and the phone are the only writers —
 * which is what lets a broadcast on each write be a complete change signal.
 */
export const CUSTOMIZATION_DOCS = {
  soul: 'brain/identity/soul.md',
  user: 'brain/identity/user.md',
  agents: 'brain/prefrontal/agents.md'
} as const

export type CustomizationDoc = keyof typeof CUSTOMIZATION_DOCS

/**
 * How much of one document may ride the wire.
 *
 * Whole snapshots and whole config writes are single RPC frames, and the relay
 * drops any record over 1 MiB. Without a ceiling here one oversized soul.md
 * would not merely degrade the Customization screen — it would break EVERY
 * settings screen, because they all render the one snapshot it rides in.
 *
 * 64 KiB is ~12x the largest bundled default (soul.md, 5.5 KB) and roughly ten
 * thousand words, while leaving the rest of a real snapshot — capabilities and
 * the model catalog at ~9 KB each, a usage ledger that grows for years — a
 * budget that cannot be squeezed by what someone typed into an identity file.
 */
export const CUSTOMIZATION_MAX_BYTES = 64 * 1024

/**
 * The three documents as the phone renders them.
 *
 * A missing or unreadable file is '' — the same "nothing written yet" the
 * desktop's own editor shows — while a file too large to send is OMITTED and
 * named in `oversized`. The distinction is load-bearing: the phone must never
 * be handed a truncated document it could save back over the real one, so an
 * oversized doc gets no text at all and the screen turns read-only.
 */
async function readCustomizationDocs(): Promise<{
  soul?: string
  user?: string
  agents?: string
  oversized?: string[]
}> {
  const docs: Record<string, string> = {}
  const oversized: string[] = []
  await Promise.all(
    (Object.keys(CUSTOMIZATION_DOCS) as CustomizationDoc[]).map(async (doc) => {
      let text: string
      try {
        text = await readViewerFile(CUSTOMIZATION_DOCS[doc])
      } catch {
        // Never written, or unreadable — an empty editor, not a broken screen.
        docs[doc] = ''
        return
      }
      if (Buffer.byteLength(text, 'utf8') > CUSTOMIZATION_MAX_BYTES) oversized.push(doc)
      else docs[doc] = text
    })
  )
  return { ...docs, ...(oversized.length ? { oversized: oversized.sort() } : {}) }
}

export async function buildConfigSnapshot(sources: SnapshotSources): Promise<ConfigSnapshot> {
  const config = ((await readConfig()) ?? {}) as Cfg
  const capabilities = await sources.serializeCapabilities().catch(() => [])
  // Three shell-outs between them, so they go together rather than in series.
  const [launchAtStartupActive, cliPathInstalled, cliMechanism] = await Promise.all([
    attempt(sources.launchAtStartupActive),
    attempt(sources.cliPathInstalled),
    attempt(sources.cliMechanism)
  ])

  const llm = (config.llm ?? {}) as Cfg
  const brain = (llm.brain ?? {}) as Cfg
  const local = (llm.local ?? {}) as Cfg
  const telegram = (config.telegram ?? {}) as Cfg
  const whatsapp = (config.whatsapp ?? {}) as Cfg
  const mobile = (config.mobile ?? {}) as Cfg
  const google = (config.google ?? {}) as Cfg
  const stt = (config.stt ?? {}) as Cfg
  const tts = (config.tts ?? {}) as Cfg
  const computerUse = (config.computerUse ?? {}) as Cfg
  const browserExtension = (config.browserExtension ?? {}) as Cfg
  const mcp = (config.mcp ?? {}) as Cfg
  const compaction = (config.compaction ?? {}) as Cfg
  const reflection = (config.reflection ?? {}) as Cfg
  const safety = (config.safety ?? {}) as Cfg
  const disabledCapabilities: string[] = Array.isArray(config.disabledCapabilities)
    ? config.disabledCapabilities
    : []

  const [
    data,
    usageDays,
    ollamaRunning,
    ollamaModels,
    projects,
    compactionRuns,
    extension,
    readiness,
    changelogMonths
  ] = await Promise.all([
    attempt(sources.dataAnalytics),
    attempt(sources.usageDays),
    attempt(sources.ollamaRunning),
    attempt(sources.ollamaModels),
    attempt(sources.projects),
    attempt(sources.compactionRuns),
    attempt(sources.extensionStatus),
    attempt(sources.extensionReadiness),
    attempt(sources.changelogMonths)
  ])

  // Blockers count + the first blocker's title: enough for a status row on
  // the phone; the full walkthrough is a desktop/model affair.
  const readinessFindings = (readiness?.findings ?? []) as Array<Record<string, unknown>>
  const readinessBlockers = readinessFindings.filter((f) => f.severity === 'blocker')

  // Not an `attempt`: the reader already answers '' per unreadable document,
  // so there is no failure mode that should cost the section as a whole.
  const customization = await readCustomizationDocs()

  // Per-model thinking mode for the current Brain. Absent unless the user has
  // actually chosen one for this model — the phone falls back to its default
  // rather than this side inventing a choice the desktop never made.
  const thinkingModes = (llm.thinkingModes ?? {}) as Record<string, unknown>
  const thinkingMode = thinkingModes[str(brain.model)]

  // The ordered modes THIS model honours — the same registry the desktop's
  // brain button renders from. Served so the phone's Library cards offer
  // exactly what the model accepts and never a mode it would silently ignore;
  // a phone paired with an older desktop gets no list and falls back to the
  // full canonical scale on its side.
  const localModelId = bool(llm.localOnly)
    ? typeof local.model === 'string'
      ? local.model
      : null
    : null
  const reasoningModes = bool(llm.localOnly)
    ? localModelId
      ? reasoningModesFor('local', localModelId)
      : []
    : reasoningModesFor(str(brain.providerId), str(brain.model))

  const snapshot: Record<string, unknown> = {
    capabilities: capabilities.map((capability) => ({
      name: capability.name,
      description: capability.description,
      enabled: capability.enabled,
      official: capability.official,
      core: capability.core,
      hasPlugin: capability.hasPlugin,
      toolCount: capability.toolCount,
      requires: capability.requires
    })),

    // The phone renders name + enabled only; server definitions (commands,
    // headers, oauth state — all secrets) stay desktop-side.
    mcpServers: Array.isArray(mcp.servers)
      ? (mcp.servers as Cfg[]).map((server) => ({
          name: str(server?.name, str(server?.slug, 'server')),
          enabled: bool(server?.enabled, true)
        }))
      : [],

    // Variable[] verbatim minus nothing: the Variables page renders name,
    // value and the sensitive flag (masked display). The tunnel is end-to-end
    // sealed, and both devices are the same person's.
    variables: (Array.isArray(config.variables) ? config.variables : [])
      .filter((variable: Cfg) => typeof variable?.name === 'string' && variable.name)
      .map((variable: Cfg) => ({
        name: variable.name,
        value: str(variable?.value),
        sensitive: bool(variable?.sensitive)
      })),

    // Soul, User and Agents — the markdown the phone's Customization screen
    // edits, verbatim. Full text rather than a size or a preview: the screen
    // shows the document and writes it back, and a half-loaded document is a
    // document that cannot be edited safely.
    customization,

    services: {
      google: {
        // GoogleConfig.status is already 'active' | 'inactive' — the exact
        // string the phone compares against.
        status: str(google.status, 'inactive'),
        projectId: str(google.projectId)
      },
      // Connection lists are mapped to {label, detail} — the two lines the
      // phone renders — and NOTHING else. The stored objects carry live
      // tokens (PATs, integration secrets) that must never ride the tunnel.
      github: (Array.isArray(config.github?.connections) ? config.github.connections : []).map(
        (connection: Cfg) => ({
          label: str(connection?.label, str(connection?.login, 'GitHub')),
          detail:
            [str(connection?.login), str(connection?.name)].filter(Boolean).join(' · ') ||
            str(connection?.label)
        })
      ),
      notion: (Array.isArray(config.notion?.connections) ? config.notion.connections : []).map(
        (connection: Cfg) => ({
          label: str(connection?.label, str(connection?.name, 'Notion')),
          detail: str(connection?.name, str(connection?.email))
        })
      ),
      braveEnabled: bool(config.brave?.enabled),
      // The credential itself, not a mask: the phone's field EDITS it, and
      // both devices are the same person's — the tunnel is end-to-end sealed.
      braveApiKey: str(config.brave?.apiKey),
      // Video generation (MiniMax H3): same shape as Brave — an enabled flag
      // (the capability isn't switched off) plus the editable credential.
      // Deliberately NOT the MiniMax chat provider's key (see VideoConfig).
      videoEnabled: !disabledCapabilities.includes('video'),
      videoApiKey: str(config.video?.apiKey),
      // Absent-means-on, matching getVideoConfig: only an explicit false
      // turns the director off.
      videoDirector: config.video?.director !== false,
      // Memes has no enabled flag of its own — memegen works with zero
      // config — so "enabled" means the capability itself isn't switched off.
      memesEnabled: !disabledCapabilities.includes('memes'),
      memes: {
        imgflipUsername: str(config.memes?.imgflip?.username),
        imgflipPassword: str(config.memes?.imgflip?.password),
        giphyApiKey: str(config.memes?.giphy?.apiKey)
      },
      sttModel: str(stt.defaultModel, 'small'),
      // Pinned transcription language ('auto' = Whisper detection). The 'en'
      // fallback mirrors the plugin's own default for an unset config.
      sttLanguage: str(stt.language, 'en'),
      ttsVoice: str(tts.defaultVoice, 'af_bella'),
      ttsSpeed: str(tts.defaultSpeed, '1.0'),
      // Voice prompts get spoken replies — absent-means-on, like videoDirector.
      ttsVoiceReplies: tts.voiceReplies !== false,
      screenshotMaxWidth: str(computerUse.screenshotMaxWidth, '1280'),
      screenshotFormat: str(computerUse.screenshotFormat, 'jpeg'),
      browserExtension: {
        port: int(browserExtension.port, 23151),
        screenshotMaxWidth: int(browserExtension.screenshotMaxWidth, 1280),
        screenshotFormat: str(browserExtension.screenshotFormat, 'jpeg'),
        screenshotQuality: int(browserExtension.screenshotQuality, 80),
        connected: extension?.status === 'connected',
        readiness: {
          ready: readiness?.ready === true,
          tier: str(readiness?.tier, 'none'),
          blockers: readinessBlockers.length,
          top: readinessBlockers.length > 0 ? str(readinessBlockers[0].title) || null : null
        },
        browsers: (extension?.browsers ?? []).map((entry) => {
          const browser = (entry ?? {}) as Cfg
          return {
            browser: str(browser.browser),
            name: str(browser.name, 'Browser'),
            browserVersion: str(browser.browserVersion) || null,
            os: str(browser.os) || null,
            profileEmail: str(browser.profileEmail) || null,
            extensionVersion: str(browser.version) || null,
            connectedAt: typeof browser.connectedAt === 'number' ? browser.connectedAt : null
          }
        })
      },
      // Computer use is this app driving this machine's screen and input —
      // present by construction while the desktop runs. The row exists so the
      // phone reports it as this machine's, not a hardcoded guess.
      computerUse: {
        connected: true,
        connections: [{ label: platformLabel(process.platform), detail: 'screen + input' }]
      }
    },

    channels: {
      inapp: {
        verbose: bool(config.inapp?.verbose),
        // Whether the thinking card renders at all. One workspace answer for
        // both surfaces (the phone obeys the same key), ON by default — so an
        // absent field must read as true here too, or a workspace that has
        // never touched the switch would reach the phone as off.
        reasoning: bool(config.inapp?.reasoning, true)
      },
      // The terminal channel. `runMode` is what decides which autostart
      // registration this machine gets, so it belongs beside the setting it
      // explains rather than hidden in config.json.
      //
      // The three probed fields below are what make the phone's CLI card worth
      // opening at all. `verbose` is the only thing here anyone can edit; the
      // question actually worth asking from a phone is whether the terminal
      // half of this desktop is WORKING — is `wolffish` findable in a shell,
      // did the autostart registration take, and by which mechanism. Those
      // three cannot be read off config.json (they are a PATH probe and a
      // launchctl/systemctl/schtasks query), so they are optional sources and a
      // desktop that cannot answer omits them rather than guessing.
      cli: {
        verbose: bool(config.cli?.verbose),
        runMode: config.cli?.runMode === 'headless' ? 'headless' : 'gui',
        ...(cliPathInstalled === undefined ? {} : { pathInstalled: cliPathInstalled }),
        // The SAME registration `preferences.launchAtStartupActive` reports —
        // one probe, read twice, so the CLI card and the Preferences row can
        // never disagree about whether this machine starts on its own.
        ...(launchAtStartupActive === undefined ? {} : { serviceActive: launchAtStartupActive }),
        ...(cliMechanism === undefined ? {} : { mechanism: cliMechanism })
      },
      // The phone's own channel — the two settings the Mobile panel here
      // carries, so the phone can render and edit them rather than being the
      // one device that cannot see what it is set to. Notifications default
      // ON (MobileChannelConfig), the feed defaults clean.
      mobile: {
        notifications: bool(mobile.notifications, true),
        verbose: bool(mobile.verbose)
      },
      telegram: {
        enabled: bool(telegram.enabled),
        // Stored as number[]; the phone renders one comma-joined line.
        allowedUserIds: (Array.isArray(telegram.allowedUserIds) ? telegram.allowedUserIds : [])
          .map((id: unknown) => str(id))
          .filter(Boolean)
          .join(', '),
        autoRefresh: bool(telegram.autoRefresh, true),
        staleHours: str(telegram.staleHours, '12'),
        verbose: bool(telegram.verbose),
        hideAutomations: bool(telegram.hideAutomationsFromResume, true)
      },
      whatsapp: {
        enabled: bool(whatsapp.enabled),
        allowedNumbers: (Array.isArray(whatsapp.allowedPhoneNumbers)
          ? whatsapp.allowedPhoneNumbers
          : []
        )
          .map((n: unknown) => str(n))
          .filter(Boolean)
          .join(', '),
        autoRefresh: bool(whatsapp.autoRefresh, true),
        staleHours: str(whatsapp.staleHours, '12'),
        verbose: bool(whatsapp.verbose),
        hideAutomations: bool(whatsapp.hideAutomationsFromResume, true)
      }
    },

    llm: {
      brainProvider: str(brain.providerId),
      brainModel: str(brain.model),
      chatMode: str(llm.mode, 'single'),
      localOnly: bool(llm.localOnly),
      restrictPowerfulModels: bool(llm.restrictPowerfulModels, true),
      ...(typeof thinkingMode === 'string' && THINKING_MODES.has(thinkingMode)
        ? { thinkingMode }
        : {}),
      // What this model can actually do, in the brain button's own order.
      reasoningModes,
      local: {
        enabled: bool(local.enabled),
        model: typeof local.model === 'string' ? local.model : null,
        ...(ollamaRunning === undefined ? {} : { running: ollamaRunning }),
        ...(ollamaModels === undefined ? {} : { models: ollamaModels })
      },
      // Key presence, chosen model and the cached catalog — the Model page's
      // whole surface. The real credential never leaves this machine; the
      // phone gets a recognisable prefix.
      providers: (Array.isArray(llm.providers) ? llm.providers : []).map((provider: Cfg) => ({
        id: str(provider?.id),
        model: typeof provider?.model === 'string' ? provider.model : null,
        hasKey: Boolean(provider?.apiKey),
        apiKey: maskKey(provider?.apiKey),
        models:
          Array.isArray(provider?.models) && provider.models.length
            ? provider.models.filter((model: unknown) => typeof model === 'string')
            : typeof provider?.model === 'string' && provider.model
              ? [provider.model]
              : []
      }))
    },

    preferences: {
      launchAtStartup: bool(config.launchAtStartup, true),
      // What is ACTUALLY registered with the OS, which is not the same
      // question as what the user asked for. They disagree whenever the
      // registration failed or was never possible — the state Linux was
      // silently in for as long as the app used Electron's login-item API
      // there. Surfaced so a settings row can say "On · Inactive" instead of
      // claiming success. Undefined when the caller didn't supply the probe.
      ...(launchAtStartupActive === undefined
        ? {}
        : { launchAtStartupActive: launchAtStartupActive }),
      theme: str(config.theme, 'system'),
      locale: str(config.locale, 'en'),
      bypassPermissions: bool(safety.bypassPermissions),
      blockCredentials: bool(safety.blockCredentials, true),
      weekStartsOn: config.weekStartsOn === 0 ? 0 : 1,
      updatesEnabled: bool(config.updates?.enabled, true),
      ...(typeof config.ollamaModelsFolder === 'string'
        ? { ollamaModelsFolder: config.ollamaModelsFolder }
        : {})
    },

    desktop: {
      version: app.getVersion(),
      platform: platformLabel(process.platform),
      // IANA zone the schedules below fire in. The phone renders this
      // machine's clock and next-run countdowns from it instead of quietly
      // assuming the two devices share a timezone.
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      syncedAt: new Date().toISOString()
    },

    // Defaults mirror DEFAULT_REFLECTION (3 / 12), not invented ones — an
    // unset config must read the same on both screens.
    reflection: {
      hour: int(reflection.hour, 3),
      quietHours: int(reflection.quietHours, 12)
    },

    compaction: {
      // Defaults mirror CompactionConfig's own (23 / Sunday / 23), not
      // invented ones — an unset schedule must read the same on both screens.
      dailyHour: int(compaction.dailyHour, 23),
      weeklyDay: int(compaction.weeklyDay, 0),
      weeklyHour: int(compaction.weeklyHour, 23),
      ...(compactionRuns
        ? {
            runs: {
              daily: compactionRuns.daily ?? null,
              weekly: compactionRuns.weekly ?? null,
              // The reflection jobs report through the same brainstem meta
              // file; the phone's Knowledge screen renders all four cards.
              reflection: compactionRuns.reflection ?? null,
              deepClean: compactionRuns.deepClean ?? null
            }
          }
        : {})
    }
  }

  if (data) snapshot.data = data
  if (Array.isArray(usageDays)) snapshot.usage = { days: usageDays }
  // The list alone — the phone fetches a month's body over Rpc.changelogRead
  // when the reader opens it. Omitted (not empty) when the source is absent,
  // so an older wiring renders the phone's documented empty state.
  if (Array.isArray(changelogMonths) && changelogMonths.length > 0) {
    snapshot.changelog = { months: changelogMonths }
  }

  if (Array.isArray(projects)) {
    snapshot.projects = (projects as Cfg[]).map((project) => ({
      id: str(project?.id),
      title: str(project?.title),
      icon: str(project?.icon),
      instructions: str(project?.instructions),
      files: (Array.isArray(project?.files) ? project.files : []).map((file: Cfg) => ({
        path: str(file?.path),
        name: str(file?.name)
      })),
      // Absolute desktop paths, verbatim — the phone shows them and cannot
      // resolve them, which is the point of showing the whole path.
      directories: (Array.isArray(project?.directories) ? project.directories : []).map((dir) =>
        str(dir)
      ),
      createdAt: int(project?.createdAt, 0),
      updatedAt: int(project?.updatedAt, 0)
    }))
  }

  return snapshot
}
