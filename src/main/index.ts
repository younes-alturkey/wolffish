process.noDeprecation = true

import { electronApp, is, optimizer } from '@electron-toolkit/utils'
import { attachFilesToAutomation, removeAutomationFile } from '@main/automations/files'
import { projectFoldersFor } from '@main/uploads/project-folders'
import { installAttention } from '@main/attention'
import { braveService, type BraveStatus, type BraveTestResult } from '@main/brave'
import { turnRouter } from '@main/channels/channel'
import { collectChannelStatus } from '@main/channels/status'
import { normalizeReasoningMode, reasoningModesFor } from '@main/runtime/reasoning'
import { getPlanMode, onPlanModeChange, setPlanMode } from '@main/runtime/plan-mode'
import { ElectronChannel } from '@main/channels/electron/channel'
import {
  openBrowserUrl,
  type DoctorOptions,
  type FixOptions
} from '@main/channels/extension/doctor'
import { ExtensionServer } from '@main/channels/extension/server'
import { MobileChannel } from '@main/channels/mobile/channel'
import {
  CUSTOMIZATION_DOCS,
  CUSTOMIZATION_MAX_BYTES,
  THINKING_MODES,
  parseAllowedNumbers,
  parseAllowedUserIds,
  type CustomizationDoc
} from '@main/channels/mobile/snapshot'
import { TelegramChannel } from '@main/channels/telegram/channel'
import { TurnRunner, type ActiveRun } from '@main/channels/turn-runner'
import {
  reconcileAll,
  reconcileConversation,
  type ReconcilerDeps
} from '@main/channels/interjection-reconciler'
import {
  forgetConversationPark,
  parkedInterjections,
  releaseHeldInterjection
} from '@main/channels/interjection-store'
import type { Interjection } from '@main/runtime/agent/interjection'
import { WhatsAppChannel } from '@main/channels/whatsapp/channel'
import {
  countConversationsSince,
  createConversation,
  deleteConversation,
  idFromFilename,
  listConversations,
  loadConversation,
  mergeConversationOnto,
  mintMessageId,
  updateConversation,
  type ConversationFile,
  type ConversationMessage,
  type ConversationMeta,
  type MessageAttachment
} from '@main/conversations'
import { turnScope } from '@main/runtime/corpus'
import { countdowns } from '@main/runtime/countdown'
import { waits } from '@main/runtime/wait'
import { registerCountdownCapability } from '@main/runtime/countdown-capability'
import { registerCheckInCapability } from '@main/runtime/check-in-capability'
import { checkIns } from '@main/runtime/check-in'
import { processManager } from '@main/processes/instance'
import { registerProcessesCapability } from '@main/processes/tools'
import { isLive as isProcessLive } from '@main/processes/types'
import { browserTabs } from '@main/browser/tab-manager'
import { registerPreviewCapability } from '@main/browser/tools'
import { flushBrowserCookies } from '@main/browser/session'
import type {
  BrowserFps,
  BrowserInputEvent,
  BrowserPartition,
  BrowserRect,
  BrowserTabMode
} from '@main/browser/types'
import type { TaskSnapshot } from '@main/runtime/broca'
import { checkVideoService, videoTasks } from '@main/runtime/video-tasks'
import { getDataAnalytics, type DataAnalytics } from '@main/data'
import {
  copyDiagnosticArchive,
  exportConversationDiagnostics,
  type DiagnosticProgress,
  type DiagnosticResult
} from '@main/diagnostics'
import { githubService, type GitHubStatus, type GitHubTestResult } from '@main/github'
import {
  getSttInstallState,
  getTtsInstallState,
  installStt,
  installTts,
  sttStatus,
  ttsStatus,
  type EngineInstallProgress,
  type EngineInstallResult,
  type EngineRuntimeState,
  type EngineStatus
} from '@main/voice-engines'
import {
  googleService,
  type GoogleAuthResult,
  type GoogleBinaryStatus,
  type GoogleCredentialsResult,
  type GoogleSetupResult,
  type GoogleSetupState,
  type GoogleStatus,
  type GoogleUpdateResult
} from '@main/google'
import { CliChannel } from '@main/channels/cli/channel'
import { CliServer } from '@main/channels/cli/server'
import { registerCliIpc, type AutostartFacts } from '@main/channels/cli/ipc'
import { stableExecPath } from '@main/autostart/appimage'
import { cliEntryPath, cliPathStatus, installCliPath } from '@main/autostart/cli-path'
import {
  autostartMechanism,
  autostartStatus,
  installAutostart,
  uninstallAutostart,
  type AutostartMode
} from '@main/autostart/autostart'
import { handle, ipcHandlers } from '@main/ipc-registry'
import { acquireLock, releaseLockSync } from '@main/lockfile'
import { memesService, type MemesStatus, type MemesTestResult } from '@main/memes'
import { notionService, type NotionStatus, type NotionTestResult } from '@main/notion'
import { configureSummarizer, queueConversationSummarization } from '@main/conversation-summarizer'
import {
  attachFilesToProcedure,
  createProcedure,
  deleteProcedure,
  listProcedures,
  setProceduresChangedListener,
  updateProcedure,
  type ProcedureFileRef
} from '@main/procedures'
import {
  attachFilesToProject,
  createProject,
  deleteProject,
  listProjects,
  setProjectsChangedListener,
  updateProject,
  type ProjectFileRef
} from '@main/projects'
import {
  defaultModelsFolder,
  detect as detectOllama,
  enrichWithDetails,
  isOllamaInstalled,
  listTags,
  platformInstallUrl,
  pullModel,
  scanModelManifests,
  startOllama,
  startOllamaWatch,
  type OllamaPullStatus,
  type OllamaSnapshot
} from '@main/ollama'
import { diskWriter } from '@main/io/diskWriter'
import { Agent } from '@main/runtime/agent'
import type { ApprovalDecision } from '@main/runtime/amygdala'
import { nextCronMs, previewSchedule } from '@main/runtime/brainstem'
import { COMPACTION_THRESHOLD } from '@main/runtime/compactor'
import type { AskUserResponse } from '@main/runtime/cerebellum'
import { LOCKED_CAPABILITIES, WOLFFISH_AUTHOR } from '@main/runtime/cerebellum'
import {
  isKnowledgeTarget,
  KNOWLEDGE_TARGETS,
  KnowledgeStore,
  type EntrySource
} from '@main/runtime/knowledge'
import { deleteCapabilityFolder, importCapability } from '@main/runtime/capabilityImport'
import { McpManager } from '@main/runtime/mcp/manager'
import type { McpAddInput, McpHeader } from '@main/runtime/mcp/types'
import { MODEL_CATALOG } from '@main/runtime/models'
import { localProvider } from '@main/runtime/providers/local'
import { sudoSession } from '@main/runtime/sudoSession'
import type { CloudProviderConfig } from '@main/runtime/thalamus'
import { Thalamus } from '@main/runtime/thalamus'
import type { TimeRange as UsageTimeRange } from '@main/runtime/usage'
import { cloudModelSupportsVision } from '@main/runtime/vision'
import { detectSystem, type SystemInfo } from '@main/system'
import {
  checkForUpdatesIfEnabled,
  getUpdaterState,
  initUpdater,
  installUpdate,
  installFailed,
  isUpdateReady,
  markInstalling,
  onUpdaterState,
  stageUpdate,
  stampPreUpdateVersion,
  type UpdaterState
} from '@main/updater'
import type { UpdaterWireState } from '@main/tunnel/protocol'
import { renderDeckPreview, type DeckPreview } from '@main/uploads/deck-preview'
import {
  classifyFile,
  isSupportedExtension,
  readUpload,
  resolveUploadPath,
  saveUpload,
  saveUploadFromBuffer,
  statUpload,
  uploadExists,
  type UploadedFileMetadata
} from '@main/uploads/uploads'
import { categorizeFile, validateFile, type ValidationError } from '@main/uploads/validation'
import {
  hasBundledDefault,
  readBundledDefault,
  readViewerBinaryFile,
  readViewerFile,
  readViewerTree,
  resolveViewerPath,
  statViewerFile,
  writeViewerFile,
  type ViewerTreeNode
} from '@main/viewer'
import { wlog } from '@main/workspace/logger'
import {
  bundledCapabilityNames,
  ensureWorkspace,
  extensionFolderPath,
  factoryReset,
  getBraveConfig,
  getBrowserExtensionConfig,
  getCompactionConfig,
  getComputerUseConfig,
  getGitHubConfig,
  getReflectionConfig,
  normalizeReflectionConfig,
  getCliConfig,
  getGoogleConfig,
  getInAppConfig,
  getMemesConfig,
  getMobileChannelConfig,
  setMobileChannelConfig as persistMobileChannelConfig,
  getVideoConfig,
  setVideoConfig,
  getNotionConfig,
  getStatus,
  getSttConfig,
  getTelegramConfig,
  getTtsConfig,
  getVariables,
  getWhatsAppConfig,
  lockfilePath,
  markOnboardingComplete,
  patchConfig,
  setBlockCredentials as persistBlockCredentials,
  setBrain as persistBrain,
  setMode as persistMode,
  setBraveConfig as persistBraveConfig,
  setBrowserExtensionConfig as persistBrowserExtensionConfig,
  setBypassPermissions as persistBypassPermissions,
  setCliConfig as persistCliConfig,
  setCompactionConfig as persistCompactionConfig,
  setReflectionConfig as persistReflectionConfig,
  setGitHubConfig as persistGitHubConfig,
  setGoogleConfig as persistGoogleConfig,
  setInAppConfig as persistInAppConfig,
  setLaunchAtStartup as persistLaunchAtStartup,
  setLocale as persistLocale,
  setLocalOnly as persistLocalOnly,
  setMemesConfig as persistMemesConfig,
  setNotionConfig as persistNotionConfig,
  setRestrictPowerfulModels as persistRestrictPowerfulModels,
  setSttConfig as persistSttConfig,
  setTelegramConfig as persistTelegramConfig,
  setTheme as persistTheme,
  setThinkingMode as persistThinkingMode,
  setTtsConfig as persistTtsConfig,
  setVariables as persistVariables,
  setWeekStartsOn as persistWeekStartsOn,
  setWhatsAppConfig as persistWhatsAppConfig,
  readConfig,
  reconcileLocalModel,
  removeCloudProvider,
  selectLocalModel,
  setCloudProvider,
  workspaceRoot,
  type BraveConfig,
  type BrowserExtensionConfig,
  type ComputerUseConfig,
  type GitHubConfig,
  type GitHubConnection,
  type GoogleConfig,
  type InAppConfig,
  type MemesConfig,
  type VideoConfig,
  type NotionConfig,
  type NotionConnection,
  type SttConfig,
  type TelegramConfig,
  type TtsConfig,
  type Variable,
  type WeekStartsOn,
  type WhatsAppConfig,
  type WorkspaceStatus
} from '@main/workspace/workspace'
import type { ChatHistoryMessage } from '@preload/index'
import icon from '@resources/icons-win/icons/512x512.png?asset'
import dockIcon from '@resources/icons/icons/1024x1024.png?asset'
import trayIconDefault from '@resources/images/icon_transparent.png?asset'
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  nativeTheme,
  net,
  protocol,
  screen,
  session,
  shell,
  systemPreferences,
  Tray
} from 'electron'
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import os from 'node:os'
import { isAbsolute, join } from 'node:path'
import { pathToFileURL } from 'node:url'

// Redirect Chromium/Electron-managed state into ~/.wolffish so a single
// `rm -rf ~/.wolffish` wipes every byte the app touches. Must run before
// app.whenReady() — Electron resolves these paths on first use.
const WOLFFISH_ROOT = join(os.homedir(), '.wolffish')
app.setPath('userData', join(WOLFFISH_ROOT, 'runtime'))
app.setAppLogsPath(join(WOLFFISH_ROOT, 'logs'))

/**
 * Headless: boot the whole agent — channels, automations, MCP, the CLI socket
 * — and never create a window or a tray. This is what a VPS runs under
 * systemd, and what the `wolffish` command attaches to.
 *
 * Only the window and tray are skipped. Everything else is deliberately the
 * same code path, because a headless mode that boots differently is a second
 * app to keep working; this one is the same app with its face turned off.
 * `window-all-closed` was already a no-op (the tray app stays resident), so
 * nothing had to change for the process to survive with zero windows.
 */
const IS_HEADLESS = process.argv.includes('--headless') || process.env.WOLFFISH_HEADLESS === '1'

// Resolve a path the assistant mentioned in chat (which may start with ~) to an
// absolute path. Returns null for anything that isn't a real absolute/home path
// — the renderer only ever passes such paths, but this guards against junk.
function resolveDevicePath(p: string): string | null {
  if (!p || typeof p !== 'string') return null
  const trimmed = p.trim()
  let resolved = trimmed
  if (trimmed === '~') resolved = os.homedir()
  else if (trimmed.startsWith('~/')) resolved = join(os.homedir(), trimmed.slice(2))
  return isAbsolute(resolved) ? resolved : null
}

// Wolffish is a full-access local agent — it runs shell commands, installs
// software, and elevates with sudo on the user's behalf. Chromium's sandbox
// works against that: on Linux it sets the kernel's no_new_privs flag on the
// main process, which the kernel then uses to ignore the setuid bit on `sudo`
// and `pkexec` — so EVERY elevation a plugin spawns fails with
// `sudo: The "no new privileges" flag is set`. `--no-sandbox` runs every
// process unsandboxed: no no_new_privs (sudo works) and no setuid
// chrome-sandbox helper needed in a packaged AppImage/deb. Must run before
// app.whenReady(). Built-in safety lives in the amygdala approval gate.
//
// Do NOT also pass `--disable-setuid-sandbox`: it's redundant under
// `--no-sandbox` and Linux-only, so it only muddies the flag set.
/**
 * Same two signals `IS_HEADLESS` reads further down. Duplicated rather than
 * hoisted because the switches below have to be appended before Electron
 * commits to a display, which is earlier than that constant is defined.
 */
const IS_HEADLESS_BOOT =
  process.argv.includes('--headless') || process.env.WOLFFISH_HEADLESS === '1'

app.commandLine.appendSwitch('no-sandbox')

// Running unsandboxed, Chromium's guest/renderer processes allocate their
// shared memory directly in /dev/shm instead of via the sandbox broker. On some
// Linux hosts a guest process can't access /dev/shm from its context and dies
// FATAL ("Creating shared memory in /dev/shm ... failed"), which leaves the
// <webview> page viewer, PDF preview, and wolffish-media files BLANK while the
// main window (already painted) looks fine. This bit packaged Linux only —
// macOS/Windows don't use /dev/shm, and under the SUID sandbox (before we
// disabled it) the broker handled the shared memory. `--disable-dev-shm-usage`
// routes that shared memory to a regular temp file, fixing the blank guests
// with no effect on the sudo/no_new_privs behavior above.
app.commandLine.appendSwitch('disable-dev-shm-usage')

// The real fix for the blank Linux viewers. Even with --no-sandbox, the
// guest/renderer/GPU child processes in a packaged build still bring up the
// seccomp-bpf filter ("InitializeSandbox() called ... in process gpu-process"),
// and that filter REJECTS the syscall those processes use to allocate their
// compositor shared-memory buffer — failing thousands of times per second with
// the impossible `access(...) /tmp: No such process` (ESRCH = seccomp denial).
// With no buffer, the <webview> page viewer / PDF preview / wolffish-media files
// can't composite → BLANK, while the main window (already painted) looks fine.
// In dev the CLI `--no-sandbox` tears down seccomp too, which is why dev renders;
// macOS/Windows have no seccomp layer. Disabling the seccomp + GPU sandbox layers
// here matches the --no-sandbox intent (fully unsandboxed) and lets the guests
// get their shared memory. No effect on the sudo/no_new_privs behavior above.
app.commandLine.appendSwitch('disable-seccomp-filter-sandbox')
app.commandLine.appendSwitch('disable-gpu-sandbox')
// --no-zygote: child processes are exec'd fresh (each inheriting the current
// command line incl. --no-sandbox) instead of forked from a zygote that may
// have committed to a sandbox before appendSwitch() ran in this main module.
// Belt-and-suspenders for the same blank-guest issue.
app.commandLine.appendSwitch('no-zygote')

/**
 * A Linux box with no display server — the machine this whole CLI exists for.
 *
 * Electron is Chromium, and Chromium on Linux insists on a display at startup
 * even when nothing will ever be drawn: without one it aborts with "Missing X
 * server or $DISPLAY" before a single line of this file's logic runs. The
 * systemd unit written by autostart.ts launches exactly that way — no session,
 * no DISPLAY — so a VPS install would register successfully, report itself
 * healthy, and then fail to boot on every restart, with the reason visible
 * only in the journal.
 *
 * Ozone's headless platform is the supported way to run with no display at
 * all. Applied ONLY when this really is a headless Linux launch, so a normal
 * desktop start is untouched.
 */
if (
  process.platform === 'linux' &&
  IS_HEADLESS_BOOT &&
  !process.env.DISPLAY &&
  !process.env.WAYLAND_DISPLAY
) {
  app.commandLine.appendSwitch('ozone-platform', 'headless')
  app.commandLine.appendSwitch('disable-gpu')
  app.commandLine.appendSwitch('disable-software-rasterizer')
  app.disableHardwareAcceleration()
}

// Single-instance guard: if Wolffish is already running (even collapsed to
// tray), focus the existing window instead of showing a lockfile error.
if (!app.requestSingleInstanceLock()) {
  app.quit()
}

// Storage partition of the in-chat HTML file preview guests. Persistent on
// purpose: a page's localStorage (a game's high score) survives like it would
// in a browser. Mirrored by the renderer's HtmlPreview component.
const HTML_PREVIEW_PARTITION = 'persist:htmlpreview'

app.on('second-instance', () => {
  restoreMainWindow()
})

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'wolffish-media',
    privileges: { bypassCSP: true, supportFetchAPI: true, stream: true }
  }
])

export type ThemeSource = 'system' | 'light' | 'dark'
export type Locale = 'en' | 'ar'

export type ProviderListEntry = {
  id: CloudProviderConfig['id']
  model: string
  apiKey: string
  models?: string[]
  reasoningModels?: string[]
}

export type ProviderTestErrorKind =
  | 'invalid_key'
  | 'rate_limited'
  | 'invalid_model'
  | 'network'
  | 'generic'

export type ProviderTestResult =
  | { ok: true; models: string[]; reasoningModels?: string[] }
  | { ok: false; kind: ProviderTestErrorKind; message?: string }

function classifyHttpError(
  status: number,
  rawBody: string
): { kind: ProviderTestErrorKind; message?: string } {
  if (status === 401 || status === 403) return { kind: 'invalid_key' }
  if (status === 429) return { kind: 'rate_limited' }
  if (status === 404) return { kind: 'invalid_model' }
  let message = rawBody
  try {
    const parsed = JSON.parse(rawBody) as { error?: { message?: string } }
    if (parsed.error?.message) message = parsed.error.message
  } catch {
    /* keep raw body */
  }
  return { kind: 'generic', message: message || `HTTP ${status}` }
}

/**
 * Hit the provider's /v1/models endpoint. This doubles as auth validation —
 * if the key is bad we get a 401, no tokens spent. Returns chat-capable
 * models only, sorted newest first.
 */
async function fetchProviderModels(
  id: CloudProviderConfig['id'],
  apiKey: string
): Promise<ProviderTestResult> {
  try {
    if (id === 'anthropic') {
      const res = await fetch('https://api.anthropic.com/v1/models?limit=1000', {
        method: 'GET',
        headers: {
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01'
        }
      })
      if (!res.ok) {
        const text = await res.text().catch(() => '')
        return { ok: false, ...classifyHttpError(res.status, text) }
      }
      const body = (await res.json()) as {
        data?: Array<{ id: string; created_at?: string }>
      }
      const models = (body.data ?? [])
        .filter((m) => isAnthropicChatModel(m.id))
        .slice()
        .sort((a, b) => (b.created_at ?? '').localeCompare(a.created_at ?? ''))
        .map((m) => m.id)
      return { ok: true, models }
    }

    if (id === 'deepseek') {
      const res = await fetch('https://api.deepseek.com/models', {
        method: 'GET',
        headers: { Authorization: `Bearer ${apiKey}` }
      })
      if (!res.ok) {
        const text = await res.text().catch(() => '')
        return { ok: false, ...classifyHttpError(res.status, text) }
      }
      const body = (await res.json()) as {
        data?: Array<{ id: string; created?: number }>
      }
      const models = (body.data ?? [])
        .filter((m) => isDeepSeekChatModel(m.id))
        .slice()
        .sort((a, b) => (b.created ?? 0) - (a.created ?? 0))
        .map((m) => m.id)
      return { ok: true, models }
    }

    if (id === 'mimo') {
      const res = await fetch('https://api.xiaomimimo.com/v1/models', {
        method: 'GET',
        headers: { 'api-key': apiKey }
      })
      if (!res.ok) {
        const text = await res.text().catch(() => '')
        return { ok: false, ...classifyHttpError(res.status, text) }
      }
      const body = (await res.json()) as {
        data?: Array<{ id: string; created?: number }>
      }
      const models = (body.data ?? [])
        .filter((m) => isMiMoChatModel(m.id))
        .slice()
        .sort((a, b) => (b.created ?? 0) - (a.created ?? 0))
        .map((m) => m.id)
      return { ok: true, models }
    }

    if (id === 'minimax') {
      const res = await fetch('https://api.minimaxi.chat/v1/models', {
        method: 'GET',
        headers: { Authorization: `Bearer ${apiKey}` }
      })
      if (!res.ok) {
        const text = await res.text().catch(() => '')
        return { ok: false, ...classifyHttpError(res.status, text) }
      }
      const body = (await res.json()) as {
        data?: Array<{ id: string; created?: number }>
      }
      const models = (body.data ?? [])
        .filter((m) => isMiniMaxChatModel(m.id))
        .slice()
        .sort((a, b) => (b.created ?? 0) - (a.created ?? 0))
        .map((m) => m.id)
      return { ok: true, models }
    }

    if (id === 'kimi') {
      const res = await fetch('https://api.moonshot.ai/v1/models', {
        method: 'GET',
        headers: { Authorization: `Bearer ${apiKey}` }
      })
      if (!res.ok) {
        const text = await res.text().catch(() => '')
        return { ok: false, ...classifyHttpError(res.status, text) }
      }
      const body = (await res.json()) as {
        data?: Array<{ id: string; created?: number }>
      }
      const models = (body.data ?? [])
        .filter((m) => isKimiChatModel(m.id))
        .slice()
        // Moonshot stamps every model with one shared `created` (catalog
        // refresh), which would leave the picker in raw API order with the
        // flagship last — tie-break by family+version, kimi-k* newest-first,
        // the sunsetting moonshot-v1 line after.
        .sort(
          (a, b) =>
            (b.created ?? 0) - (a.created ?? 0) ||
            kimiRank(b.id).localeCompare(kimiRank(a.id), undefined, { numeric: true })
        )
        .map((m) => m.id)
      return { ok: true, models }
    }

    if (id === 'qwen') {
      const res = await fetch('https://dashscope-intl.aliyuncs.com/compatible-mode/v1/models', {
        method: 'GET',
        headers: { Authorization: `Bearer ${apiKey}` }
      })
      if (!res.ok) {
        const text = await res.text().catch(() => '')
        return { ok: false, ...classifyHttpError(res.status, text) }
      }
      const body = (await res.json()) as {
        data?: Array<{ id: string; created?: number }>
      }
      const models = (body.data ?? [])
        .filter((m) => isQwenChatModel(m.id))
        .slice()
        .sort((a, b) => (b.created ?? 0) - (a.created ?? 0))
        .map((m) => m.id)
      return { ok: true, models }
    }

    if (id === 'stepfun') {
      const res = await fetch('https://api.stepfun.ai/v1/models', {
        method: 'GET',
        headers: { Authorization: `Bearer ${apiKey}` }
      })
      if (!res.ok) {
        const text = await res.text().catch(() => '')
        return { ok: false, ...classifyHttpError(res.status, text) }
      }
      const body = (await res.json()) as {
        data?: Array<{ id: string; created?: number }>
      }
      const models = (body.data ?? [])
        .filter((m) => isStepfunChatModel(m.id))
        .slice()
        .sort((a, b) => (b.created ?? 0) - (a.created ?? 0))
        .map((m) => m.id)
      return { ok: true, models }
    }

    if (id === 'zai') {
      const res = await fetch('https://api.z.ai/api/paas/v4/models', {
        method: 'GET',
        headers: { Authorization: `Bearer ${apiKey}` }
      })
      if (!res.ok) {
        const text = await res.text().catch(() => '')
        return { ok: false, ...classifyHttpError(res.status, text) }
      }
      const body = (await res.json()) as {
        data?: Array<{ id: string; created?: number }>
      }
      const models = (body.data ?? [])
        .filter((m) => isZaiChatModel(m.id))
        .slice()
        .sort((a, b) => (b.created ?? 0) - (a.created ?? 0))
        .map((m) => m.id)
      return { ok: true, models }
    }

    if (id === 'xai') {
      const res = await fetch('https://api.x.ai/v1/models', {
        method: 'GET',
        headers: { Authorization: `Bearer ${apiKey}` }
      })
      if (!res.ok) {
        const text = await res.text().catch(() => '')
        return { ok: false, ...classifyHttpError(res.status, text) }
      }
      const body = (await res.json()) as {
        data?: Array<{ id: string; created?: number }>
      }
      const models = (body.data ?? [])
        .filter((m) => isXAIChatModel(m.id))
        .slice()
        .sort((a, b) => (b.created ?? 0) - (a.created ?? 0))
        .map((m) => m.id)
      return { ok: true, models }
    }

    if (id === 'openrouter') {
      // OpenRouter's /v1/models is public — it returns 200 with no auth at
      // all — so unlike every other provider's catalogue endpoint it can't
      // double as key validation. Probe /v1/key alongside it: that endpoint
      // 401s on a revoked/invalid key.
      const [keyRes, res] = await Promise.all([
        fetch('https://openrouter.ai/api/v1/key', {
          method: 'GET',
          headers: { Authorization: `Bearer ${apiKey}` }
        }),
        fetch('https://openrouter.ai/api/v1/models', {
          method: 'GET',
          headers: { Authorization: `Bearer ${apiKey}` }
        })
      ])
      if (!keyRes.ok) {
        const text = await keyRes.text().catch(() => '')
        return { ok: false, ...classifyHttpError(keyRes.status, text) }
      }
      if (!res.ok) {
        const text = await res.text().catch(() => '')
        return { ok: false, ...classifyHttpError(res.status, text) }
      }
      const body = (await res.json()) as {
        data?: Array<{ id: string; created?: number; supported_parameters?: string[] }>
      }
      const filtered = (body.data ?? [])
        .filter((m) => isOpenRouterChatModel(m.id))
        .slice()
        .sort((a, b) => (b.created ?? 0) - (a.created ?? 0))
      const models = filtered.map((m) => m.id)
      const reasoningModels = filtered
        .filter((m) => m.supported_parameters?.includes('reasoning'))
        .map((m) => m.id)
      return { ok: true, models, reasoningModels }
    }

    const res = await fetch('https://api.openai.com/v1/models', {
      method: 'GET',
      headers: { Authorization: `Bearer ${apiKey}` }
    })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      return { ok: false, ...classifyHttpError(res.status, text) }
    }
    const body = (await res.json()) as {
      data?: Array<{ id: string; created?: number }>
    }
    const models = (body.data ?? [])
      .filter((m) => isOpenAIChatModel(m.id))
      .slice()
      .sort((a, b) => (b.created ?? 0) - (a.created ?? 0))
      .map((m) => m.id)
    return { ok: true, models }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return { ok: false, kind: 'network', message }
  }
}

// Anthropic /v1/models returns the full historical catalog (claude-2, the
// claude-3.x generations, dated snapshots, etc.). Wolffish supports the current
// generation — the Claude 4.x family (opus-4 / sonnet-4 / haiku-4) and Fable —
// which are the models with verified thinking/effort behaviour. Hide the rest so
// the picker stays focused and the user isn't offered unvalidated models.
function isAnthropicChatModel(id: string): boolean {
  return /^claude-(fable|opus-4|sonnet-4|haiku-4)/.test(id)
}

// OpenAI's /v1/models returns 60+ entries. Keep ANY chat-completions-capable
// model — reasoning OR not (non-reasoning models just show the brain button
// off). Omit only what genuinely can't work in Wolffish or adds no value:
//  • non-chat endpoints (image/audio/tts/realtime/etc.)
//  • -pro tiers — Responses-API only, 404 on /v1/chat/completions (verified)
//  • gpt-3.5 — too weak for an agentic assistant
//  • dated snapshots (…-YYYY-MM-DD or -MMDD) — exact duplicates of the alias
function isOpenAIChatModel(id: string): boolean {
  if (id.startsWith('gpt-image-') || id.startsWith('chatgpt-image')) return false
  if (/-(audio|tts|whisper|search|realtime|transcribe|image|instruct)/.test(id)) return false
  if (/-pro($|-)/.test(id)) return false
  if (/(\d{4}-\d{2}-\d{2}|-\d{4})$/.test(id)) return false
  if (/^gpt-3\.5/.test(id)) return false
  return /^(gpt-|chatgpt-|o\d)/.test(id)
}

function isDeepSeekChatModel(id: string): boolean {
  return id.startsWith('deepseek-')
}

function isMiniMaxChatModel(id: string): boolean {
  return id.startsWith('MiniMax-M')
}

function isStepfunChatModel(id: string): boolean {
  if (id.startsWith('step-')) {
    if (/-(image|tts|asr|embed)/.test(id)) return false
    if (/-\d{4}$/.test(id)) return false // dated snapshot (e.g. step-3.5-flash-2603)
    return true
  }
  return false
}

// DashScope returns 150+ models. Keep only the clean Qwen chat/reasoning API
// tiers and drop the noise: non-chat modalities (image/tts/asr/omni/vl/mt/…),
// open-weight size variants (…-8b, -235b-a22b, -next), dated snapshots,
// preview/latest aliases, legacy qwen2 / qwen-coder.
function isQwenChatModel(id: string): boolean {
  if (!/^(qwen|qwq|qvq)/.test(id)) return false
  if (
    /-(image|tts|asr|realtime|embed|livetranslate|captioner|ocr|character|omni|vl|mt|s2s|vc|vd|tingwu)/.test(
      id
    )
  )
    return false
  if (/^(wan|z-image|text-embedding|ccai|tongyi)/.test(id)) return false
  if (id.startsWith('qwen-image') || id.startsWith('qwen-vl') || id.startsWith('qwen-mt'))
    return false
  if (id.startsWith('qwen-coder')) return false // legacy; superseded by qwen3-coder
  if (/(\d{4}-\d{2}-\d{2})$/.test(id) || /-preview$/.test(id) || /-latest$/.test(id)) return false
  if (/-\d+b(-a\d+b)?($|-)/.test(id) || /-next($|-)/.test(id)) return false // open-weight sizes
  if (/^qwen2/.test(id)) return false
  return true
}

