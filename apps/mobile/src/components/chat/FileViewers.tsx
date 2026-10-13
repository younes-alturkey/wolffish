import {
  ArrowExpandIcon,
  CodeIcon,
  Copy01Icon,
  EyeIcon,
  File01Icon,
  Pdf02Icon,
  PresentationBarChart01Icon,
  Upload01Icon,
  Table01Icon,
  Tick02Icon
} from '@/components/core/icons'
import { ExpandedSheet } from '@/components/core/ExpandedSheet'
import { delimiterFor, parseDelimited, type SheetTable } from '@/lib/files/csv'
import { fileName as baseName, formatBytes, type FileClassification } from '@/lib/files/fileKinds'
import { useWorkspaceFile } from '@/lib/files/useWorkspaceFile'
import { useWorkspaceFileText } from '@/lib/files/useWorkspaceFileText'
import { cn } from '@/lib/utils/cn'
import * as Clipboard from 'expo-clipboard'
import * as WebBrowser from 'expo-web-browser'
import { ensurePdfHostDocument, PDF_MAX_INLINE_BYTES, type PdfHostDocument } from '@/lib/pdf/html'
import {
  ensureOfficeHostDocument,
  OFFICE_MAX_INLINE_BYTES,
  type OfficeHostDocument,
  type OfficeKind
} from '@/lib/office/html'
import { useTokens } from '@/providers/theme/useTheme'
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Platform, Pressable, ScrollView, Text, useWindowDimensions, View } from 'react-native'
import { WebView } from 'react-native-webview'
import { DownloadGlyph, DownloadStatus } from '@/components/chat/DownloadStatus'
import {
  CardFooter,
  CardHeader,
  CardShell,
  IconAction,
  MissingCard,
  RenderGuard,
  shareFile,
  SheetTabs,
  ViewerPager,
  type Align
} from '@/components/chat/FileChrome'
import { MarkdownView } from '@/components/chat/MarkdownView'

/**
 * Inline file viewers — the mobile counterparts of the desktop's
 * MarkdownFileViewer / CodeFileViewer / HtmlFileViewer / SpreadsheetViewer /
 * PdfViewer. Each renders a preview card at chat-bubble width and opens the
 * same content full-screen through ExpandedSheet, mirroring the desktop's
 * card→expand pair.
 *
 * Two mobile-specific rules, both about living inside a scrolling feed:
 *  - WebView previews (PDF, slides) are NON-INTERACTIVE (a WebView that
 *    scrolls inside the chat list steals the list's pan gesture) — tapping one
 *    expands it, and the expanded sheet is where scrolling, zooming and links
 *    live. Native bodies (markdown, source, CSV) scroll in place inside their
 *    clamp, and HTML is a live viewer (see HtmlFileCard) that takes the page's
 *    own height and only takes the gesture once the page is too tall to show
 *    whole. Every card keeps the footer's expand button either way;
 *  - the desktop's open/reveal/download trio collapses into the system share
 *    sheet, which is where "open in…", "save to Files" and "print" live.
 */

/** Line-numbered source and rendered markdown both clamp to this inline. */
const INLINE_BODY_HEIGHT = 260
/**
 * A live HTML card grows to its page's own height, up to this share of the
 * screen — past it the page scrolls inside the card instead.
 */
const HTML_INLINE_SCREEN_SHARE = 0.55
/** Ceiling for that share, so a tablet doesn't hand one page the whole feed. */
const HTML_MAX_INLINE_HEIGHT = 640
/** …and a floor, so a near-empty page still reads as a page and not a seam. */
const HTML_MIN_INLINE_HEIGHT = 96
/** Beyond this many characters the body is clipped for rendering only. */
const MAX_RENDER_CHARS = 120_000

/**
 * Injected into the inline HTML frame: reports the rendered page's size so the
 * card can take the page's own height instead of a fixed window.
 *
 * The width rides along because the two numbers are in different units. A page
 * that declares no viewport (or a wide one) lays out at the engine's default
 * width and is then scaled down to fit the card, so the height it reports is
 * in that page's CSS pixels, not the card's points — the width ratio is what
 * converts one to the other.
 *
 * Sent immediately (injectedJavaScript runs at document end, by which time a
 * cached page may already have fired `load`), again on `load` for pages still
 * fetching images, and thereafter whenever layout changes, which is how a page
 * that builds itself in JS gets a card the right size.
 */
const MEASURE_PAGE = `
(function () {
  var send = function () {
    var doc = document.documentElement
    var body = document.body
    if (!doc || !body) return
    // Measuring the page is the whole trick, and no single number does it:
    //  - the ROOT's scrolling area is floored at the viewport, so asking it
    //    alone means a two-line page answers with the height of the frame it
    //    was handed and the card can never shrink to fit its page;
    //  - the BODY's own box can shrink to nothing under absolutely positioned
    //    children (a slide deck, a page that lays itself out against the
    //    viewport), which would clip the page to a sliver.
    // So: take the body's content, widen it to the lowest edge any child
    // reaches, and only then let the root's number in — when it is larger
    // than the viewport, which is when it is reporting content rather than
    // the floor.
    var rect = body.getBoundingClientRect()
    var style = window.getComputedStyle(body)
    var margins = (parseFloat(style.marginTop) || 0) + (parseFloat(style.marginBottom) || 0)
    var bottom = 0
    var kids = body.children
    for (var i = 0; i < kids.length; i++) {
      var box = kids[i].getBoundingClientRect()
      if (box.height > 0 && box.bottom > bottom) bottom = box.bottom
    }
    var height = Math.max(
      body.scrollHeight,
      body.offsetHeight,
      Math.ceil(rect.height + margins),
      Math.ceil(bottom + window.scrollY + (parseFloat(style.marginBottom) || 0))
    )
    if (doc.scrollHeight > (window.innerHeight || 0)) height = Math.max(height, doc.scrollHeight)
    window.ReactNativeWebView.postMessage(
      JSON.stringify({ type: 'size', height: height, width: doc.clientWidth })
    )
  }
  send()
  window.addEventListener('load', send)
  if (window.ResizeObserver) new window.ResizeObserver(send).observe(document.body)
})();
true;
`

