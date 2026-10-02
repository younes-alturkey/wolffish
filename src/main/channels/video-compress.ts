import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

import { workspaceRoot } from '@main/workspace/workspace'

const execFileP = promisify(execFile)

/**
 * Fit a video under a channel's size ceiling by re-encoding it — the shared
 * back end for Telegram (50 MB) and WhatsApp (16 MB inline) delivery of
 * generated or model-produced videos. Bitrate is budgeted from the clip's
 * real duration, resolution steps down as the budget tightens, and a second,
 * harsher attempt runs when the first lands over the limit. Callers decide
 * what to do with a failure (Telegram: explain; WhatsApp: fall back to a
 * document). Returns fresh mp4 bytes; the original file is never touched —
 * full quality stays available in the app.
 *
 * Same conventions as whatsapp/gif.ts: managed-ffmpeg-first resolution,
 * mkdtemp scratch, execFile (no shell), `T | { error }` — never throws.
 */

export type VideoCompress = {
  mp4: Buffer
  /** e.g. "compressed 62.4 MB → 14.8 MB (854px)". */
  note: string
}

const AUDIO_BITRATE = 96_000
const MIN_VIDEO_BITRATE = 200_000
/** Leave headroom under the hard limit — container overhead is real. */
const BUDGET_FACTOR = 0.92

function ffmpegBinary(): string {
  const exe = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'
  const managed = path.join(path.dirname(workspaceRoot()), 'bin', 'ffmpeg', exe)
  return existsSync(managed) ? managed : exe
}

function parseDurationSec(ffmpegStderr: string): number {
  const m = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(ffmpegStderr)
  if (!m) return 0
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + parseFloat(m[3])
}

async function probeDuration(absPath: string): Promise<number> {
  try {
    await execFileP(ffmpegBinary(), ['-hide_banner', '-i', absPath], {
      maxBuffer: 4 * 1024 * 1024
    })
    return 0
  } catch (err) {
    return parseDurationSec((err as { stderr?: string }).stderr ?? '')
  }
}

function mb(bytes: number): string {
  return (bytes / 1024 / 1024).toFixed(1)
}

export async function compressVideoToLimit(
  input: string | Buffer,
  limitBytes: number
): Promise<VideoCompress | { error: string }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wf-vcomp-'))
  let absPath: string
  let originalBytes = 0
  if (Buffer.isBuffer(input)) {
    absPath = path.join(dir, 'in.mp4')
    await fs.writeFile(absPath, input)
    originalBytes = input.length
  } else {
    absPath = path.resolve(input)
    try {
      originalBytes = (await fs.stat(absPath)).size
    } catch {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => {})
      return { error: `file not found: ${absPath}` }
    }
  }
  const duration = await probeDuration(absPath)
  if (duration <= 0) {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {})
    return { error: 'could not probe video duration (ffmpeg missing or unreadable file)' }
  }
  try {
    // Attempt 1 sizes the bitrate to the byte budget; attempt 2 halves it
    // and steps the resolution down again for stubborn content.
    for (const attempt of [0, 1]) {
      const budgetBits = limitBytes * 8 * BUDGET_FACTOR * (attempt === 0 ? 1 : 0.72)
      const videoBitrate = Math.max(
        MIN_VIDEO_BITRATE,
        Math.floor(budgetBits / duration - AUDIO_BITRATE)
      )
      const maxSide = videoBitrate < 500_000 ? 640 : videoBitrate < 1_200_000 ? 854 : 1280
      const outPath = path.join(dir, `out-${attempt}.mp4`)
      try {
        await execFileP(
          ffmpegBinary(),
          [
            '-y',
            '-i',
            absPath,
            '-vf',
            `scale='min(${maxSide},iw)':'min(${maxSide},ih)':force_original_aspect_ratio=decrease:force_divisible_by=2`,
            '-c:v',
            'libx264',
            '-preset',
            'veryfast',
            '-b:v',
            String(videoBitrate),
            '-maxrate',
            String(Math.floor(videoBitrate * 1.2)),
            '-bufsize',
            String(videoBitrate * 2),
            '-pix_fmt',
            'yuv420p',
            '-c:a',
            'aac',
            '-b:a',
            String(AUDIO_BITRATE),
            '-movflags',
            '+faststart',
            outPath
          ],
          { maxBuffer: 16 * 1024 * 1024 }
        )
      } catch (err) {
        return { error: err instanceof Error ? err.message : String(err) }
      }
      const mp4 = await fs.readFile(outPath).catch(() => Buffer.alloc(0))
      if (mp4.length === 0) return { error: 'ffmpeg produced an empty file' }
      if (mp4.length <= limitBytes) {
        return {
          mp4,
          note: `compressed ${mb(originalBytes)} MB → ${mb(mp4.length)} MB (≤${maxSide}px)`
        }
      }
    }
    return { error: `still over ${mb(limitBytes)} MB after two compression passes` }
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}
