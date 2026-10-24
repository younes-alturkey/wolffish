import * as cheerio from 'cheerio'
import fs from 'node:fs/promises'
import path from 'node:path'

const DEFAULT_MAX_RESULTS = 5
const MAX_RESULTS = 20
// Page text riding along with a DeepSeek result (includeContent) is capped
// per result so a 20-result search cannot flood the context window.
const MAX_CONTENT_PER_RESULT = 4_000
const BRAVE_SEARCH_ENDPOINT = 'https://api.search.brave.com/res/v1/web/search'
const DEEPSEEK_SEARCH_ENDPOINT = 'https://api.deepseek.com/v1/tools/search'

const ENGINES = ['brave', 'deepseek', 'duckduckgo']
const DEFAULT_ORDER = ['brave', 'deepseek', 'duckduckgo']

const ENGINE_LABEL = { brave: 'Brave', deepseek: 'DeepSeek', duckduckgo: 'DuckDuckGo' }

// Workspace root captured at init() so we can read the live config on every
// search. Re-reading on each call (instead of caching) means settings changes
// take effect without restarting the app.
let workspaceRoot = null

// DDG rate-limit guard — enforce a minimum gap between consecutive scrapes.
const DDG_MIN_GAP_MS = 10_000
let lastDdgSearchAt = 0

function ddgThrottle() {
  const wait = DDG_MIN_GAP_MS - (Date.now() - lastDdgSearchAt)
  if (wait > 0) return new Promise((r) => setTimeout(r, wait))
}

// Real browser UA — DDG rate-limits requests with bot-looking UAs.
const BROWSER_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'

const toolDefinitions = [
  {
    name: 'web_search',
    description:
      "Search the web. Returns titles, snippets and URLs — never a page. Fast, and a query on Brave or DeepSeek spends the user's money, so use it to settle one fact or to find which URL to open. Engines run in the user's order (default Brave, then DeepSeek, then DuckDuckGo); pass `engine` to pick one, and it falls back down that order if the pick is off or fails. The result names the engine that answered. To actually read or work with a site, prefer the browser-extension capability.",
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description:
            'The search query. On DeepSeek it also takes operators: site:, -site:, "exact phrase", -term, lang:en, after:2026-01-01, before:2026.'
        },
        maxResults: {
          type: 'number',
          description: 'Maximum number of results to return (default 5, max 20)'
        },
        engine: {
          type: 'string',
          enum: ENGINES,
          description:
            'Optional. Which engine to try first. brave: broad general index, strong on English and Western news. deepseek: query operators, publication dates, authority scores, model-ready summaries and optional page text; strong on Chinese and other Asian sources. duckduckgo: free, no key, last resort — slow and easily rate-limited. Omit to follow the user\'s order.'
        },
        includeContent: {
          type: 'boolean',
          description:
            'Optional, DeepSeek only. Also return each result\'s page text (capped per result), which often saves a web_fetch. Ignored by other engines.'
        }
      },
      required: ['query']
    }
  }
]

async function readConfig() {
  if (!workspaceRoot) return null
  try {
    return JSON.parse(await fs.readFile(path.join(workspaceRoot, 'config.json'), 'utf8'))
  } catch {
    return null
  }
}

// Same normalization as workspace.ts getWebToolsConfig: the user's order for
// known engines, then any engine the stored list predates.
function normalizeOrder(stored) {
  const seen = new Set()
  if (Array.isArray(stored)) for (const e of stored) if (ENGINES.includes(e)) seen.add(e)
  for (const e of DEFAULT_ORDER) seen.add(e)
  return [...seen]
}

