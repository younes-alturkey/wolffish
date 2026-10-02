import { cn } from '@lib/utils/cn'
import type { UpdaterErrorInfo, UpdateReadyEvent } from '@preload/index'
import { useFlow } from '@providers/flow/useFlow'
import { ArrowUp02Icon, Cancel01Icon } from 'hugeicons-react'
import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

let cachedUpdate: UpdateReadyEvent | null = null

export function UpdateCard(): React.JSX.Element | null {
  const { t } = useTranslation()
  const { status } = useFlow()
  const [update, setUpdate] = useState<UpdateReadyEvent | null>(cachedUpdate)
  const [dismissed, setDismissed] = useState(false)
  const [installing, setInstalling] = useState(false)
  // The install failed (main broadcast the error phase). Shown in place of the
  // release notes; the button turns into Retry, which re-runs the check — the
  // artifact is cached, so 'ready' comes back in seconds and clears this.
  const [failed, setFailed] = useState<UpdaterErrorInfo | null>(null)

  useEffect(() => {
    if (status?.config?.updates?.enabled === false) return
    let cancelled = false
    void window.api.updater.getReady().then((event) => {
      if (cancelled || !event) return
      cachedUpdate = event
      setUpdate((prev) => prev ?? event)
    })
    const unsub = window.api.updater.onReady((event) => {
      cachedUpdate = event
      setUpdate(event)
      setFailed(null)
      setInstalling(false)
    })
    // Without this the card stayed pinned on a dimmed, dead button forever
    // after a failed install — nothing else ever reset the flag.
    const unsubState = window.api.updater.onState((s) => {
      if (s.phase === 'error') {
        setInstalling(false)
        setFailed(s.error)
      }
    })
    return () => {
      cancelled = true
      unsub()
      unsubState()
    }
  }, [status?.config?.updates?.enabled])

  const handleInstall = useCallback(() => {
    if (failed) {
      // Retry: the check finds the cached artifact and re-emits ready.
      setFailed(null)
      void window.api.updater.check()
      return
    }
    setInstalling(true)
    void window.api.updater.install()
  }, [failed])

  if (!update || dismissed) return null
  if (status?.config?.updates?.enabled === false) return null

  return (
    <div
      className={cn(
        'bg-surface border-border mx-auto flex w-full max-w-2xl items-center gap-3 rounded-xl border px-4 py-3',
        'shadow-sm'
      )}
    >
      <div className="bg-primary/10 text-primary flex h-8 w-8 shrink-0 items-center justify-center rounded-lg">
        <ArrowUp02Icon size={18} />
      </div>

      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <div className="flex items-center gap-2">
          <span className="text-fg text-sm font-medium">
            {t('update.available', 'Update available')}
          </span>
          <code className="bg-border/50 text-fg rounded px-1.5 py-0.5 text-xs font-mono">
            v{update.version}
          </code>
        </div>
        {failed ? (
          <p className="truncate text-xs text-red-700 dark:text-red-200">
            {t(`settings.updates.errors.${failed.code}`, failed.message)}
          </p>
        ) : (
          update.releaseNotes && (
            <p className="text-muted truncate text-xs">{update.releaseNotes}</p>
          )
        )}
      </div>

      <div className="flex shrink-0 items-center gap-1.5">
        <button
          type="button"
          onClick={() => setDismissed(true)}
          disabled={installing}
          aria-label={t('common.close', 'Close')}
          className={cn(
            'text-muted hover:text-fg rounded-lg p-1',
            'hover:bg-border/40',
            'focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg',
            installing ? 'cursor-not-allowed opacity-40' : 'cursor-pointer'
          )}
        >
          <Cancel01Icon size={14} />
        </button>

        <button
          type="button"
          onClick={handleInstall}
          disabled={installing}
          className={cn(
            'bg-primary text-primary-fg flex items-center gap-1 rounded-lg px-3 py-1.5 text-xs font-medium shadow-sm',
            'hover:bg-primary/90',
            'focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg',
            installing ? 'cursor-not-allowed opacity-60' : 'cursor-pointer'
          )}
        >
          {/* The label never becomes "Installing…" — the button stays Update and
              only dims, so the card reads the same the whole way through. */}
          <span>{failed ? t('update.retry', 'Retry') : t('update.install', 'Update')}</span>
        </button>
      </div>
    </div>
  )
}
