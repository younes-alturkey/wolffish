import { cn } from '@lib/utils/cn'
import {
  PauseIcon,
  PlayIcon,
  DashboardSpeed01Icon,
  Download01Icon,
  FolderOpenIcon,
  VolumeMute02Icon
} from 'hugeicons-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

export type AudioSource = 'upload' | 'voice'

export type AudioPlayerProps = {
  /**
   * For `source: 'upload'`, a workspace-relative path
   * (e.g. "uploads/conv-…/recording.mp3"). For `source: 'voice'`, an
   * absolute path under workspace/speech/ (what the TTS plugin returns).
   */
  filePath: string
  fileExists: boolean
  mimeType: string
  fileName: string
  /**
   * Which IPC channel to source bytes through. Uploads go through the
   * upload channel; TTS-generated voice memos go through the voice
   * channel. Defaults to 'upload' for the common case.
   */
  source?: AudioSource
}

/**
 * Inline audio player. Used for both uploaded audio attachments and
 * TTS-generated voice memos — `source` selects the IPC channel, the
 * visual language and controls are identical.
 */
export function AudioPlayer({
  filePath,
  fileExists,
  mimeType,
  fileName,
  source = 'upload'
}: AudioPlayerProps): React.JSX.Element {
  if (!fileExists) {
    return <DeletedPlayer />
  }
  return (
    <ActivePlayer filePath={filePath} mimeType={mimeType} fileName={fileName} source={source} />
  )
}

function DeletedPlayer(): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <div
      className={cn(
        'border-border bg-surface flex w-full max-w-[85%] items-center gap-3 self-start',
        'rounded-2xl border px-4 py-3 opacity-50'
      )}
    >
      <div className="bg-muted/20 flex h-8 w-8 shrink-0 items-center justify-center rounded-full">
        <VolumeMute02Icon size={16} className="text-muted" />
      </div>
      <span className="text-muted text-sm italic">{t('chat.audioPlayer.deleted')}</span>
    </div>
  )
}

