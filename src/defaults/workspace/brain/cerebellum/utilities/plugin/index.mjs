// Utilities — small, always-available helper tools that are too small to
// each warrant their own capability. Add new general-purpose tools here:
// register them in toolDefinitions, handle them in execute(), and (if they
// take a notable argument) describe them in describeAction().
//
// Tools:
//   - send_file: deliver a file to the user as a native attachment on
//     whatever channel they're on (in-app, WhatsApp, Telegram).
//   - show_path: push an openable location card for a folder/file on disk
//     into the in-app chat (folder → Open, file → Reveal in folder).
//   - wait: block this turn for as long as the model asks, behind a card
//     that says why and lets the user cut it short.

import { existsSync } from 'node:fs'
import { copyFile, mkdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'

// No size ceiling here on purpose. This tool is CHANNEL-BLIND — it emits a
// marker and the surface the user is actually on decides what to do with it —
// so a bot API's 50 MB upload limit does not belong at this layer: it made the
// in-app chat and the CLI, which upload nothing and read the file straight off
// local disk, refuse files they could have delivered instantly. Telegram and
// WhatsApp enforce their own limits at the point of upload (they stat before
// reading, and Telegram re-encodes oversized video), which is the only place
// the limit is real.

// Type buckets mirror the channel + renderer extractors so the
// `[wolffish-output: <path> (<type>)]` marker we emit is recognized and
// delivered everywhere. Anything not in these sets is delivered as a
// generic `(file)` (rendered as a file card / sent as a document).
// One suffix-based type rides above the buckets: `*.chart.json` → `(chart)`,
// the interactive chart-card spec (see the dataviz capability) — the in-app
// renderer draws it as a live chart; channels fall back to a document send.
const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.tiff', '.tif'])
const AUDIO_EXTS = new Set(['.mp3', '.wav', '.m4a', '.ogg', '.flac', '.aac', '.wma', '.opus'])
const VIDEO_EXTS = new Set(['.mp4', '.mov', '.avi', '.mkv', '.m4v', '.wmv', '.flv', '.webm'])
const DOCUMENT_EXTS = new Set(['.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.csv'])

function workspaceRoot() {
  return path.join(homedir(), '.wolffish', 'workspace')
}

function classify(ext) {
  if (IMAGE_EXTS.has(ext)) return 'image'
  if (AUDIO_EXTS.has(ext)) return 'audio'
  if (VIDEO_EXTS.has(ext)) return 'video'
  if (DOCUMENT_EXTS.has(ext)) return 'document'
  return 'file'
}

// Accept absolute, ~/-relative, and workspace-relative paths. Relative
// paths resolve against the workspace root — that's where the agent saves
// generated files (files/…, uploads/…).
function resolveInput(raw) {
  if (typeof raw !== 'string' || raw.trim().length === 0) return null
  const p = raw.trim()
  if (p === '~') return homedir()
  if (p.startsWith('~/') || p.startsWith('~\\')) return path.join(homedir(), p.slice(2))
  if (path.isAbsolute(p)) return p
  return path.resolve(workspaceRoot(), p)
}

// The in-app renderer can only read files inside the workspace. If the
// file lives elsewhere (~/Desktop, /tmp, …) copy it into workspace/files/
// so the in-app viewer can load it. Remote channels read the path directly
// either way. Mirrors the shell plugin's opened-file surfacing.
async function ensureInWorkspace(abs) {
  const wsRoot = workspaceRoot()
  if (abs === wsRoot || abs.startsWith(wsRoot + path.sep)) return abs

  const filesDir = path.join(wsRoot, 'files')
  await mkdir(filesDir, { recursive: true })

  const ext = path.extname(abs)
  const baseName = path.basename(abs)
  const stem = path.basename(baseName, ext)
  const srcSize = (await stat(abs)).size

  let destPath = path.join(filesDir, baseName)
  let suffix = 0
  while (existsSync(destPath)) {
    const destSize = await stat(destPath)
      .then((s) => s.size)
      .catch(() => -1)
    // Same name and size ⇒ already copied; reuse instead of piling up copies.
    if (destSize === srcSize) return destPath
    suffix++
    destPath = path.join(filesDir, `${stem}_${suffix}${ext}`)
  }
  await copyFile(abs, destPath)
  return destPath
}

async function sendFile(args) {
  const input = resolveInput(args?.file ?? args?.path)
  if (!input) return { success: false, error: 'file is required (path to the file to deliver)' }

  let st
  try {
    st = await stat(input)
  } catch {
    return { success: false, error: `file not found: ${input}` }
  }
  if (!st.isFile()) return { success: false, error: `not a file: ${input}` }
  if (st.size === 0) return { success: false, error: `file is empty: ${input}` }

  let markerPath = input
  try {
    markerPath = await ensureInWorkspace(input)
  } catch {
    // Copy failed — remote channels can still send the original absolute path.
  }

  // `.chart.json` outranks the extension buckets: the full suffix — not the
  // bare `.json` — is what routes a chart spec to the in-app chart card.
  const isChart = markerPath.toLowerCase().endsWith('.chart.json')
  const type = isChart ? 'chart' : classify(path.extname(markerPath).toLowerCase())
  // The marker is what every channel + the in-app renderer parse to deliver
  // the file. Emit it as the whole output so nothing leaks as stray text.
  return { success: true, output: `[wolffish-output: ${markerPath} (${type})]` }
}

async function showPath(args) {
  const input = resolveInput(args?.path ?? args?.file)
  if (!input) return { success: false, error: 'path is required (folder or file to show)' }
  let st
  try {
    st = await stat(input)
  } catch {
    return { success: false, error: `path not found: ${input}` }
  }
  // The marker is what the in-app renderer parses into the openable location
  // card (folder → Open, file → Reveal in folder). Emit it as the whole
  // output so nothing leaks as stray text. The type is captured at call time
  // so a card in a resumed conversation still knows what it pointed at after
  // the path is deleted (it renders disabled with an "unavailable" note).
  // Channels don't recognize it — nothing to open on WhatsApp/Telegram.
  return {
    success: true,
    output: `[wolffish-path: ${input} (${st.isDirectory() ? 'folder' : 'file'})]`
  }
}

// The blocking-wait host (PluginContext.wait), wired by main over the
// WaitManager singleton. Absent only in a runtime that never set it — the
// tool then says so instead of pretending to sleep.
let waitHost = null

// Accepts the duration in whichever unit the model reached for. `seconds` is
// the documented one; minutes/hours exist because an hour-long wait written
// as 3600 is easy to fat-finger by an order of magnitude, and a model that
// writes `hours: 1` should not be punished for it.
//
// Fields normally ADD, so a composite duration works: { hours: 1, minutes: 30 }
// is ninety minutes. The exception is the RESTATEMENT — every field filled in
// with the same duration in its own unit, e.g. { seconds: 240, minutes: 4 },
// which a live model produced on the very first desktop run and which naive
// addition silently doubled. When every non-zero field expresses the identical
// duration, that duration is the answer, counted once. Ambiguous only in the
// case where a model really does mean "4 minutes AND another 240 seconds",
// which nothing would ever write that way.
function resolveSeconds(args) {
  const pick = (v) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0)
  const parts = [pick(args?.seconds), pick(args?.minutes) * 60, pick(args?.hours) * 3600].filter(
    (n) => n > 0
  )
  if (parts.length === 0) return 0
  if (parts.every((n) => n === parts[0])) return parts[0]
  return parts.reduce((a, b) => a + b, 0)
}

