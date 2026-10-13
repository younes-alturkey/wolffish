import { AttachSheet } from '@/components/chat/AttachmentPicker'
import { Button } from '@/components/core/Button'
import { Input } from '@/components/core/Input'
import { Modal } from '@/components/core/Modal'
import { Delete02Icon, PlusSignIcon } from '@/components/core/icons'
import { EmojiPicker } from '@/components/workspace/EmojiPicker'
import { DialogError, PromptPreview, PromptSheet } from '@/components/workspace/PromptSheet'
import { pickDocuments, pickMedia, type PickedFile } from '@/lib/files/pickAttachments'
import { MAX_FILES_PER_MESSAGE, uploadErrorMessage, validateUpload } from '@/lib/files/uploadPolicy'
import { updateProject, uploadProjectFile } from '@/lib/sync/projects'
import type { SyncProject, SyncProjectFile } from '@/lib/tunnel/protocol'
import { cn } from '@/lib/utils/cn'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Pressable, ScrollView, Text, View, useWindowDimensions } from 'react-native'

/** Emoji every project falls back to — the desktop's own default. */
export const DEFAULT_PROJECT_ICON = '📁'

/**
 * Middle truncation that keeps the extension visible: the base name gets the
 * ellipsis while ".pdf" stays pinned — "quarterly-report-fin….pdf".
 */
function splitFileName(name: string): { base: string; ext: string } {
  const dot = name.lastIndexOf('.')
  if (dot <= 0 || dot === name.length - 1) return { base: name, ext: '' }
  return { base: name.slice(0, dot), ext: name.slice(dot) }
}

/**
 * Edit dialog for one project — title, emoji, instructions and the referenced
 * files. The desktop's ProjectDialog, one-for-one, including the two contracts
 * that make it feel the same:
 *
 * - Instructions AUTOSAVE on a 600 ms debounce and the title is required, so
 *   nothing is written until one is typed and a never-named fresh stub is
 *   discarded by the caller on close.
 * - Files persist IMMEDIATELY per add/remove — they are not text being drafted.
 *
 * What differs is only where the bytes come from. The desktop copies from a
 * path on its own disk and shows a copy-progress bar; the phone uploads over
 * the relay and shows the same bar against the same denominator (the whole
 * batch, so it only moves forward), because the transfer is the slow part on
 * both and a file that simply appears with no warning is the thing the bar was
 * added to fix.
 */
export type ProjectDialogProps = {
  project: SyncProject | null
  onClose: () => void
  /** Every persisted change flows back so callers keep list/active state fresh. */
  onChanged: (project: SyncProject) => void
  /** Chat project-mode extra: start a fresh conversation in this project. */
  onNewConversation?: (project: SyncProject) => void
  /** Chat project-mode extra: leave the project. */
  onExitProject?: () => void
  /**
   * Chat project-mode extra: the chat controls (model, mode, thinking, context).
   *
   * In project mode this dialog stands where the composer's menu button was, so
   * the controls that button opened live here — behind a two-segment switch
   * beside the title rather than a third footer button, because they are a VIEW
   * of this dialog, not an action it performs. Absent (the Projects screen) ⇒ no
   * switch and no second view: there is no chat there to control.
   */
  controls?: React.ReactNode
  /**
   * A turn is running in this project's conversation — the controls that would
   * shift the base under it lock (instructions, file add/remove, exit), exactly
   * as they do on the desktop.
   */
  busy?: boolean
  /** No desktop to write to: everything is read-only and says so. */
  readOnly?: boolean
}

export function ProjectDialog(props: ProjectDialogProps): React.JSX.Element | null {
  if (!props.project) return null
  // Keyed remount per project: drafts seed from props in useState initializers,
  // so switching projects can never leak one project's drafts into another's.
  return <ProjectDialogBody key={props.project.id} {...props} project={props.project} />
}

/** One tick of the add-files batch — the desktop's AttachFilesProgress. */
type CopyProgress = { index: number; total: number; name: string; sent: number; totalBytes: number }

