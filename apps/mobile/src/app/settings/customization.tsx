import { Edit02Icon, File01Icon } from '@/components/core/icons'
import { MarkdownDocEditor } from '@/components/settings/MarkdownDocEditor'
import { CodeChip, PanelScreen, Section } from '@/components/settings/SettingsUI'
import { useFreshConfig } from '@/lib/sync/useFreshConfig'
import { useToast } from '@/providers/toast/useToast'
import {
  CUSTOMIZATION_DOCS,
  saveCustomizationDoc,
  useCustomizationDoc,
  useCustomizationOversized,
  useSettingsReadOnly,
  type CustomizationDoc
} from '@/state/demoConfig'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Pressable, ScrollView, Text, View } from 'react-native'

/**
 * Customization — the desktop's three separate sidebar destinations (Soul,
 * User, Agents) as one screen.
 *
 * Three pages is the right shape on a desktop, where the sidebar is always
 * there and a page is one click away. On a phone it would be three taps into
 * three near-identical screens, so they collapse into one: each document gets a
 * card with its name, what it is FOR, and the document itself in a scrolling
 * code block — the three questions "which file is this, why would I touch it,
 * what does it currently say" answered without opening anything. Tapping a card
 * opens the same expanded editor the composer uses for a long prompt.
 *
 * The documents ride the ordinary config sync: they arrive in the snapshot the
 * every other settings screen renders, they save through the same
 * Rpc.configSet write, and the desktop's change broadcast brings an edit made
 * over there back here in the push's own latency. Nothing on this screen is a
 * second sync path.
 */

/** The desktop paths, purely to print — the writing side owns the real map. */
const DOC_PATHS: Record<CustomizationDoc, string> = {
  soul: 'brain/identity/soul.md',
  user: 'brain/identity/user.md',
  agents: 'brain/prefrontal/agents.md'
}

export default function CustomizationScreen(): React.JSX.Element {
  const { t } = useTranslation()
  // These documents live on the desktop and are edited there too — pull the
  // current text every time this screen comes into focus, like every other
  // screen rendering desktop-owned values.
  useFreshConfig()
  const [editing, setEditing] = useState<CustomizationDoc | null>(null)

  return (
    <>
      <PanelScreen
        title={t('settings.tabs.customization')}
        subtitle={t('settings.customization.subtitle')}
      >
        {CUSTOMIZATION_DOCS.map((doc) => (
          <DocCard key={doc} doc={doc} onEdit={() => setEditing(doc)} />
        ))}
      </PanelScreen>
      {/* Keyed by document and mounted only while open, so every open starts
          from the text as it stands now and no draft outlives its editor. */}
      {editing ? <DocEditor key={editing} doc={editing} onClose={() => setEditing(null)} /> : null}
    </>
  )
}

/**
 * One document. Its own component so the store's single-field subscription
 * contract holds: a desktop edit to soul.md re-renders the Soul card, not the
 * three of them.
 */
function DocCard({
  doc,
  onEdit
}: {
  doc: CustomizationDoc
  onEdit: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const text = useCustomizationDoc(doc)
  const oversized = useCustomizationOversized(doc)
  const title = t(`settings.customization.docs.${doc}.title`)

  return (
    <Section className="gap-3">
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={t('settings.customization.edit', { name: title })}
        disabled={oversized}
        onPress={onEdit}
        className="flex-row items-center gap-3"
      >
        {/* One icon for all three: they are the same kind of thing — a markdown
            document that shapes the agent — and three different marks would
            imply three different mechanisms. */}
        <File01Icon size={18} className="text-muted" />
        <View className="flex-1 flex-col gap-0.5">
          <Text className="text-fg font-sans-medium text-left text-sm">{title}</Text>
          <CodeChip value={DOC_PATHS[doc]} mono className="self-start" />
        </View>
        {/* The pencil the Projects cards use for the same act, at the same
            size — opening one of these is editing a document, not expanding a
            panel, and two marks for one gesture is two gestures to learn. */}
        {oversized ? null : <Edit02Icon size={15} className="text-muted" />}
      </Pressable>

      <Text className="text-muted text-left font-sans text-xs leading-5">
        {t(`settings.customization.docs.${doc}.description`)}
      </Text>

      {oversized ? (
        <View className="bg-bg border-border rounded-lg border p-3">
          <Text className="text-muted text-left font-sans text-xs leading-5">
            {t('settings.customization.oversized')}
          </Text>
        </View>
      ) : (
        /* The document itself, scrolling in place rather than stretching the
           screen — the desktop's max-h block, in the app's code-block tones.
           The Pressable is INSIDE the scroller on purpose: a tap that never
           moves opens the editor, and the first pixel of drag hands the touch
           to the scroll view, so the block reads and opens with one finger. */
        <ScrollView className="bg-bg border-border max-h-56 rounded-lg border" nestedScrollEnabled>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t('settings.customization.edit', { name: title })}
            onPress={onEdit}
          >
            {/* Direction left to RN's `auto`, matching every other code block
                in the app: an English document reads flush-left even while the
                screen around it is RTL. */}
            <Text className="text-fg p-3 font-mono text-[11px] leading-4">
              {text || t('settings.customization.empty')}
            </Text>
          </Pressable>
        </ScrollView>
      )}
    </Section>
  )
}

/**
 * The editor over one document, with the save round trip.
 *
 * Saving goes through saveCustomizationDoc — the same awaited write the
 * credential fields use, because a document deserves an answer rather than the
 * fire-and-forget a switch can live with. The modal closes on success only: a
 * refused write leaves the text on screen with the reason above it, so the
 * edit is still there to retry or copy out rather than silently lost to a
 * revert. The success toast is raised after the close, because a toast raised
 * from inside a React Native Modal never paints on iOS.
 */
function DocEditor({
  doc,
  onClose
}: {
  doc: CustomizationDoc
  onClose: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const toast = useToast()
  const text = useCustomizationDoc(doc)
  const readOnly = useSettingsReadOnly()
  // The text this editor opened on. Read once: the store keeps moving (a
  // desktop edit, a snapshot refresh) and re-seeding a field being typed into
  // is exactly the clobber the desktop editor's dirty rule exists to prevent.
  const [initialValue] = useState(text)

  return (
    <MarkdownDocEditor
      title={t(`settings.customization.docs.${doc}.title`)}
      fileName={DOC_PATHS[doc]}
      initialValue={initialValue}
      readOnly={readOnly}
      onSave={async (value) => {
        const result = await saveCustomizationDoc(doc, value)
        if (result === 'too-large') return t('settings.customization.tooLarge')
        if (result === 'failed') return t('settings.customization.saveError')
        onClose()
        toast.show({ tone: 'success', message: t('settings.customization.saved') })
        return null
      }}
      onClose={onClose}
    />
  )
}
