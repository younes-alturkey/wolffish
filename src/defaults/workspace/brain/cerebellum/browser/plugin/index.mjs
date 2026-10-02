import { randomUUID } from 'node:crypto'
import { mkdir, rm } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import path from 'node:path'

const CREDENTIAL_TTL_MS = 60 * 60 * 1000
const DEFAULT_VIEWPORT = { width: 1280, height: 720 }
const MAX_OUTPUT = 100_000
const MAX_NETWORK_LOG = 200

let pw = null

async function loadPlaywright() {
  if (pw) return pw
  try {
    pw = await import('playwright-core')
    return pw
  } catch {
    return null
  }
}

// True when Playwright's own bundled build for this engine is present on disk.
async function bundledBrowserAvailable(bt) {
  try {
    const execPath = bt.executablePath()
    if (!execPath) return false
    const { access } = await import('node:fs/promises')
    await access(execPath)
    return true
  } catch {
    return false
  }
}

// Common install locations for a system Chrome / Edge / Chromium, per OS.
// Used as a fallback when Playwright couldn't download its own Chromium
// (e.g. on a brand-new Linux distro it doesn't recognize yet).
function systemChromiumCandidates() {
  if (process.platform === 'darwin') {
    return [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'
    ]
  }
  if (process.platform === 'win32') {
    const pf = process.env['PROGRAMFILES'] || 'C:\\Program Files'
    const pf86 = process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)'
    const local = process.env['LOCALAPPDATA'] || ''
    const list = [
      path.join(pf, 'Google\\Chrome\\Application\\chrome.exe'),
      path.join(pf86, 'Google\\Chrome\\Application\\chrome.exe'),
      path.join(pf, 'Microsoft\\Edge\\Application\\msedge.exe'),
      path.join(pf86, 'Microsoft\\Edge\\Application\\msedge.exe')
    ]
    if (local) list.unshift(path.join(local, 'Google\\Chrome\\Application\\chrome.exe'))
    return list
  }
  return [
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/snap/bin/chromium',
    '/usr/bin/microsoft-edge'
  ]
}

// Find the first system Chromium-family executable that exists on disk.
async function findSystemChromium() {
  const { access } = await import('node:fs/promises')
  for (const candidate of systemChromiumCandidates()) {
    if (!candidate) continue
    try {
      await access(candidate)
      return candidate
    } catch {
      // keep looking
    }
  }
  return null
}

// Launch a browser, preferring Playwright's bundled build but transparently
// falling back to a system-installed Chrome/Edge/Chromium when it's missing.
// Only chromium has a borrowable system equivalent; firefox/webkit must use
// the bundled build.
async function launchBrowser(bt, browserType, launchOpts) {
  if (await bundledBrowserAvailable(bt)) {
    return bt.launch(launchOpts)
  }

  if (browserType === 'chromium') {
    // 1. Let Playwright discover a system Chrome/Edge via its channel support
    //    (cross-platform, handles registry/app-bundle lookups for us).
    for (const channel of ['chrome', 'msedge', 'chromium']) {
      try {
        return await bt.launch({ ...launchOpts, channel })
      } catch {
        // try the next channel
      }
    }
    // 2. Fall back to an explicit executable we located on disk.
    const execPath = await findSystemChromium()
    if (execPath) {
      return bt.launch({ ...launchOpts, executablePath: execPath })
    }
    throw new Error(
      'No usable Chromium found. Playwright’s bundled build is not installed and no system ' +
        'Chrome / Edge / Chromium was detected. Install Google Chrome and try again, or run ' +
        '"npx playwright-core install chromium" if your OS is supported.'
    )
  }

  throw new Error(
    `${browserType} is not installed. Restart Wolffish so the capability can re-download it, ` +
      `or run "npx playwright-core install ${browserType}".`
  )
}

function resolveUserPath(p, workspaceRoot) {
  if (!p) return null
  if (p.startsWith('~')) return path.resolve(homedir(), p.slice(2))
  if (path.isAbsolute(p)) return path.resolve(p)
  return path.resolve(workspaceRoot || homedir(), p)
}

function htmlToMarkdown(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<\/div>/gi, '\n')
    .replace(/<\/h[1-6]>/gi, '\n\n')
    .replace(/<h1[^>]*>/gi, '# ')
    .replace(/<h2[^>]*>/gi, '## ')
    .replace(/<h3[^>]*>/gi, '### ')
    .replace(/<h4[^>]*>/gi, '#### ')
    .replace(/<h5[^>]*>/gi, '##### ')
    .replace(/<h6[^>]*>/gi, '###### ')
    .replace(/<li[^>]*>/gi, '- ')
    .replace(/<\/li>/gi, '\n')
    .replace(/<a[^>]+href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, '[$2]($1)')
    .replace(/<strong[^>]*>([\s\S]*?)<\/strong>/gi, '**$1**')
    .replace(/<b[^>]*>([\s\S]*?)<\/b>/gi, '**$1**')
    .replace(/<em[^>]*>([\s\S]*?)<\/em>/gi, '*$1*')
    .replace(/<i[^>]*>([\s\S]*?)<\/i>/gi, '*$1*')
    .replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, '`$1`')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

// ── Credential Store ──

const credentials = new Map()

function storeCredential(domain, username, password) {
  const id = randomUUID()
  const timer = setTimeout(() => {
    clearCredential(id)
  }, CREDENTIAL_TTL_MS)
  credentials.set(id, {
    domain,
    username,
    password,
    createdAt: Date.now(),
    timer
  })
  return id
}

function clearCredential(id) {
  const cred = credentials.get(id)
  if (!cred) return false
  clearTimeout(cred.timer)
  cred.username = ''
  cred.password = ''
  cred.domain = ''
  credentials.delete(id)
  return true
}

