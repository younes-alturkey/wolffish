/**
 * Reading and writing ONE setting, and the four list-shaped flows that are not
 * settings at all: providers, the Brain, prompt variables, capabilities.
 *
 * Everything here goes through the same handlers the desktop panels call. The
 * browser (settings-browser.mjs) walks the page → card → row hierarchy; this
 * file is what it calls once a row or a flow is chosen, and what scripts call
 * directly by id.
 */
import { c, heading, icon, interactive, out, pad, question, table, wrapText } from '../lib/ui.mjs'

/**
 * Providers the app knows how to talk to, for the picker on a machine that has
 * none configured yet. Mirrors the CloudProviderId union in preload/index.ts;
 * a stale entry here costs a menu line, a missing one costs a dead end.
 */
const KNOWN_PROVIDERS = [
  'anthropic',
  'openai',
  'openrouter',
  'deepseek',
  'xai',
  'qwen',
  'kimi',
  'minimax',
  'mimo',
  'stepfun',
  'zai'
]

/** `provider:test`'s error kinds, said in words rather than in enum. */
const KEY_ERRORS = {
  invalid_key: 'the provider rejected that key',
  rate_limited: 'the provider is rate-limiting — try again in a moment',
  invalid_model: 'the key works but that model does not exist for it',
  network: 'could not reach the provider — check the network',
  generic: 'the provider refused the request'
}

/**
 * Names that mean "this is a credential". Matching on the NAME rather than
 * asking is deliberate: the desktop has a checkbox next to the field, and a
 * terminal prompt for every variable would be a question asked ten times to
 * catch the one that mattered.
 */
const SENSITIVE_NAME = /(key|token|secret|password|passwd|pwd|credential|auth)/i

/**
 * Enough of a credential to recognise WHICH one is installed, never enough to
 * use it — the same rule the daemon applies to setting cards (`maskSecret` in
 * channels/cli/ipc.ts), repeated here because `provider:list` hands this
 * process the raw key (the desktop panel needs it) and a terminal is
 * scrollback, tmux buffers and screen shares.
 */
function mask(value) {
  const text = String(value ?? '')
  if (text.length === 0) return 'not set'
  if (text.length < 5) return '•'.repeat(6)
  if (text.length <= 10) return `${text.slice(0, 2)}${'•'.repeat(6)}${text.slice(-2)}`
  return `${text.slice(0, 6)}${'•'.repeat(10)}${text.slice(-2)}`
}

export async function getSetting(client, id, { json } = {}) {
  const cards = await client.invoke('cli:describeSettings')
  const card = cards.find((entry) => entry.id === id)
  if (!card) {
    out(c.red(`unknown setting: ${id}`))
    suggest(cards, id)
    return 1
  }
  if (json) {
    out(JSON.stringify(card, null, 2))
    return 0
  }
  heading(card.label)
  if (card.description) out(wrapText(c.gray(card.description), 2))
  out()
  const rows = [
    ['id', card.id],
    ['value', card.display]
  ]
  if (card.actual) rows.push(['registered', card.actual])
  if (card.options?.length) rows.push(['options', card.options.map((o) => o.value).join(', ')])
  const keyWidth = Math.max(...rows.map(([k]) => k.length))
  for (const [key, value] of rows) out(`  ${c.gray(pad(key, keyWidth))}  ${value}`)
  out()
  return 0
}

export async function setSetting(client, id, value) {
  const result = await client.invoke('cli:setSetting', { id, value })
  if (!result?.ok) {
    out(`${icon.fail()} ${c.red(result?.error ?? 'failed')}`)
    if (String(result?.error ?? '').startsWith('unknown setting')) {
      const cards = await client.invoke('cli:describeSettings')
      suggest(cards, id)
    }
    return 1
  }
  // Read back rather than echoing the input: the handler may normalize, and a
  // setting whose OS registration failed must not report success.
  const cards = await client.invoke('cli:describeSettings')
  const card = cards.find((entry) => entry.id === id)
  out(`${icon.ok()} ${c.bold(card?.label ?? id)} ${c.gray('→')} ${c.cyan(card?.display ?? value)}`)
  if (card?.actual) out(c.gray(`  registered: ${card.actual}`))
  return 0
}

