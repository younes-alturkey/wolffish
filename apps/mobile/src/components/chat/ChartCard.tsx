import { ChartLineData02Icon, CodeIcon, Image01Icon } from '@/components/core/icons'
import { ExpandedSheet } from '@/components/core/ExpandedSheet'
import { ensureChartHostDocument, type ChartHostDocument } from '@/lib/charts/html'
import { requestChartSnapshot } from '@/lib/charts/snapshots'
import { parseChartSpec, type ChartSpec } from '@/lib/charts/spec'
import { chartThemeFor, type ChartTheme } from '@/lib/charts/theme'
import { fileName as baseName } from '@/lib/files/fileKinds'
import { useWorkspaceFileText } from '@/lib/files/useWorkspaceFileText'
import { useTheme } from '@/providers/theme/useTheme'
import { Image } from 'expo-image'
import { Directory, File, Paths } from 'expo-file-system'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ActivityIndicator, PixelRatio, Pressable, Text, View } from 'react-native'
import { WebView } from 'react-native-webview'
import { DownloadStatus } from '@/components/chat/DownloadStatus'
import {
  CardFooter,
  CardShell,
  IconAction,
  shareFile,
  type Align
} from '@/components/chat/FileChrome'
import {
  ExpandAction,
  ShareAction,
  SourceBody,
  type FileViewerProps
} from '@/components/chat/FileViewers'

/**
 * Interactive chart card for delivered `.chart.json` specs — the mobile
 * counterpart of the desktop's ChartCard. The inline card shows a PNG
 * snapshot rasterized by the shared hidden chart WebView (see
 * lib/charts/snapshots for why previews are images), and expands into the
 * full-screen sheet where the chart runs live — ECharts with touch tooltips —
 * with the desktop's Chart ⇄ Data toggle. Falls back to the plain file card
 * while loading fails, for oversized files, and for specs that cannot render;
 * the file stays shareable either way.
 */

/** Desktop ChartCard's inline guard — twice the general text-card budget. */
const CHART_MAX_INLINE_BYTES = 1024 * 1024
const DEFAULT_PLOT_HEIGHT = 320

/** The live, interactive plot inside the expanded sheet. */
function ChartLiveView({ spec, theme }: { spec: ChartSpec; theme: ChartTheme }): React.JSX.Element {
  const [doc, setDoc] = useState<ChartHostDocument | null>(null)
  // Remounts the frame if its content process dies while the sheet is open.
  const [generation, setGeneration] = useState(0)
  const webViewRef = useRef<WebView | null>(null)
  const readyRef = useRef(false)

  useEffect(() => {
    let alive = true
    ensureChartHostDocument()
      .then((built) => {
        if (alive) setDoc(built)
      })
      .catch(() => {
        // Unreachable in practice: the card only expands after the inline
        // snapshot succeeded, which needs this same document.
      })
    return () => {
      alive = false
    }
  }, [])

  const sendRender = useCallback(() => {
    webViewRef.current?.injectJavaScript(
      `window.__wolffishChart && window.__wolffishChart.dispatch(${JSON.stringify({
        type: 'render',
        spec,
        theme
      })}); true;`
    )
  }, [spec, theme])

  // Re-render in place when the spec or theme changes under an open sheet.
  useEffect(() => {
    if (readyRef.current) sendRender()
  }, [sendRender])

  if (!doc) {
    return (
      <View className="flex-1 items-center justify-center">
        <ActivityIndicator />
      </View>
    )
  }

  return (
    <View
      className="flex-1"
      onLayout={() => {
        // Rotation / split-view resizes the frame natively; the plot must follow.
        if (readyRef.current) {
          webViewRef.current?.injectJavaScript(
            "window.__wolffishChart && window.__wolffishChart.dispatch({ type: 'resize' }); true;"
          )
        }
      }}
    >
      <WebView
        key={generation}
        ref={webViewRef}
        source={{ uri: doc.uri }}
        style={{ backgroundColor: 'transparent' }}
        originWhitelist={['file://*']}
        allowingReadAccessToURL={doc.directory}
        allowFileAccess
        allowFileAccessFromFileURLs={false}
        allowUniversalAccessFromFileURLs={false}
        javaScriptEnabled
        domStorageEnabled={false}
        setSupportMultipleWindows={false}
        scrollEnabled={false}
        bounces={false}
        onShouldStartLoadWithRequest={(request) => request.url.startsWith('file://')}
        onMessage={(event) => {
          let message: { type?: string }
          try {
            message = JSON.parse(event.nativeEvent.data) as typeof message
          } catch {
            return
          }
          if (message.type === 'ready') {
            readyRef.current = true
            sendRender()
          }
        }}
        onContentProcessDidTerminate={() => {
          readyRef.current = false
          setGeneration((n) => n + 1)
        }}
        onRenderProcessGone={() => {
          readyRef.current = false
          setGeneration((n) => n + 1)
        }}
      />
    </View>
  )
}

