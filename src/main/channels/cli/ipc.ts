/**
 * The `cli:*` and `service:*` IPC channels — everything the terminal needs
 * that the desktop never did.
 *
 * Everything ELSE the CLI does goes through the app's existing 200-odd
 * handlers untouched (see ipc-registry). What lands here is only the work that
 * has no renderer equivalent: describing a setting as text, staging a file
 * from a path instead of a picker, running a turn without a WebContents, and
 * the two installers (autostart, PATH) that a windowless box needs and a
 * desktop never asked for.
 */
import type { CliChannel } from '@main/channels/cli/channel'
import type { CliServer } from '@main/channels/cli/server'
import {
  CLI_SETTINGS,
  CLI_SETTING_GROUPS,
  CLI_SETTING_SECTIONS,
  coerceSettingValue,
  readPath,
  settingArgs,
  type CliSetting,
  type CliSettingGroup
} from '@main/channels/cli/settings'
import { autostartMechanism, isHeadlessHost, type AutostartMode } from '@main/autostart/autostart'
import {
  cliPathStatus,
  installCliPath,
  uninstallCliPath,
  type CliPathStatus
} from '@main/autostart/cli-path'
import type { MessageAttachmentType } from '@main/conversations'
import type { IpcHandler } from '@main/ipc-registry'
import type { ApprovalDecision } from '@main/runtime/amygdala'
import type { InterjectVerdict, Interjection } from '@main/runtime/agent/interjection'
import type { AskUserResponse } from '@main/runtime/cerebellum'
import { validateFile } from '@main/uploads/validation'
import { saveUploadFromFile } from '@main/uploads/uploads'
import { attachFilesToAutomation } from '@main/automations/files'
import { attachFilesToProject, listProjects, updateProject } from '@main/projects'
import { attachFilesToProcedure, listProcedures, updateProcedure } from '@main/procedures'
import {
  DIR_MARKER_RE,
  FILE_MARKER_RE,
  parseHeartbeatBlocks,
  splitMarkers
} from '@main/runtime/brainstem'
import { readViewerFile, writeViewerFile } from '@main/viewer'
import { getCliConfig, setCliConfig, type CliConfig } from '@main/workspace/workspace'
import { workspaceRoot } from '@main/workspace/root'
import { diskWriter } from '@main/io/diskWriter'
import { wlog } from '@main/workspace/logger'
import QRCode from 'qrcode'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const TAG = '[cli]'

/** One settings row, ready to print. */
export type CliSettingCard = {
  id: string
  group: CliSettingGroup
  /**
   * The card this row belongs to. Load-bearing, not decoration: labels are
   * card-scoped in the desktop, so four rows legitimately read "Verbose task
   * results" and only the section tells them apart.
   */
  section: string
  kind: CliSetting['kind']
  label: string
  description: string
  /** Current value, straight from the config snapshot. */
  value: unknown
  /** Rendered form of `value` — enum labels resolved, secrets already masked. */
  display: string
  /**
   * For settings whose real state lives outside config.json: what is ACTUALLY
   * registered. Only launchAtStartup has one, and it is the whole reason the
   * Linux autostart bug was invisible for so long.
   */
  actual?: string | null
  /**
   * The same fact as `actual`, as a boolean.
   *
   * `actual` is a display string, and the terminal used to decide whether to
   * flag a mismatch by regex-matching it — a test that broke the moment the
   * word changed. Compare booleans; render strings.
   */
  actualOk?: boolean | null
  options?: Array<{ value: string; label: string }>
  /** Units or bounds, shown in the prompt. */
  hint?: string | null
}

/** A settings page, as the CLI's page picker renders it. */
export type CliSettingGroupCard = {
  id: CliSettingGroup
  label: string
  count: number
  /** Cards on this page, in the desktop's own order. */
  sections: CliSettingSectionCard[]
  /** True when the page's content is a flow rather than rows (MCP, Usage, …). */
  interactive: boolean
}

/** One card on a page. */
export type CliSettingSectionCard = {
  id: string
  group: CliSettingGroup
  label: string
  count: number
}

/**
 * Show enough of a credential to recognise WHICH one is installed, never
 * enough to use it.
 *
 * The config snapshot carries these unmasked on purpose — the phone EDITS
 * them, and the tunnel is end-to-end sealed. A terminal is not that: whatever
 * `wolffish config` prints lands in scrollback, in a tmux buffer, in a
 * screen recording, and in whatever the user pastes when asking for help. So
 * the masking happens here, at the surface, rather than in the shared
 * assembler that the phone also depends on.
 */