function CopyAction({ text }: { text: string }): React.JSX.Element {
  const { t } = useTranslation()
  const [copied, setCopied] = useState(false)
  const Icon = copied ? Tick02Icon : Copy01Icon
  return (
    <IconAction
      label={t('chat.copy')}
      icon={<Icon size={14} className={copied ? 'text-emerald-600' : 'text-muted'} />}
      onPress={() => {
        void Clipboard.setStringAsync(text).then(() => {
          setCopied(true)
          setTimeout(() => setCopied(false), 1500)
        })
      }}
    />
  )
}

export function ShareAction({ uri }: { uri: string | null }): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <IconAction
      label={t('chat.fileCard.share')}
      icon={<Upload01Icon size={14} className="text-muted" />}
      onPress={() => shareFile(uri)}
    />
  )
}

export function ExpandAction({ onPress }: { onPress: () => void }): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <IconAction
      label={t('chat.fileCard.expand')}
      icon={<ArrowExpandIcon size={14} className="text-muted" />}
      onPress={onPress}
    />
  )
}

/**
 * The card a viewer occupies while its bytes are still arriving.
 *
 * Deliberately not a spinner in a box: it is the SAME shell, the same header
 * (the icon and the name are known long before the file is), the same footer
 * with the same number of action slots, and a body of exactly the height the
 * loaded body will take. Loading and loaded therefore have one footprint, so
 * the file landing swaps content inside a box that never changes size —
 * nothing below it moves, and the feed's scroll position stays put. It is the
 * desktop's rule for the same problem (PdfViewer's loading state and its
 * iframe are both `h-[400px]`, ImageViewer's placeholder carries the image's
 * own aspect ratio) applied to the whole card rather than just the body.
 *
 * The reserved body carries the transfer itself (DownloadStatus) instead of a
 * shimmer — same footprint, but it says which download you are waiting on.
 */
export function ViewerSkeleton({
  align,
  icon,
  name,
  relPath,
  expectedBytes,
  bodyHeight,
  bodyAspect,
  footerLabel,
  actions
}: {
  align?: Align
  icon: ReactNode
  name: string
  /** The file being fetched — the key its progress is reported under. */
  relPath: string
  /** Size from the message metadata, if it carried one. */
  expectedBytes?: number
  /** Height of the body the loaded card will render. */
  bodyHeight: number
  /**
   * …or the shape it will take, for a body sized from its content's aspect
   * (a slide). Wins over `bodyHeight`, and reserves the same box the loaded
   * card will measure for itself.
   */
  bodyAspect?: number | null
  footerLabel?: string
  /** How many action buttons the loaded footer carries — they set its height. */
  actions: number
}): React.JSX.Element {
  return (
    <CardShell align={align}>
      <CardHeader icon={icon} name={name} />
      <View
        className="bg-bg border-border border-t p-3"
        style={bodyAspect ? { aspectRatio: bodyAspect } : { height: bodyHeight }}
      >
        <View className="bg-border h-full w-full rounded-lg opacity-40" />
        <DownloadStatus relPath={relPath} expectedBytes={expectedBytes} />
      </View>
      <CardFooter label={footerLabel}>
        {/* m-1.5 + 14pt matches IconAction's p-1.5 + 14pt icon, so the footer
            is the same height with placeholders as with real buttons. */}
        {Array.from({ length: actions }, (_, index) => (
          <View key={index} className="bg-border m-1.5 h-3.5 w-3.5 rounded opacity-40" />
        ))}
      </CardFooter>
    </CardShell>
  )
}

/**
 * Non-interactive preview that expands on tap — see the file header note.
 * Text-ish bodies pass `maxHeight` so a two-line file gets a two-line card;
 * WebView bodies (HTML, PDF) have no intrinsic height and pass `height`.
 *
 * A slide passes `aspectRatio` instead, and that is the only way to get it
 * exactly right: the card's real width is 85% of the feed's content box, which
 * is the screen less its horizontal padding, so any height computed from the
 * screen width is out by a few points and the slide letterboxes inside it.
 * Handing the ratio to the layout engine derives the height from the width
 * actually measured, which is exact by construction and stays exact if the
 * feed's padding ever changes.
 */
function PreviewTap({
  onPress,
  label,
  height,
  maxHeight,
  aspectRatio,
  children
}: {
  onPress: () => void
  label: string
  height?: number
  maxHeight?: number
  aspectRatio?: number
  children: ReactNode
}): React.JSX.Element {
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={label} onPress={onPress}>
      <View
        pointerEvents="none"
        style={
          aspectRatio !== undefined
            ? { aspectRatio }
            : height !== undefined
              ? { height }
              : { maxHeight }
        }
        className="overflow-hidden"
      >
        {children}
      </View>
    </Pressable>
  )
}

/** Line-numbered monospace body — one Text per column keeps it cheap. */
export function SourceBody({
  content,
  flex,
  maxHeight = INLINE_BODY_HEIGHT
}: {
  content: string
  flex?: boolean
  /** Inline clamp; the HTML card passes its own so both its views match. */
  maxHeight?: number
}): React.JSX.Element {
  const shown = content.length > MAX_RENDER_CHARS ? content.slice(0, MAX_RENDER_CHARS) : content
  const gutter = useMemo(
    () => Array.from({ length: Math.max(shown.split('\n').length, 1) }, (_, i) => i + 1).join('\n'),
    [shown]
  )
  return (
    <ScrollView
      className={flex ? 'flex-1' : ''}
      style={flex ? undefined : { maxHeight }}
      nestedScrollEnabled
    >
      {/* The gutter sits OUTSIDE the horizontal scroller — line numbers stay
          pinned to the leading edge while only the code slides sideways (the
          desktop does the same with `sticky left-0`). Both columns share the
          vertical scroller and the same line metrics, so rows stay aligned. */}
      <View className="flex-row" style={{ direction: 'ltr' }}>
        <View className="bg-bg-soft border-border border-e px-2 py-2">
          {/* text-muted, not muted/70: the alpha would drop (same var() rule
              as the CSV borders below) and default-black numbers vanish on
              a dark background. */}
          <Text
            className="text-muted text-right font-mono"
            style={{ fontSize: 11, lineHeight: 18 }}
            selectable={false}
          >
            {gutter}
          </Text>
        </View>
        <ScrollView horizontal showsHorizontalScrollIndicator={false}>
          <Text
            className="text-fg px-3 py-2 font-mono"
            style={{ fontSize: 11, lineHeight: 18 }}
            selectable
          >
            {shown}
          </Text>
        </ScrollView>
      </View>
    </ScrollView>
  )
}

