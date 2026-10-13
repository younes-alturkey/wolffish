/**
 * Boot shim for e2e-openai-vision-live.ts under ELECTRON_RUN_AS_NODE —
 * same electron stub as the sibling openai shim.
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

import('./e2e-openai-vision-live').catch((err) => {
  console.error('boot failed:', err)
  process.exit(1)
})
