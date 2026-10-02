---
name: ffmpeg
description: FFmpeg multimedia framework for video/audio processing
triggers:
  - ffmpeg
  - video
  - audio
  - convert
  - transcode
  - compress
  - encode
  - decode
  - mp4
  - mkv
  - avi
  - mov
  - webm
  - mp3
  - wav
  - aac
  - flac
  - ogg
  - trim
  - cut
  - clip
  - merge video
  - concat
  - resize video
  - scale
  - bitrate
  - codec
  - h264
  - h265
  - hevc
  - gif
  - thumbnail
  - extract audio
  - extract frame
  - subtitle
  - watermark
  - rotate
  - crop
  - filter
  - resolution
  - fps
  - frame rate
  - media
  - multimedia
  - screen recording
  - stream
  - mux
  - demux
  - remux
  - container
  - format
  - aspect ratio
  - 4k
  - 1080p
  - 720p
  - 480p
  - hdr
  - sdr
  - slow motion
  - speed up
  - time lapse
  - reverse video
  - loop video
  - loop gif
  - animated gif
  - video to gif
  - gif to video
  - audio to video
  - add music
  - background music
  - volume
  - normalize audio
  - noise reduction
  - fade in
  - fade out
  - crossfade
  - overlay
  - picture in picture
  - pip
  - split screen
  - side by side
  - green screen
  - chroma key
  - stabilize
  - denoise
  - sharpen
  - blur
  - vignette
  - color correction
  - brightness
  - contrast
  - saturation
  - convert video
  - convert audio
  - compress video
  - reduce video size
  - make smaller
requires: []
tools:
  - name: ffmpeg_check
    readOnly: true
    description: Check if ffmpeg is installed
    parameters: {}
  - name: ffmpeg_install
    description: Install ffmpeg with no admin rights — reuse a global ffmpeg, else download a no-root static build into ~/.wolffish/bin (no package manager, no password)
    parameters: {}
  - name: ffmpeg_install_system
    description: Optional — install ffmpeg AND ffprobe system-wide via the OS (brew / winget / apt|dnf; admin on Linux). Use when a global ffmpeg or ffprobe (video metadata) is needed.
    parameters: {}
  - name: ffmpeg_run
    description: "Run an ffmpeg command. IMPORTANT — save output files inside the workspace files/ directory. Never use /tmp/."
    parameters:
      args:
        type: string
        description: ffmpeg arguments (everything after 'ffmpeg')
confirm_patterns:
  - pattern: "ffmpeg_install"
    reason: Installing ffmpeg
  - pattern: "ffmpeg_install_system"
    reason: Installing ffmpeg system-wide (needs admin)
---

# FFmpeg

## Usage

Use `ffmpeg_check` to verify ffmpeg is installed before running commands.
If not installed, call `ffmpeg_install` (requires user approval).

`ffmpeg_install` is managed-first and needs no admin rights: it reuses a global
ffmpeg if present, otherwise downloads a static build into `~/.wolffish/bin/ffmpeg`
— no package manager, no password. Don't fall back to ad-hoc `shell` downloads —
just call `ffmpeg_install`. `ffmpeg_check` and `ffmpeg_run` resolve that managed
copy directly, so a freshly installed ffmpeg works immediately without an app
restart.

The managed install provides `ffmpeg` only. If you need `ffprobe` (e.g. to read
video metadata) or a globally-visible ffmpeg, call `ffmpeg_install_system`, which
installs both via the OS package manager (admin on Linux) and falls back to the
no-root copy if that's unavailable.

Use `ffmpeg_run` with the arguments you'd pass after `ffmpeg` on the command line.

## Output files

Save all output files in the workspace `files/` directory — the same parent directory where `uploads/` lives, but use `files/` instead. For example if the input is at `…/uploads/conv-…/video.mp4`, save output to `…/files/output.mp3`. Never use `/tmp/` or any path outside the workspace.

## Common patterns

- **Compress video:** `-i input.mp4 -crf 28 -preset medium output.mp4`
- **Extract audio:** `-i input.mp4 -vn -acodec copy output.aac`
- **Convert format:** `-i input.avi -c:v libx264 -c:a output.mp4`
- **Resize video:** `-i input.mp4 -vf scale=1280:720 output.mp4`
- **Get info:** `-i input.mp4` (prints metadata to stderr)
