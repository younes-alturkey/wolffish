import fs from 'node:fs/promises'
import path from 'node:path'

let pluginDir = ''
let workspaceRoot = ''
let cacheDir = ''

// Holds the markdown for the most recently generated image so that
// add_to_chat can inject it without the model needing to copy any URL.
let pendingContent = ''

// Network ceilings. External meme/GIF APIs are third-party and can stall; a
// stalled fetch would otherwise hang the tool call (and the turn) forever.
const API_TIMEOUT_MS = 12_000 // metadata calls (templates, search, caption)
const DOWNLOAD_TIMEOUT_MS = 20_000 // image / GIF downloads

async function readConfig() {
  try {
    const raw = await fs.readFile(path.join(workspaceRoot, 'config.json'), 'utf8')
    return JSON.parse(raw)
  } catch {
    return {}
  }
}

async function ensureCacheDir() {
  await fs.mkdir(cacheDir, { recursive: true })
}

// Imgflip template ids are always all-digits (e.g. "181913649"); memegen ids
// are slugs (e.g. "drake", "distracted-boyfriend", "2-buttons" — never purely
// numeric). So the id alone tells us which provider can render it.
function isImgflipId(id) {
  return /^\d+$/.test(id)
}

function encodeMemgenLine(text) {
  const encoded = String(text)
    .replace(/_/g, '__')
    .replace(/-/g, '--')
    .replace(/\?/g, '~q')
    .replace(/#/g, '~h')
    .replace(/"/g, "''")
    .replace(/%/g, '~p')
    .replace(/\//g, '~s')
    .replace(/\s/g, '_')
  // memegen needs a single "_" to hold a blank box; an empty segment collapses
  // the path and shifts the remaining captions into the wrong boxes.
  return encoded.length > 0 ? encoded : '_'
}

// Real timeout via AbortController so a hung API surfaces a clear "timed out"
// instead of blocking indefinitely. Mirrors the web-search plugin.
async function fetchWithTimeout(url, options = {}, timeoutMs = API_TIMEOUT_MS) {
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

async function downloadImage(url, filename) {
  await ensureCacheDir()
  const response = await fetchWithTimeout(url, {}, DOWNLOAD_TIMEOUT_MS)
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} downloading image`)
  }
  const buffer = Buffer.from(await response.arrayBuffer())
  const filePath = path.join(cacheDir, filename)
  await fs.writeFile(filePath, buffer)
  return filePath
}

async function memeGenerate(args) {
  const templateId = String(args?.template_id ?? '').trim()
  if (!templateId) {
    return {
      success: false,
      error:
        'template_id is required. Call meme_templates to find one (e.g. "drake" for memegen, or a numeric id for imgflip).'
    }
  }
  const lines = Array.isArray(args?.lines) ? args.lines.map((l) => String(l ?? '')) : []

  // Route by the id, not by the `provider` arg: the id uniquely determines its
  // provider, so a template id from meme_templates always renders even if the
  // caller passes the wrong provider (or none). This is the fix for the
  // "memegen id sent to imgflip → No template_id specified" failure.
  if (isImgflipId(templateId)) {
    return memeGenerateImgflip(templateId, lines)
  }
  return memeGenerateMemegen(templateId, lines)
}

async function memeGenerateMemegen(templateId, lines) {
  const captionLines = lines.length > 0 ? lines : ['', '']
  const linePath = captionLines.map(encodeMemgenLine).join('/')
  const url = `https://api.memegen.link/images/${templateId}/${linePath}.png`

  try {
    const filename = `${templateId}-${Date.now()}.png`
    const filePath = await downloadImage(url, filename)
    const relativePath = path.relative(workspaceRoot, filePath)
    const md = `![${templateId} meme](wolffish-media://${relativePath})`
    pendingContent = md
    return { success: true, output: md }
  } catch (err) {
    return { success: false, error: `Failed to generate meme: ${err?.message ?? err}` }
  }
}

async function memeGenerateImgflip(templateId, lines) {
  const config = await readConfig()
  const imgflip = config?.memes?.imgflip
  if (!imgflip?.username || !imgflip?.password) {
    return {
      success: false,
      error:
        'This is an Imgflip template (numeric id) but Imgflip credentials are not configured. Add them in Settings → Services → Memes, or use a memegen template (slug id like "drake") instead.'
    }
  }

  const body = new URLSearchParams({
    template_id: templateId,
    username: imgflip.username,
    password: imgflip.password
  })

  if (lines.length <= 2) {
    body.set('text0', lines[0] ?? '')
    body.set('text1', lines[1] ?? '')
  } else {
    lines.forEach((line, i) => {
      body.set(`boxes[${i}][text]`, line)
    })
  }

  try {
    const response = await fetchWithTimeout('https://api.imgflip.com/caption_image', {
      method: 'POST',
      body
    })
    if (!response.ok) {
      return { success: false, error: `Imgflip API returned HTTP ${response.status}` }
    }
    const json = await response.json()
    if (!json.success) {
      return { success: false, error: `Imgflip error: ${json.error_message ?? 'unknown'}` }
    }
    const imageUrl = json.data.url
    const filename = `imgflip-${templateId}-${Date.now()}.png`
    const filePath = await downloadImage(imageUrl, filename)
    const relativePath = path.relative(workspaceRoot, filePath)
    const md = `![${templateId} meme](wolffish-media://${relativePath})`
    pendingContent = md
    return { success: true, output: md }
  } catch (err) {
    return { success: false, error: `Imgflip generation failed: ${err?.message ?? err}` }
  }
}

async function memeTemplates(args) {
  const provider = String(args?.provider ?? 'memegen')
  const query = args?.query ? String(args.query).toLowerCase().trim() : null

  try {
    if (provider === 'imgflip') {
      const response = await fetchWithTimeout('https://api.imgflip.com/get_memes')
      if (!response.ok) {
        return { success: false, error: `Imgflip API returned HTTP ${response.status}` }
      }
      const json = await response.json()
      let memes = json.data?.memes ?? []
      if (query) {
        memes = memes.filter((m) => m.name.toLowerCase().includes(query))
      }
      const list = memes.slice(0, 50).map((m) => ({
        id: String(m.id),
        name: m.name,
        box_count: m.box_count,
        provider: 'imgflip'
      }))
      if (list.length === 0) {
        // Imgflip only exposes its ~100 most popular templates and has no real
        // search — tell the model rather than returning a bare [] it'll misread
        // as "no such meme exists".
        return {
          success: true,
          output: JSON.stringify({
            templates: [],
            note: query
              ? `No Imgflip template name matches "${query}". Imgflip only lists its ~100 most popular templates. For a much larger, searchable library call meme_templates again WITHOUT a provider (memegen).`
              : 'No Imgflip templates returned.'
          })
        }
      }
      return { success: true, output: JSON.stringify({ templates: list }) }
    }

    const response = await fetchWithTimeout('https://api.memegen.link/templates/')
    if (!response.ok) {
      return { success: false, error: `memegen API returned HTTP ${response.status}` }
    }
    const templates = await response.json()
    let list = templates.map((t) => ({
      id: t.id,
      name: t.name,
      box_count: t.lines ?? 2,
      provider: 'memegen'
    }))
    if (query) {
      list = list.filter((t) => t.name.toLowerCase().includes(query))
    }
    return { success: true, output: JSON.stringify({ templates: list.slice(0, 50) }) }
  } catch (err) {
    return { success: false, error: `Failed to fetch templates: ${err?.message ?? err}` }
  }
}

// Download a batch of Giphy results into the meme cache and return inline
// markdown for each. Shared by gif_search and gif_trending.
async function downloadGifs(gifs) {
  const lines = []
  for (const gif of gifs) {
    const gifUrl = gif.images?.downsized?.url ?? gif.images?.original?.url
    if (!gifUrl) continue
    const filename = `gif-${gif.id}-${Date.now()}.gif`
    try {
      const filePath = await downloadImage(gifUrl, filename)
      const relativePath = path.relative(workspaceRoot, filePath)
      lines.push(`![${gif.title || 'gif'}](wolffish-media://${relativePath})`)
    } catch {
      // skip this gif if download fails
    }
  }
  return lines
}

function clampLimit(value, fallback) {
  const n = Number(value)
  if (!Number.isFinite(n) || n <= 0) return fallback
  return Math.min(Math.floor(n), 25)
}

async function gifSearch(args) {
  const query = String(args?.query ?? '').trim()
  if (!query) return { success: false, error: 'query is required for gif_search' }
  const limit = clampLimit(args?.limit, 3)

  const config = await readConfig()
  const apiKey = config?.memes?.giphy?.apiKey
  if (!apiKey) {
    return {
      success: false,
      error: 'Giphy API key not configured. Go to Settings → Services → Memes to set it up.'
    }
  }

  try {
    const url = `https://api.giphy.com/v1/gifs/search?api_key=${encodeURIComponent(apiKey)}&q=${encodeURIComponent(query)}&limit=${limit}&rating=pg-13`
    const response = await fetchWithTimeout(url)
    if (!response.ok) {
      return { success: false, error: `Giphy API returned HTTP ${response.status}` }
    }
    const json = await response.json()
    const lines = await downloadGifs(json.data ?? [])
    if (lines.length === 0) {
      return { success: false, error: `No GIFs found for "${query}"` }
    }
    const md = lines.join('\n')
    pendingContent = md
    return { success: true, output: md }
  } catch (err) {
    return { success: false, error: `Giphy search failed: ${err?.message ?? err}` }
  }
}

async function gifTrending(args) {
  const limit = clampLimit(args?.limit, 5)

  const config = await readConfig()
  const apiKey = config?.memes?.giphy?.apiKey
  if (!apiKey) {
    return {
      success: false,
      error: 'Giphy API key not configured. Go to Settings → Services → Memes to set it up.'
    }
  }

  try {
    const url = `https://api.giphy.com/v1/gifs/trending?api_key=${encodeURIComponent(apiKey)}&limit=${limit}&rating=pg-13`
    const response = await fetchWithTimeout(url)
    if (!response.ok) {
      return { success: false, error: `Giphy API returned HTTP ${response.status}` }
    }
    const json = await response.json()
    const lines = await downloadGifs(json.data ?? [])
    if (lines.length === 0) {
      return { success: false, error: 'No trending GIFs available' }
    }
    const md = lines.join('\n')
    pendingContent = md
    return { success: true, output: md }
  } catch (err) {
    return { success: false, error: `Giphy trending failed: ${err?.message ?? err}` }
  }
}

function addToChat() {
  const content = pendingContent
  pendingContent = ''
  if (!content)
    return { success: false, error: 'No image to add — call meme_generate or gif_search first' }
  return { success: true, output: content }
}

const toolDefinitions = [
  {
    name: 'add_to_chat',
    description:
      'Insert the most recently generated meme or GIF into the chat message so it renders inline. Call this after meme_generate, gif_search, or gif_trending when the image should appear in the CURRENT chat. (To send the image to someone on a channel instead, pass the wolffish-media:// path from the generate result to send_file / whatsapp_send_image — do not base64-encode it.)',
    parameters: {
      type: 'object',
      properties: {},
      required: []
    }
  },
  {
    name: 'meme_generate',
    description:
      'Generate a captioned meme image from a template. Pass the template_id exactly as returned by meme_templates — its id determines the provider automatically (numeric = Imgflip, slug like "drake" = memegen), so you do not need to pass provider. Returns a wolffish-media:// path to the saved image.',
    parameters: {
      type: 'object',
      properties: {
        template_id: {
          type: 'string',
          description:
            'Template id from meme_templates. A slug (e.g. "drake", "distracted-boyfriend") uses memegen; an all-numeric id uses Imgflip.'
        },
        lines: {
          type: 'array',
          items: { type: 'string' },
          description: 'Caption text for each box, top to bottom'
        },
        provider: {
          type: 'string',
          enum: ['memegen', 'imgflip'],
          description:
            'Optional and usually unnecessary — the provider is inferred from template_id. Only the id matters.'
        }
      },
      required: ['template_id', 'lines']
    }
  },
  {
    name: 'meme_templates',
    description:
      'List available meme templates, optionally filtered by name. Each result is tagged with its provider; pass the returned id straight to meme_generate. Default (no provider) queries memegen, which has a large searchable library; Imgflip only exposes ~100 popular templates.',
    parameters: {
      type: 'object',
      properties: {
        provider: {
          type: 'string',
          enum: ['memegen', 'imgflip'],
          description: 'Which API to query (default: memegen — larger, searchable)'
        },
        query: { type: 'string', description: 'Filter templates by name' }
      },
      required: []
    }
  },
  {
    name: 'gif_search',
    description: 'Search Giphy for a GIF by keyword. Requires a Giphy API key in config (Settings → Services → Memes).',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'What to search for' },
        limit: { type: 'number', description: 'Max results, 1-25 (default 3)' }
      },
      required: ['query']
    }
  },
  {
    name: 'gif_trending',
    description: 'Get trending GIFs from Giphy. Requires a Giphy API key in config (Settings → Services → Memes).',
    parameters: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Max results, 1-25 (default 5)' }
      },
      required: []
    }
  }
]

const plugin = {
  name: 'memes',
  tools: toolDefinitions,
  async init(context) {
    pluginDir = context.pluginDir
    workspaceRoot = context.workspaceRoot
    // Store generated media in uploads/memes/ so it persists alongside user
    // uploads, passes the upload:download security check, and survives
    // capability re-syncs (the capability plugin/ dir is force-overwritten
    // on each launch; uploads/ is never touched by the sync).
    cacheDir = path.join(workspaceRoot, 'uploads', 'memes')
    await ensureCacheDir()
  },
  async execute(toolName, args) {
    switch (toolName) {
      case 'add_to_chat':
        return addToChat()
      case 'meme_generate':
        return memeGenerate(args)
      case 'meme_templates':
        return memeTemplates(args)
      case 'gif_search':
        return gifSearch(args)
      case 'gif_trending':
        return gifTrending(args)
      default:
        return { success: false, error: `memes: unknown tool ${toolName}` }
    }
  }
}

export default plugin
