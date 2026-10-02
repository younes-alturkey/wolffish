# Browser extension — live end-to-end harness

Drives the REAL `ExtensionServer` (main process code, electron-as-node) against
the REAL extension build loaded unpacked into a throwaway Chromium, and asserts
on wire responses. No LLM in the loop; no `~/.wolffish` touched (HOME is
redirected to a scratch dir for the run).

## One-time setup

```bash
# A folder with playwright + a Chromium that still honours --load-extension
# (branded Chrome 137+ dropped the flag; Playwright's Chromium keeps it).
mkdir -p /tmp/wf-pw && cd /tmp/wf-pw && npm init -y >/dev/null
npm i playwright@1.63.0 --no-audit --no-fund
npx playwright install chromium
```

## Run

```bash
cd wolffish-extension && pnpm build            # fresh dist/
cd ../wolffish-app
PLAYWRIGHT_BROWSERS_PATH="$HOME/Library/Caches/ms-playwright" \
WOLFFISH_PW_ROOT=/tmp/wf-pw \
WOLFFISH_EXT_DIST=../wolffish-extension/dist \
HOME=/tmp/wf-e2e-home \
ELECTRON_RUN_AS_NODE=1 TSX_TSCONFIG_PATH=tsconfig.node.json \
npx electron $(ls ~/.npm/_npx/*/node_modules/tsx/dist/cli.mjs | head -1) \
  src/main/__tests__/browser-extension-live/ext-live.boot.ts
```

Add `WOLFFISH_E2E_HEADED=1` to watch it. The harness prints one line per
check and exits non-zero on the first failure.

## What it covers

Handshake (origin + token), per-tab CDP sessions, snapshot + uid actions,
fill/fill_form/find, CDP screenshot (fullPage + clip), network + console rings,
dialog latch + handle, emulate echo, file upload by path, download completion,
overlay presence on touched tabs only (and hidden during capture), doctor
findings with zero and one client, the post-action aftermath fields, and one
tab group per conversation (two jobs, two tabs, two titles, neither
inheriting the other's).
