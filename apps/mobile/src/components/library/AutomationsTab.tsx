import { Badge } from '@/components/core/Badge'
import { Button } from '@/components/core/Button'
import { ConfirmDialog } from '@/components/core/ConfirmDialog'
import { Input } from '@/components/core/Input'
import { Modal } from '@/components/core/Modal'
import {
  Delete02Icon,
  Edit02Icon,
  HelpCircleIcon,
  InformationCircleIcon,
  PlayIcon,
  PlusSignIcon
} from '@/components/core/icons'
import { DEFAULT_PROJECT_ICON } from '@/components/workspace/ProjectDialog'
import { DialogError, PromptPreview, PromptSheet } from '@/components/workspace/PromptSheet'
import { EmojiPicker } from '@/components/workspace/EmojiPicker'
import { ModePills } from '@/components/workspace/ModePills'
import { ProjectChipRow } from '@/components/workspace/ProjectChipRow'
import {
  addBlockPath,
  attachJobs,
  chipSchedule,
  chipStateOf,
  CHIP_KINDS,
  CHIP_TIMES,
  deleteBlock,
  DEFAULT_AUTOMATION_ICON,
  findBlock,
  GUIDE_ROWS,
  nextCronMs,
  orderAutomations,
  parseAutomations,
  parseSchedule,
  removeBlockPath,
  setBlockMode,
  setBlockThinking,
  toggleBlock,
  writeDraft,
  type AutomationBlock,
  type BoundBlock,
  type ChipKind,
  type ChipTimes
} from '@/lib/automations/heartbeat'
import { AttachSheet } from '@/components/chat/AttachmentPicker'
import { AttachmentChips } from '@/components/workspace/AttachmentChips'
import { pickDocuments, pickMedia, type PickedFile } from '@/lib/files/pickAttachments'
import { MAX_FILES_PER_MESSAGE, uploadErrorMessage, validateUpload } from '@/lib/files/uploadPolicy'
import {
  editAutomations,
  resolveDirectory,
  runAutomation,
  uploadAutomationFile,
  useAutomations
} from '@/lib/sync/automations'
import { useProjects, useProjectsWritable } from '@/lib/sync/projects'
import { useChatReasoning } from '@/lib/sync/useChatReasoning'
import { ThinkingPills } from '@/components/workspace/ThinkingPills'
import type { ReasoningMode } from '@/lib/tunnel/protocol'
import { cn } from '@/lib/utils/cn'
import { formatAbsoluteMoment, formatSignedRelative } from '@/lib/utils/relativeTime'
import { useLocale } from '@/providers/locale/useLocale'
import { useToast } from '@/providers/toast/useToast'
import { useConfigValue } from '@/state/demoConfig'
import { useFocusEffect } from 'expo-router'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Pressable, ScrollView, Text, View, useWindowDimensions } from 'react-native'

/**
 * Automations — one tab of the Library screen; the desktop's Automations page
 * on one column.
 *
 * The store is a markdown file, but the phone shows only what the file MEANS —
 * the cards. The desktop's raw-markdown view is not here: on a phone the file
 * is read through the cards and edited through their editor, and a second
 * surface for the same store is a second place to get it wrong. Every card
 * action (switch on/off, change mode, delete, save the editor) is a splice of
 * that one file, and all of the splicing lives in
 * lib/automations/heartbeat.ts — a direct port of the desktop's own, so the two
 * screens can never write the file in incompatible ways.
 *
 * What the desktop uniquely knows is WHEN each active automation fires: the
 * scheduler runs on that machine, against that clock. So the next-run moment is
 * served, never computed here — except in the editor's preview of a schedule
 * that has not been saved yet, which has no desktop answer to ask for.
 */