export function maskSecret(value: string): string {
  if (value.length === 0) return '—'
  // Provider keys are prefixed (`sk-ant-`, `sk-`, `gsk_`) and the prefix is
  // the identifying half; the tail is the secret.
  //
  // Even a short value keeps its ends. A row of bare dots answers "is one
  // set?" and nothing else — not WHICH one, which is the question someone
  // staring at three credentials actually has. Below five characters there is
  // nothing to show that is not most of it.
  if (value.length < 5) return '•'.repeat(6)
  if (value.length <= 10) return `${value.slice(0, 2)}${'•'.repeat(6)}${value.slice(-2)}`
  return `${value.slice(0, 6)}${'•'.repeat(10)}${value.slice(-2)}`
}

function displayValue(
  setting: CliSetting,
  value: unknown,
  options?: CliSettingCard['options']
): string {
  if (value === undefined || value === null || value === '') return '—'
  if (setting.kind === 'boolean') return value === true ? 'On' : 'Off'
  if (setting.kind === 'enum') {
    const match = options?.find((o) => o.value === String(value))
    return match ? match.label : String(value)
  }
  if (setting.kind === 'secret') return maskSecret(String(value))
  return String(value)
}

/** `~/.wolffish/workspace/cli-state.json` — see the cli:kv* handlers. */
function cliStatePath(): string {
  return path.join(workspaceRoot(), 'cli-state.json')
}

