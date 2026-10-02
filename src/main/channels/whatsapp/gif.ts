import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

import { workspaceRoot } from '@main/workspace/workspace'

const execFileP = promisify(execFile)

// WhatsApp has no native GIF type — a "GIF" is a short, muted, looping video
// sent with gifPlayback:true. An animated GIF sent as an imageMessage is
// silently dropped by the server, so GIFs must be transcoded to mp4 and sent
// as video. Clips longer than this are delivered as a normal video instead.
export const GIF_PLAYBACK_MAX_SECONDS = 8

export type GifTranscode = { mp4: Buffer; durationSec: number }

/** True when the media is an animated-GIF container that must ride as video. */
export function isGifMime(mimetype: string | null | undefined): boolean {
  return (mimetype ?? '').toLowerCase().startsWith('image/gif')
}

// Prefer the wolffish-managed ffmpeg (~/.wolffish/bin/ffmpeg/ffmpeg — a sibling
// of the workspace, the layout voice-engines installs); fall back to a bare
// `ffmpeg` resolved off PATH.
function ffmpegBinary(): string {
  const exe = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'
  const managed = path.join(path.dirname(workspaceRoot()), 'bin', 'ffmpeg', exe)
  return existsSync(managed) ? managed : exe
}

// ffmpeg prints `Duration: HH:MM:SS.xx` to stderr while probing the input.
function parseDurationSec(ffmpegStderr: string): number {
  const m = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(ffmpegStderr)
  if (!m) return 0
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + parseFloat(m[3])
}

/**
 * Transcode an animated GIF to an H.264 mp4 WhatsApp can play back as a GIF.
 * WhatsApp will not render a raw .gif container as video, so the bytes are
 * re-encoded (yuv420p + even dimensions = broadly decodable H.264; +faststart
 * so it streams). Returns the mp4 and its duration (for the gif-vs-video call),
 * or an error string if ffmpeg is missing or the encode fails.
 */
export async function transcodeGifToMp4(gif: Buffer): Promise<GifTranscode | { error: string }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wf-gif-'))
  const inPath = path.join(dir, 'in.gif')
  const outPath = path.join(dir, 'out.mp4')
  try {
    await fs.writeFile(inPath, gif)
    const { stderr } = await execFileP(
      ffmpegBinary(),
      [
        '-y',
        '-i',
        inPath,
        '-movflags',
        '+faststart',
        '-pix_fmt',
        'yuv420p',
        '-vf',
        'scale=trunc(iw/2)*2:trunc(ih/2)*2',
        '-c:v',
        'libx264',
        outPath
      ],
      { maxBuffer: 16 * 1024 * 1024 }
    )
    const mp4 = await fs.readFile(outPath)
    if (mp4.length === 0) return { error: 'ffmpeg produced an empty file' }
    return { mp4, durationSec: parseDurationSec(stderr) }
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) }
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}
