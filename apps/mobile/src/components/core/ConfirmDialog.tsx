import { Button } from '@/components/core/Button'
import { Modal } from '@/components/core/Modal'
import { Text, View } from 'react-native'

export type ConfirmDialogProps = {
  open: boolean
  title: string
  message: string
  confirmLabel: string
  cancelLabel: string
  onConfirm: () => void
  onCancel: () => void
  /** Disables both actions while the confirmed action is running. */
  busy?: boolean
}

/**
 * Confirmation dialog in the wolffish dialog style: stacked full-width
 * actions, primary on top — the pattern the desktop app uses for its
 * Modal footers.
 */
export function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel,
  cancelLabel,
  onConfirm,
  onCancel,
  busy = false
}: ConfirmDialogProps): React.JSX.Element {
  return (
    <Modal
      open={open}
      onClose={onCancel}
      title={title}
      dismissable={!busy}
      footer={
        <View className="flex-row gap-2">
          <Button variant="ghost" disabled={busy} onPress={onCancel} className="flex-1">
            {cancelLabel}
          </Button>
          <Button disabled={busy} onPress={onConfirm} className="flex-1">
            {confirmLabel}
          </Button>
        </View>
      }
    >
      <Text className="text-fg text-left font-sans text-sm leading-relaxed">{message}</Text>
    </Modal>
  )
}