async function readCliState(): Promise<Record<string, unknown>> {
  try {
    const raw = await fs.readFile(cliStatePath(), 'utf8')
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

export type CliIpcDeps = {
  handle: (channel: string, listener: IpcHandler) => void
  handlers: Map<string, IpcHandler>
  channel: CliChannel
  server: CliServer
  /** The phone's snapshot builder — the CLI's source for current values. */
  snapshot: () => Promise<Record<string, unknown>>
  /** Broadcast a config change, so open panels + the phone stay in step. */
  broadcast: (channel: string, payload: unknown) => void
  /**
   * Everything `wolffish status` prints that isn't config. `callerPath` is the
   * asking terminal's own PATH, when it has one — a daemon under systemd or
   * launchd cannot answer "is the command on your PATH" from its own.
   */
  status: (callerPath?: string | null) => Promise<Record<string, unknown>>
  /**
   * Stop a turn this channel does not own — a channel reply, an automation, a
   * procedure run. Same fallthrough the desktop's Stop button uses.
   */
  cancelAnywhere: (conversationId: string) => Promise<boolean>
  /** Binary a service manager should launch, and the client entry it runs. */
  execPath: string
  cliEntry: string
  /**
   * The ONE autostart dispatcher, shared with the Wolffish tab's toggle. Each
   * call moves both halves together — the stored `launchAtStartup` intent and
   * the OS registration — and knows about the Electron login item, which the
   * autostart module deliberately does not.
   */
  autostart: {
    enable: () => Promise<AutostartFacts>
    disable: () => Promise<AutostartFacts>
    read: () => Promise<AutostartFacts>
  }
}

export type AutostartFacts = {
  active: boolean
  mechanism: string
  warning: string | null
  location: string | null
}

export function registerCliIpc(deps: CliIpcDeps): void {
  const { handle, channel, server } = deps

  // ── Settings, as printable cards ─────────────────────────────────────────
  // The trailing argument older clients passed (a locale) is accepted and
  // ignored: the CLI is an English surface, and the table's own words are
  // final. See settings.ts.
  handle('cli:describeSettings', async (): Promise<CliSettingCard[]> => {
    const snapshot = await deps.snapshot()

    return CLI_SETTINGS.map((setting) => {
      const options = setting.options?.map((option) => ({
        value: option.value,
        label: option.label
      }))
      const raw = readPath(snapshot, setting.read)
      // A credential never leaves this function intact — not in `display`, and
      // not in `value` either. `value` is what `--json` prints, so leaving the
      // real key there would defeat the masking entirely the moment anyone
      // piped the output. Null when unset keeps the "is it configured?" test
      // (`card.value ? …`) working without carrying the secret.
      const value =
        setting.kind === 'secret'
          ? typeof raw === 'string' && raw.length > 0
            ? maskSecret(raw)
            : null
          : raw
      const card: CliSettingCard = {
        id: setting.id,
        group: setting.group,
        section: setting.section,
        kind: setting.kind,
        label: setting.label,
        description: setting.description ?? '',
        hint: setting.hint ?? null,
        value,
        display: displayValue(setting, raw, options),
        options
      }
      if (setting.actualRead) {
        const actual = readPath(snapshot, setting.actualRead)
        card.actualOk = actual === undefined ? null : actual === true
        card.actual = actual === undefined ? null : actual === true ? 'Active' : 'Inactive'
      }
      return card
    })
  })

  /**
   * Write one setting by id. Routed to the SAME handler the desktop panel
   * calls, so a CLI write and a UI write are one code path — including the
   * broadcast that tells every other open surface.
   */
  handle(
    'cli:setSetting',
    async (
      _e,
      payload: { id: string; value: string }
    ): Promise<{ ok: true } | { ok: false; error: string }> => {
      const setting = CLI_SETTINGS.find((s) => s.id === payload?.id)
      if (!setting) return { ok: false, error: `unknown setting: ${payload?.id}` }
      const coerced = coerceSettingValue(setting, String(payload.value ?? ''))
      if (!coerced.ok) return { ok: false, error: coerced.error }
      const handler = deps.handlers.get(setting.channel)
      if (!handler) return { ok: false, error: `no handler for ${setting.channel}` }
      try {
        await handler(null, ...settingArgs(setting, coerced.value))
        return { ok: true }
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) }
      }
    }
  )

  /**
   * The settings PAGES and their CARDS, named exactly as the app's own tabs
   * and sub-tabs are. The CLI's picker mirrors the desktop's nav rather than
   * inventing a second taxonomy — someone who knows where a setting lives in
   * the window can find it here, and the card is what makes a row's label
   * ("Status", "Show all tool activity") mean something on its own.
   */
  handle('cli:settingGroups', async (): Promise<CliSettingGroupCard[]> => {
    return CLI_SETTING_GROUPS.map((group) => ({
      id: group.id,
      label: group.label,
      count: CLI_SETTINGS.filter((s) => s.group === group.id).length,
      interactive: group.interactive === true,
      sections: CLI_SETTING_SECTIONS.filter((section) => section.group === group.id).map(
        (section) => ({
          id: section.id,
          group: section.group,
          label: section.label,
          count: CLI_SETTINGS.filter((s) => s.section === section.id).length
        })
      )
    }))
  })

  /**
   * The raw config snapshot. `cli:describeSettings` covers the scalar rows;
   * this is for the list-shaped state a table can't model (which provider is
   * the Brain, connected services, capability roster).
   */
  handle('cli:snapshot', () => deps.snapshot())

  // ── The CLI channel's own preferences ────────────────────────────────────
  handle('cli:getConfig', (): Promise<CliConfig> => getCliConfig())
  handle('cli:setConfig', async (_e, patch: Partial<CliConfig>) => {
    await setCliConfig(patch ?? {})
    const config = await getCliConfig()
    deps.broadcast('cli:configChange', config)
    return { ok: true as const, config }
  })

  /**
   * The terminal's own small state — theme, prompt history, recent models,
   * which hints have been dismissed. The client holds none of it on disk:
   * the daemon owns `~/.wolffish`, so the daemon owns this file too, and a
   * terminal on another machine (SSH) sees the same preferences.
   *
   * One JSON object, read-modify-written under the disk writer's per-file
   * queue. Values are opaque to the daemon.
   */
  handle('cli:kvGet', async (): Promise<Record<string, unknown>> => readCliState())
  handle('cli:kvSet', async (_e, patch: Record<string, unknown>) => {
    const next = { ...(await readCliState()), ...(patch ?? {}) }
    for (const [key, value] of Object.entries(next)) if (value === null) delete next[key]
    await diskWriter.writeFileAtomic(cliStatePath(), JSON.stringify(next, null, 2))
    return { ok: true as const }
  })

  // ── Turns ────────────────────────────────────────────────────────────────
  handle(
    'cli:send',
    async (
      _e,
      payload: {
        text: string
        conversationId?: string | null
        attachmentPaths?: string[]
        workingFolders?: string[]
        projectId?: string | null
        thinkingMode?: 'off' | 'on' | 'high' | 'max'
        modeOverride?: 'single' | 'workflow'
        /** Plan mode: read-only turn that may only write its plan file (`wolffish --plan`). */
        planMode?: boolean
      }
    ) => {
      const attachments = payload?.attachmentPaths?.length
        ? await stageAttachments(payload.attachmentPaths, payload.conversationId ?? null)
        : []
      return channel.send({
        text: String(payload?.text ?? ''),
        conversationId: payload?.conversationId ?? null,
        attachments,
        workingFolders: payload?.workingFolders,
        planMode: payload?.planMode === true,
        projectId: payload?.projectId ?? null,
        thinkingMode: payload?.thinkingMode,
        modeOverride: payload?.modeOverride
      })
    }
  )

  /**
   * A message typed while the turn runs. Attachments stage through the same
   * helper `cli:send` uses, then the runner parks the message for the agent's
   * next stop point. `no_live_turn` tells the terminal to send normally.
   */
  handle(
    'cli:interject',
    async (
      _e,
      payload: {
        conversationId?: string | null
        messageId: string
        text: string
        attachmentPaths?: string[]
      }
    ): Promise<InterjectVerdict> => {
      const conversationId = payload?.conversationId ?? null
      if (!conversationId) return { status: 'no_live_turn' }
      const attachments = payload?.attachmentPaths?.length
        ? await stageAttachments(payload.attachmentPaths, conversationId)
        : []
      return channel.interject({
        conversationId,
        messageId: String(payload?.messageId ?? ''),
        text: String(payload?.text ?? ''),
        attachments
      })
    }
  )

  handle(
    'cli:withdrawInterjection',
    (_e, payload: { conversationId: string; messageId: string }): { ok: boolean } => ({
      ok: channel.withdrawInterjection(
        String(payload?.conversationId ?? ''),
        String(payload?.messageId ?? '')
      )
    })
  )

  handle('cli:pendingInterjections', (_e, conversationId: string): Interjection[] =>
    conversationId ? channel.pendingInterjections(String(conversationId)) : []
  )

  /**
   * Stop a turn — whichever surface started it.
   *
   * The CLI channel only knows its OWN turns, so this used to be able to stop
   * a terminal run and nothing else. But `wolffish status` lists every active
   * run on the box, including automations and channel replies, and on a
   * headless machine the terminal is the only place a runaway one can be
   * stopped from: a list you cannot act on is worse than no list. `deps.cancel`
   * is the same cross-channel fallthrough the desktop's Stop button uses —
   * this channel first, then the runner, then autonomous runs.
   */
  handle('cli:cancel', async (_e, conversationId?: string | null) => {
    const mine = await channel.cancel(conversationId)
    if (mine.canceled || !conversationId) return mine
    return { canceled: await deps.cancelAnywhere(conversationId) }
  })

  handle('cli:approvalRespond', (_e, payload: { id: string; decision: ApprovalDecision }) => ({
    ok: channel.respondApproval(payload?.id, payload?.decision)
  }))

  handle('cli:askRespond', (_e, payload: { id: string; response: AskUserResponse }) => ({
    ok: channel.respondAsk(payload?.id, payload?.response)
  }))

  handle('cli:pendingRequests', () => channel.pendingRequests())

  /**
   * Stage a file the user named by path. This is the whole of "file upload" in
   * the CLI: the bytes are already on the machine the agent runs on, so the
   * work is a validated copy into the conversation's uploads folder — the same
   * one the composer's drag-and-drop performs.
   */
  handle(
    'cli:attach',
    async (
      _e,
      payload: { conversationId: string; paths: string[] }
    ): Promise<
      | { ok: true; attachments: Awaited<ReturnType<typeof stageAttachments>> }
      | { ok: false; error: string }
    > => {
      try {
        const attachments = await stageAttachments(payload.paths, payload.conversationId)
        return { ok: true, attachments }
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) }
      }
    }
  )

  // ── Attached files and working folders ───────────────────────────────────
  /**
   * The three things that carry files and folders — a project, a procedure, an
   * automation — reached by PATH instead of by a native picker.
   *
   * The desktop's `projects:pickFiles` / `procedures:pickFiles` /
   * `automations:pickFiles` all open a dialog, which is a WebContents away
   * from a terminal and simply absent on a headless box. Underneath the dialog
   * each already has a path-based attach; these two handlers are that half,
   * exposed. The copy rule, the collision naming and the workspace ownership
   * are the shared ones (uploads/owned-copies.ts) — this adds a door, not a
   * second way of attaching.
   *
   * Automations are the odd one: heartbeat.md IS their store, so the copy and
   * the `file:` marker have to land together or a run sees neither. Both halves
   * happen here, through main's own parser — the terminal never does markdown
   * surgery on the schedule file.
   */
  handle(
    'cli:ownerFiles',
    async (
      _e,
      payload: { owner: OwnerKind; id: string; attach?: string[]; detach?: string[] }
    ): Promise<OwnerFilesResult> => {
      const { owner, id } = payload
      const attach = payload.attach ?? []
      const detach = payload.detach ?? []

      if (owner === 'automation') return automationFiles(id, attach, detach)

      const current = await findOwner(owner, id)
      if (!current) return { ok: false, error: `${owner} not found: ${id}` }

      let files = (current.files ?? []).slice()
      let skipped: string[] = []
      let missing: string[] = []

      if (attach.length > 0) {
        const result =
          owner === 'project'
            ? await attachFilesToProject(id, attach)
            : await attachFilesToProcedure(id, attach)
        files = (result.added ?? []).length > 0 ? await reloadFiles(owner, id) : files
        skipped = result.skipped ?? []
        missing = result.missing ?? []
      }

      if (detach.length > 0) {
        // Matched on NAME as well as path: the listing prints names, and a
        // name is what someone reads back to the terminal.
        const wanted = new Set(detach.map((entry) => entry.toLowerCase()))
        files = files.filter(
          (file) =>
            !wanted.has(file.name.toLowerCase()) && !wanted.has(String(file.path).toLowerCase())
        )
        if (owner === 'project') await updateProject({ id, files })
        else await updateProcedure({ id, files })
      }

      return {
        ok: true,
        files,
        directories: (await findOwner(owner, id))?.directories ?? [],
        skipped,
        missing
      }
    }
  )

  handle(
    'cli:ownerFolders',
    async (
      _e,
      payload: { owner: OwnerKind; id: string; add?: string[]; remove?: string[] }
    ): Promise<OwnerFilesResult> => {
      const { owner, id } = payload
      const add = (payload.add ?? []).map((entry) => resolveUserPath(entry))
      const remove = payload.remove ?? []

      if (owner === 'automation') return automationFolders(id, add, remove)

      const current = await findOwner(owner, id)
      if (!current) return { ok: false, error: `${owner} not found: ${id}` }

      // Folders are REFERENCES, never copies — but a reference to something
      // that is not a folder is a run that fails later for a reason nobody can
      // see from the listing, so they are checked now.
      const missing: string[] = []
      const kept: string[] = []
      for (const entry of add) {
        const stat = await fs.stat(entry).catch(() => null)
        if (stat?.isDirectory()) kept.push(entry)
        else missing.push(entry)
      }
      const removing = new Set(remove.map((entry) => resolveUserPath(entry)))
      const directories = [
        ...(current.directories ?? []).filter((dir) => !removing.has(dir) && !remove.includes(dir)),
        ...kept.filter((dir) => !(current.directories ?? []).includes(dir))
      ]
      if (owner === 'project') await updateProject({ id, directories })
      else await updateProcedure({ id, directories })
      return { ok: true, files: current.files ?? [], directories, skipped: [], missing }
    }
  )

  // ── Pairing ──────────────────────────────────────────────────────────────
  /**
   * The module matrix for a QR the terminal wants to draw.
   *
   * The CLI ships as loose source next to app.asar, so its own
   * `import('qrcode')` fails in every packaged install: ESM resolution walks
   * the real directories above resources/cli and never enters the archive.
   * This process runs from inside the archive, where the dependency resolves,
   * so the daemon computes the matrix and the terminal only draws it. Rows
   * travel as '1'/'0' strings — JSON-friendly on the socket, and unambiguous
   * about orientation in a way a flat bit array was not.
   *
   * Level L to match the CLI's own local path: the code is read off a screen,
   * not a crumpled receipt, and the smaller matrix is what keeps it inside a
   * terminal window (see printQr in pair.mjs, which measures before drawing).
   */
  handle(
    'cli:qrMatrix',
    (
      _e,
      text: string
    ): { ok: true; size: number; rows: string[] } | { ok: false; error: string } => {
      try {
        const qr = QRCode.create(String(text ?? ''), { errorCorrectionLevel: 'L' })
        const size = qr.modules.size
        const data = qr.modules.data
        const rows: string[] = []
        for (let y = 0; y < size; y++) {
          let row = ''
          for (let x = 0; x < size; x++) row += data[y * size + x] ? '1' : '0'
          rows.push(row)
        }
        return { ok: true, size, rows }
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) }
      }
    }
  )

  // ── Status ───────────────────────────────────────────────────────────────
  handle('cli:status', async (_e, callerPath?: string | null) => ({
    ...(await deps.status(callerPath)),
    cli: {
      socket: server.isListening(),
      clients: server.clientCount(),
      pid: process.pid
    }
  }))

  // ── Autostart (the Linux fix, and the headless story everywhere) ─────────
  /**
   * Autostart. This panel and the Wolffish tab's "Launch at startup" toggle
   * are TWO CONTROLS OVER ONE REGISTRATION, so they share one dispatcher
   * (deps.autostart, defined in index.ts) rather than each reaching for the
   * autostart module directly. Two reasons, both learned the hard way:
   *
   *  - Only the dispatcher knows that a GUI install on macOS/Windows uses
   *    Electron's own login item, which lives outside this module entirely.
   *    Calling autostartStatus() straight would report "not registered" on a
   *    Mac whose login item is registered — a confident, wrong answer.
   *  - Both halves have to move together: the stored intent
   *    (`config.launchAtStartup`) AND the OS registration. Writing one leaves
   *    the two screens disagreeing, and the disagreement stays invisible until
   *    a reboot settles which was telling the truth.
   *
   * What genuinely belongs to THIS screen is `mode` — whether "start
   * automatically" means a login item (needs a desktop session, opens a
   * window) or a background service (starts with the machine, no session, no
   * window). That choice only matters to someone running headless.
   */
  handle('service:status', async () => {
    const mode = await runMode()
    return { ...(await deps.autostart.read()), mode }
  })

  /**
   * The three writers below announce on `preferences:changed`, the same signal
   * `runtime:setLaunchAtStartup` fires — because they change the same thing.
   *
   * Returning the new status only tells the surface that asked. Everything
   * else that renders this registration was left stale: the Wolffish tab's
   * "Launch at startup" row (which listens for exactly this and is the reason
   * the CLI panel claims the two move as one), a CLI panel in a second window,
   * an attached terminal, and the phone — whose Channels → CLI card reports
   * `serviceActive` and `runMode`, and learns about config changes through the
   * generic config.changed push this broadcast triggers.
   */
  handle('service:install', async (_e, requested?: AutostartMode) => {
    /**
     * Switching mode tears the OLD registration down first.
     *
     * `service:setMode` already did this; `service:install --headless` did
     * not, so a box that had been registered as a login item and was then
     * installed as a service ended up with BOTH — two registrations racing to
     * launch the app at boot, and an uninstall later removing only one of
     * them.
     */
    if (requested && requested !== (await runMode())) {
      if ((await deps.autostart.read()).active) await deps.autostart.disable()
    }
    if (requested) await setCliConfig({ runMode: requested })
    const status = await deps.autostart.enable()
    const mode = await runMode()
    deps.broadcast('preferences:changed', { launchAtStartup: true })
    return { ...status, mode }
  })

  handle('service:uninstall', async () => {
    const status = await deps.autostart.disable()
    const mode = await runMode()
    deps.broadcast('preferences:changed', { launchAtStartup: false })
    return { ...status, mode }
  })

  /**
   * Change the mechanism without changing whether autostart is on. The old
   * registration is torn down BEFORE the new one is written, so switching
   * from a login item to a service unit can never leave both registered and
   * racing to launch the app twice.
   */
  handle('service:setMode', async (_e, mode: AutostartMode) => {
    const previous = await runMode()
    // No write, so no announcement: a broadcast here would have every surface
    // refetch on a tap that changed nothing.
    if (previous === mode) return { ...(await deps.autostart.read()), mode }
    const wasActive = (await deps.autostart.read()).active
    if (wasActive) await deps.autostart.disable()
    await setCliConfig({ runMode: mode })
    const status = wasActive ? await deps.autostart.enable() : await deps.autostart.read()
    // Deliberately WITHOUT `launchAtStartup`: this switches the mechanism, not
    // the setting, and the only value available here is the OS REGISTRATION,
    // which is a different claim — the two disagree exactly when a
    // registration failed, which is the case this whole panel exists to make
    // visible. Naming what actually changed keeps every listener refetching
    // (that is all any of them do with this signal) without asserting
    // something about a setting nobody touched.
    deps.broadcast('preferences:changed', { runMode: mode })
    return { ...status, mode }
  })

  /**
   * What each mode WOULD register on this machine, plus whether the host even
   * has a desktop session. The panel uses it to label the two choices with the
   * real mechanism (`launchd` / `systemd` / `schtasks`) instead of generic
   * words, and to recommend the service on a box with no display.
   */
  handle('service:mechanism', async () => ({
    gui: autostartMechanism('gui'),
    headless: autostartMechanism('headless'),
    current: autostartMechanism(await runMode()),
    headlessHost: isHeadlessHost()
  }))

  // ── PATH ─────────────────────────────────────────────────────────────────
  // The caller's PATH, when it has one to give — a terminal knows whether the
  // shim resolves; a service-managed daemon's own environment does not.
  handle(
    'cli:pathStatus',
    (_e, callerPath?: string | null): Promise<CliPathStatus> => cliPathStatus(callerPath)
  )
  handle('cli:installPath', async (): Promise<CliPathStatus> => {
    const status = await installCliPath(deps.execPath, deps.cliEntry)
    deps.broadcast('cli:pathChanged', status)
    return status
  })
  handle('cli:uninstallPath', async (): Promise<CliPathStatus> => {
    const status = await uninstallCliPath()
    deps.broadcast('cli:pathChanged', status)
    return status
  })
  handle('cli:entryPath', () => ({
    execPath: deps.execPath,
    entry: deps.cliEntry,
    binary: deps.cliEntry
  }))

  wlog.info(TAG, 'ipc registered')
}

