// The `python` dependency-capability.
//
// Like the `node` and `ffmpeg` capabilities, this provisions a runtime other
// plugins depend on — here a fully hermetic, uv-managed Python under
// ~/.wolffish/bin/python (see ../lib/runtime.mjs). Plugins that need Python
// declare `requires: ['python']`; cerebellum runs `python_check` and, if
// missing, `python_install` (behind the approval gate) before the plugin runs.
//
// The heavy lifting lives in lib/runtime.mjs so consumer plugins (text-to-speech,
// speech-to-text, …) reuse the exact same provisioning + venv logic. This plugin
// is just the check/install front door for the dependency system.

import path from 'node:path'
import { pythonRuntime } from '../lib/runtime.mjs'

let workspaceRoot = ''

const toolDefinitions = [
  {
    name: 'python_check',
    description: 'Check whether the managed Python runtime (uv + CPython) is installed and ready.',
    parameters: { type: 'object', properties: {}, required: [] }
  },
  {
    name: 'python_install',
    description:
      'Provision the managed Python runtime: fetch uv if needed and install a pinned, ' +
      'self-contained CPython under ~/.wolffish/bin/python. No system Python or admin rights required.',
    parameters: { type: 'object', properties: {}, required: [] }
  }
]

function runtime() {
  return pythonRuntime(workspaceRoot)
}

const plugin = {
  name: 'python',
  tools: toolDefinitions,

  async init(context) {
    workspaceRoot = context?.workspaceRoot ?? ''
  },

  async execute(toolName, _args) {
    const py = runtime()
    switch (toolName) {
      case 'python_check': {
        try {
          const status = await py.check()
          return { success: true, output: JSON.stringify(status) }
        } catch (err) {
          // A check must never throw the dependency resolver off the rails —
          // report "not installed" so the install path can run.
          return {
            success: true,
            output: JSON.stringify({ installed: false, error: err?.message ?? String(err) })
          }
        }
      }
      case 'python_install': {
        try {
          await py.ensurePython()
          const status = await py.check()
          if (!status.installed) {
            return {
              success: false,
              error:
                'Python runtime did not become ready after install. ' +
                `Expected a managed CPython ${py.PY_VERSION} under ${py.paths.HOME}.`
            }
          }
          return {
            success: true,
            output: JSON.stringify({
              installed: true,
              home: py.paths.HOME,
              uv: status.uv,
              python: py.PY_VERSION
            })
          }
        } catch (err) {
          return {
            success: false,
            error:
              `Failed to provision the Python runtime: ${err?.message ?? String(err)}\n` +
              `It would have been installed under ${path.join(py.paths.HOME)} with no admin rights.`
          }
        }
      }
      default:
        return { success: false, error: `python: unknown tool ${toolName}` }
    }
  }
}

export default plugin
