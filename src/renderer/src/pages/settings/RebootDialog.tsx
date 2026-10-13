import { Button } from '@components/core/Button'
import { Modal } from '@components/core/Modal'
import { useToast } from '@components/core/toast/useToast'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'

export function RebootDialog({
  open,
  onClose
}: {
  open: boolean
  onClose: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const toast = useToast()
  const [rebooting, setRebooting] = useState(false)

  const handleClose = (): void => {
    if (rebooting) return
    onClose()
  }

  const onConfirm = async (): Promise<void> => {
    setRebooting(true)
    try {
      const result = await window.api.app.reboot()
      if (!result.scheduled) throw new Error('busy')
    } catch {
      setRebooting(false)
      toast.show({ tone: 'error', message: t('settings.reboot.errorToast') })
    }
  }

  return (
    <Modal
      open={open}
      onClose={handleClose}
      dismissable={!rebooting}
      title={t('settings.reboot.title')}
      footer={
        <>
          <Button size="md" variant="primary" disabled={rebooting} onClick={() => void onConfirm()}>
            {rebooting ? t('settings.reboot.rebooting') : t('settings.reboot.confirm')}
          </Button>
          <Button size="md" variant="ghost" onClick={handleClose} disabled={rebooting}>
            {t('settings.reboot.cancel')}
          </Button>
        </>
      }
    >
      <p>{t('settings.reboot.warning')}</p>
    </Modal>
  )
}
