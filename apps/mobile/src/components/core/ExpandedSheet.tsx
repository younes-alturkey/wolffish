import { Cancel01Icon } from '@/components/core/icons'
import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Modal as RNModal, Pressable, Text, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'

/**
 * Full-screen sheet for reading a file at full size — the mobile counterpart
 * of the desktop's ExpandedSheet (a centered 90%-viewport dialog there; the
 * phone equivalent of "as big as it gets" is the whole screen). Same
 * dismissal contract as the desktop: only the explicit close control (and the
 * platform back gesture, Android's Escape) closes it, so a stray tap while
 * reading never loses the reader's place.
 */
export function ExpandedSheet({
  open,
  onClose,
  title,
  actions,
  children
}: {
  open: boolean
  onClose: () => void
  /** Shown in the header bar; also the close button's accessible label. */
  title?: string
  /** Controls rendered in the header before the close button. */
  actions?: ReactNode
  children: ReactNode
}): React.JSX.Element {
  const { t } = useTranslation()
  const insets = useSafeAreaInsets()

  return (
    <RNModal visible={open} animationType="slide" onRequestClose={onClose}>
      {/* Surface, not bg: the sheet is the card grown to full screen, and a
          reader mid-file must not watch the page color change under the text. */}
      <View className="bg-surface flex-1" style={{ paddingTop: insets.top }}>
        <View className="border-border-soft flex-row items-center gap-2 border-b px-3 pb-2">
          <Text
            numberOfLines={1}
            className="text-fg font-sans-semibold min-w-0 flex-1 text-left text-base"
          >
            {title}
          </Text>
          {actions}
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t('chat.fileCard.close')}
            hitSlop={8}
            onPress={onClose}
            className="p-1"
          >
            <Cancel01Icon size={18} className="text-muted" />
          </Pressable>
        </View>
        <View className="flex-1" style={{ paddingBottom: insets.bottom }}>
          {children}
        </View>
      </View>
    </RNModal>
  )
}
