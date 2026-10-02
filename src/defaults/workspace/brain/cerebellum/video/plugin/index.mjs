/**
 * Video generation (MiniMax H3) — thin adapter over the main process's
 * VideoTaskManager, reached through the init context's `videoTasks` host
 * bridge. Everything heavy lives host-side in TypeScript: media validation
 * and sharp/ffmpeg optimization, task creation, the 10s poll loop, artifact
 * download into generations/video/conv-<id>/, and the live task-card
 * snapshot flow. This plugin only maps tool args onto the host surface and
 * formats results as model-facing text.
 *
 * The tool SCHEMAS the model sees come from ../SKILL.md frontmatter (the
 * source of truth for disk capabilities); the definitions below exist for
 * parity and must be kept in sync by hand.
 */
import path from 'node:path'

let videoTasks = null
let workspaceRoot = ''

const NOT_WIRED =
  'video: the task host is not wired (app still starting?). Try again in a moment.'

function absoluteOutputPath(snapshot) {
  if (!snapshot.outputPath) return null
  return path.isAbsolute(snapshot.outputPath)
    ? snapshot.outputPath
    : path.join(workspaceRoot, snapshot.outputPath)
}

function mb(bytes) {
  return (bytes / 1024 / 1024).toFixed(1)
}

function describe(snapshot) {
  const v = snapshot.video
  const facts = v
    ? ` (${v.resolution} · ${v.durationSeconds}s${v.ratio ? ` · ${v.ratio}` : ''} · ${v.inputSummary})`
    : ''
  return `${snapshot.taskId} "${snapshot.title}"${facts}`
}

function statusLine(snapshot) {
  const abs = absoluteOutputPath(snapshot)
  const base = `${describe(snapshot)}: ${snapshot.status}`
  if (snapshot.status === 'succeeded' && abs) {
    return `${base} — saved to ${abs}${snapshot.outputBytes ? ` (${mb(snapshot.outputBytes)} MB)` : ''}`
  }
  if (snapshot.status === 'failed') return `${base} — ${snapshot.error ?? 'unknown error'}`
  return base
}

async function check() {
  if (!videoTasks) return { success: false, error: NOT_WIRED }
  const result = await videoTasks.check()
  if (!result.configured || !result.reachable) {
    return { success: false, error: result.detail }
  }
  return { success: true, output: result.detail }
}

async function generate(args) {
  if (!videoTasks) return { success: false, error: NOT_WIRED }
  const result = await videoTasks.submit({
    prompt: typeof args.prompt === 'string' ? args.prompt : '',
    title: typeof args.title === 'string' ? args.title : undefined,
    durationSeconds:
      typeof args.duration_seconds === 'number' ? args.duration_seconds : undefined,
    resolution: typeof args.resolution === 'string' ? args.resolution : undefined,
    ratio: typeof args.ratio === 'string' ? args.ratio : undefined,
    firstFrame: typeof args.first_frame === 'string' ? args.first_frame : undefined,
    lastFrame: typeof args.last_frame === 'string' ? args.last_frame : undefined,
    referenceImages: toStringArray(args.reference_images),
    referenceVideos: toStringArray(args.reference_videos),
    referenceAudios: toStringArray(args.reference_audios)
  })
  if (!result.ok) return { success: false, error: `video_generate: ${result.error}` }
  const lines = [
    `Video task created: ${describe(result.snapshot)}`,
    `Task card is live in chat and updates itself — do not narrate its contents.`
  ]
  if (result.notes.length > 0) {
    lines.push(`Media adjustments: ${result.notes.join('; ')}`)
  }
  const mins = Math.max(1, Math.round(result.snapshot.estimateSeconds / 60))
  lines.push(
    `Next: call video_await now to collect the result (typically ~${mins}–${mins + 2} min).`
  )
  return { success: true, output: lines.join('\n') }
}

