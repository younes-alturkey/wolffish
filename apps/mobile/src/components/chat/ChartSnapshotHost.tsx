import {
  chartHostCrashed,
  completeChartSnapshot,
  failAllChartWork,
  failChartSnapshot,
  hasChartWork,
  onChartDemand,
  registerChartHost,
  type ChartSnapshotJob
} from '@/lib/charts/snapshots'
import { ensureChartHostDocument, type ChartHostDocument } from '@/lib/charts/html'
import { useEffect, useRef, useState } from 'react'
import { View } from 'react-native'
import { WebView } from 'react-native-webview'

/**
 * The hidden rasterizer behind every inline chart card: one offscreen WebView
 * running the shared chart page (vendored ECharts + option builder), turning
 * specs into PNG data URLs for lib/charts/snapshots. Mounted once at the app
 * root; renders nothing at all until the first chart asks for a snapshot.
 *
 * Same confinement as the visible chart WebViews: a local file:// document
 * with read access scoped to its own directory, no storage, and no
 * navigation — the page needs nothing from the network.
 */
export function ChartSnapshotHost(): React.JSX.Element | null {
  const [wanted, setWanted] = useState(hasChartWork())
  const [doc, setDoc] = useState<ChartHostDocument | null>(null)
  // A new key remounts the WebView after its content process dies.
  const [generation, setGeneration] = useState(0)
  const webViewRef = useRef<WebView | null>(null)
  const unregisterRef = useRef<(() => void) | null>(null)

  useEffect(() => onChartDemand(() => setWanted(true)), [])

  useEffect(() => {
    if (!wanted || doc) return
    let alive = true
    ensureChartHostDocument()
      .then((built) => {
        if (alive) setDoc(built)
      })
      .catch(() => {
        // Composition failed (disk, dev-server asset fetch). Fail what's
        // queued — cards fall back — and allow a later demand to retry.
        failAllChartWork('chart host unavailable')
        if (alive) setWanted(hasChartWork())
      })
    return () => {
      alive = false
    }
  }, [wanted, doc])

  useEffect(
    () => () => {
      unregisterRef.current?.()
    },
    []
  )

  if (!wanted || !doc) return null

  const send = (job: ChartSnapshotJob): void => {
    webViewRef.current?.injectJavaScript(
      `window.__wolffishChart && window.__wolffishChart.dispatch(${JSON.stringify({
        type: 'snapshot',
        id: job.id,
        spec: job.spec,
        theme: job.theme,
        width: job.width,
        height: job.height,
        scale: job.scale,
        background: job.background
      })}); true;`
    )
  }

  const crashed = (): void => {
    unregisterRef.current?.()
    unregisterRef.current = null
    chartHostCrashed()
    setGeneration((n) => n + 1)
  }

  return (
    <View
      pointerEvents="none"
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={{ position: 'absolute', width: 1, height: 1, opacity: 0 }}
    >
      <WebView
        key={generation}
        ref={webViewRef}
        source={{ uri: doc.uri }}
        originWhitelist={['file://*']}
        allowingReadAccessToURL={doc.directory}
        allowFileAccess
        allowFileAccessFromFileURLs={false}
        allowUniversalAccessFromFileURLs={false}
        javaScriptEnabled
        domStorageEnabled={false}
        setSupportMultipleWindows={false}
        onShouldStartLoadWithRequest={(request) => request.url.startsWith('file://')}
        onMessage={(event) => {
          let message: { type?: string; id?: number; dataUrl?: string; message?: string }
          try {
            message = JSON.parse(event.nativeEvent.data) as typeof message
          } catch {
            return
          }
          if (message.type === 'ready') {
            unregisterRef.current?.()
            unregisterRef.current = registerChartHost(send)
          } else if (message.type === 'snapshot' && message.id !== undefined && message.dataUrl) {
            completeChartSnapshot(message.id, message.dataUrl)
          } else if (message.type === 'error') {
            failChartSnapshot(message.id, message.message ?? 'chart page error')
          }
        }}
        onContentProcessDidTerminate={crashed}
        onRenderProcessGone={crashed}
        onError={crashed}
      />
    </View>
  )
}
