import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  ArrowLeft02Icon,
  ArrowRight02Icon,
  CheckmarkCircle02Icon,
  HardDriveIcon,
  RefreshIcon
} from 'hugeicons-react'
import { Button } from '@components/core/Button'
import { DiskUsageBar } from '@components/common/disk-usage-bar/DiskUsageBar'
import { useToast } from '@components/core/toast/useToast'
import { MIN_FREE_DISK_BYTES } from '@providers/flow/FlowProvider'
import { useFlow } from '@providers/flow/useFlow'
import { useLocale } from '@providers/locale/useLocale'
import { RTL_LOCALES } from '@lib/i18n'
import { formatBytesL } from '@lib/utils/format'
import { cn } from '@lib/utils/cn'

export function LowDiskSpace(): React.JSX.Element {
  const { t } = useTranslation()
  const { locale } = useLocale()
  const isRtl = RTL_LOCALES.has(locale)
  const ArrowIcon = isRtl ? ArrowLeft02Icon : ArrowRight02Icon

  const { revalidateScreen, dismissDiskGate } = useFlow()
  const toast = useToast()
  const [freeBytes, setFreeBytes] = useState<number | null | undefined>(undefined)
  const [totalBytes, setTotalBytes] = useState<number | null>(null)
  const [checking, setChecking] = useState(false)
  const [continuing, setContinuing] = useState(false)

  const detect = async (): Promise<number | null> => {
    setChecking(true)
    try {
      // Pin a minimum 500ms so the spinner + disabled state are always
      // observable. statfs returns in microseconds otherwise.
      const [info] = await Promise.all([
        window.api.system.getInfo(),
        new Promise((resolve) => setTimeout(resolve, 500))
      ])
      setFreeBytes(info.freeDiskBytes)
      setTotalBytes(info.totalDiskBytes)
      return info.freeDiskBytes
    } finally {
      setChecking(false)
    }
  }

  // User-initiated check — always answer with a toast: success when enough
  // space was found, warning when still low. Silent detect is used for the
  // initial mount so we don't spam toasts.
  const onRecalculateClick = async (): Promise<void> => {
    const bytes = await detect()
    if (bytes != null && bytes >= MIN_FREE_DISK_BYTES) {
      toast.show({
        tone: 'success',
        message: t('lowDiskSpace.toast.enough', { free: formatBytesL(bytes, t) })
      })
      return
    }
    toast.show({
      tone: 'warning',
      message: t('lowDiskSpace.toast.stillLow')
    })
  }

  useEffect(() => {
    // detect() flips setChecking(true) on its first line, which would be
    // a synchronous setState in the effect body. Defer it via a microtask
    // so the state update lands after the effect returns.
    queueMicrotask(() => {
      void detect()
    })
  }, [])

  const onContinue = async (): Promise<void> => {
    setContinuing(true)
    try {
      await revalidateScreen()
    } finally {
      setContinuing(false)
    }
  }

  // Close the warning without freeing space. Session-only: the warning
  // returns on the next launch if the disk is still low. From here on any
  // disk-full failures are the user's call — they were warned.
  const onContinueAnyway = async (): Promise<void> => {
    setContinuing(true)
    try {
      await dismissDiskGate()
    } finally {
      setContinuing(false)
    }
  }

  // Until the very first detect() resolves we don't know how much space is
  // free. Show a single neutral "checking" state in that window so the UI
  // doesn't flash a wrong assumption.
  const knowState = freeBytes !== undefined
  const sufficient = freeBytes != null && freeBytes >= MIN_FREE_DISK_BYTES
  const minLabel = formatBytesL(MIN_FREE_DISK_BYTES, t)
  const freeLabel = formatBytesL(freeBytes, t)

  return (
    <main className="bg-bg flex min-h-full w-full items-center justify-center px-6 py-12">
      <div className="flex w-full max-w-md flex-col gap-6">
        <header className="flex flex-col items-center gap-2 text-center">
          <h1 className="text-fg text-2xl font-semibold tracking-tight">
            {!knowState
              ? t('lowDiskSpace.titleChecking')
              : sufficient
                ? t('lowDiskSpace.titleOk')
                : t('lowDiskSpace.title')}
          </h1>
          <p className="text-muted text-sm leading-relaxed">
            {!knowState
              ? t('lowDiskSpace.subtitleChecking')
              : sufficient
                ? t('lowDiskSpace.subtitleOk')
                : t('lowDiskSpace.subtitle', { min: minLabel })}
          </p>
        </header>

        <section
          className={cn(
            'border-border bg-surface rounded-2xl border p-6 shadow-sm dark:shadow-none',
            'flex flex-col gap-4'
          )}
        >
          {!knowState ? (
            <div className="flex flex-col items-center gap-3 py-2 text-center">
              <HardDriveIcon size={36} className="text-muted" />
              <p className="text-fg text-base font-medium">{t('lowDiskSpace.checkingTitle')}</p>
              <p className="text-muted text-sm leading-relaxed">{t('lowDiskSpace.checking')}</p>
            </div>
          ) : sufficient ? (
            <div className="flex flex-col items-center gap-3 py-2 text-center">
              <CheckmarkCircle02Icon size={36} className="text-accent" />
              <p className="text-fg text-base font-medium">
                {t('lowDiskSpace.enough', { free: freeLabel })}
              </p>
              <p className="text-muted text-sm leading-relaxed">{t('lowDiskSpace.enoughHint')}</p>
            </div>
          ) : (
            <div className="flex flex-col gap-4">
              <div className="flex flex-col items-center gap-3 py-2 text-center">
                <HardDriveIcon size={36} className="text-muted" />
                <p className="text-muted text-sm leading-relaxed">
                  {t('lowDiskSpace.hint', { free: freeLabel, min: minLabel })}
                </p>
              </div>
              <DiskUsageBar freeBytes={freeBytes} totalBytes={totalBytes} />
              <Button size="lg" disabled={checking} onClick={() => void onRecalculateClick()}>
                <RefreshIcon size={18} className={checking ? 'animate-spin' : ''} />
                <span>{t('lowDiskSpace.recalculate')}</span>
              </Button>
            </div>
          )}
        </section>

        {!knowState && (
          <Button size="lg" disabled>
            <RefreshIcon size={18} className="animate-spin" />
            <span>{t('lowDiskSpace.recalculate')}</span>
          </Button>
        )}

        {sufficient && (
          <Button size="lg" disabled={continuing} onClick={() => void onContinue()}>
            <span>{t('lowDiskSpace.continue')}</span>
            <ArrowIcon size={18} />
          </Button>
        )}

        {knowState && !sufficient && (
          <div className="flex flex-col gap-2">
            <Button
              size="lg"
              variant="ghost"
              disabled={continuing}
              onClick={() => void onContinueAnyway()}
            >
              <span>{t('lowDiskSpace.continueAnyway')}</span>
              <ArrowIcon size={18} />
            </Button>
            <p className="text-muted text-center text-xs leading-relaxed">
              {t('lowDiskSpace.continueAnywayHint')}
            </p>
          </div>
        )}
      </div>
    </main>
  )
}