function isZaiChatModel(id: string): boolean {
  // Z.ai serves GLM chat/reasoning models. Vision variants (glm-*v) are
  // chat-capable too; only filter out obvious non-chat endpoints.
  if (id.startsWith('glm-')) {
    if (/-(tts|asr|embedding|whisper|image|video|voice|cogview|realtime)/.test(id)) return false
    return true
  }
  return false
}

function isXAIChatModel(id: string): boolean {
  if (!id.startsWith('grok-')) return false
  if (/-(imagine|embed|tts|stt|whisper)/.test(id)) return false
  if (id.includes('multi-agent')) return false // not allowed on /chat/completions
  return true
}

function isOpenRouterChatModel(id: string): boolean {
  if (/(-embed|-tts|-stt|-whisper|-vision-gen|-diffusion|-stable|flux|dall-e|midjourney)/.test(id))
    return false
  if (
    /^(anthropic\/|openai\/|google\/|meta-llama\/|deepseek\/|mistralai\/|qwen\/|x-ai\/|cohere\/|microsoft\/|perplexity\/|amazon\/|nousresearch\/|xiaomi\/|moonshotai\/|minimax\/|stepfun\/|z-ai\/)/.test(
      id
    )
  )
    return true
  return false
}

// MiMo /v1/models is unfiltered and includes TTS / voice-clone / voice-design /
// ASR endpoints, which are not chat models and can't drive Wolffish's agentic
// loop. Keep only the text/omni chat models.
function isMiMoChatModel(id: string): boolean {
  if (!id.startsWith('mimo-')) return false
  if (/-(tts|voiceclone|voicedesign|asr|embed)/.test(id)) return false
  return true
}

// Sort key for the kimi picker tie-break: kimi-k* family above moonshot-v1.
function kimiRank(id: string): string {
  return id.startsWith('kimi-') ? `1-${id}` : `0-${id}`
}

function isKimiChatModel(id: string): boolean {
  if (id.startsWith('kimi-') || id.startsWith('moonshot-v1-')) {
    // Drop non-chat endpoints and the redundant vision-preview variants —
    // Kimi's vision is covered by the general k2.x models, so the moonshot
    // *-vision-preview duplicates just clutter the picker.
    if (/-(tts|asr|embedding|whisper|vision)/.test(id)) return false
    return true
  }
  return false
}

/**
 * Refresh the cached model list for every saved provider, in the
 * background, on app startup. Failures (offline, expired key) are silent —
 * the user keeps whatever cache they had and can retest from settings.
 */
async function refreshAllProviderModels(): Promise<void> {
  const cfg = await readConfig()
  if (!cfg?.llm.providers?.length) return
  for (const p of cfg.llm.providers) {
    if (!p.apiKey) continue
    const result = await fetchProviderModels(p.id, p.apiKey)
    if (!result.ok) continue
    await setCloudProvider({ ...p, models: result.models, reasoningModels: result.reasoningModels })
    broadcast('provider:updated', { id: p.id })
  }
  // Re-seed so any new model selection downstream sees the latest config
  // (apiKey/model haven't changed but the cached model list did).
  const next = await readConfig()
  if (next?.llm.providers) {
    thalamus.setCloudProviders(next.llm.providers)
    thalamus.setBrain(next.llm.brain ?? null)
  }
}

export type ThemeState = {
  themeSource: ThemeSource
  shouldUseDarkColors: boolean
}

let activePull: AbortController | null = null
let ollamaWatch: ReturnType<typeof startOllamaWatch> | null = null
let activePullModel: string | null = null
let lockAcquired = false
let isShuttingDown = false

const thalamus = new Thalamus(localProvider)
const agent = new Agent({
  thalamus,
  workspaceRoot: workspaceRoot(),
  getActiveModel: () => localProvider.currentModel
})

// Channels are the user-facing surfaces wolffish speaks through. The
// Electron renderer is the original; Telegram is the second. They share
// one TurnRunner, which serializes turns PER CONVERSATION (one ordered
// transcript each) while conversations — across channels and within the
// renderer — run concurrently. Amygdala's approval bridge dispatches to
// the sink of the turn that asked, resolved through the turn-identity
// AsyncLocalStorage via the singleton turnRouter.
const turnRunner = new TurnRunner(agent)
// Every turn's lifecycle (any channel) is broadcast so the renderer's
// Conversations sidebar can show live status chips for in-app, WhatsApp,
// Telegram runs alike.
turnRunner.setLifecycleListener((ev) => {
  broadcast('chat:turnState', ev)
  // The phone is a second view of this app, not a channel being relayed to:
  // a turn started anywhere — in-app, Telegram, WhatsApp, the phone itself —
  // has to show up there as it happens, exactly as it does in the sidebar.
  pushTurnToMobile(ev)
})
// Mid-turn user messages (pending / delivered / withdrawn) reach every
// surface watching the conversation on their own channel — never through
// chat:turnState, whose consumers read any unknown phase as a failed run.
turnRunner.onInterjection((ev) => {
  broadcast('chat:interjection', ev)
  try {
    mobileChannel.pushInterjection(ev)
  } catch {
    // never let a dead tunnel disturb a turn
  }
})
/**
 * The mid-turn message safety net (channels/interjection-reconciler.ts).
 *
 * Every push above can be missed — a phone that backgrounded, a window that
 * closed, a tunnel that dropped — and until now a missed push meant the user's
 * words were simply gone. The park (channels/interjection-store.ts) keeps them;
 * this asks, on every occasion the answer could have changed, whether each
 * parked message has reached the transcript yet, and re-sends the ones that
 * have not. Idempotent and cheap: it no-ops on an empty park, which is almost
 * always.
 */
const interjectionDeps: ReconcilerDeps = {
  // Autonomous runs count as live here too: they hold the inbox through the
  // off-lane bridge above, so a message parked against one is waiting to be
  // read, not stranded — and the reconciler must not hold or re-send it out
  // from under a run that is still going.
  isConversationActive: (id) =>
    turnRunner.isConversationActive(id) || agent.isAutonomousRunActive(id),
  liveInboxIds: (id) => turnRunner.liveInterjectionIds(id),
  log: (line) => console.log(`[interjections] ${line}`)
}
const reconcileInterjectionsFor = (conversationId: string): void => {
  void reconcileConversation(conversationId, interjectionDeps).catch(() => undefined)
}
/**
 * What a surface opening a conversation should show as parked: the live inbox
 * (waiting to be read at the turn's next stop point) PLUS anything the park is
 * HOLDING — a message that is never auto-resent and is waiting for a person:
 * its run was stopped before the agent reached it, or its channel has no
 * dispatcher to put it back on the wire. Either way it would otherwise be
 * visible only to a surface that happened to be connected at the moment it
 * stopped moving. `held` is what tells the two renderers which is which.
 */
const listPendingInterjections = async (
  conversationId: string
): Promise<Array<Interjection & { held?: boolean }>> => {
  const live = turnRunner.pendingInterjections(conversationId)
  const liveIds = new Set(live.map((i) => i.messageId))
  const parked = await parkedInterjections(conversationId).catch(() => [])
  const held = parked
    .filter((item) => item.disposition === 'held' && !liveIds.has(item.messageId))
    .map((item) => ({
      messageId: item.messageId,
      text: item.text,
      attachments: item.attachments,
      ...(item.voicePrompt ? { voicePrompt: true } : {}),
      ...(item.voiceLang ? { voiceLang: item.voiceLang } : {}),
      channel: item.channel,
      sentAt: item.sentAt,
      held: true as const
    }))
  return [...live, ...held]
}
// A lane that closed with messages the turn never read is the sharpest signal
// there is — act on it immediately rather than waiting for the next save.
turnRunner.setInterjectionSweepListener(reconcileInterjectionsFor)
// Autonomous heartbeat/procedure runs never pass through the TurnRunner —
// they end inside Agent.processAutonomous. Broadcast their terminal lifecycle
// through the SAME chat:turnState event, so their sealed conversations get
// the fresh success/danger chip tint in the rail exactly like a channel run.
agent.setAutonomousLifecycleListener((ev) => {
  broadcast('chat:turnState', ev)
  pushTurnToMobile(ev)
})
// Relay conversation deletions to the renderer so the sidebar prunes its live
// run-status — a channel-side /delete never touches the renderer otherwise.
agent.corpus.on('conversation.deleted', ({ id }) => {
  broadcast('conversation:deleted', { id })
  // A deleted transcript has nowhere to re-home a parked message into, and
  // resurrecting the conversation to deliver one would be worse than the loss.
  void forgetConversationPark(id).catch(() => undefined)
})
// Relay conversation (re)index/remove so the rail + History refresh for every
// create/rename/delete path — including the ones that emit no turn lifecycle
// at all (renames, imports, rebuilds). Fires after the cortex row is
// committed.
//
// The phone rides the same signal, and for it this one is LOAD-BEARING: it is
// the only push that always fires AFTER a conversation file hits disk. The
// turn lifecycle's own metadata push cannot promise that — `done` is emitted
// before the sink's persist resolves, and an in-app turn is saved by the
// renderer moments after that — so the metadata it carries can describe the
// PRE-turn file. The phone then fetches a transcript without the answer it
// just watched, stamps it current, and with no later signal sits stale until
// the conversation is reopened. This push carries the post-save updatedAt,
// which is exactly what flips the phone's staleness check and triggers its
// refetch.
agent.corpus.on('conversation.indexed', ({ rel }) => {
  broadcast('conversation:changed', {})
  const savedId = idFromFilename(rel.split('/').pop() ?? '')
  // This is the ONE signal that always fires after a transcript hits disk, so
  // it is where "did that mid-turn message actually get written?" can finally
  // be answered — including for an in-app turn, whose segments are saved by
  // the renderer moments after the run ends.
  if (savedId) reconcileInterjectionsFor(savedId)
  // hasPeer-gated: this fires on every conversation save forever, and the
  // push starts with a file read — I/O nobody should pay with no phone
  // listening.
  if (!mobileChannel.hasPeer) return
  if (savedId) void pushConversationToMobile(savedId)
})
// Full rebuilds + the startup catch-up index via indexWalkedSync directly, so
// no conversation.indexed fires while they run — a list fetched mid-rebuild
// can be partial (see the getReindexStatus guard in conversation:list). Push
// one list-changed when the pass ends so every surface reconciles.
agent.corpus.on('index.reindexed', () => broadcast('conversation:changed', {}))
const electronChannel = new ElectronChannel(agent, turnRunner)
const telegramChannel = new TelegramChannel(agent, turnRunner, localProvider)
const whatsappChannel = new WhatsAppChannel(agent, turnRunner, localProvider)
// The terminal. Same pipeline, same TurnRunner, no window — which is also
// what makes a VPS install possible: nothing here needs one.
const cliChannel = new CliChannel(agent, turnRunner)
const cliServer = new CliServer({
  handlers: ipcHandlers,
  channel: cliChannel,
  version: app.getVersion()
})

/**
 * The phone is a second view of this app, not a chat channel: it renders the
 * conversation list, most settings and usage, so the channel serves a config
 * snapshot and a metadata index rather than a message stream. Everything it
 * pushes below keeps that view live without the phone polling.
 */
/** Assigned once the settings IPC scope defines it; see below. */
let mobileSerializeCapabilities: () => Promise<
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
> = async () => []

/**
 * Assigned in the same scope. Throwing is the honest default: a toggle
 * silently dropped would answer the phone with success and revert later,
 * which is worse than an RPC error it can act on. Unreachable in practice —
 * the tunnel only starts after the settings scope has run.
 */
let mobileSetCapabilityEnabled: (name: string, enabled: boolean) => Promise<boolean> = async () => {
  throw new Error('capability toggle not ready')
}

/**
 * What an in-app config reads as when the workspace has never written one —
 * the shape `inapp:configChange` carries, so a listener never has to guess at
 * undefined. Mirrors EMPTY_INAPP_CONFIG in workspace.ts.
 */
const EMPTY_INAPP: InAppConfig = { verbose: false, reasoning: true }

/**
 * The phone edited a setting. Every key maps onto the exact setter
 * the desktop's own panel calls — same persistence, same cache resets — so a
 * change is live for the agent immediately, no matter which screen made it.
 *
 * A whitelist, deliberately: the phone names flat keys from its own config
 * surface, and anything unlisted throws — the phone treats the error as a
 * refusal and refetches the snapshot, so an out-of-date app can never write
 * somewhere unexpected. Two absences are deliberate: the extension PORT
 * (moving it restarts the local pairing server, which is the desktop's own
 * act) and the Telegram/WhatsApp power switches (starting a bridge process
 * is likewise this machine's act; the phone renders those rows as status).
 */
async function applyMobileSettings(settings: Record<string, unknown>): Promise<void> {
  const str = (value: unknown): string => (typeof value === 'string' ? value : String(value ?? ''))
  const int = (value: unknown): number | null => {
    const n = Math.round(Number(value))
    return Number.isFinite(n) && n > 0 ? n : null
  }
  const applied: string[] = []
  for (const [key, value] of Object.entries(settings)) {
    switch (key) {
      case 'braveEnabled':
        await persistBraveConfig({ enabled: value === true })
        braveService.resetCache()
        break
      case 'braveApiKey':
        await persistBraveConfig({ apiKey: str(value) })
        braveService.resetCache()
        break
      case 'imgflipUsername':
      case 'imgflipPassword': {
        const memes = await getMemesConfig()
        await persistMemesConfig({
          imgflip: {
            username: key === 'imgflipUsername' ? str(value) : memes.imgflip.username,
            password: key === 'imgflipPassword' ? str(value) : memes.imgflip.password
          }
        })
        memesService.resetCache()
        break
      }
      case 'giphyApiKey':
        await persistMemesConfig({ giphy: { apiKey: str(value) } })
        memesService.resetCache()
        break
      case 'videoApiKey':
        // Video generation's own key (never the MiniMax chat provider's —
        // see VideoConfig). The broadcast keeps an open desktop panel and
        // the composer's URL-attach gate in sync with a phone-side save.
        await setVideoConfig({ apiKey: str(value) })
        broadcast('services:changed', { service: 'video' })
        break
      case 'videoDirector':
        // Director mode is a model directive, not a harness behavior —
        // persisting it is the whole job; the next turn's system prompt
        // picks it up.
        await setVideoConfig({ director: value === true })
        broadcast('services:changed', { service: 'video' })
        break
      case 'videoEnabled':
        // The video switch is the capability itself — same path as the
        // Capabilities screen, locked-core guard and panel refresh included.
        await mobileSetCapabilityEnabled('video', value === true)
        break
      case 'memesEnabled':
        // The memes switch is the capability itself — same path as the
        // Capabilities screen, locked-core guard and panel refresh included.
        await mobileSetCapabilityEnabled('memes', value === true)
        break
      case 'sttModel':
        await persistSttConfig({ defaultModel: str(value) })
        break
      case 'sttLanguage':
        await persistSttConfig({ language: str(value) })
        break
      case 'ttsVoice':
        await persistTtsConfig({ defaultVoice: str(value) })
        break
      case 'ttsSpeed':
        await persistTtsConfig({ defaultSpeed: str(value) })
        break
      case 'ttsVoiceReplies':
        // A model directive like videoDirector — persisting it is the whole
        // job; the next turn's <voice_prompts> block and runtime notice pick
        // it up.
        await persistTtsConfig({ voiceReplies: value === true })
        break
      // No computer-use screenshotMaxWidth/screenshotFormat cases: the agent
      // sets those per capture now, so a phone write to them is a stale
      // client and falls through to the throw below — which is how this
      // switch is meant to reject one (the phone re-pulls the snapshot).
      case 'browserScreenshotMaxWidth': {
        const width = int(value)
        if (width) await persistBrowserExtensionConfig({ screenshotMaxWidth: width })
        break
      }
      case 'browserScreenshotFormat':
        await persistBrowserExtensionConfig({ screenshotFormat: value === 'png' ? 'png' : 'jpeg' })
        break
      case 'browserScreenshotQuality': {
        const quality = int(value)
        if (quality) {
          await persistBrowserExtensionConfig({ screenshotQuality: Math.min(100, quality) })
        }
        break
      }
      // Customization — the three hand-written documents behind the desktop's
      // Soul, User and Agents pages. Written through writeViewerFile, which is
      // the exact call those pages' Save button makes, so a save from the phone
      // and a save from here are one act with one atomic write.
      case 'soulMarkdown':
      case 'userMarkdown':
      case 'agentsMarkdown': {
        const doc = key.slice(0, -'Markdown'.length) as CustomizationDoc
        const text = str(value)
        // The phone enforces the same ceiling before sending; this is the side
        // that owns the file, so it refuses rather than trusting the sender.
        // Throwing IS the answer — the phone treats a rejected configSet as a
        // refusal, refetches the snapshot and puts the document back.
        if (Buffer.byteLength(text, 'utf8') > CUSTOMIZATION_MAX_BYTES) {
          throw new Error(`${CUSTOMIZATION_DOCS[doc]} is too large to write from the phone`)
        }
        await writeViewerFile(CUSTOMIZATION_DOCS[doc], text)
        // Same announcement this app's own editor makes below, so an open
        // Soul/User/Agents page adopts the phone's save live.
        broadcast('customization:changed', { doc, path: CUSTOMIZATION_DOCS[doc] })
        break
      }
      // Preferences — mirroring the runtime:* IPC handlers exactly: persist,
      // then update the live runtime the same way a click in the panel does.
      case 'restrictPowerfulModels':
        await persistRestrictPowerfulModels(value === true)
        break
      case 'bypassPermissions':
        await persistBypassPermissions(value === true)
        agent.amygdala.setBypassPermissions(value === true)
        break
      case 'blockCredentials':
        await persistBlockCredentials(value === true)
        turnRunner.setBlockCredentials(value === true)
        break
      case 'updatesEnabled':
        await patchConfig((c) => ({
          ...c,
          updates: { ...(c.updates ?? { enabled: true }), enabled: value === true }
        }))
        break
      case 'weekStartsOn':
        // 0 (Sunday) or 1 (Monday) — the same two values the panel's own
        // segmented control can send `runtime:setWeekStartsOn`.
        if (value !== 0 && value !== 1) {
          throw new Error(`"${String(value)}" is not a week start`)
        }
        await persistWeekStartsOn(value)
        break
      // The Model screen and the composer's control cluster. Each key maps
      // onto the exact handler its own desktop control calls —
      // `provider:setMode`, `runtime:setThinkingMode`, `runtime:setLocalOnly`,
      // `model:select`, `provider:setBrain` — same persistence, same live
      // runtime update, same announcement, so a pick on either screen is the
      // same act.
      case 'chatMode': {
        const mode = value === 'workflow' ? 'workflow' : 'single'
        await persistMode(mode)
        agent.setMode(mode)
        broadcast('provider:updated', { id: null })
        break
      }
      case 'thinkingMode': {
        const mode = str(value)
        if (!THINKING_MODES.has(mode)) throw new Error(`"${mode}" is not a thinking mode`)
        // Stored per model, exactly as the desktop's brain button stores it.
        // The snapshot serves the current Brain's entry, so the Brain is the
        // model this phone-side chip names — no Brain, nothing to hold it.
        const model = str((await readConfig())?.llm.brain?.model)
        if (!model) throw new Error('no Brain model to hold a thinking mode')
        await persistThinkingMode(model, mode)
        broadcast('preferences:changed', { thinkingMode: { model, mode } })
        break
      }
      case 'localOnly':
        await persistLocalOnly(value === true)
        thalamus.setLocalOnly(value === true)
        break
      case 'localModel': {
        // Choosing among the models the desktop has already pulled — the
        // phone's picker lists /api/tags, so anything else is a stale row.
        // Refusing beats silently starting a multi-gigabyte pull.
        const modelName = str(value)
        const installed = await listTags().catch(() => [])
        if (!installed.some((tag) => tag.name === modelName)) {
          throw new Error(`"${modelName}" is not installed on the desktop`)
        }
        await selectLocalModel(modelName)
        const updated = await readConfig()
        if (updated?.llm.local.model) {
          localProvider.configure(updated.llm.local.model, updated.llm.local.endpoint)
        }
        broadcast('model:pullDone', { modelName, ok: true as const })
        ollamaWatch?.poke()
        break
      }
      case 'brainProvider': {
        // The provider half of the cloud picker. The phone follows with its
        // brainModel write; until that lands, the provider's own stored model
        // keeps the Brain coherent — the same pair the desktop's picker sets.
        const providerId = str(value)
        const provider = (await readConfig())?.llm.providers.find((p) => p.id === providerId)
        if (!provider) throw new Error(`"${providerId}" is not a configured provider`)
        const updated = await persistBrain({ providerId: provider.id, model: provider.model })
        thalamus.setBrain(updated.llm.brain ?? null)
        broadcast('provider:updated', { id: provider.id })
        break
      }
      case 'brainModel': {
        const brain = (await readConfig())?.llm.brain
        if (!brain) throw new Error('no Brain provider to set a model for')
        const updated = await persistBrain({ providerId: brain.providerId, model: str(value) })
        thalamus.setBrain(updated.llm.brain ?? null)
        broadcast('provider:updated', { id: brain.providerId })
        break
      }
      case 'providers': {
        // The Model screen's provider cards, as one array. Only two fields
        // are honored per entry: a model choice and a NEWLY TYPED key. The
        // snapshot sends key previews (12 chars + '…', see maskKey), and
        // those round-trip back here on every model change — a masked value
        // must never overwrite the real credential it abbreviates. Rows this
        // desktop does not have cannot carry a user edit (the phone renders
        // snapshot rows), so they are dropped rather than refused.
        if (!Array.isArray(value)) throw new Error('providers must be an array')
        const stored = (await readConfig())?.llm.providers ?? []
        let changed: string | null = null
        for (const entry of value as Array<{ id?: unknown; model?: unknown; apiKey?: unknown }>) {
          const existing = stored.find((p) => p.id === entry?.id)
          if (!existing) continue
          const model =
            typeof entry.model === 'string' && entry.model ? entry.model : existing.model
          const apiKey =
            typeof entry.apiKey === 'string' && entry.apiKey && !entry.apiKey.endsWith('…')
              ? entry.apiKey
              : existing.apiKey
          if (model === existing.model && apiKey === existing.apiKey) continue
          await setCloudProvider({ ...existing, model, apiKey })
          changed = existing.id
        }
        if (changed) {
          // Re-seed the cascade exactly as `provider:save` does — setBrain
          // included, because setCloudProvider mirrors a model change onto a
          // Brain that points at the edited provider.
          const updated = await readConfig()
          if (updated?.llm.providers) {
            thalamus.setCloudProviders(updated.llm.providers)
            thalamus.setBrain(updated.llm.brain ?? null)
          }
          broadcast('provider:updated', { id: changed })
        }
        break
      }
      case 'mcpServers': {
        // The MCP screen's switches, as one name→enabled map — the snapshot
        // lists servers by display name and ids stay desktop-side, so the
        // name resolution here mirrors the snapshot's exactly. Applied as a
        // diff through the manager (the path `mcp:setEnabled` takes), which
        // owns lifecycle, persistence and the status broadcast.
        const map = (value ?? {}) as Record<string, unknown>
        const servers = (await readConfig())?.mcp?.servers ?? []
        for (const server of servers) {
          const name =
            typeof server.name === 'string'
              ? server.name
              : typeof server.slug === 'string'
                ? server.slug
                : 'server'
          const wanted = map[name]
          if (typeof wanted !== 'boolean' || wanted === (server.enabled !== false)) continue
          const result = await mcpManager.setEnabled(server.id, wanted)
          if (!result.ok) throw new Error(result.error ?? `could not switch "${name}"`)
        }
        break
      }
      // The compaction schedule — persist and reschedule exactly as
      // `runtime:setCompactionConfig` does. Reflection's settings ride their
      // own RPC (applyReflectionConfig below); these three are the phone's
      // only Knowledge keys on the generic path.
      case 'compactionDailyHour':
      case 'compactionWeeklyHour': {
        const hour = Math.round(Number(value))
        if (!Number.isFinite(hour) || hour < 0 || hour > 23) {
          throw new Error(`"${String(value)}" is not an hour`)
        }
        const patch = key === 'compactionDailyHour' ? { dailyHour: hour } : { weeklyHour: hour }
        const updated = await persistCompactionConfig(patch)
        agent.brainstem.setCompactionConfig(updated.compaction!)
        break
      }
      case 'compactionWeeklyDay': {
        const day = Math.round(Number(value))
        if (!Number.isFinite(day) || day < 0 || day > 6) {
          throw new Error(`"${String(value)}" is not a weekday`)
        }
        const updated = await persistCompactionConfig({ weeklyDay: day })
        agent.brainstem.setCompactionConfig(updated.compaction!)
        break
      }
      // The phone's own two channel settings, edited from the phone. Routed
      // through the channel's setters rather than the config writer, because
      // each does more than persist: notifications registers or withdraws the
      // model's notify_phone tool, and both emit the status the desktop's
      // Mobile panel is listening to — so a flip made on the phone moves that
      // panel's segmented control in the same breath.
      case 'mobileNotifications':
        await mobileChannel.setNotificationsEnabled(value === true)
        break
      case 'mobileVerbose':
        await mobileChannel.setVerbose(value === true)
        break
      /**
       * The terminal's feed preference — the one CLI setting the phone edits.
       * Everything else on that card is a machine fact (is `wolffish` on PATH,
       * did the autostart registration take, by which mechanism), and the two
       * that ARE knobs upstream — autostart on/off and its mode — are the same
       * OS registration `launchAtStartup` is, which this device has always
       * reported rather than driven.
       *
       * Persist and announce exactly as `cli:setConfig` does, broadcast
       * included: that push is what an open Channels → CLI panel re-seeds
       * from, so a flip made on the phone moves the segmented control in the
       * window without a refetch. Skipping it would leave the two screens
       * disagreeing until the panel was reopened.
       */
      case 'cliVerbose':
        await persistCliConfig({ verbose: value === true })
        broadcast('cli:configChange', await getCliConfig())
        break
      // The in-app feed preference — persist and announce exactly as
      // `inapp:setConfig` does, window push included, so an open desktop
      // chat adopts the phone's flip without a refetch. It drives the
      // phone's own chat feed too; the preference is the workspace's.
      case 'inappVerbose':
      case 'inappReasoning': {
        const patch: Partial<InAppConfig> =
          key === 'inappVerbose' ? { verbose: value === true } : { reasoning: value === true }
        const updated = await persistInAppConfig(patch)
        broadcast('inapp:configChange', updated.inapp ?? EMPTY_INAPP)
        break
      }
      // Telegram / WhatsApp — every editable row of the phone's Channels
      // screen, through the same patch helpers `telegram:setConfig` and
      // `whatsapp:setConfig` call, restart semantics included: an allow-list
      // change restarts a running bridge, a preference-only change does not.
      // The power switches are deliberately absent — starting a bridge is
      // the desktop's own act, and the phone renders them as status rows.
      case 'telegramAllowedUserIds':
        await applyTelegramConfigPatch({ allowedUserIds: parseAllowedUserIds(str(value)) })
        break
      case 'telegramAutoRefresh':
        await applyTelegramConfigPatch({ autoRefresh: value === true })
        break
      case 'telegramStaleHours': {
        const hours = int(value)
        if (hours) await applyTelegramConfigPatch({ staleHours: hours })
        break
      }
      case 'telegramVerbose':
        await applyTelegramConfigPatch({ verbose: value === true })
        break
      case 'telegramHideAutomations':
        await applyTelegramConfigPatch({ hideAutomationsFromResume: value === true })
        break
      case 'whatsappAllowedNumbers':
        await applyWhatsAppConfigPatch({ allowedPhoneNumbers: parseAllowedNumbers(str(value)) })
        break
      case 'whatsappAutoRefresh':
        await applyWhatsAppConfigPatch({ autoRefresh: value === true })
        break
      case 'whatsappStaleHours': {
        const hours = int(value)
        if (hours) await applyWhatsAppConfigPatch({ staleHours: hours })
        break
      }
      case 'whatsappVerbose':
        await applyWhatsAppConfigPatch({ verbose: value === true })
        break
      case 'whatsappHideAutomations':
        await applyWhatsAppConfigPatch({ hideAutomationsFromResume: value === true })
        break
      default:
        throw new Error(`"${key}" is not editable from the phone`)
    }
    applied.push(key)
  }
  // One broadcast for the lot: the renderer hears it like any settings save,
  // and the broadcast hook's config.changed push is the phone's confirmation.
  // The applied values ride along so a listening panel can seed its controls
  // straight from the payload instead of refetching first.
  if (applied.length) broadcast('settings:mobileChange', { keys: applied, settings })
  // Plus the per-service announcements the service panels re-seed from — the
  // same channel their own desktop-side saves fire, so a panel cannot tell
  // (and needn't care) which device made the change.
  for (const service of new Set(applied.map((key) => MOBILE_KEY_SERVICE[key]))) {
    if (service) broadcast('services:changed', { service })
  }
}

/**
 * Which customization document a workspace-relative path names, or null for
 * every other file. Windows separators and a leading `./` are normalized away
 * because the caller is a UI path, not a canonical one — the same tolerance
 * resolveScoped applies before touching disk.
 */
function customizationDocFor(relativePath: string): CustomizationDoc | null {
  const normalized = String(relativePath ?? '')
    .replace(/\\/g, '/')
    .replace(/^\.?\/+/, '')
  return (
    (Object.keys(CUSTOMIZATION_DOCS) as CustomizationDoc[]).find(
      (doc) => CUSTOMIZATION_DOCS[doc] === normalized
    ) ?? null
  )
}

/** Which service panel each phone-editable key belongs to, for re-seeding. */
const MOBILE_KEY_SERVICE: Record<string, string | undefined> = {
  braveEnabled: 'brave',
  braveApiKey: 'brave',
  memesEnabled: 'memes',
  imgflipUsername: 'memes',
  imgflipPassword: 'memes',
  giphyApiKey: 'memes',
  sttModel: 'stt',
  sttLanguage: 'stt',
  ttsVoice: 'tts',
  ttsSpeed: 'tts',
  ttsVoiceReplies: 'tts',
  browserScreenshotMaxWidth: 'browserExtension',
  browserScreenshotFormat: 'browserExtension',
  browserScreenshotQuality: 'browserExtension'
}

/**
 * Persist a Telegram patch and run the channel lifecycle — one path however
 * the change arrives (the settings IPC or the phone's configSet). A patch
 * that touches only runtime preferences (verbose, autoRefresh, staleHours,
 * hideAutomations) needs no bot restart — those are read fresh per
 * message/turn. Restart stays reserved for connection changes (token,
 * allow-list, enable transitions).
 */
async function applyTelegramConfigPatch(patch: Partial<TelegramConfig>): Promise<{
  status: ReturnType<TelegramChannel['getStatus']>
  config: TelegramConfig
}> {
  const updated = await persistTelegramConfig(patch)
  const next = updated.telegram ?? {
    enabled: false,
    botToken: '',
    allowedUserIds: []
  }
  const touchesConnection =
    patch.enabled !== undefined ||
    patch.botToken !== undefined ||
    patch.allowedUserIds !== undefined
  if (next.enabled) {
    if (touchesConnection) {
      // Re-running start with a different token must restart the
      // long-poll loop, otherwise the old bot keeps replying.
      await telegramChannel.restart(next).catch(() => undefined)
    }
  } else {
    await telegramChannel.stop('config disabled').catch(() => undefined)
  }
  return { status: telegramChannel.getStatus(), config: next }
}

