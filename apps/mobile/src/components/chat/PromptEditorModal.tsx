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
  ScrollView,
  Text,
  TextInput,
  View
} from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'

/**
 * Expanded prompt editor — the mobile take on the desktop's draft-expand modal:
 * the same draft the composer holds, with room to write it.
 *
 * Deliberately NOT a code editor, which is where this parts from the desktop
 * (CodeMirror in markdown mode, gutter and all). On a phone that is the wrong
 * promise: a monospaced field behind a line-number rail says "syntax goes
 * here", and what is being written is a message. So the app's own sans face,
 * the platform's typo correction, and a placeholder that names the one thing
 * this field is for — messaging Wolffish, idle or while it works.
 *
 * It sends, too. The whole reason to open this is a prompt too long for the
 * composer's one row, and routing that prompt back through the composer to be
 * sent — Done, then aim for a 42.5pt button — is a step with nothing in it.
 * Send hands the draft over and the composer closes this in the same action.
 * Done stays for the other case: a draft that is not finished.
 */

const LINE_HEIGHT = 22
const FONT_SIZE = 15

export function PromptEditorModal({
  open,
  initialValue,
  streaming,
  onSend,
  onDone
}: {
  open: boolean
  initialValue: string
  /** Mid-turn the message goes into the running turn — the placeholder says
   *  so, exactly as the composer's does; Send stays Send. */
  streaming: boolean
  /** Hand the draft over now, as a message. The composer clears and closes. */
  onSend: (value: string) => void
  /** The other exit — Done (and the platform back gesture) commit the draft
   *  without sending it. */
  onDone: (value: string) => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const tokens = useTokens()
  const insets = useSafeAreaInsets()
  // Parking the keyboard to read a long draft is not exiting — Done commits
  // and closes; the chevron only puts the keys away.
  const accessoryID = useId()
  const [value, setValue] = useState(initialValue)

  // Reset local state each time the editor opens with a fresh draft.
  const [openedWith, setOpenedWith] = useState(initialValue)
  if (open && openedWith !== initialValue) {
    setOpenedWith(initialValue)
    setValue(initialValue)
  }

  // Attachments are the composer's, not this modal's, so an empty editor has
  // nothing of its own to send — unlike the composer, where a staged file is
  // a message on its own.
  const canSend = value.trim().length > 0
  const sendLabel = t('chat.send')

  return (
    <RNModal visible={open} animationType="slide" onRequestClose={() => onDone(value)}>
      <View className="bg-bg flex-1" style={{ paddingTop: insets.top }}>
        {/* BEFORE the field in tree order: the field autoFocuses on mount,
            and an accessory that registers after that focus is never looked
            up again — the keyboard would rise bare. */}
        <KeyboardDismissAccessory nativeID={accessoryID} />
        <View className="border-border-soft flex-row items-center gap-2 border-b px-3 pb-2">
          <Text numberOfLines={1} className="text-fg font-sans-semibold flex-1 text-left text-base">
            {t('chat.editor.title')}
          </Text>
          <Button
            size="sm"
            variant="outline"
            accessibilityLabel={t('chat.editor.done')}
            onPress={() => onDone(value)}
          >
            {t('chat.editor.done')}
          </Button>
          <Button
            size="sm"
            disabled={!canSend}
            accessibilityLabel={sendLabel}
            onPress={() => onSend(value)}
          >
            {sendLabel}
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
              placeholder={rtlPlaceholder(
                streaming ? t('chat.interject.editorPlaceholder') : t('chat.editor.placeholder')
              )}
              placeholderTextColor={tokens.muted}
              selectionColor={tokens.accent}
              textAlignVertical="top"
              className={cn('text-fg flex-1 px-4 py-3 font-sans', INPUT_TEXT_ALIGN)}
              style={[{ fontSize: FONT_SIZE, lineHeight: LINE_HEIGHT }, WRITING_DIRECTION]}
              accessibilityLabel={t('chat.editor.title')}
              inputAccessoryViewID={accessoryID}
            />
          </ScrollView>
        </KeyboardAvoidingView>
      </View>
    </RNModal>
  )
}
