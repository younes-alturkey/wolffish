import { PauseIcon, PlayIcon, Upload01Icon } from '@/components/core/icons'
import { ExpandedSheet } from '@/components/core/ExpandedSheet'
import { ZoomableImage } from '@/components/core/ZoomableImage'
import { fileName, formatBytes } from '@/lib/files/fileKinds'
import { useWorkspaceFile } from '@/lib/files/useWorkspaceFile'
import { cn } from '@/lib/utils/cn'
import { useTokens } from '@/providers/theme/useTheme'
import { useEvent } from 'expo'
import { useAudioPlayer, useAudioPlayerStatus } from 'expo-audio'
import { Image } from 'expo-image'
import { useVideoPlayer, VideoView } from 'expo-video'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Pressable, Text, View } from 'react-native'
import { DownloadGlyph, DownloadStatus } from '@/components/chat/DownloadStatus'
import { IconAction, MissingCard, shareFile, type Align } from '@/components/chat/FileChrome'

/**
 * Media renderers — the mobile counterparts of the desktop's ImageViewer /
 * AudioPlayer / VideoPlayer. Every file resolves through the workspace cache;
 * a pruned or unpushed file renders its per-type "deleted/unavailable" state,
 * exactly like the desktop's missing-file cards.
 *
 * Images and video expand to full screen, mirroring the desktop's click-to-
 * zoom lightbox and the video element's fullscreen control. The expanded
 * image is a real zooming stage — pinch, pan and double-tap — see
 * ZoomableImage.
 */

/** Fixed width of the inline thumbnail; height follows the image's own ratio. */
const THUMB_WIDTH = 260
/** Placeholder height until the image's natural size reports in. */
const THUMB_HEIGHT = 200

/**
 * Natural ratios already decoded this session, by workspace path. The ratio
 * is component state, and the live row's card is REMOUNTED when the stored
 * copy takes over at the end of a turn (a different feed key) — without this,
 * every image in the reply snapped back to the 260×200 placeholder and grew
 * again, a bounce the scroller then had to chase. A few bytes per image ever
 * shown; the paths are workspace-relative and stable across the swap.
 */
const knownAspectRatios = new Map<string, number>()

/** Shape of the video card until the track's natural size lands — desktop's loading aspect. */
const DEFAULT_VIDEO_ASPECT = 16 / 9

export function ImageBlock({
  relPath,
  conversationId,
  align = 'start',
  sizeBytes,
  displayName
}: {
  relPath: string
  conversationId?: string
  align?: Align
  sizeBytes?: number
  displayName?: string
}): React.JSX.Element {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  // Natural ratio, known only once the decoder reports it — same deal as the
  // video track below, so the thumb holds its placeholder shape until then.
  // Seeded from the session cache so a remount (the live row handing over to
  // the stored copy) mounts at true height instead of bouncing through the
  // placeholder.
  const [aspectRatio, setAspectRatio] = useState<number | null>(
    () => knownAspectRatios.get(relPath) ?? null
  )
  const { uri, loading, missing } = useWorkspaceFile(relPath, conversationId)
  const name = displayName ?? fileName(relPath)

  if (loading) {
    // The thumbnail's starting footprint: the bytes landing swap the image in
    // at this width, and only the height settles once the real ratio lands.
    return (
      <View
        className={cn('bg-border overflow-hidden', align === 'end' ? 'self-end' : 'self-start')}
        style={{ width: THUMB_WIDTH, height: THUMB_HEIGHT, borderRadius: 16 }}
      >
        <DownloadStatus relPath={relPath} expectedBytes={sizeBytes} />
      </View>
    )
  }
  if (missing || !uri) return <MissingCard label={t('chat.imageViewer.deleted')} align={align} />

  return (
    <View className={align === 'end' ? 'self-end' : 'self-start'}>
      <Pressable
        accessibilityRole="imagebutton"
        accessibilityLabel={name}
        onPress={() => setOpen(true)}
        onLongPress={() => shareFile(uri)}
      >
        {/* The pressable carries the label — a nested one would double it.
            Width is the constraint; the image's own ratio sets the height, so
            a tall screenshot renders whole instead of cropping to the box. */}
        <Image
          source={{ uri }}
          contentFit="cover"
          onLoad={({ source }) => {
            if (source.width > 0 && source.height > 0) {
              knownAspectRatios.set(relPath, source.width / source.height)
              setAspectRatio(source.width / source.height)
            }
          }}
          style={
            aspectRatio === null
              ? { width: THUMB_WIDTH, height: THUMB_HEIGHT, borderRadius: 16 }
              : { width: THUMB_WIDTH, aspectRatio, borderRadius: 16 }
          }
        />
      </Pressable>
      <ExpandedSheet
        open={open}
        onClose={() => setOpen(false)}
        title={name}
        actions={
          <IconAction
            label={t('chat.fileCard.share')}
            icon={<Upload01Icon size={16} className="text-muted" />}
            onPress={() => shareFile(uri)}
          />
        }
      >
        {/* Mounted only while open, which is what returns the next opening to
            1× — the zoom lives in the stage's own shared values, and the
            desktop resets its lightbox the same way. */}
        {open ? <ZoomableImage uri={uri} label={name} /> : null}
        <Text className="text-muted p-2 text-center font-sans text-[10px]">
          {[sizeBytes ? formatBytes(sizeBytes) : '', t('chat.imageViewer.zoomHint')]
            .filter(Boolean)
            .join(' · ')}
        </Text>
      </ExpandedSheet>
    </View>
  )
}

