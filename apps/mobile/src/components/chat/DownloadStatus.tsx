import { Download01Icon } from '@/components/core/icons'
import { ProgressBar } from '@/components/core/ProgressBar'
import { useDownloadProgress } from '@/lib/files/downloadProgress'
import { formatBytes } from '@/lib/files/fileKinds'
import { useTranslation } from 'react-i18next'
import { Text, View } from 'react-native'

/**
 * What a file card shows while its bytes are still arriving: the transfer
 * glyph, a progress bar, and the transfer's status under it.
 *
 * This replaces the spinner every download used to sit behind. A spinner says
 * only "something is happening" — but a 40 MB video and a 4 KB README are very
 * different waits, and the card is the only thing that can tell you which one
 * you are in. It is also the same component everywhere, so a download reads the
 * same whether it lands in an image, a chart, a PDF or a plain file row.
 *
 * Every pixel the bar moves is driven by bytes that actually arrived — there is
 * no timer in here, so a stalled transfer visibly stalls instead of animating
 * on regardless. Both transports report real counts (the desktop fetch against
 * the file's stat, the CDN download against Content-Length; see fileCache), and
 * the one case where a source declines to give a total still moves the bar off
 * the bytes received, just along a curve that can never reach the end.
 */

/** Never sit at a dead zero: a bar that has not moved reads as a hang. */
const MIN_FRACTION = 0.04
/**
 * Bytes at which a transfer with no declared total shows half a bar. The curve
 * below is asymptotic, so such a download approaches the end without ever
 * claiming to have reached it — which is exactly what we know about it.
 */
const BLIND_HALFWAY_BYTES = 4 * 1024 * 1024

/**
 * Bidi-isolate a byte count interpolated into localized text — the desktop's
 * ltrIsolate, and the same fix settings/data.tsx needs for its disk sentence.
 * Without it the Arabic status captures the digits into the Arabic run and
 * strands the unit on the far side.
 */
function bidiIsolate(value: string): string {
  return `⁨${value}⁩`
}

function useTransfer(
  relPath: string,
  expectedBytes?: number
): { fraction: number; status: string } {
  const { t } = useTranslation()
  const progress = useDownloadProgress(relPath)
  const received = progress?.receivedBytes ?? 0
  // The card's own size is a fallback, never an override: the transport knows
  // the bytes it is actually moving, the message metadata only claims to.
  const total = progress?.totalBytes || expectedBytes || 0

  const fraction =
    total > 0
      ? Math.min(received / total, 1)
      : // No total anywhere: saturating curve on the bytes we do have.
        1 - 1 / (1 + received / BLIND_HALFWAY_BYTES)

  let status: string
  if (received <= 0) {
    status = t('chat.download.starting')
  } else if (total > 0 && received >= total) {
    // The bytes are all here; moving the file into the cache and recording it
    // is what's left. Brief, but claiming "done" while the card is still a
    // placeholder would be a lie the next frame contradicts.
    status = t('chat.download.finishing')
  } else if (total > 0) {
    status = t('chat.download.progress', {
      done: bidiIsolate(formatBytes(received)),
      total: bidiIsolate(formatBytes(total))
    })
  } else {
    status = t('chat.download.received', { done: bidiIsolate(formatBytes(received)) })
  }

  return { fraction: Math.max(fraction, MIN_FRACTION), status }
}

/**
 * `bg-primary-line` rather than the bar's default `bg-border` track: the same
 * component sits on a card body, on a bare `bg-border` image placeholder and
 * inside a chart skeleton, and a tint of its own fill is the one track colour
 * that stays visible on all of them. It has to be the precomputed line tone,
 * not `bg-primary/20` — an alpha modifier on a var() colour compiles to no
 * rule at all (see global.css) and the track disappears everywhere. The softer
 * `primary-soft` is not enough either: on dark it lands within a shade of
 * `bg-border`, so the placeholder case would still show a track-less bar.
 */
const TRACK = 'bg-primary-line'

type DownloadStatusProps = {
  relPath: string
  /**
   * Size the sender recorded, used only until the transport reports its own.
   * Delivered files carry none, hence the optional.
   */
  expectedBytes?: number
  /**
   * `block` centres the glyph, bar and status inside the space the loaded card
   * has already reserved — it is absolutely positioned, so it cannot change a
   * skeleton's footprint. `row` drops the glyph (the card's leading slot shows
   * it) and stacks the bar and status to fill a text column.
   */
  variant?: 'block' | 'row'
  /**
   * `row` only: points between the bar and the status. Match the gap of the
   * column it is dropped into, or the loading card ends up a hair taller or
   * shorter than the loaded one and the feed shifts when the file lands.
   */
  rowGap?: number
}

export function DownloadStatus({
  relPath,
  expectedBytes,
  variant = 'block',
  rowGap = 4
}: DownloadStatusProps): React.JSX.Element {
  const { fraction, status } = useTransfer(relPath, expectedBytes)

  if (variant === 'row') {
    return (
      <View className="w-full flex-col" style={{ gap: rowGap }}>
        <ProgressBar value={fraction} className={TRACK} />
        <Text
          numberOfLines={1}
          className="text-muted font-sans text-left text-[10px]"
          // Pinned, not left to the platform: this line is the third row in a
          // column sized for the loaded card's two, and the default leading for
          // a 10pt font would push it past the card's height.
          style={{ lineHeight: 12 }}
        >
          {status}
        </Text>
      </View>
    )
  }

  return (
    <View
      // Absolute, and pointer-transparent: the placeholder around it owns the
      // footprint the loaded card will take, and this must not touch it.
      pointerEvents="none"
      className="absolute inset-0 items-center justify-center gap-2 px-6"
    >
      <Download01Icon size={22} className="text-muted" />
      <View className="w-full max-w-[180px]">
        <ProgressBar value={fraction} className={TRACK} />
      </View>
      <Text numberOfLines={1} className="text-muted font-sans text-center text-[10px]">
        {status}
      </Text>
    </View>
  )
}

/** The glyph a row card puts in its leading slot while the file transfers. */
export function DownloadGlyph({ size = 18 }: { size?: number }): React.JSX.Element {
  return <Download01Icon size={size} className="text-muted" />
}