function clearAllCredentials() {
  for (const [id] of credentials) {
    clearCredential(id)
  }
}

function getCredentialValue(id, fieldName) {
  const cred = credentials.get(id)
  if (!cred) return null
  if (fieldName === 'username') return cred.username
  if (fieldName === 'password') return cred.password
  return null
}

function redactCredentials(text) {
  if (!text || credentials.size === 0) return text
  let redacted = String(text)
  for (const [, cred] of credentials) {
    if (cred.password && cred.password.length > 0) {
      redacted = redacted.replaceAll(cred.password, '[REDACTED]')
    }
    if (cred.username && cred.username.length > 0) {
      redacted = redacted.replaceAll(cred.username, '[CREDENTIAL_USER]')
    }
  }
  return redacted
}

// ── Session Store ──

const sessions = new Map()

function getSession(sessionId) {
  return sessions.get(sessionId) || null
}

function getPage(session, tabId) {
  if (tabId && session.pages.has(tabId)) return session.pages.get(tabId)
  return session.pages.get(session.activeTab) || null
}

// ── Tool Implementations ──

async function browserLaunch(args, screenshotsDir) {
  const lib = await loadPlaywright()
  if (!lib) {
    return { success: false, error: 'playwright-core is not installed. The browser capability needs its npm dependencies — this should resolve automatically on next launch.' }
  }

  const browserType = args?.browser || 'chromium'
  const bt = lib[browserType] || lib.chromium

  let browser
  try {
    browser = await launchBrowser(bt, browserType, {
      headless: args?.headless === true
    })
  } catch (err) {
    return { success: false, error: err?.message ?? String(err) }
  }

  const context = await browser.newContext({
    viewport: {
      width: args?.viewport_width || DEFAULT_VIEWPORT.width,
      height: args?.viewport_height || DEFAULT_VIEWPORT.height
    },
    locale: args?.locale || undefined,
    timezoneId: args?.timezone || undefined,
    userAgent: args?.user_agent || undefined
  })

  const page = await context.newPage()
  const sessionId = randomUUID()
  const tabId = randomUUID()

  const networkLog = []
  page.on('response', (response) => {
    if (networkLog.length < MAX_NETWORK_LOG) {
      networkLog.push({
        url: response.url(),
        method: response.request().method(),
        status: response.status(),
        content_type: response.headers()['content-type'] || '',
        timestamp: Date.now()
      })
    }
  })

  sessions.set(sessionId, {
    browser,
    context,
    pages: new Map([[tabId, page]]),
    activeTab: tabId,
    networkLog,
    screenshotsDir
  })

  return {
    success: true,
    output: JSON.stringify({
      session_id: sessionId,
      tab_id: tabId,
      browser: browserType,
      headless: args?.headless === true,
      viewport: {
        width: args?.viewport_width || DEFAULT_VIEWPORT.width,
        height: args?.viewport_height || DEFAULT_VIEWPORT.height
      }
    })
  }
}

async function browserClose(args) {
  const session = getSession(args?.session_id)
  if (!session) return { success: false, error: `No session found: ${args?.session_id}` }

  try {
    await session.context.close()
    await session.browser.close()
  } catch { /* browser may already be closed */ }

  sessions.delete(args.session_id)

  if (args?.clear_credentials !== false) {
    clearAllCredentials()
  }

  return { success: true, output: 'Browser session closed.' }
}

async function browserNavigate(args) {
  const session = getSession(args?.session_id)
  if (!session) return { success: false, error: `No session found: ${args?.session_id}` }

  const page = getPage(session, args?.tab_id)
  if (!page) return { success: false, error: 'No active page in session.' }

  const waitUntil = args?.wait_until || 'domcontentloaded'
  const timeout = args?.timeout_ms || 0

  let response
  try {
    response = await page.goto(args.url, { waitUntil, timeout: timeout || undefined })
  } catch (err) {
    if (waitUntil === 'networkidle') {
      response = await page.goto(args.url, { waitUntil: 'domcontentloaded', timeout: timeout || undefined })
    } else {
      throw err
    }
  }
  return {
    success: true,
    output: JSON.stringify({
      url: page.url(),
      title: await page.title(),
      status: response?.status() ?? 0
    })
  }
}