// Which engines can run right now, and in what order. An engine is usable
// when it is switched on and (for the paid ones) has a key.
async function readSettings() {
  const cfg = await readConfig()
  const braveKey = String(cfg?.brave?.apiKey ?? '').trim()
  const deepseekKey = String(cfg?.deepseekSearch?.apiKey ?? '').trim()
  return {
    order: normalizeOrder(cfg?.webTools?.searchOrder),
    keys: {
      brave: cfg?.brave?.enabled && braveKey ? braveKey : null,
      deepseek: cfg?.deepseekSearch?.searchEnabled === true && deepseekKey ? deepseekKey : null
    },
    usable: {
      brave: Boolean(cfg?.brave?.enabled && braveKey),
      deepseek: Boolean(cfg?.deepseekSearch?.searchEnabled === true && deepseekKey),
      duckduckgo: cfg?.webTools?.duckduckgoEnabled !== false
    }
  }
}

// Helpers

// DDG wraps outbound URLs in /l/?uddg=<encoded>. Unwrap them so callers get
// the real destination, not the redirector.
function unwrapDdgUrl(url) {
  if (!url) return url
  const m = url.match(/[?&]uddg=([^&]+)/)
  if (m) {
    try {
      return decodeURIComponent(m[1])
    } catch {
      return url
    }
  }
  if (url.startsWith('//')) return `https:${url}`
  return url
}

// Fetch with an OPTIONAL timeout. We never impose a timeout by default — the
// request runs to completion unless a caller explicitly passes `timeoutMs`
// (e.g. the web_fetch tool, when the model asks for one). This keeps timeouts
// a deliberate choice rather than a hard-coded limit.
async function fetchWithTimeout(url, options, timeoutMs) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return fetch(url, options)
  }
  const controller = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, timeoutMs)
  try {
    return await fetch(url, { ...options, signal: controller.signal })
  } catch (err) {
    // Distinguish our timeout abort from other fetch errors so callers can
    // surface a clear, classifiable message ("timed out") rather than the
    // opaque "This operation was aborted".
    if (timedOut) {
      const e = new Error(`Request timed out after ${Math.round(timeoutMs / 1000)}s`)
      e.name = 'TimeoutError'
      throw e
    }
    throw err
  } finally {
    clearTimeout(timer)
  }
}

// Search providers — both scrape DuckDuckGo via different endpoints. They are
// independent CDNs/hosts, so rate-limiting one rarely affects the other.

const PROVIDERS = [
  {
    name: 'duckduckgo-html',
    url: (q) => `https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}`,
    parse: ($, max) => {
      const results = []
      $('.result, .web-result').each((_, el) => {
        if (results.length >= max) return
        const $el = $(el)
        const $a = $el.find('.result__title a, h2 a').first()
        const title = $a.text().trim()
        const url = unwrapDdgUrl($a.attr('href') || '')
        const snippet = $el.find('.result__snippet').text().trim()
        if (title && /^https?:/i.test(url)) results.push({ title, snippet, url })
      })
      return results
    }
  },
  {
    name: 'duckduckgo-lite',
    url: (q) => `https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(q)}`,
    parse: ($, max) => {
      const results = []
      $('a.result-link').each((_, el) => {
        if (results.length >= max) return
        const $el = $(el)
        const title = $el.text().trim()
        const url = unwrapDdgUrl($el.attr('href') || '')
        const snippet = $el
          .closest('tr')
          .nextAll('tr')
          .find('.result-snippet')
          .first()
          .text()
          .trim()
        if (title && /^https?:/i.test(url)) results.push({ title, snippet, url })
      })
      return results
    }
  }
]

async function runProvider(provider, query, maxResults) {
  const res = await fetchWithTimeout(
    provider.url(query),
    {
      headers: {
        'User-Agent': BROWSER_UA,
        Accept: 'text/html,application/xhtml+xml',
        'Accept-Language': 'en-US,en;q=0.9'
      }
    },
  )
  if (!res.ok) throw new Error(`${provider.name} returned HTTP ${res.status}`)
  const html = await res.text()
  if (/anomaly|unusual traffic|rate limit/i.test(html)) {
    throw new Error(`${provider.name} rate-limited (anomaly detected)`)
  }
  return provider.parse(cheerio.load(html), maxResults)
}

