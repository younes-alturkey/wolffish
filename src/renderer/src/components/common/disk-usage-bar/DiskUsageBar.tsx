import { useTranslation } from 'react-i18next'
import { cn } from '@lib/utils/cn'
import { formatBytesL } from '@lib/utils/format'

type Props = {
  freeBytes: number | null
  totalBytes: number | null
}

/**
 * Disk usage label + progress bar with tiered colors:
 *   <50% used → emerald, 50–<80% → amber, ≥80% → red.
 * Tones match the toast palette so "this is fine / pay attention / act now"
 * reads consistently across the app. Falls back to a full red bar with em-dash
 * labels when free or total are null — this is the only way to ever read as
 * "broken", which is the right signal in that edge case.
 */
export function DiskUsageBar({ freeBytes, totalBytes }: Props): React.JSX.Element {
  const { t } = useTranslation()
  const usedPercent =
    totalBytes != null && freeBytes != null && totalBytes > 0
      ? Math.min(100, Math.max(0, ((totalBytes - freeBytes) / totalBytes) * 100))
      : 100
  const fillColor =
    usedPercent >= 80
      ? 'bg-red-500 dark:bg-red-400'
      : usedPercent >= 50
        ? 'bg-amber-500 dark:bg-amber-400'
        : 'bg-emerald-500 dark:bg-emerald-400'
  const freeLabel = formatBytesL(freeBytes, t)
  const totalLabel = formatBytesL(totalBytes, t)
  const percent = Math.round(usedPercent)

  return (
    <div className="flex flex-col gap-1.5">
      <div className="text-muted flex justify-between text-xs">
        <span>{t('common.diskUsage', { free: freeLabel, total: totalLabel })}</span>
        <span className="tabular-nums">{percent}%</span>
      </div>
      <div
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
        className="bg-bg border-border h-1.5 w-full overflow-hidden rounded-full border"
      >
        <div
          className={cn('h-full rounded-full transition-[width] duration-150 ease-out', fillColor)}
          style={{ width: `${usedPercent}%` }}
        />
      </div>
    </div>
  )
}
