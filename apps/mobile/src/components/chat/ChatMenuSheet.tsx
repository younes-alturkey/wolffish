import { Modal } from '@/components/core/Modal'
import type { ConversationFile } from '@/lib/conversations/types'
import { cn } from '@/lib/utils/cn'
import { useChatRuntime } from '@/state/chatRuntime'
import { useProjects } from '@/lib/sync/projects'
import { useMemo, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { Pressable, ScrollView, Text, useWindowDimensions, View } from 'react-native'
import { ContextMeterCard, ModeAndThinkingControls } from '@/components/chat/ChatControls'
import { ModelSwitch } from '@/components/chat/ModelSwitch'

/** The unfiled chip's value — the row keys on strings, so null needs one. */
const NO_PROJECT = ''

/**
 * The project to work in, as a row of chips.
 *
 * Chips rather than a dropdown because the whole list is the point: the projects
 * are few, named and emoji'd, and one tap enters one — a Select hid every option
 * behind a modal to pick from a set that fits on the row itself. The row never
 * wraps; it scrolls freely on x however many projects there are, so adding the
 * twentieth costs the sheet no height.
 *
 * Choosing one ENTERS it: project mode is set, and the chat screen starts a fresh
 * conversation inside it (see the seenProjectRef rule in app/chat.tsx) — the same
 * thing tapping a card on the Projects screen does. It is deliberately not a
 * "re-file this conversation" control: a project's instructions are the base a
 * conversation starts FROM, so moving one already under way into a project would
 * show its chrome over turns that never received those instructions. The new
 * conversation is filed at creation, by the send itself.
 *
 * Chips come from the same project list the Projects screen and the project
 * dialog read and write, which is why they carry the project's own icon and
 * title rather than the id conversations bind by; a conversation pointing at a
 * project that list no longer has keeps showing its raw id rather than silently
 * reading as unfiled.
 */
function ProjectChips({
  conversation,
  onPicked
}: {
  conversation: ConversationFile | null | undefined
  /** A project was chosen — the sheet this sits in comes down. */
  onPicked?: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const { data: projects = [] } = useProjects()
  const pendingProjectId = useChatRuntime((state) => state.pendingProjectId)
  const setPendingProject = useChatRuntime((state) => state.setPendingProject)
  const activeProjectId = useChatRuntime((state) => state.activeProjectId)
  const setActiveProject = useChatRuntime((state) => state.setActiveProject)

  // Project mode is the answer when there is one; otherwise the open
  // conversation's own binding, so a project chat opened from History reads as
  // the project it belongs to rather than as unfiled.
  const value = activeProjectId ?? conversation?.projectId ?? pendingProjectId ?? NO_PROJECT
  const project = value ? projects.find((entry) => entry.id === value) : undefined

  const chips = useMemo(() => {
    const rows = [
      { value: NO_PROJECT, label: t('chat.menu.noProject'), icon: '📄' },
      ...projects.map((entry) => ({ value: entry.id, label: entry.title, icon: entry.icon }))
    ]
    // A binding whose project is missing from that list still needs a chip, or
    // the row would show nothing lit and the next pick would silently drop it.
    if (value && !projects.some((entry) => entry.id === value)) {
      rows.push({ value, label: value, icon: conversation?.icon ?? '📁' })
    }
    return rows
  }, [projects, t, value, conversation?.icon])

  // The lit chip can start off the row's right edge — the sheet would open on a
  // row that reads as unfiled. Scroll it into view the once; every later change
  // comes from a tap, which is already in view. The latch turns only on a scroll
  // that actually happened, so a chip laid out at the start before the project
  // list lands still gets carried in when the list pushes it right.
  const rowRef = useRef<ScrollView | null>(null)
  const settled = useRef(false)
  const onActiveLayout = (x: number): void => {
    if (settled.current || x <= 0) return
    settled.current = true
    rowRef.current?.scrollTo({ x: Math.max(x - 12, 0), animated: false })
  }

  const onChange = (next: string): void => {
    // One act, one meaning: enter the project (or leave it with "No project").
    // The chat screen watches project mode and puts the open conversation down,
    // so nothing here has to know what was on screen.
    setActiveProject(next || null)
    if (!next) setPendingProject(null)
    onPicked?.()
  }

  return (
    <View className="flex-col gap-1.5">
      <Text className="text-muted font-sans-medium text-left text-sm">
        {t('chat.menu.project')}
      </Text>
      <ScrollView
        ref={rowRef}
        horizontal
        showsHorizontalScrollIndicator={false}
        accessibilityRole="tablist"
        // The visible label above is a SIBLING Text, so without this the row
        // announces only its chips, with no hint of what they choose.
        accessibilityLabel={t('chat.menu.project')}
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{ alignItems: 'center', gap: 8 }}
      >
        {chips.map((chip) => {
          const active = chip.value === value
          return (
            <Pressable
              key={chip.value}
              accessibilityRole="tab"
              accessibilityState={{ selected: active }}
              onLayout={active ? (event) => onActiveLayout(event.nativeEvent.layout.x) : undefined}
              onPress={() => onChange(chip.value)}
              className={cn(
                'h-9 shrink-0 flex-row items-center gap-2 rounded-lg border px-3',
                active ? 'bg-primary border-primary' : 'bg-bg border-border active:bg-border-soft'
              )}
            >
              <Text className="text-sm">{chip.icon}</Text>
              <Text
                numberOfLines={1}
                className={cn(
                  'font-sans-medium max-w-[160px] text-xs',
                  active ? 'text-primary-fg' : 'text-fg'
                )}
              >
                {chip.label}
              </Text>
            </Pressable>
          )
        })}
      </ScrollView>
      {/* The project's prompt, in the app's code-block tones — the recessed
          mono panel tool output and compaction runs already use. Scrolls in
          place rather than stretching the sheet, so a long prompt is capped
          without being truncated the way the old 3-line preview was.
          Alignment left to RN's `auto`, the desktop's `dir="auto"`: an Arabic
          prompt reads flush-right even while the app is English. */}
      {project?.instructions ? (
        <ScrollView className="bg-bg border-border max-h-32 rounded-lg border" nestedScrollEnabled>
          <Text selectable className="text-fg p-3 font-mono text-[11px] leading-4">
            {project.instructions}
          </Text>
        </ScrollView>
      ) : null}
    </View>
  )
}

/**
 * The chat controls themselves — everything that flanks the desktop composer
 * (model, mode, thinking, project, context meter), scrolling in one column.
 * Plan mode is NOT here: it is a stance on the very next turn, so it lives on
 * the surface that sends it — the composer's own Plan chip (see Composer),
 * exactly where the desktop keeps it.
 *
 * Separate from the sheet below because project mode shows the SAME panel from
 * inside the project dialog (the composer's menu button becomes the project
 * button there, so this is where the controls live). One panel, so the two
 * places can never drift into offering different controls.
 */
export function ChatControlsPanel({
  conversation,
  showProject = true,
  onProjectPicked
}: {
  conversation: ConversationFile | null | undefined
  /**
   * Hide the project chips. Set inside the project dialog: there the project is
   * not a control being picked, it is the context you are in — and that dialog
   * already carries Close project. Two ways to change it from one screen, one of
   * which unmounts the screen mid-interaction, is a trap rather than a shortcut.
   */
  showProject?: boolean
  /** Passed through to the chips — choosing a project closes the sheet. */
  onProjectPicked?: () => void
}): React.JSX.Element {
  const { height } = useWindowDimensions()
  return (
    <ScrollView
      // Viewport-relative, not a magic number: the body is long enough to
      // scroll on every phone, and the dialog still fits the shortest one.
      style={{ maxHeight: Math.round(height * 0.6) }}
      contentContainerStyle={{ gap: 20 }}
      showsVerticalScrollIndicator={false}
    >
      <ModelSwitch />
      <ModeAndThinkingControls />
      {showProject && <ProjectChips conversation={conversation} onPicked={onProjectPicked} />}
      <ContextMeterCard conversation={conversation} />
    </ScrollView>
  )
}

/**
 * The controls as their own sheet — what the composer's menu button opens when
 * no project is active.
 */
export function ChatMenuSheet({
  open,
  onClose,
  conversation
}: {
  open: boolean
  onClose: () => void
  conversation: ConversationFile | null | undefined
}): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <Modal open={open} onClose={onClose} title={t('chat.menu.title')}>
      <ChatControlsPanel conversation={conversation} onProjectPicked={onClose} />
    </Modal>
  )
}
