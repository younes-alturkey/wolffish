import { useTokens } from '@/providers/theme/useTheme'
import { useMemo } from 'react'
import { I18nManager, Platform, ScrollView, Text, View, useWindowDimensions } from 'react-native'
import Markdown from 'react-native-markdown-display'
import * as WebBrowser from 'expo-web-browser'
import type { ThemeTokens } from '@/lib/theme/colors'

/**
 * Markdown for chat bubbles — mirrors the desktop core/Markdown component:
 * GFM-ish rendering (markdown-it default: tables, autolinks, strikethrough),
 * bordered LTR code blocks, horizontally scrollable tables, accent links
 * opened in the in-app browser. Styled from the live theme tokens so it
 * follows light/dark, with a variant for the primary-colored user bubble.
 *
 * Every text run is selectable — see the `textgroup` rule below. This is the
 * one place that has to be got right for the whole feed: react-native-markdown-
 * display renders its own Text nodes, so no amount of props on the bubble
 * reaches them.
 */

export type MarkdownVariant = 'assistant' | 'user'

const MONO_FONT = Platform.select({ ios: 'Menlo', android: 'monospace', default: 'monospace' })

/**
 * First strong directional character decides the block's direction — the
 * mobile equivalent of the desktop's dir="auto" on message content. Beyond
 * fidelity this is load-bearing: laying out RTL-dominant text under a forced
 * LTR writingDirection makes iOS text measurement explode to absurd heights
 * (observed with real Arabic digest conversations).
 */
const STRONG_LTR_RE = /[A-Za-zÀ-ɏ]/g
const STRONG_RTL_RE = /[֐-ࣿיִ-﷽ﹰ-ﻼ]/g

/** Whether markdown contains a GFM table — such bubbles need definite width. */
export function markdownHasTable(text: string): boolean {
  return /^\s*\|.*\|\s*$/m.test(text)
}

export function contentIsRtl(text: string): boolean {
  const sample = text.slice(0, 2000)
  const ltr = sample.match(STRONG_LTR_RE)?.length ?? 0
  const rtl = sample.match(STRONG_RTL_RE)?.length ?? 0
  if (ltr === 0 && rtl === 0) return I18nManager.isRTL
  return rtl > ltr
}

