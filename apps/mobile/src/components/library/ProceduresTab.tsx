import { AttachSheet } from '@/components/chat/AttachmentPicker'
import { AttachmentChips } from '@/components/workspace/AttachmentChips'
import { Badge } from '@/components/core/Badge'
import { Button } from '@/components/core/Button'
import { ConfirmDialog } from '@/components/core/ConfirmDialog'
import { Input } from '@/components/core/Input'
import { Modal } from '@/components/core/Modal'
import { Delete02Icon, Edit02Icon, PlayIcon, PlusSignIcon } from '@/components/core/icons'
import { DEFAULT_PROJECT_ICON } from '@/components/workspace/ProjectDialog'
import { DialogError, PromptPreview, PromptSheet } from '@/components/workspace/PromptSheet'
import { ModePills } from '@/components/workspace/ModePills'
import { ThinkingPills } from '@/components/workspace/ThinkingPills'
import { EmojiPicker } from '@/components/workspace/EmojiPicker'
import { ProjectChipRow } from '@/components/workspace/ProjectChipRow'
import { pickDocuments, pickMedia, type PickedFile } from '@/lib/files/pickAttachments'
import { MAX_FILES_PER_MESSAGE, uploadErrorMessage, validateUpload } from '@/lib/files/uploadPolicy'
import {
  createProcedure,
  deleteProcedure,
  updateProcedure,
  uploadProcedureFile,
  useProcedures
} from '@/lib/sync/procedures'
import { useProjects, useProjectsWritable } from '@/lib/sync/projects'
import { useChatReasoning } from '@/lib/sync/useChatReasoning'
import type { ReasoningMode, SyncProcedure, SyncProjectFile } from '@/lib/tunnel/protocol'
import { cn } from '@/lib/utils/cn'
import { formatSignedRelative } from '@/lib/utils/relativeTime'
import { useToast } from '@/providers/toast/useToast'
import { useChatRuntime } from '@/state/chatRuntime'
import { useConfigValue } from '@/state/demoConfig'
import { router, useFocusEffect } from 'expo-router'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Pressable, Text, View } from 'react-native'

/**
 * Procedures — one tab of the Library screen, which owns the chrome around it
 * (back button, tab strip, subtitle); this is the desktop's Procedures page on
 * one column: saved prompts run on demand, each with its own emoji, run mode
 * and optional project binding.
 *
 * Play starts a FRESH conversation and sends the prompt into it, which is what
 * the desktop's play does (a new session that auto-sends). A project-bound
 * procedure runs inside that project, so the run gets its overlay and the
 * conversation registers under it — the binding travels with the send rather
 * than being applied afterwards.
 */

/** Card emoji for a procedure that never picked one — the desktop's default. */
const DEFAULT_PROCEDURE_ICON = '📋'

/** The unbound chip's value; the row keys on strings, so null needs one. */
const NO_PROJECT = ''

