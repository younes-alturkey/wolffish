---
name: node
description: Node.js runtime and npm package manager
triggers:
  - node
  - npm
  - npx
  - nvm
  - javascript
  - js
  - typescript
  - ts
  - nodejs
  - react
  - vue
  - angular
  - express
  - next
  - vite
  - webpack
  - eslint
  - prettier
  - jest
  - vitest
  - mocha
  - package.json
  - node_modules
  - yarn
  - pnpm
  - deno
  - bun
  - svelte
  - nuxt
  - remix
  - astro
  - gatsby
  - electron
  - tauri
  - nestjs
  - fastify
  - koa
  - hapi
  - socket.io
  - prisma
  - sequelize
  - mongoose
  - typeorm
  - drizzle
  - zod
  - tailwind
  - postcss
  - sass
  - less
  - storybook
  - cypress
  - playwright
  - puppeteer
  - rollup
  - esbuild
  - swc
  - babel
  - tsx
  - jsx
  - node version
  - node runtime
  - check node
  - install node
  - update node
  - npm install
  - npm run
  - npm start
  - npm test
  - npm build
requires: []
tools:
  - name: node_check
    readOnly: true
    description: Check if a usable Node.js (24+) is available
    parameters: {}
  - name: node_install
    description: Provision Node.js with no admin rights — reuse Node 24+ if present, else download an official no-root copy into ~/.wolffish/bin
    parameters: {}
  - name: node_install_system
    description: Optional — install Node.js system-wide via the OS (admin password / UAC), so it appears in the user's own terminal
    parameters: {}
confirm_patterns:
  - pattern: "node_install"
    reason: Installing Node.js
  - pattern: "node_install_system"
    reason: Installing Node.js system-wide (needs admin)
---

# Node.js

## Usage

Use `node_check` to verify a usable Node.js (24+) is available and get the version.
If not, call `node_install` (requires user approval) — and trust it.

`node_install` is the default and needs **no admin rights**: it reuses an existing
global Node ≥24 if one is present, and otherwise downloads the official no-root
Node into `~/.wolffish/bin`. No package manager, no password prompt. This is the
same managed-first policy the `python` capability uses, so it works the same on a
fresh machine with nothing pre-installed.

`node_install_system` is **optional** and only for when the user explicitly wants
a globally visible Node in their own terminal. It installs system-wide via the OS
(Homebrew / official MSI+UAC / apt|dnf+sudo) and prompts once for the admin
password; if elevation is declined or unavailable, it falls back to the no-root
copy so the user is never left stuck. Prefer `node_install` unless asked otherwise.

Do NOT install Node yourself with raw `shell_exec` `sudo apt install nodejs` (or
`pkexec`/`brew`/`winget`/`msiexec`). Use the tools above — they route through the
shared password session and the approval gate. If one returns a permission or
"password prompt cancelled" error, surface it; that error is deterministic, so
don't retry the same command.

Once installed, use the `shell_exec` tool for `node`, `npm`, and `npx` commands.