async function runMode(): Promise<AutostartMode> {
  const config = await getCliConfig()
  return config.runMode === 'headless' ? 'headless' : 'gui'
}

// ── The three owners of files and folders ──────────────────────────────────

export type OwnerKind = 'project' | 'procedure' | 'automation'

export type OwnerFilesResult =
  | {
      ok: true
      files: Array<{ path: string; name: string }>
      directories: string[]
      /** Sources already attached under that name — not copied again. */
      skipped: string[]
      /** Sources that are not there, or folders that are not folders. */
      missing: string[]
    }
  | { ok: false; error: string }

const HEARTBEAT = 'brain/brainstem/heartbeat.md'

async function findOwner(
  owner: OwnerKind,
  id: string
): Promise<{ files?: Array<{ path: string; name: string }>; directories?: string[] } | null> {
  const list = owner === 'project' ? await listProjects() : await listProcedures()
  return list.find((entry) => entry.id === id) ?? null
}

async function reloadFiles(
  owner: OwnerKind,
  id: string
): Promise<Array<{ path: string; name: string }>> {
  return (await findOwner(owner, id))?.files ?? []
}

/**
 * One automation's block, located by its heading.
 *
 * `parseHeartbeatBlocks` is main's own reader — the same one the scheduler
 * runs on — so a block found here is a block the scheduler agrees exists.
 */