// Brave Search — runs when the user switched it on and saved a key.
async function searchBrave(apiKey, query, maxResults) {
  const url = `${BRAVE_SEARCH_ENDPOINT}?q=${encodeURIComponent(query)}&count=${maxResults}`
  const res = await fetchWithTimeout(url, {
    headers: {
      Accept: 'application/json',
      'Accept-Encoding': 'gzip',
      'X-Subscription-Token': apiKey
    }
  })
  if (res.status === 401 || res.status === 403) throw new Error('invalid API key')
  if (res.status === 429) throw new Error('rate limited')
  if (res.status === 422) throw new Error('subscription expired')
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const json = await res.json()
  const raw = Array.isArray(json?.web?.results) ? json.web.results : []
  return raw
    .slice(0, maxResults)
    .map((r) => {
      const result = { title: r.title ?? '', snippet: r.description ?? '', url: r.url ?? '' }
      if (r.age) result.date = r.age
      return result
    })
    .filter((r) => r.title && /^https?:/i.test(r.url))
}

// DeepSeek Search — its own key (deepseekSearch.apiKey), not the model key.
// Billed per successful non-empty search; failures and empty results are free.
async function searchDeepSeek(apiKey, query, maxResults, includeContent) {
  const res = await fetchWithTimeout(DEEPSEEK_SEARCH_ENDPOINT, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      Accept: 'application/json'
    },
    body: JSON.stringify({
      query: query.slice(0, 128),
      count: maxResults,
      need_content: includeContent === true
    })
  })
  if (res.status === 401 || res.status === 403) throw new Error('invalid API key')
  if (res.status === 402) throw new Error('insufficient balance — top up at platform.deepseek.com')
  if (res.status === 429) throw new Error('rate limited')
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    const message = text.match(/"message"\s*:\s*"([^"]+)"/)?.[1]
    throw new Error(`HTTP ${res.status}${message ? `: ${message}` : ''}`)
  }
  const json = await res.json()
  const raw = Array.isArray(json?.results) ? json.results : []
  return raw
    .slice(0, maxResults)
    .map((r) => {
      const result = {
        title: r.title ?? '',
        url: r.url ?? '',
        snippet: r.snippet ?? '',
        summary: r.summary ?? ''
      }
      if (r.date) result.date = r.date
      if (r.site_name) result.site = r.site_name
      if (typeof r.authority === 'number' && r.authority >= 0) result.authority = r.authority
      if (typeof r.rerank_score === 'number') result.score = Math.round(r.rerank_score * 100) / 100
      if (includeContent && r.content) result.content = String(r.content).slice(0, MAX_CONTENT_PER_RESULT)
      return result
    })
    .filter((r) => r.title && /^https?:/i.test(r.url))
}

async function searchDuckDuckGo(query, maxResults) {
  const errors = []
  for (const p of PROVIDERS) {
    try {
      await ddgThrottle()
      const results = await runProvider(p, query, maxResults)
      lastDdgSearchAt = Date.now()
      return results
    } catch (err) {
      lastDdgSearchAt = Date.now()
      errors.push(`${p.name}: ${err?.message ?? err}`)
    }
  }
  throw new Error(errors.join('; '))
}

// Brave usage tracking — appends one line per successful query to the
// workspace usage directory so the Usage panel can show search cost.
async function recordBraveUsage(query) {
  if (!workspaceRoot) return
  const now = new Date()
  const yyyy = now.getFullYear()
  const mm = String(now.getMonth() + 1).padStart(2, '0')
  const dd = String(now.getDate()).padStart(2, '0')
  const hh = String(now.getHours()).padStart(2, '0')
  const mi = String(now.getMinutes()).padStart(2, '0')
  const ss = String(now.getSeconds()).padStart(2, '0')
  const date = `${yyyy}-${mm}-${dd}`
  const time = `${hh}:${mi}:${ss}`

  const dir = path.join(workspaceRoot, 'usage', 'providers')
  const filepath = path.join(dir, 'brave.md')

  const safe = query.replace(/[|\n\r]/g, ' ').slice(0, 120)
  const line = `- ${date} ${time} | web_search | ${safe}\n`

  try {
    await fs.mkdir(dir, { recursive: true })
  } catch { return }

  let existing = ''
  try { existing = await fs.readFile(filepath, 'utf8') } catch { existing = '' }

  const dateHeader = `## ${date}`
  if (!existing.includes(dateHeader)) {
    const body = existing.length === 0
      ? `# Brave Search\n\n${dateHeader}\n\n${line}`
      : `\n${dateHeader}\n\n${line}`
    try { await fs.appendFile(filepath, body, 'utf8') } catch { return }
  } else {
    try { await fs.appendFile(filepath, line, 'utf8') } catch { return }
  }
}

