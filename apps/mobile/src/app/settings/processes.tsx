import { Redirect } from 'expo-router'

/**
 * Processes is a tab of the Library screen. The route exists because it is on
 * the deep-link allowlist both repos share (DEEPLINK_ROUTES): a notification
 * the desktop sends naming it must land on this list, so it redirects into the
 * Library with the tab preselected rather than going dark.
 */
export default function ProcessesRoute(): React.JSX.Element {
  return <Redirect href="/settings/library?tab=processes" />
}
