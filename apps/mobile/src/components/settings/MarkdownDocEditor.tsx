import { Button } from '@/components/core/Button'
import { INPUT_TEXT_ALIGN, WRITING_DIRECTION, rtlPlaceholder } from '@/components/core/Input'
import { KeyboardDismissAccessory } from '@/components/core/KeyboardDismissBar'
import { cn } from '@/lib/utils/cn'
import { useTokens } from '@/providers/theme/useTheme'
import { CUSTOMIZATION_MAX_BYTES, utf8Bytes } from '@/state/demoConfig'
import { useEffect, useId, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  KeyboardAvoidingView,
  Modal as RNModal,
  ScrollView,
  Text,
  TextInput,
  View
} from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'

/**
 * The expanded editor for one customization document — the chat composer's
 * PromptEditorModal, pointed at a file instead of a draft: same full-screen
 * modal, same header-with-two-buttons, same keyboard handling.
 *
 * What differs is what is being written. This is markdown the agent reads as
 * instructions, so it wears the code-block face the card preview wears — mono,
 * 12/18 — and it turns OFF the conveniences a message field wants: autocorrect
 * would quietly rewrite `brain/prefrontal/agents.md`, and autocapitalize would
 * fight every `- ` bullet and every `#` heading. Spellcheck stays, matching the
 * desktop's CodeMirror, because the prose inside these documents is still prose.
 *
 * State is mounted-fresh per open (the parent keys this by document), so a
 * document that changes on the desktop while this is open never overwrites what
 * is being typed here — the same dirty rule the desktop editor follows.
 *
 * Mount it only while editing: an unmounted modal cannot hold a stale draft,
 * and RN keeps no state for it either way.
 */

const FONT_SIZE = 12
const LINE_HEIGHT = 18

export function MarkdownDocEditor({
  title,
  fileName,
  initialValue,
  /** Reading is always allowed; saving needs the desktop that owns the file. */
  readOnly,
  /**
   * Write it. Resolves null when the document landed — the caller closes this
   * editor itself in that case — or a message to show when it did not.
   *
   * The failure message is rendered INLINE rather than raised as a toast: a
   * toast raised from inside a React Native Modal never paints on iOS, and a
   * refused save is exactly the message that has to survive the modal staying
   * open (same reason PairSheet reports its errors inline).
   */
  onSave,
  onClose
}: {
  title: string
  fileName: string
  initialValue: string
  readOnly: boolean
  onSave: (value: string) => Promise<string | null>
  onClose: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const tokens = useTokens()
  const insets = useSafeAreaInsets()
  // Parking the keyboard to read the document is not Close — the chevron
  // only puts the keys away.
  const accessoryID = useId()
  const [value, setValue] = useState(initialValue)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const dirty = value !== initialValue
  // Checked as you type, not only on Save: the ceiling is the desktop's, and
  // finding out about it after writing 300 KB is finding out too late.
  const oversized = utf8Bytes(value) > CUSTOMIZATION_MAX_BYTES

  // A save that lands closes this editor from the outside, which means the
  // round trip can outlive the component. Everything after the await is
  // guarded: settling state onto an unmounted editor is at best noise and at
  // worst a warning chasing the next screen.
  const mounted = useRef(true)
  useEffect(
    () => () => {
      mounted.current = false
    },
    []
  )

  const save = async (): Promise<void> => {
    if (saving) return
    setSaving(true)
    setError(null)
    let message: string | null
    try {
      message = await onSave(value)
    } catch {
      message = t('settings.customization.saveError')
    }
    if (!mounted.current) return
    setSaving(false)
    setError(message)
  }

  return (
    <RNModal visible animationType="slide" onRequestClose={onClose}>
      {/* The card colour, not the page's. A full-screen editor over `bg-bg`
          leaves the writing area reading as bare background — the document
          loses the surface it had on the card behind, and a transparent field
          on the page ground is the one thing that does not look editable.
          Taking `bg-surface` for the whole sheet keeps the document on the
          same paper it was just being read on, header and field included. */}
      <View className="bg-surface flex-1" style={{ paddingTop: insets.top }}>
        {/* BEFORE the field in tree order: the field autoFocuses on mount,
            and an accessory that registers after that focus is never looked
            up again — the keyboard would rise bare. */}
        <KeyboardDismissAccessory nativeID={accessoryID} />
        <View className="border-border-soft flex-row items-center gap-2 border-b px-3 pb-2">
          <View className="flex-1 flex-col">
            <Text numberOfLines={1} className="text-fg font-sans-semibold text-left text-base">
              {title}
            </Text>
            {/* The path is what makes this the same file the desktop edits —
                worth one muted line, since nothing else on screen says so. */}
            <Text
              selectable
              numberOfLines={1}
              style={{ writingDirection: 'ltr' }}
              className="text-muted text-left font-mono text-[11px]"
            >
              {fileName}
            </Text>
          </View>
          <Button
            size="sm"
            variant="outline"
            accessibilityLabel={t('common.close')}
            onPress={onClose}
          >
            {readOnly ? t('common.close') : t('common.cancel')}
          </Button>
          {/* The label never swaps while saving — the disabled dim carries
              the busy state, and the button keeps its size and its word. */}
          {readOnly ? null : (
            <Button
              size="sm"
              disabled={!dirty || oversized || saving}
              accessibilityLabel={t('settings.customization.save')}
              onPress={() => void save()}
            >
              {t('settings.customization.save')}
            </Button>
          )}
        </View>

        {/* One line, only when there is something to say, most urgent first: a
            refused save, then a size that will be refused, then the reason
            saving is off entirely. Never stacked — each one supersedes the
            reading below it. */}
        {error ? (
          <Text className="border-border-soft border-b px-4 py-2 text-left font-sans text-xs text-rose-500">
            {error}
          </Text>
        ) : oversized && !readOnly ? (
          <Text className="border-border-soft border-b px-4 py-2 text-left font-sans text-xs text-amber-600 dark:text-amber-400">
            {t('settings.customization.tooLarge')}
          </Text>
        ) : readOnly ? (
          <Text className="text-muted border-border-soft border-b px-4 py-2 text-left font-sans text-xs">
            {t('settings.customization.readOnly')}
          </Text>
        ) : null}

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
              autoFocus={!readOnly}
              editable={!readOnly}
              value={value}
              onChangeText={(next) => {
                setValue(next)
                // A refusal describes the text that was sent; the next
                // keystroke makes it a claim about text that no longer exists.
                if (error) setError(null)
              }}
              autoCorrect={false}
              autoCapitalize="none"
              spellCheck
              placeholder={rtlPlaceholder(t('settings.customization.placeholder'))}
              placeholderTextColor={tokens.muted}
              selectionColor={tokens.accent}
              textAlignVertical="top"
              // Filled rather than left transparent, so the field owns its
              // area even if what sits behind it ever changes colour.
              className={cn('text-fg bg-surface flex-1 px-4 py-3 font-mono', INPUT_TEXT_ALIGN)}
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
