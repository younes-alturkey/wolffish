/**
 * `window.api` for a browser: the preload's own factory fed the WebSocket
 * transport, with the handful of calls a browser cannot make the Electron
 * way swapped out here.
 *
 *   native file pickers  → an <input type=file>, uploaded into the server's
 *                          staging folder, then handed to the SAME save /
 *                          attach handlers a picked path would have reached
 *   save dialogs         → a download of the URL the server rewrites to
 *   "open externally"    → a new tab
 *   "reveal in Finder"   → nothing; there is no Finder here
 *   microphone access    → the browser's own prompt, which getUserMedia raises
 *   system theme         → prefers-color-scheme, not the server's nativeTheme
 *
 * Everything else — every panel, every turn, every event — is the preload's
 * code path unchanged.
 */
import { buildApi } from '@preload/api'
import type { WolffishApi } from '@preload/index'
import i18n from '@lib/i18n'
import {
  emitUploadProgress,
  pendingAttachmentFor,
  peekPickedFile,
  registerPickedFile,
  takePickedFile,
  uploadToStaging,
  type Staged
} from '@lib/web-bridge/picked-files'
import { webPrompt } from '@lib/web-bridge/prompt'
import type { WebTransport } from '@lib/web-bridge/transport'
import { randomId } from '@lib/utils/randomId'

export type { Staged } from '@lib/web-bridge/picked-files'
export { uploadToStaging } from '@lib/web-bridge/picked-files'

/**
 * A file input, clicked. Resolves [] when the user cancels. Modern browsers
 * say so with a `cancel` event; older ones only give the window its focus
 * back — and after that a large file can take seconds to arrive (a phone
 * copying it out of iCloud first), so that fallback waits a long time
 * rather than calling a slow pick a cancel.
 */
export function pickFiles(options: { multiple?: boolean; accept?: string } = {}): Promise<File[]> {
  return new Promise((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.multiple = options.multiple === true
    if (options.accept) input.accept = options.accept
    input.style.display = 'none'
    document.body.appendChild(input)
    let settled = false
    const finish = (files: File[]): void => {
      if (settled) return
      settled = true
      window.removeEventListener('focus', onFocus)
      input.remove()
      resolve(files)
    }
    const supportsCancel = 'oncancel' in input
    const onFocus = (): void => {
      setTimeout(() => finish(Array.from(input.files ?? [])), 20_000)
    }
    input.addEventListener('change', () => finish(Array.from(input.files ?? [])))
    input.addEventListener('cancel', () => finish([]))
    if (!supportsCancel) window.addEventListener('focus', onFocus)
    input.click()
  })
}

function triggerDownload(url: string): void {
  const a = document.createElement('a')
  a.href = url
  a.download = ''
  a.rel = 'noopener'
  a.style.display = 'none'
  document.body.appendChild(a)
  a.click()
  setTimeout(() => a.remove(), 1000)
}

function openInNewTab(url: string): void {
  window.open(url, '_blank', 'noopener')
}

type DownloadAnswer = { ok: boolean; downloadUrl?: string; error?: string; canceled?: boolean }
type OpenAnswer = { ok: boolean; openUrl?: string; error?: string }