export function VideoBlock({
  relPath,
  conversationId,
  align = 'start',
  displayName,
  fallback
}: {
  relPath: string
  conversationId?: string
  align?: Align
  displayName?: string
  /** Shown when the platform's decoder can't play this container (e.g. .webm on iOS). */
  fallback?: React.JSX.Element
}): React.JSX.Element {
  const { t } = useTranslation()
  const { uri, loading, missing } = useWorkspaceFile(relPath, conversationId)
  // The player must be created unconditionally (hook order); a null source is
  // legal and simply leaves the view idle until the cache resolves.
  const player = useVideoPlayer(uri ?? null, (instance) => {
    instance.loop = false
  })
  // A container the device cannot decode (Ogg/WebM on iOS, say) fails at load
  // time, not at classify time — the only honest signal is the player's own
  // status, so a dead black box degrades to the openable file card.
  const { status } = useEvent(player, 'statusChange', { status: player.status })
  // The natural size arrives with the track, not with the source, so the card
  // holds a 16/9 shape until then and re-lays out once the decoder reports in.
  const { videoTrack } = useEvent(player, 'videoTrackChange', { videoTrack: player.videoTrack })
  const size = videoTrack?.size
  const aspectRatio = size?.width && size?.height ? size.width / size.height : DEFAULT_VIDEO_ASPECT
  const name = displayName ?? fileName(relPath)

  if (loading) {
    // Same footprint the loaded card starts at — the 16/9 stage AND the name
    // row under it — so resolving the cache doesn't jog the transcript. A clip
    // whose track reports a different ratio still settles once; its natural
    // size arrives with the decoder, not with the file, so there is nothing to
    // reserve it from (the desktop's VideoPlayer holds aspect-video the same
    // way for the same reason).
    return (
      <View
        className={cn(
          'bg-surface border-border w-[85%] flex-col overflow-hidden rounded-2xl border',
          align === 'end' ? 'self-end' : 'self-start'
        )}
      >
        <View className="bg-border w-full" style={{ aspectRatio: DEFAULT_VIDEO_ASPECT }}>
          <DownloadStatus relPath={relPath} />
        </View>
        <View className="flex-row items-center gap-2 px-3 py-2">
          <View className="bg-border h-2.5 w-24 rounded-full opacity-40" />
          <View className="flex-1" />
          {/* m-1.5 + 14pt is IconAction's own box (p-1.5 + a 14pt icon) — the
              share button is what sets this row's height. */}
          <View className="bg-border m-1.5 h-3.5 w-3.5 rounded opacity-40" />
        </View>
      </View>
    )
  }
  if (missing || !uri) return <MissingCard label={t('chat.videoPlayer.deleted')} align={align} />
  if (status === 'error' && fallback) return fallback

  return (
    <View
      className={cn(
        'bg-surface border-border w-[85%] overflow-hidden rounded-2xl border',
        align === 'end' ? 'self-end' : 'self-start'
      )}
    >
      {/* Native controls carry play/scrub/fullscreen — the platform's own
          video affordances, and the mobile answer to the desktop <video>.
          The card's width is the constraint; the video's own ratio sets the
          height, so any clip renders whole — no crop, no letterbox bars. */}
      <VideoView
        player={player}
        style={{
          width: '100%',
          aspectRatio,
          backgroundColor: 'black'
        }}
        contentFit="contain"
        nativeControls
        fullscreenOptions={{ enable: true }}
        allowsPictureInPicture
        accessibilityLabel={name}
      />
      <View className="flex-row items-center gap-2 px-3 py-2">
        <Text
          numberOfLines={1}
          className="text-muted font-sans min-w-0 flex-1 text-left text-[11px]"
        >
          {name}
        </Text>
        <IconAction
          label={t('chat.fileCard.share')}
          icon={<Upload01Icon size={14} className="text-muted" />}
          onPress={() => shareFile(uri)}
        />
      </View>
    </View>
  )
}

