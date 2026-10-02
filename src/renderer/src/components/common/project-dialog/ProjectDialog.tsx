import { EmojiPicker } from '@components/common/emoji-picker/EmojiPicker'
import { Button } from '@components/core/Button'
import { CodeEditor } from '@components/core/CodeEditor'
import { EditorSheet } from '@components/core/EditorSheet'
import { ExpandedSheet } from '@components/core/ExpandedSheet'
import { useToast } from '@components/core/toast/useToast'
import { cn } from '@lib/utils/cn'
import type { Project, ProjectCopyProgress, ProjectFileRef } from '@preload/index'
import { useTheme } from '@providers/theme/useTheme'
import { Add01Icon, Copy01Icon, Delete02Icon } from 'hugeicons-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

/**
 * Middle truncation that keeps the extension visible: the base name gets the
 * CSS ellipsis while ".pdf" stays pinned — "quarterly-report-fin….pdf".
 */
function splitFileName(name: string): { base: string; ext: string } {
  const dot = name.lastIndexOf('.')
  if (dot <= 0 || dot === name.length - 1) return { base: name, ext: '' }
  return { base: name.slice(0, dot), ext: name.slice(dot) }
}

/** Last path segment, for either separator — these are absolute OS paths. */
function folderBaseName(filePath: string): string {
  const parts = filePath.split(/[\\/]/).filter(Boolean)
  return parts[parts.length - 1] ?? filePath
}

const fieldClass = cn(
  'bg-bg border-border text-fg placeholder:text-muted/60 block w-full rounded-lg border px-3 py-2 text-sm leading-5',
  'focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-1 focus-visible:ring-offset-bg focus-visible:outline-none'
)

// The copy-progress card and the referenced-files list share one shell, and
// hold rows of one fixed height — so the block claims its space the moment a
// copy starts and keeps it when progress gives way to the finished file row,
// instead of shifting the dialog a second time on completion.
const fileCardClass = 'border-border bg-bg rounded-lg border p-1.5'
/** h-8 — the remove button's h-6 plus the row's former py-1, top and bottom. */
const fileRowHeight = 'h-8'
const fileRowClass = cn(fileRowHeight, 'flex items-center gap-2 rounded-md px-1.5')

export type ProjectDialogProps = {
  project: Project | null
  onClose: () => void
  /** Every persisted change flows back so callers keep list/active state fresh. */
  onChanged: (project: Project) => void
  /** Chat project-mode extras: start a fresh conversation in this project. */
  onNewConversation?: (project: Project) => void
  /** Chat project-mode extras: leave the project (back to the projects list). */
  onExitProject?: () => void
  /**
   * A turn is executing in this project's session — the controls that edit
   * the project's own base under it lock (instructions, files, folders) so
   * it can't shift mid-turn. Exiting does not lock: it is a view switch, and
   * the running turn keeps going in its session.
   */
  busy?: boolean
}

/**
 * Edit dialog for one project — title, emoji icon, instructions (auto-saved
 * with the procedures editor's debounce discipline) and the referenced-files
 * list (persisted immediately per add/remove). Shared by the Projects page
 * and chat's project mode.
 */
export function ProjectDialog(props: ProjectDialogProps): React.JSX.Element | null {
  // Keyed remount per project: draft state seeds from props in useState
  // initializers (no seeding effect, no cascading setState), and switching
  // projects can never leak one project's drafts into another's editor.
  if (!props.project) return null
  return <ProjectDialogBody key={props.project.id} {...props} project={props.project} />
}