function suggest(cards, id) {
  const needle = String(id).toLowerCase()
  const close = cards
    .map((card) => card.id)
    .filter((candidate) => candidate.toLowerCase().includes(needle.split('.').pop() ?? needle))
    .slice(0, 6)
  if (close.length > 0) {
    out(c.gray('  did you mean:'))
    for (const candidate of close) out(`    ${candidate}`)
  } else {
    out(c.gray('  list them all with: wolffish settings list'))
  }
}

/**
 * Provider keys, entered without echo and never as an argv token. A key typed
 * as `wolffish settings set … sk-live-…` lands in the shell history file; this
 * path does not.
 */
export async function manageKeys(client, args) {
  const [sub, ...rest] = args
  if (!sub || sub === 'list') {
    const snapshot = await client.invoke('cli:describeSettings')
    const providers = await client.invoke('provider:list').catch(() => [])
    heading('Model providers')
    table(
      ['provider', 'model', 'key'],
      providers.map((p) => [
        p.id,
        p.model || c.gray('—'),
        p.apiKey ? c.gray(mask(p.apiKey)) : c.gray('not set')
      ])
    )
    // Already masked by the daemon before it reached this process — `value` on
    // a secret card IS the mask, never the credential.
    const secrets = snapshot.filter((card) => card.kind === 'secret')
    if (secrets.length > 0) {
      heading('Service keys')
      table(
        ['setting', 'value'],
        secrets.map((card) => [card.id, card.value ? c.gray(card.display) : c.gray('not set')])
      )
    }
    out()
    out(c.gray('  add or replace a key from this card, or: wolffish keys set <provider>'))
    return 0
  }

  // Reached from the settings browser, where the user has not typed a
  // provider name — pick one from what the app actually supports rather than
  // making them remember the id.
  if (sub === 'set-interactive') {
    const providers = await client.invoke('provider:list').catch(() => [])
    const snapshot = await client.invoke('cli:snapshot').catch(() => ({}))
    /**
     * On a machine with no provider yet, `provider:list` is empty — and an
     * empty picker that says "use the command you just used" is a dead end on
     * exactly the machine this flow exists for. Offer the catalogue instead.
     */
    const known = providers.length > 0 ? providers : KNOWN_PROVIDERS.map((id) => ({ id }))
    if (known.length === 0) {
      out(c.yellow('  no providers configured yet'))
      out(c.gray('  wolffish keys set <provider> — anthropic, openai, deepseek, xai, ...'))
      return 1
    }
    heading('Provider')
    known.forEach((p, i) => {
      const has = p.apiKey ? c.green('key set') : c.gray('no key')
      const isBrain = snapshot?.llm?.brainProvider === p.id && snapshot?.llm?.brainModel === p.model
      out(
        `   ${c.cyan(String(i + 1).padStart(2))}. ${String(p.id).padEnd(12)} ${has}` +
          (isBrain ? c.gray(' · current brain') : '')
      )
    })
    out()
    if (!interactive()) return 0
    const pick = (await question(`  ${c.dim(`1-${known.length}, blank cancels`)}: `)).trim()
    if (!pick) return 0
    const chosen = known[Number.parseInt(pick, 10) - 1]
    if (!chosen) {
      out(c.red('  no such provider'))
      return 1
    }
    return manageKeys(client, ['set', chosen.id])
  }

  if (sub === 'set') {
    const [provider, model] = rest
    if (!provider) {
      out(c.red('usage: wolffish keys set <provider> [model]'))
      return 2
    }
    // A key has to be TYPED. On a non-TTY with no session there is nobody to
    // type it, and the raw read would sit on a stdin that never reaches EOF —
    // a command that hangs a deploy script forever rather than failing it.
    if (!interactive()) {
      out(c.red('  a key has to be typed — run this from a terminal'))
      return 2
    }
    const apiKey = await question(`  ${c.bold(provider)} API key ${c.dim('(hidden)')}: `, {
      hidden: true
    })
    if (!apiKey.trim()) {
      out(c.yellow('  nothing entered — unchanged'))
      return 1
    }
    const existing = (await client.invoke('provider:list').catch(() => [])).find(
      (entry) => entry.id === provider
    )

    /**
     * TEST first, then save — the desktop panel's order, and the reason it
     * works where this did not.
     *
     * `provider:test` is what fetches the provider's model catalogue, and
     * `provider:save` stores whatever it is handed. Saving a bare key stored
     * `models: undefined`, so `wolffish brain <provider> <model>` had nothing
     * to offer and nothing to validate against: the key was accepted, the
     * provider looked configured, and the first real turn failed on a model
     * name the user had to guess. A wrong key also failed here rather than
     * silently, hours later, in a turn.
     */
    out(c.gray('  checking the key…'))
    const test = await client
      .invoke('provider:test', { id: provider, apiKey: apiKey.trim() })
      .catch((error) => ({ ok: false, kind: error?.message }))
    if (test?.ok === false) {
      out(
        `${icon.fail()} ${c.red(KEY_ERRORS[test.kind] ?? test.kind ?? 'the provider rejected it')}`
      )
      out(c.gray('  nothing was saved'))
      return 1
    }
    const models = Array.isArray(test?.models) ? test.models : []
    const result = await client.invoke('provider:save', {
      id: provider,
      model: model ?? existing?.model ?? models[0] ?? '',
      apiKey: apiKey.trim(),
      models: models.length ? models : undefined,
      reasoningModels: test?.reasoningModels
    })
    if (result?.ok === false) {
      out(`${icon.fail()} ${c.red(result.error ?? 'failed')}`)
      return 1
    }
    out(`${icon.ok()} saved key for ${c.bold(provider)}`)
    if (models.length) {
      out(c.gray(`  ${models.length} models available — wolffish brain ${provider} <model>`))
    }
    return 0
  }

  out(c.red(`unknown: wolffish keys ${sub}`))
  return 2
}

