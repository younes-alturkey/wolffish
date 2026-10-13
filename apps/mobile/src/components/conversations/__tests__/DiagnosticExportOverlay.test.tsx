/**
 * The Debug button's overlay, in the one state that has no analogue on the
 * desktop: the archive coming down the relay.
 *
 * The counter is the whole point of these. Its first frame lands a full
 * round-trip before any byte does (the file's stat), so a formatter that draws
 * zero as nothing — which is right for a file card of unknown size — spends
 * that round-trip showing " / 660 KB", which reads as a stalled or broken
 * transfer. It reads "0 KB" instead, in the total's unit, and stays in that
 * unit as it climbs rather than walking B → KB → MB against a fixed total.
 */

// The overlay's Button reaches the store, which reaches the tunnel client,
// which touches AsyncStorage at import time.
jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock')
)

jest.mock('expo-sharing', () => ({ shareAsync: jest.fn(async () => undefined) }))

jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 47, bottom: 34, left: 0, right: 0 })
}))

/**
 * The export itself is the desktop's job and is mocked whole: what is under
 * test is what the overlay draws for a phase, so the test queues phases and the
 * mock replays them. Replayed from INSIDE the call — that is the mount effect,
 * which render() already has inside act — rather than pushed in from the test
 * body afterwards, which would settle state outside any act scope.
 *
 * The promise never settles, which is what holds the overlay in its running
 * state instead of falling through to the finished card.
 *
 * `mock`-prefixed so jest's hoisting lets the factory close over them, and the
 * sink is a named alias rather than an inline function type: the hoist check
 * runs before types are stripped and reads a parameter name inside an
 * annotation as an out-of-scope variable access.
 */
type PhaseSink = (phase: DiagnosticPhase) => void
const mockPhases: { current: DiagnosticPhase[] } = { current: [] }

jest.mock('@/lib/sync/diagnostics', () => ({
  onDiagnosticProgress: () => () => undefined,
  exportDiagnostics: (_id: string, onPhase: PhaseSink) => {
    mockPhases.current.forEach(onPhase)
    return new Promise(() => undefined)
  }
}))

import { DiagnosticExportOverlay } from '@/components/conversations/DiagnosticExportOverlay'
// Initializes i18next, so the overlay renders its copy rather than raw keys.
import '@/lib/i18n'
import type { DiagnosticPhase } from '@/lib/sync/diagnostics'
import { render, screen, waitFor } from '@testing-library/react-native'

const TOTAL = 660 * 1024

/**
 * Awaited, as every screen test here is: a bare `render()` called from inside a
 * helper never binds `screen`, and every later query then fails with "render
 * function has not been called" rather than with what is actually wrong.
 */
async function mountAt(...phases: DiagnosticPhase[]): Promise<void> {
  mockPhases.current = phases
  await render(<DiagnosticExportOverlay conversationId="conv-1" onClose={() => undefined} />)
}

afterEach(() => {
  mockPhases.current = []
})

it('counts the download from zero rather than leaving the received side blank', async () => {
  await mountAt({ kind: 'downloading', receivedBytes: 0, totalBytes: TOTAL })
  await waitFor(() => expect(screen.getByText('Downloading the archive')).toBeTruthy())
  expect(screen.getByText('0 KB / 660 KB')).toBeTruthy()
})

it('holds the received side in the total’s unit once bytes arrive', async () => {
  await mountAt({ kind: 'downloading', receivedBytes: 512, totalBytes: TOTAL })
  await waitFor(() => expect(screen.getByText('1 KB / 660 KB')).toBeTruthy())
})

it('never counts past the total', async () => {
  await mountAt({ kind: 'downloading', receivedBytes: TOTAL + 4096, totalBytes: TOTAL })
  await waitFor(() => expect(screen.getByText('660 KB / 660 KB')).toBeTruthy())
})

it('shows the desktop’s step count while it is still collecting', async () => {
  await mountAt()
  await waitFor(() => expect(screen.getByText(/^0 \/ \d+$/)).toBeTruthy())
})