// Why an engine the model asked for was skipped — worded for the model, which
// relays it when the user asks why their pick was not used.
function unavailableReason(engine) {
  if (engine === 'duckduckgo') return 'DuckDuckGo is switched off in Settings → Services → Web Search'
  return `${ENGINE_LABEL[engine]} is not set up (it needs to be switched on with a key in Settings → Services → Web Search)`
}

// web_search

async function executeSearch(args) {
  const query = String(args?.query ?? '').trim()
  if (!query) return { success: false, error: 'empty search query' }

  const maxResults = Math.min(
    MAX_RESULTS,
    Math.max(1, Math.round(Number(args?.maxResults) || DEFAULT_MAX_RESULTS))
  )
  const requested = typeof args?.engine === 'string' ? args.engine.trim().toLowerCase() : ''
  const settings = await readSettings()

  const notes = []
  const chain = []
  if (requested) {
    if (!ENGINES.includes(requested)) {
      notes.push(`Unknown engine "${requested}" — used the user's order instead.`)
    } else if (settings.usable[requested]) {
      chain.push(requested)
    } else {
      notes.push(`${unavailableReason(requested)}, so the user's order was used instead.`)
    }
  }
  for (const engine of settings.order) {
    if (settings.usable[engine] && !chain.includes(engine)) chain.push(engine)
  }

  if (chain.length === 0) {
    return {
      success: false,
      error:
        'No search engine is available: Brave and DeepSeek are not set up and DuckDuckGo is switched off. The user can turn one on in Settings → Services → Web Search.'
    }
  }

  const errors = []
  for (const engine of chain) {
    try {
      let results
      if (engine === 'brave') {
        results = await searchBrave(settings.keys.brave, query, maxResults)
        void recordBraveUsage(query)
      } else if (engine === 'deepseek') {
        results = await searchDeepSeek(settings.keys.deepseek, query, maxResults, args?.includeContent)
      } else {
        results = await searchDuckDuckGo(query, maxResults)
      }
      const payload = { engine, results }
      if (errors.length > 0) payload.fallback = errors
      if (notes.length > 0) payload.notes = notes
      if (results.length === 0) {
        payload.message = 'No results found. Try a different or more specific query, or another engine.'
      }
      return { success: true, output: JSON.stringify(payload) }
    } catch (err) {
      errors.push(`${engine}: ${err?.message ?? err}`)
    }
  }

  return {
    success: false,
    error: `Every search engine failed.\n${errors.join('\n')}${notes.length ? `\n${notes.join('\n')}` : ''}\nTry a different query or wait 30 seconds before retrying.`
  }
}

// Plugin export

export default {
  name: 'web-search',
  tools: toolDefinitions,

  async init(context) {
    workspaceRoot = context?.workspaceRoot ?? null
  },

  describeAction(toolName, args) {
    if (toolName === 'web_search') {
      return {
        title: 'Web search',
        description: `Search for: ${args?.query ?? '(empty)'}`,
        risk: 'low'
      }
    }
    return null
  },

  async execute(toolName, args) {
    if (toolName === 'web_search') return executeSearch(args)
    return { success: false, error: `web-search: unknown tool ${toolName}` }
  }
}
