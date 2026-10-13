import { useEffect, useState } from 'react'
import { Text, View } from 'react-native'
import { useTranslation } from 'react-i18next'
import { useEvent } from 'expo'
import { useVideoPlayer, VideoView } from 'expo-video'

import { ProgressBar } from '@/components/core/ProgressBar'
import { Video01Icon } from '@/components/core/icons'
import { DownloadStatus } from '@/components/chat/DownloadStatus'
import type { TaskSnapshot, TaskStatus } from '@/lib/conversations/types'
import { useWorkspaceFile } from '@/lib/files/useWorkspaceFile'
import { cn } from '@/lib/utils/cn'

/**
 * Generic async-generation task card (MiniMax H3 video today) — the mobile
 * twin of the desktop's TaskCard. Fully deterministic: everything rendered
 * comes from the desktop manager's TaskSnapshot; snapshots replace each
 * other by taskId upstream (segments.ts fold), so live pushes and a
 * reloaded conversation render identically.
 *
 * Progress interpolates elapsed time against the manager's measured
 * estimate, clamped at 95% until a terminal snapshot arrives — the API
 * reports no true percentage. A 1 Hz tick keeps it moving between pushes.
 *
 * No cancel button here: cancel rides Electron IPC on the desktop and no
 * task RPC exists on the tunnel — the desktop card, the chat model, or a
 * reply ("cancel the video") all cancel it.
 */

const STATUS_TONE: Record<TaskStatus, { container: string; text: string }> = {
  submitted: { container: 'bg-primary-soft', text: 'text-primary' },
  queued: { container: 'bg-primary-soft', text: 'text-primary' },
  running: { container: 'bg-primary-soft', text: 'text-primary' },
  succeeded: { container: 'bg-emerald-500/15', text: 'text-emerald-600 dark:text-emerald-400' },
  failed: { container: 'bg-red-500/15', text: 'text-red-600 dark:text-red-400' },
  cancelled: { container: 'bg-border-soft', text: 'text-muted' }
}

const LIVE_STATUSES: ReadonlySet<TaskStatus> = new Set(['submitted', 'queued', 'running'])

export function TaskCard({
  snapshot,
  conversationId
}: {
  snapshot: TaskSnapshot
  conversationId?: string
}): React.JSX.Element {
  const { t } = useTranslation()
  const live = LIVE_STATUSES.has(snapshot.status)

  // 1 Hz tick while live so elapsed time and the estimate bar move.
  const [now, setNow] = useState<number>(() => Date.now())
  useEffect(() => {
    if (!live) return
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [live])

  const elapsedMs = Math.max(0, (snapshot.endedAt ?? now) - snapshot.createdAt)
  const progress =
    snapshot.status === 'succeeded'
      ? 1
      : live
        ? Math.min(0.95, elapsedMs / 1000 / Math.max(1, snapshot.estimateSeconds))
        : 0

  const tone = STATUS_TONE[snapshot.status]
  const video = snapshot.video
  const facts = video
    ? [video.resolution, `${video.durationSeconds}s`, video.ratio, video.inputSummary]
        .filter(Boolean)
        .join(' · ')
    : ''

  return (
    <View className="bg-surface border-border w-[85%] flex-col gap-2 self-start rounded-xl border px-3 py-2.5">
      <View className="flex-row items-center gap-2">
        <Video01Icon size={15} className="text-muted" />
        <View className={cn('rounded-full px-2 py-0.5', tone.container)}>
          <Text className={cn('font-sans-medium text-[11px]', tone.text)}>
            {t(`chat.task.status.${snapshot.status}`)}
          </Text>
        </View>
        <Text
          selectable
          numberOfLines={1}
          className="text-fg font-sans-medium min-w-0 flex-1 text-left text-sm"
        >
          {snapshot.title}
        </Text>
        <Text
          className="text-muted font-sans text-[11px]"
          style={{ writingDirection: 'ltr', fontVariant: ['tabular-nums'] }}
        >
          {formatElapsed(elapsedMs)}
        </Text>
      </View>

      {live && <ProgressBar value={progress} />}

      <View className="flex-row items-center gap-2">
        {facts.length > 0 && (
          <Text
            numberOfLines={1}
            className="text-muted font-sans min-w-0 flex-1 text-left text-[11px]"
          >
            {facts}
          </Text>
        )}
        <Text
          selectable
          numberOfLines={1}
          className="text-muted font-sans text-[10px] opacity-70"
          style={{ writingDirection: 'ltr' }}
        >
          {snapshot.taskId}
        </Text>
      </View>

      {snapshot.detail && snapshot.status !== 'failed' && (
        <Text selectable className="text-muted text-left font-sans text-[11px]">
          {snapshot.detail}
        </Text>
      )}

      {snapshot.status === 'failed' && (
        <View className="rounded-lg border border-red-500/30 bg-red-500/10 px-2.5 py-2">
          <Text
            selectable
            className="text-left font-sans text-[11px] text-red-600 dark:text-red-400"
          >
            {snapshot.error ?? t('chat.task.status.failed')}
          </Text>
        </View>
      )}

      {snapshot.status === 'succeeded' && snapshot.outputPath && (
        <TaskVideoPreview relPath={snapshot.outputPath} conversationId={conversationId} />
      )}
    </View>
  )
}

/**
 * The finished mp4 INSIDE the card, padded by the card's own gap — the
 * mobile twin of the desktop's TaskVideoPreview. A slim sibling of
 * MediaBlocks' VideoBlock: same player, same aspect/height rules, but no
 * feed shell (w-[85%] border + filename footer) — nesting that shell here
 * would render as two glued cards and double-constrain the width.
 */
function TaskVideoPreview({
  relPath,
  conversationId
}: {
  relPath: string
  conversationId?: string
}): React.JSX.Element | null {
  const { uri, loading, missing } = useWorkspaceFile(relPath, conversationId)
  const player = useVideoPlayer(uri ?? null, (instance) => {
    instance.loop = false
  })
  const { status } = useEvent(player, 'statusChange', { status: player.status })
  const { videoTrack } = useEvent(player, 'videoTrackChange', { videoTrack: player.videoTrack })
  const size = videoTrack?.size
  const aspectRatio = size?.width && size?.height ? size.width / size.height : 16 / 9

  if (loading) {
    return (
      <View
        className="bg-bg-soft w-full items-center justify-center overflow-hidden rounded-lg"
        style={{ aspectRatio: 16 / 9 }}
      >
        <DownloadStatus relPath={relPath} />
      </View>
    )
  }
  // Missing or undecodable: the card's status line already tells the story,
  // and the model's own delivery (send_file) renders the full player with
  // its per-type fallbacks — no second failure card inside this one.
  if (missing || !uri || status === 'error') return null

  return (
    <View className="w-full overflow-hidden rounded-lg">
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
        accessibilityLabel={relPath.split('/').pop() ?? 'video'}
      />
    </View>
  )
}

function formatElapsed(ms: number): string {
  const total = Math.floor(ms / 1000)
  const minutes = Math.floor(total / 60)
  const seconds = total % 60
  return `${minutes}:${String(seconds).padStart(2, '0')}`
}