export function AutomationsTab(): React.JSX.Element {
  const { t } = useTranslation()
  const { locale } = useLocale()
  const toast = useToast()
  const { data, isLoading, refetch } = useAutomations()
  const { data: projects = [] } = useProjects()
  const writable = useProjectsWritable()
  const globalMode = useConfigValue('chatMode')
  // The chat's reasoning contract: the modes the selected model honours, and
  // the mode chat is showing right now — what a block with no marker runs at.
  const reasoning = useChatReasoning()

  const [editorFor, setEditorFor] = useState<AutomationBlock | null>(null)
  const [creating, setCreating] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<AutomationBlock | null>(null)
  const [deleting, setDeleting] = useState(false)

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

  const markdown = data?.markdown ?? ''
  const blocks = useMemo(
    () => orderAutomations(attachJobs(parseAutomations(markdown), data?.jobs ?? [])),
    [markdown, data?.jobs]
  )
  const projectsById = useMemo(() => new Map(projects.map((p) => [p.id, p])), [projects])

  /**
   * Which automations are busy, keyed by heading label — the page's identity for
   * one. A running or queued automation's play button is disabled with a note:
   * pressing it again would only coalesce into the pending run.
   */
  const busyByLabel = useMemo(() => {
    const map = new Map<string, 'running' | 'queued'>()
    // Procedure runs share the pool and now ride the wire too (they are
    // carded under the automations switch) — but they are not headings in
    // this file, so a label collision must not light up somebody else's row.
    for (const run of data?.runs.running ?? []) {
      if (run.kind !== 'procedure') map.set(run.label, 'running')
    }
    for (const run of data?.runs.queued ?? []) {
      if (run.kind !== 'procedure' && !map.has(run.label)) map.set(run.label, 'queued')
    }
    return map
  }, [data?.runs])

  /**
   * Card emoji: a project-bound automation wears its PROJECT's emoji; an unbound
   * one wears its own `icon:` marker, else the screen default.
   */
  const cardIcon = useCallback(
    (block: AutomationBlock): string =>
      (block.project ? projectsById.get(block.project)?.icon : undefined) ||
      block.icon ||
      DEFAULT_AUTOMATION_ICON,
    [projectsById]
  )

  /**
   * Every file edit funnels through here so one failure message covers them all
   * and every splice re-locates its block in the file as it stands right now —
   * the indices on a card were parsed from whatever the last read returned.
   */
  const applyEdit = useCallback(
    async (edit: (markdown: string) => string | null): Promise<boolean> => {
      try {
        const result = await editAutomations(edit)
        return result !== null
      } catch {
        toast.show({ tone: 'error', message: t('workspace.saveError') })
        return false
      }
    },
    [t, toast]
  )

  const relocate = useCallback(
    (block: AutomationBlock, apply: (md: string, fresh: AutomationBlock) => string) =>
      applyEdit((md) => {
        const fresh = findBlock(md, { label: block.label, active: block.active })
        // The automation is gone — edited away from the other screen while this
        // card sat here. Abandoning is right: there is nothing to act on, and
        // the push that removed it is already on its way to this list.
        if (!fresh) return null
        return apply(md, fresh)
      }),
    [applyEdit]
  )

  const handleToggle = useCallback(
    (block: AutomationBlock): void => {
      void relocate(block, (md, fresh) => toggleBlock(md, fresh))
    },
    [relocate]
  )

  const handleSetMode = useCallback(
    (block: AutomationBlock, mode: 'single' | 'workflow'): void => {
      if (block.mode === mode) return
      void relocate(block, (md, fresh) => setBlockMode(md, fresh, mode))
    },
    [relocate]
  )

  /**
   * The thinking switch rewrites the block's own `thinking:` marker through the
   * same relocate splice the mode toggle uses — the file is the store, so the
   * write lands on the desktop and both screens reload off one change.
   * `reasoning.current` is what a block with no marker runs at, so a press that
   * would change nothing is skipped.
   */
  const handleSetThinking = useCallback(
    (block: AutomationBlock, thinking: ReasoningMode): void => {
      if ((block.thinking ?? reasoning.current) === thinking) return
      void relocate(block, (md, fresh) => setBlockThinking(md, fresh, thinking))
    },
    [reasoning.current, relocate]
  )

  const handleDelete = useCallback((): void => {
    const target = deleteTarget
    if (!target || deleting) return
    setDeleting(true)
    void relocate(target, (md, fresh) => deleteBlock(md, fresh))
      .then((ok) => {
        setDeleteTarget(null)
        if (ok) toast.show({ tone: 'success', message: t('heartbeat.deleteSuccess') })
      })
      .finally(() => setDeleting(false))
  }, [deleteTarget, deleting, relocate, t, toast])

  const handleRun = useCallback(
    (block: AutomationBlock): void => {
      void runAutomation(block.label)
        .then((result) => {
          if (result.started) toast.show({ tone: 'success', message: t('heartbeat.runStarted') })
          else if (result.ok) toast.show({ tone: 'info', message: t('heartbeat.runQueued') })
          else toast.show({ tone: 'error', message: t('heartbeat.runError') })
        })
        .catch(() => toast.show({ tone: 'error', message: t('heartbeat.runError') }))
    },
    [t, toast]
  )

  /**
   * The meta line: the next run, then the last edit — and nothing else. The
   * desktop's card also names the bound project here, but on a phone's width
   * that third segment is what pushed the line onto two rows, and it says
   * nothing the card is not already saying: a bound automation wears its
   * project's emoji (see cardIcon). A switched-off automation says only that —
   * it never fires, so a next run would be a lie.
   */
  const metaLine = useCallback(
    (block: AutomationBlock): string => {
      // The desktop's own scheduler answers first (attachJobs). With nobody to
      // ask — demo mode, where the heartbeat comes from the config snapshot and
      // no scheduler is running anywhere — resolve the moment from the cron on
      // this device's clock, exactly as the editor's preview does below. That
      // is what keeps a bundled automation showing a live next fire instead of
      // a timestamp baked at build time, which would read as a run in the past.
      const nextRunMs = block.nextRunMs ?? (block.cron ? nextCronMs(block.cron, now) : null)
      const schedule = !block.active
        ? t('heartbeat.inactive')
        : block.type === 'startup'
          ? t('heartbeat.onLaunch')
          : nextRunMs != null
            ? `${t('heartbeat.nextRun', { time: formatSignedRelative(nextRunMs, now, t) })} · ${formatAbsoluteMoment(nextRunMs, locale)}`
            : t('heartbeat.active')
      const parts = [schedule]
      const edited = data?.stamps[block.label]
      if (edited != null) {
        parts.push(t('heartbeat.editedAt', { time: formatSignedRelative(edited, now, t) }))
      }
      return parts.join(' · ')
    },
    [data?.stamps, locale, now, t]
  )

  return (
    <>
      <View className="flex-row items-center justify-between gap-2">
        <View className="min-w-0 flex-1 flex-row items-center gap-2">
          <Text className="text-fg font-sans-semibold text-left text-base">
            {t('heartbeat.title')}
          </Text>
          {!isLoading && <Badge label={String(blocks.length)} />}
        </View>
        <Button
          size="sm"
          disabled={!writable}
          onPress={() => setCreating(true)}
          className="shrink-0"
        >
          <PlusSignIcon size={14} className="text-primary-fg" />
          {t('heartbeat.new')}
        </Button>
      </View>

      {isLoading ? (
        <Text className="text-muted py-10 text-center font-sans text-sm">
          {t('common.loading')}
        </Text>
      ) : blocks.length === 0 ? (
        <View className="border-border rounded-2xl border border-dashed px-6 py-12">
          <Text className="text-muted text-center font-sans text-sm">{t('heartbeat.empty')}</Text>
        </View>
      ) : (
        <View className="flex-col gap-3">
          {blocks.map((block) => {
            const busy = block.active ? busyByLabel.get(block.label) : undefined
            return (
              <View
                key={block.label}
                className={cn(
                  'bg-surface border-border flex-col gap-2.5 rounded-2xl border px-4 py-3',
                  !block.active && 'opacity-60'
                )}
              >
                <View className="flex-row items-start justify-between gap-3">
                  <View className="min-w-0 flex-1 flex-row items-center gap-2.5">
                    <Text className="text-2xl leading-7">{cardIcon(block)}</Text>
                    <View className="min-w-0 flex-1 flex-col gap-1">
                      {/* The heading is the schedule syntax — LTR technical
                          text, even in Arabic. */}
                      <Text
                        numberOfLines={1}
                        style={{ writingDirection: 'ltr' }}
                        className="text-fg font-sans-medium text-left text-sm"
                      >
                        {block.label}
                      </Text>
                      <View className="flex-row">
                        <Badge label={t(`heartbeat.type.${block.type}`)} variant="primary" />
                      </View>
                    </View>
                  </View>
                  <View className="shrink-0 flex-row items-center">
                    {block.active && (
                      <Pressable
                        accessibilityRole="button"
                        accessibilityLabel={t('heartbeat.run')}
                        hitSlop={6}
                        disabled={!!busy || !writable}
                        onPress={() => handleRun(block)}
                        className={cn(
                          'h-8 w-8 items-center justify-center rounded-lg',
                          busy || !writable ? 'opacity-40' : 'active:bg-border-soft'
                        )}
                      >
                        <PlayIcon size={17} className="text-muted" />
                      </Pressable>
                    )}
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel={t('heartbeat.edit')}
                      hitSlop={6}
                      onPress={() => setEditorFor(block)}
                      className="h-8 w-8 items-center justify-center rounded-lg active:bg-border-soft"
                    >
                      <Edit02Icon size={15} className="text-muted" />
                    </Pressable>
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel={t('heartbeat.delete')}
                      hitSlop={6}
                      disabled={!writable}
                      onPress={() => setDeleteTarget(block)}
                      className={cn(
                        'h-8 w-8 items-center justify-center rounded-lg',
                        writable ? 'active:bg-border-soft' : 'opacity-40'
                      )}
                    >
                      <Delete02Icon size={15} className="text-muted" />
                    </Pressable>
                  </View>
                </View>

                {/* On/off and the run mode, the desktop's two segmented pills.
                    End-aligned above the schedule line: they are settings for
                    this automation, so they sit with the action cluster's edge
                    rather than starting a new column under the emoji. RN mirrors
                    `justify-end` with the writing direction, so this is the right
                    edge in English and the left one in Arabic. */}
                <View className="flex-row flex-wrap items-center justify-end gap-2">
                  <OnOffPills
                    active={block.active}
                    disabled={!writable}
                    onChange={() => handleToggle(block)}
                  />
                  <ModePills
                    value={block.mode ?? globalMode}
                    disabled={!writable}
                    onChange={(mode) => handleSetMode(block, mode)}
                  />
                </View>

                {/* The reasoning switch, on its own line under the pills above
                    — the phone's width cannot hold three controls in that row,
                    and the desktop keeps these as two edge-aligned groups too.
                    It edits the block's own `thinking:` marker, so this
                    automation runs at it whatever the composer is set to. */}
                <ThinkingPills
                  modes={reasoning.modes}
                  value={block.thinking ?? reasoning.current}
                  disabled={!writable}
                  onChange={(thinking) => handleSetThinking(block, thinking)}
                />

                <Text className="text-muted text-left font-sans text-xs">{metaLine(block)}</Text>

                {busy && (
                  <View className="flex-row items-center gap-1.5">
                    <InformationCircleIcon
                      size={13}
                      className={busy === 'running' ? 'text-emerald-500' : 'text-amber-500'}
                    />
                    <Text
                      numberOfLines={1}
                      className={cn(
                        'flex-1 text-left font-sans text-xs',
                        busy === 'running' ? 'text-emerald-500' : 'text-amber-500'
                      )}
                    >
                      {t(busy === 'running' ? 'heartbeat.noteRunning' : 'heartbeat.noteQueued')}
                    </Text>
                  </View>
                )}

                <PromptPreview value={block.body} empty={t('heartbeat.promptEmpty')} />

                {/* What this automation carries into every run. Shown on the
                    card rather than tucked in the editor: the paths are the
                    part of an automation you cannot infer from its prompt, and
                    the phone's only job here is to let you see them and take
                    one away. */}
                {/* An automation stores absolute paths, so the file chips take
                    the basename — every other surface already holds a name. */}
                <AttachmentChips
                  files={block.files.map((file) => baseName(file))}
                  directories={block.dirs}
                />
              </View>
            )
          })}
        </View>
      )}

      {(editorFor !== null || creating) && (
        <AutomationEditor
          block={editorFor}
          blocks={blocks}
          projects={projects}
          readOnly={!writable}
          onClose={() => {
            setEditorFor(null)
            setCreating(false)
          }}
        />
      )}

      <ConfirmDialog
        open={deleteTarget !== null}
        title={t('heartbeat.deleteTitle')}
        message={t('heartbeat.deleteWarning', { name: deleteTarget?.label ?? '' })}
        confirmLabel={t('heartbeat.deleteConfirm')}
        cancelLabel={t('heartbeat.deleteCancel')}
        busy={deleting}
        onConfirm={handleDelete}
        onCancel={() => setDeleteTarget(null)}
      />
    </>
  )
}