function buildStyles(
  tokens: ThemeTokens,
  variant: MarkdownVariant,
  rtl: boolean
): Record<string, object> {
  const onPrimary = variant === 'user'
  const fg = onPrimary ? tokens.primaryFg : tokens.fg
  const muted = onPrimary ? tokens.primaryFg : tokens.muted
  const border = onPrimary ? `${tokens.primaryFg}44` : tokens.border
  const codeBg = onPrimary ? '#00000022' : tokens.bg
  const accent = onPrimary ? tokens.primaryFg : tokens.accent

  return {
    body: {
      color: fg,
      fontFamily: 'IBMPlexSansArabic-Regular',
      fontSize: 14,
      lineHeight: 21,
      writingDirection: rtl ? 'rtl' : 'ltr',
      textAlign: rtl ? 'right' : 'left'
    },
    paragraph: { marginTop: 0, marginBottom: 8 },
    heading1: {
      fontFamily: 'IBMPlexSansArabic-SemiBold',
      fontSize: 20,
      marginBottom: 8,
      marginTop: 8
    },
    heading2: {
      fontFamily: 'IBMPlexSansArabic-SemiBold',
      fontSize: 18,
      marginBottom: 8,
      marginTop: 8
    },
    heading3: {
      fontFamily: 'IBMPlexSansArabic-SemiBold',
      fontSize: 16,
      marginBottom: 6,
      marginTop: 6
    },
    heading4: {
      fontFamily: 'IBMPlexSansArabic-SemiBold',
      fontSize: 14,
      marginBottom: 6,
      marginTop: 6
    },
    strong: { fontFamily: 'IBMPlexSansArabic-SemiBold' },
    em: { fontStyle: 'italic' },
    link: { color: accent, textDecorationLine: 'underline' },
    blockquote: {
      backgroundColor: 'transparent',
      borderStartWidth: 2,
      borderStartColor: border,
      borderLeftWidth: 2,
      borderLeftColor: border,
      paddingLeft: 12,
      paddingRight: 0,
      marginLeft: 0,
      color: muted,
      fontStyle: 'italic'
    },
    hr: { backgroundColor: border, height: 1, marginVertical: 12 },
    bullet_list: { marginBottom: 8 },
    ordered_list: { marginBottom: 8 },
    list_item: { marginBottom: 2 },
    // A list item is a row — the marker, then the item's own content — and the
    // library sizes that content with `flex: 1`, i.e. a flex-basis of ZERO. A
    // zero basis contributes nothing to the max-content width, so a bubble that
    // hugs its content (max-w with no definite width) picks its width from the
    // paragraphs alone. Yoga measures the list's height at the wider max-width
    // it was still free to use, then lays the list out at the narrower width the
    // bubble settled on: the item wraps to more lines than the measured height
    // has room for, and the overflow pushes whatever follows the list — usually
    // the closing paragraph — straight through the bubble's bottom padding.
    // Basing the content on its intrinsic width makes the list count toward the
    // width it is then given, so measure and layout agree. `flex: 0` is
    // load-bearing: Yoga only honours an `auto` basis when the shorthand is not
    // also asking for zero, and the library's own `flex: 1` survives the merge.
    bullet_list_content: { flex: 0, flexGrow: 1, flexShrink: 1, flexBasis: 'auto' },
    ordered_list_content: { flex: 0, flexGrow: 1, flexShrink: 1, flexBasis: 'auto' },
    code_inline: {
      backgroundColor: codeBg,
      color: fg,
      fontFamily: MONO_FONT,
      fontSize: 12,
      borderWidth: 0,
      borderRadius: 4,
      paddingHorizontal: 4,
      paddingVertical: 1
    },
    code_block: {
      backgroundColor: codeBg,
      color: fg,
      fontFamily: MONO_FONT,
      fontSize: 12,
      lineHeight: 18,
      borderWidth: 1,
      borderColor: border,
      borderRadius: 8,
      padding: 12,
      writingDirection: 'ltr',
      textAlign: 'left'
    },
    fence: {
      backgroundColor: codeBg,
      color: fg,
      fontFamily: MONO_FONT,
      fontSize: 12,
      lineHeight: 18,
      borderWidth: 1,
      borderColor: border,
      borderRadius: 8,
      padding: 12,
      writingDirection: 'ltr',
      textAlign: 'left'
    },
    // Every border-bearing key must be overridden — the library defaults
    // tables and blocklinks to pure #000000, which reads as a harsh black
    // line in both themes.
    table: {
      borderWidth: 1,
      borderColor: border,
      borderRadius: 8,
      marginBottom: 8
    },
    thead: { borderColor: border },
    tbody: { borderColor: border },
    th: {
      padding: 8,
      fontFamily: 'IBMPlexSansArabic-SemiBold',
      fontSize: 13,
      minWidth: 112,
      textAlign: 'left',
      borderColor: border
    },
    tr: { borderBottomWidth: 1, borderColor: border, flexDirection: 'row' },
    td: { padding: 8, fontSize: 13, minWidth: 112, textAlign: 'left', borderColor: border },
    blocklink: { borderColor: border, borderBottomWidth: 1 },
    image: { borderRadius: 16, marginVertical: 4 }
  }
}

/**
 * Whether `selectable` is worth setting on this platform.
 *
 * Android: yes — it maps to setTextIsSelectable(true), which is real in-place
 * selection with drag handles, exactly what a reader wants.
 *
 * iOS: no. React Native ships no granular text selection for <Text> there —
 * RCTSelectableText exists only under ReactAndroid, and `selectable` resolves
 * to RCTParagraphComponentView, whose whole contribution is a long-press menu
 * that copies the entire node. That duplicates the feed's own copy button
 * while stealing the long press that could do something better, so iOS routes
 * the long press to SelectTextSheet instead (see `onLongPress`).
 */
const IN_PLACE_SELECTION = Platform.OS === 'android'

/**
 * Fenced and indented code. `node.type` is the style key too ('fence' or
 * 'code_block'), which is how one function serves both rules.
 */