export function installWebApi(transport: WebTransport): WolffishApi {
  const api = buildApi({
    invoke: (channel, ...args) => transport.invoke(channel, ...args),
    subscribe: (channel, listener) => transport.subscribe(channel, listener),
    getPathForFile: () => ''
  })

  // Picked files travel as virtual paths: the composer shows them at once
  // (name, size, type) and the bytes go up when Send is pressed — see
  // attachments.ts. The registry behind the paths is picked-files.ts.
  const virtualPath = (file: File): string => registerPickedFile(file)
  const stage = (file: Blob, name: string, progressId?: string): Promise<Staged> =>
    uploadToStaging(
      file,
      name,
      progressId
        ? (loaded, total) =>
            transport.emitLocal('upload:copyProgress', {
              progressId,
              copiedBytes: loaded,
              totalBytes: total
            })
        : undefined
    )
  // A panel's files go up one after another, reported the way the main-side
  // copy reports its own progress (file position, bytes across the whole
  // batch), so the panel's copy card shows the upload — the slow half in a
  // browser — exactly as it shows the copy that follows it.
  type BatchTick = {
    index: number
    total: number
    name: string
    copiedBytes: number
    totalBytes: number
  }
  const stageAll = async (files: File[], onTick: (tick: BatchTick) => void): Promise<string[]> => {
    const totalBytes = files.reduce((sum, file) => sum + file.size, 0)
    const paths: string[] = []
    let before = 0
    for (const [i, file] of files.entries()) {
      const tick = (loaded: number): void =>
        onTick({
          index: i + 1,
          total: files.length,
          name: file.name,
          copiedBytes: Math.min(totalBytes, before + loaded),
          totalBytes
        })
      tick(0)
      const staged = await uploadToStaging(file, file.name, (loaded) => tick(loaded))
      before += file.size
      tick(file.size)
      paths.push(staged.path)
    }
    return paths
  }
  // A single file whose panel has a busy state but no bar of its own shows
  // its upload on the send-time pill instead.
  const stageWithPill = async (file: File): Promise<Staged> => {
    const id = randomId()
    const progress = (loaded: number, done: boolean, error: string | null): void =>
      emitUploadProgress({
        id,
        name: file.name,
        loaded,
        total: file.size,
        index: 1,
        count: 1,
        done,
        error
      })
    progress(0, false, null)
    try {
      const staged = await uploadToStaging(file, file.name, (loaded) =>
        progress(loaded, false, null)
      )
      progress(file.size, true, null)
      return staged
    } catch (err) {
      progress(0, true, err instanceof Error ? err.message : String(err))
      throw err
    }
  }

  const folderPrompt = async (): Promise<string | null> => {
    const value = await webPrompt({
      title: i18n.t('web.prompt.folder.title'),
      description: i18n.t('web.prompt.folder.description'),
      placeholder: i18n.t('web.prompt.folder.placeholder'),
      browse: 'directory',
      defaultValue: '~',
      validate: async (candidate) => {
        const trimmed = candidate.trim()
        if (!trimmed) return i18n.t('web.prompt.folder.empty')
        const stat = await api.upload.statPath(trimmed)
        if (!stat.exists) return i18n.t('web.prompt.folder.missing')
        if (!stat.isDirectory) return i18n.t('web.prompt.folder.notFolder')
        return null
      }
    })
    return value ? value.trim() : null
  }

  const baseSaveFile = api.upload.saveFile
  // A picked file "saves" instantly as a pending record; the staged copy and
  // the real record come at send time. A real path (a staged upload, say)
  // goes straight to the app's own handler.
  api.upload.saveFile = async (payload) => {
    const file = peekPickedFile(payload.sourcePath)
    if (!file) return baseSaveFile(payload)
    return pendingAttachmentFor(payload.sourcePath, file)
  }
  api.upload.saveBuffer = async ({ conversationId, buffer, fileName }) => {
    const staged = await stage(new Blob([buffer]), fileName)
    return baseSaveFile({ conversationId, sourcePath: staged.path })
  }
  // Dropped and pasted files have no path in a browser; a virtual one keeps
  // them out of memory (no arrayBuffer round-trip) and on the same path as a
  // pick.
  api.upload.getPathForFile = (file) => registerPickedFile(file)
  api.upload.pickFile = async () => (await pickFiles({ multiple: true })).map(virtualPath)
  api.upload.pickFolder = folderPrompt
  api.paths.pickDirectories = async () => {
    const folder = await folderPrompt()
    return folder ? [folder] : null
  }
  api.ollama.pickModelsFolder = folderPrompt
  // The install page belongs in THIS browser, not on the server's desktop.
  api.ollama.openInstallPage = async () => {
    openInNewTab(await api.ollama.installUrl())
    return { opened: true }
  }
  api.projects.pickFiles = async (projectId) => {
    const files = await pickFiles({ multiple: true })
    if (files.length === 0) return null
    const paths = await stageAll(files, (tick) =>
      transport.emitLocal('projects:copyProgress', { projectId, ...tick })
    )
    return transport.invoke('web:attachFiles', {
      kind: 'project',
      id: projectId,
      paths
    }) as ReturnType<WolffishApi['projects']['pickFiles']>
  }
  api.procedures.pickFiles = async (procedureId) => {
    const files = await pickFiles({ multiple: true })
    if (files.length === 0) return null
    const paths = await stageAll(files, (tick) =>
      transport.emitLocal('procedures:copyProgress', { procedureId, ...tick })
    )
    return transport.invoke('web:attachFiles', {
      kind: 'procedure',
      id: procedureId,
      paths
    }) as ReturnType<WolffishApi['procedures']['pickFiles']>
  }
  api.automationFiles.pickFiles = async (existing) => {
    const files = await pickFiles({ multiple: true })
    if (files.length === 0) return null
    const paths = await stageAll(files, (tick) =>
      transport.emitLocal('automations:copyProgress', tick)
    )
    return transport.invoke('web:attachFiles', {
      kind: 'automation',
      existing: existing ?? [],
      paths
    }) as ReturnType<WolffishApi['automationFiles']['pickFiles']>
  }
  api.cerebellum.pickImport = async () => {
    const [file] = await pickFiles({ accept: '.md,.zip,text/markdown,application/zip' })
    if (!file) return null
    return (await stageWithPill(file)).path
  }
  const baseImportCapability = api.cerebellum.importCapability
  // A dropped file reaches the panel as a virtual path (getPathForFile); it
  // is staged here, so the panel's own import call gets a real path.
  api.cerebellum.importCapability = async (sourcePath) => {
    const file = takePickedFile(sourcePath)
    if (!file) return baseImportCapability(sourcePath)
    const staged = await stageWithPill(file)
    return baseImportCapability(staged.path)
  }

  const asDownload = (answer: DownloadAnswer): DownloadAnswer => {
    if (answer?.downloadUrl) {
      triggerDownload(answer.downloadUrl)
      return { ok: true }
    }
    return answer
  }
  // Bytes never ride the socket. A file is fetched from the server's own
  // routes, which stream it with Range support and let the browser cache
  // it; base64 in one JSON frame is capped on the server (a 260 MB PDF
  // through it killed the main process) and would be unusable on a phone.
  api.upload.readFile = async (relativePath) => {
    const href = await api.upload.fileUrl(relativePath)
    return href ? fetchBytes(href) : null
  }
  api.voice.readFile = async (filePath) => {
    const bytes = await fetchBytes(`/device?path=${encodeURIComponent(filePath)}`)
    if (!bytes) throw new Error(`missing file: ${filePath}`)
    return bytes
  }
  api.upload.download = async (relativePath) =>
    asDownload((await transport.invoke('upload:download', relativePath)) as DownloadAnswer)
  api.viewer.download = async (relativePath) =>
    asDownload((await transport.invoke('viewer:download', relativePath)) as DownloadAnswer)
  api.upload.downloadPath = async (p) =>
    asDownload((await transport.invoke('upload:downloadPath', p)) as DownloadAnswer)
  api.voice.download = async (filePath) =>
    asDownload((await transport.invoke('voice:download', filePath)) as DownloadAnswer)
  api.chat.exportPdf = async (payload) =>
    asDownload((await transport.invoke('chat:exportPdf', payload)) as DownloadAnswer)
  // "Save a copy" of a diagnostics bundle is a download of the archive the
  // server already wrote — there is no save dialog to point anywhere.
  api.diagnostics.saveCopy = async ({ zipPath }) =>
    asDownload((await transport.invoke('upload:downloadPath', zipPath)) as DownloadAnswer)

  const asOpen = (answer: OpenAnswer): OpenAnswer => {
    if (answer?.openUrl) {
      openInNewTab(answer.openUrl)
      return { ok: true }
    }
    return answer
  }
  api.upload.openExternal = async (relativePath) =>
    asOpen((await transport.invoke('upload:openExternal', relativePath)) as OpenAnswer)
  api.browser.openExternal = async (url) =>
    asOpen((await transport.invoke('browser:openExternal', { url })) as OpenAnswer)

  const nothingToReveal = async (): Promise<{ ok: boolean }> => ({ ok: false })
  api.upload.revealInFolder = nothingToReveal
  api.viewer.revealInFolder = nothingToReveal
  api.voice.revealInFolder = nothingToReveal
  api.upload.revealPath = nothingToReveal
  api.diagnostics.reveal = nothingToReveal

  api.mic.checkAccess = async () =>
    window.isSecureContext && navigator.mediaDevices ? 'granted' : 'denied'
  api.mic.requestAccess = async () => true

  api.spellcheck.onContextMenu = () => () => undefined
  api.spellcheck.replace = async () => undefined
  api.spellcheck.addToDictionary = async () => undefined

  // "System" means the browser's preference here, not the server's.
  const darkQuery = window.matchMedia('(prefers-color-scheme: dark)')
  type ThemeState = Awaited<ReturnType<WolffishApi['theme']['get']>>
  const resolveTheme = (state: ThemeState): ThemeState =>
    state.themeSource === 'system' ? { ...state, shouldUseDarkColors: darkQuery.matches } : state
  const baseThemeGet = api.theme.get
  const baseThemeSet = api.theme.set
  api.theme.get = async () => resolveTheme(await baseThemeGet())
  api.theme.set = async (source) => resolveTheme(await baseThemeSet(source))
  api.theme.onUpdated = (listener) => {
    const off = transport.subscribe<ThemeState>('theme:updated', (state) =>
      listener(resolveTheme(state))
    )
    const onChange = (): void =>
      void api.theme
        .get()
        .then(listener)
        .catch(() => undefined)
    darkQuery.addEventListener('change', onChange)
    return () => {
      off()
      darkQuery.removeEventListener('change', onChange)
    }
  }

  return api
}

/** A file from the server's own routes, or null when it is not there. */
async function fetchBytes(href: string): Promise<ArrayBuffer | null> {
  const res = await fetch(href, { credentials: 'same-origin' })
  if (res.status === 404) return null
  if (!res.ok) throw new Error(`${href}: ${res.status}`)
  return res.arrayBuffer()
}