async function findAutomationBlock(
  label: string
): Promise<{ raw: string; block: string; files: string[]; dirs: string[] } | null> {
  const raw = await readViewerFile(HEARTBEAT).catch(() => '')
  if (!raw) return null
  const blocks = parseHeartbeatBlocks(raw)
  const needle = label.trim().toLowerCase()
  const found =
    blocks.find((entry) => entry.label.trim().toLowerCase() === needle) ??
    blocks.find((entry) => entry.label.trim().toLowerCase().includes(needle))
  if (!found) return null
  const { files, dirs } = splitMarkers(found.block)
  return { raw, block: found.block, files, dirs }
}

/**
 * Rewrite one block's `file:`/`dir:` markers, leaving every other line — the
 * heading, the other markers, the prompt — exactly as it was.
 *
 * Replacement is positional rather than regenerative: the block is rebuilt as
 * "the lines that were not file/dir markers, with the new marker set spliced in
 * where the old ones began". Regenerating the whole block from parsed parts
 * would silently normalise a user's own formatting on every attach.
 */
async function writeAutomationMarkers(
  found: { raw: string; block: string },
  files: string[],
  dirs: string[]
): Promise<void> {
  const isMarker = (line: string): boolean =>
    FILE_MARKER_RE.test(line.trim()) || DIR_MARKER_RE.test(line.trim())
  const kept = found.block.split('\n').filter((line) => !isMarker(line))

  // Straight after the last `mode:`/`project:`/`icon:` line, which is where
  // the dialog writes them — so a block edited from both surfaces reads the
  // same. With no settings at all they lead the block.
  let insertAt = 0
  for (const [index, line] of kept.entries()) {
    if (isSettingLine(line)) insertAt = index + 1
    else if (line.trim() !== '') break
  }

  const markers = [...files.map((file) => `file: ${file}`), ...dirs.map((dir) => `dir: ${dir}`)]
  const next = [...kept.slice(0, insertAt), ...markers, ...kept.slice(insertAt)].join('\n')
  await writeViewerFile(HEARTBEAT, found.raw.replace(found.block, next))
}