export function ProceduresTab(): React.JSX.Element {
  const { t } = useTranslation()
  const toast = useToast()
  const { data: procedures = [], isLoading, refetch } = useProcedures()
  const { data: projects = [] } = useProjects()
  const writable = useProjectsWritable()
  // Rows without a stamped mode follow the workspace's global mode — the pill
  // shows that effective value, and tapping a segment stamps the row.
  const globalMode = useConfigValue('chatMode')
  // The chat's reasoning contract: the modes the selected model honours, and
  // the mode chat is showing right now — what a row without a stamp follows.
  const reasoning = useChatReasoning()
  const setActiveProject = useChatRuntime((state) => state.setActiveProject)
  const setPendingProject = useChatRuntime((state) => state.setPendingProject)
  const setPendingPrompt = useChatRuntime((state) => state.setPendingPrompt)

  const [editing, setEditing] = useState<SyncProcedure | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<SyncProcedure | null>(null)

  useFocusEffect(
    useCallback(() => {
      void refetch()
    }, [refetch])
  )

  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30_000)
    return () => clearInterval(id)
  }, [])

  const projectsById = useMemo(() => new Map(projects.map((p) => [p.id, p])), [projects])

  /**
   * Card emoji: a project-bound procedure wears its PROJECT's emoji; an unbound
   * one wears its own, else the page default. The desktop's exact rule.
   */
  const cardIcon = useCallback(
    (procedure: SyncProcedure): string =>
      (procedure.projectId ? projectsById.get(procedure.projectId)?.icon : undefined) ||
      procedure.icon ||
      DEFAULT_PROCEDURE_ICON,
    [projectsById]
  )

  const handleCreate = useCallback((): void => {
    void createProcedure({ title: '', prompt: '' })
      .then(setEditing)
      .catch(() => toast.show({ tone: 'error', message: t('procedures.saveError') }))
  }, [t, toast])

  const handleDelete = useCallback((): void => {
    const target = deleteTarget
    if (!target) return
    void deleteProcedure(target.id)
      .then(() => {
        setDeleteTarget(null)
        toast.show({ tone: 'success', message: t('procedures.deleteSuccess') })
      })
      .catch(() => toast.show({ tone: 'error', message: t('procedures.saveError') }))
  }, [deleteTarget, t, toast])

  /**
   * The mode toggle persists on its own (a per-field merge, so a concurrent
   * title/prompt autosave cannot clobber it). No optimism: the desktop's answer
   * lands in the cache, and it is one small write.
   */
  const setMode = useCallback(
    (procedure: SyncProcedure, mode: 'single' | 'workflow'): void => {
      if ((procedure.mode ?? globalMode) === mode) return
      void updateProcedure({ id: procedure.id, mode }).catch(() =>
        toast.show({ tone: 'error', message: t('procedures.saveError') })
      )
    },
    [globalMode, t, toast]
  )

  /**
   * The thinking switch persists on the same terms as the mode toggle — one
   * per-field merge to the desktop, no optimism, the stored row lands in the
   * cache. `reasoning.current` is the effective value when the row carries no
   * stamp, so a press that would change nothing is skipped.
   */
  const setThinking = useCallback(
    (procedure: SyncProcedure, thinking: ReasoningMode): void => {
      const effective = procedure.thinking ?? reasoning.current
      if (effective === thinking) return
      void updateProcedure({ id: procedure.id, thinking }).catch(() =>
        toast.show({ tone: 'error', message: t('procedures.saveError') })
      )
    },
    [reasoning.current, t, toast]
  )

  /**
   * Run it: land in a fresh chat with this procedure's prompt queued for send,
   * inside its project when it has one.
   *
   * The prompt is left in the runtime for the chat screen to send, rather than
   * sent from here: that screen owns sending — it holds the live turn, the
   * optimistic bubble and the queue — and a prompt sent behind its back would
   * render as a reply to nothing. It also travels better than a navigation
   * param, since the run POPS BACK to a chat screen that is already mounted.
   */
  const handlePlay = useCallback(
    (procedure: SyncProcedure): void => {
      const project = procedure.projectId ? projectsById.get(procedure.projectId) : undefined
      // A bound procedure enters project mode, exactly as the desktop's run
      // does; an unbound one only files the one chat it is about to start (and
      // clears any project mode, since this run is not in one).
      if (project) setActiveProject(project)
      else {
        setActiveProject(null)
        setPendingProject(null)
      }
      setPendingPrompt(procedure.prompt)
      try {
        router.dismissTo('/chat')
      } catch {
        router.replace('/chat')
      }
    },
    [projectsById, setActiveProject, setPendingProject, setPendingPrompt]
  )

  return (
    <>
      <View className="flex-row items-center justify-between gap-3">
        <View className="flex-row items-center gap-2">
          <Text className="text-fg font-sans-semibold text-left text-base">
            {t('procedures.title')}
          </Text>
          {!isLoading && <Badge label={String(procedures.length)} />}
        </View>
        <Button size="sm" disabled={!writable} onPress={handleCreate} className="shrink-0">
          <PlusSignIcon size={14} className="text-primary-fg" />
          {t('procedures.new')}
        </Button>
      </View>

      {isLoading ? (
        <Text className="text-muted py-10 text-center font-sans text-sm">
          {t('common.loading')}
        </Text>
      ) : procedures.length === 0 ? (
        <View className="border-border rounded-2xl border border-dashed px-6 py-12">
          <Text className="text-muted text-center font-sans text-sm">{t('procedures.empty')}</Text>
        </View>
      ) : (
        <View className="flex-col gap-3">
          {procedures.map((procedure) => {
            const name = procedure.title.trim() || t('procedures.untitled')
            const runnable = procedure.prompt.trim().length > 0
            const project = procedure.projectId ? projectsById.get(procedure.projectId) : undefined
            return (
              <View
                key={procedure.id}
                className="bg-surface border-border flex-col gap-2.5 rounded-2xl border px-4 py-3"
              >
                <View className="flex-row items-start justify-between gap-3">
                  <View className="min-w-0 shrink flex-row items-center gap-2.5">
                    <Text className="text-2xl leading-7">{cardIcon(procedure)}</Text>
                    <View className="min-w-0 flex-1 flex-col gap-0.5">
                      <Text
                        numberOfLines={1}
                        className="text-fg font-sans-medium text-left text-sm"
                      >
                        {name}
                      </Text>
                      <Text numberOfLines={1} className="text-muted text-left font-sans text-xs">
                        {[
                          t('procedures.editedAt', {
                            time: formatSignedRelative(procedure.updatedAt, now, t)
                          }),
                          ...(project ? [project.title.trim() || t('projects.untitled')] : [])
                        ].join(' · ')}
                      </Text>
                    </View>
                  </View>
                  <View className="shrink-0 flex-row items-center">
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel={t('procedures.run')}
                      hitSlop={6}
                      disabled={!runnable}
                      onPress={() => handlePlay(procedure)}
                      className={cn(
                        'h-8 w-8 items-center justify-center rounded-lg',
                        runnable ? 'active:bg-border-soft' : 'opacity-40'
                      )}
                    >
                      <PlayIcon size={17} className="text-muted" />
                    </Pressable>
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel={t('procedures.edit')}
                      hitSlop={6}
                      onPress={() => setEditing(procedure)}
                      className="h-8 w-8 items-center justify-center rounded-lg active:bg-border-soft"
                    >
                      <Edit02Icon size={15} className="text-muted" />
                    </Pressable>
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel={t('procedures.delete')}
                      hitSlop={6}
                      disabled={!writable}
                      onPress={() => setDeleteTarget(procedure)}
                      className={cn(
                        'h-8 w-8 items-center justify-center rounded-lg',
                        writable ? 'active:bg-border-soft' : 'opacity-40'
                      )}
                    >
                      <Delete02Icon size={15} className="text-muted" />
                    </Pressable>
                    {/* The run mode closes the cluster, after delete, exactly as
                        it does on the desktop card — it belongs with the row's
                        other controls rather than on a line of its own. `ms-1`
                        separates the pill group from the icon buttons without
                        widening the gaps between them. */}
                    <View className="ms-1">
                      <ModePills
                        value={procedure.mode ?? globalMode}
                        disabled={!writable}
                        onChange={(mode) => setMode(procedure, mode)}
                      />
                    </View>
                  </View>
                </View>
                <PromptPreview value={procedure.prompt} empty={t('procedures.runEmptyHint')} />

                {/* The reasoning switch reads under the row's action cluster —
                    the phone has no width for a fifth control up there. It
                    edits the procedure's own stamp, so a run of this procedure
                    uses it whatever the composer is set to. */}
                <ThinkingPills
                  modes={reasoning.modes}
                  value={procedure.thinking ?? reasoning.current}
                  disabled={!writable}
                  onChange={(thinking) => setThinking(procedure, thinking)}
                />

                {/* What this procedure carries into every run. On the card,
                    not just in the editor: the paths are the part of a
                    procedure you cannot infer from its prompt. */}
                <AttachmentChips
                  files={(procedure.files ?? []).map((file) => file.name)}
                  directories={procedure.directories ?? []}
                />
              </View>
            )
          })}
        </View>
      )}

      <ProcedureEditor
        procedure={editing}
        projects={projects}
        readOnly={!writable}
        onClose={() => setEditing(null)}
      />

      <ConfirmDialog
        open={deleteTarget !== null}
        title={t('procedures.deleteTitle')}
        message={t('procedures.deleteWarning', {
          name: deleteTarget?.title.trim() || t('procedures.untitled')
        })}
        confirmLabel={t('procedures.deleteConfirm')}
        cancelLabel={t('procedures.deleteCancel')}
        onConfirm={handleDelete}
        onCancel={() => setDeleteTarget(null)}
      />
    </>
  )
}