async function browserScreenshot(args, screenshotsDir) {
  const session = getSession(args?.session_id)
  if (!session) return { success: false, error: `No session found: ${args?.session_id}` }

  const page = getPage(session, args?.tab_id)
  if (!page) return { success: false, error: 'No active page in session.' }

  const format = args?.format || 'png'
  const outputPath = args?.output_path
    ? resolveUserPath(args.output_path)
    : path.join(screenshotsDir, `${Date.now()}.${format}`)

  await mkdir(path.dirname(outputPath), { recursive: true })

  const opts = {
    path: outputPath,
    type: format,
    fullPage: args?.full_page === true
  }
  if (format === 'jpeg' && args?.quality != null) {
    opts.quality = args.quality
  }

  if (args?.selector) {
    const el = await page.locator(args.selector).first()
    await el.screenshot(opts)
  } else {
    await page.screenshot(opts)
  }

  let mediaUrl = null
  if (workspaceRoot && outputPath.startsWith(workspaceRoot)) {
    const rel = outputPath.slice(workspaceRoot.length).replace(/^\//, '')
    mediaUrl = `wolffish-media://${encodeURIComponent(rel)}`
  }

  const result = { path: outputPath, format }
  if (mediaUrl) result.media_url = mediaUrl

  return {
    success: true,
    output: JSON.stringify(result)
  }
}

async function browserPageContent(args) {
  const session = getSession(args?.session_id)
  if (!session) return { success: false, error: `No session found: ${args?.session_id}` }

  const page = getPage(session, args?.tab_id)
  if (!page) return { success: false, error: 'No active page in session.' }

  const format = args?.format || 'text'
  const selector = args?.selector || 'body'

  let content
  if (format === 'text') {
    content = await page.locator(selector).first().innerText()
  } else if (format === 'html') {
    content = await page.locator(selector).first().innerHTML()
  } else if (format === 'markdown') {
    const html = await page.locator(selector).first().innerHTML()
    content = htmlToMarkdown(html)
  }

  if (content && content.length > MAX_OUTPUT) {
    content = content.slice(0, MAX_OUTPUT) + `\n…[truncated ${content.length - MAX_OUTPUT} chars]`
  }

  return { success: true, output: content }
}

async function browserClick(args) {
  const session = getSession(args?.session_id)
  if (!session) return { success: false, error: `No session found: ${args?.session_id}` }

  const page = getPage(session, args?.tab_id)
  if (!page) return { success: false, error: 'No active page in session.' }

  // No Wolffish-imposed default — the run is LLM-led. Use the model's
  // timeout_ms when given, otherwise defer to Playwright's own default.
  const timeout = args?.timeout_ms || 0
  const locator = page.locator(args.selector).first()
  await locator.click({
    button: args?.button || 'left',
    clickCount: args?.click_count || 1,
    timeout: timeout || undefined
  })

  return { success: true, output: `Clicked: ${args.selector}` }
}

async function browserFill(args) {
  const session = getSession(args?.session_id)
  if (!session) return { success: false, error: `No session found: ${args?.session_id}` }

  const page = getPage(session, args?.tab_id)
  if (!page) return { success: false, error: 'No active page in session.' }

  let value = args?.value
  if (args?.credential_id) {
    value = getCredentialValue(args.credential_id, args.field_name)
    if (value === null) {
      return { success: false, error: `Credential not found or expired: ${args.credential_id}` }
    }
  }

  if (value == null) {
    return { success: false, error: 'Either value or credential_id+field_name is required.' }
  }

  const locator = page.locator(args.selector).first()
  await locator.fill(value)
  return { success: true, output: `Filled: ${args.selector}` }
}

async function browserSelect(args) {
  const session = getSession(args?.session_id)
  if (!session) return { success: false, error: `No session found: ${args?.session_id}` }

  const page = getPage(session, args?.tab_id)
  if (!page) return { success: false, error: 'No active page in session.' }

  const selectArgs = {}
  if (args?.value != null) selectArgs.value = args.value
  if (args?.label != null) selectArgs.label = args.label
  if (args?.index != null) selectArgs.index = args.index

  const locator = page.locator(args.selector).first()
  await locator.selectOption(selectArgs)
  return { success: true, output: `Selected option in: ${args.selector}` }
}

async function browserType(args) {
  const session = getSession(args?.session_id)
  if (!session) return { success: false, error: `No session found: ${args?.session_id}` }

  const page = getPage(session, args?.tab_id)
  if (!page) return { success: false, error: 'No active page in session.' }

  const locator = page.locator(args.selector).first()
  await locator.pressSequentially(args.text, { delay: args?.delay_ms || 50 })
  return { success: true, output: `Typed ${args.text.length} characters into: ${args.selector}` }
}

async function browserKeyboard(args) {
  const session = getSession(args?.session_id)
  if (!session) return { success: false, error: `No session found: ${args?.session_id}` }

  const page = getPage(session, args?.tab_id)
  if (!page) return { success: false, error: 'No active page in session.' }

  await page.keyboard.press(args.key)
  return { success: true, output: `Pressed: ${args.key}` }
}

async function browserHover(args) {
  const session = getSession(args?.session_id)
  if (!session) return { success: false, error: `No session found: ${args?.session_id}` }

  const page = getPage(session, args?.tab_id)
  if (!page) return { success: false, error: 'No active page in session.' }

  const locator = page.locator(args.selector).first()
  await locator.hover()
  return { success: true, output: `Hovered: ${args.selector}` }
}

async function browserScroll(args) {
  const session = getSession(args?.session_id)
  if (!session) return { success: false, error: `No session found: ${args?.session_id}` }

  const page = getPage(session, args?.tab_id)
  if (!page) return { success: false, error: 'No active page in session.' }

  const amount = args?.amount || 500
  const directionMap = { up: [0, -amount], down: [0, amount], left: [-amount, 0], right: [amount, 0] }
  const [dx, dy] = directionMap[args.direction] || [0, amount]

  if (args?.selector) {
    const locator = page.locator(args.selector).first()
    await locator.evaluate((el, { dx, dy }) => el.scrollBy(dx, dy), { dx, dy })
  } else {
    await page.mouse.wheel(dx, dy)
  }

  return { success: true, output: `Scrolled ${args.direction} by ${amount}px` }
}

async function browserFormFill(args) {
  const session = getSession(args?.session_id)
  if (!session) return { success: false, error: `No session found: ${args?.session_id}` }

  const page = getPage(session, args?.tab_id)
  if (!page) return { success: false, error: 'No active page in session.' }

  let fields
  try {
    fields = typeof args.fields === 'string' ? JSON.parse(args.fields) : args.fields
  } catch {
    return { success: false, error: 'fields must be valid JSON array.' }
  }

  if (!Array.isArray(fields)) {
    return { success: false, error: 'fields must be an array.' }
  }

  const results = []
  for (const field of fields) {
    const locator = page.locator(field.selector).first()
    const action = field.action || 'fill'

    let value = field.value
    if (field.credential_id) {
      value = getCredentialValue(field.credential_id, field.field_name)
      if (value === null) {
        results.push({ selector: field.selector, error: 'Credential not found or expired.' })
        continue
      }
    }

    if (action === 'fill') {
      await locator.fill(value || '')
    } else if (action === 'select') {
      await locator.selectOption(value || '')
    } else if (action === 'check') {
      await locator.check()
    } else if (action === 'uncheck') {
      await locator.uncheck()
    }

    results.push({ selector: field.selector, action, ok: true })
  }

  return { success: true, output: JSON.stringify({ filled: results.length, results }) }
}

async function browserExtractTable(args) {
  const session = getSession(args?.session_id)
  if (!session) return { success: false, error: `No session found: ${args?.session_id}` }

  const page = getPage(session, args?.tab_id)
  if (!page) return { success: false, error: 'No active page in session.' }

  const useHeaders = args?.headers !== false

  const data = await page.locator(args.selector).first().evaluate((table, useHeaders) => {
    const rows = Array.from(table.querySelectorAll('tr'))
    const result = []
    let headers = []

    for (let i = 0; i < rows.length; i++) {
      const cells = Array.from(rows[i].querySelectorAll('th, td'))
      const values = cells.map(c => c.textContent?.trim() || '')

      if (i === 0 && useHeaders) {
        headers = values
        continue
      }

      if (useHeaders && headers.length > 0) {
        const row = {}
        values.forEach((v, j) => { row[headers[j] || `col_${j}`] = v })
        result.push(row)
      } else {
        result.push(values)
      }
    }
    return result
  }, useHeaders)

  return { success: true, output: JSON.stringify(data) }
}

async function browserExtractLinks(args) {
  const session = getSession(args?.session_id)
  if (!session) return { success: false, error: `No session found: ${args?.session_id}` }

  const page = getPage(session, args?.tab_id)
  if (!page) return { success: false, error: 'No active page in session.' }

  const container = args?.selector || 'body'
  const links = await page.locator(container).first().evaluate((el) => {
    return Array.from(el.querySelectorAll('a[href]')).map(a => ({
      text: a.textContent?.trim() || '',
      href: a.href
    }))
  })

  let filtered = links
  if (args?.filter) {
    const re = new RegExp(args.filter)
    filtered = links.filter(l => re.test(l.href))
  }

  return { success: true, output: JSON.stringify(filtered) }
}

async function browserStoreCredential(args) {
  if (!args?.domain || !args?.username || !args?.password) {
    return { success: false, error: 'domain, username, and password are all required.' }
  }

  const id = storeCredential(args.domain, args.username, args.password)
  const expiresAt = new Date(Date.now() + CREDENTIAL_TTL_MS).toISOString()

  return {
    success: true,
    output: JSON.stringify({
      credential_id: id,
      domain: args.domain,
      expires_at: expiresAt,
      message: 'Credentials stored securely in memory. They will auto-expire in 60 minutes.'
    })
  }
}

async function browserClearCredentials(args) {
  if (args?.credential_id) {
    const cleared = clearCredential(args.credential_id)
    if (!cleared) return { success: false, error: `Credential not found: ${args.credential_id}` }
    return { success: true, output: 'Credential cleared.' }
  }

  const count = credentials.size
  clearAllCredentials()
  return { success: true, output: `Cleared ${count} credential(s).` }
}

async function browserListCredentials() {
  const list = []
  for (const [id, cred] of credentials) {
    list.push({
      credential_id: id,
      domain: cred.domain,
      username: cred.username,
      expires_at: new Date(cred.createdAt + CREDENTIAL_TTL_MS).toISOString()
    })
  }
  return { success: true, output: JSON.stringify(list) }
}

async function browserWait(args) {
  const session = getSession(args?.session_id)
  if (!session) return { success: false, error: `No session found: ${args?.session_id}` }

  const page = getPage(session, args?.tab_id)
  if (!page) return { success: false, error: 'No active page in session.' }

  const timeout = args?.timeout_ms || 0
  const type = args?.type

  if (type === 'selector') {
    if (!args?.selector) return { success: false, error: 'selector is required for type=selector.' }
    const state = args?.state || 'visible'
    await page.locator(args.selector).first().waitFor({ state, timeout: timeout || undefined })
    return { success: true, output: `Element ${args.selector} is ${state}.` }
  }

  if (type === 'navigation') {
    await page.waitForURL(args?.url_pattern ? new RegExp(args.url_pattern) : /.*/, { timeout: timeout || undefined })
    return { success: true, output: `Navigation complete. URL: ${page.url()}` }
  }

  if (type === 'timeout') {
    if (!timeout) return { success: false, error: 'timeout_ms is required for type=timeout' }
    await new Promise(r => setTimeout(r, timeout))
    return { success: true, output: `Waited ${timeout}ms.` }
  }

  if (type === 'network_idle') {
    await page.waitForLoadState('networkidle', { timeout: timeout || undefined })
    return { success: true, output: 'Network is idle.' }
  }

  return { success: false, error: `Unknown wait type: ${type}` }
}

async function browserEvaluate(args) {
  const session = getSession(args?.session_id)
  if (!session) return { success: false, error: `No session found: ${args?.session_id}` }

  const page = getPage(session, args?.tab_id)
  if (!page) return { success: false, error: 'No active page in session.' }

  const result = await page.evaluate(args.script)
  const output = JSON.stringify(result, null, 2)

  if (output && output.length > MAX_OUTPUT) {
    return { success: true, output: output.slice(0, MAX_OUTPUT) + '\n…[truncated]' }
  }

  return { success: true, output: output ?? 'undefined' }
}

async function browserDownload(args, workspaceRoot) {
  const session = getSession(args?.session_id)
  if (!session) return { success: false, error: `No session found: ${args?.session_id}` }

  const page = getPage(session, args?.tab_id)
  if (!page) return { success: false, error: 'No active page in session.' }

  const outputPath = resolveUserPath(args.output_path, workspaceRoot)
  if (!outputPath) return { success: false, error: 'output_path is required.' }

  await mkdir(path.dirname(outputPath), { recursive: true })

  const timeout = args?.timeout_ms || 60_000

  const downloadPromise = page.waitForEvent('download', { timeout })
  if (args?.trigger_selector) {
    await page.locator(args.trigger_selector).first().click()
  }
  const download = await downloadPromise
  await download.saveAs(outputPath)

  return {
    success: true,
    output: JSON.stringify({
      path: outputPath,
      suggestedFilename: download.suggestedFilename(),
      url: download.url()
    })
  }
}

async function browserCookies(args) {
  const session = getSession(args?.session_id)
  if (!session) return { success: false, error: `No session found: ${args?.session_id}` }

  const action = args?.action
  if (action === 'get') {
    const url = args?.domain ? `https://${args.domain}` : undefined
    const cookies = url ? await session.context.cookies(url) : await session.context.cookies()
    return { success: true, output: JSON.stringify(cookies) }
  }

  if (action === 'set') {
    let cookies
    try {
      cookies = typeof args.cookies === 'string' ? JSON.parse(args.cookies) : args.cookies
    } catch {
      return { success: false, error: 'cookies must be valid JSON array.' }
    }
    await session.context.addCookies(cookies)
    return { success: true, output: `Set ${cookies.length} cookie(s).` }
  }

  if (action === 'clear') {
    await session.context.clearCookies({ domain: args?.domain || undefined })
    return { success: true, output: 'Cookies cleared.' }
  }

  return { success: false, error: `Unknown action: ${action}` }
}

async function browserNetworkLog(args) {
  const session = getSession(args?.session_id)
  if (!session) return { success: false, error: `No session found: ${args?.session_id}` }

  let logs = session.networkLog || []
  if (args?.filter) {
    logs = logs.filter(l => l.url.includes(args.filter))
  }
  const limit = args?.limit || 50
  logs = logs.slice(-limit)

  return { success: true, output: JSON.stringify(logs) }
}

async function browserPdf(args, workspaceRoot) {
  const session = getSession(args?.session_id)
  if (!session) return { success: false, error: `No session found: ${args?.session_id}` }

  const page = getPage(session, args?.tab_id)
  if (!page) return { success: false, error: 'No active page in session.' }

  const outputPath = resolveUserPath(args.output_path, workspaceRoot)
  if (!outputPath) return { success: false, error: 'output_path is required.' }

  await mkdir(path.dirname(outputPath), { recursive: true })

  await page.pdf({
    path: outputPath,
    format: args?.format || 'A4',
    landscape: args?.landscape === true,
    printBackground: args?.print_background !== false
  })

  return { success: true, output: JSON.stringify({ path: outputPath }) }
}

async function browserMultiTab(args) {
  const session = getSession(args?.session_id)
  if (!session) return { success: false, error: `No session found: ${args?.session_id}` }

  const newPage = await session.context.newPage()
  const tabId = randomUUID()

  newPage.on('response', (response) => {
    if (session.networkLog.length < MAX_NETWORK_LOG) {
      session.networkLog.push({
        url: response.url(),
        method: response.request().method(),
        status: response.status(),
        content_type: response.headers()['content-type'] || '',
        timestamp: Date.now()
      })
    }
  })

  session.pages.set(tabId, newPage)
  session.activeTab = tabId

  if (args?.url) {
    await newPage.goto(args.url, { waitUntil: 'domcontentloaded' })
  }

  return {
    success: true,
    output: JSON.stringify({
      tab_id: tabId,
      url: newPage.url(),
      title: await newPage.title()
    })
  }
}

// ── Approval Descriptions ──

function describeAction(toolName, args) {
  switch (toolName) {
    case 'browser_launch':
      return {
        title: 'Launch browser',
        description: `Launch ${args?.browser || 'chromium'}${args?.headless ? ' (headless)' : ''}`,
        risk: args?.headless ? 'medium' : 'low'
      }
    case 'browser_close':
      return { title: 'Close browser', description: 'Close browser session and clean up', risk: 'low' }
    case 'browser_navigate':
      return {
        title: 'Navigate',
        description: `Go to ${args?.url || '(unknown)'}`,
        command: args?.url,
        risk: /login|signin|auth|bank|pay/i.test(args?.url || '') ? 'medium' : 'low'
      }
    case 'browser_screenshot':
      return { title: 'Screenshot', description: 'Capture page screenshot', risk: 'low' }
    case 'browser_page_content':
      return { title: 'Extract content', description: `Extract page content as ${args?.format || 'text'}`, risk: 'low' }
    case 'browser_click':
      return { title: 'Click element', description: `Click: ${args?.selector || '(unknown)'}`, risk: 'low' }
    case 'browser_fill':
      return {
        title: 'Fill field',
        description: args?.credential_id ? `Fill ${args?.selector} with stored credential` : `Fill: ${args?.selector}`,
        risk: args?.credential_id ? 'medium' : 'low'
      }
    case 'browser_select':
      return { title: 'Select option', description: `Select in: ${args?.selector}`, risk: 'low' }
    case 'browser_type':
      return { title: 'Type text', description: `Type into: ${args?.selector}`, risk: 'low' }
    case 'browser_keyboard':
      return { title: 'Keyboard', description: `Press: ${args?.key}`, risk: 'low' }
    case 'browser_hover':
      return { title: 'Hover', description: `Hover: ${args?.selector}`, risk: 'low' }
    case 'browser_scroll':
      return { title: 'Scroll', description: `Scroll ${args?.direction} ${args?.amount || 500}px`, risk: 'low' }
    case 'browser_form_fill':
      return { title: 'Fill form', description: 'Fill multiple form fields', risk: 'medium' }
    case 'browser_extract_table':
      return { title: 'Extract table', description: `Extract table: ${args?.selector}`, risk: 'low' }
    case 'browser_extract_links':
      return { title: 'Extract links', description: 'Extract page links', risk: 'low' }
    case 'browser_store_credential':
      return {
        title: 'Store credentials',
        description: `Store login for ${args?.domain} (user: ${args?.username})`,
        impact: 'Credentials stored in runtime memory only. Auto-expire in 60 minutes.',
        risk: 'medium'
      }
    case 'browser_clear_credentials':
      return { title: 'Clear credentials', description: 'Wipe stored credentials from memory', risk: 'low' }
    case 'browser_list_credentials':
      return { title: 'List credentials', description: 'List stored credential IDs (no passwords)', risk: 'low' }
    case 'browser_wait':
      return { title: 'Wait', description: `Wait for ${args?.type}: ${args?.selector || args?.url_pattern || ''}`, risk: 'low' }
    case 'browser_evaluate':
      return {
        title: 'Execute JavaScript',
        description: 'Run arbitrary JS in page context',
        command: args?.script?.slice(0, 200),
        impact: 'Executes JavaScript in the page. Can access page data, DOM, and cookies.',
        risk: 'high'
      }
    case 'browser_download':
      return {
        title: 'Download file',
        description: `Download to: ${args?.output_path}`,
        risk: 'medium'
      }
    case 'browser_cookies':
      return {
        title: `${args?.action} cookies`,
        description: `${args?.action} cookies${args?.domain ? ` for ${args.domain}` : ''}`,
        risk: args?.action === 'set' ? 'medium' : 'low'
      }
    case 'browser_network_log':
      return { title: 'Network log', description: 'Read recent network requests', risk: 'low' }
    case 'browser_pdf':
      return { title: 'Save as PDF', description: `Save page to: ${args?.output_path}`, risk: 'low' }
    case 'browser_multi_tab':
      return { title: 'Open tab', description: `Open new tab${args?.url ? ': ' + args.url : ''}`, risk: 'low' }
    default:
      return null
  }
}

// ── Tool Definitions (for plugin.tools) ──

const toolDefinitions = [
  {
    name: 'browser_launch',
    description: 'Launch a browser instance and return a session_id.',
    parameters: {
      type: 'object',
      properties: {
        headless: { type: 'boolean', description: 'Run without a visible window. Default false.' },
        browser: { type: 'string', enum: ['chromium', 'firefox', 'webkit'], description: 'Browser engine.' },
        viewport_width: { type: 'number', description: 'Viewport width in pixels. Default 1280.' },
        viewport_height: { type: 'number', description: 'Viewport height in pixels. Default 720.' },
        locale: { type: 'string', description: 'Browser locale (e.g. en-US).' },
        timezone: { type: 'string', description: 'Timezone ID (e.g. America/New_York).' },
        user_agent: { type: 'string', description: 'Custom User-Agent string.' }
      },
      required: []
    }
  },
  {
    name: 'browser_close',
    description: 'Close a browser session and clean up all resources.',
    parameters: {
      type: 'object',
      properties: {
        session_id: { type: 'string', description: 'Session to close.' },
        clear_credentials: { type: 'boolean', description: 'Also wipe stored credentials. Default true.' }
      },
      required: ['session_id']
    }
  },
  {
    name: 'browser_navigate',
    description: 'Navigate to a URL in the active tab.',
    parameters: {
      type: 'object',
      properties: {
        session_id: { type: 'string', description: 'Browser session.' },
        url: { type: 'string', description: 'URL to navigate to.' },
        wait_until: { type: 'string', enum: ['load', 'domcontentloaded', 'networkidle'], description: 'When to consider navigation done.' },
        timeout_ms: { type: 'number', description: 'Navigation timeout in ms. Default 30000.' },
        tab_id: { type: 'string', description: 'Target a specific tab.' }
      },
      required: ['session_id', 'url']
    }
  },
  {
    name: 'browser_screenshot',
    description: 'Take a screenshot of the current page or a specific element.',
    parameters: {
      type: 'object',
      properties: {
        session_id: { type: 'string', description: 'Browser session.' },
        output_path: { type: 'string', description: 'Where to save. Default auto-generated.' },
        full_page: { type: 'boolean', description: 'Capture full scrollable page.' },
        selector: { type: 'string', description: 'Selector to screenshot a specific element.' },
        format: { type: 'string', enum: ['png', 'jpeg'], description: 'Image format.' },
        quality: { type: 'number', description: 'JPEG quality 0-100.' }
      },
      required: ['session_id']
    }
  },
  {
    name: 'browser_page_content',
    description: 'Extract text, HTML, or markdown content from the page.',
    parameters: {
      type: 'object',
      properties: {
        session_id: { type: 'string', description: 'Browser session.' },
        format: { type: 'string', enum: ['text', 'html', 'markdown'], description: 'Output format.' },
        selector: { type: 'string', description: 'Extract from this element only.' },
        tab_id: { type: 'string', description: 'Target tab.' }
      },
      required: ['session_id', 'format']
    }
  },
  {
    name: 'browser_click',
    description: 'Click an element. Supports CSS, XPath, text=, role= selectors.',
    parameters: {
      type: 'object',
      properties: {
        session_id: { type: 'string', description: 'Browser session.' },
        selector: { type: 'string', description: 'Element selector.' },
        button: { type: 'string', enum: ['left', 'right', 'middle'], description: 'Mouse button.' },
        click_count: { type: 'number', description: 'Number of clicks. Default 1.' },
        timeout_ms: { type: 'number', description: 'Timeout for element in ms. Optional — defaults to the browser engine default when unset.' },
        tab_id: { type: 'string', description: 'Target tab.' }
      },
      required: ['session_id', 'selector']
    }
  },
  {
    name: 'browser_fill',
    description: 'Fill a form field. Use credential_id for secure credential entry.',
    parameters: {
      type: 'object',
      properties: {
        session_id: { type: 'string', description: 'Browser session.' },
        selector: { type: 'string', description: 'Input element selector.' },
        value: { type: 'string', description: 'Text to fill. Omit if using credential_id.' },
        credential_id: { type: 'string', description: 'Credential UUID for secure entry.' },
        field_name: { type: 'string', enum: ['username', 'password'], description: 'Credential field to use.' },
        tab_id: { type: 'string', description: 'Target tab.' }
      },
      required: ['session_id', 'selector']
    }
  },
  {
    name: 'browser_select',
    description: 'Select an option from a dropdown.',
    parameters: {
      type: 'object',
      properties: {
        session_id: { type: 'string', description: 'Browser session.' },
        selector: { type: 'string', description: 'Select element selector.' },
        value: { type: 'string', description: 'Option value attribute.' },
        label: { type: 'string', description: 'Option visible text.' },
        index: { type: 'number', description: 'Option index (0-based).' },
        tab_id: { type: 'string', description: 'Target tab.' }
      },
      required: ['session_id', 'selector']
    }
  },
  {
    name: 'browser_type',
    description: 'Type text character by character with keystroke events.',
    parameters: {
      type: 'object',
      properties: {
        session_id: { type: 'string', description: 'Browser session.' },
        selector: { type: 'string', description: 'Target input element.' },
        text: { type: 'string', description: 'Text to type.' },
        delay_ms: { type: 'number', description: 'Delay between keystrokes. Default 50ms.' },
        tab_id: { type: 'string', description: 'Target tab.' }
      },
      required: ['session_id', 'selector', 'text']
    }
  },
  {
    name: 'browser_keyboard',
    description: 'Press a keyboard key or shortcut.',
    parameters: {
      type: 'object',
      properties: {
        session_id: { type: 'string', description: 'Browser session.' },
        key: { type: 'string', description: 'Key descriptor: Enter, Tab, Control+a, Meta+c.' },
        tab_id: { type: 'string', description: 'Target tab.' }
      },
      required: ['session_id', 'key']
    }
  },
  {
    name: 'browser_hover',
    description: 'Hover over an element.',
    parameters: {
      type: 'object',
      properties: {
        session_id: { type: 'string', description: 'Browser session.' },
        selector: { type: 'string', description: 'Element to hover.' },
        tab_id: { type: 'string', description: 'Target tab.' }
      },
      required: ['session_id', 'selector']
    }
  },
  {
    name: 'browser_scroll',
    description: 'Scroll the page or a specific element.',
    parameters: {
      type: 'object',
      properties: {
        session_id: { type: 'string', description: 'Browser session.' },
        direction: { type: 'string', enum: ['up', 'down', 'left', 'right'], description: 'Direction.' },
        amount: { type: 'number', description: 'Pixels. Default 500.' },
        selector: { type: 'string', description: 'Scroll within this element.' },
        tab_id: { type: 'string', description: 'Target tab.' }
      },
      required: ['session_id', 'direction']
    }
  },
  {
    name: 'browser_form_fill',
    description: 'Fill an entire form with multiple fields at once.',
    parameters: {
      type: 'object',
      properties: {
        session_id: { type: 'string', description: 'Browser session.' },
        fields: { type: 'string', description: 'JSON array of field objects.' },
        tab_id: { type: 'string', description: 'Target tab.' }
      },
      required: ['session_id', 'fields']
    }
  },
  {
    name: 'browser_extract_table',
    description: 'Extract an HTML table as structured JSON.',
    parameters: {
      type: 'object',
      properties: {
        session_id: { type: 'string', description: 'Browser session.' },
        selector: { type: 'string', description: 'Table element selector.' },
        headers: { type: 'boolean', description: 'First row is headers. Default true.' },
        tab_id: { type: 'string', description: 'Target tab.' }
      },
      required: ['session_id', 'selector']
    }
  },
  {
    name: 'browser_extract_links',
    description: 'Extract all links from the page or a section.',
    parameters: {
      type: 'object',
      properties: {
        session_id: { type: 'string', description: 'Browser session.' },
        selector: { type: 'string', description: 'Container element.' },
        filter: { type: 'string', description: 'Regex pattern to filter hrefs.' },
        tab_id: { type: 'string', description: 'Target tab.' }
      },
      required: ['session_id']
    }
  },
  {
    name: 'browser_store_credential',
    description: 'Securely store login credentials in runtime memory. Returns credential_id only.',
    parameters: {
      type: 'object',
      properties: {
        domain: { type: 'string', description: 'Website domain.' },
        username: { type: 'string', description: 'Username or email.' },
        password: { type: 'string', description: 'Password. Never written to disk.' }
      },
      required: ['domain', 'username', 'password']
    }
  },
  {
    name: 'browser_clear_credentials',
    description: 'Clear stored credentials from memory.',
    parameters: {
      type: 'object',
      properties: {
        credential_id: { type: 'string', description: 'Specific credential to clear. Omit to clear all.' }
      },
      required: []
    }
  },
  {
    name: 'browser_list_credentials',
    description: 'List stored credential IDs and metadata. Never includes passwords.',
    parameters: {
      type: 'object',
      properties: {},
      required: []
    }
  },
  {
    name: 'browser_wait',
    description: 'Wait for a condition on the page.',
    parameters: {
      type: 'object',
      properties: {
        session_id: { type: 'string', description: 'Browser session.' },
        type: { type: 'string', enum: ['selector', 'navigation', 'timeout', 'network_idle'], description: 'Wait type.' },
        selector: { type: 'string', description: 'Selector for type=selector.' },
        state: { type: 'string', enum: ['visible', 'hidden', 'attached', 'detached'], description: 'Selector state.' },
        timeout_ms: { type: 'number', description: 'Max wait time. Default 30000.' },
        url_pattern: { type: 'string', description: 'URL pattern for navigation waits.' },
        tab_id: { type: 'string', description: 'Target tab.' }
      },
      required: ['session_id', 'type']
    }
  },
  {
    name: 'browser_evaluate',
    description: 'Execute JavaScript in page context. Returns result as JSON. Requires user approval.',
    parameters: {
      type: 'object',
      properties: {
        session_id: { type: 'string', description: 'Browser session.' },
        script: { type: 'string', description: 'JavaScript code to execute.' },
        tab_id: { type: 'string', description: 'Target tab.' }
      },
      required: ['session_id', 'script']
    }
  },
  {
    name: 'browser_download',
    description: 'Trigger and capture a file download from the page.',
    parameters: {
      type: 'object',
      properties: {
        session_id: { type: 'string', description: 'Browser session.' },
        trigger_selector: { type: 'string', description: 'Element to click to start download.' },
        output_path: { type: 'string', description: 'Where to save the file.' },
        timeout_ms: { type: 'number', description: 'Download timeout. Default 60000.' },
        tab_id: { type: 'string', description: 'Target tab.' }
      },
      required: ['session_id', 'output_path']
    }
  },
  {
    name: 'browser_cookies',
    description: 'Read, set, or clear browser cookies.',
    parameters: {
      type: 'object',
      properties: {
        session_id: { type: 'string', description: 'Browser session.' },
        action: { type: 'string', enum: ['get', 'set', 'clear'], description: 'Cookie operation.' },
        cookies: { type: 'string', description: 'JSON array of cookie objects for set.' },
        domain: { type: 'string', description: 'Domain filter for get/clear.' }
      },
      required: ['session_id', 'action']
    }
  },
  {
    name: 'browser_network_log',
    description: 'Get recent network requests made by the page.',
    parameters: {
      type: 'object',
      properties: {
        session_id: { type: 'string', description: 'Browser session.' },
        filter: { type: 'string', description: 'URL pattern to filter.' },
        limit: { type: 'number', description: 'Max entries. Default 50.' }
      },
      required: ['session_id']
    }
  },
  {
    name: 'browser_pdf',
    description: 'Save the current page as a PDF file.',
    parameters: {
      type: 'object',
      properties: {
        session_id: { type: 'string', description: 'Browser session.' },
        output_path: { type: 'string', description: 'Where to save the PDF.' },
        format: { type: 'string', enum: ['A4', 'Letter', 'Legal'], description: 'Paper format.' },
        landscape: { type: 'boolean', description: 'Landscape orientation.' },
        print_background: { type: 'boolean', description: 'Include backgrounds. Default true.' }
      },
      required: ['session_id', 'output_path']
    }
  },
  {
    name: 'browser_multi_tab',
    description: 'Open a new tab in an existing browser session.',
    parameters: {
      type: 'object',
      properties: {
        session_id: { type: 'string', description: 'Browser session.' },
        url: { type: 'string', description: 'URL to open in new tab.' }
      },
      required: ['session_id']
    }
  }
]

// ── Plugin Export ──

let pluginDir = ''
let workspaceRoot = ''
let screenshotsDir = ''

const plugin = {
  name: 'browser',
  tools: toolDefinitions,
  describeAction,

  async init(context) {
    pluginDir = context.pluginDir
    workspaceRoot = context.workspaceRoot
    screenshotsDir = path.join(pluginDir, 'screenshots')
    await mkdir(screenshotsDir, { recursive: true })
  },

  async execute(toolName, args) {
    try {
      let result
      switch (toolName) {
        case 'browser_launch':
          result = await browserLaunch(args, screenshotsDir)
          break
        case 'browser_close':
          result = await browserClose(args)
          break
        case 'browser_navigate':
          result = await browserNavigate(args)
          break
        case 'browser_screenshot':
          result = await browserScreenshot(args, screenshotsDir)
          break
        case 'browser_page_content':
          result = await browserPageContent(args)
          break
        case 'browser_click':
          result = await browserClick(args)
          break
        case 'browser_fill':
          result = await browserFill(args)
          break
        case 'browser_select':
          result = await browserSelect(args)
          break
        case 'browser_type':
          result = await browserType(args)
          break
        case 'browser_keyboard':
          result = await browserKeyboard(args)
          break
        case 'browser_hover':
          result = await browserHover(args)
          break
        case 'browser_scroll':
          result = await browserScroll(args)
          break
        case 'browser_form_fill':
          result = await browserFormFill(args)
          break
        case 'browser_extract_table':
          result = await browserExtractTable(args)
          break
        case 'browser_extract_links':
          result = await browserExtractLinks(args)
          break
        case 'browser_store_credential':
          result = await browserStoreCredential(args)
          break
        case 'browser_clear_credentials':
          result = await browserClearCredentials(args)
          break
        case 'browser_list_credentials':
          result = await browserListCredentials()
          break
        case 'browser_wait':
          result = await browserWait(args)
          break
        case 'browser_evaluate':
          result = await browserEvaluate(args)
          break
        case 'browser_download':
          result = await browserDownload(args, workspaceRoot)
          break
        case 'browser_cookies':
          result = await browserCookies(args)
          break
        case 'browser_network_log':
          result = await browserNetworkLog(args)
          break
        case 'browser_pdf':
          result = await browserPdf(args, workspaceRoot)
          break
        case 'browser_multi_tab':
          result = await browserMultiTab(args)
          break
        default:
          result = { success: false, error: `browser: unknown tool ${toolName}` }
      }

      if (result.output) {
        result.output = redactCredentials(result.output)
      }
      if (result.error) {
        result.error = redactCredentials(result.error)
      }

      return result
    } catch (err) {
      const message = redactCredentials(err?.message || String(err))
      return { success: false, error: message }
    }
  },

  async destroy() {
    for (const [id, session] of sessions) {
      try {
        await session.context.close()
        await session.browser.close()
      } catch { /* ignore */ }
      sessions.delete(id)
    }
    clearAllCredentials()
  }
}

export default plugin
