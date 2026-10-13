import { Cancel01Icon, Copy01Icon, Tick02Icon } from '@/components/core/icons'
import { contentIsRtl } from '@/components/chat/MarkdownView'
import { flattenMarkdown } from '@/components/chat/flattenMarkdown'
import { useTokens } from '@/providers/theme/useTheme'
import * as Clipboard from 'expo-clipboard'
import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Modal as RNModal, Platform, Pressable, Text, TextInput, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { create } from 'zustand'

/**
 * Free text selection for one message, tool output or code block.
 *
 * WHY A SHEET, and not selection in the bubble itself: React Native has no
 * granular text selection for <Text> on iOS. The component that provides it,
 * RCTSelectableText, ships only in ReactAndroid; on iOS `selectable` resolves
 * to RCTParagraphComponentView, whose entire contribution is one
 * UILongPressGestureRecognizer wired to a whole-node Copy — which is just the
 * copy button the feed already has. The only iOS view with a real selection
 * cursor is UITextView, and the only UITextView React Native exposes is a
 * multiline TextInput.
 *
 * So the body below is a read-only multiline TextInput: `editable={false}`
 * sets UITextView.editable = NO while selectable stays YES, which is exactly
 * "no keyboard, full cursor" — drag handles, magnifier, and the system menu
 * (Copy / Look Up / Translate / Share) over whatever range the user drags.
 *
 * Android reaches this too, but doesn't need it: `selectable` there is real
 * in-place selection, so the feed long-press stays with the platform (see
 * MarkdownView's IN_PLACE_SELECTION) and this sheet is never opened.
 */

/**
 * ONE sheet for the whole screen, opened by a store rather than rendered per
 * message. Every bubble, tool card and code block can ask for it, and a Modal
 * plus a safe-area subscription inside each of them — in a virtualized feed
 * that mounts and unmounts rows constantly — is a lot of machinery for a
 * control that is open at most once. Call sites use `openSelectText`, which
 * subscribes to nothing, so asking for the sheet never re-renders the feed.
 */
type SelectTextState = {
  text: string | null
  title?: string
  /**
   * Whether `text` is markdown to render, or already-final text to show as-is.
   * A message bubble is markdown — showing its source would put the reader
   * back among the `**` and `|` they opened this to get away from. Tool output
   * and commands are not: they are literal, and "rendering" them would eat
   * characters that are part of the payload.
   */
  markdown: boolean
}

const useSelectTextStore = create<SelectTextState>(() => ({
  text: null,
  title: undefined,
  markdown: false
}))

/** Open on a message bubble's markdown — shown rendered, as in the feed. */
export function openSelectMarkdown(source: string, title?: string): void {
  useSelectTextStore.setState({ text: source, title, markdown: true })
}

/** Open on literal text — tool output, a command, a path. */
export function openSelectText(text: string, title?: string): void {
  useSelectTextStore.setState({ text, title, markdown: false })
}

export function closeSelectText(): void {
  useSelectTextStore.setState({ text: null, title: undefined, markdown: false })
}

/**
 * Whether the platform needs this sheet at all. iOS only — Android's own
 * in-place selection is the better answer there and already works.
 */
export const NEEDS_SELECT_SHEET = Platform.OS === 'ios'

/** Mounted once per screen that shows selectable content. */
export function SelectTextHost(): React.JSX.Element | null {
  const text = useSelectTextStore((state) => state.text)
  const title = useSelectTextStore((state) => state.title)
  const markdown = useSelectTextStore((state) => state.markdown)
  // Nothing below this line exists until the sheet is actually asked for,
  // which also keeps the hooks it needs (safe area, theme) out of the feed's
  // render path entirely.
  if (text === null) return null
  return <SelectTextSheet text={text} title={title} markdown={markdown} onClose={closeSelectText} />
}

export function SelectTextSheet({
  text,
  title,
  markdown,
  onClose
}: {
  text: string
  title?: string
  /** Render `text` as markdown rather than showing it literally. */
  markdown?: boolean
  onClose: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const tokens = useTokens()
  const insets = useSafeAreaInsets()
  const [copied, setCopied] = useState(false)
  // Rendered markdown goes in as styled Text children; literal text goes in as
  // one plain string. `plain` is what those read as either way, which is what
  // Copy-all must put on the clipboard — copying the source out of a sheet
  // showing the rendered form is exactly the mismatch this fixes.
  const { body, plain } = useMemo(() => {
    // Both paths hand the field a single <Text> root — see flattenMarkdown.
    if (!markdown) return { body: <Text>{text}</Text>, plain: text }
    const flat = flattenMarkdown(text, tokens)
    return { body: flat.node, plain: flat.text }
  }, [markdown, text, tokens])
  // Direction from the content, like a message bubble — an Arabic reply must
  // not be laid out under a forced LTR base direction.
  const rtl = useMemo(() => contentIsRtl(plain), [plain])
  const CopyIcon = copied ? Tick02Icon : Copy01Icon

  return (
    <RNModal visible animationType="slide" onRequestClose={onClose}>
      <View className="bg-surface flex-1" style={{ paddingTop: insets.top }}>
        <View className="border-border-soft flex-row items-center gap-2 border-b px-3 pb-2">
          <Text
            numberOfLines={1}
            className="text-fg font-sans-semibold min-w-0 flex-1 text-left text-base"
          >
            {title ?? t('chat.selectText.title')}
          </Text>
          {/* Copy-all still earns its place here: having opened the sheet to
              take part of the text, wanting the whole of it is one tap away
              rather than a drag to both ends. */}
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t('chat.copyMessage')}
            hitSlop={8}
            onPress={() => {
              void Clipboard.setStringAsync(plain).then(() => {
                setCopied(true)
                setTimeout(() => setCopied(false), 1500)
              })
            }}
            className="p-1"
          >
            <CopyIcon size={18} className={copied ? 'text-emerald-600' : 'text-muted'} />
          </Pressable>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t('chat.fileCard.close')}
            hitSlop={8}
            onPress={onClose}
            className="p-1"
          >
            <Cancel01Icon size={18} className="text-muted" />
          </Pressable>
        </View>

        <Text className="text-muted px-4 pb-1 pt-2 text-left font-sans text-xs">
          {t('chat.selectText.hint')}
        </Text>

        {/* Children, not `value`: iOS builds one NSAttributedString out of
            nested Text, which is how the rendered form keeps its weights and
            fonts and still selects as a single run. */}
        <TextInput
          multiline
          editable={false}
          scrollEnabled
          textAlignVertical="top"
          selectionColor={tokens.accent}
          style={{
            writingDirection: rtl ? 'rtl' : 'ltr',
            textAlign: rtl ? 'right' : 'left',
            // Matches MarkdownView's body metrics so the text reads at the
            // same size and rhythm it did in the bubble.
            fontFamily: 'IBMPlexSansArabic-Regular',
            fontSize: 14,
            lineHeight: 21,
            color: tokens.fg,
            paddingBottom: insets.bottom + 24
          }}
          className="flex-1 px-4"
        >
          {body}
        </TextInput>
      </View>
    </RNModal>
  )
}
