import { Button } from '@components/core/Button'
import { Modal } from '@components/core/Modal'
import { useToast } from '@components/core/toast/useToast'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

export type PowerAction = 'restart' | 'reboot'

/**
 * The one confirmation both rail entries share: Restart brings Wolffish back
 * as a fresh process, Reboot takes the whole machine down. Once confirmed the
 * closing overlay takes over by broadcast, here and in every browser.
 */
export function PowerDialog({
  action,
  onClose
}: {
  action: PowerAction | null
  onClose: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const toast = useToast()
  const [busy, setBusy] = useState(false)
  // Only a machine that starts Wolffish by itself gets it back after a reboot.
  const [comesBack, setComesBack] = useState(true)
  const [shown, setShown] = useState<PowerAction>('restart')
  if (action && action !== shown) setShown(action)

  useEffect(() => {
    if (action !== 'reboot') return
    let live = true
    void window.api.runtime
      .getLaunchAtStartupStatus()
      .then((s) => live && setComesBack(s.active))
      .catch(() => undefined)
    return () => {
      live = false
    }
  }, [action])

  const handleClose = (): void => {
    if (busy) return
    onClose()
  }

  const onConfirm = async (): Promise<void> => {
    setBusy(true)
    try {
      if (shown === 'restart') {
        const result = await window.api.app.restart()
        if (!result.scheduled) throw new Error('busy')
        return
      }
      const result = await window.api.app.rebootDevice()
      if (result.scheduled) return
      setBusy(false)
      const key =
        result.error === 'permission'
          ? 'settings.power.reboot.permissionToast'
          : result.error === 'unsupported'
            ? 'settings.power.reboot.unsupportedToast'
            : 'settings.power.reboot.errorToast'
      toast.show({ tone: 'error', message: t(key) })
    } catch {
      setBusy(false)
      toast.show({ tone: 'error', message: t(`settings.power.${shown}.errorToast`) })
    }
  }

  const k = `settings.power.${shown}`

  return (
    <Modal
      open={action !== null}
      onClose={handleClose}
      dismissable={!busy}
      title={t(`${k}.title`)}
      footer={
        <>
          <Button size="md" variant="primary" disabled={busy} onClick={() => void onConfirm()}>
            {busy ? t(`${k}.working`) : t(`${k}.confirm`)}
          </Button>
          <Button size="md" variant="ghost" onClick={handleClose} disabled={busy}>
            {t('settings.power.cancel')}
          </Button>
        </>
      }
    >
      <p>{t(`${k}.warning`)}</p>
      {shown === 'reboot' && !comesBack && (
        <p className="mt-2 text-amber-600 dark:text-amber-400">{t(`${k}.noAutostart`)}</p>
      )}
    </Modal>
  )
}
