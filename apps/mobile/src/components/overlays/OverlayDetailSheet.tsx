import { Modal } from '@/components/core/Modal'
import { elapsed, PulsingIcon, REINDEX_TONE } from '@/components/overlays/OverlayChrome'
import type { ActiveOverlay } from '@/lib/sync/overlays'
import { cn } from '@/lib/utils/cn'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Text, View } from 'react-native'

/**
 * The reindex card, opened — the phone's answer to the desktop's
 * ReindexActiveOverlay.
 *
 * What the card had to cut: an explanation of what is happening, when it
 * started, how long it has been going, and the count as a percentage.
 *
 * Dismissing stops nothing. Neither does the desktop's, and a phone that could
 * interrupt a memory rebuild with a stray tap on a backdrop would be worse.
 */

/** The elapsed clock only advances while the sheet is open to show it. */
const TICK_MS = 1000

export function OverlayDetailSheet({
  overlay,
  onClose
}: {
  overlay: ActiveOverlay | null
  onClose: () => void
}): React.JSX.Element {
  const { t, i18n } = useTranslation()
  const [now, setNow] = useState(() => Date.now())

  // Keyed on startedAt alone, NOT on the overlay object: a reindex re-renders
  // this on every progress tick, and an interval torn down and rebuilt each
  // time would never reach its first fire, freezing the clock at zero. The
  // desktop hit exactly this and fixed it the same way.
  const startedAt = overlay?.startedAt ?? 0
  useEffect(() => {
    if (!startedAt) return
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), TICK_MS)
    return () => clearInterval(timer)
  }, [startedAt])

  // Rendered closed rather than returning null, so the hooks above keep the
  // same order whether or not the card is open.
  if (!overlay)
    return (
      <Modal open={false} onClose={onClose}>
        {null}
      </Modal>
    )

  const tone = REINDEX_TONE
  const Icon = tone.icon

  return (
    <Modal open onClose={onClose} title={t('overlays.reindexTitle')}>
      <View className="flex-col items-center gap-4 py-2">
        <PulsingIcon tone={tone.disc} halo={tone.halo} size={48}>
          <Icon size={22} className={tone.tint} />
        </PulsingIcon>

        {startedAt > 0 && (
          <View className="flex-row flex-wrap items-center justify-center gap-x-2 gap-y-1">
            <Text className="text-muted font-sans text-[11px]">
              {t('overlays.startedAt', {
                time: new Date(startedAt).toLocaleTimeString(i18n.language, {
                  hour: '2-digit',
                  minute: '2-digit'
                })
              })}
            </Text>
            {/* Pinned LTR: mm:ss counts up left to right in every locale. */}
            <Text className="text-muted font-sans text-[11px]" style={{ writingDirection: 'ltr' }}>
              {elapsed(now - startedAt)}
            </Text>
          </View>
        )}

        <ReindexDetail done={overlay.done} total={overlay.total} fill={tone.fill} />

        <Text className="text-muted text-center font-sans text-[11px] leading-relaxed">
          {t('overlays.runsOnDesktop')}
        </Text>
      </View>
    </Modal>
  )
}

function ReindexDetail({
  done,
  total,
  fill
}: {
  done: number
  total: number
  fill: string
}): React.JSX.Element {
  const { t, i18n } = useTranslation()
  const percent = total > 0 ? Math.round((done / total) * 100) : 0
  return (
    <View className="w-full flex-col gap-2">
      <Text className="text-fg text-left font-sans text-[13px] leading-relaxed">
        {t('overlays.reindexBody')}
      </Text>
      <View className="bg-border h-1.5 w-full overflow-hidden rounded-full">
        <View className={cn('h-full rounded-full', fill)} style={{ width: `${percent}%` }} />
      </View>
      <View className="flex-row items-center justify-between">
        <Text className="text-muted font-sans text-[11px]" style={{ writingDirection: 'ltr' }}>
          {done.toLocaleString(i18n.language)} / {total.toLocaleString(i18n.language)}
        </Text>
        <Text className="text-muted font-sans text-[11px]" style={{ writingDirection: 'ltr' }}>
          {percent}%
        </Text>
      </View>
    </View>
  )
}
