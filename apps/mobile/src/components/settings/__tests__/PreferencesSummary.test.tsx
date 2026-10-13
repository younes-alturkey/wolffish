jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock')
)

/**
 * The Preferences row's summary: whether the desktop comes up on its own, then
 * whether the agent still stops to ask.
 *
 * Both halves are read from the store per render rather than at mount, because
 * both are the desktop's to change while this list is open — `launchAtStartup`
 * is a login item only that machine can register, and it lands here the same
 * way every other mirrored preference does, through a snapshot.
 *
 * The colour is the other assertion, and each half carries its own: green when
 * the machine acts on its own, amber when it will not — an off that is
 * announced from the list rather than found by opening the tab. A tone that
 * followed the wrong half would look exactly as deliberate as the right one.
 *
 * No hand-rolled `act`: store writes are settled by waitFor.
 */

jest.mock('expo-localization', () => ({ getLocales: () => [{ languageCode: 'en' }] }))

import { PreferencesSummary } from '@/components/settings/TabSummaries'
import { useDemoConfig } from '@/state/demoConfig'
import { cleanup, render, screen, waitFor } from '@testing-library/react-native'
import '@/lib/i18n'

/** Awaited: render resolves asynchronously, and `screen` is empty until it does. */
async function draw(): Promise<void> {
  await render(<PreferencesSummary />)
}

/** The colour classes the summary paints with, as TabSummaries spells them. */
const OK = 'text-emerald-600 dark:text-emerald-400'
const WARN = 'text-amber-600 dark:text-amber-400'
const MUTED = 'text-muted'

const classesOf = (text: string): string =>
  (screen.getByText(text) as unknown as { props: { className: string } }).props.className

afterEach(cleanup)

describe('Preferences summary', () => {
  it('states both preferences, startup first, in the panel’s own order', async () => {
    useDemoConfig.setState({ launchAtStartup: true, bypassPermissions: true })
    await draw()
    expect(screen.getByText('Startup On')).toBeTruthy()
    expect(screen.getByText('Bypass On')).toBeTruthy()
  })

  it('follows the store, so a desktop change moves the row without a remount', async () => {
    useDemoConfig.setState({ launchAtStartup: false, bypassPermissions: true })
    await draw()
    expect(screen.getByText('Startup Off')).toBeTruthy()
    // What a snapshot carrying the desktop's own preferences amounts to.
    useDemoConfig.setState({ launchAtStartup: true, bypassPermissions: false })
    await waitFor(() => expect(screen.getByText('Startup On')).toBeTruthy())
    expect(screen.getByText('Bypass Off')).toBeTruthy()
  })

  it('colours each half from its own state, never from its neighbour’s', async () => {
    useDemoConfig.setState({ launchAtStartup: true, bypassPermissions: false })
    await draw()
    expect(classesOf('Startup On')).toContain(OK)
    expect(classesOf('Bypass Off')).toContain(WARN)
  })

  it('turns amber the moment either one goes off', async () => {
    useDemoConfig.setState({ launchAtStartup: false, bypassPermissions: true })
    await draw()
    expect(classesOf('Startup Off')).toContain(WARN)
    expect(classesOf('Bypass On')).toContain(OK)
    // Neither half falls back to the muted grey the plain summaries print.
    expect(classesOf('Startup Off')).not.toContain(MUTED)
  })
})
