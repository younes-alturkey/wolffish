jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock')
)

/**
 * The Data row's summary chip: the desktop's workspace, then what this phone
 * has downloaded, one dot between them.
 *
 * Two figures from two machines in one chip is exactly where a wrong em dash
 * hides. The desktop's side is a mirror — no snapshot means no number, and
 * printing `0 B` there would claim an empty workspace on a machine this
 * device has never measured. The phone's side is a live measurement, so its
 * em dash means "not counted yet" and has to give way to `0 B` the moment the
 * count comes back empty. Both dashes render identically, so only the source
 * they came from tells them apart — hence the assertions below.
 */

const mockCacheUsage = jest.fn<Promise<{ totalBytes: number; fileCount: number }>, []>()

jest.mock('@/lib/files/fileCache', () => ({
  getCacheUsage: () => mockCacheUsage()
}))
jest.mock('@/lib/conversations/repo', () => ({ countConversations: async () => 0 }))
jest.mock('expo-localization', () => ({ getLocales: () => [{ languageCode: 'en' }] }))

import { DataSummary } from '@/components/settings/TabSummaries'
import { queryClient } from '@/lib/query/queryClient'
import { useDemoConfig } from '@/state/demoConfig'
import { QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen, waitFor } from '@testing-library/react-native'

const NO_DESKTOP = {
  freeDiskBytes: null,
  totalDiskBytes: null,
  workspaceBytes: null,
  hippocampusBytes: null,
  corpusBytes: null,
  prefrontalBytes: null,
  ramBytes: null,
  totalRamBytes: null,
  cpuPercent: null,
  cpuCount: null
}

/** Awaited: render resolves asynchronously, and `screen` is empty until it does. */
async function draw(): Promise<void> {
  await render(
    <QueryClientProvider client={queryClient}>
      <DataSummary />
    </QueryClientProvider>
  )
}

beforeEach(() => {
  mockCacheUsage.mockReset()
  mockCacheUsage.mockResolvedValue({ totalBytes: 0, fileCount: 0 })
  useDemoConfig.setState({ desktopData: NO_DESKTOP })
})

afterEach(() => {
  cleanup()
  // Every query that loses its last observer arms a 7-day gc timer, and the
  // worker will not exit while one is pending.
  queryClient.clear()
})

describe('Data summary', () => {
  it('prints the desktop workspace and this phone’s downloads, dot separated', async () => {
    useDemoConfig.setState({ desktopData: { ...NO_DESKTOP, workspaceBytes: 4_704_356_511 } })
    mockCacheUsage.mockResolvedValue({ totalBytes: 125_829_120, fileCount: 12 })
    await draw()
    await waitFor(() => expect(screen.getByText('4.38 GB · 120.0 MB')).toBeTruthy())
  })

  it('dashes the desktop side until a snapshot lands, and never zeroes it', async () => {
    await draw()
    await waitFor(() => expect(screen.getByText('— · 0 B')).toBeTruthy())
  })

  it('dashes this phone’s side only while the count is in flight', async () => {
    useDemoConfig.setState({ desktopData: { ...NO_DESKTOP, workspaceBytes: 4_704_356_511 } })
    let answer = (_usage: { totalBytes: number; fileCount: number }): void => undefined
    mockCacheUsage.mockReturnValue(
      new Promise((resolve) => {
        answer = resolve
      })
    )
    await draw()
    expect(screen.getByText('4.38 GB · —')).toBeTruthy()
    answer({ totalBytes: 0, fileCount: 0 })
    await waitFor(() => expect(screen.getByText('4.38 GB · 0 B')).toBeTruthy())
  })
})
