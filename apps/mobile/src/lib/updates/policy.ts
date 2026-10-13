/**
 * Minimum quiet time between OTA update checks. expo-updates already checks
 * at every cold start (checkAutomatically: ON_LOAD); this throttles the
 * extra foreground checks so quick app switches don't hammer the update
 * server or the user's battery.
 */
export const CHECK_INTERVAL_MS = 5 * 60 * 1000

/** Whether enough quiet time has passed since the last check to check again. */
export function isCheckDue(lastCheckedAtMs: number, nowMs: number): boolean {
  return nowMs - lastCheckedAtMs >= CHECK_INTERVAL_MS
}
