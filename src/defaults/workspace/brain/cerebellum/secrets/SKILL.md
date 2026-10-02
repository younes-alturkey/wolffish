---
name: secrets
description: Save and list the user's secrets and variables (Settings > Variables) — API keys, tokens, base URLs, and other reusable values
triggers:
  - secret
  - secrets
  - api key
  - apikey
  - token
  - password
  - credential
  - save my key
  - save this key
  - store my key
  - remember my key
  - save the token
  - variable
  - variables
  - env var
  - environment variable
  - base url
  - save this
  - remember this value
  - what secrets
  - which secrets
  - list secrets
  - list variables
  - do i have a key
  - my keys
tools:
  - name: add_secret
    description: Save a secret/variable to the user's store (Settings > Variables), the same place they add them from the UI. If a secret with the same name exists, its value is replaced.
    parameters:
      name:
        type: string
        description: Variable name the value is referenced by, e.g. "OPENAI_API_KEY".
      value:
        type: string
        description: The secret/value to store.
      sensitive:
        type: boolean
        required: false
        description: Only changes how the Settings UI shows it (masked vs plain) — you always get the real value. Defaults to true; pass false for non-secret config like a base URL.
  - name: list_secrets
    readOnly: true
    description: List the saved secrets/variables with their actual values so you can use a stored value directly instead of asking the user. Each is tagged sensitive or not. Call before asking the user for any key/token/value.
    parameters: {}
---

# Secrets & variables

Save and look up the user's named values — API keys, tokens, passwords, base
URLs — in the same store the **Settings > Variables** panel uses
(`config.json` → `variables`). A value saved here shows up in the Settings UI
and is made available to you in your `<variables>` context block, so you can use
it directly in later tool calls.

## When to use

- The user pastes an API key/token/password and asks you to save or remember it
  → `add_secret` (sensitive by default).
- The user gives you a reusable non-secret value (a base URL, an account id) and
  wants it kept → `add_secret` with `sensitive: false`.
- You're about to ask the user for a key/value — first `list_secrets` to check
  whether it already exists.
- The user asks "what keys/secrets do I have saved?" → `list_secrets`.

## Tools

- `add_secret` — save (or update) a secret/variable. Same effect as adding it in
  the Variables UI. Replaces the value if the name already exists.
- `list_secrets` — list saved secrets/variables **with their real values** so
  you can use them directly. Each is tagged sensitive or not.

## Rules

- **These tools exist so you have the values — don't ask the user for something
  you already have.** `list_secrets` returns the real values to you; the
  `sensitive` tag is just a hint about which ones not to paste into your chat
  reply to the user. There is no masking that hides a value from you.
- **Only save when the user asks.** Don't squirrel away values speculatively.
- **Don't paste a sensitive value into your user-facing reply** — refer to it by
  name ("using your `OPENAI_API_KEY`"). Using it in a tool call is fine.
- **Default to sensitive.** A key, token, or password is sensitive. Use
  `sensitive: false` only for plainly non-secret config (a base URL, a region).
- **Check before asking.** If a task needs a value, `list_secrets` (or your
  `<variables>` block) may already have it — don't ask the user to re-enter it.
- **Updating replaces the old value.** If the name already exists, `add_secret`
  overwrites it — confirm you have the right name so you don't clobber a real key.
- This is the right tool for secrets — do **not** hand-edit `config.json` with
  the filesystem tools to add a variable.