/**
 * WhatsApp's counterpart, same contract: persist, mirror the allow-list into
 * the live channel, start/stop on enable transitions, and announce the
 * status to every surface — whichever device made the change.
 */
async function applyWhatsAppConfigPatch(patch: Partial<WhatsAppConfig>): Promise<{
  status: ReturnType<WhatsAppChannel['getStatus']>
  config: WhatsAppConfig
}> {
  const previous = await getWhatsAppConfig()
  const updated = await persistWhatsAppConfig(patch)
  const next = updated.whatsapp ?? { enabled: false, allowedPhoneNumbers: [] }
  whatsappChannel.updateAllowedPhoneNumbers(next.allowedPhoneNumbers ?? [])
  if (previous.enabled !== next.enabled) {
    if (next.enabled) {
      if (whatsappChannel.isStarted()) {
        whatsappChannel.setProcessingEnabled(true)
      } else {
        await whatsappChannel.start(next).catch(() => undefined)
      }
    } else {
      whatsappChannel.setProcessingEnabled(false)
    }
  }
  const status = whatsappChannel.getStatus()
  // Every surface, not just the window (or phone) that asked.
  broadcast('whatsapp:statusChange', status)
  return { status, config: next }
}

/**
 * Persist a reflection patch and fan the change out — one path however the
 * change arrives (settings IPC or the phone's tunnel RPC). The renderer
 * broadcast keeps an open ReflectionPanel current, and doubles (via the
 * generic hook in broadcast()) as the config.changed push that tells the
 * phone to refresh.
 */
async function applyReflectionPatch(
  patch: import('@main/workspace/workspace').ReflectionPatch
): Promise<import('@main/workspace/workspace').ReflectionConfig> {
  const updated = await persistReflectionConfig(patch)
  const cfg = normalizeReflectionConfig(updated.reflection)
  agent.brainstem.setReflectionConfig(cfg)
  broadcast('reflection:changed', {})
  return cfg
}

/**
 * Where this build keeps its own release notes — src/changelog in dev, the
 * packaged resources copy in production. One resolver shared by the updater
 * IPC and the phone's changelog RPC, so the two readers can never diverge.
 */
function changelogDir(): string {
  return is.dev
    ? join(app.getAppPath(), 'src', 'changelog')
    : join(process.resourcesPath, 'changelog')
}

/** Months with notes, newest first — `YYYY-MM` directory names only. */
async function listChangelogMonths(): Promise<string[]> {
  const { readdir } = await import('node:fs/promises')
  try {
    const entries = await readdir(changelogDir(), { withFileTypes: true })
    return entries
      .filter((entry) => entry.isDirectory() && /^\d{4}-\d{2}$/.test(entry.name))
      .map((entry) => entry.name)
      .sort()
      .reverse()
  } catch {
    return []
  }
}

/** One month's notes in one language, English fallback — null when absent. */
async function readChangelogMarkdown(month: string, locale?: string): Promise<string | null> {
  const { readFile } = await import('node:fs/promises')
  for (const lang of [locale ?? 'en', 'en']) {
    try {
      return await readFile(join(changelogDir(), month, `${lang}.md`), 'utf8')
    } catch {
      // try the next language
    }
  }
  return null
}

/** The updater's state minus `releaseNotes` — the wire shape the phone
 *  renders. The notes stay home: state rides every download-percent tick. */
const toWireUpdaterState = (state: UpdaterState): UpdaterWireState => ({
  phase: state.phase,
  version: state.version,
  percent: state.percent,
  error: state.error
})

const mobileChannel = new MobileChannel({
  agent,
  runner: turnRunner,
  listPendingInterjections: (conversationId) => listPendingInterjections(conversationId),
  serializeCapabilities: () => mobileSerializeCapabilities(),
  // The phone's reflection controls write through to the same config the
  // settings panel edits; run-now rides the same brainstem queue.
  applyReflectionConfig: async (patch) => applyReflectionPatch(patch),
  runReflectionJob: async (kind) =>
    kind === 'deepClean' ? agent.brainstem.runDeepCleanNow() : agent.brainstem.runReflectionNow(),
  // The phone's capability toggle takes the exact same path as a click in
  // this app's own settings panel — write, guards, broadcast and all.
  applyCapability: (name, enabled) => mobileSetCapabilityEnabled(name, enabled),
  applySettings: (settings) => applyMobileSettings(settings),
  // Variables from the phone persist through the same save the panel's IPC
  // uses, renderer broadcast included — one path, whoever wrote.
  applyVariables: (variables) => saveVariablesEverywhere(variables),
  // No range filter: the phone aggregates the whole ledger locally, exactly
  // as the desktop Usage panel does. agent.usage folds the same per-line
  // cache the panel reads, so the two screens can never disagree.
  usageDays: () => agent.usage.getDays(),
  dataAnalytics: () => getDataAnalytics(),
  // Same probes the Ollama settings IPC uses — default endpoint, live answer.
  ollamaRunning: () => detectOllama(),
  ollamaModels: async () => (await listTags()).map((tag) => tag.name),
  projects: () => listProjects(),
  compactionRuns: () => agent.brainstem.getCompactionRuns(),
  // This build's own release notes for the phone's What's-new page: the month
  // list rides the snapshot, bodies are served one month at a time.
  changelogMonths: () => listChangelogMonths(),
  readChangelog: (month, locale) => readChangelogMarkdown(month, locale),
  // The phone's updater controls land on the SAME registered handlers this
  // app's own Updates panel and the CLI invoke, so a tap over the tunnel is
  // the identical act — guards, state machine, graceful shutdown and all.
  updaterState: async () => toWireUpdaterState(getUpdaterState()),
  updaterCheck: async () => {
    const check = ipcHandlers.get('updater:check')
    if (!check) return { ok: false, error: 'updater unavailable' }
    return (await check(null)) as { ok: boolean; version?: string | null; error?: string }
  },
  countdownAbort: (countdownId) => countdowns.abort(countdownId, 'user'),
  updaterInstall: async () => {
    // Refuse cleanly when nothing verified is ready — never trip the
    // handler's own failure path (that surfaces an error card on BOTH
    // screens) for what can only be a stale phone tap racing a state change.
    if (is.dev || !isUpdateReady()) return { ok: false }
    const install = ipcHandlers.get('updater:install')
    if (!install) return { ok: false }
    // Answer first, install a beat later: the handler runs the full desktop
    // sequence (installing broadcast, pre-update stamp, graceful shutdown,
    // quitAndInstall), and the phone's reply has to leave on this tunnel
    // before that shutdown takes the process with it. The tunnel itself
    // survives the grace window — shutdownGracefully never stops the Mobile
    // channel — so the phone also sees the 'installing' push before the drop.
    setTimeout(() => {
      void install(null)
    }, 500)
    return { ok: true }
  },
  // What the OS has ACTUALLY registered, not the stored intent — the two
  // disagree whenever a registration failed, which on Linux used to be always.
  launchAtStartupActive: async () => (await readAutostartStatus()).active,
  // The terminal half of this desktop, as the phone's CLI card reports it.
  // Same two probes the Channels → CLI panel runs, so the card on the phone
  // and the card in the window answer from one source rather than two.
  cliPathInstalled: async () => (await cliPathStatus()).installed,
  cliMechanism: async () => autostartMechanism(await currentRunMode()),
  // Deliberately lazy: extensionServer is constructed a few statements below,
  // and this closure only runs once a phone asks for a snapshot.
  extensionStatus: async () => extensionServer.getStatus(),
  extensionReadiness: async () => extensionServer.readiness(),
  // The model's notify_phone gate, persisted with the rest of the workspace
  // config so "off" survives restarts.
  loadNotificationsEnabled: async () => (await getMobileChannelConfig()).notifications !== false,
  saveNotificationsEnabled: async (enabled) => {
    await persistMobileChannelConfig({ notifications: enabled })
  },
  // The phone's feed preference, persisted beside it. Both keys ride the
  // config snapshot to the phone and come back through applyMobileSettings,
  // so the two devices edit one value rather than two drifting copies.
  loadVerbose: async () => (await getMobileChannelConfig()).verbose === true,
  saveVerbose: async (verbose) => {
    await persistMobileChannelConfig({ verbose })
  },
  onStatus: (status) => broadcast('mobile:statusChange', status),
  // A project re-file made on the phone is a write to this app's own
  // conversation file, so the rail, History and the Projects page re-read on
  // the very signal a re-file made here fires.
  onConversationChanged: (id) => broadcast('conversation:changed', { id }),
  // Connection logging is unconditional — a link that will not form is
  // exactly when the record is needed, and it lands in the workspace log
  // beside every other channel's, rotated per day like the rest.
  log: (line) => wlog.info('mobile', line),
  // The same file, one level down: served RPCs, pushes, per-frame counters.
  // `grep -v DEBUG` on the day's log gives back the ordinary story.
  debug: (line) => wlog.debug('mobile', line)
})
// Live-mirror in-flight channel turns into the in-app view: a Telegram/WhatsApp
// run streams throttled assistant-message snapshots to the renderer so an open
// conversation reflects it AS IT HAPPENS, instead of the whole transcript
// appearing at once only after the end-of-turn disk save. The snapshot's stable
// id matches the message the same turn later persists, so the renderer upserts
// by id (never a duplicate). Payload-targeted (unlike the id-less
// conversation:changed) so the renderer only touches the named conversation.
const mirrorMessageToRenderer = (
  conversationId: string,
  message: ConversationMessage | null,
  userMessage?: ConversationMessage
): void => {
  // Best-effort UI mirror. The channel invokes this from inside the turn's
  // render chain (which also drives the outbound bot sends + the persist), so
  // a throw here — e.g. webContents.send on a window torn down mid-send — must
  // never propagate back and wedge the turn. Same contract as the turn
  // lifecycle listener.
  try {
    // The renderer reads its prompt off disk (channel turns persist the user
    // message before running), so only the assistant half concerns it, and a
    // prompt-only tick has nothing for it at all.
    if (message) broadcast('conversation:messageMirror', { conversationId, message })
  } catch {
    // a broken renderer bridge must never affect the channel turn
  }
  try {
    // The phone gets the same in-flight snapshot the renderer does, so a
    // Telegram or WhatsApp run is visible there while it is still writing —
    // as the FULL message (prose + segments, stable id), which the phone
    // upserts into its cached body. Upsert, not refetch-per-tick: the
    // payload IS the state, so tool and task cards render mid-turn and the
    // end-of-turn save replaces the snapshot under the same id.
    //
    // The prompt rides along. It IS on disk for a channel turn, but the phone
    // deliberately does not re-read the body mid-turn, so without this the
    // Telegram message being answered is invisible there until the turn ends.
    mobileChannel.pushMessageAppended(conversationId, message ?? undefined, userMessage)
  } catch {
    // and neither must a broken tunnel
  }
}

/**
 * Turn lifecycle → the phone. `started` lets it show the conversation as
 * running; the terminal phases tell it the stored body is now behind, which
 * is what makes a run started elsewhere land on the phone without the user
 * doing anything.
 *
 * The metadata rides EVERY phase, `started` included: an autonomous run saves
 * its conversation shell before its lifecycle fires (that ordering is what
 * puts it in this app's own rail the moment it starts), and channel turns
 * persist their prompt the same way — so the phone's list can show the real
 * title, icon and origin from the first instant instead of synthesizing a row
 * from the live turn until the run ends. A conversation with no file yet (an
 * in-app first message, saved when the turn folds) simply pushes nothing.
 */
function pushTurnToMobile(ev: {
  phase: string
  conversationId: string | null
  channel?: string
}): void {
  if (!ev.conversationId) return
  try {
    mobileChannel.pushTurnStatus(ev.conversationId, ev.phase, ev.channel ?? null)
    void pushConversationToMobile(ev.conversationId)
  } catch {
    // never let a dead tunnel disturb a turn
  }
}
telegramChannel.setMessageMirror(mirrorMessageToRenderer)
whatsappChannel.setMessageMirror(mirrorMessageToRenderer)
// A terminal turn mirrors exactly like a Telegram one: it persists its user
// message before running, so both the app window and the phone can follow a
// CLI run live instead of learning about it at the fold.
cliChannel.setMessageMirror(mirrorMessageToRenderer)
// Automations and procedures mirror the same way. Their conversation is
// created and saved BEFORE the run starts, so it can be opened while it works
// — and this is what makes that feed fill in live instead of sitting on the
// prompt until the run ends.
agent.setAutonomousMessageMirror(mirrorMessageToRenderer)
// And they take mid-turn messages the same way. An automation or heartbeat job
// runs unattended for minutes — it is the run a user most often wants to steer
// — but it calls agent.respond() directly instead of riding a TurnRunner lane,
// so the inbox refused every message aimed at it and the sending window was
// left holding words it could not show. The bridge lends those runs the
// runner's own inbox: same accept, same park, same sweep, same reconciler.
agent.setAutonomousInterjections({
  open: (conversationId) => turnRunner.openOffLaneRun(conversationId),
  take: (conversationId, turnId) => turnRunner.drainInterjections(conversationId, turnId),
  close: (conversationId, reason) => turnRunner.closeOffLaneRun(conversationId, reason)
})
// Phone-run turns mirror INTO the renderer — the last quarter of the mirror
// matrix, and the one that was missing: a turn started on the phone streamed
// to the phone alone, so the desktop's own window showed a thinking shimmer
// over a blank conversation for the whole run and the transcript landed all
// at once at the end-of-turn save. Renderer half only — the phone half is the
// mobile channel's own sink, and routing through mirrorMessageToRenderer
// would push every snapshot to the phone twice.
mobileChannel.setMessageMirror((conversationId, message) => {
  try {
    if (message) broadcast('conversation:messageMirror', { conversationId, message })
  } catch {
    // a broken renderer bridge must never affect the phone's turn
  }
})
// In-app turns mirror the OTHER way: their renderer already streams
// (chat:segment), so the snapshot goes only to the paired phone — as a FULL
// message (prose + segments, stable id) the phone upserts into its cached
// body. That is what makes a desktop-chat run, its task cards included,
// appear on the phone while it is still writing instead of all at once at
// the end-of-turn save. Text rides the same payload, so no message.delta
// bubble is emitted for these turns — one rendering path, no duplicates.
electronChannel.setMessageMirror((conversationId, message, userMessage) => {
  try {
    // `message` is null on the prompt-only tick this channel emits at send,
    // which reaches the phone as a nudge carrying the user message — the one
    // copy of an in-app prompt that exists anywhere but the renderer's feed
    // until the turn folds to disk.
    mobileChannel.pushMessageAppended(conversationId, message ?? undefined, userMessage)
  } catch {
    // a broken tunnel must never affect the in-app turn
  }
})
const extensionServer = new ExtensionServer()

// MCP server connections. Each connected server registers an in-process
// cerebellum capability (`mcp-<slug>`), so its tools reach the Brain and
// workflow agents through the exact same per-turn selection path as
// every other capability — connect/disconnect just adds/removes the
// registration. All lifecycle noise stays inside the manager.
const mcpManager = new McpManager({
  register: (capability, plugin) =>
    agent.cerebellum.registerInProcessCapability(capability, plugin),
  unregister: (name) => agent.cerebellum.unregisterInProcessCapability(name),
  openExternal: (url) => void shell.openExternal(url),
  appVersion: app.getVersion(),
  onStatusChange: (snapshots) => broadcast('mcp:statusChange', snapshots),
  takenCapabilityNames: () => new Set(agent.cerebellum.getCapabilities().map((c) => c.name))
})

agent.amygdala.setApprovalBridge((req) => turnRouter.dispatchApproval(req))
agent.cerebellum.setAskBridge((req) => turnRouter.dispatchAskUser(req))
// Wire the agent-management bridge the `workflow` capability's plugin
// receives in its init context. It forwards to the Agent's active workflow
// session — the single source of truth for a turn's live subagents.
agent.cerebellum.setWorkflowHost(agent.workflowHost())
// Wire the MCP-management bridge the `mcp` capability's plugin receives in its
// init context. It forwards to the McpManager — the exact same methods the
// Settings → MCP IPC handlers call — so an agent-driven add/test/remove
// reflects in the UI (via mcp:statusChange) exactly like a manual one.
agent.cerebellum.setMcpHost({
  list: () => mcpManager.snapshot(),
  add: (input) => mcpManager.add(input),
  test: (id) => mcpManager.test(id),
  remove: (id) => mcpManager.remove(id),
  setEnabled: (id, enabled) => mcpManager.setEnabled(id, enabled),
  authorize: (id) => mcpManager.authorize(id)
})
// Wire the retrieval bridge the `introspect` capability's plugin receives in
// its init context. It queries the SAME cortex index the ambient context
// assembly reads, so memory_search / conversation_list / usage_report and the
// prompt's memory section can never disagree about what wolffish knows.
agent.cerebellum.setCortexHost({
  searchRecords: (query, opts) => agent.cortex.searchRecords(query, opts),
  getRecordsByRef: (refPrefix, limit) => agent.cortex.getRecordsByRef(refPrefix, limit),
  recordsByDate: (date, sources, limit) => agent.cortex.recordsByDate(date, sources, limit),
  listConversations: (opts) => agent.cortex.listConversations(opts),
  usageSummary: (opts) => agent.cortex.usageSummary(opts),
  searchArtifacts: (opts) => agent.cortex.searchArtifacts(opts),
  coverage: () => agent.cortex.coverage(),
  saveKnowledge: async (file, fact, topic) => {
    // Exact-line dedup here: promoteToKnowledge is append-only by design, so
    // the bridge is where "don't save what's already saved" lives.
    const trimmed = fact.trim()
    const filed = Boolean(topic?.trim())
    if (!trimmed) return { ok: false, deduped: false, filed }
    const line = trimmed.startsWith('-') ? trimmed : `- ${trimmed}`
    let newTopic = filed
    try {
      const { readFile } = await import('node:fs/promises')
      const p = join(workspaceRoot(), 'brain', 'hippocampus', 'knowledge', `${file}.md`)
      const existing = await readFile(p, 'utf8').catch(() => '')
      if (existing.split(/\r?\n/).some((l) => l.trim() === line)) {
        return { ok: true, deduped: true, filed }
      }
      if (filed) {
        const heading = `## ${topic?.trim()}`.toLowerCase()
        newTopic = !existing.split(/\r?\n/).some((l) => l.trim().toLowerCase() === heading)
      }
    } catch {
      // a failed dedup probe must not block the save
    }
    await agent.hippocampus.promoteToKnowledge(file, trimmed, topic)
    // A note filed under a topic that didn't exist yet ADDS a `##` heading, and
    // the memory map (which carries only headings) is cached per calendar day —
    // without this the new topic would stay invisible until midnight. Filing
    // into an existing topic changes no heading, so it costs no cache break.
    if (newTopic) agent.prefrontal.invalidateMemoryMap()
    return { ok: true, deduped: false, filed }
  }
})
// Wire the amend surface the `knowledge` capability's plugin receives. The
// store owns the allowlist, the structure invariants and the .bak safety net;
// this bridge only validates the target name (a plugin arg is untrusted input)
// and hands the memory map a targeted invalidation when topics change.
const knowledgeStore = new KnowledgeStore({
  workspaceRoot: workspaceRoot(),
  corpus: agent.corpus,
  onKnowledgeTopicsChanged: () => agent.prefrontal.invalidateMemoryMap()
})
{
  const badTarget = (target: string): { ok: false; error: string } => ({
    ok: false,
    error: `Unknown target "${target}" — pick one of: ${KNOWLEDGE_TARGETS.join(', ')}.`
  })
  agent.cerebellum.setKnowledgeHost({
    targets: () => [...KNOWLEDGE_TARGETS],
    list: () => knowledgeStore.list(),
    read: async (target) => {
      if (!isKnowledgeTarget(target)) return badTarget(target)
      const { rel, content } = await knowledgeStore.read(target)
      return { ok: true as const, rel, content }
    },
    add: async (target, entry, opts) =>
      isKnowledgeTarget(target)
        ? knowledgeStore.add(target, entry, {
            section: opts.section,
            source: opts.source as EntrySource | undefined
          })
        : badTarget(target),
    edit: async (target, find, replace) =>
      isKnowledgeTarget(target) ? knowledgeStore.edit(target, find, replace) : badTarget(target),
    forget: async (target, find) =>
      isKnowledgeTarget(target) ? knowledgeStore.forget(target, find) : badTarget(target),
    rewrite: async (target, content) =>
      isKnowledgeTarget(target) ? knowledgeStore.rewrite(target, content) : badTarget(target),
    restore: async (target) =>
      isKnowledgeTarget(target) ? knowledgeStore.restore(target) : badTarget(target)
  })
}
// Feed live channel connectivity to the introspect capability so the agent can
// check whether Telegram/WhatsApp are reachable (via `channel_status` /
// `wolffish_status`) and tell the user how to reconnect a disconnected one.
agent.cerebellum.setChannelStatusProvider(() =>
  collectChannelStatus({
    telegram: () => telegramChannel.getStatus(),
    whatsapp: () => whatsappChannel.getStatus(),
    mobile: () => mobileChannel.getStatus(),
    // The agent's own view has to include the terminal, or on a headless box
    // it believes it has no way to answer the person it is talking to.
    cli: () => ({ clients: cliServer.clientCount(), listening: cliServer.isListening() }),
    headless: () => IS_HEADLESS
  })
)
// ── Video generation (MiniMax H3) ────────────────────────────────────────
// Wire the async-task bridge the `video` capability's plugin receives in its
// init context. VideoTaskManager owns the whole task lifetime (media prep,
// task creation, 10s poll loop, artifact download); the host stamps the
// active conversation/turn onto every submit so tasks land in the right
// transcript and ride the right turn's segment stream.
agent.cerebellum.setVideoTasksHost({
  check: () => checkVideoService(),
  submit: (input) =>
    videoTasks.submit(
      agent.cerebellum.getCurrentConversationId(),
      turnScope.getStore()?.turnId ?? null,
      input
    ),
  awaitTask: (taskId, signal) => videoTasks.awaitTask(taskId, signal),
  cancel: (taskId) => videoTasks.cancel(taskId),
  get: (taskId) => videoTasks.get(taskId),
  list: () => videoTasks.listFor(agent.cerebellum.getCurrentConversationId())
})
// Every snapshot change reaches the renderer so an open conversation's task
// card updates live even after its turn ended — the renderer folds the push
// into its in-memory copy, so its next whole-file save carries it.
// High-frequency-adjacent → MOBILE_CONFIG_SILENT below.
videoTasks.onSnapshot((snapshot) => broadcast('task:changed', snapshot))
// Terminal fallback: when a task outlives its turn (the model moved on, the
// turn was cancelled, the app restarted), the manager still has to finish
// the job — persist the final card state and get the artifact to a channel
// user. While the owning turn is live this is a no-op: the model is the
// delivery path (video_await → send_file / channel send tools).
videoTasks.onTerminal((snapshot) => {
  void deliverVideoTaskFallback(snapshot)
})
void videoTasks.init()

// ── Turn-end countdowns ──────────────────────────────────────────────────
// The manager fires an armed tool call after the arming turn ends (see
// runtime/countdown.ts). `system_power` arms through the host below; the
// model arms anything else through the generic `countdown_start` tool.
countdowns.setExecutor((tool, args) => agent.cerebellum.executeTool(tool, args))
agent.cerebellum.setCountdownHost({
  arm: (input) => {
    const scope = turnScope.getStore()
    if (scope?.autonomous) {
      return Promise.resolve({
        ok: false as const,
        error:
          'Countdowns are refused in an automation run: nobody is watching the card to abort it.'
      })
    }
    return countdowns.arm(agent.cerebellum.getCurrentConversationId(), scope?.turnId ?? null, input)
  },
  isFiring: () => countdowns.isFiring(),
  pending: () => countdowns.pending()
})
registerCountdownCapability(agent.cerebellum, agent.amygdala, countdowns)
// ── Check-ins ────────────────────────────────────────────────────────────
// A tool call that runs past its check-in delay is parked, still running,
// and the model decides (runtime/check-in.ts). The progress a running tool
// reports (PluginContext.progressReporter) is what the check-in shows.
checkIns.setProgressSource((toolCallId) => agent.cerebellum.getToolProgress(toolCallId))
registerCheckInCapability(agent.cerebellum, checkIns)
// ── Wolffish's own browser ───────────────────────────────────────────────
// Tabs live in main (WebContentsView, z-parked under the app UI); the
// `preview` capability is the model's handle on them. State changes reach
// every surface through broadcast; frames go straight to the renderer —
// never through broadcast, whose CLI/mobile fan-out would serialise 30 JPEG
// buffers a second onto a terminal socket.
registerPreviewCapability(agent.cerebellum, browserTabs)
browserTabs.setStillGate(() => mobileChannel.hasPeer)
browserTabs.setHandlers({
  onChanged: (snapshot) => {
    broadcast('browser:changed', snapshot)
    if (mobileChannel.hasPeer) mobileChannel.pushBrowserChanged(snapshot)
  },
  onClosed: (tabId, reason) => broadcast('browser:closed', { tabId, reason }),
  onFrame: (frame) => {
    const win = mainBrowserWindow()
    if (win && !win.isDestroyed()) win.webContents.send('browser:frame', frame)
  }
})
// Blocking waits (`wait`, utilities). No cross-turn plumbing: a wait lives
// and dies inside the tool call that is holding its turn open, so its cards
// ride that turn's broca and its only outside input is a mid-turn message —
// which the turn runner already hands to WaitManager.interrupt.
agent.cerebellum.setWaitHost({
  start: (input, signal) => waits.start(input, signal)
})
// Every transition reaches the renderer and the phone — the arming turn's
// broca carries only the `armed` state; counting/fired/aborted happen after
// the turn ended and have no stream to ride. High-frequency-adjacent →
// MOBILE_CONFIG_SILENT below.
countdowns.onSnapshot((snapshot) => {
  broadcast('countdown:changed', snapshot)
  if (mobileChannel.hasPeer) mobileChannel.pushCountdownChanged(snapshot)
})
// Once the write-through has refreshed the on-disk body, nudge the phone to
// re-read it (the deliverVideoTaskFallback pattern): the push above folds the
// card live when the phone already holds the message, this covers the case
// where it does not yet.
countdowns.onWritten((snapshot) => {
  if (snapshot.conversationId && mobileChannel.hasPeer) {
    mobileChannel.pushMessageAppended(snapshot.conversationId, undefined)
  }
})
void countdowns.init()

// ── Managed processes ──────────────────────────────────────────────────
// One registry of long-lived processes (dev servers, tunnels, watchers…)
// that outlive the tool call, the turn and the app — see src/main/processes.
// The model drives it through the `processes` capability; the shell plugin's
// background path delegates into it through the seam below; Library and the
// chat card act through the IPC handlers further down. Card updates after
// the opening turn ended ride process:cardChanged plus a conversation-file
// write-through, the countdown pattern.
registerProcessesCapability(agent.cerebellum, agent.amygdala, processManager)
agent.cerebellum.setProcessesHost({
  start: async (input) => {
    const name = input.name ?? `bg-${Date.now().toString(36).slice(-4)}`
    const result = await processManager.start({
      name,
      command: input.command,
      cwd: input.cwd,
      env: input.env,
      port: { mode: 'none' },
      restart: 'never',
      onQuit: 'keep',
      origin: input.origin ?? {
        conversationId: agent.cerebellum.getCurrentConversationId(),
        kind: 'shell'
      },
      wait: input.wait ?? false
    })
    if (!result.ok) return { ok: false, error: result.error }
    return {
      ok: true,
      name: result.record.name,
      pid: result.record.run.pid,
      logPath: result.record.run.logPath,
      url: result.record.run.url
    }
  },
  list: () =>
    processManager.list().map((r) => ({
      name: r.name,
      pid: r.run.pid,
      state: r.run.state,
      command: r.command,
      cwd: r.cwd,
      logPath: r.run.logPath,
      startedAt: r.run.startedAt
    })),
  stop: (name) => processManager.stop(name),
  stopAll: () => processManager.stopAll(),
  findByPid: (pid) =>
    processManager.list().find((r) => r.run.pid === pid && isProcessLive(r))?.name ?? null
})
processManager.onChanged(() => {
  broadcast('processes:changed', {})
  if (mobileChannel.hasPeer) mobileChannel.pushProcessesChanged()
})
processManager.onCard((snapshot) => {
  broadcast('process:cardChanged', snapshot)
  if (mobileChannel.hasPeer) mobileChannel.pushProcessCardChanged(snapshot)
  if (processManager.isOwningTurnLive(snapshot.cardId) || !snapshot.conversationId) return
  // The opening turn is over: rewrite the card in the conversation file in
  // place so a reopened conversation shows its last state.
  void updateConversation(snapshot.conversationId, (current) => {
    if (!current) return null
    let found = false
    for (const message of current.messages) {
      for (const seg of message.segments ?? []) {
        if (seg.kind === 'process' && seg.snapshot.cardId === snapshot.cardId) {
          seg.snapshot = snapshot
          found = true
        }
      }
    }
    return found ? current : null
  }).catch(() => undefined)
})
processManager.onCrash((record) => {
  wlog.warn(
    '[processes]',
    `${record.name} crashed (exit ${record.run.exitCode ?? '?'})${record.run.lastError ? `: ${record.run.lastError}` : ''}`
  )
})
void processManager
  .init()
  .catch((err) =>
    wlog.warn('[processes]', `init failed: ${err instanceof Error ? err.message : String(err)}`)
  )