function codeBlockRule(
  node: { key: string; type: string; content: string },
  _children: React.ReactNode,
  _parents: unknown,
  merged: Record<string, object>,
  inherited?: object,
  onLongPress?: () => void
): React.ReactNode {
  // markdown-it hands these blocks one trailing newline too many.
  const content = node.content.endsWith('\n') ? node.content.slice(0, -1) : node.content
  return (
    <Text
      key={node.key}
      selectable={IN_PLACE_SELECTION}
      onLongPress={onLongPress}
      suppressHighlighting
      style={[inherited, merged[node.type]]}
    >
      {content}
    </Text>
  )
}

export type MarkdownViewProps = {
  children: string
  variant?: MarkdownVariant
  /**
   * Long press anywhere in the rendered text. Used on iOS to open the free
   * selection sheet; harmless to pass on Android, where the platform's own
   * selection claims the gesture first.
   */
  onLongPress?: () => void
}

export function MarkdownView({
  children,
  variant = 'assistant',
  onLongPress
}: MarkdownViewProps): React.JSX.Element {
  const tokens = useTokens()
  const { width } = useWindowDimensions()
  const rtl = useMemo(() => contentIsRtl(children), [children])
  const styles = useMemo(() => buildStyles(tokens, variant, rtl), [tokens, variant, rtl])
  const rules = useMemo(
    () => ({
      // Selection. The library renders its own Text nodes, so this rule is the
      // only way to reach them. `textgroup` — not the leaf `text` rule — is the
      // right seam: the parser wraps every inline run in one (paragraph,
      // heading, list item, blockquote, table cell), and nested Text is virtual,
      // so a single native text node carries the run's bold/italic/code/link
      // children with it.
      //
      // onLongPress rides the same node. A link's own <Text onPress> is nested
      // INSIDE this one and stays the closer handler for its own range, so
      // tapping a link still opens it.
      textgroup: (
        node: { key: string },
        children: React.ReactNode,
        _parents: unknown,
        merged: Record<string, object>
      ) => (
        <Text
          key={node.key}
          selectable={IN_PLACE_SELECTION}
          onLongPress={onLongPress}
          suppressHighlighting
          style={merged.textgroup}
        >
          {children}
        </Text>
      ),
      // Fences and indented code are BLOCK tokens — the parser never wraps them
      // in a textgroup, so they need the props of their own, or code (the thing
      // most worth copying) would be the one thing you couldn't. Both rules
      // otherwise reproduce the library's own: inherited text styles under the
      // block style, and the parser's surplus trailing newline trimmed off.
      // Bound here rather than passed as a rule directly because the library
      // calls rules with a fixed argument list that has no room for a handler.
      fence: (
        node: { key: string; type: string; content: string },
        children: React.ReactNode,
        parents: unknown,
        merged: Record<string, object>,
        inherited?: object
      ) => codeBlockRule(node, children, parents, merged, inherited, onLongPress),
      code_block: (
        node: { key: string; type: string; content: string },
        children: React.ReactNode,
        parents: unknown,
        merged: Record<string, object>,
        inherited?: object
      ) => codeBlockRule(node, children, parents, merged, inherited, onLongPress),
      // Tables and fenced code overflow horizontally inside their own
      // scroller — the feed itself must never scroll sideways.
      // NOTE: a bubble containing a table must have a DEFINITE width
      // (w-[85%], not max-w) — see markdownHasTable. A horizontal scroller
      // under content-sized ancestors creates a circular width constraint
      // that explodes Yoga into a screens-tall blank void (observed with
      // real Arabic table replies).
      table: (node: { key: string }, children: React.ReactNode) => (
        <ScrollView key={node.key} horizontal showsHorizontalScrollIndicator={false}>
          <View style={styles.table as object}>{children}</View>
        </ScrollView>
      )
    }),
    [styles, width, onLongPress]
  )

  return (
    <Markdown
      style={styles}
      rules={rules}
      onLinkPress={(url: string) => {
        if (url.startsWith('http://') || url.startsWith('https://')) {
          void WebBrowser.openBrowserAsync(url)
        }
        return false
      }}
    >
      {children}
    </Markdown>
  )
}
