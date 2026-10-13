/**
 * End-to-end render test for delivered/attached files: one case per file type
 * the desktop app supports, driven through the real FileBlock dispatch, the
 * real viewers and a faked workspace cache. A regression here means a file the
 * desktop renders would land in the mobile feed as a dead card.
 */
import { ThemeContext } from '@/providers/theme/useTheme'
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native'
import type { ReactElement } from 'react'
import { SafeAreaProvider } from 'react-native-safe-area-context'

jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock')
)

jest.mock('expo-localization', () => ({ getLocales: () => [{ languageCode: 'en' }] }))

/** relPath → body. Anything absent from this map is a missing file. */
const FILES: Record<string, string> = {
  'files/shot.png': 'binary-png',
  'files/clip.mp4': 'binary-mp4',
  'voice/reply.mp3': 'binary-mp3',
  'files/report.pdf': '%PDF-1.4 binary',
  'files/page.html': '<html><body><h1>Report</h1></body></html>',
  'files/README.md': '# Title\n\nSome **bold** prose.',
  'files/notes.txt': 'plain line one\nplain line two',
  'files/app.ts': 'export const answer = 42\n',
  'files/data.csv': 'name,qty\nwidget,7\ngizmo,3',
  'files/logo.svg':
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8"><circle cx="4" cy="4" r="3"/></svg>',
  'files/book.xlsx': 'binary-xlsx',
  'files/letter.docx': 'binary-docx',
  'files/deck.pptx': 'binary-pptx',
  'files/legacy.doc': 'binary-doc',
  'files/legacy.ppt': 'binary-ppt',
  'files/archive.zip': 'binary-zip',
  // A raw literal (not JSON.stringify): jest.mock factories may only
  // reference this map while its initializer is entirely call-free.
  'files/q3-revenue.chart.json':
    '{"type":"column","title":"Q3 revenue","subtitle":"by product line",' +
    '"footnote":"Source: finance close","categories":["Jul","Aug","Sep"],' +
    '"series":[{"name":"Hardware","data":[12,14,17]}]}',
  'files/broken.chart.json': 'not a chart spec',
  // Listed in CACHED below — the already-materialized case.
  'files/cached.ts': 'export const cached = true\n'
}

/**
 * Paths whose bytes are already materialized in the fake cache — the state
 * every file reaches after its first view, and the one that must render with
 * no fetch and no placeholder. Everything else takes the download path.
 * A literal, like FILES: jest hoists the factories above both.
 */
const CACHED: string[] = ['files/cached.ts']

jest.mock('@/lib/files/fileCache', () => ({
  statCachedFile: jest.fn((relPath: string) =>
    CACHED.includes(relPath) && relPath in FILES
      ? { uri: `file:///cache/${relPath}`, sizeBytes: FILES[relPath].length }
      : null
  ),
  resolveWorkspaceFile: jest.fn(async (relPath: string) => {
    // Authoritative absence — the source answered "not here". Transient
    // failures never say missing; they retry (see useFileRetry).
    if (!(relPath in FILES)) return { uri: null, missing: true }
    // Fetched once, cached from then on — what makes the second view sync.
    if (!CACHED.includes(relPath)) CACHED.push(relPath)
    return { uri: `file:///cache/${relPath}`, missing: false }
  })
}))

jest.mock('expo-file-system', () => ({
  File: class {
    uri: string
    constructor(uri: string) {
      this.uri = uri
    }
    get exists(): boolean {
      return this.uri.replace('file:///cache/', '') in FILES
    }
    get size(): number {
      return this.body().length
    }
    private body(): string {
      return FILES[this.uri.replace('file:///cache/', '')] ?? ''
    }
    textSync(): string {
      return this.body()
    }
    async text(): Promise<string> {
      return this.body()
    }
  }
}))

jest.mock('expo-image', () => {
  const { View } = jest.requireActual('react-native')
  return { Image: (props: object) => <View testID="image" {...props} /> }
})

