---
name: python
description: Hermetic Python runtime (uv-managed CPython) for native Python plugins
triggers:
  - python
  - python3
  - pip
  - venv
  - virtualenv
  - uv
  - conda
  - pipx
  - numpy
  - scipy
  - pandas
  - pytorch
  - tensorflow
  - onnx
  - onnxruntime
  - transformers
  - whisper
  - kokoro
  - python runtime
  - python install
  - check python
  - install python
tools:
  - name: python_check
    readOnly: true
    description: Check whether the managed Python runtime (uv + CPython) is installed and ready.
    parameters: {}
  - name: python_install
    description: Install the managed Python runtime (fetch uv if needed, then a pinned no-root CPython under ~/.wolffish/bin/python).
    parameters: {}
confirm_patterns:
  - pattern: "python_install"
    reason: Installing the local Python runtime
requires: []
---

# Python runtime

A self-contained Python toolchain for plugins that run native Python code
(e.g. text-to-speech via Kokoro, speech-to-text via Whisper). It never touches a
system Python: everything lives under `~/.wolffish/bin/python`, managed by
[`uv`](https://docs.astral.sh/uv/).

## Usage

- `python_check` — report whether the runtime is ready (and the pinned version).
- `python_install` — provision it (requires user approval). This fetches the `uv`
  binary if it isn't already available, then installs a pinned, relocatable
  CPython. No admin password, no system package manager, no PATH changes.

Do NOT try to install Python yourself with `shell_exec` (`brew install python`,
`apt install python3`, downloading installers). Plugins that need Python declare
`requires: ['python']`; the dependency system runs `python_install` through the
approval gate automatically.

## How plugins use it

A consumer declares `requires: ['python']`, then dynamic-imports the shared
runtime and provisions an isolated venv. Because bundled capabilities are
renamed `python` -> `.python` in the user workspace, the import is resolved at
runtime by probing both names (a static specifier can't span the rename):

```js
async function locatePythonRuntime() {
  const cerebellum = path.resolve(PLUGIN_DIR, '..', '..')
  for (const name of ['.python', 'python']) {
    const candidate = path.join(cerebellum, name, 'lib', 'runtime.mjs')
    if (await fileExists(candidate)) return import(pathToFileURL(candidate).href)
  }
  throw new Error('the `python` capability is not installed')
}

const { pythonRuntime } = await locatePythonRuntime()
const py = pythonRuntime(workspaceRoot)
await py.ensureVenv('my-tool', ['some-package'])
const { code, stdout } = await py.runInVenv('my-tool', [scriptPath, '--flag'])
```

Each consumer gets its own venv under `~/.wolffish/bin/python/venvs/<name>`, so
dependency sets never collide. Provisioning is idempotent and cached.
