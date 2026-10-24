import * as cheerio from 'cheerio'
import fs from 'node:fs/promises'
import path from 'node:path'

const DEFAULT_MAX_LENGTH = 15_000
const DEEPSEEK_FETCH_ENDPOINT = 'https://api.deepseek.com/v1/tools/fetch'

const ENGINES = ['direct', 'deepseek']
const DEFAULT_ORDER = ['direct', 'deepseek']

// Workspace root captured at init() so the live config is read on every
// fetch — a settings change applies to the next call without a restart.
let workspaceRoot = null

const BROWSER_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'

const PRIVATE_IP_RE =
  /^https?:\/\/(127\.\d+\.\d+\.\d+|localhost|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+|\[::1\]|.*\.local)(:\d+)?(\/|$)/i

const toolDefinitions = [
  {
    name: 'web_fetch',
    description:
      "Read one web page as text. Engines run in the user's order (default direct, then DeepSeek); pass `engine` to pick one, and it falls back down that order if the pick is off or fails. direct: a plain HTTP GET — instant and free, but it sees only what the server sends. deepseek: DeepSeek's Fetch API returns clean Markdown and gets through some sites that refuse or break a direct GET; slower and paid per page. Neither runs JavaScript, signs in, or clicks — paywalls, logins and bot checks need the browser-extension capability. Neither reaches localhost or private networks.",
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'The URL of the web page to fetch' },
        maxLength: {
          type: 'number',
          description: 'Maximum characters to return (default 15000)'
        },
        engine: {
          type: 'string',
          enum: ENGINES,
          description:
            "Optional. Which engine to try first. Omit to follow the user's order. Pick deepseek straight away for a page a direct fetch already failed on (403, empty, cookie wall)."
        },
        timeout: {
          type: 'number',
          description:
            'Optional. Seconds to wait before giving up on a slow or unresponsive page. Omit to wait indefinitely (no timeout).'
        }
      },
      required: ['url']
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

// Same normalization as workspace.ts getWebToolsConfig.
function normalizeOrder(stored) {
  const seen = new Set()
  if (Array.isArray(stored)) for (const e of stored) if (ENGINES.includes(e)) seen.add(e)
  for (const e of DEFAULT_ORDER) seen.add(e)
  return [...seen]
}

async function readSettings() {
  const cfg = await readConfig()
  const deepseekKey = String(cfg?.deepseekSearch?.apiKey ?? '').trim()
  const deepseekOn = cfg?.deepseekSearch?.fetchEnabled === true && deepseekKey.length > 0
  return {
    order: normalizeOrder(cfg?.webTools?.fetchOrder),
    deepseekKey: deepseekOn ? deepseekKey : null,
    usable: { direct: true, deepseek: deepseekOn }
  }
}

// Fetch with an OPTIONAL timeout — none unless the model asks for one.
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

// A failure the next engine cannot fix (a PDF, a video) stops the chain
// instead of spending a paid call on it.
class FinalError extends Error {}

const HEADING_PREFIX = { h1: '# ', h2: '## ', h3: '### ', h4: '#### ', h5: '##### ', h6: '###### ' }

function extractContent($) {
  $('script, style, nav, footer, header, aside, iframe, noscript, svg').remove()
  let root = $('article').first()
  if (!root.length) root = $('main').first()
  if (!root.length) root = $('body')

  const lines = []
  root.find('h1, h2, h3, h4, h5, h6, p, li, td, th, pre, code, blockquote').each((_, el) => {
    const tag = el.tagName?.toLowerCase()
    let text = $(el).text().trim()
    if (!text) return
    if (HEADING_PREFIX[tag]) text = HEADING_PREFIX[tag] + text
    else if (tag === 'li') text = `- ${text}`
    else if (tag === 'blockquote') text = `> ${text}`
    else if (tag === 'pre' || tag === 'code') text = `\`\`\`\n${text}\n\`\`\``
    lines.push(text)
  })
  return lines.join('\n\n')
}

async function fetchDirect(url, timeoutMs) {
  let response
  try {
    response = await fetchWithTimeout(
      url,
      {
        headers: {
          'User-Agent': BROWSER_UA,
          Accept: 'text/html,application/xhtml+xml,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.9'
        },
        redirect: 'follow'
      },
      timeoutMs
    )
  } catch (err) {
    if (err?.name === 'TimeoutError') throw err
    throw new Error(`fetch failed: ${err?.message ?? err}`)
  }

  if (!response.ok) throw new Error(`HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ''}`)

  const contentType = (response.headers.get('content-type') || '').toLowerCase()
  if (
    contentType.startsWith('image/') ||
    contentType.startsWith('audio/') ||
    contentType.startsWith('video/') ||
    contentType.startsWith('application/octet-stream') ||
    contentType.startsWith('application/zip') ||
    contentType.startsWith('application/pdf')
  ) {
    throw new FinalError(`Cannot read binary content (Content-Type: ${contentType})`)
  }

  let text
  try {
    const buffer = await response.arrayBuffer()
    const charsetMatch = contentType.match(/charset=([^\s;]+)/i)
    const charset = charsetMatch ? charsetMatch[1] : 'utf-8'
    text = new TextDecoder(charset).decode(buffer)
  } catch (err) {
    throw new Error(`failed to decode response: ${err?.message ?? err}`)
  }

  if (!contentType.includes('html')) {
    if (!text.trim()) throw new Error('page returned no readable content')
    return text
  }

  const content = extractContent(cheerio.load(text)).replace(/\n{3,}/g, '\n\n').trim()
  // An empty extraction is usually a JS-rendered shell — exactly the page a
  // DeepSeek fetch may still read, so it counts as a failure here.
  if (!content) throw new Error('page returned no readable content (likely rendered by JavaScript)')
  return content
}