async function deliverVideoTaskFallback(snapshot: TaskSnapshot): Promise<void> {
  if (videoTasks.isOwningTurnLive(snapshot.taskId)) return
  const conversationId = snapshot.conversationId
  if (!conversationId) return
  // 1. Write the terminal snapshot into the conversation file. No turn is
  //    alive to persist segments, so without this a reopen would show the
  //    card frozen mid-run. Replaces the existing task segment in place
  //    (keeping its ids); if the turn died before any segment persisted,
  //    a minimal assistant message carries the card instead.
  await updateConversation(conversationId, (current) => {
    if (!current) return null
    let found = false
    for (const message of current.messages) {
      for (const seg of message.segments ?? []) {
        if (seg.kind === 'task' && seg.snapshot.taskId === snapshot.taskId) {
          seg.snapshot = snapshot
          found = true
        }
      }
    }
    if (!found) {
      current.messages.push({
        id: mintMessageId(),
        role: 'assistant',
        content: '',
        timestamp: Date.now(),
        segments: [
          {
            kind: 'task',
            turnId: `task_${snapshot.taskId}`,
            segmentId: `task_${snapshot.taskId}`,
            snapshot
          }
        ]
      })
    }
    return current
  }).catch(() => undefined)
  broadcast('conversation:changed', { id: conversationId })
  // The write-through above just refreshed the on-disk body — nudge the
  // phone to re-read it so an open mobile conversation shows the finished
  // task card (and its video) without waiting for a manual refresh.
  if (mobileChannel.hasPeer) mobileChannel.pushMessageAppended(conversationId, undefined)

  // 2. Channel delivery. In-app the card itself shows the video; Telegram/
  //    WhatsApp users get the artifact (or the failure) pushed to them via
  //    the channel send tools — the same post-turn path heartbeats use.
  //    Cancelled tasks stay silent: the user asked for that.
  const conversation = await loadConversation(conversationId).catch(() => null)
  const channel = conversation?.channel
  if (channel !== 'telegram' && channel !== 'whatsapp') return
  // Single-user default recipient: telegram tools default on their own; the
  // whatsapp tools need an explicit JID, so derive it from the first allowed
  // number (a group-originated conversation falls back to the primary user).
  const waJid =
    channel === 'whatsapp'
      ? await getWhatsAppConfig()
          .then((cfg) => {
            const phone = cfg.allowedPhoneNumbers?.[0]?.replace(/[^0-9]/g, '')
            return phone ? `${phone}@s.whatsapp.net` : null
          })
          .catch(() => null)
      : null
  if (channel === 'whatsapp' && !waJid) return
  const sendText = async (message: string): Promise<void> => {
    const sendTool = channel === 'telegram' ? 'telegram_send' : 'whatsapp_send'
    await agent.cerebellum
      .executeTool(sendTool, channel === 'telegram' ? { message } : { jid: waJid, message })
      .catch(() => undefined)
  }
  const title = snapshot.title
  if (snapshot.status === 'succeeded' && snapshot.outputPath) {
    const tool = channel === 'telegram' ? 'telegram_send_video' : 'whatsapp_send_video'
    const args =
      channel === 'telegram'
        ? { path: snapshot.outputPath, caption: `🎬 ${title}` }
        : { jid: waJid, path: snapshot.outputPath, caption: `🎬 ${title}` }
    const result = await agent.cerebellum
      .executeTool(tool, args as Record<string, unknown>)
      .catch(() => ({ success: false as const, error: 'send failed' }))
    if (result.success) {
      // Tell the manager the artifact already reached the user, so the
      // pending runtime-tail notice flips to "already delivered". Without
      // this the model's next turn is told to present it and sends the same
      // video a second time.
      videoTasks.markDelivered(snapshot.taskId)
    } else {
      await sendText(
        `🎬 ${title}: the video is ready — open the app to watch it (sending it here failed).`
      )
    }
  } else if (snapshot.status === 'failed') {
    await sendText(`🎬 ${title}: video generation failed — ${snapshot.error ?? 'unknown error'}`)
  }
}

// Rolling prefix summarizer: fires after conversation persistence (channel
// post-turn saves + the conversation:save IPC). The onUpdated push tells the
// renderer to fold {summary, mark} into its in-memory conversation so its
// next whole-file save preserves rather than clobbers the summary.
configureSummarizer({
  thalamus: agent.thalamus,
  onUpdated: (update) => broadcast('conversation:summaryUpdated', update)
})

function currentThemeState(): ThemeState {
  return {
    themeSource: nativeTheme.themeSource as ThemeSource,
    shouldUseDarkColors: nativeTheme.shouldUseDarkColors
  }
}

function backgroundColor(): string {
  return nativeTheme.shouldUseDarkColors ? '#0d1117' : '#f0f4f8'
}

let tray: Tray | null = null

// --- Custom Windows tray popup menu -----------------------------------------
// Native Win32 tray context menus are sized by the OS, so Electron can't make
// them bigger. On Windows we instead draw our own menu in a small frameless,
// transparent popup window (see src/preload/trayMenu.ts) scaled ~30% larger.
// The window size is fixed to that popup's CSS: a 244px card plus a 14px
// transparent margin on every side for the drop shadow.
const TRAY_POPUP_WIDTH = 272
const TRAY_POPUP_HEIGHT = 136

let trayPopup: BrowserWindow | null = null
let trayPopupShownAt = 0
let trayMenuLocale: Locale = 'en'

// The main app window — never the tray popup. Adding the popup means a bare
// `getAllWindows()[0]` could grab the wrong window, so restore/show paths use
// this helper instead.
function mainBrowserWindow(): BrowserWindow | null {
  return BrowserWindow.getAllWindows().find((w) => w !== trayPopup && !w.isDestroyed()) ?? null
}

function restoreMainWindow(): void {
  const win = mainBrowserWindow()
  if (win) {
    if (win.isMinimized()) win.restore()
    win.show()
    win.focus()
    showDock()
  } else {
    createWindow()
    showDock()
  }
}

function buildTrayPopup(): BrowserWindow {
  const popup = new BrowserWindow({
    width: TRAY_POPUP_WIDTH,
    height: TRAY_POPUP_HEIGHT,
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    hasShadow: false,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: join(__dirname, '../preload/trayMenu.js'),
      sandbox: false,
      contextIsolation: true
    }
  })
  popup.setMenu(null)
  // Dismiss on click-away. Ignore the blur that can fire as the window first
  // takes focus, otherwise it would hide itself the instant it opens.
  popup.on('blur', () => {
    if (Date.now() - trayPopupShownAt > 120) popup.hide()
  })
  void popup.loadURL(
    'data:text/html;charset=UTF-8,' +
      encodeURIComponent(
        '<!doctype html><html><head><meta charset="utf-8"><title>Wolffish</title></head><body></body></html>'
      )
  )
  return popup
}

function showTrayPopup(bounds: Electron.Rectangle): void {
  const popup = trayPopup ?? (trayPopup = buildTrayPopup())
  const state = { locale: trayMenuLocale, dark: nativeTheme.shouldUseDarkColors }

  const area = screen.getDisplayMatching(bounds).workArea
  // Anchor to the tray icon: right-aligned, opening upward from a bottom
  // taskbar (downward if the tray sits in the top half of the screen).
  let x = Math.round(bounds.x + bounds.width - TRAY_POPUP_WIDTH)
  const openUp = bounds.y + bounds.height / 2 > area.y + area.height / 2
  let y = openUp ? Math.round(bounds.y - TRAY_POPUP_HEIGHT) : Math.round(bounds.y + bounds.height)
  x = Math.min(Math.max(x, area.x), area.x + area.width - TRAY_POPUP_WIDTH)
  y = Math.min(Math.max(y, area.y), area.y + area.height - TRAY_POPUP_HEIGHT)
  popup.setBounds({ x, y, width: TRAY_POPUP_WIDTH, height: TRAY_POPUP_HEIGHT })

  const sendState = (): void => popup.webContents.send('tray-menu:render', state)
  if (popup.webContents.isLoading()) popup.webContents.once('did-finish-load', sendState)
  else sendState()

  trayPopupShownAt = Date.now()
  popup.show()
  popup.focus()
}

// The tray artwork (icon_transparent.png) sits on a large transparent canvas —
// the fish fills only ~79% of the width and ~65% of the height — so at tray
// size it rendered noticeably smaller than neighboring app icons. Trim to the
// opaque content and pad back out to a centered square so Windows draws the
// logo edge-to-edge like other apps, without distorting its aspect ratio.
function trayIconImage(size: number): Electron.NativeImage {
  const source = nativeImage.createFromPath(trayIconDefault)
  const { width, height } = source.getSize()
  const bitmap = source.toBitmap() // BGRA, 4 bytes per pixel; we only read alpha
  const ALPHA = 16
  let minX = width
  let minY = height
  let maxX = -1
  let maxY = -1
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (bitmap[(y * width + x) * 4 + 3] > ALPHA) {
        if (x < minX) minX = x
        if (x > maxX) maxX = x
        if (y < minY) minY = y
        if (y > maxY) maxY = y
      }
    }
  }
  let cropped = source
  if (maxX >= minX && maxY >= minY) {
    // Square holding the content + a little breathing room so the outline
    // isn't clipped, centered on the content's midpoint and clamped to canvas.
    const side = Math.round(Math.max(maxX - minX + 1, maxY - minY + 1) * 1.03)
    const cx = (minX + maxX) / 2
    const cy = (minY + maxY) / 2
    const x = Math.max(0, Math.min(Math.round(cx - side / 2), width - side))
    const y = Math.max(0, Math.min(Math.round(cy - side / 2), height - side))
    const clamped = Math.min(side, width - x, height - y)
    cropped = source.crop({ x, y, width: clamped, height: clamped })
  }
  return cropped.resize({ width: size, height: size })
}

function createTray(locale: Locale = 'en'): void {
  if (tray) return
  const isAr = locale === 'ar'
  trayMenuLocale = locale
  let img: Electron.NativeImage
  if (process.platform === 'darwin') {
    // Unified with Windows/Linux: show the transparent colored logo (not the white template),
    // keeping the existing 22pt menu-bar size (22x22 @1x, 44x44 @2x for retina).
    const base = nativeImage.createFromPath(trayIconDefault)
    img = nativeImage.createEmpty()
    img.addRepresentation({
      scaleFactor: 1,
      width: 22,
      height: 22,
      buffer: base.resize({ width: 22, height: 22 }).toPNG()
    })
    img.addRepresentation({
      scaleFactor: 2,
      width: 44,
      height: 44,
      buffer: base.resize({ width: 44, height: 44 }).toPNG()
    })
  } else {
    img = trayIconImage(32)
  }
  tray = new Tray(img)
  tray.setToolTip('Wolffish')

  if (process.platform === 'win32') {
    // Windows: open the custom, larger popup on right-click instead of the
    // un-resizable native menu. Left/double click still restore the window.
    ipcMain.on('tray-menu:action', (_event, action: 'show' | 'quit') => {
      trayPopup?.hide()
      if (action === 'quit') {
        isQuittingFromTray = true
        app.quit()
      } else {
        restoreMainWindow()
      }
    })
    ipcMain.on('tray-menu:close', () => trayPopup?.hide())
    tray.on('right-click', (_event, bounds) => showTrayPopup(bounds))
  } else {
    // macOS/Linux keep the OS-native context menu (on macOS it also handles
    // left-click).
    const contextMenu = Menu.buildFromTemplate([
      {
        label: isAr ? 'إظهار وولفيش' : 'Show Wolffish',
        click: () => restoreMainWindow()
      },
      { type: 'separator' },
      {
        label: isAr ? 'إغلاق' : 'Quit',
        click: () => {
          isQuittingFromTray = true
          app.quit()
        }
      }
    ])
    tray.setContextMenu(contextMenu)
  }

  // On Windows/Linux a single left-click restores the window (standard tray
  // behavior); macOS routes clicks through the context menu above.
  if (process.platform !== 'darwin') {
    tray.on('click', restoreMainWindow)
  }
  tray.on('double-click', restoreMainWindow)
}

function showDock(): void {
  if (process.platform !== 'darwin') return
  void app.dock?.show().then(() => {
    if (is.dev) app.dock?.setIcon(dockIcon)
  })
}

let isQuittingFromTray = false