// Reanimated's worklets runtime needs the native binary; here it carries only
// the expanded image's zoom transform, which starts at rest and stays there
// without fingers on the glass. The geometry behind it is checked on its own
// in lib/utils/__tests__/zoomPan.test.ts.
jest.mock('react-native-reanimated', () => {
  const { View } = jest.requireActual('react-native')
  return {
    __esModule: true,
    // createAnimatedComponent is gesture-handler's, not ours: it wraps the
    // detector's child at import time, so the mock has to answer for it.
    default: { View, createAnimatedComponent: (component: unknown) => component },
    useSharedValue: (value: unknown) => ({ value }),
    useAnimatedStyle: (style: () => object) => style(),
    // Also gesture-handler's: the detector subscribes to its own event stream
    // through Reanimated, and there is no stream to subscribe to here.
    useEvent: () => () => undefined,
    withTiming: (value: number) => value,
    withDecay: () => 0
  }
})

// The chart host document is composed from bundled assets (ECharts, the page
// runtime, the Plex face) — none of which exist in this faked filesystem.
jest.mock('@/lib/charts/html', () => ({
  ensureChartHostDocument: jest.fn(async () => ({
    uri: 'file:///cache/chart-host/host.html',
    directory: 'file:///cache/chart-host/'
  }))
}))

// Same reason as the chart host, and one more: the module pulls in the whole
// vendored pdf.js build, which boots a Node fallback path the moment it is
// required. Nothing here needs the real composer — the PDF card is checked on
// which document it points the frame at, not on how the page was written.
jest.mock('@/lib/pdf/html', () => ({
  PDF_MAX_INLINE_BYTES: 10 * 1024 * 1024,
  ensurePdfHostDocument: jest.fn(async () => ({
    uri: 'file:///cache/pdf-host/host.html',
    directory: 'file:///cache/pdf-host/'
  }))
}))

// The office card drives its page over `injectJavaScript`, so the fake frame
// has to carry that method on its ref — a bare View would make the pager throw
// rather than fail an assertion.
const mockInjectJavaScript = jest.fn()

jest.mock('react-native-webview', () => {
  const { View } = jest.requireActual('react-native')
  const { forwardRef, useImperativeHandle } = jest.requireActual('react')
  const WebView = forwardRef((props: object, ref: unknown) => {
    useImperativeHandle(ref, () => ({ injectJavaScript: mockInjectJavaScript }))
    return <View testID="webview" {...props} />
  })
  return { WebView }
})

jest.mock('@/lib/office/html', () => ({
  OFFICE_MAX_INLINE_BYTES: 8 * 1024 * 1024,
  ensureOfficeHostDocument: jest.fn(async () => ({
    uri: 'file:///cache/office-host/host.html',
    directory: 'file:///cache/office-host/'
  }))
}))

jest.mock('expo-video', () => {
  const { View } = jest.requireActual('react-native')
  return {
    // Includes the listener surface `useEvent(player, 'statusChange')` needs.
    useVideoPlayer: () => ({
      loop: false,
      status: 'readyToPlay',
      // Deliberately not 16/9 — proves the card takes its shape from the track
      // rather than from the placeholder aspect.
      videoTrack: { size: { width: 640, height: 480 } },
      play: jest.fn(),
      pause: jest.fn(),
      addListener: jest.fn(() => ({ remove: jest.fn() })),
      removeListener: jest.fn()
    }),
    VideoView: (props: object) => <View testID="video" {...props} />
  }
})

jest.mock('expo-audio', () => ({
  useAudioPlayer: () => ({ play: jest.fn(), pause: jest.fn(), seekTo: jest.fn() }),
  useAudioPlayerStatus: () => ({ playing: false, duration: 12, currentTime: 0 })
}))

jest.mock('expo-sharing', () => ({ shareAsync: jest.fn(async () => undefined) }))
jest.mock('expo-clipboard', () => ({ setStringAsync: jest.fn(async () => undefined) }))
jest.mock('expo-web-browser', () => ({ openBrowserAsync: jest.fn(async () => undefined) }))

import '@/lib/i18n'
import { FileBlock } from '@/components/chat/FileBlock'
import { resolveWorkspaceFile } from '@/lib/files/fileCache'
import { ensureOfficeHostDocument } from '@/lib/office/html'
import { ensurePdfHostDocument } from '@/lib/pdf/html'
import * as Sharing from 'expo-sharing'
import { Platform } from 'react-native'