function MarkdownBody({ content, flex }: { content: string; flex?: boolean }): React.JSX.Element {
  const shown = content.length > MAX_RENDER_CHARS ? content.slice(0, MAX_RENDER_CHARS) : content
  return (
    <ScrollView
      className={flex ? 'flex-1' : ''}
      style={flex ? undefined : { maxHeight: INLINE_BODY_HEIGHT }}
      contentContainerStyle={{ padding: 12 }}
      nestedScrollEnabled
    >
      <MarkdownView>{shown}</MarkdownView>
    </ScrollView>
  )
}

export type FileViewerProps = {
  relPath: string
  conversationId?: string
  classification: FileClassification
  sizeBytes?: number
  displayName?: string
  align?: Align
  /** Rendered when the body can't be shown inline (missing, oversized, binary). */
  fallback: React.JSX.Element
}

/**
 * Markdown, plain-text and source files: rendered markdown or line-numbered
 * source, clamped inline with copy/share/expand — the desktop's
 * MarkdownFileViewer/CodeFileViewer card.
 */
export function TextFileCard({
  relPath,
  conversationId,
  classification,
  sizeBytes,
  displayName,
  align,
  fallback
}: FileViewerProps): React.JSX.Element {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const {
    text,
    uri,
    sizeBytes: readSize,
    loading,
    missing,
    oversized
  } = useWorkspaceFileText(relPath, conversationId)
  const name = displayName ?? classification.name ?? baseName(relPath)
  const isMarkdown = classification.kind === 'markdown'
  const icon = isMarkdown ? (
    <File01Icon size={14} className="text-muted" />
  ) : (
    <CodeIcon size={14} className="text-muted" />
  )

  if (loading) {
    return (
      <ViewerSkeleton
        align={align}
        icon={icon}
        name={name}
        relPath={relPath}
        expectedBytes={sizeBytes}
        // The loaded body clamps AT this height; a file short enough to come in
        // under it settles upward by the difference. Reserving the clamp is the
        // better of the two errors — most delivered source files run past it,
        // and anything already cached renders at its true height on frame one
        // (useWorkspaceFileText) without passing through here at all.
        bodyHeight={INLINE_BODY_HEIGHT}
        footerLabel={[classification.language ?? classification.ext, formatBytes(sizeBytes ?? 0)]
          .filter(Boolean)
          .join(' · ')}
        actions={3}
      />
    )
  }
  if (missing || oversized || text === null) return fallback

  const lineCount = text.split('\n').length
  const body = isMarkdown ? <MarkdownBody content={text} /> : <SourceBody content={text} />
  const expandedBody = isMarkdown ? (
    <MarkdownBody content={text} flex />
  ) : (
    <SourceBody content={text} flex />
  )
  const footerLabel = [
    classification.language ?? classification.ext,
    formatBytes(sizeBytes || readSize)
  ]
    .filter(Boolean)
    .join(' · ')

  return (
    <CardShell align={align}>
      <CardHeader icon={icon} name={name} meta={t('chat.fileViewer.lines', { count: lineCount })} />
      {/* Scrolls in place (the body is a clamped ScrollView; nestedScrollEnabled
          hands the gesture back to the feed at its ends) — the footer's expand
          button is what opens the sheet, so no PreviewTap here. */}
      <View className="overflow-hidden">{body}</View>
      <CardFooter label={footerLabel}>
        <ShareAction uri={uri} />
        <CopyAction text={text} />
        <ExpandAction onPress={() => setOpen(true)} />
      </CardFooter>
      <ExpandedSheet
        open={open}
        onClose={() => setOpen(false)}
        title={name}
        actions={
          <>
            <ShareAction uri={uri} />
            <CopyAction text={text} />
          </>
        }
      >
        {expandedBody}
      </ExpandedSheet>
    </CardShell>
  )
}

/**
 * HTML files: a live (sandboxed) render of the page with a source toggle —
 * the desktop's HtmlFileViewer.
 *
 * Unlike every other card here the inline body is the real thing, not a
 * preview: the frame takes the PAGE'S OWN height (measured by MEASURE_PAGE)
 * so a delivered page shows whole, in the feed, the way it was written — and
 * only when a page runs past the screen share above does the card clamp and
 * let the page scroll inside it. Nothing about the body expands the card:
 * taps land on the page (a link opens in the system browser), and the footer's
 * expand button is what opens the full-screen sheet.
 */
