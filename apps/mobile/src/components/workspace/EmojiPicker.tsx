import { Modal } from '@/components/core/Modal'
import { INPUT_TEXT_ALIGN, WRITING_DIRECTION, rtlPlaceholder } from '@/components/core/Input'
import { KeyboardDismissAccessory } from '@/components/core/KeyboardDismissBar'
import { EMOJI_GROUPS } from '@/lib/emoji/emojiData'
import { useTokens } from '@/providers/theme/useTheme'
import { useId, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { FlatList, Pressable, Text, TextInput, View, useWindowDimensions } from 'react-native'

/**
 * The desktop's emoji picker as a dialog — same catalog, same groups, same
 * search-by-name.
 *
 * A dialog rather than the desktop's anchored popover: a 320pt popover hanging
 * off a 36pt button has nowhere to go on a phone, and the trigger it hangs from
 * already lives inside a dialog. Everything else is one-for-one, including the
 * group labels, which come from the same `projects.emojiGroups.*` keys so they
 * localize identically.
 */
const GROUP_LABEL_KEYS: Record<string, string> = {
  'Smileys & Emotion': 'projects.emojiGroups.smileys',
  'People & Body': 'projects.emojiGroups.people',
  'Animals & Nature': 'projects.emojiGroups.nature',
  'Food & Drink': 'projects.emojiGroups.food',
  'Travel & Places': 'projects.emojiGroups.travel',
  Activities: 'projects.emojiGroups.activities',
  Objects: 'projects.emojiGroups.objects',
  Symbols: 'projects.emojiGroups.symbols',
  Flags: 'projects.emojiGroups.flags'
}

export function EmojiPicker({
  open,
  onPick,
  onClose
}: {
  open: boolean
  onPick: (emoji: string) => void
  onClose: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const tokens = useTokens()
  const { height } = useWindowDimensions()
  const [query, setQuery] = useState('')
  // The search field's own iOS keyboard-dismiss chevron.
  const accessoryID = useId()

  const groups = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return EMOJI_GROUPS
    return EMOJI_GROUPS.map((group) => ({
      label: group.label,
      emojis: group.emojis.filter(([, name]) => name.includes(q))
    })).filter((group) => group.emojis.length > 0)
  }, [query])

  const close = (): void => {
    setQuery('')
    onClose()
  }

  return (
    <Modal open={open} onClose={close} title={t('projects.pickIcon')}>
      <View className="bg-bg border-border rounded-lg border px-3">
        <KeyboardDismissAccessory nativeID={accessoryID} />
        <TextInput
          value={query}
          onChangeText={setQuery}
          autoCapitalize="none"
          autoCorrect={false}
          placeholder={rtlPlaceholder(t('projects.emojiSearch'))}
          placeholderTextColor={tokens.muted}
          selectionColor={tokens.accent}
          className={`text-fg h-10 w-full py-0 font-sans text-sm ${INPUT_TEXT_ALIGN}`}
          style={WRITING_DIRECTION}
          accessibilityLabel={t('projects.emojiSearch')}
          inputAccessoryViewID={accessoryID}
        />
      </View>
      {groups.length === 0 ? (
        <Text className="text-muted py-6 text-center font-sans text-xs">
          {t('projects.emojiNoResults')}
        </Text>
      ) : (
        // A FlatList over the GROUPS, not a plain scroller: the catalog is 1,588
        // glyphs and mounting them all is ~1,600 views in one commit, which
        // stalls the dialog's open on a mid-range phone. Nine group rows
        // virtualize cleanly, and only the first couple mount up front.
        <FlatList
          data={groups}
          keyExtractor={(group) => group.label}
          // Viewport-relative: the catalog always scrolls, and the dialog still
          // fits the shortest phone.
          style={{ maxHeight: Math.round(height * 0.5) }}
          contentContainerStyle={{ gap: 12 }}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
          initialNumToRender={2}
          windowSize={3}
          removeClippedSubviews
          renderItem={({ item: group }) => (
            <View className="flex-col gap-1.5">
              <Text className="text-muted font-sans-medium text-left text-[11px] uppercase">
                {GROUP_LABEL_KEYS[group.label] ? t(GROUP_LABEL_KEYS[group.label]) : group.label}
              </Text>
              {/* A plain wrapping row, not a grid: emoji glyph widths differ
                  across the catalog and a fixed column count clips the wide
                  ones. Each cell is square and the row wraps. */}
              <View className="flex-row flex-wrap">
                {group.emojis.map(([emoji, name]) => (
                  <Pressable
                    key={`${group.label}-${emoji}`}
                    accessibilityRole="button"
                    accessibilityLabel={name}
                    onPress={() => {
                      onPick(emoji)
                      setQuery('')
                    }}
                    className="h-10 w-10 items-center justify-center rounded-md active:bg-border-soft"
                  >
                    <Text className="text-xl leading-7">{emoji}</Text>
                  </Pressable>
                ))}
              </View>
            </View>
          )}
        />
      )}
    </Modal>
  )
}
