import { router } from 'expo-router'

/**
 * The back arrow on a screen that is not always reached from somewhere.
 *
 * Every screen in this app is normally pushed over chat, so `router.back()` is
 * the whole story — until a notification tap opens one DIRECTLY at launch. The
 * entry screen redirects rather than pushes (there is nothing behind it worth
 * keeping), so a tap that names a settings page or History lands on a stack of
 * one, where back is a button that does nothing. Falling through to chat is
 * what "back" means there: the app.
 */
export function goBack(): void {
  if (router.canGoBack()) {
    router.back()
    return
  }
  router.replace('/chat')
}
