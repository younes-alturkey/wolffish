import { Attachment01Icon, Folder01Icon } from '@/components/core/icons'
import { Text, View } from 'react-native'

/**
 * The attached files and working folders a project, procedure or automation
 * carries, as read-only chips on its card.
 *
 * One component for all three screens rather than three copies: they are the
 * same thing on the same kind of card, and the desktop draws them identically
 * too (Projects.tsx, Procedures.tsx, Heartbeat.tsx). Attaching and detaching
 * live in each screen's editor — this is the summary you see without opening
 * anything.
 *
 * A file shows its NAME and a folder shows its full PATH, deliberately. An
 * attached file was copied into Wolffish's own workspace, so its path tells the
 * user nothing they want; a folder is a REFERENCE to a place on the desktop,
 * and "reports" means nothing without knowing which "reports".
 *
 * No background of their own: they sit ON the card and take its surface rather
 * than punching a darker well into it — the same call the desktop chips make.
 *
 * Both chips are a FIXED h-5. Sized by their content they came out different
 * heights: the folder path is mono and the filename is sans, and one font size
 * does not mean one line box across two fonts. The desktop chips are pinned for
 * exactly the same reason.
 */
export function AttachmentChips({
  files,
  directories
}: {
  /** File names, already reduced from whatever the store holds. */
  files: string[]
  /** Absolute desktop folder paths, shown verbatim. */
  directories: string[]
}): React.JSX.Element | null {
  if (files.length === 0 && directories.length === 0) return null
  return (
    // writingDirection lives on the Text nodes below — it is a text style, and
    // a View rejects it. Paths and filenames are LTR in either locale.
    <View className="flex-row flex-wrap items-center gap-1.5">
      {files.map((name) => (
        <View
          key={name}
          className="border-border h-5 max-w-full flex-row items-center gap-1 rounded-md border px-1.5"
        >
          <Attachment01Icon size={10} className="text-muted shrink-0" />
          <Text
            numberOfLines={1}
            style={{ writingDirection: 'ltr' }}
            className="text-muted shrink text-left font-sans text-[10px]"
          >
            {name}
          </Text>
        </View>
      ))}
      {directories.map((dir) => (
        <View
          key={dir}
          className="border-border h-5 max-w-full flex-row items-center gap-1 rounded-md border px-1.5"
        >
          <Folder01Icon size={10} className="text-muted shrink-0" />
          <Text
            numberOfLines={1}
            style={{ writingDirection: 'ltr' }}
            className="text-muted shrink text-left font-mono text-[10px]"
          >
            {dir}
          </Text>
        </View>
      ))}
    </View>
  )
}