const isSettingLine = (line: string): boolean => /^(mode|project|icon):\s*\S/i.test(line.trim())

async function automationFiles(
  label: string,
  attach: string[],
  detach: string[]
): Promise<OwnerFilesResult> {
  const found = await findAutomationBlock(label)
  if (!found) return { ok: false, error: `automation not found: ${label}` }

  let files = found.files.slice()
  let skipped: string[] = []
  let missing: string[] = []

  if (attach.length > 0) {
    // The copy first, the marker second: a copy with no marker is swept by the
    // prune grace window, while a marker with no copy is a run that cannot
    // read its own attachment.
    const result = await attachFilesToAutomation(files, attach)
    files = [...files, ...result.added.map((ref) => ref.path)]
    skipped = result.skipped
    missing = result.missing
  }
  if (detach.length > 0) {
    const wanted = new Set(detach.map((entry) => entry.toLowerCase()))
    files = files.filter(
      (file) => !wanted.has(file.toLowerCase()) && !wanted.has(path.basename(file).toLowerCase())
    )
  }

  await writeAutomationMarkers(found, files, found.dirs)
  return {
    ok: true,
    files: files.map((file) => ({ path: file, name: path.basename(file) })),
    directories: found.dirs,
    skipped,
    missing
  }
}

async function automationFolders(
  label: string,
  add: string[],
  remove: string[]
): Promise<OwnerFilesResult> {
  const found = await findAutomationBlock(label)
  if (!found) return { ok: false, error: `automation not found: ${label}` }

  const missing: string[] = []
  const kept: string[] = []
  for (const entry of add) {
    const stat = await fs.stat(entry).catch(() => null)
    if (stat?.isDirectory()) kept.push(entry)
    else missing.push(entry)
  }
  const removing = new Set(remove.map((entry) => resolveUserPath(entry)))
  const dirs = [
    ...found.dirs.filter((dir) => !removing.has(dir) && !remove.includes(dir)),
    ...kept.filter((dir) => !found.dirs.includes(dir))
  ]
  await writeAutomationMarkers(found, found.files, dirs)
  return {
    ok: true,
    files: found.files.map((file) => ({ path: file, name: path.basename(file) })),
    directories: dirs,
    skipped: [],
    missing
  }
}

