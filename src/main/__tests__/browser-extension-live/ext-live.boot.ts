/**
 * Boot shim for ext-live.ts under ELECTRON_RUN_AS_NODE: `require('electron')`
 * resolves to the binary path string in that mode, and the server's import
 * graph (workspace.ts) reads `app.getAppPath()` / `is.dev`. Hand back a stub
 * BEFORE anything loads. HOME must already point at a scratch dir so the
 * workspace root (`~/.wolffish/workspace`) never touches the real one.
 */
/* eslint-disable @typescript-eslint/no-require-imports */
{
  // Refuse to run against the real home: everything below writes a workspace
  // under $HOME/.wolffish. os.homedir() just echoes $HOME, so compare against
  // the passwd entry, which the environment cannot fake.
  const realHome = require('node:os').userInfo().homedir
  if (!process.env.HOME || process.env.HOME === realHome) {
    console.error('ext-live: set HOME to a scratch directory before running')
    process.exit(2)
  }
  const Module = require('node:module')
  const origLoad = Module._load
  const repo = require('node:path').resolve(__dirname, '..', '..', '..', '..')
  Module._load = function (request: string, ...rest: unknown[]) {
    if (request === 'electron') {
      return {
        app: { getAppPath: () => repo, isPackaged: false, getPath: () => process.env.HOME },
        net: { isOnline: () => true },
        shell: { openExternal: async () => undefined, showItemInFolder: () => undefined },
        systemPreferences: {
          isTrustedAccessibilityClient: () => true,
          getMediaAccessStatus: () => 'granted'
        }
      }
    }
    if (request === '@electron-toolkit/utils') return { is: { dev: true } }
    return origLoad.call(this, request, ...rest)
  }
}

import('./ext-live').catch((err) => {
  console.error('boot failed:', err)
  process.exit(1)
})