export function HtmlFileCard({
  relPath,
  conversationId,
  classification,
  sizeBytes,
  displayName,
  align,
  fallback
}: FileViewerProps): React.JSX.Element {
  const { t } = useTranslation()
  const { height: screenHeight } = useWindowDimensions()
  const [open, setOpen] = useState(false)
  const [view, setView] = useState<'preview' | 'source'>('preview')
  // The page's rendered size, in ITS pixels, as last reported by the frame.
  const [page, setPage] = useState<{ height: number; width: number } | null>(null)
  // The frame's own width, in points — the other half of that conversion.
  const [frameWidth, setFrameWidth] = useState(0)
  const {
    text,
    uri,
    sizeBytes: readSize,
    loading,
    missing,
    oversized
  } = useWorkspaceFileText(relPath, conversationId)
  const name = displayName ?? classification.name ?? baseName(relPath)

  const maxHeight = Math.round(
    Math.min(
      Math.max(screenHeight * HTML_INLINE_SCREEN_SHARE, INLINE_BODY_HEIGHT),
      HTML_MAX_INLINE_HEIGHT
    )
  )

  if (loading) {
    return (
      <ViewerSkeleton
        align={align}
        icon={<CodeIcon size={14} className="text-muted" />}
        name={name}
        relPath={relPath}
        expectedBytes={sizeBytes}
        // The loaded frame OPENS at this height and settles to the page's own
        // height once it reports one. Reserving the clamp is the better of the
        // two errors: a page shorter than half a screen is the rare one, and a
        // page sized in `vh` measures exactly what it was given — starting at
        // the clamp is what makes those land at a readable height instead of
        // collapsing to the floor.
        bodyHeight={maxHeight}
        footerLabel={['html', formatBytes(sizeBytes ?? 0)].filter(Boolean).join(' · ')}
        actions={4}
      />
    )
  }
  if (missing || oversized || text === null) return fallback

  // Page height converted from the page's pixels to ours (see MEASURE_PAGE),
  // null until the frame has reported a size and the card has been laid out.
  const natural =
    page && page.width > 0 && frameWidth > 0
      ? Math.round(page.height * (frameWidth / page.width))
      : null
  const bodyHeight =
    natural === null ? maxHeight : Math.min(Math.max(natural, HTML_MIN_INLINE_HEIGHT), maxHeight)
  // Only a page too tall for the card scrolls inside it; anything that fits
  // hands every gesture straight back to the feed it is sitting in.
  const scrolls = natural === null || natural > maxHeight

  // The page runs for real — scripts and all — which is the point of
  // delivering an HTML file to a phone. It is confined the same way the
  // desktop's sandboxed iframe is: loaded from a string (opaque origin, no
  // baseUrl), no file access, no shared storage, so it can reach neither the
  // app's data nor the workspace cache. Only the initial document load may
  // navigate the frame — a tapped link opens in the system browser instead of
  // replacing the card's contents.
  const frame = (mode: 'card' | 'full'): React.JSX.Element => (
    <WebView
      originWhitelist={['*']}
      source={{ html: text }}
      style={{ backgroundColor: 'white' }}
      javaScriptEnabled
      allowFileAccess={false}
      allowFileAccessFromFileURLs={false}
      allowUniversalAccessFromFileURLs={false}
      domStorageEnabled={false}
      setSupportMultipleWindows={false}
      scrollEnabled={mode === 'full' || scrolls}
      // Android has no scrollEnabled; what it needs instead is permission to
      // hand the feed the gesture when the page reaches its end (iOS chains
      // that way already).
      nestedScrollEnabled
      injectedJavaScript={MEASURE_PAGE}
      onMessage={(event) => {
        // The sheet reports its size too — and lays the page out at a
        // different width, so taking that number would resize the card to it
        // the moment the sheet closes. Only the card's own frame counts.
        if (mode !== 'card') return
        let message: { type?: string; height?: number; width?: number }
        try {
          message = JSON.parse(event.nativeEvent.data) as typeof message
        } catch {
          return
        }
        if (message.type !== 'size' || !message.height || !message.width) return
        const next = { height: message.height, width: message.width }
        // A page measured in `vh` re-measures every time the card resizes to
        // it; the dead zone is what stops those two chasing each other a
        // pixel at a time.
        setPage((prev) =>
          prev && prev.width === next.width && Math.abs(prev.height - next.height) < 8 ? prev : next
        )
      }}
      onShouldStartLoadWithRequest={(request) => {
        if (request.url === 'about:blank' || request.url.startsWith('data:')) return true
        if (/^https?:/.test(request.url)) void WebBrowser.openBrowserAsync(request.url)
        return false
      }}
    />
  )

  const previewing = view === 'preview'
  const footerLabel = ['html', formatBytes(sizeBytes || readSize)].filter(Boolean).join(' · ')
  const viewToggle = (
    <IconAction
      label={t(`chat.htmlViewer.${previewing ? 'source' : 'preview'}`)}
      selected={previewing}
      icon={
        previewing ? (
          <CodeIcon size={14} className="text-muted" />
        ) : (
          <EyeIcon size={14} className="text-muted" />
        )
      }
      onPress={() => setView(previewing ? 'source' : 'preview')}
    />
  )

  return (
    <CardShell align={align}>
      <CardHeader icon={<CodeIcon size={14} className="text-muted" />} name={name} />
      <View
        className="overflow-hidden"
        // The rendered page is pinned to its measured height; source keeps the
        // scroll-inside-a-clamp shape the other text cards use, at the same
        // ceiling, so the toggle doesn't change the card's size twice over.
        style={previewing ? { height: bodyHeight } : undefined}
        onLayout={(event) => setFrameWidth(event.nativeEvent.layout.width)}
      >
        {/* While the sheet is up the card is hidden behind it — don't keep a
            second copy of the page (and its scripts) alive underneath. */}
        {previewing ? (
          open ? (
            <View className="bg-surface flex-1" />
          ) : (
            frame('card')
          )
        ) : (
          <SourceBody content={text} maxHeight={maxHeight} />
        )}
      </View>
      <CardFooter label={footerLabel}>
        {viewToggle}
        <ShareAction uri={uri} />
        <CopyAction text={text} />
        <ExpandAction onPress={() => setOpen(true)} />
      </CardFooter>
      <ExpandedSheet
        open={open}
        onClose={() => setOpen(false)}
        title={name}
        actions={
          <>
            {viewToggle}
            <ShareAction uri={uri} />
            <CopyAction text={text} />
          </>
        }
      >
        {previewing ? frame('full') : <SourceBody content={text} flex />}
      </ExpandedSheet>
    </CardShell>
  )
}

function SheetGrid({ table, flex }: { table: SheetTable; flex?: boolean }): React.JSX.Element {
  const [header, ...body] = table.rows
  return (
    <ScrollView
      horizontal
      className={flex ? 'flex-1' : ''}
      style={flex ? undefined : { maxHeight: INLINE_BODY_HEIGHT }}
    >
      <ScrollView nestedScrollEnabled style={flex ? undefined : { maxHeight: INLINE_BODY_HEIGHT }}>
        <View style={{ direction: 'ltr' }}>
          {header ? (
            <View className="bg-bg-soft border-border flex-row border-b">
              {header.map((cell, index) => (
                <Text
                  key={index}
                  selectable
                  numberOfLines={2}
                  className="text-fg font-sans-medium border-border w-32 border-e px-2 py-1.5 text-left text-[11px]"
                >
                  {cell}
                </Text>
              ))}
            </View>
          ) : null}
          {body.map((row, rowIndex) => (
            // border-soft, not border/60: an alpha modifier on a var() color
            // silently drops in RN and a dropped border color paints black
            // (see global.css) — the token is the same tone, precomputed.
            <View key={rowIndex} className="border-border-soft flex-row border-b">
              {row.map((cell, index) => (
                <Text
                  key={index}
                  selectable
                  numberOfLines={2}
                  className="text-fg border-border-soft w-32 border-e px-2 py-1.5 text-left font-sans text-[11px]"
                >
                  {cell}
                </Text>
              ))}
            </View>
          ))}
        </View>
      </ScrollView>
    </ScrollView>
  )
}