function ActivePlayer({
  filePath,
  mimeType,
  fileName,
  source
}: {
  filePath: string
  mimeType: string
  fileName: string
  source: AudioSource
}): React.JSX.Element {
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const progressRef = useRef<HTMLDivElement>(null)
  const [playing, setPlaying] = useState(false)
  const [currentTime, setCurrentTime] = useState(0)
  const [duration, setDuration] = useState(0)
  const [playbackRate, setPlaybackRate] = useState(1)
  const { url, error } = useAudioBlob(filePath, mimeType, source)

  useEffect(() => {
    const audio = audioRef.current
    if (!audio) return

    const onTime = (): void => setCurrentTime(audio.currentTime)
    const onMeta = (): void => setDuration(audio.duration)
    const onEnded = (): void => {
      setPlaying(false)
      setCurrentTime(0)
      audio.currentTime = 0
    }
    // Keep the button in sync when playback is paused from outside togglePlay
    // (e.g. Chat pausing feed media when you navigate away — see Chat.tsx).
    const onPause = (): void => setPlaying(false)

    audio.addEventListener('timeupdate', onTime)
    audio.addEventListener('loadedmetadata', onMeta)
    audio.addEventListener('ended', onEnded)
    audio.addEventListener('pause', onPause)
    return () => {
      audio.removeEventListener('timeupdate', onTime)
      audio.removeEventListener('loadedmetadata', onMeta)
      audio.removeEventListener('ended', onEnded)
      audio.removeEventListener('pause', onPause)
    }
  }, [url])

  const togglePlay = useCallback(() => {
    const audio = audioRef.current
    if (!audio) return
    if (playing) {
      audio.pause()
      setPlaying(false)
    } else {
      void audio.play()
      setPlaying(true)
    }
  }, [playing])

  const cycleSpeed = useCallback(() => {
    const audio = audioRef.current
    if (!audio) return
    const speeds = [1, 1.5, 2]
    const idx = speeds.indexOf(playbackRate)
    const next = speeds[(idx + 1) % speeds.length]
    audio.playbackRate = next
    setPlaybackRate(next)
  }, [playbackRate])

  const seek = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      const audio = audioRef.current
      const bar = progressRef.current
      if (!audio || !bar || !duration) return
      const rect = bar.getBoundingClientRect()
      const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width))
      audio.currentTime = ratio * duration
      setCurrentTime(audio.currentTime)
    },
    [duration]
  )

  const download = useCallback(async () => {
    try {
      if (source === 'voice') await window.api.voice.download(filePath)
      else await window.api.upload.download(filePath)
    } catch {
      // download failed silently
    }
  }, [filePath, source])

  const revealInFolder = useCallback(async () => {
    try {
      if (source === 'voice') await window.api.voice.revealInFolder(filePath)
      else await window.api.upload.revealInFolder(filePath)
    } catch {
      // best-effort
    }
  }, [filePath, source])

  if (error) {
    return <DeletedPlayer />
  }

  const progress = duration > 0 ? (currentTime / duration) * 100 : 0

  return (
    <div
      className={cn(
        'border-border bg-surface flex w-full max-w-[85%] flex-col gap-1 self-start',
        'rounded-2xl border px-4 py-3'
      )}
    >
      <div className="text-muted truncate text-[11px] font-medium" title={fileName}>
        {fileName}
      </div>
      <div className="flex items-center gap-3">
        {url && <audio ref={audioRef} src={url} preload="metadata" />}

        <button
          type="button"
          onClick={togglePlay}
          disabled={!url}
          className={cn(
            'flex h-8 w-8 shrink-0 cursor-pointer items-center justify-center rounded-full',
            'bg-primary text-primary-fg hover:brightness-110',
            'focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg',
            'disabled:cursor-not-allowed disabled:opacity-50'
          )}
        >
          {playing ? <PauseIcon size={14} /> : <PlayIcon size={14} />}
        </button>

        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <div
            ref={progressRef}
            onClick={seek}
            className="bg-border h-1.5 w-full cursor-pointer rounded-full"
          >
            <div
              className="bg-primary h-full rounded-full transition-[width] duration-100"
              style={{ width: `${progress}%` }}
            />
          </div>
          <div className="text-muted flex items-center justify-between text-[10px] tabular-nums">
            <span>{formatTime(currentTime)}</span>
            <span>{duration > 0 ? formatTime(duration) : '--:--'}</span>
          </div>
        </div>

        <button
          type="button"
          onClick={cycleSpeed}
          title={`Speed: ${playbackRate}x`}
          className={cn(
            'text-muted hover:text-fg flex shrink-0 cursor-pointer items-center gap-0.5 rounded px-1 py-0.5 text-[10px] font-medium',
            'focus-visible:ring-2 focus-visible:ring-accent'
          )}
        >
          <DashboardSpeed01Icon size={12} />
          {playbackRate}x
        </button>

        <button
          type="button"
          onClick={revealInFolder}
          title="Reveal in folder"
          className={cn(
            'text-muted hover:text-fg flex shrink-0 cursor-pointer items-center justify-center rounded p-1',
            'focus-visible:ring-2 focus-visible:ring-accent'
          )}
        >
          <FolderOpenIcon size={14} />
        </button>
        <button
          type="button"
          onClick={download}
          title="Download"
          className={cn(
            'text-muted hover:text-fg flex shrink-0 cursor-pointer items-center justify-center rounded p-1',
            'focus-visible:ring-2 focus-visible:ring-accent'
          )}
        >
          <Download01Icon size={14} />
        </button>
      </div>
    </div>
  )
}

function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds)) return '--:--'
  const m = Math.floor(seconds / 60)
  const s = Math.floor(seconds % 60)
  return `${m}:${s.toString().padStart(2, '0')}`
}

/**
 * Fetch audio bytes through the source's IPC channel and wrap them in
 * an object URL the `<audio>` element can stream from. Mirrors the
 * pattern useUploadBlob uses for non-audio uploads — Blob URLs scoped to
 * the renderer's lifetime, no custom Electron protocol. The hook lives
 * here (rather than in `@hooks`) because AudioPlayer is the only caller
 * that needs to dispatch across the upload and voice channels.
 */
function useAudioBlob(
  filePath: string,
  mimeType: string,
  source: AudioSource
): { url: string | null; error: boolean } {
  const [url, setUrl] = useState<string | null>(null)
  const [error, setError] = useState(false)

  useEffect(() => {
    let cancelled = false
    let revoke: string | null = null

    void (async () => {
      try {
        const buffer =
          source === 'voice'
            ? await window.api.voice.readFile(filePath)
            : await window.api.upload.readFile(filePath)
        if (!buffer) throw new Error(`missing upload: ${filePath}`)
        if (cancelled) return
        const blob = new Blob([buffer], { type: mimeType })
        const objectUrl = URL.createObjectURL(blob)
        revoke = objectUrl
        setUrl(objectUrl)
        setError(false)
      } catch {
        if (!cancelled) {
          setUrl(null)
          setError(true)
        }
      }
    })()

    return () => {
      cancelled = true
      if (revoke) URL.revokeObjectURL(revoke)
    }
  }, [filePath, mimeType, source])

  return { url, error }
}