const SAFE_AREA = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 47, left: 0, right: 0, bottom: 34 }
}

// `render` and `fireEvent` are async in RNTL 14: they resolve their own
// `act()` before the render result is published to `screen`. Every call site
// must await, or the queries below race the mount.
async function renderBlock(element: ReactElement): Promise<void> {
  await render(
    <SafeAreaProvider initialMetrics={SAFE_AREA}>
      <ThemeContext.Provider
        value={{ theme: 'light', isDark: false, setTheme: async () => undefined }}
      >
        {element}
      </ThemeContext.Provider>
    </SafeAreaProvider>
  )
}

describe('FileBlock — one delivered file per supported type', () => {
  it('renders an image as a tappable thumbnail that expands full screen', async () => {
    await renderBlock(<FileBlock relPath="files/shot.png" declared="image" />)
    await waitFor(() => expect(screen.getByTestId('image')).toBeTruthy())

    await fireEvent.press(screen.getByLabelText('shot.png'))
    // Thumbnail + the expanded sheet's full-bleed copy.
    await waitFor(() => expect(screen.getAllByTestId('image').length).toBeGreaterThan(1))
    expect(screen.getByText('shot.png')).toBeTruthy()
  })

  it('sizes the image by its own ratio once it reports in — nothing cropped', async () => {
    await renderBlock(<FileBlock relPath="files/shot.png" declared="image" />)
    const thumb = await waitFor(() => screen.getByTestId('image'))
    // Placeholder footprint until the decoder reports the natural size.
    expect(thumb.props.style).toMatchObject({ width: 260, height: 200 })

    // A tall screenshot: 750x1800. The old fixed box would crop it.
    await fireEvent(thumb, 'load', { source: { width: 750, height: 1800 } })
    const style = screen.getByTestId('image').props.style
    expect(style).toMatchObject({ width: 260, aspectRatio: 750 / 1800 })
    expect(style.height).toBeUndefined()
    expect(style.maxHeight).toBeUndefined()
  })

  it('renders a video in the native player', async () => {
    await renderBlock(<FileBlock relPath="files/clip.mp4" declared="video" />)
    await waitFor(() => expect(screen.getByTestId('video')).toBeTruthy())
    expect(screen.getByText('clip.mp4')).toBeTruthy()
  })

  it('sizes the video by its own aspect ratio, not a fixed height', async () => {
    await renderBlock(<FileBlock relPath="files/clip.mp4" declared="video" />)
    const style = await waitFor(() => screen.getByTestId('video').props.style)
    // 640x480 track -> 4/3, width-constrained, height left to the ratio.
    expect(style).toMatchObject({ width: '100%', aspectRatio: 4 / 3 })
    expect(style.height).toBeUndefined()
    // No viewport cap either: a portrait clip renders whole, like images.
    expect(style.maxHeight).toBeUndefined()
  })

  it('renders audio as a transport with a play control', async () => {
    await renderBlock(<FileBlock relPath="voice/reply.mp3" declared="audio" />)
    await waitFor(() => expect(screen.getByText('reply.mp3')).toBeTruthy())
    expect(screen.getByText('0:00 / 0:12')).toBeTruthy()

    // Audio carries the same export affordance as video.
    await fireEvent.press(screen.getByLabelText('Share'))
    expect(Sharing.shareAsync).toHaveBeenCalledWith('file:///cache/voice/reply.mp3')
  })

  it('renders a PDF preview that expands (iOS)', async () => {
    await renderBlock(<FileBlock relPath="files/report.pdf" declared="document" />)
    await waitFor(() => expect(screen.getByTestId('webview')).toBeTruthy())
    expect(screen.getByText('report.pdf')).toBeTruthy()

    await fireEvent.press(screen.getByLabelText('Expand'))
    // The sheet takes over the single document renderer; its close control is
    // the proof it is up.
    await waitFor(() => expect(screen.getByLabelText('Close')).toBeTruthy())
    expect(screen.getByTestId('webview')).toBeTruthy()
  })

  /**
   * Android has no PDF engine in its WebView, so the same card has to point
   * the frame at a composed pdf.js page instead of at the file — and at the
   * right one: `#preview` is a single pinned page, `#full` the scrollable
   * document. Getting the hash wrong is invisible in a snapshot and shows up
   * as a card that scrolls inside the feed, or a sheet stuck on page 1.
   */
  it('renders the composed pdf.js document on Android', async () => {
    Platform.OS = 'android'
    try {
      await renderBlock(<FileBlock relPath="files/report.pdf" declared="document" />)
      await waitFor(() => expect(screen.getByTestId('webview')).toBeTruthy())
      expect(ensurePdfHostDocument).toHaveBeenCalledWith(
        'file:///cache/files/report.pdf',
        `files/report.pdf:${FILES['files/report.pdf'].length}`
      )
      expect(screen.getByTestId('webview').props.source).toEqual({
        uri: 'file:///cache/pdf-host/host.html#preview'
      })
      // The page may not read a second file — the document is inside it.
      expect(screen.getByTestId('webview').props.allowFileAccessFromFileURLs).toBe(false)

      await fireEvent.press(screen.getByLabelText('Expand'))
      await waitFor(() => expect(screen.getByLabelText('Close')).toBeTruthy())
      expect(screen.getByTestId('webview').props.source).toEqual({
        uri: 'file:///cache/pdf-host/host.html#full'
      })
    } finally {
      Platform.OS = 'ios'
    }
  })

  it('renders HTML live, toggles to source, and expands', async () => {
    await renderBlock(<FileBlock relPath="files/page.html" declared="file" />)
    await waitFor(() => expect(screen.getByTestId('webview')).toBeTruthy())

    await fireEvent.press(screen.getByLabelText('Source'))
    await waitFor(() => expect(screen.queryByTestId('webview')).toBeNull())
    expect(screen.getByText(/<h1>Report<\/h1>/)).toBeTruthy()

    await fireEvent.press(screen.getByLabelText('Preview'))
    await waitFor(() => expect(screen.getByTestId('webview')).toBeTruthy())

    await fireEvent.press(screen.getByLabelText('Expand'))
    await waitFor(() => expect(screen.getByLabelText('Close')).toBeTruthy())
    expect(screen.getByTestId('webview')).toBeTruthy()
  })

  it('takes the page\u2019s own height and leaves the feed its gesture', async () => {
    await renderBlock(<FileBlock relPath="files/page.html" declared="file" />)
    const frame = await waitFor(() => screen.getByTestId('webview'))
    // Until the page reports a size the card holds the reserved window, which
    // scrolls because anything might be under the fold.
    expect(frame.props.scrollEnabled).toBe(true)

    // 300pt of card; a page that lays itself out 720 wide is shown at 300/720,
    // so its 360 CSS pixels of content stand 150pt tall here.
    await fireEvent(frame, 'layout', { nativeEvent: { layout: { width: 300, height: 640 } } })
    await fireEvent(frame, 'message', {
      nativeEvent: { data: JSON.stringify({ type: 'size', height: 360, width: 720 }) }
    })

    const shown = screen.getByTestId('webview')
    expect(shown.parent?.props.style).toMatchObject({ height: 150 })
    // It fits — so the page hands every drag back to the chat list.
    expect(shown.props.scrollEnabled).toBe(false)
  })

  it('renders markdown as rich text, not source', async () => {
    await renderBlock(<FileBlock relPath="files/README.md" declared="file" />)
    await waitFor(() => expect(screen.getByText('Title')).toBeTruthy())
    expect(screen.getByText('bold')).toBeTruthy()
    expect(screen.getByText('README.md')).toBeTruthy()
  })

  it('renders plain text as line-numbered source', async () => {
    await renderBlock(<FileBlock relPath="files/notes.txt" declared="document" />)
    await waitFor(() => expect(screen.getByText(/plain line one/)).toBeTruthy())
    expect(screen.getByText('1\n2')).toBeTruthy()
    expect(screen.getByText('2 lines')).toBeTruthy()
  })

  it('renders source files as a code card', async () => {
    await renderBlock(<FileBlock relPath="files/app.ts" declared="file" />)
    await waitFor(() => expect(screen.getByText(/export const answer = 42/)).toBeTruthy())
    expect(screen.getByText(/typescript/)).toBeTruthy()
  })

  it('renders an SVG exactly like any other image', async () => {
    // expo-image decodes SVG, so a delivered logo gets the same thumbnail,
    // lightbox and share as a .png — no card chrome, and never its markup.
    await renderBlock(<FileBlock relPath="files/logo.svg" declared="file" />)
    await waitFor(() => expect(screen.getByTestId('image')).toBeTruthy())
    expect(screen.queryByText(/<circle/)).toBeNull()

    await fireEvent.press(screen.getByLabelText('logo.svg'))
    await waitFor(() => expect(screen.getAllByTestId('image').length).toBeGreaterThan(1))
    expect(screen.getByText('logo.svg')).toBeTruthy()
  })

  it('renders CSV as a table', async () => {
    await renderBlock(<FileBlock relPath="files/data.csv" declared="document" />)
    await waitFor(() => expect(screen.getByText('widget')).toBeTruthy())
    expect(screen.getByText('name')).toBeTruthy()
    expect(screen.getByText('qty')).toBeTruthy()
    expect(screen.getByText(/3 rows/)).toBeTruthy()
  })

  it('renders a chart spec as a chart card with the data toggle', async () => {
    await renderBlock(<FileBlock relPath="files/q3-revenue.chart.json" declared="chart" />)
    // Chrome comes from the spec, not the filename — the desktop card's header.
    await waitFor(() => expect(screen.getByText('Q3 revenue')).toBeTruthy())
    expect(screen.getByText('by product line')).toBeTruthy()
    expect(screen.getByText('Source: finance close')).toBeTruthy()
    expect(screen.getByLabelText('Share as image')).toBeTruthy()

    await fireEvent.press(screen.getByLabelText('Expand'))
    await waitFor(() => expect(screen.getByLabelText('Close')).toBeTruthy())
    // The sheet's chart view is the live plot frame…
    expect(screen.getByTestId('webview')).toBeTruthy()

    // …and the desktop's Chart ⇄ Data toggle shows the parsed spec as JSON.
    await fireEvent.press(screen.getByLabelText('Data'))
    await waitFor(() => expect(screen.getByText(/"type": "column"/)).toBeTruthy())
    expect(screen.queryByTestId('webview')).toBeNull()
  })

  it('degrades an unparseable chart spec to the plain file card', async () => {
    await renderBlock(<FileBlock relPath="files/broken.chart.json" declared="chart" />)
    await waitFor(() => expect(screen.getByText('broken.chart.json')).toBeTruthy())
    // No chart chrome — the generic card keeps the file shareable, nothing more.
    expect(screen.queryByLabelText('Share as image')).toBeNull()
  })

  /**
   * Word, Excel and PowerPoint all render through one card and one engine
   * bundle, on both platforms. The card is checked on what it does with what
   * the page reports back — the page count that turns into a pager, the sheet
   * names that replace it, and the error that sends the file to the OS.
   */
  const post = async (payload: object): Promise<void> => {
    // fireEvent, never a hand-rolled act(): calling act() directly in an RNTL
    // screen test corrupts the act scope and silently empties every render
    // that follows it in the file.
    await fireEvent(screen.getByTestId('webview'), 'message', {
      nativeEvent: { data: JSON.stringify(payload) }
    })
  }
  const ready = (pages: number, labels: string[] | null = null): Promise<void> =>
    post({ type: 'ready', pages, labels })

  it('scrolls a Word document rather than paging it', async () => {
    await renderBlock(
      <FileBlock relPath="files/letter.docx" declared="document" sizeBytes={2048} />
    )
    await waitFor(() => expect(screen.getByTestId('webview')).toBeTruthy())

    expect(ensureOfficeHostDocument).toHaveBeenCalledWith(
      'file:///cache/files/letter.docx',
      'docx',
      expect.objectContaining({ surface: '#ffffff', fg: '#0d1117' }),
      expect.stringContaining('files/letter.docx')
    )
    // The page may not read a second file — the document is inside it.
    expect(screen.getByTestId('webview').props.allowFileAccessFromFileURLs).toBe(false)
    // Live in the feed, and able to give the gesture back when it runs out —
    // without this a document would swallow the chat list's pan on Android.
    expect(screen.getByTestId('webview').props.nestedScrollEnabled).toBe(true)

    await ready(4)
    await waitFor(() => expect(screen.getByText('Page 1 of 4 · 2 KB')).toBeTruthy())

    // A document is read, not flipped through: no chevrons, and the position
    // line simply follows wherever the reader has scrolled to.
    expect(screen.queryByLabelText('Next')).toBeNull()
    expect(screen.queryByLabelText('Previous')).toBeNull()

    await post({ type: 'page', index: 1 })
    await waitFor(() => expect(screen.getByText('Page 2 of 4 · 2 KB')).toBeTruthy())
  })

  it('gives a workbook sheet tabs rather than a pager', async () => {
    await renderBlock(<FileBlock relPath="files/book.xlsx" declared="document" sizeBytes={2048} />)
    await waitFor(() => expect(screen.getByTestId('webview')).toBeTruthy())
    expect(ensureOfficeHostDocument).toHaveBeenCalledWith(
      'file:///cache/files/book.xlsx',
      'xlsx',
      expect.anything(),
      expect.stringContaining('files/book.xlsx')
    )

    await ready(3, ['Species', 'Readings', 'Notes'])
    // Every sheet is one tap away, named — the desktop's SheetTabs, not a
    // pager that would make the reader count to the sheet they want.
    await waitFor(() => expect(screen.getByLabelText('Species')).toBeTruthy())
    expect(screen.getByLabelText('Readings')).toBeTruthy()
    expect(screen.getByLabelText('Notes')).toBeTruthy()
    expect(screen.queryByLabelText('Next')).toBeNull()
    expect(screen.queryByLabelText('Previous')).toBeNull()

    await fireEvent.press(screen.getByLabelText('Notes'))
    expect(mockInjectJavaScript).toHaveBeenCalledWith('window.wolffishGoTo(2);true;')
  })

  it('counts slides in a deck and carries the place into the expanded sheet', async () => {
    await renderBlock(<FileBlock relPath="files/deck.pptx" declared="document" sizeBytes={2048} />)
    await waitFor(() => expect(screen.getByTestId('webview')).toBeTruthy())

    await ready(7)
    await waitFor(() => expect(screen.getByText('Slide 1 of 7 · 2 KB')).toBeTruthy())
    await fireEvent.press(screen.getByLabelText('Next'))
    await waitFor(() => expect(screen.getByText('Slide 2 of 7 · 2 KB')).toBeTruthy())

    await fireEvent.press(screen.getByLabelText('Expand'))
    await waitFor(() => expect(screen.getByLabelText('Close')).toBeTruthy())
    // The sheet's frame mounts at the top; the card restores the reader's place.
    mockInjectJavaScript.mockClear()
    await ready(7)
    expect(mockInjectJavaScript).toHaveBeenCalledWith('window.wolffishGoTo(1);true;')
  })

  it('disables the pager at both ends, so the last page is reachable', async () => {
    await renderBlock(<FileBlock relPath="files/deck.pptx" declared="document" sizeBytes={2048} />)
    await waitFor(() => expect(screen.getByTestId('webview')).toBeTruthy())
    await ready(3)

    // Slide 1: back is dead, forward is live.
    await waitFor(() => expect(screen.getByText('Slide 1 of 3 · 2 KB')).toBeTruthy())
    expect(screen.getByLabelText('Previous')).toBeDisabled()
    expect(screen.getByLabelText('Next')).not.toBeDisabled()

    await fireEvent.press(screen.getByLabelText('Next'))
    await fireEvent.press(screen.getByLabelText('Next'))

    // The last slide is a place the pager can actually arrive at — it used to
    // be unreachable, because the index was inferred from a scroll offset that
    // clamps at the bottom, and Next stayed enabled doing nothing.
    await waitFor(() => expect(screen.getByText('Slide 3 of 3 · 2 KB')).toBeTruthy())
    expect(screen.getByLabelText('Next')).toBeDisabled()
    expect(screen.getByLabelText('Previous')).not.toBeDisabled()
  })

  it('degrades to the file card when no engine can render the document', async () => {
    await renderBlock(
      <FileBlock relPath="files/letter.docx" declared="document" sizeBytes={2048} />
    )
    await waitFor(() => expect(screen.getByTestId('webview')).toBeTruthy())

    await post({ type: 'error', reason: 'unsupported' })

    await waitFor(() => expect(screen.queryByTestId('webview')).toBeNull())
    expect(screen.getByText('DOCX · 2 KB')).toBeTruthy()
    await fireEvent.press(screen.getByLabelText('letter.docx'))
    expect(Sharing.shareAsync).toHaveBeenCalledWith('file:///cache/files/letter.docx')
  })

  it('degrades when the page never answers at all', async () => {
    jest.useFakeTimers()
    try {
      await renderBlock(
        <FileBlock relPath="files/deck.pptx" declared="document" sizeBytes={2048} />
      )
      await waitFor(() => expect(screen.getByTestId('webview')).toBeTruthy())
      // No 'ready', no 'error', no load failure — a truncated engine asset or a
      // renderer that died before it ran. The watchdog is the only thing that
      // stops the card holding an empty frame for the rest of the session.
      jest.advanceTimersByTime(20_000)
      await waitFor(() => expect(screen.queryByTestId('webview')).toBeNull())
      expect(screen.getByText('PPTX · 2 KB')).toBeTruthy()
    } finally {
      jest.useRealTimers()
    }
  })

  it.each([
    ['files/legacy.doc', 'legacy.doc', 'DOC'],
    ['files/legacy.ppt', 'legacy.ppt', 'PPT'],
    ['files/archive.zip', 'archive.zip', 'ZIP']
  ])('hands %s to the system viewer through a file card', async (relPath, name, ext) => {
    await renderBlock(<FileBlock relPath={relPath} declared="file" sizeBytes={2048} />)
    await waitFor(() => expect(screen.getByText(name)).toBeTruthy())
    expect(screen.getByText(`${ext} · 2 KB`)).toBeTruthy()

    await fireEvent.press(screen.getByLabelText(name))
    expect(Sharing.shareAsync).toHaveBeenCalledWith(`file:///cache/${relPath}`)
  })
})