/**
 * Validate then copy each path into the conversation's uploads folder.
 * Validation is the same call the composer makes, so the CLI inherits the
 * per-message file count and byte ceilings rather than inventing its own.
 */
async function stageAttachments(
  paths: string[],
  conversationId: string | null
): Promise<
  Array<{
    type: MessageAttachmentType
    filePath: string
    originalName: string
    mimeType: string
    sizeBytes: number
  }>
> {
  if (!conversationId) throw new Error('conversationId is required to attach files')
  const staged: Array<{
    type: MessageAttachmentType
    filePath: string
    originalName: string
    mimeType: string
    sizeBytes: number
  }> = []
  let totalBytes = 0
  for (const raw of paths) {
    const absolute = resolveUserPath(raw)
    const stat = await fs.stat(absolute)
    if (!stat.isFile()) throw new Error(`not a file: ${absolute}`)
    const invalid = validateFile(path.basename(absolute), stat.size, staged.length, totalBytes)
    if (invalid) throw new Error(`${path.basename(absolute)}: ${invalid.code}`)
    const meta = await saveUploadFromFile(conversationId, absolute, path.basename(absolute))
    totalBytes += meta.sizeBytes
    staged.push({
      type: meta.type,
      filePath: meta.filePath,
      originalName: meta.originalName,
      mimeType: meta.mimeType,
      sizeBytes: meta.sizeBytes
    })
  }
  return staged
}

/** Accept `~/…` and relative paths the way every other Wolffish path input does. */
function resolveUserPath(raw: string): string {
  const trimmed = raw.trim()
  if (trimmed === '~') return os.homedir()
  if (trimmed.startsWith('~/') || trimmed.startsWith('~\\')) {
    return path.join(os.homedir(), trimmed.slice(2))
  }
  return path.resolve(trimmed)
}
