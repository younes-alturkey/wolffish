import { Modal } from '@/components/core/Modal'
import { CancelCircleIcon, File01Icon, Image02Icon } from '@/components/core/icons'
import { classifyFile, formatBytes } from '@/lib/files/fileKinds'
import type { PickedFile } from '@/lib/files/pickAttachments'
import { useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { Platform, Pressable, ScrollView, Text, View } from 'react-native'

/**
 * Choosing files, and seeing what has been chosen.
 *
 * The desktop composer stages attachments as chips above the textarea and
 * uploads nothing until the message is sent; this is the same contract on a
 * phone, with the OS pickers standing in for the file dialog, drag-and-drop and
 * paste. Nothing here transfers a byte — a chip is a local file the user can
 * still change their mind about.
 */

/**
 * The two sources, as a sheet.
 *
 * The sheet closes BEFORE the picker opens, and the picker waits for it to be
 * GONE — two separate things, and both are load-bearing.
 *
 * Closing first is for the answer: a toast raised while a React Native Modal
 * is up never paints on iOS, and what comes back from a pick is exactly what
 * raises toasts (an unsupported type, a file over the cap). Left open, every
 * rejection would be silent.
 *
 * Waiting for the dismissal to FINISH is for the picker itself. On iOS a Modal
 * is a presented view controller, and the system photo picker is another one:
 * asked for mid-dismissal it does launch — and is then torn down with the
 * sheet a few milliseconds later, with no error anywhere. (Seen exactly that
 * way in the device log: PhotosPicker starts, its hosted scene is invalidated,
 * nothing reaches JS.) `onDismiss` is the only honest signal that the slot is
 * free. Android has no such conflict and no such callback, so it runs straight
 * away.
 */
export function AttachSheet({
  open,
  onClose,
  onPickMedia,
  onPickFiles
}: {
  open: boolean
  onClose: () => void
  onPickMedia: () => void
  onPickFiles: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const pending = useRef<(() => void) | null>(null)
  const choose = (run: () => void): void => {
    if (Platform.OS === 'ios') pending.current = run
    onClose()
    if (Platform.OS !== 'ios') run()
  }
  // Also the release valve for a sheet dismissed WITHOUT a choice (backdrop,
  // back gesture): nothing is pending, so nothing runs.
  const afterDismiss = (): void => {
    const run = pending.current
    pending.current = null
    run?.()
  }
  return (
    <Modal open={open} onClose={onClose} onDismiss={afterDismiss} title={t('chat.attach.title')}>
      <View className="flex-col gap-2">
        <AttachOption
          icon={<Image02Icon size={18} className="text-fg" />}
          label={t('chat.attach.media')}
          hint={t('chat.attach.mediaHint')}
          onPress={() => choose(onPickMedia)}
        />
        <AttachOption
          icon={<File01Icon size={18} className="text-fg" />}
          label={t('chat.attach.files')}
          hint={t('chat.attach.filesHint')}
          onPress={() => choose(onPickFiles)}
        />
      </View>
    </Modal>
  )
}

function AttachOption({
  icon,
  label,
  hint,
  onPress
}: {
  icon: React.ReactNode
  label: string
  hint: string
  onPress: () => void
}): React.JSX.Element {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      className="border-border bg-bg flex-row items-center gap-3 rounded-lg border px-3 py-3 active:bg-border-soft"
    >
      {icon}
      <View className="flex-1 flex-col">
        <Text className="text-fg font-sans-medium text-left text-sm">{label}</Text>
        <Text className="text-muted font-sans text-left text-xs">{hint}</Text>
      </View>
    </Pressable>
  )
}

/**
 * The staged files, above the input.
 *
 * A horizontal scroller rather than the desktop's wrapping row: chips are wide
 * relative to a phone, and ten of them wrapped would push the composer halfway
 * up the screen. The chip itself is the desktop's — type badge, name, size,
 * remove — so the same message reads the same on both surfaces.
 */
export function AttachmentTray({
  files,
  onRemove
}: {
  files: PickedFile[]
  onRemove: (id: string) => void
}): React.JSX.Element | null {
  if (files.length === 0) return null
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      className="max-h-16"
      contentContainerStyle={{ gap: 8, paddingHorizontal: 12, paddingTop: 10 }}
      keyboardShouldPersistTaps="handled"
    >
      {files.map((file) => (
        <AttachmentChip key={file.id} file={file} onRemove={() => onRemove(file.id)} />
      ))}
    </ScrollView>
  )
}

function AttachmentChip({
  file,
  onRemove
}: {
  file: PickedFile
  onRemove: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const { kind } = classifyFile(file.name)
  return (
    <View className="border-border bg-surface h-9 max-w-[220px] flex-row items-center gap-2 self-start rounded-lg border px-2.5">
      <View className="bg-primary-soft rounded px-1.5 py-0.5">
        <Text className="text-primary font-sans-medium text-[10px] uppercase">{kind}</Text>
      </View>
      <Text numberOfLines={1} className="text-fg shrink font-sans text-left text-xs">
        {file.name}
      </Text>
      {file.sizeBytes > 0 && (
        <Text className="text-muted shrink-0 font-sans text-[10px]">
          {formatBytes(file.sizeBytes)}
        </Text>
      )}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={t('chat.attach.remove', { name: file.name })}
        hitSlop={8}
        onPress={onRemove}
        className="shrink-0"
      >
        <CancelCircleIcon size={14} className="text-muted" />
      </Pressable>
    </View>
  )
}