export function AudioBlock({
  relPath,
  conversationId,
  align = 'start',
  displayName
}: {
  relPath: string
  conversationId?: string
  align?: Align
  displayName?: string
}): React.JSX.Element {
  const { t } = useTranslation()
  const tokens = useTokens()
  const { uri, loading, missing } = useWorkspaceFile(relPath, conversationId)
  const player = useAudioPlayer(uri ?? undefined)
  const status = useAudioPlayerStatus(player)

  if (loading) {
    // The transport's own shape — same container, same 36pt button, same
    // three-line column — so the height is identical before and after the
    // bytes land and the row below never moves. The transport's own parts,
    // too: the name is known already, and the download bar sits exactly where
    // the playback bar will, with the transfer status where the timecode goes.
    return (
      <View
        className={cn(
          'bg-surface border-border w-[85%] flex-row items-center gap-3 rounded-xl border px-3 py-2.5',
          align === 'end' ? 'self-end' : 'self-start'
        )}
      >
        <View className="bg-border h-9 w-9 items-center justify-center rounded-full">
          <DownloadGlyph size={16} />
        </View>
        <View className="flex-1 flex-col gap-1.5">
          <Text numberOfLines={1} className="text-fg font-sans-medium text-left text-xs">
            {displayName ?? fileName(relPath)}
          </Text>
          {/* gap-1.5 is 6pt — the column's own gap, so the three rows keep the
              spacing the loaded transport has. */}
          <DownloadStatus relPath={relPath} variant="row" rowGap={6} />
        </View>
        <View className="bg-border m-1.5 h-3.5 w-3.5 rounded opacity-40" />
      </View>
    )
  }
  if (missing || !uri) return <MissingCard label={t('chat.audioPlayer.deleted')} align={align} />

  const playing = status.playing
  const duration = status.duration ?? 0
  const position = status.currentTime ?? 0
  const progress = duration > 0 ? Math.min(position / duration, 1) : 0
  const mmss = (seconds: number): string => {
    const s = Math.max(0, Math.floor(seconds))
    return `${Math.floor(s / 60)}:${(s % 60).toString().padStart(2, '0')}`
  }

  return (
    <View
      className={cn(
        // w-[85%] is CardShell's width — the transport lines up with every
        // other file card in the feed instead of sitting short of them.
        'bg-surface border-border w-[85%] flex-row items-center gap-3 rounded-xl border px-3 py-2.5',
        align === 'end' ? 'self-end' : 'self-start'
      )}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={playing ? t('chat.stop') : t('chat.send')}
        onPress={() => {
          if (playing) {
            player.pause()
          } else {
            if (status.didJustFinish || (duration > 0 && position >= duration)) {
              player.seekTo(0)
            }
            player.play()
          }
        }}
        className="bg-primary h-9 w-9 items-center justify-center rounded-full active:opacity-90"
      >
        {playing ? (
          <PauseIcon size={16} color={tokens.primaryFg} />
        ) : (
          <PlayIcon size={16} color={tokens.primaryFg} />
        )}
      </Pressable>
      <View className="flex-1 flex-col gap-1.5">
        <Text numberOfLines={1} className="text-fg font-sans-medium text-left text-xs">
          {displayName ?? fileName(relPath)}
        </Text>
        <View className="bg-border h-1 w-full overflow-hidden rounded-full">
          <View className="bg-primary h-full" style={{ width: `${progress * 100}%` }} />
        </View>
        <Text className="text-muted text-left font-sans text-[10px]">
          {mmss(position)} / {mmss(duration)}
        </Text>
      </View>
      {/* Same share affordance the video card carries, on the trailing edge so
          the transport keeps its shape. */}
      <IconAction
        label={t('chat.fileCard.share')}
        icon={<Upload01Icon size={14} className="text-muted" />}
        onPress={() => shareFile(uri)}
      />
    </View>
  )
}
