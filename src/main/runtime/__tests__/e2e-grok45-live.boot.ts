/**
 * Boot shim for e2e-grok45-live.ts under ELECTRON_RUN_AS_NODE: in that mode
 * require('electron') resolves to the binary-path string, so thalamus.ts's
 * `net.isOnline()` would crash. Patch the module loader to hand back a stub
 * BEFORE the harness (and thalamus) load.
 */
/* eslint-disable @typescript-eslint/no-require-imports */
const Module = require('node:module')
const origLoad = Module._load
Module._load = function (request: string, ...rest: unknown[]) {
  if (request === 'electron') return { net: { isOnline: () => true } }
  return origLoad.call(this, request, ...rest)
}

import('./e2e-grok45-live').catch((err) => {
  console.error('boot failed:', err)
  process.exit(1)
})