async function awaitTask(args, signal) {
  if (!videoTasks) return { success: false, error: NOT_WIRED }
  let taskId = typeof args.task_id === 'string' && args.task_id.trim() ? args.task_id.trim() : null
  if (!taskId) {
    const all = videoTasks.list()
    if (all.length === 0) {
      return { success: false, error: 'video_await: no video tasks in this conversation.' }
    }
    taskId = all[all.length - 1].taskId
  }
  if (!videoTasks.get(taskId)) {
    return { success: false, error: `video_await: unknown task ${taskId}` }
  }
  const snapshot = await videoTasks.awaitTask(taskId, signal)
  if (!snapshot) {
    return {
      success: true,
      output:
        `Wait for ${taskId} was interrupted; the task keeps running server-side. ` +
        `Its card stays live and the video will be saved automatically when it lands.`
    }
  }
  if (snapshot.status === 'succeeded') {
    const abs = absoluteOutputPath(snapshot)
    const took = snapshot.endedAt
      ? Math.round((snapshot.endedAt - snapshot.createdAt) / 1000)
      : null
    return {
      success: true,
      output:
        `Video task ${describe(snapshot)} SUCCEEDED${took ? ` in ${took}s` : ''}.\n` +
        `Saved: ${abs}${snapshot.outputBytes ? ` (${mb(snapshot.outputBytes)} MB)` : ''}\n` +
        `The in-app card already shows the video. Deliver the file now: in-app send_file with that path; ` +
        `Telegram telegram_send_video; WhatsApp whatsapp_send_video (they compress oversized videos and keep the original in the app).`
    }
  }
  if (snapshot.status === 'cancelled') {
    return { success: true, output: `Video task ${describe(snapshot)} was cancelled.` }
  }
  return {
    success: false,
    error:
      `Video task ${describe(snapshot)} FAILED: ${snapshot.error ?? 'unknown error'}. ` +
      `Fix the inputs before retrying — the same request will fail the same way.`
  }
}

async function status(args) {
  if (!videoTasks) return { success: false, error: NOT_WIRED }
  const taskId = typeof args.task_id === 'string' && args.task_id.trim() ? args.task_id.trim() : null
  if (taskId) {
    const snap = videoTasks.get(taskId)
    if (!snap) return { success: false, error: `video_status: unknown task ${taskId}` }
    return { success: true, output: statusLine(snap) }
  }
  const all = videoTasks.list()
  if (all.length === 0) {
    return { success: true, output: 'No video tasks in this conversation.' }
  }
  return { success: true, output: all.map(statusLine).join('\n') }
}

async function cancel(args) {
  if (!videoTasks) return { success: false, error: NOT_WIRED }
  const taskId = typeof args.task_id === 'string' ? args.task_id.trim() : ''
  if (!taskId) return { success: false, error: 'video_cancel: task_id is required.' }
  const result = await videoTasks.cancel(taskId)
  if (!result.ok) return { success: false, error: `video_cancel: ${result.error}` }
  return { success: true, output: `Video task ${taskId} cancelled.` }
}

function toStringArray(value) {
  if (!Array.isArray(value)) return undefined
  const out = value.filter((v) => typeof v === 'string' && v.trim().length > 0)
  return out.length > 0 ? out : undefined
}

const toolDefinitions = [
  {
    name: 'video_check',
    description: 'Confirm video generation is configured and the key works (free).',
    input_schema: { type: 'object', properties: {}, required: [] }
  },
  {
    name: 'video_generate',
    description: 'Start a MiniMax H3 video generation task (see SKILL.md).',
    input_schema: { type: 'object', properties: {}, required: [] }
  },
  {
    name: 'video_await',
    description: 'Wait for a video task to finish and get the saved mp4 path.',
    input_schema: { type: 'object', properties: {}, required: [] }
  },
  {
    name: 'video_status',
    description: 'Non-blocking snapshot of video tasks.',
    input_schema: { type: 'object', properties: {}, required: [] }
  },
  {
    name: 'video_cancel',
    description: 'Cancel a queued or running video task.',
    input_schema: { type: 'object', properties: {}, required: [] }
  }
]

const plugin = {
  name: 'video',
  tools: toolDefinitions,
  async init(context) {
    workspaceRoot = context.workspaceRoot
    videoTasks = context.videoTasks ?? null
  },
  async execute(toolName, args, signal) {
    switch (toolName) {
      case 'video_check':
        return check()
      case 'video_generate':
        return generate(args ?? {})
      case 'video_await':
        return awaitTask(args ?? {}, signal)
      case 'video_status':
        return status(args ?? {})
      case 'video_cancel':
        return cancel(args ?? {})
      default:
        return { success: false, error: `video: unknown tool ${toolName}` }
    }
  }
}

export default plugin