function ProjectDialogBody({
  project,
  onClose,
  onChanged,
  onNewConversation,
  onExitProject,
  busy = false
}: ProjectDialogProps & { project: Project }): React.JSX.Element {
  const { t } = useTranslation()
  const { isDark } = useTheme()
  const toast = useToast()

  const [draftTitle, setDraftTitle] = useState(project.title)
  const [draftIcon, setDraftIcon] = useState(project.icon)
  const [draftInstructions, setDraftInstructions] = useState(project.instructions)
  const [files, setFiles] = useState<ProjectFileRef[]>(project.files)
  const [dirs, setDirs] = useState<string[]>(project.directories ?? [])
  const [addingDirs, setAddingDirs] = useState(false)
  const [emojiOpen, setEmojiOpen] = useState(false)
  // The instructions are edited in a full-screen sheet rather than inline: the
  // dialog shows four lines and clicking opens the editor. Autosave is
  // unchanged — the sheet writes into the same draft state, so an edit made in
  // it is committed by the same debounce and reflected on close.
  const [instructionsExpanded, setInstructionsExpanded] = useState(false)
  // The required-title error stays hidden until the user edits SOMETHING —
  // a fresh project opens with an empty title, and scolding before any input
  // is noise. Any edit arms it (not just title edits): with an empty title
  // autosave is suspended and the stub is discarded on close, so icon/
  // instructions/file work is exactly what the warning protects.
  const [touched, setTouched] = useState(false)
  const titleInvalid = touched && draftTitle.trim() === ''
  // Last values dispatched to disk — the auto-save baseline (same contract as
  // the procedures editor: stops idle re-saves and close-time double writes).
  const savedRef = useRef<{ title: string; icon: string; instructions: string }>({
    title: project.title,
    icon: project.icon,
    instructions: project.instructions
  })

  const persist = useCallback(
    (id: string, title: string, icon: string, instructions: string) => {
      savedRef.current = { title, icon, instructions }
      return window.api.projects
        .update({ id, title, icon, instructions })
        .then(onChanged)
        .catch(() => toast.show({ tone: 'error', message: t('projects.saveError') }))
    },
    [onChanged, t, toast]
  )

  useEffect(() => {
    if (!project) return
    if (draftTitle.trim() === '') return
    const saved = savedRef.current
    if (
      draftTitle === saved.title &&
      draftIcon === saved.icon &&
      draftInstructions === saved.instructions
    ) {
      return
    }
    const handle = setTimeout(
      () => void persist(project.id, draftTitle, draftIcon, draftInstructions),
      600
    )
    return () => clearTimeout(handle)
  }, [project, draftTitle, draftIcon, draftInstructions, persist])

  const close = useCallback(() => {
    setInstructionsExpanded(false)
    if (project && draftTitle.trim() !== '') {
      const saved = savedRef.current
      if (
        draftTitle !== saved.title ||
        draftIcon !== saved.icon ||
        draftInstructions !== saved.instructions
      ) {
        void persist(project.id, draftTitle, draftIcon, draftInstructions)
      }
    }
    onClose()
  }, [project, draftTitle, draftIcon, draftInstructions, persist, onClose])

  const persistFiles = useCallback(
    (next: ProjectFileRef[]) => {
      if (!project) return
      setTouched(true)
      setFiles(next)
      void window.api.projects
        .update({ id: project.id, files: next })
        .then(onChanged)
        .catch(() => toast.show({ tone: 'error', message: t('projects.saveError') }))
    },
    [project, onChanged, t, toast]
  )

  const persistDirs = useCallback(
    (next: string[]) => {
      if (!project) return
      setTouched(true)
      setDirs(next)
      void window.api.projects
        .update({ id: project.id, directories: next })
        .then(onChanged)
        .catch(() => toast.show({ tone: 'error', message: t('projects.saveError') }))
    },
    [project, onChanged, t, toast]
  )

  const addDirs = useCallback(() => {
    if (addingDirs) return
    setAddingDirs(true)
    void window.api.paths
      .pickDirectories()
      .then((picked) => {
        if (!picked) return
        persistDirs([...dirs, ...picked.filter((p) => !dirs.includes(p))])
      })
      .catch(() => toast.show({ tone: 'error', message: t('projects.saveError') }))
      .finally(() => setAddingDirs(false))
  }, [addingDirs, dirs, persistDirs, t, toast])

  // A pickFiles() call is in flight — the whole time, including while the
  // native picker is open. Adding and removing lock: both write the same
  // file list, and a second picker over the first is just a race.
  const [adding, setAdding] = useState(false)
  // Copy ticks from main. Non-null only once bytes are actually moving, so
  // the bar appears when the picker closes rather than behind it.
  const [copy, setCopy] = useState<ProjectCopyProgress | null>(null)

  // Subscribed only for the duration of OUR add. The ticks are a broadcast,
  // and this dialog can be mounted twice for one project (Projects page +
  // chat's project mode) — a copy started elsewhere would otherwise leave a
  // bar here with no completion to clear it.
  useEffect(() => {
    if (!adding) return
    return window.api.projects.onCopyProgress((progress) => {
      if (progress.projectId !== project.id) return
      setCopy(progress)
    })
  }, [adding, project.id])

  const addFiles = useCallback(() => {
    if (adding) return
    // Pick + copy happen main-side in one step (files are copied into the
    // project's uploads dir); the returned project is already persisted.
    setAdding(true)
    void window.api.projects
      .pickFiles(project.id)
      .then((updated) => {
        if (!updated) return
        setTouched(true)
        setFiles(updated.files)
        onChanged(updated)
      })
      .catch(() => toast.show({ tone: 'error', message: t('projects.saveError') }))
      .finally(() => {
        setAdding(false)
        setCopy(null)
      })
  }, [adding, project.id, onChanged, t, toast])

  const copyPercent = copy
    ? copy.totalBytes > 0
      ? Math.min(100, Math.round((copy.copiedBytes / copy.totalBytes) * 100))
      : 100
    : 0
  const locked = busy || adding

  const copyInstructions = useCallback(() => {
    void navigator.clipboard
      .writeText(draftInstructions)
      .then(() => toast.show({ tone: 'success', message: t('projects.copied') }))
      .catch(() => {})
  }, [draftInstructions, t, toast])

  return (
    <EditorSheet
      open={project !== null}
      onClose={close}
      // While the expanded editor is stacked on top, Escape/backdrop must only
      // close that — not both sheets at once.
      dismissable={!instructionsExpanded}
      title={t('projects.editTitle')}
      footer={
        <div className="flex w-full items-center gap-2">
          {onExitProject && (
            // Muted, not destructive-red: closing a project is a benign mode
            // switch — the ghost variant's own neutral hover applies. Never
            // disabled under a running turn: exit only swaps the visible
            // session, and the project's turn keeps running in its own.
            <Button variant="ghost" size="sm" onClick={onExitProject} className="text-muted">
              {t('projects.exit')}
            </Button>
          )}
          <div className="flex-1" />
          {onNewConversation && project && (
            <Button
              size="sm"
              variant="outline"
              onClick={() => onNewConversation(project)}
              className="flex items-center gap-1.5"
            >
              <Add01Icon size={14} />
              <span>{t('projects.newConversation')}</span>
            </Button>
          )}
          {/* Chat's project dialog closes via backdrop/autosave — no Done;
              the Projects page keeps it as the editor's single action. */}
          {!onExitProject && (
            <Button size="sm" onClick={close}>
              {t('projects.done')}
            </Button>
          )}
        </div>
      }
    >
      <div className="flex flex-col gap-3">
        <div className="flex items-start gap-2">
          <div className="relative">
            <button
              type="button"
              onClick={() => setEmojiOpen((v) => !v)}
              aria-label={t('projects.pickIcon')}
              title={t('projects.pickIcon')}
              className={cn(
                'bg-bg border-border flex h-9 w-9 shrink-0 cursor-pointer items-center justify-center rounded-lg border text-lg',
                'focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none'
              )}
            >
              {draftIcon || '📁'}
            </button>
            {emojiOpen && (
              <EmojiPicker
                onPick={(emoji) => {
                  setTouched(true)
                  setDraftIcon(emoji)
                  setEmojiOpen(false)
                }}
                onClose={() => setEmojiOpen(false)}
              />
            )}
          </div>
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <input
              value={draftTitle}
              onChange={(e) => {
                setTouched(true)
                setDraftTitle(e.target.value)
              }}
              placeholder={t('projects.titlePlaceholder')}
              aria-required
              aria-invalid={titleInvalid}
              className={cn(fieldClass, titleInvalid && 'border-rose-500/70')}
            />
            {titleInvalid && <p className="text-xs text-rose-500">{t('projects.titleRequired')}</p>}
          </div>
        </div>

        <div className="flex items-center justify-between">
          <span className="text-muted text-xs font-medium">{t('projects.instructions')}</span>
          {/* Nothing to copy when there are no instructions. */}
          {draftInstructions.trim() !== '' && (
            <button
              type="button"
              onClick={copyInstructions}
              aria-label={t('projects.copy')}
              title={t('projects.copy')}
              className="text-muted hover:text-fg flex h-6 w-6 cursor-pointer items-center justify-center rounded-md"
            >
              <Copy01Icon size={13} />
            </button>
          )}
        </div>
        {/* The instructions, in the same CodeMirror editor the expanded sheet
            runs — editable in place, over the same draft state. Fixed height,
            filled or empty: the dialog never reflows as instructions grow, so
            long instructions scroll inside the block and the button below
            opens the full-height sheet to write comfortably, exactly as the
            Automations and Procedures editors do. background="field" sits the
            block in the same bg-bg well the Select and input fields use. */}
        <div className="border-border h-40 w-full overflow-hidden rounded-lg border">
          <CodeEditor
            background="field"
            value={draftInstructions}
            language="markdown"
            isDark={isDark}
            onChange={(value) => {
              setTouched(true)
              setDraftInstructions(value)
            }}
            placeholder={t('projects.instructionsPlaceholder')}
            className="h-full overflow-auto overscroll-contain"
            spellcheck
            readOnly={busy}
          />
        </div>
        {/* Same draft, more room — opens the full-height editor sheet. */}
        <Button
          variant="outline"
          size="sm"
          onClick={() => setInstructionsExpanded(true)}
          disabled={busy}
          className="self-start"
        >
          {draftInstructions.trim()
            ? t('projects.editInstructions')
            : t('projects.addInstructions')}
        </Button>

        <div className="flex items-center justify-between">
          <span className="text-muted text-xs font-medium">
            {t('projects.files', { count: files.length })}
          </span>
          <Button
            variant="outline"
            size="sm"
            onClick={addFiles}
            disabled={locked}
            className="flex items-center gap-1"
          >
            <Add01Icon size={13} />
            {/* Label is fixed while a pick/copy is in flight — the disabled
                state carries "busy", and the progress bar below reports it. */}
            <span>{t('projects.addFiles')}</span>
          </Button>
        </div>
        {/* Copying a large file into the workspace is not instant. Without
            this the dialog showed nothing at all and then the file simply
            appeared. Real bytes, batch-wide, from the main-side copy. */}
        {copy && (
          <div className={fileCardClass}>
            {/* Label + bar stack inside ONE row box: the card is then exactly
                as tall as the files list holding a single file. */}
            <div className={cn(fileRowHeight, 'flex flex-col justify-center gap-1 px-1.5')}>
              <div className="text-muted flex items-center gap-2 text-xs">
                <span dir="ltr" title={copy.name} className="min-w-0 flex-1 truncate">
                  {copy.name}
                </span>
                {copy.total > 1 && (
                  <span className="shrink-0 tabular-nums">
                    {t('projects.copyingCount', { index: copy.index, total: copy.total })}
                  </span>
                )}
                <span className="shrink-0 tabular-nums">{copyPercent}%</span>
              </div>
              <div
                role="progressbar"
                aria-label={t('projects.copyingFiles')}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={copyPercent}
                className="bg-border h-1 w-full overflow-hidden rounded-full"
              >
                <div
                  className="bg-primary h-full rounded-full transition-[width] duration-150"
                  style={{ width: `${copyPercent}%` }}
                />
              </div>
            </div>
          </div>
        )}
        {files.length > 0 && (
          <ul className={cn(fileCardClass, 'flex max-h-36 flex-col gap-0.5 overflow-y-auto')}>
            {files.map((file) => {
              const { base, ext } = splitFileName(file.name)
              return (
                <li key={file.path} className={cn('group shrink-0', fileRowClass)}>
                  {/* dir=ltr pins filename order (and the pinned extension)
                      even in the RTL locale — paths are LTR text. */}
                  <span
                    title={file.path}
                    dir="ltr"
                    className="text-fg flex min-w-0 flex-1 items-baseline text-xs"
                  >
                    <span className="truncate">{base}</span>
                    {ext && <span className="shrink-0">{ext}</span>}
                  </span>
                  <button
                    type="button"
                    onClick={() => persistFiles(files.filter((f) => f.path !== file.path))}
                    disabled={locked}
                    aria-label={t('projects.removeFile')}
                    title={t('projects.removeFile')}
                    className={cn(
                      'text-muted flex h-6 w-6 shrink-0 items-center justify-center rounded-md',
                      locked
                        ? 'cursor-not-allowed opacity-40'
                        : 'cursor-pointer hover:text-rose-500'
                    )}
                  >
                    <Delete02Icon size={13} />
                  </button>
                </li>
              )
            })}
          </ul>
        )}
        {/* Working folders: references, never copies. Every turn inside the
            project gets a fresh listing of each one, through the same channel
            chat's own folder picker uses. */}
        <div className="flex items-center justify-between">
          <span className="text-muted text-xs font-medium">
            {t('projects.folders', { count: dirs.length })}
          </span>
          <Button
            variant="outline"
            size="sm"
            onClick={addDirs}
            disabled={locked || addingDirs}
            className="flex items-center gap-1"
          >
            <Add01Icon size={13} />
            <span>{t('projects.addFolders')}</span>
          </Button>
        </div>
        {dirs.length > 0 && (
          <ul className={cn(fileCardClass, 'flex max-h-40 flex-col gap-1.5 overflow-y-auto')}>
            {dirs.map((dir) => (
              <li key={dir} dir="ltr" className="flex flex-col gap-0.5 px-1.5 py-0.5">
                <span title={dir} className="text-fg truncate text-xs">
                  {folderBaseName(dir)}
                </span>
                <div className="flex items-center gap-1">
                  {/* The full path, in a code block — the same treatment the
                      composer's working-folder card gives it. */}
                  <code
                    title={dir}
                    className="border-border bg-surface text-muted block min-w-0 flex-1 truncate rounded border px-1 py-0.5 font-mono text-[10px]"
                  >
                    {dir}
                  </code>
                  <button
                    type="button"
                    onClick={() => persistDirs(dirs.filter((d) => d !== dir))}
                    disabled={locked}
                    aria-label={t('projects.removeFolder')}
                    title={t('projects.removeFolder')}
                    className={cn(
                      'text-muted flex h-6 w-6 shrink-0 items-center justify-center rounded-md',
                      locked
                        ? 'cursor-not-allowed opacity-40'
                        : 'cursor-pointer hover:text-rose-500'
                    )}
                  >
                    <Delete02Icon size={13} />
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
        <p className="text-muted text-xs">{t('projects.autosaveHint')}</p>
      </div>

      {/* The expanded instructions editor — the file viewers' own expand sheet,
          over the same draft state, so what is typed here autosaves on the
          editor's debounce and the preview above reflects it on close. The
          sheet, not a centered dialog: the form behind it is a sheet too, so
          expanding the instructions widens the same surface instead of stacking
          a second shape on top of it. */}
      <ExpandedSheet
        open={instructionsExpanded}
        onClose={() => setInstructionsExpanded(false)}
        title={
          draftInstructions.trim() ? t('projects.editInstructions') : t('projects.addInstructions')
        }
      >
        <CodeEditor
          background="field"
          value={draftInstructions}
          language="markdown"
          isDark={isDark}
          onChange={(value) => {
            setTouched(true)
            setDraftInstructions(value)
          }}
          placeholder={t('projects.instructionsPlaceholder')}
          className="h-full overflow-auto"
          spellcheck
          readOnly={busy}
        />
      </ExpandedSheet>
    </EditorSheet>
  )
}
