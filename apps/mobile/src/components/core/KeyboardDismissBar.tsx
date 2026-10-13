import { KeyboardHideIcon } from '@/components/core/icons'
import { useTranslation } from 'react-i18next'
import { InputAccessoryView, Keyboard, Platform, Pressable, StyleSheet, View } from 'react-native'

/**
 * The iPhone's missing keyboard-dismiss control. Android docks a chevron in
 * its navigation bar and the iPad keyboard carries its own dismiss key; the
 * iPhone keyboard ships with no way out at all — the app is expected to
 * provide one. The feed's swipe-down gesture is that answer for anyone who
 * knows it; this is the visible one: a chevron docked just above the
 * keyboard, riding it as it comes and goes (and down with the interactive
 * drag, since the accessory belongs to the keyboard's own window).
 *
 * One rule makes it app-wide: EVERY field renders its own accessory, keyed
 * by a per-instance nativeID (React's useId) — the field names the id, and
 * a KeyboardDismissAccessory sibling right next to it registers the bar.
 * The core Input and Textarea wrappers pair one automatically, so most
 * screens never think about it; raw TextInputs (the composer, the prompt
 * editors, the pickers' search rows) pair their own.
 *
 * Per field rather than one shared bar because iOS resolves the id against
 * views mounted NEAR the field: a single bar in the root layout never
 * attaches to fields on pushed screens, and one inside another window never
 * attaches across (both verified on device). Mounted adjacent, the bar
 * shows everywhere the field does — RN Modal dialogs and full-screen
 * editors included.
 *
 * Mount it BEFORE its field in tree order. A field that autoFocuses grabs
 * the keyboard during its own mount, and an accessory that registers after
 * that moment is never looked up again — the keyboard rises bare (the
 * prompt editors hit exactly this). Earlier siblings mount first, so
 * accessory-then-field is always safe; the anchor is invisible either way.
 *
 * iOS only, twice over: Android needs nothing, and InputAccessoryView
 * exists nowhere else anyway.
 */

export function KeyboardDismissAccessory({
  nativeID
}: {
  /** The id the paired field names as its inputAccessoryViewID — unique per
   *  field instance (useId), so many fields on one screen never collide. */
  nativeID: string
}): React.JSX.Element | null {
  const { t } = useTranslation()
  if (Platform.OS !== 'ios') return null
  return (
    // Zero-size absolute anchor: absolutely-positioned children take no flex
    // slot and earn no `gap`, so this drops into any column or row without
    // moving a thing. The accessory content itself is reparented into the
    // keyboard's window natively and sizes to the viewport, not to this box.
    <View style={styles.anchor}>
      <InputAccessoryView nativeID={nativeID}>
        {/* Trailing edge, where the thumb already lives — justify-end so RTL
            mirrors it. The disc is the composer card's own surface-and-border
            language; border-border rather than border-soft, which reads black
            on a floating disc in dark mode. */}
        <View className="flex-row justify-end px-3 py-1.5">
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t('chat.hideKeyboard')}
            hitSlop={8}
            onPress={() => Keyboard.dismiss()}
            className="bg-surface border-border h-8 w-8 items-center justify-center rounded-full border active:opacity-60"
          >
            <KeyboardHideIcon size={18} className="text-muted" />
          </Pressable>
        </View>
      </InputAccessoryView>
    </View>
  )
}

const styles = StyleSheet.create({
  anchor: { position: 'absolute', width: 0, height: 0 }
})