/** CSV/TSV rendered as a table — the desktop's SpreadsheetViewer for those. */
export function SheetFileCard({
  relPath,
  conversationId,
  classification,
  sizeBytes,
  displayName,
  align,
  fallback
}: FileViewerProps): React.JSX.Element {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const {
    text,
    uri,
    sizeBytes: readSize,
    loading,
    missing,
    oversized
  } = useWorkspaceFileText(relPath, conversationId)
  const table = useMemo(
    () => (text === null ? null : parseDelimited(text, delimiterFor(classification.ext))),
    [text, classification.ext]
  )
  const name = displayName ?? classification.name ?? baseName(relPath)

  if (loading) {
    return (
      <ViewerSkeleton
        align={align}
        icon={<Table01Icon size={14} className="text-muted" />}
        name={name}
        relPath={relPath}
        expectedBytes={sizeBytes}
        bodyHeight={INLINE_BODY_HEIGHT}
        footerLabel={formatBytes(sizeBytes ?? 0)}
        actions={3}
      />
    )
  }
  if (missing || oversized || text === null || table === null || table.rows.length === 0) {
    return fallback
  }

  const footerLabel = [
    t('chat.fileViewer.rows', { count: table.totalRows }),
    formatBytes(sizeBytes || readSize)
  ]
    .filter(Boolean)
    .join(' · ')

  return (
    <CardShell align={align}>
      <CardHeader icon={<Table01Icon size={14} className="text-muted" />} name={name} />
      {/* Scrolls in place, same as TextFileCard; expand lives in the footer. */}
      <View className="overflow-hidden">
        <SheetGrid table={table} />
      </View>
      <CardFooter label={footerLabel}>
        <ShareAction uri={uri} />
        <CopyAction text={text} />
        <ExpandAction onPress={() => setOpen(true)} />
      </CardFooter>
      <ExpandedSheet
        open={open}
        onClose={() => setOpen(false)}
        title={name}
        actions={
          <>
            <ShareAction uri={uri} />
            <CopyAction text={text} />
          </>
        }
      >
        <SheetGrid table={table} flex />
      </ExpandedSheet>
    </CardShell>
  )
}

/**
 * PDFs — a first-page preview that expands to a scrollable document, the
 * desktop's PdfViewer.
 *
 * Two engines behind one card. iOS renders PDFs natively in WKWebView, so
 * there the frame is simply pointed at the file. Android's WebView has never
 * shipped a PDF engine, so the renderer travels with the page: lib/pdf/html
 * composes a self-contained pdf.js document around the file's bytes, and the
 * frame loads that instead. Everything outside `source` is the same, including
 * the closed sandbox — neither engine may read a second file.
 *
 * The card still degrades to the plain file row (`fallback`, which hands the
 * document to the system viewer through the share sheet) when the file is past
 * the inline ceiling or pdf.js cannot make a page out of it.
 */
export function PdfFileCard({
  relPath,
  conversationId,
  classification,
  sizeBytes,
  displayName,
  align,
  fallback
}: FileViewerProps): React.JSX.Element {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const { uri, sizeBytes: cachedSize, loading, missing } = useWorkspaceFile(relPath, conversationId)
  const name = displayName ?? classification.name ?? baseName(relPath)

  const native = Platform.OS === 'ios'
  const bytes = sizeBytes || cachedSize
  const oversized = !native && bytes > PDF_MAX_INLINE_BYTES
  const [host, setHost] = useState<PdfHostDocument | null>(null)
  // Set by a page that loaded but could not render — a PDF pdf.js rejects, or
  // a document too heavy for the WebView's renderer. Both end at the file row.
  const [engineFailed, setEngineFailed] = useState(false)
  // Remounts the frame if the renderer dies under a large document.
  const [generation, setGeneration] = useState(0)

  useEffect(() => {
    if (native || !uri || oversized) return
    let alive = true
    ensurePdfHostDocument(uri, `${relPath}:${bytes}`)
      .then((built) => {
        if (alive) setHost(built)
      })
      .catch(() => {
        // Asset read or a full disk — the file row still shares the document.
        if (alive) setEngineFailed(true)
      })
    return () => {
      alive = false
    }
  }, [native, uri, oversized, relPath, bytes])

  if (loading || (!native && uri && !oversized && !host && !engineFailed)) {
    return (
      <ViewerSkeleton
        align={align}
        icon={<Pdf02Icon size={14} className="text-muted" />}
        name={name}
        relPath={relPath}
        expectedBytes={sizeBytes}
        // Exact: the loaded document frame is pinned to this same height.
        bodyHeight={INLINE_BODY_HEIGHT + 60}
        footerLabel={[classification.ext.toUpperCase(), formatBytes(sizeBytes ?? 0)]
          .filter(Boolean)
          .join(' · ')}
        actions={2}
      />
    )
  }
  if (missing || !uri) return fallback
  if (!native && (oversized || engineFailed || !host)) return fallback

  const directory = native ? uri.slice(0, uri.lastIndexOf('/') + 1) : host!.directory
  // The composed page serves both mounts; the hash is how it knows which one
  // is asking (page 1, pinned — or every page, scrollable and zoomable).
  const documentUri = (mode: 'preview' | 'full'): string => (native ? uri : `${host!.uri}#${mode}`)
  const frame = (mode: 'preview' | 'full'): React.JSX.Element => (
    <WebView
      key={`${mode}-${generation}`}
      source={{ uri: documentUri(mode) }}
      // Without file:// in the whitelist the WebView refuses the document and
      // punts it to Linking.openURL, which can't open a sandbox path — the
      // card renders blank. This is what makes the PDF preview appear at all.
      originWhitelist={['file://*']}
      // iOS needs explicit read access to the containing directory to load a
      // file:// document; scoping it to the file's own folder keeps the frame
      // away from the rest of the cache.
      allowingReadAccessToURL={directory}
      allowFileAccess
      // Shut on both platforms, and load-bearing on Android: it is what says
      // the pdf.js page may not go reading the rest of the sandbox. Closing it
      // is why the document is inlined into the page rather than fetched.
      allowFileAccessFromFileURLs={false}
      allowUniversalAccessFromFileURLs={false}
      javaScriptEnabled
      domStorageEnabled={false}
      setSupportMultipleWindows={false}
      style={{ backgroundColor: 'white' }}
      onShouldStartLoadWithRequest={(request) => request.url.startsWith('file://')}
      onMessage={(event) => {
        let message: { type?: string }
        try {
          message = JSON.parse(event.nativeEvent.data) as typeof message
        } catch {
          return
        }
        if (message.type === 'error') setEngineFailed(true)
      }}
      onContentProcessDidTerminate={() => setGeneration((n) => n + 1)}
      onRenderProcessGone={() => setGeneration((n) => n + 1)}
    />
  )

  return (
    <CardShell align={align}>
      <CardHeader icon={<Pdf02Icon size={14} className="text-muted" />} name={name} />
      <PreviewTap onPress={() => setOpen(true)} label={name} height={INLINE_BODY_HEIGHT + 60}>
        {/* One document renderer at a time — see HtmlFileCard. */}
        {open ? <View className="bg-surface flex-1" /> : frame('preview')}
      </PreviewTap>
      <CardFooter
        label={[classification.ext.toUpperCase(), formatBytes(bytes)].filter(Boolean).join(' · ')}
      >
        <ShareAction uri={uri} />
        <ExpandAction onPress={() => setOpen(true)} />
      </CardFooter>
      <ExpandedSheet
        open={open}
        onClose={() => setOpen(false)}
        title={name}
        actions={<ShareAction uri={uri} />}
      >
        {frame('full')}
      </ExpandedSheet>
    </CardShell>
  )
}