/** Last path segment, for either separator — these are absolute desktop paths. */
function baseName(filePath: string): string {
  const parts = filePath.split(/[\\/]/).filter(Boolean)
  return parts[parts.length - 1] ?? filePath
}

/** On | Off, the desktop's first pill. Either segment switches the automation. */
function OnOffPills({
  active,
  disabled,
  onChange
}: {
  active: boolean
  disabled?: boolean
  onChange: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <View
      accessibilityRole="tablist"
      className={cn(
        'border-border bg-bg flex-row items-center self-start rounded-lg border p-0.5',
        disabled && 'opacity-60'
      )}
    >
      {[true, false].map((on) => {
        const selected = on === active
        return (
          <Pressable
            key={String(on)}
            accessibilityRole="tab"
            accessibilityState={{ selected }}
            disabled={disabled || selected}
            onPress={onChange}
            className={cn('rounded-md px-2 py-1', selected && 'bg-primary')}
          >
            <Text
              className={cn(
                'font-sans-medium text-[10px]',
                selected ? 'text-primary-fg' : 'text-muted'
              )}
            >
              {t(on ? 'settings.toggle.on' : 'settings.toggle.off')}
            </Text>
          </Pressable>
        )
      })}
    </View>
  )
}

const NO_PROJECT = ''

