import { Redirect } from 'expo-router'

// Deep links can carry any wolffi.sh path; the app has no matching routes for
// most of them, so land every unmatched URL on the home screen instead of
// expo-router's default unmatched-route screen.
export default function NotFound(): React.JSX.Element {
  return <Redirect href="/" />
}