/**
 * The chart card's own footprint while its spec is still arriving: the same
 * shell, the same two-line head, a plot box at the default height and the same
 * three footer actions. Charts are the tallest thing in the feed — a generic
 * short placeholder growing into one moves the transcript by ~250pt, which is
 * the jump this shape exists to prevent. See ViewerSkeleton for the rule.
 *
 * The one residual settle is a spec that overrides `height`: the number lives
 * inside the file being fetched, so it cannot be known before it lands. A
 * cached spec (every demo chart — the importer seeds them) skips this state
 * entirely and mounts at its true height.
 */
function ChartSkeleton({
  name,
  relPath,
  align
}: {
  name: string
  relPath: string
  align?: Align
}): React.JSX.Element {
  return (
    <CardShell align={align}>
      <View className="flex-row items-start gap-2 px-3 pb-1 pt-2.5">
        <ChartLineData02Icon size={15} className="text-muted mt-0.5" />
        <View className="min-w-0 flex-1">
          <Text numberOfLines={1} className="text-fg font-sans-semibold text-left text-sm">
            {name}
          </Text>
        </View>
      </View>
      <View className="w-full px-2" style={{ height: DEFAULT_PLOT_HEIGHT }}>
        <View className="bg-border h-full w-full rounded-lg opacity-40" />
        <DownloadStatus relPath={relPath} />
      </View>
      <CardFooter label={name}>
        {[0, 1, 2].map((index) => (
          <View key={index} className="bg-border m-1.5 h-3.5 w-3.5 rounded opacity-40" />
        ))}
      </CardFooter>
    </CardShell>
  )
}