/** One tick of the add-files batch — the desktop's AttachFilesProgress. */
type CopyProgress = { index: number; total: number; name: string; sent: number; totalBytes: number }

/**
 * The automation editor — schedule, emoji, project and prompt.
 *
 * Autosaves ~600 ms after the last change, but ONLY while the draft is actually
 * saveable: schedule recognized, no label collision, prompt present. An invalid
 * draft is never written, so closing keeps the last saved state. The desktop's
 * exact contract, including the label-collision guard — the heading IS the
 * automation's identity, and a second one with the same heading would collide in
 * the scheduler.
 */
function AutomationEditor({
  block,
  blocks,
  projects,
  readOnly,
  onClose
}: {
  /** Null ⇒ creating. */
  block: AutomationBlock | null
  blocks: AutomationBlock[]
  projects: Array<{ id: string; title: string; icon: string }>
  /** No desktop to write to — every control is inert. */
  readOnly: boolean
  onClose: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const { locale } = useLocale()
  // Reported inline rather than as a toast — see DialogError.
  const [error, setError] = useState<string | null>(null)
  // The guide stacks ON this dialog, so it must live INSIDE it: a native modal
  // rendered as the screen's child cannot present while this one is up — iOS
  // silently refuses, and the help button would do nothing.
  const [guideOpen, setGuideOpen] = useState(false)

  const [schedule, setSchedule] = useState(block?.label ?? chipSchedule('daily'))
  // The "how many times" pills multiply the period chips: picking "3 times"
  // then "Every day" (or the other way round) fills a three-time Daily. Both
  // rows light from the heading in the field (chipStateOf), so an edited or
  // hand-typed schedule shows its own period and count. The count state only
  // carries a pick made while no period chip describes the field yet.
  const chipState = useMemo(() => chipStateOf(schedule.trim()), [schedule])
  const [pendingTimes, setPendingTimes] = useState<ChipTimes>(1)
  const litTimes: ChipTimes | null = chipState ? chipState.times : pendingTimes
  const applyChip = (kind: ChipKind, times: ChipTimes): void => {
    setSchedule(chipSchedule(kind, Date.now(), times))
  }
  const applyTimes = (times: ChipTimes): void => {
    setPendingTimes(times)
    if (chipState) applyChip(chipState.kind, times)
  }
  const [prompt, setPrompt] = useState(block?.body ?? '')
  const [icon, setIcon] = useState(block?.icon ?? '')
  const [projectId, setProjectId] = useState(block?.project ?? NO_PROJECT)
  const [emojiOpen, setEmojiOpen] = useState(false)
  const [promptOpen, setPromptOpen] = useState(false)
  // Files and folders are NOT part of the debounced draft: each add or remove
  // is its own splice of heartbeat.md, because an add already moved bytes
  // across the tunnel and a remove already dropped the desktop's copy.
  const [files, setFiles] = useState<string[]>(block?.files ?? [])
  const [dirs, setDirs] = useState<string[]>(block?.dirs ?? [])
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

  /**
   * The persisted block's identity. It MOVES as the label is edited across
   * autosaves, which is what lets the next save find the block the previous one
   * wrote instead of inserting a second copy.
   */
  const boundRef = useRef<BoundBlock | null>(
    block ? { label: block.label, active: block.active } : null
  )
  const [boundLabel, setBoundLabel] = useState<string | null>(block?.label ?? null)
  const savedRef = useRef({
    schedule: block?.label ?? '',
    prompt: block?.body ?? '',
    icon: block?.icon ?? '',
    projectId: block?.project ?? NO_PROJECT
  })

  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30_000)
    return () => clearInterval(id)
  }, [])

  const trimmed = schedule.trim()
  const parsed = useMemo(() => parseSchedule(trimmed), [trimmed])
  const duplicate =
    trimmed !== '' &&
    blocks.some(
      (b) =>
        b.label.toLowerCase() === trimmed.toLowerCase() &&
        b.label.toLowerCase() !== (boundLabel?.toLowerCase() ?? '')
    )
  const invalid = parsed === null || duplicate

  /**
   * Errors paint late, validity paints now. Mid-edit keystrokes pass through
   * invalid states ("Daily (09:3" on the way to "Daily (09:30)") and turning the
   * field red for each one reads as flicker, so the red state waits out a typing
   * pause. Display only — the autosave gate below reads the raw validity.
   */
  const [heldInvalid, setHeldInvalid] = useState(false)
  useEffect(() => {
    if (!invalid) {
      setHeldInvalid(false)
      return
    }
    const handle = setTimeout(() => setHeldInvalid(true), 600)
    return () => clearTimeout(handle)
  }, [invalid, trimmed])
  const showError = invalid && heldInvalid

  // While the error is held back, the preview keeps the last parseable draft —
  // swapping to blank and back would be its own flash.
  const [lastParsed, setLastParsed] = useState(parsed)
  useEffect(() => {
    if (parsed) setLastParsed(parsed)
  }, [parsed])
  const preview = parsed ?? lastParsed
  const previewMs = preview
    ? (preview.atMs ?? (preview.cron ? nextCronMs(preview.cron, now) : null))
    : null

  const boundProject = projectId ? projects.find((p) => p.id === projectId) : undefined

  const persist = useCallback(
    (draft: { schedule: string; prompt: string; icon: string; projectId: string }): void => {
      savedRef.current = draft
      const bound = boundRef.current
      // The binding must move in the SAME tick the write is dispatched: the
      // duplicate check excludes the draft's own block only through boundLabel,
      // and updating it after the await paints a spurious "duplicate" while the
      // write is in flight.
      boundRef.current = { label: draft.schedule, active: bound?.active ?? true }
      setBoundLabel(draft.schedule)
      setError(null)
      void editAutomations((markdown) => {
        const result = writeDraft(markdown, bound, draft)
        boundRef.current = result.bound
        return result.markdown
      }).catch(() => setError(t('workspace.saveError')))
    },
    [t]
  )

  useEffect(() => {
    if (invalid || prompt.trim() === '') return
    const saved = savedRef.current
    if (
      trimmed === saved.schedule &&
      prompt === saved.prompt &&
      icon === saved.icon &&
      projectId === saved.projectId
    ) {
      return
    }
    const handle = setTimeout(() => persist({ schedule: trimmed, prompt, icon, projectId }), 600)
    return () => clearTimeout(handle)
  }, [invalid, trimmed, prompt, icon, projectId, persist])

  const close = useCallback((): void => {
    // Flush whatever the debounce has not dispatched.
    const saved = savedRef.current
    if (
      !invalid &&
      prompt.trim() !== '' &&
      (trimmed !== saved.schedule ||
        prompt !== saved.prompt ||
        icon !== saved.icon ||
        projectId !== saved.projectId)
    ) {
      persist({ schedule: trimmed, prompt, icon, projectId })
    }
    onClose()
  }, [invalid, trimmed, prompt, icon, projectId, persist, onClose])

  /**
   * Splice one marker into (or out of) THIS automation's block.
   *
   * Every attachment edit goes through here so it re-locates the block in the
   * file as it stands right now — the indices this editor opened with went
   * stale the moment the first autosave rewrote the block. `bound` is null
   * only for an automation that has never been written, which is why the
   * buttons below are gated on it.
   */
  const spliceMarker = useCallback(
    async (apply: (md: string, fresh: AutomationBlock) => string): Promise<boolean> => {
      const bound = boundRef.current
      if (!bound) return false
      setError(null)
      try {
        const result = await editAutomations((md) => {
          const fresh = findBlock(md, bound)
          if (!fresh) return null
          return apply(md, fresh)
        })
        return result !== null
      } catch {
        setError(t('workspace.saveError'))
        return false
      }
    },
    [t]
  )

  /**
   * Pick, validate, upload — the project dialog's contract exactly. Validation
   * is per file rather than per batch (a good file in a bad batch still
   * attaches, and every refusal names the rule it broke) and uploads run
   * sequentially, since each is a run of ordered chunk RPCs on one socket.
   *
   * The desktop answers with the ABSOLUTE path it chose; writing that as a
   * `file:` marker is this side's half, and it happens per file so a batch that
   * fails halfway still keeps what already landed.
   */
  const addFiles = useCallback(
    (source: 'media' | 'files'): void => {
      if (adding || readOnly || !boundLabel) return
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
          let known = files
          const failed: string[] = []
          for (const [index, file] of accepted.entries()) {
            try {
              const stored = await uploadAutomationFile(
                known,
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
              // `known` must grow as we go: it is what tells the desktop which
              // folder this automation owns, so the second file of a batch has
              // to see the first one's path or it would mint a second folder.
              known = [...known, stored.path]
              setFiles(known)
              await spliceMarker((md, fresh) => addBlockPath(md, fresh, 'file', stored.path))
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
    [adding, readOnly, boundLabel, files, spliceMarker, t]
  )

  const removeFile = useCallback(
    (value: string): void => {
      setFiles((current) => current.filter((f) => f !== value))
      void spliceMarker((md, fresh) => removeBlockPath(md, fresh, 'file', value))
    },
    [spliceMarker]
  )

  /**
   * Add a working folder by naming it. A phone cannot browse the desktop's
   * filesystem, so the path is typed — and the DESKTOP is what validates it,
   * answering with the resolved absolute path or rejecting with the reason. A
   * working folder the run cannot list would be worse than no folder at all.
   */
  const addFolder = useCallback((): void => {
    const value = folderDraft.trim()
    if (!value || addingFolder || readOnly || !boundLabel) return
    setAddingFolder(true)
    setError(null)
    void resolveDirectory(value)
      .then(async (resolved) => {
        if (dirs.includes(resolved)) {
          setFolderDraft('')
          return
        }
        const ok = await spliceMarker((md, fresh) => addBlockPath(md, fresh, 'dir', resolved))
        if (ok) {
          setDirs((current) => [...current, resolved])
          setFolderDraft('')
        }
      })
      .catch((err: unknown) =>
        setError(err instanceof Error ? err.message : t('workspace.saveError'))
      )
      .finally(() => setAddingFolder(false))
  }, [folderDraft, addingFolder, readOnly, boundLabel, dirs, spliceMarker, t])

  const removeFolder = useCallback(
    (value: string): void => {
      setDirs((current) => current.filter((d) => d !== value))
      void spliceMarker((md, fresh) => removeBlockPath(md, fresh, 'dir', value))
    },
    [spliceMarker]
  )

  const attachLocked = readOnly || adding || !boundLabel

  return (
    <Modal
      open
      onClose={close}
      // Escape/backdrop must only close whatever is stacked on top.
      dismissable={!emojiOpen && !promptOpen && !guideOpen && !attachOpen && !adding}
      title={block ? t('heartbeat.editor.editTitle') : t('heartbeat.editor.createTitle')}
      footer={
        <View className="flex-row justify-end">
          <Button size="sm" onPress={close}>
            {t('heartbeat.editor.done')}
          </Button>
        </View>
      }
    >
      <View className="flex-row items-center justify-between gap-2">
        <Text className="text-muted font-sans-medium text-left text-sm">
          {t('heartbeat.editor.schedule')}
        </Text>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t('heartbeat.editor.guideButton')}
          hitSlop={6}
          onPress={() => setGuideOpen(true)}
          className="h-7 w-7 items-center justify-center rounded-md active:bg-border-soft"
        >
          <HelpCircleIcon size={15} className="text-muted" />
        </Pressable>
      </View>

      {/* Two rows that read as one sentence: "3 times" · "Every day". The
          count pills hold a selection (lit); the period chips fill in a
          correct schedule anchored on now, so the preview line below
          immediately confirms the pick. */}
      <View
        accessibilityRole="radiogroup"
        accessibilityLabel={t('heartbeat.editor.timesAria')}
        className="flex-row flex-wrap gap-1.5"
      >
        {CHIP_TIMES.map((times) => {
          const active = times === litTimes
          return (
            <Pressable
              key={times}
              accessibilityRole="radio"
              accessibilityState={{ checked: active }}
              onPress={() => applyTimes(times)}
              className={cn(
                'rounded-full border px-2.5 py-1',
                active ? 'bg-primary border-primary' : 'border-border bg-bg active:bg-border-soft'
              )}
            >
              <Text className={cn('font-sans text-xs', active ? 'text-primary-fg' : 'text-muted')}>
                {t(`heartbeat.editor.times.${times}`)}
              </Text>
            </Pressable>
          )
        })}
      </View>
      <View
        accessibilityRole="radiogroup"
        accessibilityLabel={t('heartbeat.editor.schedule')}
        className="flex-row flex-wrap gap-1.5"
      >
        {CHIP_KINDS.map((kind) => {
          const active = chipState?.kind === kind
          return (
            <Pressable
              key={kind}
              accessibilityRole="radio"
              accessibilityState={{ checked: active }}
              onPress={() => applyChip(kind, litTimes ?? pendingTimes)}
              className={cn(
                'rounded-full border px-2.5 py-1',
                active ? 'bg-primary border-primary' : 'border-border bg-bg active:bg-border-soft'
              )}
            >
              <Text className={cn('font-sans text-xs', active ? 'text-primary-fg' : 'text-muted')}>
                {t(`heartbeat.editor.chips.${kind}`)}
              </Text>
            </Pressable>
          )
        })}
      </View>

      <View className="flex-row items-start gap-2">
        {/* A project-bound automation wears the project's emoji — the button
            shows it and disables; its own icon returns when the binding goes. */}
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={
            boundProject ? t('heartbeat.editor.projectIcon') : t('heartbeat.editor.pickIcon')
          }
          disabled={boundProject !== undefined}
          onPress={() => setEmojiOpen(true)}
          className="bg-bg border-border h-10 w-10 shrink-0 items-center justify-center rounded-lg border active:bg-border-soft"
        >
          <Text className="text-lg">
            {boundProject
              ? boundProject.icon || DEFAULT_PROJECT_ICON
              : icon || DEFAULT_AUTOMATION_ICON}
          </Text>
        </Pressable>
        <View className="min-w-0 flex-1">
          <Input
            value={schedule}
            onChangeText={setSchedule}
            placeholder="Daily (09:00)"
            autoCapitalize="words"
            autoCorrect={false}
            // The schedule is the file's own syntax: LTR and monospaced in
            // either locale, like every other technical value in the app.
            style={{ writingDirection: 'ltr' }}
            className={cn('font-mono', showError && 'border-rose-500/70')}
          />
        </View>
      </View>

      {showError || preview === null ? (
        parsed === null ? (
          <Pressable accessibilityRole="button" onPress={() => setGuideOpen(true)}>
            <Text className="text-left font-sans text-xs text-rose-500">
              {`${t('heartbeat.editor.invalid')} ${t('heartbeat.editor.guideButton')}`}
            </Text>
          </Pressable>
        ) : (
          <Text className="text-left font-sans text-xs text-rose-500">
            {t('heartbeat.editor.duplicate')}
          </Text>
        )
      ) : preview.type === 'startup' ? (
        <Text className="text-muted text-left font-sans text-xs">{t('heartbeat.onLaunch')}</Text>
      ) : preview.atMs != null && preview.atMs <= now ? (
        <Text className="text-left font-sans text-xs text-amber-500">
          {t('heartbeat.editor.pastOnce')}
        </Text>
      ) : previewMs != null ? (
        <Text className="text-muted text-left font-sans text-xs">
          {`${t('heartbeat.nextRun', { time: formatSignedRelative(previewMs, now, t) })} · ${formatAbsoluteMoment(previewMs, locale)}`}
        </Text>
      ) : (
        <Text className="text-left font-sans text-xs text-amber-500">
          {t('heartbeat.editor.cronUnknown')}
        </Text>
      )}

      <ProjectChipRow
        label={t('heartbeat.editor.project')}
        noneLabel={t('heartbeat.editor.projectNone')}
        projects={projects}
        value={projectId}
        disabled={readOnly}
        onChange={(value) => {
          setProjectId(value)
          setEmojiOpen(false)
        }}
      />

      <View className="flex-col gap-1.5">
        <Text className="text-muted font-sans-medium text-left text-sm">
          {t('heartbeat.editor.prompt')}
        </Text>
        <PromptPreview
          value={prompt}
          empty={t('heartbeat.promptEmpty')}
          maxHeight={140}
          onPress={() => setPromptOpen(true)}
        />
        <Button variant="outline" size="sm" onPress={() => setPromptOpen(true)}>
          {prompt.trim() ? t('procedures.editPrompt') : t('procedures.addPrompt')}
        </Button>
      </View>

      {/* Files: uploaded to the DESKTOP, which owns the workspace and the name.
          Every run is told what it has and where, and reads with its own tools
          — the bytes are never pasted into the prompt. The whole section waits
          for the automation to exist: its markers live in a block, and a block
          that has never been written has nowhere to put them. */}
      <View className="flex-row items-center justify-between gap-2">
        <Text className="text-muted font-sans-medium text-left text-sm">
          {t('heartbeat.files', { count: files.length })}
        </Text>
        <Button
          variant="outline"
          size="sm"
          disabled={attachLocked}
          onPress={() => setAttachOpen(true)}
          className="flex-row items-center gap-1"
        >
          <PlusSignIcon size={13} className="text-fg" />
          {t('heartbeat.addFiles')}
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
            <View key={file} className="h-9 flex-row items-center gap-2 rounded-md px-1.5">
              {/* The NAME only — the path is on the desktop and nothing here can
                  open it. writingDirection ltr pins filename order in RTL. */}
              <Text
                numberOfLines={1}
                style={{ writingDirection: 'ltr' }}
                className="text-fg min-w-0 flex-1 text-left font-sans text-xs"
              >
                {baseName(file)}
              </Text>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={t('heartbeat.removeFile')}
                disabled={attachLocked}
                hitSlop={6}
                onPress={() => removeFile(file)}
                className={cn(
                  'h-7 w-7 shrink-0 items-center justify-center rounded-md',
                  attachLocked ? 'opacity-40' : 'active:bg-border-soft'
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
        {t('heartbeat.folders', { count: dirs.length })}
      </Text>
      {!readOnly && (
        <View className="flex-row items-end gap-2">
          <View className="min-w-0 flex-1">
            <Input
              value={folderDraft}
              editable={!addingFolder && !!boundLabel}
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
          {/* size md, not sm: this one sits BESIDE the field, and the field is
              h-10 — an h-8 button next to it reads as misaligned. */}
          <Button
            variant="outline"
            size="md"
            disabled={addingFolder || !boundLabel || folderDraft.trim() === ''}
            onPress={addFolder}
            className="shrink-0 flex-row items-center gap-1"
          >
            <PlusSignIcon size={13} className="text-fg" />
            {t('heartbeat.addFolder')}
          </Button>
        </View>
      )}
      {dirs.length > 0 && (
        <View className="border-border bg-bg flex-col gap-1.5 rounded-lg border p-1.5">
          {dirs.map((dir) => (
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
                accessibilityLabel={t('heartbeat.removeFolder')}
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
      {!boundLabel && (
        <Text className="text-muted text-left font-sans text-xs">
          {t('heartbeat.attachAfterSave')}
        </Text>
      )}

      <DialogError message={error} />
      <Text className="text-muted text-left font-sans text-xs">
        {t('heartbeat.editor.autosaveHint')}
      </Text>

      <EmojiPicker
        open={emojiOpen}
        onClose={() => setEmojiOpen(false)}
        onPick={(emoji) => {
          setIcon(emoji)
          setEmojiOpen(false)
        }}
      />
      <PromptSheet
        open={promptOpen}
        title={t('heartbeat.editor.prompt')}
        initialValue={prompt}
        placeholder={t('heartbeat.editor.promptPlaceholder')}
        onDone={(value) => {
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
      <ScheduleGuide open={guideOpen} onClose={() => setGuideOpen(false)} />
    </Modal>
  )
}

/** The schedule forms, verbatim from the desktop's guide dialog. */
function ScheduleGuide({
  open,
  onClose
}: {
  open: boolean
  onClose: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const { height } = useWindowDimensions()
  return (
    <Modal open={open} onClose={onClose} title={t('heartbeat.guide.title')}>
      <Text className="text-muted text-left font-sans text-sm leading-relaxed">
        {t('heartbeat.guide.intro')}
      </Text>
      <ScrollView
        style={{ maxHeight: Math.round(height * 0.45) }}
        contentContainerStyle={{ gap: 10 }}
        showsVerticalScrollIndicator={false}
      >
        {GUIDE_ROWS.map((row) => (
          <View key={row.key} className="flex-col gap-1">
            <View className="bg-bg border-border rounded-lg border px-2.5 py-1.5">
              <Text
                selectable
                style={{ writingDirection: 'ltr' }}
                className="text-fg text-left font-mono text-xs"
              >
                {row.code}
              </Text>
            </View>
            <Text className="text-muted px-0.5 text-left font-sans text-xs leading-relaxed">
              {t(`heartbeat.guide.${row.key}`)}
            </Text>
          </View>
        ))}
      </ScrollView>
      <Text className="text-muted text-left font-sans text-xs leading-relaxed">
        {t('heartbeat.guide.localTime')}
      </Text>
      <Text className="text-muted text-left font-sans text-xs leading-relaxed">
        {t('heartbeat.guide.chipsTip')}
      </Text>
    </Modal>
  )
}