function humanDuration(seconds) {
  if (seconds < 60) return `${Math.round(seconds)}s`
  if (seconds < 3600) {
    const m = Math.floor(seconds / 60)
    const s = Math.round(seconds % 60)
    return s ? `${m}m ${s}s` : `${m}m`
  }
  const h = Math.floor(seconds / 3600)
  const m = Math.round((seconds % 3600) / 60)
  return m ? `${h}h ${m}m` : `${h}h`
}

async function wait(args, signal) {
  if (!waitHost || typeof waitHost.start !== 'function') {
    return {
      success: false,
      error:
        'wait is unavailable in this runtime. Do the next step now, or schedule it with automation_create.'
    }
  }
  const seconds = resolveSeconds(args)
  if (seconds <= 0) {
    return {
      success: false,
      error:
        'How long? Pass a positive "seconds" (or "minutes" / "hours"). There is no maximum — ask for the wait the job actually needs.'
    }
  }
  const reason = typeof args?.reason === 'string' ? args.reason.trim() : ''
  if (!reason) {
    return {
      success: false,
      error:
        'reason is required — one line, in the user\'s words, saying what you are waiting for. It is the card\'s title, and an unexplained pause reads as a hang.'
    }
  }

  const result = await waitHost.start({ reason, seconds }, signal)
  if (!result.ok) return { success: false, error: result.error }

  const { status, waitedSeconds } = result.outcome
  const asked = humanDuration(seconds)
  const spent = humanDuration(waitedSeconds)
  if (status === 'elapsed') {
    return {
      success: true,
      output:
        `Waited ${asked}. Now do the one thing you were waiting to do — once, whether that is an action, ` +
        'a file or an answer. Finish any remaining tool call before you write your closing line, so you never ' +
        'report the outcome, keep working, and report it again.',
      meta: { label: `Waited ${asked}` }
    }
  }
  if (status === 'interrupted') {
    return {
      success: true,
      output:
        `The wait ended after ${spent} of ${asked} because the user sent a message — it follows this result and is their latest word. ` +
        'Do what it asks, or — if it only tells you to carry on — the one thing the wait was for. Never both, and never twice. ' +
        'Finish any remaining tool call before you write your closing line, so you never report the outcome, keep working, ' +
        'and report it again.',
      meta: { label: 'Wait interrupted' }
    }
  }
  return {
    success: false,
    error: `The run was stopped after ${spent} of ${asked}. Nothing was waited out.`
  }
}