export function ChartFileCard({
  relPath,
  conversationId,
  classification,
  displayName,
  align,
  fallback
}: FileViewerProps): React.JSX.Element {
  const { t } = useTranslation()
  const { isDark } = useTheme()
  const [open, setOpen] = useState(false)
  const [view, setView] = useState<'chart' | 'data'>('chart')
  const { text, uri, loading, missing, oversized } = useWorkspaceFileText(
    relPath,
    conversationId,
    CHART_MAX_INLINE_BYTES
  )
  const spec = useMemo(() => (text === null ? null : parseChartSpec(text)), [text])
  const theme = useMemo(() => chartThemeFor(isDark), [isDark])
  const name = displayName ?? classification.name ?? baseName(relPath)

  const [plotWidth, setPlotWidth] = useState(0)
  const [snapshot, setSnapshot] = useState<string | null>(null)
  const [snapshotFailed, setSnapshotFailed] = useState(false)

  const plotHeight = spec?.height ?? DEFAULT_PLOT_HEIGHT

  useEffect(() => {
    if (!spec || plotWidth <= 0) return
    let alive = true
    requestChartSnapshot({
      spec,
      theme,
      width: plotWidth,
      height: plotHeight,
      scale: Math.min(PixelRatio.get(), 3)
    })
      .then((dataUrl) => {
        if (alive) {
          setSnapshot(dataUrl)
          setSnapshotFailed(false)
        }
      })
      .catch(() => {
        // Keep a previous image if one exists (a theme flip that failed);
        // otherwise degrade to the plain file card below.
        if (alive) setSnapshotFailed(true)
      })
    return () => {
      alive = false
    }
  }, [spec, theme, plotWidth, plotHeight])

  const shareAsImage = useCallback(() => {
    if (!spec) return
    void (async () => {
      try {
        // The desktop's savePng: 2× export on the card surface (a transparent
        // PNG turns illegible the moment a share target puts it on white).
        const dataUrl = await requestChartSnapshot({
          spec,
          theme,
          width: plotWidth > 0 ? plotWidth : 320,
          height: plotHeight,
          scale: 2,
          background: theme.surface
        })
        const directory = new Directory(Paths.cache, 'chart-share')
        directory.create({ intermediates: true, idempotent: true })
        const file = new File(directory, `${name.replace(/\.chart\.json$/i, '')}.png`)
        await file.write(dataUrl.slice(dataUrl.indexOf(',') + 1), { encoding: 'base64' })
        shareFile(file.uri)
      } catch {
        // Best-effort, like every share action.
      }
    })()
  }, [spec, theme, plotWidth, plotHeight, name])

  if (loading) return <ChartSkeleton name={name} relPath={relPath} align={align} />
  if (missing || oversized || text === null || spec === null) return fallback
  // The chart engine itself failed with nothing to show — the file card at
  // least keeps the spec shareable.
  if (snapshotFailed && !snapshot) return fallback

  const title = spec.title.length > 0 ? spec.title : name
  const specJson = JSON.stringify(spec, null, 2)

  const showingChart = view === 'chart'
  const viewToggle = (
    <IconAction
      label={t(showingChart ? 'chat.chartCard.viewData' : 'chat.chartCard.viewChart')}
      selected={showingChart}
      icon={
        showingChart ? (
          <CodeIcon size={14} className="text-muted" />
        ) : (
          <ChartLineData02Icon size={14} className="text-muted" />
        )
      }
      onPress={() => setView(showingChart ? 'data' : 'chart')}
    />
  )
  const shareImageAction = (
    <IconAction
      label={t('chat.chartCard.shareImage')}
      icon={<Image01Icon size={14} className="text-muted" />}
      onPress={shareAsImage}
    />
  )

  return (
    <CardShell align={align}>
      <View className="flex-row items-start gap-2 px-3 pb-1 pt-2.5">
        <ChartLineData02Icon size={15} className="text-muted mt-0.5" />
        <View className="min-w-0 flex-1">
          <Text numberOfLines={1} className="text-fg font-sans-semibold text-left text-sm">
            {title}
          </Text>
          {spec.subtitle ? (
            <Text numberOfLines={1} className="text-muted font-sans text-left text-[11px]">
              {spec.subtitle}
            </Text>
          ) : null}
        </View>
      </View>

      <Pressable
        accessibilityRole="button"
        accessibilityLabel={title}
        onPress={() => setOpen(true)}
      >
        <View pointerEvents="none" className="w-full px-2" style={{ height: plotHeight }}>
          <View
            className="h-full w-full"
            onLayout={(event) => setPlotWidth(Math.round(event.nativeEvent.layout.width))}
          >
            {snapshot ? (
              <Image
                source={{ uri: snapshot }}
                contentFit="fill"
                style={{ width: '100%', height: '100%' }}
                accessibilityLabel={title}
              />
            ) : (
              // A pulse, not the download status the pre-spec skeleton shows:
              // the spec is already on disk and this is the rasterizer working,
              // so there is no transfer to report. Inside a box already at its
              // final height — rasterizing is the last step, and it must read
              // as the same card still settling rather than a new state.
              <View className="animate-pulse h-full w-full">
                <View className="bg-border h-full w-full rounded-lg opacity-40" />
              </View>
            )}
          </View>
        </View>
      </Pressable>

      <CardFooter label={spec.footnote ?? name}>
        {shareImageAction}
        <ShareAction uri={uri} />
        <ExpandAction onPress={() => setOpen(true)} />
      </CardFooter>

      <ExpandedSheet
        open={open}
        onClose={() => setOpen(false)}
        title={title}
        actions={
          <>
            {viewToggle}
            {shareImageAction}
            <ShareAction uri={uri} />
          </>
        }
      >
        {showingChart ? (
          <View className="flex-1 p-3">
            {spec.subtitle ? (
              <Text className="text-muted font-sans pb-2 text-left text-xs">{spec.subtitle}</Text>
            ) : null}
            <ChartLiveView spec={spec} theme={theme} />
            {spec.footnote ? (
              <Text className="text-muted font-sans pt-2 text-left text-[11px]">
                {spec.footnote}
              </Text>
            ) : null}
          </View>
        ) : (
          <SourceBody content={specJson} flex />
        )}
      </ExpandedSheet>
    </CardShell>
  )
}
