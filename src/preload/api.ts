import type { WolffishApi } from '@preload/index'

/**
 * How the renderer's `window.api` reaches the main process. Two
 * implementations exist: the preload's, over Electron IPC, and the Web UI's,
 * over a WebSocket into the same handler map. Everything above this line —
 * every method name, every channel string, every argument shape — is shared
 * by construction, so a panel that gains a call gains it in the browser too.
 */
export type ApiTransport = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  invoke: (channel: string, ...args: unknown[]) => Promise<any>
  subscribe: <T>(channel: string, listener: (payload: T) => void) => () => void
  /** Absolute path of a dropped File when it lives on this machine's disk; '' otherwise. */
  getPathForFile: (file: File) => string
}

export function buildApi(transport: ApiTransport): WolffishApi {
  return {
    theme: {
      get: () => transport.invoke('theme:get'),
      set: (source) => transport.invoke('theme:set', source),
      onUpdated: (listener) => transport.subscribe('theme:updated', listener)
    },
    locale: {
      get: () => transport.invoke('locale:get'),
      set: (locale) => transport.invoke('locale:set', locale)
    },
    system: {
      getInfo: () => transport.invoke('system:getInfo')
    },
    workspace: {
      getStatus: () => transport.invoke('workspace:getStatus'),
      completeOnboarding: () => transport.invoke('workspace:completeOnboarding'),
      getModelCatalog: () => transport.invoke('workspace:getModelCatalog')
    },
    ollama: {
      detect: () => transport.invoke('ollama:detect'),
      installUrl: () => transport.invoke('ollama:installUrl'),
      openInstallPage: () => transport.invoke('ollama:openInstallPage'),
      start: () => transport.invoke('ollama:start'),
      listInstalled: () => transport.invoke('ollama:listInstalled'),
      snapshot: () => transport.invoke('ollama:snapshot'),
      onChanged: (listener) => transport.subscribe('ollama:changed', listener),
      scanAvailable: () => transport.invoke('ollama:scanAvailable'),
      getModelsFolder: () => transport.invoke('ollama:getModelsFolder'),
      setModelsFolder: (folder) => transport.invoke('ollama:setModelsFolder', folder),
      pickModelsFolder: () => transport.invoke('ollama:pickModelsFolder')
    },
    model: {
      select: (modelName) => transport.invoke('model:select', modelName),
      cancelPull: () => transport.invoke('model:cancelPull'),
      status: () => transport.invoke('model:status'),
      capabilities: () => transport.invoke('model:capabilities'),
      onPullProgress: (listener) => transport.subscribe('model:pullProgress', listener),
      onPullDone: (listener) => transport.subscribe('model:pullDone', listener)
    },
    provider: {
      list: () => transport.invoke('provider:list'),
      test: (payload) => transport.invoke('provider:test', payload),
      save: (payload) => transport.invoke('provider:save', payload),
      remove: (id) => transport.invoke('provider:remove', id),
      setBrain: (brain) => transport.invoke('provider:setBrain', brain),
      setMode: (mode) => transport.invoke('provider:setMode', mode),
      onUpdated: (listener) => transport.subscribe('provider:updated', listener)
    },
    chat: {
      send: (payload) => transport.invoke('chat:send', payload),
      cancel: (payload) => transport.invoke('chat:cancel', payload),
      activeRuns: () => transport.invoke('chat:activeRuns'),
      getPlanMode: (conversationId) => transport.invoke('chat:planModeGet', conversationId),
      setPlanMode: (payload) => transport.invoke('chat:planModeSet', payload),
      onPlanMode: (listener) => transport.subscribe('chat:planMode', listener),
      turnMirror: (conversationId) => transport.invoke('chat:turnMirror', conversationId),
      respondApproval: (payload) => transport.invoke('chat:approvalRespond', payload),
      respondAsk: (payload) => transport.invoke('chat:askRespond', payload),
      exportPdf: (payload) => transport.invoke('chat:exportPdf', payload),
      onSegment: (listener) => transport.subscribe('chat:segment', listener),
      onDone: (listener) => transport.subscribe('chat:done', listener),
      onError: (listener) => transport.subscribe('chat:error', listener),
      onTurnEvent: (listener) => transport.subscribe('chat:turnEvent', listener),
      onApprovalRequest: (listener) => transport.subscribe('chat:approvalRequest', listener),
      onAskRequest: (listener) => transport.subscribe('chat:askRequest', listener),
      onCredentialBlocked: (listener) => transport.subscribe('chat:credentialBlocked', listener),
      onTurnState: (listener) => transport.subscribe('chat:turnState', listener),
      interject: (payload) => transport.invoke('chat:interject', payload),
      withdrawInterjection: (payload) => transport.invoke('chat:withdrawInterjection', payload),
      pendingInterjections: (conversationId) =>
        transport.invoke('chat:pendingInterjections', conversationId),
      releaseHeldInterjection: (payload) =>
        transport.invoke('chat:releaseHeldInterjection', payload),
      onInterjection: (listener) => transport.subscribe('chat:interjection', listener)
    },
    conversation: {
      list: () => transport.invoke('conversation:list'),
      load: (id) => transport.invoke('conversation:load', id),
      save: (conv) => transport.invoke('conversation:save', conv),
      delete: (id) => transport.invoke('conversation:delete', id),
      create: (model) => transport.invoke('conversation:create', model),
      onSummaryUpdated: (listener) => transport.subscribe('conversation:summaryUpdated', listener),
      onDeleted: (listener) => transport.subscribe('conversation:deleted', listener),
      onChanged: (listener) => transport.subscribe('conversation:changed', listener),
      onMessageMirror: (listener) => transport.subscribe('conversation:messageMirror', listener)
    },
    task: {
      cancel: (taskId) => transport.invoke('task:cancel', { taskId }),
      onChanged: (listener) => transport.subscribe('task:changed', listener)
    },
    countdown: {
      abort: (countdownId) => transport.invoke('countdown:abort', { countdownId }),
      onChanged: (listener) => transport.subscribe('countdown:changed', listener)
    },
    processes: {
      list: () => transport.invoke('processes:list'),
      start: (payload) => transport.invoke('processes:start', payload),
      stop: (name) => transport.invoke('processes:stop', { name }),
      stopAll: () => transport.invoke('processes:stopAll'),
      restart: (name) => transport.invoke('processes:restart', { name }),
      update: (payload) => transport.invoke('processes:update', payload),
      remove: (name) => transport.invoke('processes:remove', { name }),
      logs: (name, lines) => transport.invoke('processes:logs', { name, lines }),
      ports: () => transport.invoke('processes:ports'),
      onChanged: (listener) => transport.subscribe('processes:changed', listener),
      onCardChanged: (listener) => transport.subscribe('process:cardChanged', listener)
    },
    browser: {
      createTab: (input) => transport.invoke('browser:createTab', input),
      closeTab: (tabId) => transport.invoke('browser:closeTab', { tabId }),
      listTabs: () => transport.invoke('browser:listTabs'),
      navigate: (tabId, url) => transport.invoke('browser:navigate', { tabId, url }),
      goBack: (tabId) => transport.invoke('browser:goBack', { tabId }),
      goForward: (tabId) => transport.invoke('browser:goForward', { tabId }),
      reload: (tabId) => transport.invoke('browser:reload', { tabId }),
      attachViewer: (tabId, size, fps) =>
        transport.invoke('browser:attachViewer', { tabId, size, fps }),
      detachViewer: (tabId) => transport.invoke('browser:detachViewer', { tabId }),
      setViewerFps: (tabId, fps) => transport.invoke('browser:setViewerFps', { tabId, fps }),
      setViewerSize: (tabId, size) => transport.invoke('browser:setViewerSize', { tabId, size }),
      activate: (tabId) => transport.invoke('browser:activate', { tabId }),
      sendInput: (tabId, event) => transport.invoke('browser:sendInput', { tabId, event }),
      openExternal: (url) => transport.invoke('browser:openExternal', { url }),
      setStageRect: (tabId, rect) => transport.invoke('browser:setStageRect', { tabId, rect }),
      setMode: (tabId, mode) => transport.invoke('browser:setMode', { tabId, mode }),
      onFrame: (listener) => transport.subscribe('browser:frame', listener),
      onChanged: (listener) => transport.subscribe('browser:changed', listener),
      onClosed: (listener) => transport.subscribe('browser:closed', listener)
    },
    viewer: {
      readTree: () => transport.invoke('viewer:readTree'),
      readFile: (relativePath) => transport.invoke('viewer:readFile', relativePath),
      readBinaryFile: (relativePath) => transport.invoke('viewer:readBinaryFile', relativePath),
      writeFile: (relativePath, content) =>
        transport.invoke('viewer:writeFile', relativePath, content),
      hasDefault: (relativePath) => transport.invoke('viewer:hasDefault', relativePath),
      readDefault: (relativePath) => transport.invoke('viewer:readDefault', relativePath),
      stat: (relativePath) => transport.invoke('viewer:stat', relativePath),
      download: (relativePath) => transport.invoke('viewer:download', relativePath),
      revealInFolder: (relativePath) => transport.invoke('viewer:revealInFolder', relativePath),
      resync: () => transport.invoke('viewer:resync'),
      onCustomizationChanged: (listener) => transport.subscribe('customization:changed', listener)
    },
    heartbeat: {
      getJobs: () => transport.invoke('heartbeat:getJobs'),
      getRuns: () => transport.invoke('heartbeat:getRuns'),
      runJob: (idOrLabel) => transport.invoke('heartbeat:runJob', idOrLabel),
      getMeta: () => transport.invoke('heartbeat:getMeta'),
      adoptMeta: (stamps) => transport.invoke('heartbeat:adoptMeta', stamps),
      onChanged: (listener) => transport.subscribe('heartbeat:changed', listener),
      onJobStarted: (listener) => transport.subscribe('heartbeat:jobStarted', listener),
      onJobEnded: (listener) => transport.subscribe('heartbeat:jobEnded', listener),
      onJobLog: (listener) => transport.subscribe('heartbeat:jobLog', listener),
      onRunsChanged: (listener) => transport.subscribe('heartbeat:runsChanged', listener)
    },
    paths: {
      pickDirectories: () => transport.invoke('paths:pickDirectories'),
      listDirectories: (target, options) =>
        transport.invoke('paths:listDirectories', target, options)
    },
    automationFiles: {
      pickFiles: (existing) => transport.invoke('automations:pickFiles', existing),
      removeFile: (path) => transport.invoke('automations:removeFile', path),
      onCopyProgress: (listener) => transport.subscribe('automations:copyProgress', listener)
    },
    procedures: {
      list: () => transport.invoke('procedures:list'),
      create: (payload) => transport.invoke('procedures:create', payload),
      update: (payload) => transport.invoke('procedures:update', payload),
      delete: (id) => transport.invoke('procedures:delete', id),
      pickFiles: (procedureId) => transport.invoke('procedures:pickFiles', procedureId),
      onChanged: (listener) => transport.subscribe('procedures:changed', listener),
      onCopyProgress: (listener) => transport.subscribe('procedures:copyProgress', listener)
    },
    projects: {
      list: () => transport.invoke('projects:list'),
      create: (payload) => transport.invoke('projects:create', payload),
      update: (payload) => transport.invoke('projects:update', payload),
      delete: (id) => transport.invoke('projects:delete', id),
      pickFiles: (projectId) => transport.invoke('projects:pickFiles', projectId),
      onChanged: (listener) => transport.subscribe('projects:changed', listener),
      onCopyProgress: (listener) => transport.subscribe('projects:copyProgress', listener)
    },
    reindex: {
      getStatus: () => transport.invoke('reindex:getStatus'),
      onStarted: (listener) => transport.subscribe('reindex:started', listener),
      onProgress: (listener) => transport.subscribe('reindex:progress', listener),
      onEnded: (listener) => transport.subscribe('reindex:ended', listener)
    },
    diagnostics: {
      export: (payload) => transport.invoke('diagnostics:export', payload),
      saveCopy: (payload) => transport.invoke('diagnostics:saveCopy', payload),
      reveal: (zipPath) => transport.invoke('diagnostics:reveal', zipPath),
      onProgress: (listener) => transport.subscribe('diagnostics:progress', listener)
    },
    app: {
      factoryReset: () => transport.invoke('app:factoryReset'),
      restart: () => transport.invoke('app:restart'),
      rebootDevice: () => transport.invoke('app:rebootDevice'),
      onClosingPending: (listener) => transport.subscribe('app:closingPending', listener)
    },
    data: {
      getAnalytics: () => transport.invoke('data:getAnalytics')
    },
    services: {
      onChanged: (listener) => transport.subscribe('services:changed', listener)
    },
    video: {
      getConfig: () => transport.invoke('video:getConfig'),
      setConfig: (patch) => transport.invoke('video:setConfig', patch),
      test: () => transport.invoke('video:test')
    },
    runtime: {
      setLaunchAtStartup: (value) => transport.invoke('runtime:setLaunchAtStartup', value),
      getLaunchAtStartupStatus: () => transport.invoke('runtime:getLaunchAtStartupStatus'),
      setBypassPermissions: (value) => transport.invoke('runtime:setBypassPermissions', value),
      setBlockCredentials: (value) => transport.invoke('runtime:setBlockCredentials', value),
      setLocalOnly: (value) => transport.invoke('runtime:setLocalOnly', value),
      setRestrictPowerfulModels: (value) =>
        transport.invoke('runtime:setRestrictPowerfulModels', value),
      setThinkingMode: (model, mode) => transport.invoke('runtime:setThinkingMode', model, mode),
      setUpdatesEnabled: (value) => transport.invoke('runtime:setUpdatesEnabled', value),
      setWeekStartsOn: (value) => transport.invoke('runtime:setWeekStartsOn', value),
      setLastSettingsState: (patch) => transport.invoke('runtime:setLastSettingsState', patch),
      onPreferencesChanged: (listener) => transport.subscribe('preferences:changed', listener),
      onMobileSettingsChange: (listener) => transport.subscribe('settings:mobileChange', listener),
      getCompactionConfig: () => transport.invoke('runtime:getCompactionConfig'),
      setCompactionConfig: (patch) => transport.invoke('runtime:setCompactionConfig', patch),
      getCompactionRuns: () => transport.invoke('runtime:getCompactionRuns'),
      onCompactionChanged: (listener) => transport.subscribe('compaction:changed', listener),
      onCompactionConfigChanged: (listener) =>
        transport.subscribe('compaction:configChanged', listener),
      getReflectionConfig: () => transport.invoke('runtime:getReflectionConfig'),
      setReflectionConfig: (patch) => transport.invoke('runtime:setReflectionConfig', patch),
      runReflectionNow: () => transport.invoke('runtime:runReflectionNow'),
      runDeepCleanNow: () => transport.invoke('runtime:runDeepCleanNow'),
      onReflectionChanged: (listener) => transport.subscribe('reflection:changed', listener)
    },
    usage: {
      getSummary: (range) => transport.invoke('usage:getSummary', range),
      getStats: (range) => transport.invoke('usage:getStats', range),
      getDaily: (year) => transport.invoke('usage:getDaily', year),
      sync: () => transport.invoke('usage:sync')
    },
    cerebellum: {
      listCapabilities: () => transport.invoke('cerebellum:listCapabilities'),
      reload: () => transport.invoke('cerebellum:reload'),
      toggleCapability: (name, enabled) =>
        transport.invoke('cerebellum:toggleCapability', name, enabled),
      importCapability: (sourcePath) => transport.invoke('cerebellum:importCapability', sourcePath),
      pickImport: (options) => transport.invoke('cerebellum:pickImport', options),
      deleteCapability: (name) => transport.invoke('cerebellum:deleteCapability', name),
      onCapabilitiesChanged: (callback) =>
        transport.subscribe('cerebellum:capabilitiesChanged', callback)
    },
    variables: {
      list: () => transport.invoke('variables:list'),
      save: (variables) => transport.invoke('variables:save', variables),
      onChanged: (listener) => transport.subscribe('variables:changed', listener)
    },
    voice: {
      readFile: (filePath) => transport.invoke('voice:readFile', filePath),
      download: (filePath) => transport.invoke('voice:download', filePath),
      revealInFolder: (filePath) => transport.invoke('voice:revealInFolder', filePath),
      exists: (filePath) => transport.invoke('voice:exists', filePath)
    },
    upload: {
      pickFile: () => transport.invoke('upload:pickFile'),
      pickFolder: () => transport.invoke('upload:pickFolder'),
      saveFile: (payload) => transport.invoke('upload:saveFile', payload),
      saveBuffer: (payload) => transport.invoke('upload:saveBuffer', payload),
      readFile: (relativePath) => transport.invoke('upload:readFile', relativePath),
      renderDeck: (relativePath) => transport.invoke('upload:renderDeck', relativePath),
      exists: (relativePath) => transport.invoke('upload:exists', relativePath),
      getMetadata: (relativePath) => transport.invoke('upload:getMetadata', relativePath),
      isSupported: (fileName) => transport.invoke('upload:isSupported', fileName),
      validate: (payload) => transport.invoke('upload:validate', payload),
      openExternal: (relativePath) => transport.invoke('upload:openExternal', relativePath),
      fileUrl: (relativePath) => transport.invoke('upload:fileUrl', relativePath),
      statPath: (path) => transport.invoke('upload:statPath', path),
      projectFolders: (dirs, workingFolders) =>
        transport.invoke('upload:projectFolders', dirs, workingFolders),
      listFolder: (path) => transport.invoke('upload:listFolder', path),
      revealPath: (path) => transport.invoke('upload:revealPath', path),
      downloadPath: (path) => transport.invoke('upload:downloadPath', path),
      download: (relativePath) => transport.invoke('upload:download', relativePath),
      revealInFolder: (relativePath) => transport.invoke('upload:revealInFolder', relativePath),
      getPathForFile: (file) => transport.getPathForFile(file),
      onCopyProgress: (listener) => transport.subscribe('upload:copyProgress', listener)
    },
    mobile: {
      status: () => transport.invoke('mobile:status'),
      offerQr: () => transport.invoke('mobile:offerQr'),
      offerCode: () => transport.invoke('mobile:offerCode'),
      disconnect: () => transport.invoke('mobile:disconnect'),
      unpair: () => transport.invoke('mobile:unpair'),
      setVerbose: (verbose) => transport.invoke('mobile:setVerbose', verbose),
      setNotifications: (enabled) => transport.invoke('mobile:setNotifications', enabled),
      setRelayUrl: (url) => transport.invoke('mobile:setRelayUrl', url),
      onStatusChange: (callback) => transport.subscribe('mobile:statusChange', callback)
    },
    telegram: {
      getConfig: () => transport.invoke('telegram:getConfig'),
      setConfig: (patch) => transport.invoke('telegram:setConfig', patch),
      status: () => transport.invoke('telegram:status'),
      sendTestMessage: (payload) => transport.invoke('telegram:sendTestMessage', payload),
      onStatusChange: (callback) => transport.subscribe('telegram:statusChange', callback)
    },
    whatsapp: {
      getConfig: () => transport.invoke('whatsapp:getConfig'),
      setConfig: (patch) => transport.invoke('whatsapp:setConfig', patch),
      status: () => transport.invoke('whatsapp:status'),
      logout: () => transport.invoke('whatsapp:logout'),
      requestQr: () => transport.invoke('whatsapp:requestQr'),
      onQr: (callback) => transport.subscribe('whatsapp:qr', callback),
      onStatusChange: (callback) => transport.subscribe('whatsapp:statusChange', callback)
    },
    inapp: {
      getConfig: () => transport.invoke('inapp:getConfig'),
      setConfig: (patch) => transport.invoke('inapp:setConfig', patch),
      onConfigChange: (callback) => transport.subscribe('inapp:configChange', callback)
    },
    cli: {
      getConfig: () => transport.invoke('cli:getConfig'),
      setConfig: (patch) => transport.invoke('cli:setConfig', patch),
      onConfigChange: (callback) => transport.subscribe('cli:configChange', callback),
      pathStatus: () => transport.invoke('cli:pathStatus'),
      installPath: () => transport.invoke('cli:installPath'),
      uninstallPath: () => transport.invoke('cli:uninstallPath'),
      onPathChange: (callback) => transport.subscribe('cli:pathChanged', callback),
      serviceStatus: () => transport.invoke('service:status'),
      serviceInstall: (mode) => transport.invoke('service:install', mode),
      serviceUninstall: () => transport.invoke('service:uninstall'),
      serviceSetMode: (mode) => transport.invoke('service:setMode', mode),
      serviceMechanism: () => transport.invoke('service:mechanism'),
      entryPath: () => transport.invoke('cli:entryPath')
    },
    mcp: {
      list: () => transport.invoke('mcp:list'),
      add: (input) => transport.invoke('mcp:add', input),
      remove: (id) => transport.invoke('mcp:remove', id),
      setEnabled: (id, enabled) => transport.invoke('mcp:setEnabled', id, enabled),
      setHeaders: (id, headers) => transport.invoke('mcp:setHeaders', id, headers),
      test: (id) => transport.invoke('mcp:test', id),
      authorize: (id) => transport.invoke('mcp:authorize', id),
      onStatusChange: (callback) => transport.subscribe('mcp:statusChange', callback)
    },
    brave: {
      getConfig: () => transport.invoke('brave:getConfig'),
      setConfig: (patch) => transport.invoke('brave:setConfig', patch),
      status: () => transport.invoke('brave:status'),
      test: (apiKey) => transport.invoke('brave:test', apiKey)
    },
    notion: {
      getConfig: () => transport.invoke('notion:getConfig'),
      setConfig: (connections) => transport.invoke('notion:setConfig', connections),
      status: () => transport.invoke('notion:status'),
      test: (token) => transport.invoke('notion:test', token)
    },
    github: {
      getConfig: () => transport.invoke('github:getConfig'),
      setConfig: (connections) => transport.invoke('github:setConfig', connections),
      status: () => transport.invoke('github:status'),
      test: (token) => transport.invoke('github:test', token)
    },
    memes: {
      getConfig: () => transport.invoke('memes:getConfig'),
      setConfig: (patch) => transport.invoke('memes:setConfig', patch),
      status: () => transport.invoke('memes:status'),
      testGiphy: (apiKey) => transport.invoke('memes:testGiphy', apiKey),
      testImgflip: (payload) => transport.invoke('memes:testImgflip', payload)
    },
    google: {
      getConfig: () => transport.invoke('google:getConfig'),
      setConfig: (patch) => transport.invoke('google:setConfig', patch),
      status: () => transport.invoke('google:status'),
      checkBinary: () => transport.invoke('google:checkBinary'),
      setup: () => transport.invoke('google:setup'),
      update: () => transport.invoke('google:update'),
      getSetupState: () => transport.invoke('google:getSetupState'),
      onSetupState: (listener) => transport.subscribe('google:setupState', listener),
      onAuthUrl: (listener) => transport.subscribe('google:authUrl', listener),
      uploadCredentials: (jsonContent) => transport.invoke('google:uploadCredentials', jsonContent),
      deleteCredentials: () => transport.invoke('google:deleteCredentials'),
      authAdd: (email, opts) => transport.invoke('google:authAdd', email, opts),
      cancelAuth: () => transport.invoke('google:cancelAuth'),
      listAccounts: () => transport.invoke('google:listAccounts'),
      checkAccounts: () => transport.invoke('google:checkAccounts'),
      removeAccount: (email) => transport.invoke('google:removeAccount', email)
    },
    mic: {
      checkAccess: () => transport.invoke('mic:checkAccess'),
      requestAccess: () => transport.invoke('mic:requestAccess')
    },
    stt: {
      getConfig: () => transport.invoke('stt:getConfig'),
      setConfig: (patch) => transport.invoke('stt:setConfig', patch),
      transcribe: (payload) => transport.invoke('stt:transcribe', payload),
      installStatus: () => transport.invoke('stt:installStatus'),
      install: () => transport.invoke('stt:install'),
      onInstallProgress: (listener) => transport.subscribe('stt:installProgress', listener),
      getInstallState: () => transport.invoke('stt:getInstallState')
    },
    tts: {
      getConfig: () => transport.invoke('tts:getConfig'),
      setConfig: (patch) => transport.invoke('tts:setConfig', patch),
      installStatus: () => transport.invoke('tts:installStatus'),
      install: () => transport.invoke('tts:install'),
      onInstallProgress: (listener) => transport.subscribe('tts:installProgress', listener),
      getInstallState: () => transport.invoke('tts:getInstallState'),
      preview: (payload) => transport.invoke('tts:preview', payload)
    },
    computerUse: {
      getConfig: () => transport.invoke('computerUse:getConfig'),
      checkPermissions: () => transport.invoke('computerUse:checkPermissions'),
      openSettings: (pane) => transport.invoke('computerUse:openSettings', pane)
    },
    browserExtension: {
      getConfig: () => transport.invoke('browserExtension:getConfig'),
      setConfig: (patch) => transport.invoke('browserExtension:setConfig', patch),
      status: () => transport.invoke('browserExtension:status'),
      openExtensionFolder: () => transport.invoke('browserExtension:openExtensionFolder'),
      getExtensionPath: () => transport.invoke('browserExtension:getExtensionPath'),
      updateExtension: (target) => transport.invoke('browserExtension:updateExtension', target),
      testConnection: (target) => transport.invoke('browserExtension:testConnection', target),
      openExtensionsPage: () => transport.invoke('browserExtension:openExtensionsPage'),
      doctor: (opts) => transport.invoke('browserExtension:doctor', opts),
      fix: (action, opts) => transport.invoke('browserExtension:fix', action, opts),
      setOverlayEnabled: (enabled, target) =>
        transport.invoke('browserExtension:setOverlayEnabled', enabled, target),
      onStatusChange: (listener) => transport.subscribe('extension:statusChange', listener)
    },
    updater: {
      install: () => transport.invoke('updater:install'),
      check: () => transport.invoke('updater:check'),
      getVersion: () => transport.invoke('updater:getVersion'),
      getReady: () => transport.invoke('updater:getReady'),
      getState: () => transport.invoke('updater:getState'),
      revealInstaller: () => transport.invoke('updater:revealInstaller'),
      consumePostUpdate: () => transport.invoke('updater:consumePostUpdate'),
      listChangelogMonths: () => transport.invoke('updater:listChangelogMonths'),
      readChangelog: (month: string, locale?: string) =>
        transport.invoke('updater:readChangelog', month, locale),
      onAvailable: (listener) => transport.subscribe('updater:available', listener),
      onProgress: (listener) => transport.subscribe('updater:progress', listener),
      onReady: (listener) => transport.subscribe('updater:ready', listener),
      onState: (listener) => transport.subscribe('updater:state', listener)
    },
    web: {
      getConfig: () => transport.invoke('web:getConfig'),
      setConfig: (patch) => transport.invoke('web:setConfig', patch),
      setPassword: (password) => transport.invoke('web:setPassword', password),
      revealPassword: () => transport.invoke('web:revealPassword'),
      regeneratePassword: () => transport.invoke('web:regeneratePassword'),
      status: () => transport.invoke('web:status'),
      listSessions: () => transport.invoke('web:listSessions'),
      revokeSession: (id) => transport.invoke('web:revokeSession', id),
      revokeAllSessions: () => transport.invoke('web:revokeAllSessions'),
      listPublic: () => transport.invoke('web:listPublic'),
      revokePublic: (id) => transport.invoke('web:revokePublic', id),
      revokeAllPublic: () => transport.invoke('web:revokeAllPublic'),
      testNotification: () => transport.invoke('web:testNotification'),
      notifications: () => transport.invoke('web:notifications'),
      updateNotifications: (action) => transport.invoke('web:updateNotifications', action),
      onNotifications: (listener) => transport.subscribe('web:notifications', listener),
      renewCertificate: () => transport.invoke('web:renewCertificate'),
      httpsEnable: (input) => transport.invoke('web:httpsEnable', input),
      httpsDisable: () => transport.invoke('web:httpsDisable'),
      restart: () => transport.invoke('web:restart'),
      detectPublicIp: () => transport.invoke('web:detectPublicIp'),
      onConfigChange: (listener) => transport.subscribe('web:configChange', listener),
      onStatusChange: (listener) => transport.subscribe('web:statusChange', listener),
      onPublicChange: (listener) => transport.subscribe('web:publicChange', listener),
      onHttpsProgress: (listener) => transport.subscribe('web:httpsProgress', listener)
    },
    spellcheck: {
      onContextMenu: (listener) => transport.subscribe('spellcheck:contextMenu', listener),
      replace: (word) => transport.invoke('spellcheck:replace', word),
      addToDictionary: (word) => transport.invoke('spellcheck:addToDictionary', word)
    }
  }
}