/** CardShell's `w-[85%]` — the width an office page is scaled to fit. */
const CARD_WIDTH_SHARE = 0.85
/**
 * Bounds on the body an office page is given. The floor keeps a wide, short
 * page (a 2:1 banner slide) from becoming a letterbox slit; the ceiling keeps
 * a portrait Word page from taking most of the screen, and is a little above
 * wolffish-app's own `max-h-100` for the same card.
 */
const OFFICE_MIN_BODY = 180
const OFFICE_MAX_BODY = 420

/**
 * Which engine, icon and position line a classification maps to, and the page
 * shape to assume before the file has been read.
 *
 * The assumed aspect is what keeps the card one size: the skeleton, the
 * loading frame and the loaded slide all use it, so a 16:9 deck never resizes
 * when the renderer reports back. A 4:3 deck settles a little taller, which is
 * the one nudge left. Documents and workbooks scroll rather than fill a frame
 * of their own shape, so they keep a plain window height throughout.
 */
const OFFICE_KINDS = {
  document: { kind: 'docx', position: 'chat.officeViewer.pageOf', aspect: null },
  workbook: { kind: 'xlsx', position: 'chat.officeViewer.sheetOf', aspect: null },
  slides: { kind: 'pptx', position: 'chat.officeViewer.slideOf', aspect: 16 / 9 }
} as const satisfies Record<string, { kind: OfficeKind; position: string; aspect: number | null }>

type OfficeCardKind = keyof typeof OFFICE_KINDS

function officeIcon(kind: OfficeCardKind): React.JSX.Element {
  if (kind === 'workbook') return <Table01Icon size={14} className="text-muted" />
  if (kind === 'slides') return <PresentationBarChart01Icon size={14} className="text-muted" />
  return <File01Icon size={14} className="text-muted" />
}

/**
 * Word documents, Excel workbooks and PowerPoint decks — the desktop's
 * DocxViewer, SpreadsheetViewer and PresentationViewer behind one card.
 *
 * The whole file renders, not a first page: every page, every slide, every
 * sheet, with a pager in the footer for moving between them. The engines are
 * wolffish-app's own (see assets/office/README.md), running inside a WebView
 * over a self-contained host page — lib/office/html composes it the same way
 * lib/pdf/html composes the Android PDF page.
 *
 * Unlike the PDF card this uses one engine on BOTH platforms. iOS renders all
 * three formats natively in WKWebView and does it beautifully, but that engine
 * reports no page count, no sheet names and offers no way to jump to slide
 * seven, so a card built on it could not have a pager at all — and the two
 * platforms would not agree about what the document looks like.
 *
 * Degrades to the plain file row (`fallback`) when the file is past the inline
 * ceiling, when an engine cannot make pages out of it, or when the WebView
 * never reports back — which is what a legacy .doc or an encrypted package
 * does. The share sheet there still hands it to an app that can open it.
 */