/**
 * Which model runs, and switching it.
 *
 * With arguments it is a one-liner for scripts. With none it PICKS, rather
 * than printing a table and a command to retype: it is reached from inside the
 * settings browser, where the user has already said "change the brain", and
 * answering that with homework is the friction this whole surface exists to
 * remove.
 */
export async function brain(client, args) {
  const providers = await client.invoke('provider:list').catch(() => [])

  if (args.length > 0) {
    const [providerId, model] = args
    if (!providerId || !model) {
      out(c.red('usage: wolffish brain <provider> <model>'))
      return 2
    }
    await client.invoke('provider:setBrain', { providerId, model })
    out(`${icon.ok()} brain is now ${c.bold(`${providerId}/${model}`)}`)
    return 0
  }

  heading('Brain')
  const connected = providers.filter((p) => Boolean(p.apiKey))
  if (connected.length === 0) {
    out(c.yellow('  no provider has a key yet'))
    out(c.gray('  add one from this card, or: wolffish keys set <provider>'))
    return 1
  }

  // Which one is actually the Brain lives in the config snapshot, not in
  // provider:list — the setting is a single choice across providers.
  const snapshot = await client.invoke('cli:snapshot').catch(() => ({}))
  const activeProvider = snapshot?.llm?.brainProvider ?? null
  const activeModel = snapshot?.llm?.brainModel ?? null

  // One row per provider+model the machine could actually run, so choosing is
  // a number rather than two names typed from memory.
  const choices = connected.flatMap((provider) => {
    const models = provider.models?.length
      ? provider.models
      : provider.model
        ? [provider.model]
        : []
    return models.map((model) => ({ provider: provider.id, model }))
  })

  if (!interactive() || choices.length === 0) {
    table(
      ['provider', 'model', 'active'],
      connected.map((p) => [
        p.id,
        p.model || c.gray('—'),
        activeProvider === p.id && activeModel === p.model ? c.green('●') : ''
      ])
    )
    out()
    out(c.gray('  wolffish brain <provider> <model>'))
    return 0
  }

  choices.forEach((choice, index) => {
    const current =
      choice.provider === activeProvider && choice.model === activeModel ? c.green(' ●') : ''
    out(
      `   ${c.cyan(String(index + 1).padStart(2))}. ${pad(choice.provider, 12)} ${choice.model}${current}`
    )
  })
  out()
  const answer = (await question(`  ${c.dim(`1-${choices.length}, blank keeps it`)}: `)).trim()
  if (!answer) return 0
  const chosen = choices[Number.parseInt(answer, 10) - 1]
  if (!chosen) {
    out(c.red('  no such option'))
    return 1
  }
  await client.invoke('provider:setBrain', { providerId: chosen.provider, model: chosen.model })
  // Read back: the setter normalises and the panels re-seed from the config,
  // so what holds is what the snapshot says, not what was asked for.
  const after = await client.invoke('cli:snapshot').catch(() => ({}))
  out(
    `${icon.ok()} brain is now ${c.bold(`${after?.llm?.brainProvider ?? chosen.provider}/${after?.llm?.brainModel ?? chosen.model}`)}`
  )
  return 0
}

