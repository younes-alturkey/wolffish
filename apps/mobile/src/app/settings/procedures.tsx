import { Redirect } from 'expo-router'

/**
 * Procedures is a tab of the Library screen now. The route stays because it is on
 * the deep-link allowlist both repos share (DEEPLINK_ROUTES): a notification
 * the desktop sends naming it must still land on this list, so it redirects
 * into the Library with the tab preselected rather than going dark.
 */
export default function ProceduresRoute(): React.JSX.Element {
  return <Redirect href="/settings/library?tab=procedures" />
}