export function OfficeFileCard({
  relPath,
  conversationId,
  classification,
  sizeBytes,
  displayName,
  align,
  fallback
}: FileViewerProps): React.JSX.Element {
  const { t } = useTranslation()
  const tokens = useTokens()
  const { width: screenWidth } = useWindowDimensions()
  const [open, setOpen] = useState(false)
  const { uri, sizeBytes: cachedSize, loading, missing } = useWorkspaceFile(relPath, conversationId)
  const name = displayName ?? classification.name ?? baseName(relPath)

  const cardKind = classification.kind as OfficeCardKind
  const spec = OFFICE_KINDS[cardKind]
  const bytes = sizeBytes || cachedSize
  const oversized = bytes > OFFICE_MAX_INLINE_BYTES

  const [host, setHost] = useState<OfficeHostDocument | null>(null)
  // Set by a page that loaded but could not render — a document no engine
  // accepts, or one too heavy for the WebView. Both end at the file row.
  const [engineFailed, setEngineFailed] = useState(false)
  const [pages, setPages] = useState(0)
  const [labels, setLabels] = useState<string[] | null>(null)
  const [index, setIndex] = useState(0)
  // A page's own width/height, when it has one. Documents and decks do; a
  // workbook sheet does not, so it keeps the default body height. Seeded with
  // the kind's usual shape so the card does not resize when the real one lands.
  const [aspect, setAspect] = useState<number | null>(spec.aspect)
  // Pages the file actually holds, when the renderer stopped short of them.
  const [total, setTotal] = useState(0)
  // Set once the page has said anything at all — which is also what stops the
  // watchdog below.
  const [answered, setAnswered] = useState(false)
  // Remounts the frame if the renderer dies under a large document.
  const [generation, setGeneration] = useState(0)
  // One ref per mount rather than one shared: the card's frame unmounts as the
  // sheet's mounts, and a single ref would be nulled by whichever teardown ran
  // last, leaving the pager pointing at nothing.
  const cardRef = useRef<WebView | null>(null)
  const sheetRef = useRef<WebView | null>(null)
  const frameRef = open ? sheetRef : cardRef

  // The theme is part of the composed page (the workbook grid is app chrome,
  // so it has to be), which makes it part of the cache key too.
  const theme = useMemo(
    () => ({
      bg: tokens.bg,
      surface: tokens.surface,
      fg: tokens.fg,
      muted: tokens.muted,
      border: tokens.border
    }),
    [tokens]
  )

  useEffect(() => {
    if (!uri || oversized) return
    let alive = true
    ensureOfficeHostDocument(uri, spec.kind, theme, `${relPath}:${bytes}:${tokens.bg}`)
      .then((built) => {
        if (alive) setHost(built)
      })
      .catch(() => {
        // Asset read or a full disk — the file row still shares the document.
        if (alive) setEngineFailed(true)
      })
    return () => {
      alive = false
    }
  }, [uri, oversized, relPath, bytes, spec.kind, theme, tokens.bg])

  // The runtime answers `ready` or `error` for everything it can see going
  // wrong, but not for what kills it first: a truncated engine asset, a page
  // the WebView drops on the floor, a renderer that dies before it runs. Those
  // send nothing at all, and without this the card would hold an empty frame
  // for the rest of the session instead of degrading to a row that at least
  // opens the file. Generous, because `ready` waits on a full docx layout.
  useEffect(() => {
    if (!host || answered || engineFailed) return
    const timer = setTimeout(() => setEngineFailed(true), 20_000)
    return () => clearTimeout(timer)
  }, [host, answered, engineFailed, generation])

  const goTo = useCallback(
    (next: number) => {
      if (next < 0 || (pages > 0 && next >= pages)) return
      setIndex(next)
      frameRef.current?.injectJavaScript(`window.wolffishGoTo(${next});true;`)
    },
    [frameRef, pages]
  )

  // A slide takes its own shape, the way wolffish-app's PresentationViewer puts
  // one in an aspectRatio box — the layout engine derives the height from the
  // width it actually measures, so the slide fills the card edge to edge with
  // no mat. A document and a workbook are windows onto something that scrolls,
  // so they keep a plain window height.
  const bodyAspect = aspect && aspect > 0 ? aspect : null

  if (loading || (uri && !oversized && !host && !engineFailed)) {
    return (
      <ViewerSkeleton
        align={align}
        icon={officeIcon(cardKind)}
        name={name}
        relPath={relPath}
        expectedBytes={sizeBytes}
        // Exact: the loaded document frame is pinned to this same height.
        bodyHeight={INLINE_BODY_HEIGHT + 60}
        bodyAspect={bodyAspect}
        footerLabel={[classification.ext.toUpperCase(), formatBytes(sizeBytes ?? 0)]
          .filter(Boolean)
          .join(' · ')}
        actions={4}
      />
    )
  }
  if (missing || !uri) return fallback
  if (oversized || engineFailed || !host) return fallback

  const frame = (ref: React.RefObject<WebView | null>): React.JSX.Element => (
    <WebView
      key={generation}
      ref={ref}
      source={{ uri: host.uri }}
      // Without file:// in the whitelist the WebView refuses the document and
      // punts it to Linking.openURL, which can't open a sandbox path — the
      // card renders blank. This is what makes the preview appear at all.
      originWhitelist={['file://*']}
      // iOS needs explicit read access to the containing directory to load a
      // file:// document; scoping it to the host folder keeps the frame away
      // from the rest of the cache.
      allowingReadAccessToURL={host.directory}
      allowFileAccess
      // Shut on both platforms: the composed page may not go reading the rest
      // of the sandbox. Closing it is why the document is inlined rather than
      // fetched.
      allowFileAccessFromFileURLs={false}
      allowUniversalAccessFromFileURLs={false}
      javaScriptEnabled
      domStorageEnabled={false}
      setSupportMultipleWindows={false}
      // Android does not chain a nested scroller's gesture to its parent
      // unless told to; iOS already does. Without it a document in the feed
      // would swallow the pan and the chat list could not be scrolled past it.
      nestedScrollEnabled
      style={{ backgroundColor: tokens.surface }}
      onShouldStartLoadWithRequest={(request) => request.url.startsWith('file://')}
      // The composed page is a local file, so a load error means it is gone or
      // unreadable — there is nothing to retry into.
      onError={() => setEngineFailed(true)}
      onMessage={(event) => {
        let message: {
          type?: string
          pages?: number
          labels?: string[] | null
          index?: number
          aspect?: number | null
          total?: number
        }
        try {
          message = JSON.parse(event.nativeEvent.data) as typeof message
        } catch {
          return
        }
        setAnswered(true)
        if (message.type === 'error') setEngineFailed(true)
        if (message.type === 'ready') {
          setPages(message.pages ?? 0)
          setLabels(message.labels ?? null)
          // Only a real measurement moves the card off its seeded shape; a
          // renderer that reports none (a document, a workbook) is saying it
          // scrolls, and the seed is already null for those.
          if (typeof message.aspect === 'number' && message.aspect > 0) {
            setAspect(message.aspect)
          }
          setTotal(message.total ?? 0)
          if (!message.pages) setEngineFailed(true)
          // A frame that just mounted starts at the top; the reader's place is
          // held in RN state, so restore it rather than snapping them back —
          // expanding from slide 7 should open the sheet at slide 7.
          else if (index > 0) {
            ref.current?.injectJavaScript(`window.wolffishGoTo(${index});true;`)
          }
        }
        if (message.type === 'page' && typeof message.index === 'number') setIndex(message.index)
      }}
      // A remount is a fresh page that has said nothing yet, so the watchdog
      // has to be re-armed with it — otherwise a frame that dies twice leaves
      // the card empty with nothing left to notice.
      onContentProcessDidTerminate={() => {
        setAnswered(false)
        setGeneration((n) => n + 1)
      }}
      onRenderProcessGone={() => {
        setAnswered(false)
        setGeneration((n) => n + 1)
      }}
    />
  )

  // Three ways to get around, one per kind, and each is the only one that
  // suits it:
  //   a workbook by its named tabs, so the footer carries the size alone;
  //   a deck by its chevrons, because slides are switched between;
  //   a document by SCROLLING, so it gets neither — its footer line is a
  //   read-only position that follows the scroll, which is exactly what
  //   wolffish-app's DocxViewer shows (it passes ViewerPager no onChange).
  const tabbed = cardKind === 'workbook' && !!labels && labels.length > 1
  const paged = cardKind === 'slides'
  const scrolls = cardKind === 'document'
  const position =
    pages > 0 && !tabbed
      ? t(spec.position, { index: index + 1, count: pages, defaultValue: '' })
      : ''
  const footerLabel = [
    position,
    // Said out loud rather than silently dropped: a 400-slide deck that stops
    // at 200 must not look like a 200-slide deck.
    total > pages ? t('chat.officeViewer.partial', { count: pages, total }) : '',
    formatBytes(bytes)
  ]
    .filter(Boolean)
    .join(' · ')
  const pager =
    paged && pages > 1 ? <ViewerPager index={index} count={pages} onChange={goTo} /> : null
  const tabs = tabbed ? <SheetTabs names={labels} index={index} onSelect={goTo} /> : null

  return (
    <CardShell align={align}>
      <CardHeader icon={officeIcon(cardKind)} name={name} />
      {scrolls ? (
        // A document is LIVE in the feed: it scrolls under the finger here the
        // same way it does in the sheet, because that is how a document is
        // read and paging one is the wrong shape entirely. It is the same
        // exception HtmlFileCard makes, and it is safe for the same reason —
        // `nestedScrollEnabled` hands the gesture back to the chat list once
        // the document reaches its end, so scrolling past the card still
        // works. Expanding moves to the footer button, since the body is no
        // longer a tap target.
        <View className="overflow-hidden" style={{ height: INLINE_BODY_HEIGHT + 60 }}>
          {/* One document renderer at a time — see HtmlFileCard. */}
          {open ? <View className="bg-surface flex-1" /> : frame(cardRef)}
        </View>
      ) : (
        <PreviewTap
          onPress={() => setOpen(true)}
          label={name}
          height={bodyAspect === null ? INLINE_BODY_HEIGHT + 60 : undefined}
          aspectRatio={bodyAspect ?? undefined}
        >
          {open ? <View className="bg-surface flex-1" /> : frame(cardRef)}
        </PreviewTap>
      )}
      {/* Outside PreviewTap: that wrapper is pointerEvents="none" so the card
          body stays a tap target for expanding, and tabs have to be tappable. */}
      {tabs}
      <CardFooter label={footerLabel}>
        {pager}
        <ShareAction uri={uri} />
        <ExpandAction onPress={() => setOpen(true)} />
      </CardFooter>
      <ExpandedSheet
        open={open}
        onClose={() => setOpen(false)}
        title={name}
        actions={
          <>
            {pager}
            <ShareAction uri={uri} />
          </>
        }
      >
        <View className="flex-1">{frame(sheetRef)}</View>
        {tabs}
      </ExpandedSheet>
    </CardShell>
  )
}

