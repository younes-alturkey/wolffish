import { ArrowUp02Icon } from '@/components/core/icons'
import { restartApp } from '@/lib/utils/restart'
import { useAppStore } from '@/state/appStore'
import * as Updates from 'expo-updates'
import { useTranslation } from 'react-i18next'
import { Pressable, Text, View } from 'react-native'
import Animated, { FadeInDown, FadeOut } from 'react-native-reanimated'
import { useSafeAreaInsets } from 'react-native-safe-area-context'

/**
 * The downloaded-update notice — the desktop's UpdateCard
 * (common/update-card/UpdateCard.tsx) on a phone: the same arrow in a tinted
 * square, the same title beside a version chip, the same primary Update pill.
 *
 * Two deliberate departures from the desktop. There is no close button: a
 * thumb next to a dismiss X is a thumb about to lose the update by accident,
 * and there is no second chance at it this session. And the whole card is the
 * target rather than the pill alone — the pill says what a tap does, it isn't
 * the only place a tap counts.
 *
 * It floats under the status bar over whatever screen is up, so an update that
 * arrives in the background and one fetched by hand from Settings announce
 * themselves the same way. It replaced a sticky toast whose one line of prose
 * ("A new version is ready — tap to restart") said less than an icon, a
 * version, and a button do.
 */
export function UpdateNotice(): React.JSX.Element | null {
  const { t } = useTranslation()
  const insets = useSafeAreaInsets()
  const enabled = useAppStore((state) => state.otaEnabled)
  const { isUpdatePending, downloadedUpdate } = Updates.useUpdates()

  if (!enabled || !isUpdatePending) return null

  const version = updateVersion(downloadedUpdate)

  return (
    <Animated.View
      pointerEvents="box-none"
      entering={FadeInDown}
      exiting={FadeOut}
      style={{ top: insets.top + 8 }}
      className="absolute inset-x-0 z-40 px-4"
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${t('updates.ready')} — ${t('updates.readyHint')}`}
        onPress={() => {
          void restartApp()
        }}
        className="bg-surface border-border flex-row items-center gap-3 rounded-xl border px-4 py-3 shadow-md active:opacity-90"
      >
        <View className="bg-primary-soft h-8 w-8 shrink-0 items-center justify-center rounded-lg">
          <ArrowUp02Icon size={18} className="text-primary" />
        </View>

        <View className="min-w-0 flex-1 gap-0.5">
          <View className="flex-row items-center gap-2">
            <Text className="text-fg font-sans-medium text-left text-sm">{t('updates.ready')}</Text>
            {version ? (
              <Text className="bg-surface-soft text-fg rounded px-1.5 py-0.5 font-mono text-[11px]">
                v{version}
              </Text>
            ) : null}
          </View>
          <Text numberOfLines={1} className="text-muted text-left font-sans text-xs">
            {t('updates.readyHint')}
          </Text>
        </View>

        <View className="bg-primary shrink-0 rounded-lg px-3 py-1.5">
          <Text className="text-primary-fg font-sans-medium text-xs">{t('updates.install')}</Text>
        </View>
      </Pressable>
    </Animated.View>
  )
}

/**
 * The app version the waiting bundle was published at. Bumping APP_VERSION
 * before each `eas update` keeps this the one number that tells two OTA
 * bundles apart at a glance — and it is read from that bundle's own manifest
 * (`extra.expoClient`, where expo-constants also reads expoConfig from), not
 * from the version currently running.
 *
 * Null when the manifest cannot supply one — an embedded manifest, or a
 * rollback directive, which carries no manifest at all. The chip is then
 * simply absent: a placeholder here would be a version number that is not one.
 */
function updateVersion(update: Updates.UpdateInfo | undefined): string | null {
  const manifest = update?.manifest
  if (!manifest || !('extra' in manifest)) return null
  const version = manifest.extra?.expoClient?.version
  return typeof version === 'string' && version ? version : null
}