describe('FileBlock — degraded states', () => {
  it.each([
    ['files/gone.png', 'image', 'Image file was deleted or unavailable'],
    ['files/gone.mp4', 'video', 'Video file was deleted or unavailable'],
    ['files/gone.mp3', 'audio', 'Audio file was deleted or unavailable'],
    ['files/gone.md', 'file', 'File was deleted'],
    ['files/gone.csv', 'document', 'File was deleted'],
    ['files/gone.html', 'file', 'File was deleted'],
    ['files/gone.pdf', 'document', 'File was deleted'],
    ['files/gone.zip', 'file', 'File was deleted']
  ])('shows the per-type unavailable state for a pruned %s', async (relPath, declared, label) => {
    await renderBlock(<FileBlock relPath={relPath} declared={declared as 'file'} />)
    await waitFor(() => expect(screen.getByText(label)).toBeTruthy())
  })

  it('renders an already-cached file with no fetch and no placeholder', async () => {
    // The feed's whole stability rests on this: a file the phone already holds
    // renders at full size in its first frame, so nothing resizes underneath
    // the transcript a beat later and drags the scroll position with it.
    await renderBlock(<FileBlock relPath="files/cached.ts" declared="file" />)
    expect(screen.getByText(/export const cached = true/)).toBeTruthy()
    const asked = (resolveWorkspaceFile as jest.Mock).mock.calls.map(([path]) => path)
    expect(asked).not.toContain('files/cached.ts')
  })

  it('renders attachments on the user side with the same dispatch', async () => {
    await renderBlock(
      <FileBlock
        relPath="files/data.csv"
        declared="other"
        displayName="quarterly.csv"
        align="end"
      />
    )
    await waitFor(() => expect(screen.getByText('quarterly.csv')).toBeTruthy())
    expect(screen.getByText('widget')).toBeTruthy()
  })
})