/**
 * The catch-all card: icon, name, type · size, and a tap that hands the file
 * to the OS (share sheet → open in…, save to Files). Also the fallback every
 * viewer above degrades to.
 */
export function GenericFileCard({
  relPath,
  conversationId,
  sizeBytes,
  displayName,
  classification,
  align
}: {
  relPath: string
  conversationId?: string
  sizeBytes?: number
  displayName?: string
  classification: FileClassification
  align?: Align
}): React.JSX.Element {
  const { t } = useTranslation()
  const { uri, sizeBytes: cachedSize, loading, missing } = useWorkspaceFile(relPath, conversationId)
  const name = displayName ?? classification.name ?? baseName(relPath)
  // Attachments carry a size; delivered files don't — fall back to the file
  // the cache actually holds (the desktop stats over IPC for the same reason).
  const shownSize = sizeBytes || cachedSize

  if (!loading && (missing || !uri)) {
    return <MissingCard label={t('chat.fileCard.deleted')} align={align} />
  }

  const isPdf = classification.kind === 'pdf'
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={name}
      disabled={loading || !uri}
      onPress={() => shareFile(uri)}
      className={cn(
        // w-[85%], not max-w — a card sized to its filename would sit short of
        // every other card in the feed.
        'bg-surface border-border w-[85%] flex-row items-center gap-3 rounded-xl border px-4 py-3',
        'active:bg-border-soft',
        align === 'end' ? 'self-end' : 'self-start'
      )}
    >
      <View className="bg-bg border-border h-10 w-10 items-center justify-center rounded-lg border">
        {loading ? (
          <DownloadGlyph />
        ) : isPdf ? (
          <Pdf02Icon size={18} className="text-muted" />
        ) : (
          <File01Icon size={18} className="text-muted" />
        )}
      </View>
      {/* Held to the leading box's height in both states — the loaded column is
          shorter than the box, so the box is what sets this row's height, and
          the loading column has to stay inside it or the bytes landing would
          resize the card and nudge the feed. `h-10` rather than a number: it
          is the box's own class, so the two track each other. */}
      <View className="min-w-0 h-10 flex-1 flex-col justify-center gap-0.5 overflow-hidden">
        <Text numberOfLines={1} className="text-fg font-sans-medium text-left text-sm">
          {name}
        </Text>
        {loading ? (
          <DownloadStatus relPath={relPath} expectedBytes={shownSize} variant="row" rowGap={2} />
        ) : (
          <Text className="text-muted text-left font-sans text-xs">
            {[classification.ext.toUpperCase(), formatBytes(shownSize)].filter(Boolean).join(' · ')}
          </Text>
        )}
      </View>
    </Pressable>
  )
}
