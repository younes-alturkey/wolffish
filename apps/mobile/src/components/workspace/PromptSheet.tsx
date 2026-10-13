import { Button } from '@/components/core/Button'
import { INPUT_TEXT_ALIGN, WRITING_DIRECTION, rtlPlaceholder } from '@/components/core/Input'
import { KeyboardDismissAccessory } from '@/components/core/KeyboardDismissBar'
import { cn } from '@/lib/utils/cn'
import { useTokens } from '@/providers/theme/useTheme'
import { useId, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  KeyboardAvoidingView,
  Modal as RNModal,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  View
} from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'

/**
 * The expanded editor for a long piece of prompt text — a project's
 * instructions, a procedure's prompt, an automation's prompt.
 *
 * The same surface the composer's expand button opens (chat/PromptEditorModal):
 * full screen, the app's own sans face, platform typo correction. The desktop
 * puts CodeMirror in these three fields, which is the right promise on a
 * keyboard — a gutter and monospace say "syntax goes here" — but on a phone
 * these are prose fields typed with thumbs, and this app already decided what
 * that surface is. What IS shared with the desktop is where the text is read
 * rather than written: the card previews render it as a monospaced code block,
 * exactly as the desktop's cards do (see PromptPreview).
 *
 * Done is the only exit — there is nothing to send here. The value comes back
 * on it and on the platform's back gesture, so a draft is never lost to a
 * swipe; callers autosave from that value on the debounce they already run.
 */
const LINE_HEIGHT = 22
const FONT_SIZE = 15

export function PromptSheet({
  open,
  title,
  initialValue,
  placeholder,
  onDone
}: {
  open: boolean
  /** Names the field being edited — "Instructions", "Prompt". */
  title: string
  initialValue: string
  placeholder?: string
  onDone: (value: string) => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const tokens = useTokens()
  const insets = useSafeAreaInsets()
  // Parking the keyboard to read is not Done — same chevron as everywhere.
  const accessoryID = useId()
  const [value, setValue] = useState(initialValue)

  // Re-seed each time the sheet opens on a different draft — same contract as
  // PromptEditorModal, which is why it is written the same way.
  const [openedWith, setOpenedWith] = useState(initialValue)
  if (open && openedWith !== initialValue) {
    setOpenedWith(initialValue)
    setValue(initialValue)
  }

  return (
    <RNModal visible={open} animationType="slide" onRequestClose={() => onDone(value)}>
      <View className="bg-bg flex-1" style={{ paddingTop: insets.top }}>
        {/* BEFORE the field in tree order: the field autoFocuses on mount,
            and an accessory that registers after that focus is never looked
            up again — the keyboard would rise bare. */}
        <KeyboardDismissAccessory nativeID={accessoryID} />
        <View className="border-border-soft flex-row items-center gap-2 border-b px-3 pb-2">
          <Text numberOfLines={1} className="text-fg font-sans-semibold flex-1 text-left text-base">
            {title}
          </Text>
          <Button size="sm" accessibilityLabel={t('common.done')} onPress={() => onDone(value)}>
            {t('common.done')}
          </Button>
        </View>

        {/* 'padding' on BOTH platforms: edge-to-edge Android never resizes for
            the keyboard — not even a Modal's window — so without this the
            field keeps its full height and the cursor types under the IME. */}
        <KeyboardAvoidingView behavior="padding" className="flex-1">
          <ScrollView
            className="flex-1"
            contentContainerStyle={{ flexGrow: 1, paddingBottom: insets.bottom + 16 }}
            keyboardShouldPersistTaps="handled"
          >
            <TextInput
              multiline
              autoFocus
              value={value}
              onChangeText={setValue}
              autoCorrect
              spellCheck
              autoCapitalize="sentences"
              placeholder={rtlPlaceholder(placeholder)}
              placeholderTextColor={tokens.muted}
              selectionColor={tokens.accent}
              textAlignVertical="top"
              className={cn('text-fg flex-1 px-4 py-3 font-sans', INPUT_TEXT_ALIGN)}
              style={[{ fontSize: FONT_SIZE, lineHeight: LINE_HEIGHT }, WRITING_DIRECTION]}
              accessibilityLabel={title}
              inputAccessoryViewID={accessoryID}
            />
          </ScrollView>
        </KeyboardAvoidingView>
      </View>
    </RNModal>
  )
}

/**
 * A failure raised from INSIDE a dialog, said inline.
 *
 * Not a toast: the app's toast viewport is a plain View in the root layout tree
 * and a React Native Modal renders in its own native window above it, so a toast
 * raised from inside one is never seen on iOS — no z-index reaches across
 * windows. Every dialog in this app therefore reports its own failures next to
 * the controls that caused them, the way PairSheet does.
 */
export function DialogError({ message }: { message: string | null }): React.JSX.Element | null {
  if (!message) return null
  return (
    <Text className="text-left font-sans text-xs leading-relaxed text-rose-500">{message}</Text>
  )
}

/**
 * A prompt as the cards show it: the desktop's `<pre>` block — recessed mono
 * panel, capped height, scrolls in place rather than truncating — which is also
 * the treatment tool output and the chat menu's project instructions already
 * use in this app.
 *
 * `onPress` makes the block itself the way into the editor, so the preview and
 * the edit affordance are one target instead of the block plus a pencil.
 * Alignment is left to RN's `auto` (the desktop's `dir="auto"`): an Arabic
 * prompt reads flush-right even while the app is in English.
 */
export function PromptPreview({
  value,
  empty,
  maxHeight = 160,
  onPress,
  onSurface = false
}: {
  value: string
  /** Shown in place of the block when there is nothing written yet. */
  empty: string
  maxHeight?: number
  onPress?: () => void
  /**
   * Fill with the CARD colour instead of the recessed one.
   *
   * The default is right everywhere this block sits INSIDE a card or a dialog:
   * `bg-bg` is what makes it read as recessed against `bg-surface`, which is the
   * same trick every code block in the app uses. The chat hero is the one place
   * it stands on the bare background with no card around it, and there the
   * recess has nothing to recede from — it just reads as a darker hole. Taking
   * the card colour there makes it read as the card the hero has instead.
   */
  onSurface?: boolean
}): React.JSX.Element {
  if (!value.trim()) {
    return <Text className="text-muted text-left font-sans text-xs italic">{empty}</Text>
  }
  const block = (
    <ScrollView
      style={{ maxHeight }}
      nestedScrollEnabled
      className={cn('border-border rounded-lg border', onSurface ? 'bg-surface' : 'bg-bg')}
      showsVerticalScrollIndicator={false}
    >
      <Text selectable={!onPress} className="text-muted p-3 font-mono text-[11px] leading-4">
        {value}
      </Text>
    </ScrollView>
  )
  if (!onPress) return block
  // The ScrollView keeps its own scroll gesture; a tap that is not a drag falls
  // through to this Pressable, so a long prompt can be both read and opened.
  return (
    <Pressable accessibilityRole="button" onPress={onPress}>
      {block}
    </Pressable>
  )
}
