import * as Updates from 'expo-updates'
import { DevSettings } from 'react-native'

/**
 * Restarts the app — DevSettings in development, Updates.reloadAsync in
 * production (works without OTA updates configured; it reloads the embedded
 * bundle). The growth-app restartApp pattern.
 */
export async function restartApp(): Promise<void> {
  if (__DEV__) {
    DevSettings.reload()
    return
  }
  await Updates.reloadAsync()
}