function ProjectDialogBody({
  project,
  onClose,
  onChanged,
  onNewConversation,
  onExitProject,
  controls,
  busy = false,
  readOnly = false
}: ProjectDialogProps & { project: SyncProject }): React.JSX.Element {
  const { t } = useTranslation()
  const { height } = useWindowDimensions()
  // Reported inline rather than as a toast — see DialogError.
  const [error, setError] = useState<string | null>(null)
  // Which half of the dialog is showing. Always the project on open: this is the
  // project button, and the controls are the other thing it can also reach.
  const [view, setView] = useState<'project' | 'controls'>('project')

  const [draftTitle, setDraftTitle] = useState(project.title)
  const [draftIcon, setDraftIcon] = useState(project.icon)
  const [draftInstructions, setDraftInstructions] = useState(project.instructions)
  const [files, setFiles] = useState<SyncProjectFile[]>(project.files)
  const [directories, setDirectories] = useState<string[]>(project.directories)
  const [folderDraft, setFolderDraft] = useState('')
  const [addingFolder, setAddingFolder] = useState(false)
  const [emojiOpen, setEmojiOpen] = useState(false)
  const [promptOpen, setPromptOpen] = useState(false)
  const [attachOpen, setAttachOpen] = useState(false)
  // The required-title error stays hidden until the user edits SOMETHING — a
  // fresh project opens untitled, and scolding before any input is noise.
  const [touched, setTouched] = useState(false)
  const titleInvalid = touched && draftTitle.trim() === ''

  // Last values dispatched to the desktop — the autosave baseline. Comparing
  // against it (updated synchronously at dispatch) stops an idle dialog from
  // re-saving in a loop and stops close from re-writing what the debounce sent.
  const savedRef = useRef({
    title: project.title,
    icon: project.icon,
    instructions: project.instructions
  })

  const persist = useCallback(
    async (title: string, icon: string, instructions: string): Promise<void> => {
      savedRef.current = { title, icon, instructions }
      try {
        onChanged(await updateProject({ id: project.id, title, icon, instructions }))
      } catch {
        setError(t('projects.saveError'))
      }
    },
    [project.id, onChanged, t]
  )

  useEffect(() => {
    if (readOnly) return
    if (draftTitle.trim() === '') return
    const saved = savedRef.current
    if (
      draftTitle === saved.title &&
      draftIcon === saved.icon &&
      draftInstructions === saved.instructions
    ) {
      return
    }
    const handle = setTimeout(() => void persist(draftTitle, draftIcon, draftInstructions), 600)
    return () => clearTimeout(handle)
  }, [readOnly, draftTitle, draftIcon, draftInstructions, persist])

  const close = useCallback((): void => {
    // Flush whatever the debounce has not dispatched yet.
    if (!readOnly && draftTitle.trim() !== '') {
      const saved = savedRef.current
      if (
        draftTitle !== saved.title ||
        draftIcon !== saved.icon ||
        draftInstructions !== saved.instructions
      ) {
        void persist(draftTitle, draftIcon, draftInstructions)
      }
    }
    onClose()
  }, [readOnly, draftTitle, draftIcon, draftInstructions, persist, onClose])

  const persistFiles = useCallback(
    (next: SyncProjectFile[]): void => {
      setTouched(true)
      setError(null)
      setFiles(next)
      void updateProject({ id: project.id, files: next })
        .then((updated) => {
          // The desktop's own list wins: it deleted the copies it owns and its
          // answer is what both screens hold.
          setFiles(updated.files)
          onChanged(updated)
        })
        .catch(() => setError(t('projects.saveError')))
    },
    [project.id, onChanged, t]
  )

  /**
   * Add a working folder by naming it. A phone cannot browse the desktop's
   * filesystem, so the path is typed — and the DESKTOP is what validates it:
   * the update rejects anything that is not a folder over there, and its
   * message is what shows here. A working folder the run cannot list would be
   * worse than no folder at all.
   */
  const addFolder = useCallback((): void => {
    const value = folderDraft.trim()
    if (!value || addingFolder || readOnly) return
    if (directories.includes(value)) {
      setFolderDraft('')
      return
    }
    setAddingFolder(true)
    setError(null)
    void updateProject({ id: project.id, directories: [...directories, value] })
      .then((updated) => {
        setTouched(true)
        setDirectories(updated.directories)
        setFolderDraft('')
        onChanged(updated)
      })
      .catch((err: unknown) =>
        setError(err instanceof Error ? err.message : t('projects.saveError'))
      )
      .finally(() => setAddingFolder(false))
  }, [folderDraft, addingFolder, readOnly, directories, project.id, onChanged, t])

  const removeFolder = useCallback(
    (dir: string): void => {
      const next = directories.filter((d) => d !== dir)
      setTouched(true)
      setError(null)
      setDirectories(next)
      void updateProject({ id: project.id, directories: next })
        .then((updated) => {
          setDirectories(updated.directories)
          onChanged(updated)
        })
        .catch(() => setError(t('projects.saveError')))
    },
    [directories, project.id, onChanged, t]
  )

  // An add is in flight — from the moment the picker opens. Adding and removing
  // both write the same file list, so both lock: a second write over the first
  // is only a race.
  const [adding, setAdding] = useState(false)
  const [copy, setCopy] = useState<CopyProgress | null>(null)
  const locked = busy || adding || readOnly

  /**
   * Adopt the file list arriving from outside — a file attached on the DESKTOP
   * while this dialog sits open.
   *
   * Files are not a draft. The title and the instructions deliberately are, which
   * is why nothing re-seeds those: adopting them mid-sentence would delete what
   * the user is typing. The file list has no such state to lose, so the stored
   * one always wins — except while THIS dialog is uploading, where the arriving
   * list is a snapshot from before the file being added and would take it back
   * off screen mid-transfer.
   */
  const incomingFiles = project.files
  const incomingDirs = project.directories
  useEffect(() => {
    if (adding) return
    setFiles((current) =>
      current.length === incomingFiles.length &&
      current.every((file, index) => file.path === incomingFiles[index]?.path)
        ? current
        : incomingFiles
    )
    setDirectories((current) =>
      current.length === incomingDirs.length &&
      current.every((dir, index) => dir === incomingDirs[index])
        ? current
        : incomingDirs
    )
  }, [incomingFiles, incomingDirs, adding])

  /**
   * Pick, validate, upload. Validation is per file rather than per batch — the
   * desktop's behavior too: a good file in a bad batch still attaches, and every
   * refusal names the rule it broke. Uploads are sequential because each is a
   * run of ordered chunk RPCs on one socket; interleaving buys nothing.
   */
  const addFiles = useCallback(
    (source: 'media' | 'files'): void => {
      if (adding || readOnly) return
      void (async () => {
        setAdding(true)
        setError(null)
        try {
          const remaining = MAX_FILES_PER_MESSAGE
          const picked = source === 'media' ? await pickMedia(remaining) : await pickDocuments()
          if (picked.length === 0) return

          const accepted: PickedFile[] = []
          const rejected: string[] = []
          let totalBytes = 0
          for (const file of picked) {
            const error = validateUpload(file.name, file.sizeBytes, accepted.length, totalBytes)
            if (error) {
              rejected.push(uploadErrorMessage(error, t))
              continue
            }
            accepted.push(file)
            totalBytes += file.sizeBytes
          }
          // One line per distinct reason: ten files over one cap is one problem,
          // not ten notices stacked on top of each other.
          if (rejected.length > 0) setError([...new Set(rejected)].join('\n'))
          if (accepted.length === 0) return

          // Batch-wide denominator, so the bar only ever moves forward — the
          // desktop draws one bar for the whole add, not N that restart.
          let sentBefore = 0
          const failed: string[] = []
          for (const [index, file] of accepted.entries()) {
            try {
              const updated = await uploadProjectFile(
                project.id,
                file.uri,
                file.name,
                file.mimeType,
                (sent) =>
                  setCopy({
                    index: index + 1,
                    total: accepted.length,
                    name: file.name,
                    sent: sentBefore + sent,
                    totalBytes
                  })
              )
              setFiles(updated.files)
              onChanged(updated)
              setTouched(true)
            } catch {
              failed.push(file.name)
            }
            sentBefore += file.sizeBytes
          }
          if (failed.length > 0) {
            setError(t('chat.attach.failed', { names: failed.join(', ') }))
          }
        } catch {
          // A picker that refused to open — no library access, a provider that
          // crashed. Nothing was picked; say so and move on.
          setError(t('chat.attach.error'))
        } finally {
          setAdding(false)
          setCopy(null)
        }
      })()
    },
    [adding, readOnly, project.id, onChanged, t]
  )

  const copyPercent = copy
    ? copy.totalBytes > 0
      ? Math.min(100, Math.round((copy.sent / copy.totalBytes) * 100))
      : 100
    : 0

  return (
    <Modal
      open
      onClose={close}
      title={t('projects.editTitle')}
      titleAccessory={controls ? <ViewPills value={view} onChange={setView} /> : undefined}
      // While a sheet is stacked on top, a backdrop tap must close that sheet
      // only — not both at once.
      dismissable={!emojiOpen && !promptOpen && !attachOpen && !adding}
      footer={
        // The two project-mode actions sit at opposite ends of one row — leaving
        // the project at the start, starting another conversation in it at the
        // end. `justify-between` rather than a spacer View, because with only
        // one of them present that spacer would push it off-centre.
        <View className="flex-row items-center justify-between gap-2">
          {onExitProject && (
            // Muted, not destructive-red: closing a project is a benign mode
            // switch, so it keeps the ghost variant's neutral styling — matching
            // the desktop's own close-project button.
            <Button
              variant="ghost"
              size="sm"
              disabled={busy}
              onPress={onExitProject}
              textClassName="text-muted"
            >
              {t('projects.exit')}
            </Button>
          )}
          {onNewConversation && (
            <Button
              size="sm"
              variant="outline"
              onPress={() => onNewConversation(project)}
              className="flex-row items-center gap-1.5"
            >
              <PlusSignIcon size={13} className="text-fg" />
              {t('projects.newConversation')}
            </Button>
          )}
          {!onExitProject && (
            <Button size="sm" onPress={close}>
              {t('projects.done')}
            </Button>
          )}
        </View>
      }
    >
      {view === 'controls' && controls ? (
        controls
      ) : (
        <ScrollView
          style={{ maxHeight: Math.round(height * 0.55) }}
          contentContainerStyle={{ gap: 12 }}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          <View className="flex-row items-start gap-2">
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t('projects.pickIcon')}
              disabled={readOnly}
              onPress={() => setEmojiOpen(true)}
              className={cn(
                'bg-bg border-border h-10 w-10 shrink-0 items-center justify-center rounded-lg border active:bg-border-soft',
                readOnly && 'opacity-50'
              )}
            >
              <Text className="text-lg">{draftIcon || DEFAULT_PROJECT_ICON}</Text>
            </Pressable>
            <View className="min-w-0 flex-1 flex-col gap-1">
              <Input
                value={draftTitle}
                editable={!readOnly}
                onChangeText={(value) => {
                  setTouched(true)
                  setDraftTitle(value)
                }}
                placeholder={t('projects.titlePlaceholder')}
                className={titleInvalid ? 'border-rose-500/70' : undefined}
              />
              {titleInvalid && (
                <Text className="text-left font-sans text-xs text-rose-500">
                  {t('projects.titleRequired')}
                </Text>
              )}
            </View>
          </View>

          <View className="flex-col gap-1.5">
            <Text className="text-muted font-sans-medium text-left text-sm">
              {t('projects.instructions')}
            </Text>
            {/* The block IS the way in: tapping it opens the expanded editor. */}
            <PromptPreview
              value={draftInstructions}
              empty={t('projects.noInstructions')}
              maxHeight={140}
              onPress={busy || readOnly ? undefined : () => setPromptOpen(true)}
            />
            {!busy && !readOnly && (
              <Button variant="outline" size="sm" onPress={() => setPromptOpen(true)}>
                {draftInstructions.trim()
                  ? t('projects.editInstructions')
                  : t('projects.addInstructions')}
              </Button>
            )}
          </View>

          <View className="flex-row items-center justify-between gap-2">
            <Text className="text-muted font-sans-medium text-left text-sm">
              {t('projects.files', { count: files.length })}
            </Text>
            <Button
              variant="outline"
              size="sm"
              disabled={locked}
              onPress={() => setAttachOpen(true)}
              className="flex-row items-center gap-1"
            >
              <PlusSignIcon size={13} className="text-fg" />
              {t('projects.addFiles')}
            </Button>
          </View>

          {/* Sending a file over the relay is not instant. Real bytes, batch-wide,
            the same bar the desktop draws for its own copy. */}
          {copy && (
            <View className="border-border bg-bg flex-col gap-1.5 rounded-lg border p-2">
              <View className="flex-row items-center gap-2">
                <Text
                  numberOfLines={1}
                  style={{ writingDirection: 'ltr' }}
                  className="text-muted min-w-0 flex-1 text-left font-sans text-xs"
                >
                  {copy.name}
                </Text>
                {copy.total > 1 && (
                  <Text className="text-muted shrink-0 font-sans text-xs">
                    {t('projects.copyingCount', { index: copy.index, total: copy.total })}
                  </Text>
                )}
                <Text className="text-muted shrink-0 font-sans text-xs">{`${copyPercent}%`}</Text>
              </View>
              <View
                accessibilityRole="progressbar"
                accessibilityLabel={t('projects.copyingFiles')}
                accessibilityValue={{ min: 0, max: 100, now: copyPercent }}
                className="bg-border h-1 w-full overflow-hidden rounded-full"
              >
                <View
                  className="bg-primary h-full rounded-full"
                  style={{ width: `${copyPercent}%` }}
                />
              </View>
            </View>
          )}

          {files.length > 0 && (
            <View className="border-border bg-bg flex-col gap-0.5 rounded-lg border p-1.5">
              {files.map((file) => {
                const { base, ext } = splitFileName(file.name)
                return (
                  <View
                    key={file.path}
                    className="h-9 flex-row items-center gap-2 rounded-md px-1.5"
                  >
                    {/* writingDirection ltr pins filename order (and the pinned
                      extension) even in the RTL locale — paths are LTR text. */}
                    <View className="min-w-0 flex-1 flex-row items-baseline">
                      <Text
                        numberOfLines={1}
                        style={{ writingDirection: 'ltr' }}
                        className="text-fg min-w-0 shrink text-left font-sans text-xs"
                      >
                        {base}
                      </Text>
                      {ext ? (
                        <Text
                          style={{ writingDirection: 'ltr' }}
                          className="text-fg shrink-0 font-sans text-xs"
                        >
                          {ext}
                        </Text>
                      ) : null}
                    </View>
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel={t('projects.removeFile')}
                      disabled={locked}
                      hitSlop={6}
                      onPress={() => persistFiles(files.filter((f) => f.path !== file.path))}
                      className={cn(
                        'h-7 w-7 shrink-0 items-center justify-center rounded-md',
                        locked ? 'opacity-40' : 'active:bg-border-soft'
                      )}
                    >
                      <Delete02Icon size={13} className="text-muted" />
                    </Pressable>
                  </View>
                )
              })}
            </View>
          )}

          {/* Working folders: references on the DESKTOP's disk, never copies. A
              phone cannot browse that filesystem, so the path is typed and the
              desktop is what validates it — see addFolder. */}
          <Text className="text-muted font-sans-medium text-left text-sm">
            {t('projects.folders', { count: directories.length })}
          </Text>
          {!readOnly && (
            <View className="flex-row items-end gap-2">
              <View className="min-w-0 flex-1">
                <Input
                  value={folderDraft}
                  editable={!addingFolder}
                  onChangeText={setFolderDraft}
                  onSubmitEditing={addFolder}
                  placeholder="/Users/you/Documents/reports"
                  autoCapitalize="none"
                  autoCorrect={false}
                  // A filesystem path is LTR technical text in either locale.
                  style={{ writingDirection: 'ltr' }}
                  className="font-mono"
                />
              </View>
              {/* size md, not sm: this one sits BESIDE the field, and the field
                  is h-10 — an h-8 button next to it reads as misaligned. */}
              <Button
                variant="outline"
                size="md"
                disabled={addingFolder || folderDraft.trim() === ''}
                onPress={addFolder}
                className="shrink-0 flex-row items-center gap-1"
              >
                <PlusSignIcon size={13} className="text-fg" />
                {t('projects.addFolder')}
              </Button>
            </View>
          )}
          {directories.length > 0 && (
            <View className="border-border bg-bg flex-col gap-1.5 rounded-lg border p-1.5">
              {directories.map((dir) => (
                <View key={dir} className="flex-row items-center gap-2 px-1.5">
                  <Text
                    numberOfLines={1}
                    selectable
                    style={{ writingDirection: 'ltr' }}
                    className="text-muted min-w-0 flex-1 text-left font-mono text-[11px]"
                  >
                    {dir}
                  </Text>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={t('projects.removeFolder')}
                    disabled={readOnly}
                    hitSlop={6}
                    onPress={() => removeFolder(dir)}
                    className={cn(
                      'h-7 w-7 shrink-0 items-center justify-center rounded-md',
                      readOnly ? 'opacity-40' : 'active:bg-border-soft'
                    )}
                  >
                    <Delete02Icon size={13} className="text-muted" />
                  </Pressable>
                </View>
              ))}
            </View>
          )}

          <DialogError message={error} />
          <Text className="text-muted text-left font-sans text-xs">
            {readOnly ? t('projects.readOnly') : t('projects.autosaveHint')}
          </Text>
        </ScrollView>
      )}

      <EmojiPicker
        open={emojiOpen}
        onClose={() => setEmojiOpen(false)}
        onPick={(emoji) => {
          setTouched(true)
          setDraftIcon(emoji)
          setEmojiOpen(false)
        }}
      />
      <PromptSheet
        open={promptOpen}
        title={t('projects.instructions')}
        initialValue={draftInstructions}
        placeholder={t('projects.instructionsPlaceholder')}
        onDone={(value) => {
          setTouched(true)
          setDraftInstructions(value)
          setPromptOpen(false)
        }}
      />
      <AttachSheet
        open={attachOpen}
        onClose={() => setAttachOpen(false)}
        onPickMedia={() => addFiles('media')}
        onPickFiles={() => addFiles('files')}
      />
    </Modal>
  )
}

/**
 * Project | Controls — which half of the project dialog is showing.
 *
 * The same two-segment pill grammar as the run-mode and on/off switches
 * (ModePills, settings' Toggle): no sliding knob, because a knob translating
 * along physical X inverts under RTL while segments never do.
 */
function ViewPills({
  value,
  onChange
}: {
  value: 'project' | 'controls'
  onChange: (view: 'project' | 'controls') => void
}): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <View
      accessibilityRole="tablist"
      className="border-border bg-bg shrink-0 flex-row items-center rounded-lg border p-0.5"
    >
      {(['project', 'controls'] as const).map((option) => {
        const selected = option === value
        return (
          <Pressable
            key={option}
            accessibilityRole="tab"
            accessibilityState={{ selected }}
            accessibilityLabel={t(`projects.view.${option}`)}
            disabled={selected}
            onPress={() => onChange(option)}
            className={cn('rounded-md px-2.5 py-1', selected && 'bg-primary')}
          >
            <Text
              className={cn(
                'font-sans-medium text-xs',
                selected ? 'text-primary-fg' : 'text-muted'
              )}
            >
              {t(`projects.view.${option}`)}
            </Text>
          </Pressable>
        )
      })}
    </View>
  )
}