function createWindow(): BrowserWindow {
  const mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 1280,
    minHeight: 860,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: backgroundColor(),
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    ...(process.platform !== 'darwin' ? { icon } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      plugins: true,
      // Enables the <webview> tag used by the in-chat page viewer to render a
      // fetched website inline (borderless, isolated 'pageviewer' partition).
      webviewTag: true
    }
  })

  mainWindow.on('ready-to-show', () => mainWindow.show())

  mainWindow.on('show', () => {
    mainWindow.webContents.executeJavaScript('document.activeElement?.blur()').catch(() => {})
  })

  // Windows shutdown / restart / log-off. `query-session-end` fires first and
  // is the only warning we get; `session-end` follows and cannot be stopped.
  // Neither goes through before-quit's drain, so an in-flight turn would
  // otherwise die exactly where it stood — which is how a forty-minute run
  // came back as nothing but the prompt the titler shell wrote before it
  // started. Both flush; the checkpointer's no-op guard makes the second free.
  // We do NOT preventDefault: the user asked the machine to restart, and the
  // periodic checkpoint means there is at most a few seconds of prose at risk.
  const flushForSessionEnd = (): void => {
    wlog.info('[quit]', 'windows session ending — flushing in-flight turns')
    void electronChannel.flushCheckpoints().catch(() => undefined)
  }
  mainWindow.on('query-session-end', flushForSessionEnd)
  mainWindow.on('session-end', flushForSessionEnd)

  mainWindow.on('close', (event) => {
    if (updateInstallInProgress) return
    if (isQuittingFromTray || isShuttingDown) {
      if (quitInProgress) {
        event.preventDefault()
        return
      }
      if (hasInflightWork()) {
        event.preventDefault()
        quitInProgress = true
        broadcast('app:closingPending', { tasks: pendingBackgroundTasks })
        void drainAndQuit()
      }
      return
    }
    event.preventDefault()
    mainWindow.hide()
    if (process.platform === 'darwin') app.dock?.hide()
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  // Every <webview> the renderer mounts (website card, HTML file preview) is
  // an untrusted page. Whatever attributes the tag carries, the guest never
  // gets a preload, node, or the host's context — it is a browser tab and
  // nothing more.
  mainWindow.webContents.on('will-attach-webview', (_event, webPreferences) => {
    delete webPreferences.preload
    webPreferences.nodeIntegration = false
    webPreferences.contextIsolation = true
    webPreferences.sandbox = true
  })

  // Spellcheck. Chromium underlines misspellings for free (webPreferences.spellcheck
  // defaults to true). The engine is per-OS: macOS uses the native OS spellchecker
  // (auto language, offline, and the setters below are no-ops), while Windows/Linux
  // use Hunspell — which needs a language set and downloads its dictionaries from a
  // CDN on first use — so only configure it off macOS.
  if (process.platform !== 'darwin') {
    try {
      const ses = mainWindow.webContents.session
      const available = ses.availableSpellCheckerLanguages
      const wanted = [app.getLocale(), 'en-US'].filter((l, i, a) => !!l && a.indexOf(l) === i)
      const langs = wanted.filter((l) => available.includes(l))
      if (langs.length) ses.setSpellCheckerLanguages(langs)
    } catch (err) {
      console.error('[spellcheck] language setup failed:', err)
    }
  }

  // The misspelled word and its suggestions live ONLY in this main-process event —
  // the DOM 'contextmenu' event the renderer sees carries none of it. Relay the
  // spellcheck fields so the renderer's own styled menu can offer corrections and
  // call back into webContents.replaceMisspelling(). Fires for every right-click the
  // page doesn't preventDefault; the renderer decides whether to surface a menu.
  mainWindow.webContents.on('context-menu', (_event, params) => {
    if (mainWindow.isDestroyed()) return
    mainWindow.webContents.send('spellcheck:contextMenu', {
      isEditable: params.isEditable,
      misspelledWord: params.misspelledWord,
      dictionarySuggestions: params.dictionarySuggestions
    })
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }

  return mainWindow
}

function broadcastThemeUpdate(): void {
  const state = currentThemeState()
  for (const w of BrowserWindow.getAllWindows()) {
    w.webContents.send('theme:updated', state)
  }
}

/**
 * Push one conversation's metadata to the phone. Metadata only, matching the
 * index: the phone fetches the body when the user opens it.
 *
 * Reads the one file it describes rather than listing the whole directory —
 * this now runs at every turn START as well as every end, and a walk of the
 * full history per turn is real I/O for a single row's worth of fields.
 */
async function pushConversationToMobile(id: string): Promise<void> {
  try {
    const conv = await loadConversation(id)
    if (!conv) return
    mobileChannel.pushConversationUpserted({
      id: conv.id,
      title: conv.title,
      model: null,
      channel: conv.channel ?? null,
      icon: conv.icon ?? null,
      projectId: conv.projectId ?? null,
      sealed: false,
      createdAt: conv.updatedAt,
      updatedAt: conv.updatedAt,
      messageCount: conv.messages?.length ?? 0,
      stats: null,
      summary: null
    })
  } catch {
    // A push that cannot be built must never disturb the desktop's own save.
  }
}

/**
 * Renderer broadcasts that are NOT a change to desktop-owned configuration.
 *
 * A denylist, deliberately, not an allowlist: the phone mirrors the whole
 * settings surface, and a setting added next month must reach it without
 * anyone remembering to wire a push. Anything not named here is assumed to
 * have moved config, which costs one cheap snapshot fetch and can never leave
 * the phone stale. Named here are the high-frequency streams and the signals
 * that already have their own targeted mobile push.
 */
const MOBILE_CONFIG_SILENT = new Set([
  'app:closingPending',
  // A conversation's plan-mode stance — the phone gets its own push.
  'chat:planMode',
  'automations:copyProgress',
  'procedures:copyProgress',
  'chat:turnState',
  'conversation:changed',
  'conversation:deleted',
  'conversation:messageMirror',
  'conversation:summaryUpdated',
  'diagnostics:progress',
  'heartbeat:jobLog',
  'mobile:statusChange',
  'model:pullProgress',
  'ollama:changed',
  'projects:copyProgress',
  'reindex:progress',
  'task:changed',
  'countdown:changed',
  'processes:changed',
  'process:cardChanged',
  // In-app browser: tab state and close events are per-card pushes, not
  // config. (Frames never go through broadcast at all.)
  'browser:changed',
  'browser:closed'
])

/**
 * Autostart, dispatched by platform and run mode.
 *
 * A GUI install on macOS/Windows keeps using Electron's login item — that path
 * works and there is no reason to replace it. Everything else goes through the
 * autostart module, because `setLoginItemSettings` is `@platform darwin,win32`
 * and has never done anything at all on Linux: the app shipped a toggle there
 * that wrote a preference and registered nothing. `active` below is what is
 * REGISTERED, never what was asked for, which is what makes that visible.
 */
async function currentRunMode(): Promise<AutostartMode> {
  const cfg = await getCliConfig().catch(() => ({}) as { runMode?: 'gui' | 'headless' })
  return cfg.runMode === 'headless' ? 'headless' : 'gui'
}

function usesElectronLoginItem(mode: AutostartMode): boolean {
  return mode === 'gui' && (process.platform === 'darwin' || process.platform === 'win32')
}

/**
 * Turn autostart on or off. THE one writer — the Wolffish tab's toggle and the
 * CLI panel's Register button both land here, and it moves both halves
 * together: the stored intent, then the OS registration. Splitting them (one
 * screen writing the preference, another writing the unit) is how the two end
 * up disagreeing, and nothing surfaces the disagreement until a reboot.
 */
async function setAutostart(value: boolean): Promise<AutostartFacts> {
  await persistLaunchAtStartup(value)
  const mode = await currentRunMode()
  if (usesElectronLoginItem(mode)) {
    app.setLoginItemSettings({ openAtLogin: value })
    return {
      active: app.getLoginItemSettings().openAtLogin,
      mechanism: 'loginItem',
      warning: null,
      location: null
    }
  }
  const status = value
    ? await installAutostart(mode, app.getPath('exe'))
    : await uninstallAutostart(mode)
  return {
    active: status.active,
    mechanism: status.mechanism,
    warning: status.warning,
    location: status.location
  }
}

/**
 * Re-register autostart only if the OS has lost it. Called once at boot for an
 * install whose stored preference is an explicit yes.
 *
 * Deliberately NOT `setAutostart(true)`: that would rewrite the preference on
 * every launch (a disk write for a value that never changed) and re-run the
 * installer's shell-outs — `systemctl enable`, `launchctl bootstrap` — even
 * when nothing is wrong. Reading the status first makes the healthy path free.
 */
async function reassertAutostart(): Promise<void> {
  const current = await readAutostartStatus()
  if (current.active) return
  const repaired = await setAutostart(true)
  wlog.info(
    '[autostart]',
    repaired.active
      ? `re-registered via ${repaired.mechanism}`
      : `could not re-register via ${repaired.mechanism}${repaired.warning ? ` — ${repaired.warning}` : ''}`
  )
}

async function readAutostartStatus(): Promise<AutostartFacts> {
  const mode = await currentRunMode()
  if (usesElectronLoginItem(mode)) {
    return {
      active: app.getLoginItemSettings().openAtLogin,
      mechanism: 'loginItem',
      warning: null,
      location: null
    }
  }
  const status = await autostartStatus(mode)
  return {
    active: status.active,
    mechanism: status.mechanism,
    warning: status.warning,
    location: status.location
  }
}

/** Everything `wolffish status` prints that isn't a config value. */
async function buildCliStatus(callerPath?: string | null): Promise<Record<string, unknown>> {
  const [workspace, autostart, cliPath] = await Promise.all([
    getStatus().catch(() => null),
    readAutostartStatus().catch(() => null),
    // The terminal's PATH when it sent one — see cliPathStatus for why the
    // daemon's own is the wrong thing to answer this question with.
    cliPathStatus(callerPath).catch(() => null)
  ])
  return {
    version: app.getVersion(),
    platform: process.platform,
    headless: IS_HEADLESS,
    workspace,
    autostart,
    path: cliPath,
    channels: collectChannelStatus({
      telegram: () => telegramChannel.getStatus(),
      whatsapp: () => whatsappChannel.getStatus(),
      mobile: () => mobileChannel.getStatus(),
      cli: () => ({ clients: cliServer.clientCount(), listening: cliServer.isListening() }),
      headless: () => IS_HEADLESS
    }),
    mobile: mobileChannel.getStatus(),
    extension: extensionServer.getStatus(),
    activeRuns: [...turnRunner.activeRuns(), ...agent.activeAutonomousRuns()]
  }
}

/** The CLI's read side — the phone's snapshot, plus the live autostart probe. */
function buildCliSnapshot(): Promise<Record<string, unknown>> {
  return mobileChannel.buildSnapshot()
}

/** Coalesces a burst of config broadcasts into one push. */
let mobileConfigPushTimer: ReturnType<typeof setTimeout> | null = null

function broadcast<T>(channel: string, payload: T): void {
  for (const w of BrowserWindow.getAllWindows()) {
    w.webContents.send(channel, payload)
  }
  // Third audience, same signal, same reason: an attached terminal is another
  // open surface, and a setting saved from the app (or the phone, or a
  // channel command) has to land there too. Hooking the chokepoint is what
  // makes that true for every broadcast there is, including ones added later.
  cliServer.pushBroadcast(channel, payload)
  // Same signal, second audience. Saving a setting fires one of these on
  // every path there is, so hooking here covers them all at once instead of
  // one remembered push per handler.
  if (!MOBILE_CONFIG_SILENT.has(channel)) {
    if (mobileConfigPushTimer) clearTimeout(mobileConfigPushTimer)
    mobileConfigPushTimer = setTimeout(() => {
      mobileConfigPushTimer = null
      // Guarded twice over: an unconnected phone means there is no work worth
      // doing, and a throw escaping a timer callback takes the main process
      // with it — this runs on every settings change, so it must be inert
      // when anything about the tunnel is wrong.
      try {
        if (mobileChannel.hasPeer) mobileChannel.pushConfigChanged(channel)
      } catch {
        // a dead tunnel is not the settings save's problem
      }
    }, 300)
  }
}

/**
 * Tell the phone its own two channel settings moved.
 *
 * Needed because `mobile:statusChange` — the broadcast those setters fire — is
 * on the silent list above, and must stay there: the same payload carries the
 * live tunnel frame counters, so pushing on it would turn a settings hook into
 * a per-frame heartbeat. This is the narrow, deliberate exception: called from
 * the two IPC handlers that actually change a setting, never from the status
 * stream. Best-effort, like every other push — a dead tunnel is not a settings
 * save's problem, and the reconcile on reconnect settles it either way.
 */
function pushMobileChannelConfig(): void {
  try {
    if (mobileChannel.hasPeer) mobileChannel.pushConfigChanged('channels')
  } catch {
    // nothing — the phone re-pulls the snapshot when the link comes back
  }
}

/**
 * The one save path for variables, whatever the origin. The settings panel's
 * IPC and the phone's tunnel RPC both land here, so a save persists once and
 * every other surface hears about it in the same breath: open renderer panels
 * through 'variables:changed', and the phone through the config.changed push
 * broadcast() already schedules for any non-silent channel. Writes apply in
 * arrival order under the config lock — last write wins, both screens
 * converge on it.
 */
async function saveVariablesEverywhere(variables: Variable[]): Promise<void> {
  await persistVariables(variables)
  broadcast('variables:changed', { variables })
  // The phone gets the array itself, now — not just the debounced "something
  // changed" hint broadcast() schedules. Same guard shape as that path: a
  // push is best-effort and a dead tunnel is not the save's problem.
  try {
    if (mobileChannel.hasPeer) mobileChannel.pushVariablesChanged(variables)
  } catch {
    // nothing — config.changed still follows and the phone converges there
  }
}

async function shutdownGracefully(): Promise<void> {
  if (isShuttingDown) return
  isShuttingDown = true

  if (activePull) activePull.abort()
  // Write every in-flight turn to disk BEFORE aborting it. abort() drops the
  // accumulators on the floor, and until this landed a quit (or an update
  // install) mid-run threw away the whole turn — the renderer folds the
  // transcript only at chat:done, which an aborted turn never reaches.
  await electronChannel.flushCheckpoints().catch(() => undefined)
  electronChannel.abort()
  telegramChannel.abort()
  whatsappChannel.abort()
  await telegramChannel.stop('app shutdown').catch(() => undefined)
  await whatsappChannel.stop('app shutdown').catch(() => undefined)
  await extensionServer.stop().catch(() => undefined)
  await mcpManager.stop().catch(() => undefined)
  await agent.stop().catch(() => undefined)
  // The in-app browser: close every tab (each is a renderer process), then
  // flush the cookie store — Chromium commits cookies every 30s/512 ops, and
  // this one await is what makes a login completed seconds before Cmd+Q
  // survive the relaunch.
  browserTabs.destroyAll('shutdown')
  await flushBrowserCookies().catch(() => undefined)
  // Managed processes marked `stop on quit` get their signal; nothing waits.
  processManager.shutdown()
}

// Counts async work (title generation, save) that fired after a turn
// finished. The renderer treats these as fire-and-forget, so without
// tracking them here a Cmd+Q or window-X mid-flight would tear the
// process down before the file hit disk and the conversation would be
// lost. before-quit waits on this counter to drain before exiting.
let pendingBackgroundTasks = 0
let pendingDrainResolvers: Array<() => void> = []
// Held high from the moment the user requests quit until the drain
// finishes. While it's true, every quit/close attempt is blocked —
// otherwise a spammed Cmd+Q would let the second event slip past the
// in-progress drain and kill the process anyway.
let quitInProgress = false
let updateInstallInProgress = false

async function trackBackgroundTask<T>(work: () => Promise<T>): Promise<T> {
  pendingBackgroundTasks += 1
  try {
    return await work()
  } finally {
    pendingBackgroundTasks -= 1
    if (pendingBackgroundTasks === 0) {
      const resolvers = pendingDrainResolvers
      pendingDrainResolvers = []
      for (const r of resolvers) r()
    }
  }
}

function waitForBackgroundDrain(): Promise<void> {
  if (pendingBackgroundTasks === 0) return Promise.resolve()
  return new Promise((resolve) => pendingDrainResolvers.push(resolve))
}

function hasInflightWork(): boolean {
  return (
    !!activePull ||
    electronChannel.hasActiveTurn() ||
    telegramChannel.hasActiveTurn() ||
    whatsappChannel.hasActiveTurn() ||
    pendingBackgroundTasks > 0
  )
}

async function drainAndQuit(): Promise<void> {
  await shutdownGracefully()
  await waitForBackgroundDrain()
  // Drop the gate so our own app.quit() below isn't blocked. The
  // recursive before-quit will see quitInProgress=false and
  // hasInflightWork=false and let the default action through, which
  // lets will-quit fire and release the workspace lockfile.
  quitInProgress = false
  app.quit()
}

/**
 * macOS and Linux GUI apps inherit launchd/XDG environment, which
 * typically lacks user-specific PATH entries (Homebrew, nvm, cargo,
 * pyenv, etc.). Spawn the user's login shell once to capture their
 * real PATH and merge it into process.env so every child_process.spawn
 * downstream (shell plugin, npm install, dependency checks) sees the
 * same binaries the user's terminal would. Windows resolves PATH from
 * the registry at process start, so no fixup is needed there.
 */
function resolveShellPath(): void {
  if (process.platform === 'win32') return
  const userShell = process.env.SHELL || '/bin/sh'
  try {
    const raw = execFileSync(userShell, ['-ilc', 'printf "__WFPATH__%s__WFPATH__" "$PATH"'], {
      encoding: 'utf8',
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'ignore']
    })
    const resolved = raw.match(/__WFPATH__(.+?)__WFPATH__/)?.[1]
    if (resolved && resolved.includes(':')) process.env.PATH = resolved
  } catch {
    // best-effort — keep the existing PATH if the shell fails
  }
}

app.whenReady().then(async () => {
  // Must stay identical to `appId` in electron-builder.yml: the NSIS installer
  // stamps that value onto the Start Menu and Desktop shortcuts, and Windows
  // only matches a running window to its own shortcut — and only raises toasts
  // at all — when the two agree. A YAML file cannot import this constant, so the
  // two are kept in sync by hand.
  electronApp.setAppUserModelId('sh.wolffi.app')

  if (is.dev && process.platform === 'darwin') {
    app.dock?.setIcon(dockIcon)
  }

  resolveShellPath()
  await ensureWorkspace()
  await reconcileLocalModel()
  initUpdater()
  // The phone's Updates screen mirrors the updater live — the same state
  // machine the renderer panels subscribe to, one push per transition/tick.
  onUpdaterState((state) => {
    if (mobileChannel.hasPeer) mobileChannel.pushUpdaterState(toWireUpdaterState(state))
  })
  agent.init().catch((err) => {
    console.error('agent.init failed:', err)
  })

  // Workspace config is the single source of truth for persisted preferences.
  // Read it once at startup to apply the theme and restore the selected model.
  const cfg = await readConfig()
  nativeTheme.themeSource = cfg?.theme ?? 'system'
  if (cfg?.llm.local.model) {
    localProvider.configure(cfg.llm.local.model, cfg.llm.local.endpoint)
  }
  // Ollama liveness, tracked from here on rather than probed on demand: the
  // composer's model card hides the local provider while the daemon is down
  // the way it hides a cloud provider with no key, and it reads this flag —
  // already settled — instead of pinging when it opens. Follows the endpoint
  // the local provider is configured against, so a remote daemon counts.
  ollamaWatch = startOllamaWatch({
    getEndpoint: () => localProvider.currentEndpoint,
    onChange: (snapshot) => broadcast('ollama:changed', snapshot)
  })
  if (cfg?.llm.providers) {
    thalamus.setCloudProviders(cfg.llm.providers)
    thalamus.setBrain(cfg.llm.brain ?? null)
    // Fire-and-forget refresh of each provider's model catalogue. Cheap
    // (a single GET per provider) and doesn't block window creation.
    void refreshAllProviderModels()
  }

  // Fire-and-forget update check. Respects the updates.enabled config flag.
  void checkForUpdatesIfEnabled()
  thalamus.setLocalOnly(cfg?.llm.localOnly ?? false)
  agent.amygdala.setBypassPermissions(cfg?.safety?.bypassPermissions ?? false)
  agent.setMode(cfg?.llm.mode ?? 'single')
  turnRunner.setBlockCredentials(cfg?.safety?.blockCredentials ?? false)
  turnRunner.setLocale(cfg?.locale ?? 'en')
  sudoSession.setLocale(cfg?.locale ?? 'en')
  agent.cerebellum.setDisabled(cfg?.disabledCapabilities ?? [])
  agent.cerebellum.setPinnedCapabilities(cfg?.pinnedCapabilities ?? [])

  // Compaction schedule from config. Brainstem.init() will call
  // startCompactionScheduler() using whatever config is set here.
  if (cfg?.compaction) {
    agent.brainstem.setCompactionConfig(cfg.compaction)
  }

  // Reflection schedule config. normalize merges partial stored values over
  // the defaults, so a pre-feature config still yields a complete
  // ReflectionConfig.
  agent.brainstem.setReflectionConfig(normalizeReflectionConfig(cfg?.reflection))

  // Auto-launch: REPAIR a registration the user already asked for — never
  // create one they didn't.
  //
  // `=== true`, not `!== false`: only an explicit yes counts. (In practice
  // these are the same test, since defaultConfig() has always written the key
  // — but the intent should be readable without knowing that.)
  //
  // Repair, because a registration can go missing without the preference
  // changing: the app moved between folders, macOS reset its login items, a
  // cleanup tool deleted the .desktop entry, an update changed the binary
  // path. Without this, the toggle keeps saying On while nothing is
  // registered — the exact silent-lie the active-vs-intent split exists to
  // expose. It re-registers only when the OS says nothing is there, so a
  // healthy install pays one status read and no shell-outs.
  //
  // Through the dispatcher, not app.setLoginItemSettings directly: that call
  // does nothing on Linux, and on a headless install it would register a
  // login item over the service unit that is the real mechanism there.
  //
  // Skipped in dev — registering the dev binary as a login item brings the
  // Electron debug menu back on restart instead of the production app.
  if (!is.dev && cfg?.launchAtStartup === true) {
    void reassertAutostart().catch((err) =>
      wlog.warn('[autostart]', `re-assert failed: ${err instanceof Error ? err.message : err}`)
    )
  }

  if (cfg?.telegram?.enabled) {
    void telegramChannel
      .start(cfg.telegram)
      .catch((err) => console.error('telegram start failed:', err))
  }

  if (cfg?.whatsapp?.enabled) {
    void whatsappChannel
      .start(cfg.whatsapp)
      .catch((err) => console.error('whatsapp start failed:', err))
  }

  {
    const extCfg = cfg?.browserExtension ?? { port: 23151 }
    extensionServer.setStatusChangeHandler((status) => {
      for (const w of BrowserWindow.getAllWindows()) {
        w.webContents.send('extension:statusChange', status)
      }
    })
    void extensionServer
      .start({ port: extCfg.port })
      .catch((err) => console.error('extension server start failed:', err))
    agent.corpus.on('conversation.changed', (payload) => {
      extensionServer.setConversationId(payload.conversationId, payload.title)
    })
  }

  const lock = await acquireLock(lockfilePath())
  if (lock.acquired) lockAcquired = true

  // MCP connections start only in the instance that owns the workspace
  // lock: stdio servers are real child processes with exclusive side
  // effects (ports, database locks, OAuth token refresh writes), and a
  // dev + packaged instance pair sharing ~/.wolffish must not both
  // spawn them. Channels predate this concern; MCP doesn't inherit it.
  if (lock.acquired) {
    mcpManager.start(cfg?.mcp)
  } else {
    wlog.warn('[mcp]', `connections not started — workspace owned by pid ${lock.runningPid}`)
  }

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  // Native "needs you" signal — the Dock bounce / taskbar flash the channel
  // raises when a turn ends or a card blocks on the user while they are in
  // another app. Pointed at the main window only: the tray popup is not a
  // window anyone is waiting at.
  installAttention(mainBrowserWindow)
  // The in-app browser hosts its tabs inside the main window's contentView.
  // Same resolver, same reason: headless boot has no window, and the tab
  // manager must read that as "nowhere to show a page", not crash.
  browserTabs.install(mainBrowserWindow)

  // <webview> guests. Two browser-tab behaviors the bare tag lacks: a popup
  // (window.open, target=_blank) never becomes a naked BrowserWindow — an
  // http(s) target goes to the system browser, anything else is dropped —
  // and a LOCAL page (the HTML file preview, loaded from file:) that links
  // out to the web hands that link to the system browser instead of turning
  // the chat card into a browsing session. A website card keeps in-guest
  // navigation, as before.
  app.on('web-contents-created', (_event, contents) => {
    if (contents.getType() !== 'webview') return
    contents.setWindowOpenHandler(({ url }) => {
      if (/^https?:/i.test(url)) void shell.openExternal(url)
      return { action: 'deny' }
    })
    contents.on('will-navigate', (event, url) => {
      if (!contents.getURL().startsWith('file:')) return
      if (url.startsWith('file:') || url.startsWith('about:')) return
      event.preventDefault()
      if (/^https?:/i.test(url)) void shell.openExternal(url)
    })
  })

  // Permissions a local HTML preview may ask for. Fullscreen and pointer lock
  // are what a game wants and what a browser grants on a click; camera, mic,
  // location, notifications and the rest stay refused.
  session
    .fromPartition(HTML_PREVIEW_PARTITION)
    .setPermissionRequestHandler((_contents, permission, callback) => {
      callback(permission === 'fullscreen' || permission === 'pointerLock')
    })

  // Spellcheck corrections — the renderer's context menu calls these after the
  // main-process 'context-menu' event handed it the misspelled word + suggestions.
  // replaceMisspelling swaps the word currently selected by the right-click; it's a
  // native edit command, so undo works and controlled React inputs re-sync via input.
  handle('spellcheck:replace', (e, word: string) => {
    e.sender.replaceMisspelling(word)
  })
  handle('spellcheck:addToDictionary', (e, word: string) => {
    // Persists to the app's custom dictionary (and the OS dictionary on macOS/
    // Windows). The default session is persistent, so this is never a no-op here.
    e.sender.session.addWordToSpellCheckerDictionary(word)
  })

  // Theme
  handle('theme:get', () => currentThemeState())
  handle('theme:set', async (_e, source: ThemeSource) => {
    nativeTheme.themeSource = source
    await persistTheme(source)
    return currentThemeState()
  })

  // Locale
  handle('locale:get', async (): Promise<Locale> => {
    const config = await readConfig()
    return config?.locale ?? 'en'
  })
  handle('locale:set', async (_e, locale: Locale) => {
    await persistLocale(locale)
    turnRunner.setLocale(locale)
    sudoSession.setLocale(locale)
    return locale
  })

  // Runtime — Wolffish-specific toggles. Persist to config.json and
  // mirror into the live amygdala / thalamus instances so the change
  // takes effect on the next turn without a restart.
  handle('runtime:setBypassPermissions', async (_e, value: boolean) => {
    await persistBypassPermissions(value)
    agent.amygdala.setBypassPermissions(value)
    // Announced like every other settings save: other windows re-seed, and
    // the broadcast hook's config.changed push tells a paired phone now
    // rather than on its next screen focus.
    broadcast('preferences:changed', { bypassPermissions: value })
    return { value }
  })
  handle('runtime:setBlockCredentials', async (_e, value: boolean) => {
    await persistBlockCredentials(value)
    turnRunner.setBlockCredentials(value)
    broadcast('preferences:changed', { blockCredentials: value })
    return { value }
  })
  handle('runtime:setLocalOnly', async (_e, value: boolean) => {
    await persistLocalOnly(value)
    thalamus.setLocalOnly(value)
    return { value }
  })
  handle('runtime:setRestrictPowerfulModels', async (_e, value: boolean) => {
    await persistRestrictPowerfulModels(value)
    broadcast('preferences:changed', { restrictPowerfulModels: value })
    return { value }
  })
  handle('runtime:setThinkingMode', async (_e, model: string, mode: string) => {
    await persistThinkingMode(model, mode)
    broadcast('preferences:changed', { thinkingMode: { model, mode } })
  })

  /**
   * Which reasoning modes a given provider+model actually honours, and what is
   * stored for it now.
   *
   * The renderer works this out through the thalamus it shares by import; a
   * terminal has no such access, so per-model reasoning effort — the brain
   * button — was the one model control with no headless route at all. Reading
   * it here keeps ONE registry (reasoning.ts) answering for every surface.
   */
  handle(
    'runtime:reasoningModes',
    async (
      _e,
      payload: { provider: string; model: string }
    ): Promise<{ modes: string[]; current: string }> => {
      const cfg = await readConfig()
      const provider = cfg?.llm.providers.find((p) => p.id === payload.provider)
      const modes = reasoningModesFor(payload.provider, payload.model, {
        openrouterReasoning: provider?.reasoningModels?.includes(payload.model) ?? false
      })
      const stored = cfg?.llm.thinkingModes?.[payload.model]
      return { modes, current: normalizeReasoningMode(stored, modes) }
    }
  )

  handle('runtime:setLaunchAtStartup', async (_e, value: boolean) => {
    const status = await setAutostart(value)
    broadcast('preferences:changed', { launchAtStartup: value })
    // `active` is what the OS actually registered, which is NOT always what
    // was asked for — the panel renders both so a failed registration reads as
    // "On · Inactive" instead of a success.
    return { value, active: status.active, mechanism: status.mechanism, warning: status.warning }
  })

  handle('runtime:getLaunchAtStartupStatus', () => readAutostartStatus())

  handle('variables:list', async (): Promise<Variable[]> => {
    return getVariables()
  })
  handle('variables:save', async (_e, variables: Variable[]): Promise<{ ok: true }> => {
    await saveVariablesEverywhere(variables)
    return { ok: true }
  })

  // Telegram channel — read config, save partial updates, run lifecycle
  // hooks, ship a one-off test message. The lifecycle hooks live here
  // (not inside the channel) so the IPC handler can return the new
  // status synchronously — a UI that flips the toggle wants the chip
  // to update without polling.
  handle('telegram:getConfig', (): Promise<TelegramConfig> => getTelegramConfig())

  handle(
    'telegram:setConfig',
    async (
      _e,
      patch: Partial<TelegramConfig>
    ): Promise<{
      ok: true
      status: ReturnType<TelegramChannel['getStatus']>
      config: TelegramConfig
    }> => {
      // Shared with the phone's configSet path (applyTelegramConfigPatch) so
      // the restart rules cannot drift between the two writers.
      const result = await applyTelegramConfigPatch(patch)
      return { ok: true as const, ...result }
    }
  )

  handle(
    'telegram:status',
    (): ReturnType<TelegramChannel['getStatus']> => telegramChannel.getStatus()
  )

  // Push Telegram status changes to the renderer as they happen, the same
  // way WhatsApp does. Without this the settings panel only learns the
  // status on mount or after a manual Save — so a bot that finishes
  // starting in the background reads "starting" forever until the user
  // re-saves. The channel emits `telegram.statusChanged` on every
  // transition; we forward the current snapshot.
  // Through `broadcast()` for the same reason WhatsApp's are: a terminal
  // watching a channel come up is as real a surface as a settings panel, and
  // on a headless box it is the ONLY one.
  agent.corpus.on('telegram.statusChanged', () =>
    broadcast('telegram:statusChange', telegramChannel.getStatus())
  )

  handle(
    'telegram:sendTestMessage',
    (_e, payload: { token: string; userId: number }): Promise<{ ok: boolean; error?: string }> =>
      telegramChannel.sendTestMessage(payload.token, payload.userId)
  )

  // WhatsApp channel — Baileys-based WhatsApp Web client. Persistent
  // WebSocket that registers/unregisters tools with the cerebellum as
  // the connection comes up and goes down.
  handle('whatsapp:getConfig', (): Promise<WhatsAppConfig> => getWhatsAppConfig())

  handle(
    'whatsapp:setConfig',
    async (
      _e,
      patch: Partial<WhatsAppConfig>
    ): Promise<{
      ok: true
      status: ReturnType<WhatsAppChannel['getStatus']>
      config: WhatsAppConfig
    }> => {
      // Shared with the phone's configSet path (applyWhatsAppConfigPatch) so
      // the lifecycle rules cannot drift between the two writers.
      const result = await applyWhatsAppConfigPatch(patch)
      return { ok: true as const, ...result }
    }
  )

  handle(
    'whatsapp:status',
    (): ReturnType<WhatsAppChannel['getStatus']> => whatsappChannel.getStatus()
  )

  handle('whatsapp:logout', async (): Promise<void> => {
    await whatsappChannel.logout()
    await persistWhatsAppConfig({ enabled: false })
    broadcast('whatsapp:statusChange', whatsappChannel.getStatus())
  })

  handle('whatsapp:requestQr', (): void => {
    whatsappChannel.requestQr()
    broadcast('whatsapp:statusChange', whatsappChannel.getStatus())
  })

  /**
   * Link by phone number instead of QR. The only route that works on a
   * machine with no screen — and, measured, on any ordinary 80×24 terminal,
   * where a WhatsApp QR needs 27 rows before its caption.
   */
  handle(
    'whatsapp:requestPairingCode',
    (_e, phoneNumber: string): { ok: boolean; error?: string } => {
      const result = whatsappChannel.requestPairingCode(phoneNumber)
      broadcast('whatsapp:statusChange', whatsappChannel.getStatus())
      return result
    }
  )

  /**
   * Push QR codes and status changes out as they happen — through
   * `broadcast()`, NOT straight at the windows.
   *
   * These used to call `BrowserWindow.getAllWindows()` directly, and that made
   * linking WhatsApp from a terminal impossible rather than merely awkward:
   * `wolffish pair whatsapp` subscribes to `whatsapp:statusChange` and waits
   * for the code, and the code was only ever posted to renderer processes. On
   * the machine this CLI exists for — a VPS with no window at all — the events
   * went to an empty array and the terminal sat at "waiting for a code…"
   * forever. `broadcast()` is the chokepoint that already fans out to windows,
   * attached terminals AND the phone, so the pairing flow reaches whoever
   * actually asked for it.
   */
  agent.corpus.on('whatsapp.qr', ({ qr }) => broadcast('whatsapp:qr', qr))
  agent.corpus.on('whatsapp.pairingCode', ({ code }) => broadcast('whatsapp:pairingCode', code))
  const pushWhatsAppStatus = (): void =>
    broadcast('whatsapp:statusChange', whatsappChannel.getStatus())
  agent.corpus.on('whatsapp.started', pushWhatsAppStatus)
  agent.corpus.on('whatsapp.stopped', pushWhatsAppStatus)
  agent.corpus.on('whatsapp.error', pushWhatsAppStatus)
  agent.corpus.on('whatsapp.statusChanged', pushWhatsAppStatus)

  // In-app (desktop) chat — the primary renderer feed, not a remote relay
  // channel. Only a display preference (verbose) to persist; no lifecycle,
  // no restart. After a write we broadcast the new config so an open chat
  // window re-renders its feed immediately, the same way the channel panels
  // react to status changes.
  handle('inapp:getConfig', (): Promise<InAppConfig> => getInAppConfig())

  handle(
    'inapp:setConfig',
    async (_e, patch: Partial<InAppConfig>): Promise<{ ok: true; config: InAppConfig }> => {
      const updated = await persistInAppConfig(patch)
      const next = updated.inapp ?? EMPTY_INAPP
      // broadcast(), not a bare window send: the same signal has to reach an
      // attached terminal and the paired phone (through the config.changed
      // hook), or a flip made here stays a secret to every surface but this
      // window's own chat feed.
      broadcast('inapp:configChange', next)
      return { ok: true as const, config: next }
    }
  )

  // MCP server connections. All lifecycle mechanics live in McpManager;
  // these handlers are thin passthroughs. Status flows to the renderer
  // via the 'mcp:statusChange' broadcast wired at manager construction.
  handle('mcp:list', () => mcpManager.snapshot())

  handle('mcp:add', (_e, input: McpAddInput) => mcpManager.add(input))

  handle('mcp:remove', (_e, id: string) => mcpManager.remove(id))

  handle('mcp:setEnabled', (_e, id: string, enabled: boolean) => mcpManager.setEnabled(id, enabled))

  handle('mcp:setHeaders', (_e, id: string, headers: McpHeader[]) =>
    mcpManager.setHeaders(id, headers)
  )

  handle('mcp:test', (_e, id: string) => mcpManager.test(id))

  handle('mcp:authorize', (_e, id: string) => mcpManager.authorize(id))

  // Brave Search — stateless service. The web-search cerebellum plugin
  // reads the persisted config and uses Brave as the primary provider
  // when enabled. No long-poll, no in-process server: just a key + flag.
  handle('brave:getConfig', (): Promise<BraveConfig> => getBraveConfig())

  handle(
    'brave:setConfig',
    async (
      _e,
      patch: Partial<BraveConfig>
    ): Promise<{ ok: true; status: BraveStatus; config: BraveConfig }> => {
      const updated = await persistBraveConfig(patch)
      const next = updated.brave ?? { enabled: false, apiKey: '' }
      // Reset cached error so the next status read reflects the new key.
      braveService.resetCache()
      // Announce so every other audience — the phone (via the broadcast
      // hook's config.changed) and other windows' panels — re-seeds live.
      broadcast('services:changed', { service: 'brave' })
      return { ok: true as const, status: await braveService.getStatus(), config: next }
    }
  )

  handle('brave:status', (): Promise<BraveStatus> => braveService.getStatus())

  handle(
    'brave:test',
    (_e, apiKey: string): Promise<BraveTestResult> => braveService.testKey(apiKey)
  )

  // Notion — stateless service. The notion cerebellum plugin reads the
  // persisted config and uses the integration token for API calls. No
  // long-poll, no in-process server: just a token.
  handle('notion:getConfig', (): Promise<NotionConfig> => getNotionConfig())

  handle(
    'notion:setConfig',
    async (
      _e,
      connections: NotionConnection[]
    ): Promise<{ ok: true; status: NotionStatus; config: NotionConfig }> => {
      const updated = await persistNotionConfig(connections)
      const next = updated.notion ?? { connections: [] }
      return { ok: true as const, status: await notionService.getStatus(), config: next }
    }
  )

  handle('notion:status', (): Promise<NotionStatus> => notionService.getStatus())

  handle(
    'notion:test',
    (_e, token: string): Promise<NotionTestResult> => notionService.testToken(token)
  )

  // GitHub — stateless service. The github cerebellum plugin reads the
  // persisted config and uses the PAT for API calls. No daemon, no
  // in-process server: just a token.
  handle('github:getConfig', (): Promise<GitHubConfig> => getGitHubConfig())

  handle(
    'github:setConfig',
    async (
      _e,
      connections: GitHubConnection[]
    ): Promise<{ ok: true; status: GitHubStatus; config: GitHubConfig }> => {
      const updated = await persistGitHubConfig(connections)
      const next = updated.github ?? { connections: [] }
      return { ok: true as const, status: await githubService.getStatus(), config: next }
    }
  )

  handle('github:status', (): Promise<GitHubStatus> => githubService.getStatus())

  handle(
    'github:test',
    (_e, token: string): Promise<GitHubTestResult> => githubService.testToken(token)
  )

  // Memes — stateless service. The memes cerebellum plugin reads
  // config.json directly on every tool call. This module provides test
  // helpers and a status view for the settings panel.
  // Video generation (MiniMax H3). Its own key by design — see VideoConfig
  // in workspace.ts for why it is not shared with the MiniMax chat provider.
  handle('video:getConfig', (): Promise<VideoConfig> => getVideoConfig())

  handle(
    'video:setConfig',
    async (_e, patch: Partial<VideoConfig>): Promise<{ ok: true; config: VideoConfig }> => {
      const updated = await setVideoConfig(patch)
      broadcast('services:changed', { service: 'video' })
      const config = updated.video ?? { apiKey: '', director: true }
      return {
        ok: true as const,
        config: { apiKey: config.apiKey, director: config.director !== false }
      }
    }
  )

  handle('video:test', () => checkVideoService())

  handle('memes:getConfig', (): Promise<MemesConfig> => getMemesConfig())

  handle(
    'memes:setConfig',
    async (
      _e,
      patch: Partial<MemesConfig>
    ): Promise<{ ok: true; status: MemesStatus; config: MemesConfig }> => {
      const updated = await persistMemesConfig(patch)
      const next = updated.memes ?? {
        imgflip: { username: '', password: '' },
        giphy: { apiKey: '' }
      }
      memesService.resetCache()
      broadcast('services:changed', { service: 'memes' })
      return { ok: true as const, status: await memesService.getStatus(), config: next }
    }
  )

  handle('memes:status', (): Promise<MemesStatus> => memesService.getStatus())

  handle(
    'memes:testGiphy',
    (_e, apiKey: string): Promise<MemesTestResult> => memesService.testGiphy(apiKey)
  )

  handle(
    'memes:testImgflip',
    (_e, payload: { username: string; password: string }): Promise<MemesTestResult> =>
      memesService.testImgflip(payload.username, payload.password)
  )

  // Computer Use — desktop automation. The plugin reads config.json directly;
  // this handler is the read side only. There is deliberately no setter:
  // screenshot resolution and format are chosen by the agent per capture
  // (`max_width` / `format` on computer_screenshot), so the stored values are
  // a fallback default that no UI — desktop or phone — writes.
  handle('computerUse:getConfig', (): Promise<ComputerUseConfig> => getComputerUseConfig())

  handle(
    'computerUse:checkPermissions',
    (): {
      platform: string
      hint: string | null
      accessibility: boolean
      screenRecording: boolean
      linux?: { sessionType: string; desktop: string | null }
    } => {
      const platform = process.platform

      if (platform === 'darwin') {
        const accessibility = systemPreferences.isTrustedAccessibilityClient(true)
        const screenStatus = systemPreferences.getMediaAccessStatus('screen')
        const screenRecording = screenStatus === 'granted'

        const missing: string[] = []
        if (!accessibility) missing.push('Accessibility')
        if (!screenRecording) missing.push('Screen Recording')

        return {
          platform,
          accessibility,
          screenRecording,
          hint:
            missing.length > 0
              ? `Grant ${missing.join(' and ')} in System Settings → Privacy & Security, then restart Wolffish.`
              : null
        }
      }

      if (platform === 'linux') {
        const env = process.env
        const sessionType = env.WAYLAND_DISPLAY
          ? 'wayland'
          : env.DISPLAY
            ? 'x11'
            : (env.XDG_SESSION_TYPE ?? 'unknown')
        const desktop = env.XDG_CURRENT_DESKTOP ?? env.DESKTOP_SESSION ?? null
        return {
          platform,
          accessibility: true,
          screenRecording: true,
          linux: { sessionType, desktop },
          hint:
            sessionType === 'wayland'
              ? `Wayland session${desktop ? ` (${desktop})` : ''}: background input depends on the compositor — GNOME 47+ and KDE 6+ can grant it through the remote-desktop portal prompt; elsewhere Wolffish moves the pointer briefly for each action. Captures work through the portal or XWayland.`
              : sessionType === 'x11'
                ? 'X11 session: background input and captures work. Write access to /dev/uinput (input group) adds an independent pointer; AT-SPI adds finding controls by name.'
                : 'No display session detected. Computer use needs a graphical session (X11 or Wayland).'
        }
      }

      return { platform, accessibility: true, screenRecording: true, hint: null }
    }
  )

  // Opens the macOS Privacy & Security pane that holds a computer-use grant.
  // Accessibility can be prompted for directly; Screen Recording only appears
  // in the list once the app has tried to capture, so the pane is opened
  // straight away and the first capture registers the app.
  handle('computerUse:openSettings', async (_e, pane: string): Promise<{ ok: boolean }> => {
    if (process.platform !== 'darwin') return { ok: false }
    const panes: Record<string, string> = {
      accessibility:
        'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility',
      screenRecording:
        'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture',
      automation: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Automation'
    }
    const url = panes[pane]
    if (!url) return { ok: false }
    if (pane === 'accessibility') {
      try {
        systemPreferences.isTrustedAccessibilityClient(true)
      } catch {
        // The pane still opens.
      }
    }
    await shell.openExternal(url)
    return { ok: true }
  })

  // Browser Extension — WebSocket server for the Wolffish browser extension.
  handle(
    'browserExtension:getConfig',
    (): Promise<BrowserExtensionConfig> => getBrowserExtensionConfig()
  )

  handle(
    'browserExtension:setConfig',
    async (
      _e,
      patch: Partial<BrowserExtensionConfig>
    ): Promise<{ ok: true; config: BrowserExtensionConfig }> => {
      await persistBrowserExtensionConfig(patch)
      const next = await getBrowserExtensionConfig()
      if (patch.port !== undefined) {
        extensionServer.sendPortUpdate(next.port)
        await extensionServer.stop()
        await extensionServer.start({ port: next.port })
      }
      // The overlay switch lives in the extension's own storage too; the
      // server pushes it so the side panel and the page agree with Settings.
      if (patch.overlayEnabled !== undefined) {
        await extensionServer.setOverlayEnabled(next.overlayEnabled !== false)
      }
      broadcast('services:changed', { service: 'browserExtension' })
      return { ok: true as const, config: next }
    }
  )

  handle('browserExtension:doctor', (_e, opts?: DoctorOptions) =>
    extensionServer.doctor(opts ?? {})
  )

  handle('browserExtension:fix', (_e, action: string, opts?: FixOptions) =>
    extensionServer.fix(action, opts ?? {})
  )

  handle(
    'browserExtension:setOverlayEnabled',
    async (_e, enabled: boolean, target?: string | null): Promise<{ ok: true }> => {
      await extensionServer.setOverlayEnabled(enabled, target ?? null)
      broadcast('services:changed', { service: 'browserExtension' })
      return { ok: true as const }
    }
  )

  handle('browserExtension:status', () => extensionServer.getStatus())

  handle('browserExtension:openExtensionFolder', () => {
    shell.showItemInFolder(extensionFolderPath())
  })

  handle('browserExtension:getExtensionPath', () => {
    return extensionFolderPath()
  })

  handle('browserExtension:updateExtension', async (_e, target?: string | null) => {
    await extensionServer.requestReload(target ?? null)
    return { ok: true }
  })

  handle('browserExtension:testConnection', (_e, target?: string | null) =>
    extensionServer.runTestScenario(target ?? null)
  )

  handle('browserExtension:openExtensionsPage', async () => {
    await openBrowserUrl('chrome://extensions')
  })

  // Google Workspace (gogcli) — credential storage and OAuth are
  // delegated to the gog binary. We only persist safe public metadata
  // (client_id, project_id, account email) in config.json.
  handle('google:getConfig', (): Promise<GoogleConfig> => getGoogleConfig())

  handle(
    'google:setConfig',
    async (
      _e,
      patch: Partial<GoogleConfig>
    ): Promise<{ ok: true; status: GoogleStatus; config: GoogleConfig }> => {
      const updated = await persistGoogleConfig(patch)
      const next = updated.google ?? {
        status: 'inactive' as const,
        account: '',
        clientId: '',
        projectId: '',
        credentialsStored: false
      }
      googleService.resetCache()
      return { ok: true as const, status: await googleService.getStatus(), config: next }
    }
  )

  handle('google:status', (): Promise<GoogleStatus> => googleService.getStatus())

  handle('google:checkBinary', (): Promise<GoogleBinaryStatus> => googleService.checkBinary())

  // Broadcast setup/update progress as a full {stage, percent} state to ALL
  // windows (not just the invoking sender), so a panel remounted after the user
  // navigates away — in any window — keeps tracking the running install and
  // learns of completion. Paired with google:getSetupState for mount recovery.
  const broadcastGoogleSetupState = (payload: GoogleSetupState): void => {
    for (const w of BrowserWindow.getAllWindows()) {
      w.webContents.send('google:setupState', payload)
    }
  }
  handle('google:getSetupState', (): GoogleSetupState => googleService.getSetupState())
  handle('google:setup', async (): Promise<GoogleSetupResult> => {
    const result = await googleService.setup((percent) =>
      broadcastGoogleSetupState({ stage: 'setup', percent })
    )
    broadcastGoogleSetupState({ stage: 'idle', percent: result.ok ? 100 : 0 })
    return result
  })

  handle('google:update', async (): Promise<GoogleUpdateResult> => {
    const result = await googleService.update((percent) =>
      broadcastGoogleSetupState({ stage: 'updating', percent })
    )
    broadcastGoogleSetupState({ stage: 'idle', percent: result.ok ? 100 : 0 })
    return result
  })

  handle(
    'google:uploadCredentials',
    async (_e, jsonContent: string): Promise<GoogleCredentialsResult> => {
      const result = await googleService.uploadCredentials(jsonContent)
      if (result.ok) {
        await persistGoogleConfig({
          clientId: result.clientId,
          projectId: result.projectId,
          credentialsStored: true
        })
      }
      return result
    }
  )

  handle(
    'google:authAdd',
    async (_event, email: string, opts?: { reauth?: boolean }): Promise<GoogleAuthResult> => {
      // Capture the auth list before the OAuth flow so we can detect which
      // email gogcli actually stored — Google's OAuth returns the user's
      // real email, which often differs from whatever the user typed.
      const before = await googleService.listAccounts()
      const result = await googleService.authAdd(
        email,
        (url) => {
          /**
           * `broadcast`, not `event.sender.send`.
           *
           * The CLI dispatches these handlers with a null event (see
           * `server.ts`), and this callback fires from gogcli's stdout
           * listener with nothing around it — so `event.sender` was an
           * uncaught TypeError in the main process the instant a terminal
           * user asked to authorize an account. Broadcasting also happens to
           * be what a headless box needs: there is no browser to open, so the
           * consent URL has to be printable in the terminal.
           */
          broadcast('google:authUrl', { url })
        },
        opts
      )
      if (result.ok) {
        const after = await googleService.listAccounts()
        const newlyAdded = after.find((a) => !before.includes(a))
        // A re-auth overwrites an entry that was already listed, so there is
        // no "newly added" email to detect — fall back to the one we asked for.
        const actual = newlyAdded ?? (after.includes(email) ? email : (after[0] ?? email))
        await persistGoogleConfig({ status: 'active' })
        return { ok: true as const, account: actual }
      }
      return result
    }
  )

  handle('google:listAccounts', (): Promise<string[]> => googleService.listAccounts())

  handle(
    'google:checkAccounts',
    (): Promise<Record<string, boolean>> => googleService.checkAccounts()
  )

  handle('google:cancelAuth', (): boolean => googleService.cancelAuth())

  handle(
    'google:deleteCredentials',
    async (): Promise<{ ok: true } | { ok: false; message: string }> => {
      const result = await googleService.deleteCredentials()
      if (result.ok) {
        await persistGoogleConfig({
          status: 'inactive',
          clientId: '',
          projectId: '',
          credentialsStored: false
        })
        googleService.resetCache()
      }
      return result
    }
  )

  handle(
    'google:removeAccount',
    async (
      _e,
      email: string
    ): Promise<{ ok: true; accounts: string[] } | { ok: false; message: string }> => {
      const result = await googleService.removeAccount(email)
      if (!result.ok) return result
      const remaining = await googleService.listAccounts()
      // Status follows whether any account is still authorized — there is
      // no "primary" to promote anymore. The cerebellum plugin requires
      // an explicit `account` parameter on every call.
      await persistGoogleConfig({
        status: remaining.length > 0 ? 'active' : 'inactive'
      })
      googleService.resetCache()
      return { ok: true as const, accounts: remaining }
    }
  )

  // STT/TTS — persisted defaults the cerebellum plugins read on every
  // tool call, so users' panel choices override the plugin's
  // hard-coded fallbacks without restarting anything. Both stay
  // optional in config.json: an empty string means "use the plugin's
  // own default," which is what every existing config will have until
  // the user touches the panel.
  handle('mic:checkAccess', (): 'granted' | 'denied' | 'not-determined' | 'restricted' => {
    if (process.platform === 'darwin' || process.platform === 'win32') {
      const status = systemPreferences.getMediaAccessStatus('microphone')
      return status === 'unknown' ? 'granted' : status
    }
    return 'granted'
  })

  handle('mic:requestAccess', async (): Promise<boolean> => {
    if (process.platform === 'darwin') {
      return systemPreferences.askForMediaAccess('microphone')
    }
    return true
  })

  handle('stt:getConfig', (): Promise<SttConfig> => getSttConfig())
  handle(
    'stt:setConfig',
    async (_e, patch: Partial<SttConfig>): Promise<{ ok: true; config: SttConfig }> => {
      const updated = await persistSttConfig(patch)
      broadcast('services:changed', { service: 'stt' })
      // Normalized field-by-field: a pre-`language` config.json on disk must
      // not hand the renderer a shape missing the field the type promises.
      return {
        ok: true as const,
        config: {
          defaultModel: updated.stt?.defaultModel ?? '',
          language: updated.stt?.language ?? ''
        }
      }
    }
  )
  handle(
    'stt:transcribe',
    async (
      _e,
      payload: { filePath: string; conversationId?: string }
    ): Promise<
      { ok: true; transcript: string; language?: string } | { ok: false; error: string }
    > => {
      try {
        // Whisper decodes audio through ffmpeg. On a fresh machine ffmpeg is
        // absent, so transcription would dead-end with a long install-it-yourself
        // error. This IPC path calls the tool directly (bypassing the agent
        // loop's dependency resolution), so ensure ffmpeg here first — it
        // self-installs silently and continues.
        await agent.cerebellum.ensureSystemTool('ffmpeg')
        // Conversation id rides the ALS scope (not the imperative global) so
        // this out-of-turn call can't clobber the conversation a concurrent
        // turn published.
        const transcribe = (): Promise<Awaited<ReturnType<typeof agent.cerebellum.executeTool>>> =>
          agent.cerebellum.runWithConversation(payload.conversationId ?? null, () =>
            agent.cerebellum.executeTool('stt_transcribe', {
              filePath: payload.filePath
            })
          )
        let result = await transcribe()
        // Belt-and-suspenders: if it still failed on ffmpeg (e.g. a stale PATH),
        // ensure once more and retry exactly once.
        if (!result.success && /ffmpeg/i.test(result.error ?? '')) {
          await agent.cerebellum.ensureSystemTool('ffmpeg')
          result = await transcribe()
        }
        if (!result.success) {
          // Keep the toast to one line — collapse the multi-line plugin message
          // (which spells out manual brew/winget steps) into a short summary.
          const raw = result.error ?? 'Transcription failed'
          const error = /ffmpeg/i.test(raw)
            ? 'Couldn’t set up ffmpeg automatically — please install it and try again.'
            : raw.split('\n')[0]
          return { ok: false, error }
        }
        const raw = result.output ?? ''
        const match =
          raw.match(/"transcript"\s*:\s*"([^"]*)"/) ?? raw.match(/"text"\s*:\s*"([^"]*)"/)
        const transcript = match ? match[1] : raw.replace(/[{}"\n]/g, '').trim()
        if (!transcript) {
          return { ok: false, error: 'Transcription returned empty' }
        }
        // Whisper's detected language (ISO 639-1) — surfaced so the renderer
        // can tag the <voice_note lang="…"> history entry, giving the model a
        // deterministic reply-language signal instead of guessing.
        const language = raw.match(/"language"\s*:\s*"([^"]*)"/)?.[1] ?? ''
        return { ok: true, transcript, language }
      } catch (err) {
        if (payload.conversationId) {
          agent.cerebellum.setCurrentConversationId(null)
        }
        return { ok: false, error: err instanceof Error ? err.message : String(err) }
      }
    }
  )

  handle('tts:getConfig', (): Promise<TtsConfig> => getTtsConfig())
  handle(
    'tts:setConfig',
    async (_e, patch: Partial<TtsConfig>): Promise<{ ok: true; config: TtsConfig }> => {
      const updated = await persistTtsConfig(patch)
      broadcast('services:changed', { service: 'tts' })
      return {
        ok: true as const,
        config: {
          defaultVoice: updated.tts?.defaultVoice ?? '',
          defaultSpeed: updated.tts?.defaultSpeed ?? '',
          voiceReplies: updated.tts?.voiceReplies !== false
        }
      }
    }
  )

  // Local voice-engine provisioning, surfaced to the Settings panels so users
  // can install Kokoro (TTS) / faster-whisper (STT) on demand with a progress
  // bar — and so the panels can gate voice/model selection until ready. Install
  // is idempotent and converges with the plugins' lazy first-use install.
  handle('tts:installStatus', (): Promise<EngineStatus> => ttsStatus())
  handle('tts:getInstallState', (): EngineRuntimeState => getTtsInstallState())
  handle('stt:getInstallState', (): EngineRuntimeState => getSttInstallState())
  // Progress (and the terminal 'done') is BROADCAST to every window, not just
  // the invoking sender. A panel that remounted mid-install — or a renderer that
  // fully reloaded (its original sender is now dead) — must still receive live
  // updates and the terminal signal, otherwise it can stick on "Installing".
  // The terminal 'done' fires after the install settles (success OR failure), so
  // a non-initiating panel also stops showing "Installing" (idempotent duplicate
  // on the success path, which already emits its own 'done').
  const broadcastEngineProgress = (channel: string, payload: EngineInstallProgress): void => {
    for (const w of BrowserWindow.getAllWindows()) {
      w.webContents.send(channel, payload)
    }
  }
  // One install path per engine, shared by the panel's button (the IPC handlers
  // below) and by the agent (the voice host further down). Whoever starts it,
  // progress reaches every window and the terminal 'done' fires, so the panel's
  // card tracks an agent-triggered install exactly as it tracks its own — and
  // installTts/installStt dedupe against an in-flight run, so a click landing
  // mid-agent-install (or the reverse) joins that run instead of starting a
  // second one.
  const runTtsInstall = async (): Promise<EngineInstallResult> => {
    const res = await installTts(
      (p: EngineInstallProgress) => broadcastEngineProgress('tts:installProgress', p),
      { ensureFfmpeg: () => agent.cerebellum.ensureSystemTool('ffmpeg').then(() => undefined) }
    )
    broadcastEngineProgress('tts:installProgress', { phase: 'done', percent: 100 })
    return res
  }
  const runSttInstall = async (): Promise<EngineInstallResult> => {
    const res = await installStt((p: EngineInstallProgress) =>
      broadcastEngineProgress('stt:installProgress', p)
    )
    broadcastEngineProgress('stt:installProgress', { phase: 'done', percent: 100 })
    return res
  }
  handle('tts:install', (): Promise<EngineInstallResult> => runTtsInstall())
  handle('stt:installStatus', (): Promise<EngineStatus> => sttStatus())
  handle('stt:install', (): Promise<EngineInstallResult> => runSttInstall())

  // The agent's own hand on these two panels. Every setter is the one the
  // panel's IPC handler calls, broadcast included, so a change the model makes
  // re-seeds an open TTS/STT panel and reaches the CLI and phone surfaces
  // through the same channel a click here would — no second write path, no
  // surface left holding a stale value. Validation of WHICH values are
  // acceptable lives in the plugins, against the catalogs the panels render.
  agent.cerebellum.setVoiceHost({
    getTts: () => getTtsConfig(),
    setTts: async (patch) => {
      const updated = await persistTtsConfig(patch)
      broadcast('services:changed', { service: 'tts' })
      return {
        defaultVoice: updated.tts?.defaultVoice ?? '',
        defaultSpeed: updated.tts?.defaultSpeed ?? '',
        voiceReplies: updated.tts?.voiceReplies !== false
      }
    },
    getStt: () => getSttConfig(),
    setStt: async (patch) => {
      const updated = await persistSttConfig(patch)
      broadcast('services:changed', { service: 'stt' })
      return {
        defaultModel: updated.stt?.defaultModel ?? '',
        language: updated.stt?.language ?? ''
      }
    },
    ttsInstalled: async () => (await ttsStatus()).installed,
    sttInstalled: async () => (await sttStatus()).installed,
    installTts: () => runTtsInstall(),
    installStt: () => runSttInstall(),
    ttsInstalling: () => getTtsInstallState().installing,
    sttInstalling: () => getSttInstallState().installing
  })

  // Real Kokoro preview for the TTS panel: synthesize a short sample with the
  // selected voice/speed and hand back the audio file path for the renderer to
  // play. Gated in the UI behind an installed engine, so this is fast.
  handle(
    'tts:preview',
    async (
      _e,
      payload: { text?: string; voice?: string; speed?: string }
    ): Promise<{ ok: true; filePath: string } | { ok: false; error: string }> => {
      try {
        await agent.cerebellum.ensureSystemTool('ffmpeg')
        const result = await agent.cerebellum.executeTool('voice_generate', {
          text: payload.text?.trim() || 'Hello! This is a preview of how this voice sounds.',
          voice: payload.voice,
          speed: payload.speed
        })
        if (!result.success) {
          return { ok: false, error: (result.error ?? 'Preview failed').split('\n')[0] }
        }
        const raw = result.output ?? ''
        // voice_generate returns pure JSON; JSON.parse unescapes Windows paths
        // natively. Fall back to a regex only if the shape ever changes.
        let filePath: string | undefined
        try {
          filePath = (JSON.parse(raw) as { filePath?: string }).filePath
        } catch {
          filePath = raw.match(/"filePath"\s*:\s*"([^"]*)"/)?.[1]?.replace(/\\\\/g, '\\')
        }
        if (!filePath) return { ok: false, error: 'Preview produced no audio' }
        return { ok: true, filePath }
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) }
      }
    }
  )

  nativeTheme.on('updated', () => broadcastThemeUpdate())

  // System
  handle('system:getInfo', (): Promise<SystemInfo> => detectSystem())

  // Workspace
  handle('workspace:getStatus', (): Promise<WorkspaceStatus> => getStatus())
  handle('workspace:completeOnboarding', () => markOnboardingComplete())

  // Wipe all data on disk but preserve API keys, model selection, locale,
  // theme, and runtime toggles. The relaunch ensures no stale handles
  // (cortex.db, brainstem watcher, corpus flush timer) survive the wipe.
  handle('app:factoryReset', async () => {
    activePull?.abort()
    electronChannel.abort()
    telegramChannel.abort()
    whatsappChannel.abort()
    await telegramChannel.stop('factory reset').catch(() => undefined)
    await whatsappChannel.stop('factory reset').catch(() => undefined)
    // app.exit() below skips before-quit/will-quit, so MCP children must
    // be torn down here or they survive into the relaunched instance.
    await mcpManager.stop().catch(() => undefined)
    await agent.stop().catch(() => undefined)
    browserTabs.destroyAll('shutdown')
    if (lockAcquired) {
      releaseLockSync(lockfilePath())
      lockAcquired = false
    }
    await factoryReset().catch(() => undefined)
    app.relaunch()
    app.exit(0)
  })

  handle('data:getAnalytics', (): Promise<DataAnalytics> => getDataAnalytics())

  // The mobile channel needs the same list; publish the closure so it can be
  // called from outside this scope rather than reimplementing the mapping.
  const serializeCapabilities = async (): Promise<
    Array<{
      name: string
      description: string
      status: 'ok' | 'error'
      hasPlugin: boolean
      toolCount: number
      triggers: string[]
      requires: string[]
      official: boolean
      core: boolean
      wolffish: boolean
      tested: boolean
      enabled: boolean
      error?: string
    }>
  > => {
    const bundled = await bundledCapabilityNames()
    return agent.cerebellum
      .getCapabilities()
      .filter((c) => !c.inProcess)
      .map((c) => ({
        name: c.name,
        description: c.description,
        status: c.status,
        hasPlugin: c.hasPlugin,
        toolCount: c.tools.length,
        triggers: c.triggers.keywords,
        requires: c.requires,
        official: bundled.has(c.name),
        core: LOCKED_CAPABILITIES.has(c.name),
        wolffish: c.author === WOLFFISH_AUTHOR,
        // `tested` is tracked only for Wolffish-authored plugin skills; for
        // everything else the concept doesn't apply, so it reads as true.
        tested: c.tested !== false,
        enabled: !agent.cerebellum.isDisabled(c.name),
        error: c.error
      }))
  }

  mobileSerializeCapabilities = serializeCapabilities

  /**
   * The one implementation of "flip a capability". The settings IPC below,
   * the skills plugin's host bridge and the paired phone all call this, so a
   * toggle behaves identically whoever asked for it: the locked-core guard,
   * the config write, the live cerebellum update, and one broadcast that
   * refreshes every audience at once — this app's own panel directly, and the
   * phone via the broadcast hook's config.changed push. Returns the enabled
   * state that actually holds, which is how a refused write answers.
   *
   * The disabled set is computed inside patchConfig's lock, against the
   * config actually on disk: two toggles racing (a click here while the phone
   * flips something else) must merge, not overwrite each other.
   */
  const setCapabilityEnabled = async (name: string, enabled: boolean): Promise<boolean> => {
    // Refused before anything persists: every caller toggles names it was
    // just shown, so an unknown one is a stale screen, not a request.
    if (!agent.cerebellum.getCapabilities().some((c) => c.name === name)) {
      throw new Error(`unknown capability: ${name}`)
    }
    // Locked core capabilities can never be disabled — refuse the write so a
    // stray call can't persist a disabled entry the runtime would ignore anyway.
    if (!enabled && LOCKED_CAPABILITIES.has(name)) return true
    const next = await patchConfig((c) => {
      const disabled = new Set(c.disabledCapabilities ?? [])
      if (enabled) disabled.delete(name)
      else disabled.add(name)
      return { ...c, disabledCapabilities: [...disabled] }
    })
    agent.cerebellum.setDisabled(next.disabledCapabilities ?? [])
    broadcast('cerebellum:capabilitiesChanged', await serializeCapabilities())
    return enabled
  }

  mobileSetCapabilityEnabled = setCapabilityEnabled

  // ---------------------------------------------------------------- mobile
  handle('mobile:status', () => mobileChannel.getStatus())
  handle('mobile:offerQr', () => mobileChannel.offerQr())
  handle('mobile:offerCode', () => mobileChannel.offerCode())
  handle('mobile:disconnect', () => mobileChannel.disconnect())
  handle('mobile:unpair', () => mobileChannel.unpair())
  // Both of these settings live on two screens — this panel and the phone's
  // own Channels page — so each one tells the other side. The phone's writes
  // come back through applyMobileSettings and are announced by the broadcast
  // there; a change made HERE needs the push spelled out, because
  // mobile:statusChange is (rightly) on the silent list: it also carries the
  // per-frame tunnel counters, and pushing on those would be a heartbeat.
  handle('mobile:setVerbose', async (_event, verbose: boolean) => {
    const status = await mobileChannel.setVerbose(Boolean(verbose))
    pushMobileChannelConfig()
    return status
  })
  handle('mobile:setNotifications', async (_event, enabled: boolean) => {
    const status = await mobileChannel.setNotificationsEnabled(Boolean(enabled))
    pushMobileChannelConfig()
    return status
  })
  handle('mobile:setRelayUrl', (_event, url: string | null) =>
    mobileChannel.setRelayUrl(typeof url === 'string' ? url : null)
  )

  // Restore a stored pairing so a phone that was connected yesterday
  // reconnects without anyone touching either device.
  void mobileChannel.start().catch(() => undefined)

  // Anything parked when this process last stopped — a mid-turn message the
  // user sent seconds before a crash, a quit or a machine restart — is re-sent
  // now. AFTER the channels are up, so their dispatchers are registered; the
  // reconciler keeps anything it cannot place yet and gets another pass on the
  // next save, so a slow start never costs a message.
  void reconcileAll(interjectionDeps).catch(() => undefined)

  // Keep the phone's list live: the same corpus signals that refresh this
  // app's own list are forwarded over the tunnel.
  agent.corpus.on('conversation.changed', (event) => {
    if (event?.conversationId) void pushConversationToMobile(event.conversationId)
  })
  agent.corpus.on('conversation.deleted', (event) => {
    if (event?.id) mobileChannel.pushConversationDeleted(event.id)
  })
  // Every recorded turn moves the ledger — from ANY channel, not just runs
  // the phone can see.
  agent.corpus.on('usage.recorded', () => mobileChannel.pushUsageChanged())
  // Brainstem runs rewrite the last-run records the phone's Knowledge screen
  // shows; the generic broadcast hook never sees them (no renderer IPC fires).
  agent.corpus.on('brainstem.jobCompleted', () => mobileChannel.pushConfigChanged('brainstem'))
  // A Wolffish-authored skill just passed its first real call — refresh the
  // capabilities panel so its Untested badge clears live, mid-turn, without
  // waiting for a manual resync.
  agent.corpus.on('capability.tested', () => {
    void serializeCapabilities().then((caps) => broadcast('cerebellum:capabilitiesChanged', caps))
  })

  handle('cerebellum:listCapabilities', async () => {
    await agent.init()
    return serializeCapabilities()
  })

  handle('cerebellum:reload', async () => {
    await agent.cerebellum.reload()
    return serializeCapabilities()
  })

  handle('cerebellum:toggleCapability', async (_e, name: string, enabled: boolean) => {
    await setCapabilityEnabled(name, enabled)
  })

  // Import a user-supplied capability (SKILL.md / folder / .zip) into
  // brain/cerebellum/. Validation + staging + copy all happen in the
  // importCapability module; on success the renderer calls cerebellum:reload
  // to pick up the new folder and refresh the list.
  handle('cerebellum:importCapability', async (_e, sourcePath: string) => {
    await agent.init()
    const existingNames = new Set(agent.cerebellum.getCapabilities().map((c) => c.name))
    return importCapability({
      sourcePath,
      cerebellumDir: join(workspaceRoot(), 'brain', 'cerebellum'),
      existingNames
    })
  })

  // Native picker for the import dropzone's "browse" affordance. On macOS the
  // dialog accepts a file (SKILL.md/.zip) or a folder; on Windows only files
  // (folders still arrive via drag-and-drop). Returns null when canceled.
  handle(
    'cerebellum:pickImport',
    async (_e, options?: { title?: string; filterName?: string }): Promise<string | null> => {
      const mainWin = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
      if (!mainWin) return null
      // Labels are localized in the renderer and passed in; English fallbacks
      // keep the dialog sane if the call ever arrives without them.
      const result = await dialog.showOpenDialog(mainWin, {
        title: options?.title ?? 'Import capability',
        properties: ['openFile', 'openDirectory'],
        filters: [{ name: options?.filterName ?? 'Capability', extensions: ['md', 'zip'] }]
      })
      if (result.canceled || !result.filePaths[0]) return null
      return result.filePaths[0]
    }
  )

  // Delete a user-imported capability — cleanly nuke its folder. Official
  // (bundled) and built-in in-process capabilities are refused so a stray
  // click can't wipe a core feature. A path-containment guard ensures we only
  // ever remove a direct child of brain/cerebellum/, never a folder reached
  // through a crafted path. Returns the refreshed list on success.
  handle('cerebellum:deleteCapability', async (_e, name: string) => {
    await agent.init()
    const cap = agent.cerebellum.getCapabilities().find((c) => c.name === name)
    if (!cap) return { ok: false as const, error: `Capability "${name}" not found.` }

    const bundled = await bundledCapabilityNames()
    const outcome = await deleteCapabilityFolder({
      name,
      dir: cap.dir,
      cerebellumDir: join(workspaceRoot(), 'brain', 'cerebellum'),
      isOfficial: bundled.has(name),
      isInProcess: Boolean(cap.inProcess)
    })
    if (!outcome.ok) return outcome

    // Forget any disabled-toggle for the gone capability, then reload so the
    // in-memory cerebellum (and the plugin's destroy hook) reflect the removal.
    await patchConfig((c) => ({
      ...c,
      disabledCapabilities: (c.disabledCapabilities ?? []).filter((n) => n !== name)
    }))
    await agent.cerebellum.reload()
    const cfg = await readConfig()
    agent.cerebellum.setDisabled(cfg?.disabledCapabilities ?? [])
    return { ok: true as const, capabilities: await serializeCapabilities() }
  })

  // Capability-management bridge handed to the `skills` capability's plugin
  // via its init context. Every method mirrors a `cerebellum:*` IPC handler
  // above so the agent manages skills through the exact same atomic config
  // writes, official-capability guards, and reload path the settings panel
  // uses — there is one implementation of "disable a skill", not two.
  agent.cerebellum.setPluginHost({
    listCapabilities: async () => {
      const bundled = await bundledCapabilityNames()
      return agent.cerebellum.getCapabilities().map((c) => ({
        name: c.name,
        description: c.description,
        triggers: c.triggers.keywords,
        tools: c.tools.map((t) => ({ name: t.name, description: t.description })),
        hasPlugin: c.hasPlugin,
        status: c.status,
        enabled: !agent.cerebellum.isDisabled(c.name),
        official: Boolean(c.inProcess) || bundled.has(c.name),
        core: LOCKED_CAPABILITIES.has(c.name),
        wolffish: c.author === WOLFFISH_AUTHOR,
        tested: c.tested !== false,
        inProcess: Boolean(c.inProcess),
        dir: c.dir,
        error: c.error
      }))
    },
    setCapabilityEnabled: async (name, enabled) => {
      await setCapabilityEnabled(name, enabled)
    },
    deleteCapability: async (name) => {
      const cap = agent.cerebellum.getCapabilities().find((c) => c.name === name)
      if (!cap) return { ok: false, error: `Capability "${name}" not found.` }
      const bundled = await bundledCapabilityNames()
      const outcome = await deleteCapabilityFolder({
        name,
        dir: cap.dir,
        cerebellumDir: join(workspaceRoot(), 'brain', 'cerebellum'),
        isOfficial: bundled.has(name),
        isInProcess: Boolean(cap.inProcess)
      })
      if (!outcome.ok) return outcome
      await patchConfig((c) => ({
        ...c,
        disabledCapabilities: (c.disabledCapabilities ?? []).filter((n) => n !== name)
      }))
      await agent.cerebellum.reload()
      const cfg = await readConfig()
      agent.cerebellum.setDisabled(cfg?.disabledCapabilities ?? [])
      return { ok: true }
    },
    importCapability: async (sourcePath) => {
      const existingNames = new Set(agent.cerebellum.getCapabilities().map((c) => c.name))
      return importCapability({
        sourcePath,
        cerebellumDir: join(workspaceRoot(), 'brain', 'cerebellum'),
        existingNames
      })
    },
    reload: async () => {
      await agent.cerebellum.reload()
      const cfg = await readConfig()
      agent.cerebellum.setDisabled(cfg?.disabledCapabilities ?? [])
    }
  })

  // Automation-management bridge handed to the `automations` capability's
  // plugin via its init context. Every method runs over the live Brainstem so
  // the agent edits the same heartbeat.md the scheduler reads, validates a
  // schedule with the exact parser that registers it, and reloads through the
  // one serialized path the file-watcher uses — there is one source of truth
  // for "what automations exist and when they fire", not two.
  const heartbeatPath = (): string => join(workspaceRoot(), 'brain', 'brainstem', 'heartbeat.md')
  const snapshotAutomations = (): import('@main/runtime/cerebellum').AutomationJobInfo[] => {
    const runningIds = new Set(agent.brainstem.getRunningJobs().map((r) => r.id))
    const statuses = agent.brainstem.getJobStatuses()
    return agent.brainstem.getActiveJobs().map((j) => {
      const preview = previewSchedule(j.label)
      const status = statuses[j.label]
      return {
        id: j.id,
        kind: j.type,
        cron: j.cron,
        label: j.label,
        body: j.body,
        human: preview.ok ? preview.human : '(unrecognized schedule)',
        running: runningIds.has(j.id),
        lastRunAt: status?.lastRunAt ?? null,
        lastStatus: status?.lastStatus ?? null,
        ...(status?.lastError ? { lastError: status.lastError } : {}),
        mode: j.mode,
        thinking: j.thinking ?? null
      }
    })
  }
  agent.cerebellum.setAutomationsHost({
    getGlobalMode: async () =>
      (await readConfig().catch(() => null))?.llm.mode === 'workflow' ? 'workflow' : 'single',
    readHeartbeat: async () => {
      const { readFile } = await import('node:fs/promises')
      try {
        return await readFile(heartbeatPath(), 'utf8')
      } catch {
        return ''
      }
    },
    writeHeartbeat: async (raw) => {
      try {
        await diskWriter.writeFileAtomic(heartbeatPath(), raw)
      } catch (err) {
        return {
          ok: false,
          jobs: snapshotAutomations(),
          error: err instanceof Error ? err.message : String(err)
        }
      }
      // Apply live in the same turn rather than waiting on the file watcher,
      // so the agent can verify the new job list immediately. The watcher's
      // own reload on this write is harmless — reloadScheduler is serialized.
      await agent.brainstem.reloadScheduler()
      return { ok: true, jobs: snapshotAutomations() }
    },
    listJobs: () => snapshotAutomations(),
    previewSchedule: (heading) => previewSchedule(heading),
    getRunningJobs: () => agent.brainstem.getRunningJobs(),
    runJobNow: (idOrLabel) => agent.brainstem.runJobNow(idOrLabel)
  })

  // Procedures — the same store the renderer/IPC use, plus a detached run that
  // fires a procedure's prompt through the Brainstem's bounded run pool so it
  // runs exactly like a triggered automation (sealed conversation, in history).
  agent.cerebellum.setProjectsHost({
    list: () => listProjects(),
    create: (payload) => createProject(payload),
    update: (id, patch) => updateProject({ id, ...patch }),
    delete: async (id) => {
      await deleteProject(id)
      return { ok: true as const }
    },
    attachFiles: (projectId, paths) => attachFilesToProject(projectId, paths),
    conversationsFor: async (projectId) => {
      const metas = await listConversations()
      return metas
        .filter((m) => m.projectId === projectId)
        .map((m) => ({
          id: m.id,
          title: m.title,
          updatedAt: m.updatedAt,
          messageCount: m.messageCount
        }))
    }
  })

  agent.cerebellum.setProceduresHost({
    list: () => listProcedures(),
    create: (title, prompt) => createProcedure({ title, prompt }),
    update: (id, patch) => updateProcedure({ id, ...patch }),
    delete: async (id) => {
      await deleteProcedure(id)
      return { ok: true as const }
    },
    run: async (id) => {
      const proc = (await listProcedures()).find((p) => p.id === id)
      if (!proc) return { ok: false, started: false, error: 'Procedure not found.' }
      if (proc.prompt.trim().length === 0) {
        return {
          ok: false,
          started: false,
          error: `Procedure "${proc.title}" has no prompt to run.`
        }
      }
      return agent.brainstem.runDetached(
        proc.prompt,
        proc.title || 'Procedure',
        `procedure:${proc.id}`,
        proc.mode ?? null,
        proc.icon || '📋',
        proc.projectId ?? null,
        // A detached run gets exactly what a Play run gets: the attached files
        // as a model-led list, and a fresh listing of every working folder.
        (proc.files ?? []).map((f) => f.path),
        proc.directories ?? [],
        // The procedure's own reasoning stamp; absent ⇒ the brainstem falls
        // back to the chat's selected thinking mode, the same value Play and
        // the card's switch show.
        proc.thinking ?? null
      )
    }
  })

  // Voice — read TTS-generated audio files for the renderer's AudioPlayer
  // (source="voice"), download via save dialog, and check existence for
  // past conversations.
  handle('voice:readFile', async (_e, filePath: string): Promise<Buffer> => {
    const { readFile } = await import('node:fs/promises')
    return readFile(filePath)
  })
  handle('voice:download', async (_e, filePath: string): Promise<{ ok: boolean }> => {
    const { basename } = await import('node:path')
    const { readFile } = await import('node:fs/promises')
    const mainWin = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
    if (!mainWin) return { ok: false }
    const result = await dialog.showSaveDialog(mainWin, {
      defaultPath: basename(filePath),
      filters: [{ name: 'Audio', extensions: ['mp3'] }]
    })
    if (result.canceled || !result.filePath) return { ok: false }
    const { writeFile } = await import('node:fs/promises')
    const data = await readFile(filePath)
    await writeFile(result.filePath, data)
    return { ok: true }
  })
  handle('voice:revealInFolder', (_e, filePath: string): { ok: boolean } => {
    if (!filePath) return { ok: false }
    shell.showItemInFolder(filePath)
    return { ok: true }
  })
  handle('voice:exists', async (_e, filePath: string): Promise<boolean> => {
    const { access, constants } = await import('node:fs/promises')
    try {
      await access(filePath, constants.F_OK)
      return true
    } catch {
      return false
    }
  })

  // Uploads — file picker, copy-to-workspace, read for renderer playback,
  // existence check for past conversations, metadata for "deleted"
  // placeholders. All paths returned to the renderer are relative to
  // workspace root so the same conversation file plays back identically
  // when the workspace is moved (rare, but the cost of doing it right is
  // zero).
  handle('upload:pickFile', async (): Promise<string[]> => {
    const mainWin = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
    if (!mainWin) return []
    const result = await dialog.showOpenDialog(mainWin, {
      title: 'Attach files',
      properties: ['openFile', 'multiSelections'],
      filters: [
        {
          name: 'All supported',
          extensions: [
            'jpg',
            'jpeg',
            'png',
            'gif',
            'webp',
            'pdf',
            'docx',
            'xlsx',
            'xls',
            'csv',
            'tsv',
            'txt',
            'md',
            'json',
            'pptx',
            'html',
            'htm',
            'zip',
            'mp3',
            'wav',
            'ogg',
            'm4a',
            'flac',
            'webm',
            'mp4',
            'mov',
            'avi',
            'mkv',
            'm4v',
            'wmv',
            'flv'
          ]
        },
        { name: 'Images', extensions: ['jpg', 'jpeg', 'png', 'gif', 'webp'] },
        {
          name: 'Documents',
          extensions: [
            'pdf',
            'docx',
            'xlsx',
            'xls',
            'csv',
            'tsv',
            'txt',
            'md',
            'json',
            'pptx',
            'html',
            'htm'
          ]
        },
        { name: 'Audio', extensions: ['mp3', 'wav', 'ogg', 'm4a', 'flac', 'webm'] },
        { name: 'Video', extensions: ['mp4', 'mov', 'avi', 'mkv', 'm4v', 'wmv', 'flv'] },
        { name: 'All files', extensions: ['*'] }
      ]
    })
    if (result.canceled) return []
    return result.filePaths
  })

  handle('upload:pickFolder', async (): Promise<string | null> => {
    const mainWin = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
    if (!mainWin) return null
    const result = await dialog.showOpenDialog(mainWin, {
      title: 'Select working folder',
      properties: ['openDirectory']
    })
    if (result.canceled || result.filePaths.length === 0) return null
    return result.filePaths[0]
  })

  handle(
    'upload:saveFile',
    async (
      _e,
      payload: { conversationId: string; sourcePath: string; progressId?: string }
    ): Promise<UploadedFileMetadata> => {
      if (!payload?.conversationId) throw new Error('conversationId is required')
      if (!payload?.sourcePath) throw new Error('sourcePath is required')
      // The renderer stages a chip the moment the user picks the file and
      // correlates these ticks to it by progressId — a big copy is not
      // instant, and without them the composer sits blank until it lands.
      const progressId = payload.progressId
      const meta = await saveUpload(
        payload.conversationId,
        payload.sourcePath,
        progressId
          ? (copiedBytes, totalBytes) =>
              broadcast('upload:copyProgress', { progressId, copiedBytes, totalBytes })
          : undefined
      )
      agent.corpus.emit('upload.completed', {
        filePath: meta.filePath,
        type: meta.type,
        sizeBytes: meta.sizeBytes
      })
      return meta
    }
  )

  handle(
    'upload:saveBuffer',
    async (
      _e,
      payload: { conversationId: string; buffer: ArrayBuffer; fileName: string }
    ): Promise<UploadedFileMetadata> => {
      if (!payload?.conversationId) throw new Error('conversationId is required')
      if (!payload?.buffer) throw new Error('buffer is required')
      if (!payload?.fileName) throw new Error('fileName is required')
      const meta = await saveUploadFromBuffer(
        payload.conversationId,
        Buffer.from(payload.buffer),
        payload.fileName
      )
      agent.corpus.emit('upload.completed', {
        filePath: meta.filePath,
        type: meta.type,
        sizeBytes: meta.sizeBytes
      })
      return meta
    }
  )

  handle('upload:readFile', async (_e, relativePath: string): Promise<Buffer | null> => {
    return readUpload(relativePath)
  })

  handle('upload:exists', async (_e, relativePath: string): Promise<boolean> => {
    return uploadExists(relativePath)
  })

  // Slides are rendered here, not in the renderer: the SVGs land as files
  // inside the workspace, so a deck is painted once and every later mount
  // (and every relaunch) just reads the images back.
  handle('upload:renderDeck', async (_e, relativePath: string): Promise<DeckPreview | null> => {
    return renderDeckPreview(relativePath)
  })

  handle(
    'upload:getMetadata',
    async (
      _e,
      relativePath: string
    ): Promise<{ sizeBytes: number; mtimeMs: number; mimeType: string } | null> => {
      const stat = await statUpload(relativePath)
      if (!stat) return null
      const { mimeType } = classifyFile(relativePath)
      return { ...stat, mimeType }
    }
  )

  handle('upload:isSupported', (_e, fileName: string): boolean => {
    return isSupportedExtension(fileName) || categorizeFile(fileName) !== 'unknown'
  })

  handle(
    'upload:validate',
    (
      _e,
      payload: {
        fileName: string
        sizeBytes: number
        currentCount: number
        currentTotalBytes: number
      }
    ): ValidationError | null => {
      return validateFile(
        payload.fileName,
        payload.sizeBytes,
        payload.currentCount,
        payload.currentTotalBytes
      )
    }
  )

  handle(
    'upload:openExternal',
    async (_e, relativePath: string): Promise<{ ok: boolean; error?: string }> => {
      const abs = resolveUploadPath(relativePath)
      if (!abs) return { ok: false, error: 'invalid path' }
      try {
        const error = await shell.openPath(abs)
        if (error) return { ok: false, error }
        return { ok: true }
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) }
      }
    }
  )

  // The file: URL an in-chat <webview> loads an .html upload from. The guest
  // renders the page from its real location — relative assets resolve and
  // page scripts run, exactly as the OS browser would — which the old srcDoc
  // iframe could not do (a srcdoc document inherits the app's own CSP, whose
  // script-src 'self' blocked every inline <script>). Same workspace-scoped
  // resolver as readFile, so a malformed path can't point the guest elsewhere.
  handle('upload:fileUrl', async (_e, relativePath: string): Promise<string | null> => {
    const abs = resolveUploadPath(relativePath)
    return abs ? pathToFileURL(abs).href : null
  })

  // Stat a path the assistant mentioned in chat so the renderer can decide
  // whether to show a card (and which kind). Resolves a leading ~. Not
  // workspace-scoped: assistant-referenced paths live anywhere on the user's
  // own machine, and this only reads existence/type, never contents.
  handle(
    'upload:statPath',
    async (_e, p: string): Promise<{ exists: boolean; isDirectory: boolean }> => {
      const abs = resolveDevicePath(p)
      if (!abs) return { exists: false, isDirectory: false }
      try {
        const { stat } = await import('node:fs/promises')
        const st = await stat(abs)
        return { exists: true, isDirectory: st.isDirectory() }
      } catch {
        return { exists: false, isDirectory: false }
      }
    }
  )

  // List the immediate (top-level) contents of a directory so the chat can
  // attach a working folder's structure to each turn's context. Resolves a
  // leading ~. Not workspace-scoped — working folders are arbitrary absolute
  // paths the user picked. Directories sort first, then alphabetical; the entry
  // count is capped so a huge directory can't blow up the prompt.
  handle(
    'upload:listFolder',
    async (
      _e,
      p: string
    ): Promise<{
      entries: { name: string; isDirectory: boolean }[]
      truncated: boolean
      omittedDirectories?: number
      omittedFiles?: number
      error?: string
    }> => {
      const abs = resolveDevicePath(p)
      if (!abs) return { entries: [], truncated: false, error: 'invalid path' }
      try {
        const { readdir } = await import('node:fs/promises')
        const dirents = await readdir(abs, { withFileTypes: true })
        const sorted = dirents
          .map((d) => ({ name: d.name, isDirectory: d.isDirectory() }))
          .sort((a, b) => {
            if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1
            return a.name.localeCompare(b.name)
          })
        const LIMIT = 200
        const omitted = sorted.slice(LIMIT)
        const omittedDirectories = omitted.filter((e) => e.isDirectory).length
        return {
          entries: sorted.slice(0, LIMIT),
          truncated: omitted.length > 0,
          omittedDirectories,
          omittedFiles: omitted.length - omittedDirectories
        }
      } catch (err) {
        return {
          entries: [],
          truncated: false,
          error: err instanceof Error ? err.message : String(err)
        }
      }
    }
  )

  // The project each touched directory belongs to, for the folder chips over a
  // transcript: the repository root above it when there is one, so a run that
  // edits `wolffish-landing/content/blog/en` bills a chip reading
  // `wolffish-landing`, never `blog`. The rules and their order live in
  // src/main/uploads/project-folders.ts; only the filesystem is supplied here.
  // Keyed by the directory as the renderer sent it.
  handle(
    'upload:projectFolders',
    async (_e, dirs: string[], workingFolders: string[]): Promise<Record<string, string>> =>
      projectFoldersFor(
        Array.isArray(dirs) ? dirs : [],
        Array.isArray(workingFolders) ? workingFolders : [],
        {
          exists: existsSync,
          home: os.homedir(),
          workspaceFiles: join(workspaceRoot(), 'files')
        }
      )
  )

  // Reveal a path in the OS file manager: a directory opens directly, a file is
  // revealed in its parent folder (selected), like "Reveal in Finder". Resolves
  // a leading ~. Intentionally not workspace-scoped — see statPath.
  handle('upload:revealPath', async (_e, p: string): Promise<{ ok: boolean; error?: string }> => {
    const abs = resolveDevicePath(p)
    if (!abs) return { ok: false, error: 'invalid path' }
    try {
      const { stat } = await import('node:fs/promises')
      const st = await stat(abs)
      if (st.isDirectory()) {
        const error = await shell.openPath(abs)
        if (error) return { ok: false, error }
      } else {
        shell.showItemInFolder(abs)
      }
      return { ok: true }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  handle('upload:download', async (_e, relativePath: string): Promise<{ ok: boolean }> => {
    const abs = resolveUploadPath(relativePath)
    if (!abs) return { ok: false }
    const mainWin = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
    if (!mainWin) return { ok: false }
    const { basename } = await import('node:path')
    const result = await dialog.showSaveDialog(mainWin, {
      defaultPath: basename(abs)
    })
    if (result.canceled || !result.filePath) return { ok: false }
    const { copyFile } = await import('node:fs/promises')
    await copyFile(abs, result.filePath)
    return { ok: true }
  })

  // Save a copy of a device path (a file the assistant read/wrote anywhere on
  // the user's machine) to a location the user picks. Device counterpart to
  // upload:download — intentionally not workspace-scoped, same as revealPath.
  handle('upload:downloadPath', async (_e, p: string): Promise<{ ok: boolean; error?: string }> => {
    const abs = resolveDevicePath(p)
    if (!abs) return { ok: false, error: 'invalid path' }
    const mainWin = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
    if (!mainWin) return { ok: false, error: 'no window' }
    try {
      const { stat } = await import('node:fs/promises')
      const st = await stat(abs)
      if (!st.isFile()) return { ok: false, error: 'not a file' }
      const { basename, resolve } = await import('node:path')
      const result = await dialog.showSaveDialog(mainWin, { defaultPath: basename(abs) })
      if (result.canceled || !result.filePath) return { ok: false }
      // Saving back onto the source is a no-op — skip the copy so we never
      // risk clobbering the original (the file is already where they asked).
      if (resolve(result.filePath) === resolve(abs)) return { ok: true }
      const { copyFile } = await import('node:fs/promises')
      await copyFile(abs, result.filePath)
      return { ok: true }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  handle('upload:revealInFolder', (_e, relativePath: string): { ok: boolean } => {
    const abs = resolveUploadPath(relativePath)
    if (!abs) return { ok: false }
    shell.showItemInFolder(abs)
    return { ok: true }
  })

  handle('runtime:setUpdatesEnabled', async (_e, value: boolean) => {
    await patchConfig((c) => ({
      ...c,
      updates: { ...(c.updates ?? { enabled: true }), enabled: value }
    }))
    // Announced like the other preference setters: the broadcast hook's
    // config.changed push is what moves the phone's mirror of this switch
    // now, rather than on its next screen focus. Without it this was the one
    // setting that synced phone→desktop but not desktop→phone.
    broadcast('preferences:changed', { updatesEnabled: value })
    return { value }
  })

  handle('runtime:setLastSettingsState', async (_e, patch: Record<string, string>) => {
    await patchConfig((c) => ({
      ...c,
      lastSettingsState: { ...c.lastSettingsState, ...patch }
    }))
  })

  handle('runtime:setWeekStartsOn', async (_e, value: WeekStartsOn) => {
    await persistWeekStartsOn(value)
    broadcast('preferences:changed', { weekStartsOn: value })
    return { value }
  })
  handle('runtime:getCompactionConfig', async () => {
    return getCompactionConfig()
  })
  handle('runtime:getCompactionRuns', async () => {
    return agent.brainstem.getCompactionRuns()
  })
  handle(
    'runtime:setCompactionConfig',
    async (_e, patch: Partial<import('@main/workspace/workspace').CompactionConfig>) => {
      const updated = await persistCompactionConfig(patch)
      const cfg = updated.compaction!
      agent.brainstem.setCompactionConfig(cfg)
      // Announced like every other settings save: an open panel in another
      // window re-seeds, the floating run card re-reads its visibility, and
      // the generic hook in broadcast() pushes config.changed to the phone.
      broadcast('compaction:configChanged', cfg)
      return cfg
    }
  )
  handle('runtime:getReflectionConfig', async () => {
    return getReflectionConfig()
  })
  handle(
    'runtime:setReflectionConfig',
    async (_e, patch: import('@main/workspace/workspace').ReflectionPatch) => {
      // Shared with the phone's tunnel RPC — persist, reschedule, announce.
      return applyReflectionPatch(patch)
    }
  )
  handle('runtime:runReflectionNow', async () => {
    return agent.brainstem.runReflectionNow()
  })
  handle('runtime:runDeepCleanNow', async () => {
    return agent.brainstem.runDeepCleanNow()
  })
  // Task-card cancel button (generic async-generation tasks; video today).
  // Mirrors what the model's video_cancel tool does — same manager, same
  // server-side DELETE — so the user can stop a run without waiting on the
  // model to notice.
  handle('task:cancel', async (_e, payload: { taskId: string }) => {
    return videoTasks.cancel(payload.taskId)
  })
  // Countdown-card Abort button: stops a pending turn-end countdown for good.
  handle('countdown:abort', async (_e, payload: { countdownId: string }) => {
    return countdowns.abort(payload.countdownId, 'user')
  })

  // ── Managed processes (Library tab, chat card buttons, `wolffish process`) ──
  // The same main-process functions the model's process_* tools call; no
  // surface holds its own list.
  handle('processes:list', async () => processManager.list())
  handle('processes:start', async (_e, payload: Parameters<typeof processManager.start>[0]) => {
    const result = await processManager.start({
      ...payload,
      origin: payload.origin ?? { conversationId: null, kind: 'started' }
    })
    return result.ok
      ? { ok: true, record: result.record }
      : { ok: false, error: result.error, record: result.record }
  })
  handle('processes:stop', async (_e, payload: { name: string }) =>
    processManager.stop(payload.name)
  )
  handle('processes:stopAll', async () => processManager.stopAll())
  handle('processes:restart', async (_e, payload: { name: string }) => {
    const result = await processManager.restart(payload.name)
    return result.ok
      ? { ok: true, record: result.record }
      : { ok: false, error: result.error, record: result.record }
  })
  handle(
    'processes:update',
    async (_e, payload: { name: string } & Parameters<typeof processManager.update>[1]) => {
      const { name, ...patch } = payload
      return processManager.update(name, patch)
    }
  )
  handle('processes:remove', async (_e, payload: { name: string }) =>
    processManager.remove(payload.name)
  )
  handle('processes:logs', async (_e, payload: { name: string; lines?: number }) =>
    processManager.logs(payload.name, { lines: payload.lines ?? 200 })
  )
  handle('processes:ports', async () => processManager.ports())

  // ── In-app browser (the card's own controls) ─────────────────────────
  // Everything a card can do to its page. The model's route is the `preview`
  // tools; this is the user's, and both land on the same tab in main.
  handle(
    'browser:createTab',
    (_e, input: { url: string; conversationId: string | null; partition?: BrowserPartition }) =>
      browserTabs.createTab(input)
  )
  handle('browser:closeTab', (_e, p: { tabId: string }) => {
    browserTabs.closeTab(p.tabId, 'user')
  })
  handle('browser:listTabs', () => browserTabs.list())
  handle('browser:navigate', async (_e, p: { tabId: string; url: string }) => {
    const tab = browserTabs.require(p.tabId)
    await tab.webContents.loadURL(p.url).catch(() => undefined)
    return tab.snapshot()
  })
  handle('browser:goBack', (_e, p: { tabId: string }) => {
    const tab = browserTabs.require(p.tabId)
    if (tab.webContents.navigationHistory.canGoBack()) tab.webContents.navigationHistory.goBack()
    return tab.snapshot()
  })
  handle('browser:goForward', (_e, p: { tabId: string }) => {
    const tab = browserTabs.require(p.tabId)
    if (tab.webContents.navigationHistory.canGoForward())
      tab.webContents.navigationHistory.goForward()
    return tab.snapshot()
  })
  handle('browser:reload', (_e, p: { tabId: string }) => {
    const tab = browserTabs.require(p.tabId)
    tab.webContents.reload()
    return tab.snapshot()
  })
  handle(
    'browser:attachViewer',
    (_e, p: { tabId: string; size: { width: number; height: number }; fps: BrowserFps }) =>
      browserTabs.attachViewer(p.tabId, p.size, p.fps)
  )
  handle('browser:detachViewer', (_e, p: { tabId: string }) => browserTabs.detachViewer(p.tabId))
  handle('browser:setViewerFps', (_e, p: { tabId: string; fps: BrowserFps }) =>
    browserTabs.setViewerFps(p.tabId, p.fps)
  )
  handle(
    'browser:setViewerSize',
    (_e, p: { tabId: string; size: { width: number; height: number } }) =>
      browserTabs.setViewerSize(p.tabId, p.size)
  )
  handle('browser:activate', (_e, p: { tabId: string }) => {
    browserTabs.activate(p.tabId)
  })
  handle('browser:sendInput', (_e, p: { tabId: string; event: BrowserInputEvent }) => {
    browserTabs.sendInput(p.tabId, p.event)
  })
  // The card's "open in browser": web URLs only — never file:, data: or a
  // custom scheme that would hand the OS something to execute.
  handle('browser:openExternal', async (_e, p: { url: string }) => {
    if (!/^https?:\/\//i.test(p.url)) return { ok: false, error: 'Only http(s) URLs open outside.' }
    await shell.openExternal(p.url)
    return { ok: true }
  })
  handle('browser:setStageRect', (_e, p: { tabId: string; rect: BrowserRect | null }) => {
    browserTabs.setStage(p.tabId, p.rect)
  })
  handle('browser:setMode', (_e, p: { tabId: string; mode: BrowserTabMode }) =>
    browserTabs.setMode(p.tabId, p.mode)
  )
  handle('updater:install', async () => {
    if (is.dev || updateInstallInProgress) return
    // Bail before tearing anything down if there's no verified artifact —
    // otherwise a failed arm would force-exit the app with nothing installed.
    // installUpdate() surfaces the error to the renderer so it can recover.
    if (!isUpdateReady()) {
      installUpdate()
      return
    }
    updateInstallInProgress = true
    // Broadcast 'installing' so a panel remounted during the grace window
    // (page navigation) restores the disabled state instead of re-enabling.
    markInstalling()
    // macOS: Squirrel unpacks and signature-checks the bundle NOW, while the
    // app is still whole. Until this resolves nothing has been torn down, so a
    // failure simply lands in the error phase with a working app behind it.
    // (Before this step existed the handler force-exited 5 s after
    // quitAndInstall — usually before Squirrel had finished — and the app
    // died with nothing installed and nothing relaunched.)
    if (!(await stageUpdate())) {
      updateInstallInProgress = false
      return
    }
    await stampPreUpdateVersion()
    void shutdownGracefully()
    // Grace period: let in-flight work finish, then force through
    await new Promise((resolve) => setTimeout(resolve, 4_000))
    quitInProgress = false
    // app.exit() skips before-quit/will-quit, so their cleanup happens here.
    const exitNow = (): void => {
      mcpManager.killAllSync()
      browserTabs.destroyAll('shutdown')
      if (lockAcquired) {
        releaseLockSync(lockfilePath())
        lockAcquired = false
      }
      app.exit(0)
    }
    if (!installUpdate()) {
      // The installer never armed and the agent/channels are already down —
      // this process is a shell. Neither leaving it open nor exiting is a
      // fix; relaunching the current version hands the user a working app
      // with the update still downloaded (cache) and the failure on screen.
      wlog.warn('[updater]', 'install did not arm — relaunching current version')
      app.relaunch()
      exitNow()
      return
    }
    // Safety net: the installer is armed (NSIS spawned / ShipIt waiting on
    // this pid), so if the normal quit did not go through, force it — and if
    // a late error says the install fell over after all, relaunch instead so
    // the app comes back rather than vanishing.
    setTimeout(() => {
      if (installFailed()) {
        wlog.warn('[updater]', 'install failed after arming — relaunching current version')
        app.relaunch()
      } else {
        wlog.warn('[updater]', 'quitAndInstall did not exit — forcing')
      }
      exitNow()
    }, 10_000)
  })

  handle('updater:consumePostUpdate', async () => {
    const cfg = await readConfig()
    const last = cfg?.updates?.lastVersion
    if (!last || last === app.getVersion()) return false
    await patchConfig((c) => {
      const { lastVersion, ...rest } = c.updates ?? { enabled: true }
      void lastVersion
      return { ...c, updates: rest as typeof c.updates }
    })
    return true
  })

  // Same readers the phone's changelog RPC uses (changelogDir and friends,
  // beside applyMobileSettings). The renderer contract keeps '' for a month
  // with no page — the Changelog screen renders that as its empty state.
  handle('updater:listChangelogMonths', () => listChangelogMonths())

  handle(
    'updater:readChangelog',
    async (_event, month: string, locale?: string) =>
      (await readChangelogMarkdown(month, locale)) ?? ''
  )

  handle('workspace:getModelCatalog', () => MODEL_CATALOG)

  // Viewer — read-only tree + read/write of individual workspace files.
  handle('viewer:readTree', (): Promise<ViewerTreeNode[]> => readViewerTree())
  handle('viewer:resync', (): Promise<ViewerTreeNode[]> => readViewerTree())
  handle(
    'viewer:readFile',
    (_e, relativePath: string): Promise<string> => readViewerFile(relativePath)
  )
  handle('viewer:writeFile', async (_e, relativePath: string, content: string): Promise<void> => {
    await writeViewerFile(relativePath, content)
    // Saving Soul, User or Agents — from their own pages or from the
    // Workspace file tree — is a change a paired phone mirrors. The
    // announcement reaches other windows directly and the phone through
    // broadcast()'s generic config.changed hook, which is why there is no
    // second push to remember here. Scoped to the three: every other
    // workspace file is desktop-only, and announcing those would make the
    // phone refetch a snapshot that cannot have moved.
    const doc = customizationDocFor(relativePath)
    if (doc) broadcast('customization:changed', { doc, path: CUSTOMIZATION_DOCS[doc] })
  })
  handle(
    'viewer:hasDefault',
    (_e, relativePath: string): Promise<boolean> => hasBundledDefault(relativePath)
  )
  handle(
    'viewer:readDefault',
    (_e, relativePath: string): Promise<string> => readBundledDefault(relativePath)
  )
  handle(
    'viewer:stat',
    (_e, relativePath: string): Promise<{ mtimeMs: number }> => statViewerFile(relativePath)
  )
  handle(
    'viewer:readBinaryFile',
    (_e, relativePath: string): Promise<Buffer> => readViewerBinaryFile(relativePath)
  )
  handle('viewer:download', async (_e, relativePath: string): Promise<{ ok: boolean }> => {
    const mainWin = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
    if (!mainWin) return { ok: false }
    const fileName = relativePath.split('/').pop() ?? relativePath
    const result = await dialog.showSaveDialog(mainWin, { defaultPath: fileName })
    if (result.canceled || !result.filePath) return { ok: false }
    const buf = await readViewerBinaryFile(relativePath)
    const { writeFile } = await import('node:fs/promises')
    await writeFile(result.filePath, buf)
    return { ok: true }
  })

  handle('viewer:revealInFolder', (_e, relativePath: string): { ok: boolean } => {
    const abs = resolveViewerPath(relativePath)
    if (!abs) return { ok: false }
    shell.showItemInFolder(abs)
    return { ok: true }
  })

  // Heartbeat
  handle('heartbeat:getJobs', () => {
    const jobs = agent.brainstem.getActiveJobs()
    const now = Date.now()
    return jobs.map((j) => ({
      ...j,
      nextRunMs: j.cron ? nextCronMs(j.cron, now) : null
    }))
  })

  // Live run-pool snapshot: up to 3 concurrent runs plus the FIFO overflow.
  // The Automations page's play-button gating renders from this seed + the
  // heartbeat:runsChanged pushes below.
  handle('heartbeat:getRuns', () => ({
    running: agent.brainstem.getRunningJobs(),
    queued: agent.brainstem.getQueuedJobs()
  }))

  // Run an automation on demand from the Heartbeat page's run button. Goes
  // through the same run pool a cron fire uses (up to 3 at once, overflow
  // queued FIFO), and coalesces if the job is already running or queued.
  handle('heartbeat:runJob', (_event, idOrLabel: string) => {
    return agent.brainstem.runJobNow(idOrLabel)
  })

  // Per-job "Edited …" stamps (label → epoch ms), maintained writer-agnostically
  // by the brainstem's reload diff; adoptMeta is the one-shot donation of the
  // legacy renderer-localStorage stamps.
  handle('heartbeat:getMeta', () => agent.brainstem.getHeartbeatEditStamps())
  handle('heartbeat:adoptMeta', (_event, stamps: Record<string, number>) =>
    agent.brainstem.adoptHeartbeatEditStamps(stamps ?? {})
  )

  // An automation's attached files and working directories. Both are stored as
  // marker lines in heartbeat.md — the page owns that write — so these handlers
  // only do the parts that need main: the native pickers, the copy into the
  // workspace, and the deletion of a copy we own. `existing` is the automation's
  // current file list, which is how attachFilesToAutomation finds the dir it
  // already owns instead of minting a second one.
  handle('automations:pickFiles', async (_event, existing: string[] | undefined) => {
    const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
    if (!win) return null
    const result = await dialog.showOpenDialog(win, {
      properties: ['openFile', 'multiSelections']
    })
    if (result.canceled || result.filePaths.length === 0) return null
    // Copying starts only once the picker closes, so these ticks double as the
    // dialog's "the copy is running now" signal — it shows its bar on the first
    // one rather than while the user is still browsing.
    return attachFilesToAutomation(existing ?? [], result.filePaths, (progress) =>
      broadcast('automations:copyProgress', progress)
    )
  })
  handle('paths:pickDirectories', async () => {
    const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
    if (!win) return null
    const result = await dialog.showOpenDialog(win, {
      properties: ['openDirectory', 'multiSelections', 'createDirectory']
    })
    if (result.canceled || result.filePaths.length === 0) return null
    return result.filePaths
  })
  handle('automations:removeFile', async (_event, filePath: string) => {
    await removeAutomationFile(filePath)
    return { ok: true as const }
  })

  agent.brainstem.setListener({
    onJobStarted: (info) => broadcast('heartbeat:jobStarted', info),
    onJobEnded: (payload) => broadcast('heartbeat:jobEnded', payload),
    onJobLog: (entry) => broadcast('heartbeat:jobLog', entry),
    onRunsChanged: (snapshot) => {
      broadcast('heartbeat:runsChanged', snapshot)
      // The phone's Automations cards gate their play button on the same pool,
      // so the two screens agree about what is already running.
      if (mobileChannel.hasPeer) mobileChannel.pushAutomationRuns(snapshot)
    },
    onCompactionRun: () => broadcast('compaction:changed', {})
  })
  // Every scheduler reload = the heartbeat file changed (any writer: card
  // editor, markdown save, the agent's automation_* tools, once-job
  // self-deletes). Push it so an open Automations page re-fetches jobs and
  // edit stamps instead of showing them stale until re-entry.
  agent.corpus.on('brainstem.schedulerReloaded', () => {
    broadcast('heartbeat:changed', {})
    if (mobileChannel.hasPeer) mobileChannel.pushAutomationsChanged()
  })

  // Procedures — saved prompts the user runs on demand from the Procedures page.
  // Plain CRUD over a JSON file. The store pushes procedures:changed on every
  // committed write, so a page left open re-fetches when the agent's
  // procedure_* tools mutate it outside any renderer action.
  setProceduresChangedListener(() => {
    broadcast('procedures:changed', {})
    // Fires on EVERY committed write — this app's page, the agent's
    // procedure_* tools, or the phone's own editor echoing back. The phone
    // re-lists on it exactly as an open page here re-fetches.
    if (mobileChannel.hasPeer) mobileChannel.pushProceduresChanged()
  })
  handle('procedures:list', () => listProcedures())
  handle(
    'procedures:create',
    (
      _event,
      payload: {
        title: string
        prompt: string
        mode?: 'single' | 'workflow'
        thinking?: 'off' | 'on' | 'high' | 'max'
        icon?: string
        projectId?: string
      }
    ) => createProcedure(payload)
  )
  handle(
    'procedures:update',
    (
      _event,
      payload: {
        id: string
        title?: string
        prompt?: string
        mode?: 'single' | 'workflow'
        thinking?: 'off' | 'on' | 'high' | 'max'
        icon?: string
        projectId?: string
        files?: ProcedureFileRef[]
        directories?: string[]
      }
    ) => updateProcedure(payload)
  )
  handle('procedures:delete', async (_event, id: string) => {
    await deleteProcedure(id)
    return { ok: true as const }
  })
  // Pick + COPY in one step, exactly like projects:pickFiles: chosen files are
  // copied into the procedure's uploads/procedure-<id>/ dir and attached;
  // returns the updated procedure, or null on cancel.
  handle('procedures:pickFiles', async (_event, procedureId: string) => {
    const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
    if (!win) return null
    const result = await dialog.showOpenDialog(win, {
      properties: ['openFile', 'multiSelections']
    })
    if (result.canceled || result.filePaths.length === 0) return null
    const attached = await attachFilesToProcedure(procedureId, result.filePaths, (progress) =>
      broadcast('procedures:copyProgress', { procedureId, ...progress })
    )
    return attached.procedure
  })

  // Projects — same inert-data shape as procedures (flat JSON list, same
  // projects:changed push); the file picker runs main-side because only main
  // has dialog.
  setProjectsChangedListener(() => {
    broadcast('projects:changed', {})
    if (mobileChannel.hasPeer) {
      mobileChannel.pushProjectsChanged()
      // Projects also ride the config snapshot — the phone's chat project
      // picker reads them from there — so the section that mirrors it has to
      // be refreshed too, not just the Projects screen.
      mobileChannel.pushConfigChanged('projects')
    }
  })
  handle('projects:list', () => listProjects())
  handle(
    'projects:create',
    (_event, payload: { title: string; icon?: string; instructions?: string }) =>
      createProject(payload)
  )
  handle(
    'projects:update',
    (
      _event,
      payload: {
        id: string
        title?: string
        icon?: string
        instructions?: string
        thinking?: 'off' | 'on' | 'high' | 'max'
        files?: ProjectFileRef[]
        directories?: string[]
      }
    ) => updateProject(payload)
  )
  handle('projects:delete', async (_event, id: string) => {
    await deleteProject(id)
    return { ok: true as const }
  })
  // Pick + COPY in one step: chosen files are copied into the project's
  // uploads/project-<id>/ dir (uniform with conversation uploads) and
  // attached; returns the updated project, or null on cancel.
  handle('projects:pickFiles', async (_event, projectId: string) => {
    const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
    if (!win) return null
    const result = await dialog.showOpenDialog(win, {
      properties: ['openFile', 'multiSelections']
    })
    if (result.canceled || result.filePaths.length === 0) return null
    // Copying starts only once the picker closes, so these ticks double as
    // the dialog's "the copy is running now" signal — it shows its bar on
    // the first one rather than while the user is still browsing.
    const attached = await attachFilesToProject(projectId, result.filePaths, (progress) =>
      broadcast('projects:copyProgress', { projectId, ...progress })
    )
    return attached.project
  })

  // Memory reindex — the cortex search index is rebuilt from scratch after an
  // app update (and on launch). On a large workspace that takes a while, so we
  // surface a blocking overlay with live progress, mirroring the heartbeat one.
  handle('reindex:getStatus', () => agent.cortex.getReindexStatus())
  // The phone gets the same three edges as a card in its overlay stack rather
  // than a takeover — a phone that cannot be used at all while an index
  // rebuilds is a phone that looks broken. Each one re-reads the cortex instead
  // of translating its own payload, so the wire carries the same object the
  // desktop's own overlay renders, and the end fires `null`, which is what
  // retires the card. The channel throttles the progress ticks; start and end
  // go through unthrottled.
  const mirrorReindex = (): void => {
    if (mobileChannel.hasPeer) mobileChannel.pushReindexStatus(agent.cortex.getReindexStatus())
  }
  agent.corpus.on('index.reindexStarted', (p) => {
    broadcast('reindex:started', p)
    mirrorReindex()
  })
  agent.corpus.on('index.reindexProgress', (p) => {
    broadcast('reindex:progress', p)
    mirrorReindex()
  })
  agent.corpus.on('index.reindexed', (p) => {
    broadcast('reindex:ended', p)
    mirrorReindex()
  })

  // Per-conversation diagnostic export — bundles everything relevant to one
  // conversation into a zip under workspace/diagnostics/ for the developer.
  // Serialized behind a single in-flight guard: the collectors read the same
  // log files, and two overlapping runs would only fight over IO.
  //
  // A caller that arrives while a run is in flight ATTACHES to it rather than
  // being turned away. The overlay is remounted by things that have nothing to
  // do with the export (switching session and back re-evaluates its render
  // gate), and a fresh mount that got "already running" would show a failure
  // card for a run that is still going and about to succeed. Same conversation
  // means the same bundle either way; a DIFFERENT conversation is a real
  // conflict and still gets told so.
  //
  // The guard is shared with the PHONE, which asks for the same bundle over
  // the tunnel (Rpc.diagnosticsExport). One collector, one archive, whichever
  // screen pressed the button: two of these running at once would read the
  // same log files and write into the same folder, and the second would only
  // slow the first down.
  let diagnosticsRunning: { conversationId: string; run: Promise<DiagnosticResult> } | null = null
  const runDiagnosticExport = async (
    conversationId: string,
    /** Where progress goes for THIS caller, on top of the renderer broadcast. */
    onProgress?: (progress: DiagnosticProgress) => void
  ): Promise<DiagnosticResult> => {
    if (diagnosticsRunning) {
      if (diagnosticsRunning.conversationId === conversationId) {
        return await diagnosticsRunning.run
      }
      return {
        ok: false,
        error: 'another diagnostic export is already running',
        conversationId,
        conversationTitle: '',
        fileName: '',
        zipPath: '',
        relativePath: '',
        sizeBytes: 0,
        fileCount: 0,
        durationMs: 0,
        modelOpinion: false,
        groups: [],
        warnings: []
      }
    }
    const run = (async (): Promise<DiagnosticResult> => {
      const config = await readConfig()
      const provider = agent.thalamus.getActiveProvider()
      // Cloud-only, by design: the opinion is a lean side-call and a local
      // model is the one case where "quick" isn't true. No model at all and
      // it's skipped outright.
      const cloud = provider !== null && provider !== 'local'
      return await exportConversationDiagnostics({
        conversationId,
        env: {
          appVersion: app.getVersion(),
          packaged: app.isPackaged,
          provider,
          model: agent.thalamus.getActiveModel(),
          chatMode: config?.llm.mode ?? 'single',
          locale: config?.locale ?? null
        },
        llm: cloud ? agent.thalamus : null,
        toolCapability: (tool) => agent.cerebellum.getToolCapability(tool),
        capabilities: agent.cerebellum.getCapabilities().map((c) => ({ name: c.name, dir: c.dir })),
        // The renderer always hears it — its overlay may be open for the same
        // conversation — and the caller that asked hears it too.
        onProgress: (p) => {
          broadcast('diagnostics:progress', p)
          onProgress?.(p)
        }
      })
    })()
    // Published before the first await inside `run` can yield, so a caller
    // arriving mid-run always finds it.
    diagnosticsRunning = { conversationId, run }
    try {
      return await run
    } finally {
      diagnosticsRunning = null
    }
  }
  handle(
    'diagnostics:export',
    async (_e, payload: { conversationId: string }): Promise<DiagnosticResult> =>
      await runDiagnosticExport(payload.conversationId)
  )
  // The phone's button, through the same runner. Registered on the channel so
  // the tunnel's handler table stays in one place.
  mobileChannel.setDiagnosticExporter(runDiagnosticExport)

  // "Save a copy" on the confirmation card — the archive already lives in the
  // workspace; this only duplicates it wherever the user points.
  handle(
    'diagnostics:saveCopy',
    async (
      _e,
      payload: { zipPath: string; fileName: string }
    ): Promise<{ ok: boolean; canceled?: boolean; error?: string }> => {
      const mainWin = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
      if (!mainWin) return { ok: false, error: 'no window' }
      const result = await dialog.showSaveDialog(mainWin, {
        defaultPath: join(app.getPath('downloads'), payload.fileName),
        filters: [{ name: 'Zip archive', extensions: ['zip'] }]
      })
      if (result.canceled || !result.filePath) return { ok: false, canceled: true }
      try {
        await copyDiagnosticArchive(payload.zipPath, result.filePath)
        return { ok: true }
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) }
      }
    }
  )

  handle('diagnostics:reveal', (_e, zipPath: string): { ok: boolean } => {
    if (!zipPath) return { ok: false }
    shell.showItemInFolder(zipPath)
    return { ok: true }
  })

  // Conversations
  handle('conversation:list', async (): Promise<ConversationMeta[]> => {
    // Fast path: the cortex conversations table answers in <1ms vs the
    // legacy JSON.parse-every-file scan (~140ms today, linear in history).
    // Fall back to the scan when the index is cold/empty (first boot,
    // rebuild in flight) so History is never blank.
    try {
      // A full rebuild DELETEs the conversations table then re-inserts in
      // event-loop-yielded batches — mid-rebuild the table is non-empty but
      // INCOMPLETE, and the >0-rows check below would happily return the
      // partial list. Prefer the disk scan for the rebuild's duration
      // (~140ms per call, rare: schema bumps + explicit rebuilds only).
      if (agent.cortex.getReindexStatus()) return listConversations()
      // No window: this is the full Conversations list, and it has to agree
      // with what the phone shows — the phone reads the same workspace.
      const rows = agent.cortex.listConversations({ limit: Number.MAX_SAFE_INTEGER })
      if (rows.length > 0) {
        return rows.map((r) => ({
          id: r.id,
          title: r.title,
          updatedAt: r.updatedAt,
          channel: r.channel as ConversationMeta['channel'],
          projectId: r.projectId,
          icon: r.icon,
          messageCount: r.messageCount
        }))
      }
    } catch {
      // index not ready — fall through
    }
    return listConversations()
  })
  handle(
    'conversation:load',
    (_e, id: string): Promise<ConversationFile | null> => loadConversation(id)
  )
  handle('conversation:save', (_e, conv: ConversationFile): Promise<{ ok: true }> => {
    return trackBackgroundTask(async () => {
      // Titling is done up front by the TurnRunner (a pure LLM call that
      // persists the title before processing), so there's nothing to generate
      // here — just persist. Merge-write: the renderer's copy owns
      // messages/stats, but the disk holds the LLM title and any rolling
      // summary the summarizer advanced since the renderer last synced — a
      // blind whole-file save would clobber those.
      let effectiveTitle = conv.title
      await updateConversation(conv.id, (disk) => {
        const merged = mergeConversationOnto(disk, conv)
        effectiveTitle = merged.title
        return merged
      })
      extensionServer.updateTitle(conv.id, effectiveTitle)
      // Post-persist rolling-summary check (fire-and-forget). When it writes
      // a summary, the onUpdated push folds it into the renderer's in-memory
      // conversation so the NEXT whole-file save keeps it.
      queueConversationSummarization(conv.id)
      return { ok: true as const }
    })
  })
  handle('conversation:delete', async (_e, id: string): Promise<{ ok: boolean }> => {
    // Deleting a conversation whose turn is still running would race the
    // end-of-turn persist and resurrect the file (or strand a live stream
    // with no home). The sidebar disables delete for processing rows; this
    // is the authoritative backstop. Automation/procedure runs now own a real
    // conversation for their whole lifetime, so they need the same guard.
    if (turnRunner.isConversationActive(id) || agent.isAutonomousRunActive(id)) {
      return { ok: false }
    }
    await deleteConversation(id)
    agent.corpus.emit('conversation.deleted', { id })
    return { ok: true }
  })
  handle(
    'conversation:create',
    (_e, model: string | null): ConversationFile => createConversation(model)
  )

  // Ollama
  handle('ollama:detect', async () => {
    const reachable = await detectOllama()
    const installed = isOllamaInstalled()
    return { reachable, installed }
  })
  handle('ollama:installUrl', () => platformInstallUrl(process.platform))
  handle('ollama:openInstallPage', async () => {
    await shell.openExternal(platformInstallUrl(process.platform))
    return { opened: true }
  })
  handle('ollama:start', () => {
    const result = startOllama()
    // The daemon takes a moment to answer; the watch re-probes on its own
    // tick, and once more now so the flip lands as soon as it is up.
    if (result.ok) setTimeout(() => ollamaWatch?.poke(), 1500).unref()
    return result
  })
  // The watch's settled answer — what the renderer seeds its cache from at
  // boot; every later change arrives as `ollama:changed`.
  handle('ollama:snapshot', (): OllamaSnapshot => {
    return ollamaWatch?.current() ?? { reachable: false, installed: [] }
  })
  handle('ollama:listInstalled', async () => {
    try {
      return await listTags()
    } catch {
      return []
    }
  })

  handle('ollama:scanAvailable', async () => {
    const cfg = await readConfig()
    const folder = cfg?.ollamaModelsFolder || defaultModelsFolder()
    const scanned = await scanModelManifests(folder)
    return enrichWithDetails(scanned)
  })

  handle('ollama:getModelsFolder', async () => {
    const cfg = await readConfig()
    return cfg?.ollamaModelsFolder || defaultModelsFolder()
  })

  handle('ollama:setModelsFolder', async (_e, folder: string) => {
    await patchConfig((c) => ({ ...c, ollamaModelsFolder: folder }))
    return { ok: true as const, folder }
  })

  handle('ollama:pickModelsFolder', async () => {
    const mainWin = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
    if (!mainWin) return null
    const result = await dialog.showOpenDialog(mainWin, {
      title: 'Select Ollama models folder',
      properties: ['openDirectory']
    })
    if (result.canceled || result.filePaths.length === 0) return null
    return result.filePaths[0]
  })

  // Model selection — pulls (if needed) and persists. Streams progress to
  // every renderer; final 'success' or error is also broadcast.
  handle('model:select', async (_e, modelName: string) => {
    if (activePull && activePullModel !== modelName) {
      activePull.abort()
    }
    if (activePull && activePullModel === modelName) {
      return { ok: true, alreadyRunning: true }
    }

    const installed = await listTags().catch(() => [])
    const alreadyDownloaded = installed.some((t) => t.name === modelName)

    if (alreadyDownloaded) {
      await selectLocalModel(modelName)
      const updated = await readConfig()
      if (updated?.llm.local.model) {
        localProvider.configure(updated.llm.local.model, updated.llm.local.endpoint)
      }
      broadcast('model:pullDone', { modelName, ok: true as const })
      ollamaWatch?.poke()
      return { ok: true, alreadyDownloaded: true }
    }

    const controller = new AbortController()
    activePull = controller
    activePullModel = modelName

    try {
      await pullModel({
        model: modelName,
        signal: controller.signal,
        onStatus: (status: OllamaPullStatus) => {
          if (status.kind === 'success') {
            broadcast('model:pullProgress', {
              modelName,
              status: 'success',
              completed: null,
              total: null
            })
          } else {
            broadcast('model:pullProgress', {
              modelName,
              status: status.status,
              completed: status.completed,
              total: status.total
            })
          }
        }
      })
      await selectLocalModel(modelName)
      const updated = await readConfig()
      if (updated?.llm.local.model) {
        localProvider.configure(updated.llm.local.model, updated.llm.local.endpoint)
      }
      broadcast('model:pullDone', { modelName, ok: true as const })
      ollamaWatch?.poke()
      return { ok: true }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      const aborted = controller.signal.aborted
      broadcast('model:pullDone', {
        modelName,
        ok: false as const,
        error: message,
        aborted
      })
      return { ok: false, error: message, aborted }
    } finally {
      if (activePull === controller) {
        activePull = null
        activePullModel = null
      }
    }
  })

  handle('model:cancelPull', () => {
    activePull?.abort()
    return { canceled: !!activePull }
  })

  handle('model:status', () => ({
    model: localProvider.currentModel
  }))

  // Active-model capability check used by the renderer to decide whether
  // to allow image uploads. Cloud models go through the well-known-family
  // check in vision.ts (text-only APIs like DeepSeek reject image parts
  // with HTTP 400); for local Ollama we ask /api/show whether the model
  // declares a "vision" capability (cached in LocalProvider). Returns
  // false when no model is available at all so the renderer can dim the
  // upload button.
  handle(
    'model:capabilities',
    async (): Promise<{
      provider: string | null
      model: string | null
      supportsVision: boolean
      contextWindow: number
      compactionAt: number
    }> => {
      const contextWindow = await agent.thalamus.resolveActiveContextWindow()
      // Real auto-compaction trigger point for the active model, in tokens —
      // the meter draws it as a tick so the visible % and the compaction
      // trigger share one denominator story.
      const compactionAt = Math.floor(agent.thalamus.getContextBudget() * COMPACTION_THRESHOLD)
      const provider = agent.thalamus.getActiveProvider()
      if (!provider)
        return { provider: null, model: null, supportsVision: false, contextWindow, compactionAt }
      if (provider === 'local') {
        const model = agent.thalamus.getLocalModelName()
        const supportsVision = await agent.thalamus.localSupportsVision()
        return { provider, model, supportsVision, contextWindow, compactionAt }
      }
      const cloudProviders = agent.thalamus.getCloudProviders()
      const active = cloudProviders.find((p) => p.id === provider)
      const model = active?.model ?? null
      const supportsVision = model !== null && cloudModelSupportsVision(provider, model)
      return { provider, model, supportsVision, contextWindow, compactionAt }
    }
  )

  // Cloud providers — list/save/remove persist to config.json and re-seed
  // the thalamus cascade in-place. test hits the provider's /v1/models
  // endpoint, which validates auth without spending tokens and returns the
  // catalogue used to populate the model dropdown.
  handle('provider:list', async (): Promise<ProviderListEntry[]> => {
    const cfg = await readConfig()
    const providers = cfg?.llm.providers ?? []
    return providers.map((p) => ({
      id: p.id,
      model: p.model,
      apiKey: p.apiKey,
      models: p.models,
      reasoningModels: p.reasoningModels
    }))
  })

  handle(
    'provider:test',
    async (
      _e,
      payload: { id: CloudProviderConfig['id']; apiKey?: string }
    ): Promise<ProviderTestResult> => {
      // No apiKey from the renderer means "re-validate the key already on
      // disk" — used by the panel's silent refresh on mount. The stored key
      // never round-trips back to the renderer.
      let apiKey = payload.apiKey
      const usingStored = !apiKey
      if (!apiKey) {
        const cfg = await readConfig()
        apiKey = cfg?.llm.providers.find((p) => p.id === payload.id)?.apiKey
      }
      if (!apiKey) return { ok: false, kind: 'invalid_key' }

      const result = await fetchProviderModels(payload.id, apiKey)
      if (result.ok && usingStored) {
        const cfg = await readConfig()
        const existing = cfg?.llm.providers.find((p) => p.id === payload.id)
        if (existing) {
          await setCloudProvider({
            ...existing,
            models: result.models,
            reasoningModels: result.reasoningModels
          })
          const next = await readConfig()
          if (next?.llm.providers) {
            thalamus.setCloudProviders(next.llm.providers)
            thalamus.setBrain(next.llm.brain ?? null)
          }
          broadcast('provider:updated', { id: payload.id })
        }
      }
      return result
    }
  )

  // Save accepts an optional apiKey — if omitted, we keep what's already on
  // disk. Lets the user change just the model selection without re-pasting
  // their key.
  handle(
    'provider:save',
    async (
      _e,
      payload: {
        id: CloudProviderConfig['id']
        model: string
        apiKey?: string
        models?: string[]
        reasoningModels?: string[]
      }
    ): Promise<{ ok: true } | { ok: false; error: string }> => {
      const cfg = await readConfig()
      const existing = cfg?.llm.providers.find((p) => p.id === payload.id)
      const apiKey = payload.apiKey ?? existing?.apiKey
      if (!apiKey) {
        return { ok: false, error: 'no_key' }
      }
      const updated = await setCloudProvider({
        id: payload.id,
        model: payload.model,
        apiKey,
        models: payload.models ?? existing?.models,
        reasoningModels: payload.reasoningModels ?? existing?.reasoningModels
      })
      thalamus.setCloudProviders(updated.llm.providers)
      thalamus.setBrain(updated.llm.brain ?? null)
      broadcast('provider:updated', { id: payload.id })
      return { ok: true }
    }
  )

  handle('provider:remove', async (_e, id: CloudProviderConfig['id']): Promise<{ ok: true }> => {
    const updated = await removeCloudProvider(id)
    thalamus.setCloudProviders(updated.llm.providers)
    thalamus.setBrain(updated.llm.brain ?? null)
    broadcast('provider:updated', { id })
    return { ok: true }
  })

  handle(
    'provider:setBrain',
    async (
      _e,
      brain: { providerId: CloudProviderConfig['id']; model: string } | null
    ): Promise<{ ok: true }> => {
      const updated = await persistBrain(brain)
      thalamus.setBrain(updated.llm.brain ?? null)
      // Broadcast so the Brain page, the chat mode switcher, and the
      // reasoning button all reflect the new Brain immediately.
      broadcast('provider:updated', { id: brain?.providerId ?? null })
      return { ok: true }
    }
  )

  handle('provider:setMode', async (_e, mode: 'single' | 'workflow'): Promise<{ ok: true }> => {
    await persistMode(mode === 'workflow' ? 'workflow' : 'single')
    agent.setMode(mode === 'workflow' ? 'workflow' : 'single')
    broadcast('provider:updated', { id: null })
    return { ok: true }
  })

  // Chat — delegated to ElectronChannel. The handler returns the turnId
  // synchronously so the renderer can register listeners before any
  // segment fires. Streaming continues in the background inside the
  // channel.
  handle(
    'chat:send',
    (
      e,
      payload: {
        history: ChatHistoryMessage[]
        conversationId?: string | null
        userMessageId?: string
        assistantMessageId?: string
        workingFolders?: string[]
        contextFiles?: string[]
        thinkingMode?: string
        modeOverride?: 'single' | 'workflow'
        projectId?: string | null
        planMode?: boolean
      }
    ) => electronChannel.send(e.sender, payload)
  )

  // Mid-turn messages: the inbox is keyed by conversation, so a window
  // watching a Telegram/automation run can steer it too — same handler.
  handle(
    'chat:interject',
    (
      _e,
      payload: {
        conversationId: string
        messageId: string
        text: string
        attachments?: MessageAttachment[]
        voicePrompt?: boolean
        voiceLang?: string
      }
    ) => electronChannel.interject(payload)
  )
  handle(
    'chat:withdrawInterjection',
    async (_e, payload: { conversationId: string; messageId: string }) =>
      turnRunner.withdrawInterjection(payload.conversationId, payload.messageId, 'user') ||
      // Same fallback as the phone's: a HELD message (its run was stopped) is
      // not in any inbox, and taking it back is how a surface says it has the
      // words now.
      (await releaseHeldInterjection(payload.conversationId, payload.messageId))
  )
  // A HELD message (its run was stopped) that a window has just put back in a
  // composer. Separate from the withdraw above because the park must not be
  // emptied on a guess: only the disposition that means "nobody is waiting on
  // this any more" can be released by a renderer.
  handle(
    'chat:releaseHeldInterjection',
    (_e, payload: { conversationId: string; messageId: string }) =>
      releaseHeldInterjection(payload.conversationId, payload.messageId)
  )
  handle('chat:pendingInterjections', (_e, conversationId: string) =>
    listPendingInterjections(conversationId)
  )

  handle('chat:cancel', async (_e, payload?: { conversationId?: string | null }) => {
    const conversationId = payload?.conversationId ?? null
    const result = await electronChannel.cancel(conversationId)
    // Nothing in-app owned that conversation — it's a Telegram/WhatsApp (or
    // automation) run the user is watching from the app, so abort it through
    // the runner. Without this the Stop button on a mirrored channel run
    // would be a dead control.
    if (!result.canceled && conversationId) {
      if (turnRunner.cancelConversation(conversationId)) return { canceled: true }
      // Last stop: an automation/procedure run, which never enters the runner
      // — the agent owns those controllers.
      return { canceled: agent.cancelAutonomousRun(conversationId) }
    }
    return result
  })

  // Cold-start snapshot of every conversation currently running, on ANY
  // channel. chat:turnState only broadcasts transitions, so a window opened
  // (or reopened from the tray) mid-run has no way to learn about it —
  // this is how the renderer seeds its live run state.
  // Plan mode per conversation — held in main (runtime/plan-mode) so the
  // composer chip and the paired phone's switch read one stance. A set from
  // either side fans out to every window and to the phone.
  handle('chat:planModeGet', (_e, conversationId: string): boolean =>
    getPlanMode(String(conversationId ?? ''))
  )
  handle(
    'chat:planModeSet',
    (_e, payload: { conversationId: string; planMode: boolean }): boolean =>
      setPlanMode(String(payload?.conversationId ?? ''), payload?.planMode === true)
  )
  onPlanModeChange((change) => broadcast('chat:planMode', change))

  handle('chat:activeRuns', (): ActiveRun[] => [
    ...turnRunner.activeRuns(),
    // Autonomous runs (automations, procedures) bypass the runner entirely,
    // so they carry their own registry — without them a window opened while an
    // automation works would render its conversation idle and editable.
    ...agent.activeAutonomousRuns()
  ])

  // The turn-so-far for one running conversation — the newest live-mirror
  // snapshot of the assistant message being written. chat:activeRuns says a
  // run EXISTS; this says what it has produced. A window opened (or reloaded)
  // mid-run seeds its feed from it instead of showing a bare thinking bubble
  // until the next mirror tick, which across a long tool call is minutes
  // away. Served from the mobile channel's mirror cache, which every
  // channel's mirror feeds — a run started on the phone, Telegram, the CLI
  // or an automation all answer here.
  handle('chat:turnMirror', (_e, conversationId: string) =>
    mobileChannel.turnMirrorFor(String(conversationId ?? ''))
  )

  handle('chat:approvalRespond', (_e, payload: { id: string; decision: ApprovalDecision }) =>
    electronChannel.respondApproval(payload)
  )

  handle('chat:askRespond', (_e, payload: { id: string; response: AskUserResponse }) =>
    electronChannel.respondAsk(payload)
  )

  // Export the current conversation as a paginated PDF. The renderer builds a
  // self-contained transcript HTML (content + print stylesheet); main renders
  // it in a hidden, script-less window and prints it via Chromium's print
  // pipeline — same engine as the browser's "Save as PDF", so page-break CSS
  // in the stylesheet drives clean pagination. The HTML goes through a temp
  // file because data: URLs cap out below real conversation sizes.
  handle(
    'chat:exportPdf',
    async (
      _e,
      payload: { html: string; fileName: string }
    ): Promise<{ ok: boolean; canceled?: boolean; error?: string }> => {
      const mainWin = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
      if (!mainWin) return { ok: false, error: 'no window' }
      const safeName = payload.fileName.replace(/[\\/:*?"<>|]/g, '-')
      const result = await dialog.showSaveDialog(mainWin, {
        defaultPath: join(app.getPath('downloads'), safeName),
        filters: [{ name: 'PDF', extensions: ['pdf'] }]
      })
      if (result.canceled || !result.filePath) return { ok: false, canceled: true }

      const { writeFile, unlink } = await import('node:fs/promises')
      const tmpPath = join(app.getPath('temp'), `wolffish-chat-export-${Date.now()}.html`)
      let printWin: BrowserWindow | null = null
      try {
        await writeFile(tmpPath, payload.html, 'utf8')
        printWin = new BrowserWindow({
          show: false,
          webPreferences: {
            javascript: false,
            nodeIntegration: false,
            contextIsolation: true
          }
        })
        await printWin.loadFile(tmpPath)
        const pdf = await printWin.webContents.printToPDF({
          pageSize: 'A4',
          printBackground: true,
          displayHeaderFooter: true,
          headerTemplate: '<span></span>',
          footerTemplate:
            '<div style="width:100%;text-align:center;font-family:Helvetica,Arial,sans-serif;font-size:8px;color:#9ca3af;">' +
            '<span class="pageNumber"></span> / <span class="totalPages"></span></div>',
          margins: { top: 0.55, bottom: 0.65, left: 0.55, right: 0.55 }
        })
        await writeFile(result.filePath, pdf)
        return { ok: true }
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) }
      } finally {
        printWin?.destroy()
        void unlink(tmpPath).catch(() => undefined)
      }
    }
  )

  // Usage — aggregated token & cost data from markdown files.
  // Fire-and-forget load so the cache is warm by the time the user opens
  // the usage tab. Does not block window creation.
  void agent.usage.load().catch(() => undefined)

  /**
   * Same fast-path/fallback split as conversation:list above, for the same
   * reason: the cortex conversations table answers a COUNT in microseconds,
   * where the legacy scan reads and JSON.parses every conversation file
   * (~300ms over the current corpus, linear in history) to look at one number
   * in each. Falls back to the scan whenever the index can't be trusted —
   * mid-rebuild the table is DELETEd and refilled in yielded batches, and
   * unlike a partial list a wrong COUNT looks perfectly plausible.
   */
  const countConversations = async (cutoffMs: number): Promise<number> => {
    try {
      if (!agent.cortex.getReindexStatus()) {
        const n = agent.cortex.countConversationsSince(cutoffMs)
        if (n !== null) return n
      }
    } catch {
      // Index unusable — fall through to the scan.
    }
    return countConversationsSince(cutoffMs)
  }

  handle('usage:getSummary', async (_e, range: UsageTimeRange) => {
    return agent.usage.getSummary(range)
  })
  handle('usage:getStats', async (_e, range: UsageTimeRange) => {
    const stats = await agent.usage.getStats(range)
    const cutoffMs = rangeCutoffMs(range)
    return { ...stats, conversations: await countConversations(cutoffMs) }
  })
  handle('usage:getDaily', async (_e, year: number) => {
    return agent.usage.getDaily(year)
  })
  handle('usage:sync', async () => {
    await agent.usage.sync()
    return { ok: true as const }
  })

  protocol.handle('wolffish-media', (request) => {
    const relativePath = decodeURIComponent(request.url.replace('wolffish-media://', ''))
    const absolutePath = join(workspaceRoot(), relativePath)
    return net.fetch(`file://${absolutePath}`)
  })

  // The CLI socket serves BOTH modes: a desktop user gets `wolffish` in a
  // terminal alongside the app, a headless box gets it as the only surface.
  // Started after the IPC handlers above are registered — the server's whole
  // job is forwarding into that map.
  registerCliIpc({
    handle,
    handlers: ipcHandlers,
    channel: cliChannel,
    server: cliServer,
    snapshot: () => buildCliSnapshot(),
    broadcast: (channelName, payload) => broadcast(channelName, payload),
    status: (callerPath) => buildCliStatus(callerPath),
    // The same three-step fallthrough chat:cancel uses, so the terminal can
    // stop a run it did not start — which on a headless box is every run.
    cancelAnywhere: async (conversationId) => {
      if ((await electronChannel.cancel(conversationId)).canceled) return true
      if (turnRunner.cancelConversation(conversationId)) return true
      return agent.cancelAutonomousRun(conversationId)
    },
    // The .AppImage rather than the /tmp mount it is running from, so the
    // Channels → CLI panel names a path the user can still find afterwards.
    execPath: stableExecPath(app.getPath('exe')),
    cliEntry: cliEntryPath(is.dev, app.getAppPath(), process.resourcesPath),
    // Same three functions the Wolffish tab's toggle calls. Sharing them is
    // what keeps the two screens from ever disagreeing about whether Wolffish
    // starts on its own — they are one setting with two doors.
    autostart: {
      enable: () => setAutostart(true),
      disable: () => setAutostart(false),
      read: () => readAutostartStatus()
    }
  })
  void cliServer.start().catch((err) => wlog.error('[cli]', `socket start failed: ${err}`))

  // Install the `wolffish` shim on every boot, not just on first run. It is
  // idempotent and it has to be re-pointed after an update anyway (the app
  // binary's path can move), so writing it unconditionally is both simpler
  // and more correct than tracking whether it was ever installed. Silent and
  // best-effort: it writes into the user's own ~/.wolffish/bin, needs no
  // privilege, and a failure only means the Channels → CLI panel shows its
  // "not on PATH" card with the fix.
  //
  // In dev the shim points at the client's SOURCE under Bun (see
  // cliEntryPath), so `wolffish` in a terminal is the code being edited, with
  // no build step. The installed app takes the file back on its next boot.
  void installCliPath(
    app.getPath('exe'),
    cliEntryPath(is.dev, app.getAppPath(), process.resourcesPath)
  )
    .then((state) => {
      if (state.error) wlog.warn('[cli]', `shim install failed: ${state.error}`)
      else if (state.needsPathEntry && state.profileHasEntry)
        wlog.info('[cli]', `shim written, shell profile updated — new terminals have \`wolffish\``)
      else if (state.needsPathEntry) wlog.info('[cli]', `shim written, PATH entry needed`)
      else if (is.dev) wlog.info('[cli]', `dev shim written — \`wolffish\` runs src/cli under Bun`)
    })
    .catch(() => undefined)

  if (IS_HEADLESS) {
    wlog.info('[boot]', 'headless — no window, no tray; CLI socket is the surface')
    return
  }

  createTray(cfg?.locale ?? 'en')
  createWindow()

  app.on('activate', () => {
    const win = mainBrowserWindow()
    if (win) {
      win.show()
      showDock()
    } else {
      createWindow()
      showDock()
    }
  })
})

app.on('before-quit', (event) => {
  isQuittingFromTray = true
  if (updateInstallInProgress) return
  if (quitInProgress) {
    event.preventDefault()
    return
  }
  if (isShuttingDown || !hasInflightWork()) return

  wlog.info('[quit]', 'inflight work — draining before quit')
  event.preventDefault()
  quitInProgress = true
  broadcast('app:closingPending', { tasks: pendingBackgroundTasks })
  void drainAndQuit()
})

app.on('will-quit', () => {
  // Attached terminals get their socket closed rather than left dangling on a
  // path whose daemon is gone — the client reads that as "detached", not as a
  // hang. Fire-and-forget: will-quit is synchronous and the OS reclaims the
  // socket regardless.
  void cliServer.stop().catch(() => undefined)
  // Last-resort synchronous sweep for stdio MCP children: the idle quit
  // path never runs the async drain, and Node does not kill children on
  // parent exit — a server that ignores stdin EOF would orphan.
  mcpManager.killAllSync()
  // Browser tabs are renderer processes owned by this window; the idle-quit
  // path never ran the async drain, so close them here, synchronously.
  browserTabs.destroyAll('shutdown')
  if (lockAcquired) {
    releaseLockSync(lockfilePath())
    lockAcquired = false
  }
})

app.on('window-all-closed', () => {
  // Keep the app alive in the tray on all platforms
})

function rangeCutoffMs(range: UsageTimeRange): number {
  const now = new Date()
  switch (range) {
    case 'today':
      return new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
    case 'this_month':
      return new Date(now.getFullYear(), now.getMonth(), 1).getTime()
    case '3_months':
      return new Date(now.getFullYear(), now.getMonth() - 3, 1).getTime()
    case '6_months':
      return new Date(now.getFullYear(), now.getMonth() - 6, 1).getTime()
    case 'ytd':
      return new Date(now.getFullYear(), 0, 1).getTime()
    case 'all_time':
      return 0
  }
}
