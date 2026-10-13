import { Badge } from '@/components/core/Badge'
import { Button } from '@/components/core/Button'
import { ConfirmDialog } from '@/components/core/ConfirmDialog'
import { Delete02Icon, Edit02Icon, PlusSignIcon } from '@/components/core/icons'
import { AttachmentChips } from '@/components/workspace/AttachmentChips'
import { DEFAULT_PROJECT_ICON, ProjectDialog } from '@/components/workspace/ProjectDialog'
import { PromptPreview } from '@/components/workspace/PromptSheet'
import { useConversationList } from '@/lib/conversations/hooks'
import {
  createProject,
  deleteProject,
  updateProject,
  useProjects,
  useProjectsWritable
} from '@/lib/sync/projects'
import { useChatReasoning } from '@/lib/sync/useChatReasoning'
import { useFreshConfig } from '@/lib/sync/useFreshConfig'
import { ThinkingPills } from '@/components/workspace/ThinkingPills'
import type { ReasoningMode, SyncProject } from '@/lib/tunnel/protocol'
import { formatSignedRelative } from '@/lib/utils/relativeTime'
import { cn } from '@/lib/utils/cn'
import { useToast } from '@/providers/toast/useToast'
import { useChatRuntime } from '@/state/chatRuntime'
import { router, useFocusEffect } from 'expo-router'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Pressable, Text, View } from 'react-native'

/**
 * Projects — one tab of the Library screen, which owns the chrome around it
 * (back button, tab strip, subtitle); this is the desktop's Projects page on
 * one column.
 *
 * A project is instructions plus a file list that fresh conversations start
 * from, so the card's primary action is the same as the desktop's: TAP THE CARD
 * to enter the project, which activates it and drops into a new chat inside it.
 * Edit, delete and the conversation count sit on the card exactly as they do
 * there, and the instructions preview is the same recessed mono block.
 */
