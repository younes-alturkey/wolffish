import { FLOATING_AREA } from '@/components/chat/FloatingChrome'
import { OverlayDetailSheet } from '@/components/overlays/OverlayDetailSheet'
import { PulsingIcon, REINDEX_TONE } from '@/components/overlays/OverlayChrome'
import { useActiveOverlay, type ActiveOverlay } from '@/lib/sync/overlays'
import { cn } from '@/lib/utils/cn'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Pressable, Text, View } from 'react-native'
import Animated, { FadeInUp, FadeOut } from 'react-native-reanimated'
import { useSafeAreaInsets } from 'react-native-safe-area-context'

/**
 * The desktop rebuilding its memory index, as a card over whatever screen the
 * phone is on — the visible half of lib/sync/overlays.ts.
 *
 * The desktop blocks its whole window for a reindex, so this mounts app-wide
 * too rather than living on the chat screen: a desktop that has stopped
 * answering is news wherever the user happens to be. The card is a header row
 * and a progress line; tapping opens the whole thing.
 *
 * Sits below the chat screen's floating discs (FLOATING_AREA) so the two never
 * collide. The transcript's own top padding is deliberately NOT grown to match:
 * the card comes and goes on its own schedule, and messages shifting down
 * because a rebuild started is a worse surprise than messages passing
 * underneath — which is what they already do under the discs.
 */
export function ActiveOverlays(): React.JSX.Element | null {
  const overlay = useActiveOverlay()
  const [open, setOpen] = useState(false)
  const insets = useSafeAreaInsets()

  // A rebuild that ended takes its sheet with it, so there is never a frame
  // where the sheet stands open over a rebuild that has finished.
  useEffect(() => {
    if (open && overlay === null) setOpen(false)
  }, [open, overlay])

  if (overlay === null) return null

  return (
    <>
      <View
        // box-none, so only the card takes touches — the screen underneath
        // keeps working while the desktop rebuilds.
        pointerEvents="box-none"
        style={{ position: 'absolute', top: insets.top + FLOATING_AREA, left: 0, right: 0 }}
        className="px-3"
      >
        <ReindexCard overlay={overlay} onOpen={() => setOpen(true)} />
      </View>
      <OverlayDetailSheet overlay={open ? overlay : null} onClose={() => setOpen(false)} />
    </>
  )
}

function ReindexCard({
  overlay,
  onOpen
}: {
  overlay: ActiveOverlay
  onOpen: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const tone = REINDEX_TONE
  const Icon = tone.icon
  const title = t('overlays.reindexTitle')

  return (
    <Animated.View entering={FadeInUp.duration(200)} exiting={FadeOut.duration(150)}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={title}
        accessibilityHint={t('overlays.openHint')}
        onPress={onOpen}
        className="border-border-soft bg-surface w-full flex-col gap-1.5 rounded-xl border px-2.5 py-2 shadow-md active:opacity-70"
      >
        <View className="flex-row items-center gap-2">
          <PulsingIcon tone={tone.disc} halo={tone.halo}>
            <Icon size={12} className={tone.tint} />
          </PulsingIcon>
          <Text
            numberOfLines={1}
            className="text-fg font-sans-medium min-w-0 flex-1 text-left text-xs"
          >
            {title}
          </Text>
        </View>
        <ReindexLine done={overlay.done} total={overlay.total} />
      </Pressable>
    </Animated.View>
  )
}

/** A reindex has no prompt — its detail is how far through the files it is. */
function ReindexLine({ done, total }: { done: number; total: number }): React.JSX.Element {
  const { i18n } = useTranslation()
  const tone = REINDEX_TONE
  const percent = total > 0 ? Math.round((done / total) * 100) : 0
  return (
    <View className="bg-bg-soft border-border-soft w-full flex-row items-center gap-2 rounded-lg border px-2 py-1">
      <View className="bg-border h-1 min-w-0 flex-1 overflow-hidden rounded-full">
        <View className={cn('h-full rounded-full', tone.fill)} style={{ width: `${percent}%` }} />
      </View>
      {/* Pinned LTR: a count reads left to right in Arabic too, exactly as the
          desktop's own reindex overlay pins its `n / total`. */}
      <Text
        className={cn('font-sans-medium shrink-0 text-[10px]', tone.tint)}
        style={{ writingDirection: 'ltr' }}
      >
        {done.toLocaleString(i18n.language)} / {total.toLocaleString(i18n.language)}
      </Text>
    </View>
  )
}
