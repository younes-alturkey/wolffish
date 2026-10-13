import { cn } from '@/lib/utils/cn'
import Constants from 'expo-constants'
import * as Updates from 'expo-updates'
import { useTranslation } from 'react-i18next'
import { Text } from 'react-native'

/**
 * One muted line identifying exactly what is running: the manifest version
 * (moves with OTA updates), the native build number (moves only with store
 * builds), and the bundle source — embedded store bundle or an OTA update's
 * short id. The fastest way to confirm an OTA rollout landed on a device.
 */
export function BuildInfo({ className }: { className?: string }): React.JSX.Element {
  const { t } = useTranslation()
  const version = Constants.expoConfig?.version ?? '?'
  const build = Constants.expoConfig?.ios?.buildNumber ?? Constants.expoConfig?.android?.versionCode
  const source = __DEV__
    ? 'dev'
    : !Updates.isEnabled || Updates.isEmbeddedLaunch || !Updates.updateId
      ? t('updates.embedded')
      : `OTA ${Updates.updateId.slice(0, 8)}`
  return (
    <Text className={cn('text-muted text-center font-sans text-xs', className)}>
      {`v${version}${build != null ? ` (${build})` : ''} · ${source}`}
    </Text>
  )
}