function describeAction(toolName, args) {
  if (toolName === 'send_file') {
    const f = String(args?.file ?? args?.path ?? '').trim()
    return {
      title: 'Send file',
      description: f
        ? `Deliver ${path.basename(f)} to the conversation`
        : 'Deliver a file to the conversation',
      risk: 'low'
    }
  }
  if (toolName === 'wait') {
    const seconds = resolveSeconds(args)
    const reason = String(args?.reason ?? '').trim()
    return {
      title: 'Wait',
      description: seconds
        ? `Pause for ${humanDuration(seconds)}${reason ? ` — ${reason}` : ''}`
        : 'Pause before continuing',
      risk: 'low'
    }
  }
  if (toolName === 'show_path') {
    const p = String(args?.path ?? args?.file ?? '').trim()
    return {
      title: 'Show location',
      description: p
        ? `Show ${path.basename(p.replace(/[/\\]+$/, '')) || p} as an openable card`
        : 'Show a location as an openable card',
      risk: 'low'
    }
  }
  return null
}

const toolDefinitions = [
  {
    name: 'send_file',
    description:
      'Deliver a file to the user as a downloadable attachment in the current conversation (in-app chat, CLI, WhatsApp, or Telegram). Works for any file type. THE ONLY WAY a file reaches the user — no tool auto-delivers its output. In-app and CLI have no size limit; WhatsApp and Telegram enforce their own upload ceilings and say so if a file is too big to send there.',
    parameters: {
      type: 'object',
      properties: {
        file: {
          type: 'string',
          description:
            'Path to the file to deliver. Absolute, ~/-relative, or workspace-relative.'
        }
      },
      required: ['file']
    }
  },
  {
    name: 'show_path',
    description:
      'Push an openable location card for a folder or file on disk into the in-app chat: a folder gets an Open button (opens in the OS file manager), a file gets a Reveal button (opens its folder with the file selected). The path must exist. In-app desktop chat only — on WhatsApp/Telegram nothing renders, so name the path in prose there instead.',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Folder or file to show. Absolute, ~/-relative, or workspace-relative.'
        }
      },
      required: ['path']
    }
  },
  {
    name: 'wait',
    description:
      "Pause this turn for as long as you need, then carry on exactly where you left off. NO MAXIMUM — ten seconds or four hours, you decide; ask for the wait the job actually needs and never chop one long wait into a poll loop. While it runs the chat shows a card with your reason, a countdown to the moment you will wake, and a box the user can type into to end the wait early; anything they send from anywhere (that box, the composer, their phone, Telegram, WhatsApp) wakes you at once and arrives as their next message. USE IT whenever the next step is simply not possible yet and WILL be after some time has passed, and you intend to finish the job yourself in this same turn: a build, deploy, render, upload or scan you kicked off and must let run; a rate limit or cooldown to ride out; a page, inbox, feed or file you must re-check after a while; anything the user asked you to do 'in a bit', 'after N minutes', or 'once that finishes'. This is the ONLY way to pause and keep everything — the conversation, the files you opened, what you already worked out, the rest of your plan. PREFER IT over shell sleep commands (they show the user nothing and cannot be interrupted), over polling the same tool over and over, and over telling the user you will come back later. DO NOT use it to look busy, to pad a reply, or before an action you could take right now. TWO THINGS THIS IS NOT: (1) an action that must land AFTER your reply is sent — restarting or quitting something, anything that would cut off the message announcing it — use countdown_start; (2) a job for hours or days from now, or one you can hand over in writing — use automation_create with a one-time schedule (\"In (2h)\", \"Once (...)\"): it starts a fresh run later that begins with only what you wrote into its instruction, so spell that out self-contained (it can look up earlier runs and past conversations once it is running). Between those two: if what you would have to hand over is a whole working state you already have here, wait; if a paragraph covers it, schedule it and free this turn.",
    parameters: {
      type: 'object',
      properties: {
        reason: {
          type: 'string',
          description:
            "Why you are waiting, in one short line the user will read as the card's title — e.g. \"Letting the deploy finish\", \"Waiting out the API cooldown\", \"Giving the render 10 minutes\". Required: a pause with no explanation is indistinguishable from a hang."
        },
        seconds: {
          type: 'number',
          description:
            'How long to wait, in seconds. No maximum. Pass the duration in ONE unit — seconds, minutes or hours — never the same duration restated in two of them. Several DIFFERENT units add up, so use that only for a composite like hours 1 + minutes 30.'
        },
        minutes: {
          type: 'number',
          description:
            'How long to wait, in minutes, instead of seconds. Adds to hours for a composite duration.'
        },
        hours: {
          type: 'number',
          description:
            'How long to wait, in hours, instead of seconds. Adds to minutes for a composite duration.'
        }
      },
      required: ['reason']
    }
  }
]

const plugin = {
  name: 'utilities',
  tools: toolDefinitions,
  describeAction,
  async init(context) {
    waitHost = context?.wait ?? null
  },
  async execute(toolName, args, signal) {
    switch (toolName) {
      case 'send_file':
        return sendFile(args)
      case 'show_path':
        return showPath(args)
      case 'wait':
        return wait(args, signal)
      default:
        return { success: false, error: `utilities: unknown tool ${toolName}` }
    }
  }
}

export default plugin