/** `wolffish vars` — prompt variables, the one list the phone also edits. */
export async function variables(client, args) {
  const [sub, name, ...valueParts] = args
  const current = await client.invoke('variables:list').catch(() => [])
  if (!sub || sub === 'list') {
    heading('Variables')
    if (current.length === 0) {
      out(c.gray('  none'))
      return 0
    }
    table(
      ['name', 'value'],
      current.map((v) => [v.name, v.sensitive ? c.gray('•••••') : v.value])
    )
    return 0
  }
  if (sub === 'set') {
    if (!name) {
      out(c.red('usage: wolffish vars set <name> <value>'))
      return 2
    }
    const value = valueParts.join(' ')
    const next = current.filter((v) => v.name !== name)
    /**
     * A variable whose name reads like a credential is stored sensitive, so
     * `wolffish vars` masks it the way the desktop does. Every CLI-created
     * variable used to be `sensitive: false`, which meant a key put in from the
     * terminal printed in full on every later listing — the one surface where
     * the listing lands in scrollback.
     */
    const sensitive = SENSITIVE_NAME.test(name)
    next.push({ name, value, sensitive })
    if (sensitive) out(c.gray('  stored as a secret — it will be masked when listed'))
    await client.invoke('variables:save', next)
    out(`${icon.ok()} ${name}`)
    return 0
  }
  if (sub === 'rm' || sub === 'remove') {
    await client.invoke(
      'variables:save',
      current.filter((v) => v.name !== name)
    )
    out(`${icon.ok()} removed ${name}`)
    return 0
  }
  out(c.red(`unknown: wolffish vars ${sub}`))
  return 2
}

/** `wolffish capabilities` — the same list and toggles the panel shows. */
export async function capabilities(client, args) {
  const [sub, name] = args
  const list = await client.invoke('cerebellum:listCapabilities').catch(() => [])
  if (!sub || sub === 'list') {
    heading('Capabilities')
    table(
      ['name', 'tools', 'state', 'description'],
      list.map((cap) => [
        cap.name,
        String(cap.toolCount ?? 0),
        cap.core ? c.gray('core') : cap.enabled ? c.green('on') : c.gray('off'),
        String(cap.description ?? '').slice(0, 60)
      ])
    )
    out()
    out(c.gray('  wolffish capabilities on|off <name>'))
    return 0
  }
  if (sub === 'on' || sub === 'off') {
    if (!name) {
      out(c.red(`usage: wolffish capabilities ${sub} <name>`))
      return 2
    }
    try {
      await client.invoke('cerebellum:toggleCapability', name, sub === 'on')
    } catch (err) {
      out(`${icon.fail()} ${c.red(err.message)}`)
      return 1
    }
    // Read back: a locked core capability accepts the call and stays on, so
    // echoing the request would report a change that did not happen.
    const after = await client.invoke('cerebellum:listCapabilities').catch(() => [])
    const entry = after.find((cap) => cap.name === name)
    if (!entry) {
      out(`${icon.fail()} ${c.red(`unknown capability: ${name}`)}`)
      return 1
    }
    if (entry.enabled !== (sub === 'on')) {
      out(
        `${icon.warn()} ${c.yellow(`${name} is ${entry.enabled ? 'on' : 'off'}`)}` +
          (entry.core ? c.gray(' — core capabilities cannot be switched off') : '')
      )
      return 1
    }
    out(`${icon.ok()} ${name} ${sub}`)
    return 0
  }
  out(c.red(`unknown: wolffish capabilities ${sub}`))
  return 2
}
