/**
 * Boot shim for e2e-tool-result-images-live.ts under ELECTRON_RUN_AS_NODE:
 * in that mode require('electron') resolves to the binary-path string, so
 * thalamus.ts's `net.isOnline()` would crash. Patch the module loader to
 * hand back a stub BEFORE the harness (and any provider that pulls
 * thalamus types through a value import) loads.
 *
 * The consts live in a block because these shims are script-scoped — a
 * bare `const Module` here collides with the identically named one in
 * the sibling grok / kimi shims (TS2451).
 */
/* eslint-disable @typescript-eslint/no-require-imports */
{
  const Module = require('node:module')
  const origLoad = Module._load
  Module._load = function (request: string, ...rest: unknown[]) {
    if (request === 'electron') return { net: { isOnline: () => true } }
    return origLoad.call(this, request, ...rest)
  }
}

import('./e2e-tool-result-images-live').catch((err) => {
  console.error('boot failed:', err)
  process.exit(1)
})