/** One tick of the add-files batch — the desktop's AttachFilesProgress. */
type CopyProgress = { index: number; total: number; name: string; sent: number; totalBytes: number }

/**
 * The procedure editor — title, emoji, project binding and the prompt, which
 * opens in the app's expanded editor rather than being typed into the dialog.
 *
 * Autosaves ~600 ms after the last change, and the title is required: nothing is
 * persisted until one is typed, so a never-named fresh stub is discarded on
 * close and one that already had a title keeps its last saved state. The
 * desktop's exact contract.
 */
function ProcedureEditor({
  procedure,
  projects,
  readOnly,
  onClose
}: {
  procedure: SyncProcedure | null
  projects: Array<{ id: string; title: string; icon: string }>
  readOnly: boolean
  onClose: () => void
}): React.JSX.Element | null {
  if (!procedure) return null
  return (
    <ProcedureEditorBody
      key={procedure.id}
      procedure={procedure}
      projects={projects}
      readOnly={readOnly}
      onClose={onClose}
    />
  )
}

function ProcedureEditorBody({
  procedure,
  projects,
  readOnly,
  onClose
}: {
  procedure: SyncProcedure
  projects: Array<{ id: string; title: string; icon: string }>
  readOnly: boolean
  onClose: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  // Reported inline rather than as a toast — see DialogError.
  const [error, setError] = useState<string | null>(null)
  const [title, setTitle] = useState(procedure.title)
  const [prompt, setPrompt] = useState(procedure.prompt)
  const [icon, setIcon] = useState(procedure.icon)
  const [projectId, setProjectId] = useState(procedure.projectId ?? NO_PROJECT)
  const [emojiOpen, setEmojiOpen] = useState(false)
  const [promptOpen, setPromptOpen] = useState(false)
  const [touched, setTouched] = useState(false)
  const titleInvalid = touched && title.trim() === ''

  // Files and folders are NOT part of the debounced draft: each add or remove
  // is its own write, because an add already moved bytes across the tunnel and
  // a remove already deleted the desktop's copy.
  const [files, setFiles] = useState<SyncProjectFile[]>(procedure.files ?? [])
  const [directories, setDirectories] = useState<string[]>(procedure.directories ?? [])
  const [attachOpen, setAttachOpen] = useState(false)
  const [adding, setAdding] = useState(false)
  const [copy, setCopy] = useState<CopyProgress | null>(null)
  const [folderDraft, setFolderDraft] = useState('')
  const [addingFolder, setAddingFolder] = useState(false)
  const copyPercent = copy
    ? copy.totalBytes > 0
      ? Math.min(100, Math.round((copy.sent / copy.totalBytes) * 100))
      : 100
    : 0

  const savedRef = useRef({
    title: procedure.title,
    prompt: procedure.prompt,
    icon: procedure.icon,
    projectId: procedure.projectId ?? NO_PROJECT
  })

  const persist = useCallback(
    (next: { title: string; prompt: string; icon: string; projectId: string }): void => {
      savedRef.current = next
      setError(null)
      void updateProcedure({ id: procedure.id, ...next }).catch(() =>
        setError(t('procedures.saveError'))
      )
    },
    [procedure.id, t]
  )

  useEffect(() => {
    if (readOnly) return
    if (title.trim() === '') return
    const saved = savedRef.current
    if (
      title === saved.title &&
      prompt === saved.prompt &&
      icon === saved.icon &&
      projectId === saved.projectId
    ) {
      return
    }
    const handle = setTimeout(() => persist({ title, prompt, icon, projectId }), 600)
    return () => clearTimeout(handle)
  }, [readOnly, title, prompt, icon, projectId, persist])

  const close = useCallback((): void => {
    const saved = savedRef.current
    if (readOnly) {
      onClose()
      return
    }
    if (title.trim() === '') {
      // Never named: the stub is discarded entirely, so create-then-abandon
      // leaves nothing behind. One that already had a title keeps it — a
      // cleared title is never written.
      if (saved.title.trim() === '') {
        void deleteProcedure(procedure.id).catch(() => undefined)
      }
      onClose()
      return
    }
    if (
      title !== saved.title ||
      prompt !== saved.prompt ||
      icon !== saved.icon ||
      projectId !== saved.projectId
    ) {
      persist({ title, prompt, icon, projectId })
    }
    onClose()
  }, [readOnly, title, prompt, icon, projectId, procedure.id, persist, onClose])

  /**
   * Adopt lists arriving from OUTSIDE — a file attached on the desktop while
   * this dialog sits open. Files and folders are not a draft (the title and
   * prompt deliberately are, which is why nothing re-seeds those), so the
   * stored lists always win — except mid-upload, where the arriving snapshot
   * predates the file being sent and would take it back off screen.
   */
  const incomingFiles = procedure.files ?? []
  const incomingDirs = procedure.directories ?? []
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

  const persistFiles = useCallback(
    (next: SyncProjectFile[]): void => {
      setTouched(true)
      setError(null)
      setFiles(next)
      void updateProcedure({ id: procedure.id, files: next })
        .then((updated) => {
          // The desktop's own list wins: it deleted the copies it owns and its
          // answer is what both screens hold.
          setFiles(updated.files ?? [])
        })
        .catch(() => setError(t('procedures.saveError')))
    },
    [procedure.id, t]
  )

  /**
   * Pick, validate, upload — the project dialog's contract exactly. Validation
   * is per file rather than per batch (a good file in a bad batch still
   * attaches, and every refusal names the rule it broke) and uploads run
   * sequentially, since each is a run of ordered chunk RPCs on one socket.
   */
  const addFiles = useCallback(
    (source: 'media' | 'files'): void => {
      if (adding || readOnly) return
      void (async () => {
        setAdding(true)
        setError(null)
        try {
          const picked =
            source === 'media' ? await pickMedia(MAX_FILES_PER_MESSAGE) : await pickDocuments()
          if (picked.length === 0) return

          const accepted: PickedFile[] = []
          const rejected: string[] = []
          let totalBytes = 0
          for (const file of picked) {
            const problem = validateUpload(file.name, file.sizeBytes, accepted.length, totalBytes)
            if (problem) {
              rejected.push(uploadErrorMessage(problem, t))
              continue
            }
            accepted.push(file)
            totalBytes += file.sizeBytes
          }
          // One line per distinct reason: ten files over one cap is one problem,
          // not ten notices stacked on top of each other.
          if (rejected.length > 0) setError([...new Set(rejected)].join('\n'))
          if (accepted.length === 0) return

          // Batch-wide denominator, so the bar only ever moves forward.
          let sentBefore = 0
          const failed: string[] = []
          for (const [index, file] of accepted.entries()) {
            try {
              const updated = await uploadProcedureFile(
                procedure.id,
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
              setFiles(updated.files ?? [])
              setTouched(true)
            } catch {
              failed.push(file.name)
            }
            sentBefore += file.sizeBytes
          }
          if (failed.length > 0) setError(t('chat.attach.failed', { names: failed.join(', ') }))
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
    [adding, readOnly, procedure.id, t]
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
    void updateProcedure({ id: procedure.id, directories: [...directories, value] })
      .then((updated) => {
        setTouched(true)
        setDirectories(updated.directories ?? [])
        setFolderDraft('')
      })
      .catch((err: unknown) =>
        setError(err instanceof Error ? err.message : t('procedures.saveError'))
      )
      .finally(() => setAddingFolder(false))
  }, [folderDraft, addingFolder, readOnly, directories, procedure.id, t])

  const removeFolder = useCallback(
    (dir: string): void => {
      const next = directories.filter((d) => d !== dir)
      setTouched(true)
      setError(null)
      setDirectories(next)
      void updateProcedure({ id: procedure.id, directories: next })
        .then((updated) => setDirectories(updated.directories ?? []))
        .catch(() => setError(t('procedures.saveError')))
    },
    [directories, procedure.id, t]
  )

  const locked = readOnly || adding

  const boundProject = projectId ? projects.find((p) => p.id === projectId) : undefined

  return (
    <Modal
      open
      onClose={close}
      title={t('procedures.editTitle')}
      dismissable={!emojiOpen && !promptOpen && !attachOpen && !adding}
      footer={
        <View className="flex-row justify-end">
          <Button size="sm" onPress={close}>
            {t('procedures.done')}
          </Button>
        </View>
      }
    >
      <View className="flex-row items-start gap-2">
        {/* A project-bound procedure wears the project's emoji — the button
            shows it and disables; its own icon returns when the binding goes. */}
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={boundProject ? t('procedures.projectIcon') : t('procedures.pickIcon')}
          disabled={readOnly || boundProject !== undefined}
          onPress={() => setEmojiOpen(true)}
          className={cn(
            'bg-bg border-border h-10 w-10 shrink-0 items-center justify-center rounded-lg border',
            readOnly ? 'opacity-50' : 'active:bg-border-soft'
          )}
        >
          <Text className="text-lg">
            {boundProject
              ? boundProject.icon || DEFAULT_PROJECT_ICON
              : icon || DEFAULT_PROCEDURE_ICON}
          </Text>
        </Pressable>
        <View className="min-w-0 flex-1 flex-col gap-1">
          <Input
            value={title}
            editable={!readOnly}
            onChangeText={(value) => {
              setTouched(true)
              setTitle(value)
            }}
            placeholder={t('procedures.titlePlaceholder')}
            className={titleInvalid ? 'border-rose-500/70' : undefined}
          />
          {titleInvalid && (
            <Text className="text-left font-sans text-xs text-rose-500">
              {t('procedures.titleRequired')}
            </Text>
          )}
        </View>
      </View>

      {/* Bind a project: the run gets its context and the conversation
          registers under it. */}
      <ProjectChipRow
        label={t('procedures.project')}
        noneLabel={t('procedures.projectNone')}
        projects={projects}
        value={projectId}
        disabled={readOnly}
        onChange={(value) => {
          setTouched(true)
          setProjectId(value)
        }}
      />

      <View className="flex-col gap-1.5">
        <Text className="text-muted font-sans-medium text-left text-sm">
          {t('heartbeat.editor.prompt')}
        </Text>
        <PromptPreview
          value={prompt}
          empty={t('procedures.runEmptyHint')}
          maxHeight={140}
          onPress={readOnly ? undefined : () => setPromptOpen(true)}
        />
        {!readOnly && (
          <Button variant="outline" size="sm" onPress={() => setPromptOpen(true)}>
            {prompt.trim() ? t('procedures.editPrompt') : t('procedures.addPrompt')}
          </Button>
        )}
      </View>

      {/* Files: uploaded to the DESKTOP, which owns the workspace and the
          name. Every run is told what it has and where, and reads with its own
          tools — the bytes are never pasted into the prompt. */}
      <View className="flex-row items-center justify-between gap-2">
        <Text className="text-muted font-sans-medium text-left text-sm">
          {t('procedures.files', { count: files.length })}
        </Text>
        <Button
          variant="outline"
          size="sm"
          disabled={locked}
          onPress={() => setAttachOpen(true)}
          className="flex-row items-center gap-1"
        >
          <PlusSignIcon size={13} className="text-fg" />
          {t('procedures.addFiles')}
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
            <View className="bg-primary h-full rounded-full" style={{ width: `${copyPercent}%` }} />
          </View>
        </View>
      )}

      {files.length > 0 && (
        <View className="border-border bg-bg flex-col gap-0.5 rounded-lg border p-1.5">
          {files.map((file) => (
            <View key={file.path} className="h-9 flex-row items-center gap-2 rounded-md px-1.5">
              {/* writingDirection ltr pins filename order even in the RTL
                  locale — paths are LTR text. */}
              <Text
                numberOfLines={1}
                style={{ writingDirection: 'ltr' }}
                className="text-fg min-w-0 flex-1 text-left font-sans text-xs"
              >
                {file.name}
              </Text>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={t('procedures.removeFile')}
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
          ))}
        </View>
      )}

      {/* Working folders: references on the DESKTOP's disk, never copies. A
          phone cannot browse that filesystem, so the path is typed and the
          desktop is what validates it — see addFolder. */}
      <Text className="text-muted font-sans-medium text-left text-sm">
        {t('procedures.folders', { count: directories.length })}
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
            {t('procedures.addFolder')}
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
                accessibilityLabel={t('procedures.removeFolder')}
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
        {readOnly ? t('projects.readOnly') : t('procedures.autosaveHint')}
      </Text>

      <EmojiPicker
        open={emojiOpen}
        onClose={() => setEmojiOpen(false)}
        onPick={(emoji) => {
          setTouched(true)
          setIcon(emoji)
          setEmojiOpen(false)
        }}
      />
      <PromptSheet
        open={promptOpen}
        title={t('heartbeat.editor.prompt')}
        initialValue={prompt}
        placeholder={t('procedures.promptPlaceholder')}
        onDone={(value) => {
          setTouched(true)
          setPrompt(value)
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