export function ProjectsTab(): React.JSX.Element {
  const { t } = useTranslation()
  const toast = useToast()
  // Projects also ride the config snapshot (the chat picker reads them there),
  // and this screen falls back to it when unpaired — so refresh it on focus
  // like every other screen rendering desktop-owned values.
  useFreshConfig()
  const { data: projects = [], isLoading, refetch } = useProjects()
  const writable = useProjectsWritable()
  // The chat's reasoning contract: the modes the selected model honours, and
  // the mode chat is showing right now — what a project without a stamp runs.
  const reasoning = useChatReasoning()
  const setActiveProject = useChatRuntime((state) => state.setActiveProject)

  const [editing, setEditing] = useState<SyncProject | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<SyncProject | null>(null)

  // The desktop is edited too and this phone sleeps for most of the day, so the
  // list is re-read whenever the screen comes into focus — the same contract
  // useFreshConfig gives the settings screens. Pushes keep it live after that.
  useFocusEffect(
    useCallback(() => {
      void refetch()
    }, [refetch])
  )

  // "Edited …" labels stay fresh without reloading the list.
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30_000)
    return () => clearInterval(id)
  }, [])

  /**
   * Per-project conversation counts and last-use, from the conversation index
   * this device already holds. "Last used" beats "last edited" as the recency
   * signal — using a project IS its life sign — which is why the desktop card
   * shows both.
   */
  const { data: conversations = [] } = useConversationList()
  const convStats = useMemo(() => {
    const stats = new Map<string, { count: number; lastUsed: number }>()
    for (const meta of conversations) {
      if (!meta.projectId) continue
      const prev = stats.get(meta.projectId)
      stats.set(meta.projectId, {
        count: (prev?.count ?? 0) + 1,
        lastUsed: Math.max(prev?.lastUsed ?? 0, meta.updatedAt)
      })
    }
    return stats
  }, [conversations])

  const handleCreate = useCallback((): void => {
    // Created blank and opened for editing, exactly as on the desktop: a
    // create-then-abandon is discarded on close (see closeEditor), so an
    // untitled stub never survives as an orphan card.
    void createProject({ title: '' })
      .then(setEditing)
      .catch(() => toast.show({ tone: 'error', message: t('projects.saveError') }))
  }, [t, toast])

  const closeEditor = useCallback((): void => {
    const current = editing
    setEditing(null)
    if (current && current.title.trim() === '') {
      // Re-read from the list rather than trusting the stub we opened with: the
      // dialog autosaves, so a project that HAS been named by now is in the
      // list under its name and must not be deleted.
      const stored = projects.find((row) => row.id === current.id)
      if (!stored || stored.title.trim() === '') {
        void deleteProject(current.id).catch(() => undefined)
      }
    }
  }, [editing, projects])

  /**
   * The thinking switch writes the project's own reasoning effort — the same
   * stamp the composer's thinking control reads while the project is active,
   * so the two can never disagree. One per-field merge to the desktop; the
   * stored row lands in the cache. A no-op press is skipped.
   */
  const setThinking = useCallback(
    (project: SyncProject, thinking: ReasoningMode): void => {
      const effective = project.thinking ?? reasoning.current
      if (effective === thinking) return
      void updateProject({ id: project.id, thinking }).catch(() =>
        toast.show({ tone: 'error', message: t('projects.saveError') })
      )
    },
    [reasoning.current, t, toast]
  )

  const handleChanged = useCallback((updated: SyncProject): void => {
    // Only the open dialog's own copy. Project mode needs nothing here — it
    // holds an id and reads the row from the list, which the write has already
    // updated (see useActiveProject).
    setEditing((prev) => (prev && prev.id === updated.id ? updated : prev))
  }, [])

  const handleDelete = useCallback((): void => {
    const target = deleteTarget
    if (!target) return
    void deleteProject(target.id)
      .then(() => {
        setDeleteTarget(null)
        // A deleted project cannot stay active — chat would render its chrome
        // while turns ran with an empty overlay.
        if (useChatRuntime.getState().activeProjectId === target.id) setActiveProject(null)
        toast.show({ tone: 'success', message: t('projects.deleteSuccess') })
      })
      .catch(() => toast.show({ tone: 'error', message: t('projects.saveError') }))
  }, [deleteTarget, setActiveProject, t, toast])

  /**
   * Enter the project: activate it and land in a fresh chat inside it — the
   * desktop's own card action. No conversation id, so the first send mints one
   * under this project (see chatRuntime.activeProjectId and lib/sync/prompt.ts).
   *
   * `dismissTo`, not `push`: chat is already underneath this settings stack, and
   * pushing a second copy would leave the back gesture walking through two of
   * them. Popping back to the existing screen also keeps the conversation the
   * user was in — entering a project starts a NEW chat there, which the screen
   * does itself when it sees an active project with no conversation open.
   * `replace` is the fallback for a navigator that refuses to pop.
   */
  const enterProject = useCallback(
    (project: SyncProject): void => {
      setActiveProject(project)
      try {
        router.dismissTo('/chat')
      } catch {
        router.replace('/chat')
      }
    },
    [setActiveProject]
  )

  return (
    <>
      <View className="flex-row items-center justify-between gap-3">
        <View className="flex-row items-center gap-2">
          <Text className="text-fg font-sans-semibold text-left text-base">
            {t('projects.title')}
          </Text>
          {!isLoading && <Badge label={String(projects.length)} />}
        </View>
        <Button size="sm" disabled={!writable} onPress={handleCreate} className="shrink-0">
          <PlusSignIcon size={14} className="text-primary-fg" />
          {t('projects.new')}
        </Button>
      </View>

      {isLoading ? (
        <Text className="text-muted py-10 text-center font-sans text-sm">
          {t('common.loading')}
        </Text>
      ) : projects.length === 0 ? (
        <View className="border-border rounded-2xl border border-dashed px-6 py-12">
          <Text className="text-muted text-center font-sans text-sm">{t('projects.empty')}</Text>
        </View>
      ) : (
        <View className="flex-col gap-3">
          {projects.map((project) => {
            const name = project.title.trim() || t('projects.untitled')
            const stats = convStats.get(project.id)
            return (
              <Pressable
                key={project.id}
                accessibilityRole="button"
                accessibilityLabel={name}
                onPress={() => enterProject(project)}
                className={cn(
                  'bg-surface border-border flex-col gap-2.5 rounded-2xl border px-4 py-3',
                  'active:bg-border-soft'
                )}
              >
                <View className="flex-row items-start justify-between gap-2">
                  <View className="min-w-0 flex-1 flex-row items-center gap-2.5">
                    <Text className="text-2xl leading-7">
                      {project.icon || DEFAULT_PROJECT_ICON}
                    </Text>
                    <View className="min-w-0 flex-1 flex-col gap-0.5">
                      <Text
                        numberOfLines={1}
                        className="text-fg font-sans-medium text-left text-sm"
                      >
                        {name}
                      </Text>
                      <Text numberOfLines={2} className="text-muted text-left font-sans text-xs">
                        {[
                          t('projects.editedAt', {
                            time: formatSignedRelative(project.updatedAt, now, t)
                          }),
                          ...(stats
                            ? [
                                t('projects.usedAt', {
                                  time: formatSignedRelative(stats.lastUsed, now, t)
                                })
                              ]
                            : []),
                          t('projects.conversationCount', { count: stats?.count ?? 0 }),
                          t('projects.fileCount', { count: project.files.length })
                        ].join(' · ')}
                      </Text>
                    </View>
                  </View>
                  <View className="shrink-0 flex-row items-center">
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel={t('projects.edit')}
                      hitSlop={6}
                      onPress={() => setEditing(project)}
                      className="h-8 w-8 items-center justify-center rounded-lg active:bg-border-soft"
                    >
                      <Edit02Icon size={15} className="text-muted" />
                    </Pressable>
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel={t('projects.delete')}
                      hitSlop={6}
                      disabled={!writable}
                      onPress={() => setDeleteTarget(project)}
                      className={cn(
                        'h-8 w-8 items-center justify-center rounded-lg',
                        writable ? 'active:bg-border-soft' : 'opacity-40'
                      )}
                    >
                      <Delete02Icon size={15} className="text-muted" />
                    </Pressable>
                  </View>
                </View>
                <PromptPreview value={project.instructions} empty={t('projects.noInstructions')} />
                {/* The reasoning switch under the row's action cluster — the
                    phone's width has no room for a third icon up top. It edits
                    the project's own stamp, which every turn inside it runs at,
                    and which the composer's thinking control also reads while
                    this project is active. */}
                <ThinkingPills
                  modes={reasoning.modes}
                  value={project.thinking ?? reasoning.current}
                  disabled={!writable}
                  onChange={(thinking) => setThinking(project, thinking)}
                />
                {/* What this project carries into every conversation inside it.
                    On the card, not just in the dialog: the paths are the part
                    of a project you cannot infer from its instructions. */}
                <AttachmentChips
                  files={project.files.map((file) => file.name)}
                  directories={project.directories}
                />
              </Pressable>
            )
          })}
        </View>
      )}

      <ProjectDialog
        project={editing}
        onClose={closeEditor}
        onChanged={handleChanged}
        readOnly={!writable}
      />

      <ConfirmDialog
        open={deleteTarget !== null}
        title={t('projects.deleteTitle')}
        message={t('projects.deleteWarning', {
          name: deleteTarget?.title.trim() || t('projects.untitled')
        })}
        confirmLabel={t('projects.deleteConfirm')}
        cancelLabel={t('projects.deleteCancel')}
        onConfirm={handleDelete}
        onCancel={() => setDeleteTarget(null)}
      />
    </>
  )
}
