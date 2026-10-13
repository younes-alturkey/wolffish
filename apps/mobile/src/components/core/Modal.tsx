import { useTheme } from '@/providers/theme/useTheme'
import { cn } from '@/lib/utils/cn'
import { BlurView } from 'expo-blur'
import type { ReactNode } from 'react'
import { Modal as RNModal, Pressable, StyleSheet, Text, View } from 'react-native'

export type ModalProps = {
  open: boolean
  onClose: () => void
  title?: string
  /**
   * Rendered on the TITLE's row, at its trailing edge — a view switch, a count,
   * anything that belongs to the dialog as a whole rather than to its body. Kept
   * out of `children` so it stays put while the body scrolls or swaps.
   */
  titleAccessory?: ReactNode
  children: ReactNode
  /** Optional footer area for action buttons. */
  footer?: ReactNode
  /** Backdrop tap / back button dismissable (default true). */
  dismissable?: boolean
  /** Extra classes for the dialog panel. */
  className?: string
  /**
   * Fired once the dialog has finished going away — iOS only, which is the
   * only platform that needs it. A dialog is a presented view controller
   * there, so anything else that presents one (a system picker, a share
   * sheet) must wait for this: started during the dismissal it is torn down
   * with the dialog, silently. `onClose` is the intent, this is the fact.
   */
  onDismiss?: () => void
}

/**
 * Dialog surface — the React Native counterpart of wolffish-app Modal.tsx:
 * dimmed glass backdrop, centered surface card, title/body/footer stack.
 */
export function Modal({
  open,
  onClose,
  title,
  titleAccessory,
  children,
  footer,
  dismissable = true,
  className,
  onDismiss
}: ModalProps): React.JSX.Element {
  const { isDark } = useTheme()
  return (
    <RNModal
      visible={open}
      transparent
      animationType="fade"
      onDismiss={onDismiss}
      onRequestClose={() => {
        if (dismissable) onClose()
      }}
    >
      <View className="flex-1 items-center justify-center p-4">
        {/* Same glass backdrop as the Select modal — the mobile equivalent of
            the desktop Modal's bg-black/40 backdrop-blur-sm. */}
        <BlurView
          pointerEvents="none"
          intensity={20}
          tint={isDark ? 'dark' : 'light'}
          blurMethod="dimezisBlurView"
          style={StyleSheet.absoluteFill}
        />
        <View pointerEvents="none" className="absolute inset-0 bg-black/40" />
        {/* The dismiss target is a sibling BEHIND the card, not an ancestor of
            it: as an ancestor it competed with the card's own content for the
            touch responder, and a scrolling body inside a dialog never moved. */}
        <Pressable
          accessibilityRole="none"
          onPress={dismissable ? onClose : undefined}
          style={StyleSheet.absoluteFill}
        />
        <View
          className={cn(
            'bg-surface border-border w-full max-w-md flex-col gap-4 rounded-2xl border p-6 shadow-lg',
            className
          )}
        >
          {(title || titleAccessory) && (
            <View className="flex-row items-center justify-between gap-3">
              {title ? (
                <Text
                  numberOfLines={1}
                  className="text-fg font-sans-semibold min-w-0 flex-1 text-left text-lg"
                >
                  {title}
                </Text>
              ) : (
                <View className="flex-1" />
              )}
              {titleAccessory}
            </View>
          )}
          <View className="flex-col gap-3">{children}</View>
          {footer && <View className="pt-2">{footer}</View>}
        </View>
      </View>
    </RNModal>
  )
}
