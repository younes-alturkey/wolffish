import { Cancel01Icon } from '@/components/core/icons'
import { TONE_TEXT, ToneIcon } from '@/components/core/Alert'
import { cn } from '@/lib/utils/cn'
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Pressable, Text, View } from 'react-native'
import Animated, { FadeInDown, FadeInUp, FadeOut } from 'react-native-reanimated'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import {
  ToastContext,
  type ToastContextValue,
  type ToastInput,
  type ToastTone
} from '@/providers/toast/useToast'

type Toast = ToastInput & { id: number }

const DEFAULT_DURATION_MS = 3500

// Tone container styles mirror wolffish-app ToastProvider TONE_STYLES.
const TONE_CONTAINER: Record<ToastTone, string> = {
  info: 'bg-surface border-border',
  success: 'bg-emerald-50 border-emerald-300 dark:bg-emerald-900/40 dark:border-emerald-700',
  warning: 'bg-amber-50 border-amber-300 dark:bg-amber-900/40 dark:border-amber-700',
  error: 'bg-red-50 border-red-300 dark:bg-red-900/40 dark:border-red-700'
}

export function ToastProvider({ children }: { children: ReactNode }): React.JSX.Element {
  const [toasts, setToasts] = useState<Toast[]>([])
  const idRef = useRef(0)
  const timersRef = useRef<Map<number, ReturnType<typeof setTimeout>>>(new Map())
  const insets = useSafeAreaInsets()

  const dismiss = useCallback((id: number) => {
    setToasts((prev) => prev.filter((t) => t.id !== id))
    const timer = timersRef.current.get(id)
    if (timer) {
      clearTimeout(timer)
      timersRef.current.delete(id)
    }
  }, [])

  const show = useCallback(
    (input: ToastInput): number => {
      const id = ++idRef.current
      const toast: Toast = {
        id,
        tone: input.tone ?? 'info',
        durationMs: input.durationMs ?? DEFAULT_DURATION_MS,
        sticky: input.sticky ?? false,
        placement: input.placement ?? 'bottom',
        message: input.message,
        onPress: input.onPress
      }
      setToasts((prev) => [...prev, toast])
      if (!toast.sticky) {
        const timer = setTimeout(() => dismiss(id), toast.durationMs)
        timersRef.current.set(id, timer)
      }
      return id
    },
    [dismiss]
  )

  useEffect(
    () => () => {
      const timers = timersRef.current
      for (const t of timers.values()) clearTimeout(t)
      timers.clear()
    },
    []
  )

  const value = useMemo<ToastContextValue>(() => ({ show, dismiss }), [show, dismiss])

  // Two stacks: transient toasts keep the classic bottom position; ambient
  // app-state notices (placement: 'top') stack under the status bar.
  const top = toasts.filter((t) => t.placement === 'top')
  const bottom = toasts.filter((t) => t.placement !== 'top')

  return (
    <ToastContext.Provider value={value}>
      {children}
      <View
        pointerEvents="box-none"
        style={{ top: insets.top + 8 }}
        className="absolute inset-x-0 z-50 flex-col items-center gap-2 px-4"
      >
        {top.map((t) => (
          <ToastItem key={t.id} toast={t} onDismiss={() => dismiss(t.id)} />
        ))}
      </View>
      <View
        pointerEvents="box-none"
        style={{ bottom: insets.bottom + 16 }}
        className="absolute inset-x-0 z-50 flex-col items-center gap-2 px-4"
      >
        {bottom.map((t) => (
          <ToastItem key={t.id} toast={t} onDismiss={() => dismiss(t.id)} />
        ))}
      </View>
    </ToastContext.Provider>
  )
}

function ToastItem({
  toast,
  onDismiss
}: {
  toast: Toast
  onDismiss: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const tone = toast.tone ?? 'info'
  const textClass = TONE_TEXT[tone]
  return (
    <Animated.View entering={toast.placement === 'top' ? FadeInDown : FadeInUp} exiting={FadeOut}>
      <Pressable
        accessibilityRole="alert"
        accessibilityLiveRegion="polite"
        onPress={() => {
          toast.onPress?.()
          onDismiss()
        }}
        className={cn(
          'max-w-md flex-row items-start gap-2 rounded-xl border px-4 py-2.5 shadow-md',
          TONE_CONTAINER[tone]
        )}
      >
        <View className="mt-0.5 shrink-0">
          <ToneIcon tone={tone} className={textClass} />
        </View>
        <Text
          className={cn('min-w-0 shrink text-left font-sans text-sm leading-relaxed', textClass)}
        >
          {toast.message}
        </Text>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t('common.dismiss')}
          onPress={onDismiss}
          className="mt-0.5 shrink-0 rounded-md p-0.5 opacity-60 active:opacity-100"
        >
          <Cancel01Icon size={14} className={textClass} />
        </Pressable>
      </Pressable>
    </Animated.View>
  )
}