// DeepSeek escapes nearly every punctuation mark (`\#`, `\.`, `\,`), which
// reads as noise to the model and to the page viewer. Unescaping ASCII
// punctuation turns `\\` back into `\` too, so literal backslashes survive.
function unescapeMarkdown(text) {
  return text.replace(/\\([!-/:-@[-`{-~])/g, '$1')
}

// DeepSeek Fetch — the shared Search & Fetch key (deepseekSearch.apiKey).
// Billed per page actually returned; failures are free.
async function fetchDeepSeek(apiKey, url, timeoutMs) {
  const res = await fetchWithTimeout(
    DEEPSEEK_FETCH_ENDPOINT,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        Accept: 'application/json'
      },
      body: JSON.stringify({ url })
    },
    timeoutMs
  )
  if (res.status === 401) throw new Error('invalid API key')
  if (res.status === 402) throw new Error('insufficient balance — top up at platform.deepseek.com')
  if (res.status === 403) throw new Error('rejected by DeepSeek\'s security policy')
  if (res.status === 404) throw new Error('could not read the page (unreachable, blocked, unsupported type, or no text)')
  if (res.status === 429) throw new Error('rate limited')
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const json = await res.json()
  const content = unescapeMarkdown(String(json?.content ?? '')).trim()
  if (!content) throw new Error('page returned no readable content')
  const title = unescapeMarkdown(String(json?.title ?? '')).trim()
  return title && !content.startsWith('#') ? `# ${title}\n\n${content}` : content
}

const ENGINE_LABEL = { direct: 'direct fetch', deepseek: 'DeepSeek Fetch' }

async function executeFetch(args) {
  const url = String(args?.url ?? '').trim()
  if (!url) return { success: false, error: 'empty URL' }

  if (!/^https?:\/\//i.test(url)) {
    return { success: false, error: 'URL must start with http:// or https://' }
  }
  // Also guards DeepSeek: sending an internal hostname to a third party leaks
  // it even though their fetcher could never reach it.
  if (PRIVATE_IP_RE.test(url)) {
    return { success: false, error: 'Blocked: cannot fetch private/local network addresses' }
  }

  const maxLength = Number(args?.maxLength) || DEFAULT_MAX_LENGTH
  const timeoutSec = Number(args?.timeout)
  const timeoutMs = Number.isFinite(timeoutSec) && timeoutSec > 0 ? timeoutSec * 1000 : undefined

  const requested = typeof args?.engine === 'string' ? args.engine.trim().toLowerCase() : ''
  const settings = await readSettings()
  const notes = []
  const chain = []
  if (requested) {
    if (!ENGINES.includes(requested)) {
      notes.push(`unknown engine "${requested}", used the user's order`)
    } else if (settings.usable[requested]) {
      chain.push(requested)
    } else {
      notes.push(
        'DeepSeek Fetch is not set up (it needs to be switched on with a key in Settings → Services → Web Fetch), so direct fetch was used'
      )
    }
  }
  for (const engine of settings.order) {
    if (settings.usable[engine] && !chain.includes(engine)) chain.push(engine)
  }

  const errors = []
  for (const engine of chain) {
    try {
      const content =
        engine === 'deepseek'
          ? await fetchDeepSeek(settings.deepseekKey, url, timeoutMs)
          : await fetchDirect(url, timeoutMs)
      const footer = []
      if (engine === 'deepseek') footer.push('read via DeepSeek Fetch')
      if (errors.length > 0) footer.push(`${errors.join('; ')}`)
      footer.push(...notes)
      const body = content.slice(0, maxLength)
      return {
        success: true,
        output: footer.length > 0 ? `${body}\n\n---\n[web_fetch: ${footer.join(' — ')}]` : body
      }
    } catch (err) {
      const message = `${ENGINE_LABEL[engine]} failed: ${err?.message ?? err}`
      if (err instanceof FinalError || err?.name === 'TimeoutError') {
        return { success: false, error: [...errors, message, ...notes].join('\n') }
      }
      errors.push(message)
    }
  }

  const hint = settings.usable.deepseek
    ? ''
    : '\nIf the page needs JavaScript, a login or a click, use the browser-extension capability.'
  return { success: false, error: `${[...errors, ...notes].join('\n')}${hint}` }
}

export default {
  name: 'web-fetch',
  tools: toolDefinitions,

  async init(context) {
    workspaceRoot = context?.workspaceRoot ?? null
  },

  describeAction(toolName, args) {
    if (toolName === 'web_fetch') {
      return {
        title: 'Fetch web page',
        description: `Read: ${args?.url ?? '(empty)'}`,
        risk: 'low'
      }
    }
    return null
  },

  async execute(toolName, args) {
    if (toolName === 'web_fetch') return executeFetch(args)
    return { success: false, error: `web-fetch: unknown tool ${toolName}` }
  }
}
