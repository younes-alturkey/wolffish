import {
  ArrowUp02Icon,
  Delete02Icon,
  Edit02Icon,
  Image02Icon,
  Mic01Icon,
  PreferenceVerticalIcon,
  StopCircleIcon,
  Task01Icon,
  Tick02Icon
} from '@/components/core/icons'
import { INPUT_TEXT_ALIGN, WRITING_DIRECTION, rtlPlaceholder } from '@/components/core/Input'
import { KeyboardDismissAccessory } from '@/components/core/KeyboardDismissBar'
import type { ConversationFile } from '@/lib/conversations/types'
import { pickDocuments, pickMedia, type PickedFile } from '@/lib/files/pickAttachments'
import { MAX_FILES_PER_MESSAGE, uploadErrorMessage, validateUpload } from '@/lib/files/uploadPolicy'
import { useTokens } from '@/providers/theme/useTheme'
import { useToast } from '@/providers/toast/useToast'
import { cn } from '@/lib/utils/cn'
import {
  AudioModule,
  RecordingPresets,
  setAudioModeAsync,
  useAudioRecorder,
  useAudioRecorderState
} from 'expo-audio'
import { useEffect, useId, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Keyboard, Pressable, Text, TextInput, View } from 'react-native'
import { AttachSheet, AttachmentTray } from '@/components/chat/AttachmentPicker'
import { ChatControlsPanel, ChatMenuSheet } from '@/components/chat/ChatMenuSheet'
import { OllamaLogo, ProviderMark } from '@/components/core/providerLogos'
import { useConfigValue } from '@/state/demoConfig'
import { PromptEditorModal } from '@/components/chat/PromptEditorModal'
import { RainbowBorder } from '@/components/chat/RainbowBorder'
import { DEFAULT_PROJECT_ICON, ProjectDialog } from '@/components/workspace/ProjectDialog'
import { setPlanModeSynced } from '@/lib/sync/planMode'
import { useActiveProject, useProjectsWritable } from '@/lib/sync/projects'
import { useDesktopReachable } from '@/lib/tunnel/useTunnelStatus'
import { useAppStore } from '@/state/appStore'
import { NEW_CHAT_PENDING_KEY, selectPlanMode, useChatRuntime } from '@/state/chatRuntime'

/**
 * The chat composer — the desktop's composer card mapped to touch: ONE
 * bordered card whose top row is the field (or the recording bar swapped into
 * its place) and whose bottom row carries every control — the menu/project
 * button and the active-model chip at the start, expand / attach / the
 * mic-or-send swap and the red stop at the end — under the rainbow strip
 * while a turn runs. Voice flow: idle → recording (pulsing red dot +
 * counter) → send/delete straight from the recording bar.
 *
 * The field does NOT grow with the draft, which is where this parts from the
 * desktop textarea: on a phone a composer that climbs the screen takes the
 * conversation with it, moves the send button under the thumb that is already
 * reaching for it, and fights the keyboard for the same pixels. It scrolls
 * inside its one row instead, and a draft worth seeing whole opens in the
 * full-screen editor behind the expand button.
 *
 * Attachments follow the desktop exactly: picking stages, it does not upload,
 * and a staged file can be removed right up to the send. What leaves here is a
 * list of local files; who moves the bytes, and when, is the screen's business
 * (see chat.tsx and lib/sync/attachments.ts).
 *
 * MID-TURN nothing here is refused: a prompt, a file or a voice take submitted
 * while the agent is working is handed over exactly as it is when idle, and the
 * screen sends it INTO the running turn (see chat.tsx) — the agent reads it at
 * its next step. Send stays send. All that changes is the placeholder, which
 * says the message goes to work already in progress, plus the red stop sitting
 * beside the primary button rather than replacing it, because a turn you
 * cannot stop while you are typing the next message would be a trap.
 */

/** The single-line height of the field row at the top of the card. */
const ROW_HEIGHT = 42.5

export type ComposerSubmit =
  | { kind: 'text'; text: string; files: PickedFile[] }
  | { kind: 'voice'; uri: string; durationSeconds: number }

export type ComposerProps = {
  streaming: boolean
  conversation: ConversationFile | null | undefined
  /**
   * The conversation the field writes into — null for a chat with no id yet.
   * Separate from `conversation`, which is the loaded file and is undefined
   * for the frames before a body arrives; the draft-restore key must not be.
   */
  conversationId: string | null
  onSubmit: (payload: ComposerSubmit) => void
  onStop: () => void
  /**
   * Start a fresh chat — the header's + button, reached from here by project
   * mode's two actions (another conversation in this project, and leaving it,
   * which lands in a plain new one).
   */
  onNewConversation: () => void
}

export function Composer({
  streaming,
  conversation,
  conversationId,
  onSubmit,
  onStop,
  onNewConversation
}: ComposerProps): React.JSX.Element {
  const { t } = useTranslation()
  const tokens = useTokens()
  const toast = useToast()
  // The field's own iOS keyboard-dismiss chevron, paired by id below.
  const accessoryID = useId()
  const [draft, setDraft] = useState('')
  /**
   * Words handed BACK: a mid-turn message withdrawn before the agent read it
   * — by the user, or because the turn was stopped — is a draft again, not a
   * message that went. It lands in the runtime store under this chat's key
   * (chatRuntime.restoreDraft) and is appended to the field here, once, on
   * the render that sees it; a message the user was already typing keeps its
   * place above it.
   */
  const restoreKey = conversationId ?? NEW_CHAT_PENDING_KEY
  const restored = useChatRuntime((state) => state.draftRestores[restoreKey])
  useEffect(() => {
    if (!restored) return
    setDraft((current) => (current.trim() ? `${current}\n${restored}` : restored))
    useChatRuntime.getState().takeDraftRestore(restoreKey)
  }, [restored, restoreKey])
  const [menuOpen, setMenuOpen] = useState(false)
  const [projectOpen, setProjectOpen] = useState(false)
  const activeProject = useActiveProject()
  const setActiveProject = useChatRuntime((state) => state.setActiveProject)
  const projectsWritable = useProjectsWritable()
  const [editorOpen, setEditorOpen] = useState(false)
  const [attachOpen, setAttachOpen] = useState(false)
  const [files, setFiles] = useState<PickedFile[]>([])
  const recorder = useAudioRecorder(RecordingPresets.HIGH_QUALITY)
  const recorderState = useAudioRecorderState(recorder, 500)
  const [recording, setRecording] = useState(false)

  // The active model, for the bottom row's chip — read from the same config
  // mirror the controls sheet's ModelSwitch reads, and resolved by the same
  // rule the desktop's runtime routes a turn by: `localOnly` alone says
  // whether Ollama or the cloud brain answers.
  const localOnly = useConfigValue('localOnly')
  const localModel = useConfigValue('localModel')
  const brainProvider = useConfigValue('brainProvider')
  const brainModel = useConfigValue('brainModel')
  const localActive = localOnly
  const activeModelName = (localActive ? localModel : brainModel) || t('settings.model.noModel')

  // Plan mode, worn where the desktop wears it: a chip in the bottom row
  // beside the model chip, and the ONLY handle on the stance — it is switched
  // here, on and off, rather than from a row inside the controls sheet. A
  // stance that shapes the very next turn belongs on the surface that sends
  // it, not two taps down.
  //
  // It stands on every chat, demo included: the demo is a tour of the app, and
  // a control missing from the tour is a control the user never learns they
  // have. Nothing there runs a turn to obey the stance, but the chip is not a
  // promise about the reply — it is the stance itself, and in demo it is held
  // locally (setPlanModeSynced with no tunnel simply keeps it) exactly as the
  // model chip holds a model no demo reply is generated by.
  //
  // The one state that dims it is a PAIRED phone whose desktop is out of
  // reach: there the stance is a real thing over there, just not changeable
  // from here this second, and a flip nobody would receive is worse than a
  // chip that says why (the tap answers with the reason).
  const planMode = useChatRuntime(selectPlanMode(conversation?.id ?? null))
  const desktopReachable = useDesktopReachable()
  const paired = useAppStore((state) => state.paired)
  const planLocked = paired && !desktopReachable

  // A file on its own is a message, exactly as it is on the desktop — the
  // prompt is optional once something is attached.
  const canSend = draft.trim().length > 0 || files.length > 0

  /**
   * One press, one message.
   *
   * The draft and the staged files are React state, so a second press landing
   * in the same frame as the first still reads the text that was just handed
   * over — the field has not repainted, and the send button is still under the
   * thumb that pressed it. Without this the same message goes twice: as two
   * turns when idle, and as two rows when the screen is queueing.
   *
   * Held synchronously and released by the effect below, on the very commit
   * that empties the field — which always happens, since `setFiles([])` is a
   * fresh array even when nothing was staged.
   */
  const handedOver = useRef(false)
  useEffect(() => {
    handedOver.current = false
  }, [draft, files])

  // Not gated on `streaming`: mid-turn the submit goes into the running turn,
  // and the composer clears either way — what was written now belongs to the
  // message on its way, not to the field. The expanded editor submits through
  // here too, passing the draft it holds, which is why the text is an argument
  // rather than read from state.
  const submit = (value: string): void => {
    if (handedOver.current) return
    const text = value.trim()
    if (!text && files.length === 0) return
    handedOver.current = true
    setDraft('')
    setFiles([])
    // A message on its way is the end of editing it: the expanded editor comes
    // down with the field it was standing in for, and the keyboard goes with
    // it — idle or mid-turn alike. Half the screen was being held for a field
    // that is now empty, and the reply is what the user wants to see.
    setEditorOpen(false)
    Keyboard.dismiss()
    onSubmit({ kind: 'text', text, files })
  }

  const submitText = (): void => submit(draft)

  /**
   * Take what the picker returned, one file at a time, against the limits the
   * desktop enforces. Validating per file (rather than rejecting the batch) is
   * the desktop's behavior too: a good file in a bad batch still attaches, and
   * every refusal says which rule it broke.
   */
  const stage = (picked: PickedFile[]): void => {
    if (picked.length === 0) return
    // Decided against `files` read here rather than inside a setState updater:
    // an updater must be pure (this app builds with the React Compiler, which
    // is free to re-run one), and raising a toast from inside it is a side
    // effect on another component mid-update. Two picks cannot overlap — the
    // picker is modal — so reading current state directly is sound.
    const next = [...files]
    let totalBytes = next.reduce((sum, file) => sum + file.sizeBytes, 0)
    const rejected: string[] = []
    for (const file of picked) {
      const error = validateUpload(file.name, file.sizeBytes, next.length, totalBytes)
      if (error) {
        rejected.push(uploadErrorMessage(error, t))
        continue
      }
      next.push(file)
      totalBytes += file.sizeBytes
    }
    setFiles(next)
    // One toast per distinct reason: ten files over the same cap is one
    // problem, not ten notifications stacked over the composer.
    for (const message of [...new Set(rejected)]) toast.show({ tone: 'error', message })
  }

  const attach = (source: 'media' | 'files'): void => {
    void (async () => {
      try {
        const remaining = MAX_FILES_PER_MESSAGE - files.length
        if (remaining <= 0) {
          toast.show({
            tone: 'error',
            message: uploadErrorMessage(
              { code: 'max_files_reached', max: MAX_FILES_PER_MESSAGE },
              t
            )
          })
          return
        }
        stage(source === 'media' ? await pickMedia(remaining) : await pickDocuments())
      } catch {
        // A picker that refuses to open — no library access on Android, a
        // provider that crashed. Nothing was staged; say so and move on.
        toast.show({ tone: 'error', message: t('chat.attach.error') })
      }
    })()
  }

  const startRecording = async (): Promise<void> => {
    const permission = await AudioModule.requestRecordingPermissionsAsync()
    if (!permission.granted) {
      toast.show({ tone: 'warning', message: t('chat.voice.permissionDenied') })
      return
    }
    try {
      await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true })
      // prepareToRecordAsync never settles when the platform's audio input
      // can't start (e.g. the Simulator without host mic access) — time out
      // into a visible error rather than hanging the button silently.
      await Promise.race([
        recorder.prepareToRecordAsync(),
        new Promise((_resolve, reject) =>
          setTimeout(() => reject(new Error('audio input unavailable')), 4000)
        )
      ])
      recorder.record()
      setRecording(true)
    } catch {
      toast.show({ tone: 'error', message: t('chat.voice.error') })
    }
  }

  const stopRecording = async (send: boolean): Promise<void> => {
    try {
      await recorder.stop()
      // Recording keeps the session in record mode — restore playback.
      await setAudioModeAsync({ allowsRecording: false, playsInSilentMode: true })
      setRecording(false)
      const uri = recorder.uri
      if (send && uri) {
        onSubmit({
          kind: 'voice',
          uri,
          durationSeconds: recorderState.durationMillis / 1000
        })
      }
    } catch {
      setRecording(false)
      toast.show({ tone: 'error', message: t('chat.voice.error') })
    }
  }

  const remove = (id: string): void => {
    setFiles((current) => current.filter((file) => file.id !== id))
  }

  const mmss = (millis: number): string => {
    const s = Math.max(0, Math.floor(millis / 1000))
    return `${Math.floor(s / 60)}:${(s % 60).toString().padStart(2, '0')}`
  }

  return (
    <View className="bg-bg border-border-soft border-t">
      {/* Renders nothing inline — the accessory lives in the keyboard's
          window, shown whenever the field below names it. Before the field
          in tree order so even an auto-focused mount finds it registered. */}
      <KeyboardDismissAccessory nativeID={accessoryID} />
      {streaming && <RainbowBorder />}
      {/* Staged files sit above the input, as they do above the desktop
          textarea — visible, removable, and not yet anywhere but this phone. */}
      {!recording && <AttachmentTray files={files} onRemove={remove} />}
      <View className="px-3 py-2.5">
        {/* One surface, the desktop's composer card on touch: the card
            carries the border and background, the field rides bare in its top
            row, and every control lives in the bottom row INSIDE it. */}
        <View className="border-border bg-surface w-full flex-col rounded-lg border">
          {recording ? (
            <View key="recording-bar" className="h-[42.5px] flex-row items-center gap-3 px-3">
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={t('chat.voice.delete')}
                hitSlop={8}
                onPress={() => void stopRecording(false)}
              >
                <Delete02Icon size={18} className="text-rose-500" />
              </Pressable>
              <View className="h-2.5 w-2.5 animate-pulse rounded-full bg-red-600" />
              <Text className="text-fg font-sans-medium flex-1 text-left text-sm">
                {t('chat.voice.recording')}
              </Text>
              <Text className="text-muted font-sans text-sm" style={{ writingDirection: 'ltr' }}>
                {mmss(recorderState.durationMillis)}
              </Text>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={t('chat.voice.send')}
                hitSlop={8}
                onPress={() => void stopRecording(true)}
                className="bg-primary h-8 w-8 items-center justify-center rounded-lg active:opacity-90"
              >
                <Tick02Icon size={16} color={tokens.primaryFg} />
              </Pressable>
            </View>
          ) : (
            <View key="compose-field" className="flex-row items-center">
              {/* One row, always. `height` (not minHeight/maxHeight) is the whole
                point: the field never resizes, so nothing above it moves while
                typing — the text scrolls within these pixels instead, and the
                caret is kept in view by the platform. Bare: the card carries
                the border and surface the input used to wear. */}
              <TextInput
                multiline
                scrollEnabled
                value={draft}
                onChangeText={setDraft}
                placeholder={rtlPlaceholder(
                  streaming ? t('chat.interject.placeholder') : t('chat.placeholder')
                )}
                placeholderTextColor={tokens.muted}
                selectionColor={tokens.accent}
                style={[{ height: ROW_HEIGHT }, WRITING_DIRECTION]}
                className={cn(
                  'flex-1 py-2.5 ps-3 pe-3 font-sans text-sm leading-5',
                  'text-fg',
                  INPUT_TEXT_ALIGN
                )}
                accessibilityLabel={
                  streaming ? t('chat.interject.placeholder') : t('chat.placeholder')
                }
                // The dismiss chevron docked above the iPhone keyboard — the
                // OS gives that keyboard no way down of its own. iOS-only
                // prop; Android's navigation bar already carries the chevron.
                inputAccessoryViewID={accessoryID}
              />
            </View>
          )}

          {/* The bottom row inside the card — the desktop's grammar with what
            this screen already has. Start: the controls button (faders — or
            the PROJECT button in project mode: the project's own emoji,
            opening the dialog that carries both the project and these
            controls; the desktop makes the same swap), the active-model chip,
            which opens the very same surface, and the Plan chip while that
            stance is on. End: expand, attach, the
            mic↔send swap, and the red stop. While the recorder owns the top
            row every control here hides exactly as it used to — except stop,
            which survives: a turn you cannot stop because you happen to be
            holding a recording would be a trap. The row itself only renders
            when it has something to show. */}
          {(!recording || streaming) && (
            <View className="flex-row items-center gap-1 px-1.5 pb-1.5">
              {!recording && (
                <>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={
                      activeProject
                        ? activeProject.title.trim() || t('projects.untitled')
                        : t('chat.menu.title')
                    }
                    hitSlop={6}
                    onPress={() => (activeProject ? setProjectOpen(true) : setMenuOpen(true))}
                    className="h-7 w-7 items-center justify-center rounded-md active:bg-border-soft"
                  >
                    {activeProject ? (
                      <Text className="text-base leading-5">
                        {activeProject.icon || DEFAULT_PROJECT_ICON}
                      </Text>
                    ) : (
                      <PreferenceVerticalIcon size={16} className="text-muted" />
                    )}
                  </Pressable>
                  {/* The active model, worn as the desktop model chip — a second
                    handle on the controls the button beside it opens, so the
                    model about to answer is always one glance away.
                    Precomputed tones, not `bg-primary/10 ring-primary/30`: an
                    alpha modifier on a var() colour compiles to nothing at all
                    (see global.css), so the desktop's tint has to be worn as
                    the primary-soft/primary-line pair or the chip renders as
                    bare coloured text. */}
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={activeModelName}
                    hitSlop={6}
                    onPress={() => (activeProject ? setProjectOpen(true) : setMenuOpen(true))}
                    className="bg-primary-soft border-primary-line active:bg-primary-line h-7 min-w-0 shrink flex-row items-center gap-1.5 rounded-lg border px-2"
                  >
                    {localActive ? (
                      <OllamaLogo size={13} className="text-primary" />
                    ) : (
                      <ProviderMark provider={brainProvider} size={13} className="text-primary" />
                    )}
                    {/* The one elastic thing in the row. No width cap: every
                      other control here — the plan chip included — keeps its
                      natural size (RN shrinks nothing unless it is told to),
                      so the name takes whatever is left over and gives it
                      back, one ellipsis at a time, when the plan chip appears
                      or a longer model is picked. That is the only way a
                      `qwen2.5-coder:32b-instruct-q5_K_M` and four controls
                      share ~340pt on the narrowest phone without wrapping. */}
                    <Text
                      numberOfLines={1}
                      className="text-primary font-sans-medium shrink text-[11px]"
                      style={{ writingDirection: 'ltr' }}
                    >
                      {activeModelName}
                    </Text>
                  </Pressable>
                  {/* Plan mode, beside the model it constrains — the desktop
                    wears its Plan chip in this same row, and this one is a
                    toggle exactly as that one is: ON it is tinted like the
                    model chip beside it, OFF it is an outline, and either way
                    the stance the next send carries is on screen. Out of
                    reach it dims and answers a tap with the reason instead of
                    a flip the desktop would never hear. */}
                  <Pressable
                    accessibilityRole="button"
                    accessibilityState={{ selected: planMode, disabled: planLocked }}
                    accessibilityLabel={
                      planMode ? t('chat.planMode.onTitle') : t('chat.planMode.offTitle')
                    }
                    hitSlop={6}
                    onPress={() => {
                      if (planLocked) {
                        toast.show({ tone: 'warning', message: t('chat.planMode.offline') })
                        return
                      }
                      void setPlanModeSynced(conversation?.id ?? null, !planMode)
                    }}
                    className={cn(
                      'h-7 flex-row items-center gap-1 rounded-full border px-2',
                      planMode
                        ? 'bg-primary-soft border-primary-line active:bg-primary-line'
                        : 'border-border bg-surface active:bg-border-soft',
                      planLocked && 'opacity-50'
                    )}
                  >
                    <Task01Icon size={12} className={planMode ? 'text-primary' : 'text-muted'} />
                    <Text
                      className={cn(
                        'font-sans-medium text-[11px]',
                        planMode ? 'text-primary' : 'text-muted'
                      )}
                    >
                      {t('chat.planMode.label')}
                    </Text>
                  </Pressable>
                </>
              )}
              <View className="flex-1" />
              {!recording && (
                <>
                  {/* Opens the full-screen draft editor. It wears the same
                    pencil the desktop's composer button does, not the
                    four-arrow expand mark: the arrows belong to the file and
                    chart viewers, where the act really is "make this bigger",
                    while this control's own label is "Write your message".
                    Sized 16 like attach and mic beside it — the pencil is a
                    lighter mark than the arrows were, so at 13 it read
                    undersized next to them. */}
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={t('chat.editor.title')}
                    hitSlop={6}
                    onPress={() => setEditorOpen(true)}
                    className="h-7 w-7 items-center justify-center rounded-md active:bg-border-soft"
                  >
                    <Edit02Icon size={16} className="text-muted" />
                  </Pressable>
                  {/* Attach sits with the other message actions, next to the
                    mic, not with the session controls. It stays put when the
                    mic becomes send, so a file can be added to a prompt that
                    has already been typed.
                    The media glyph, not a plus: the desktop's attach button
                    carries this exact icon, and a plus is already spoken for
                    on this screen — the header's new-chat control. Two
                    identical glyphs meaning different things is the one thing
                    a composer cannot afford. */}
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={t('chat.attach.title')}
                    hitSlop={6}
                    onPress={() => setAttachOpen(true)}
                    className="h-7 w-7 items-center justify-center rounded-md active:bg-border-soft"
                  >
                    <Image02Icon size={16} className="text-muted" />
                  </Pressable>
                  {/* Distinct keys so React unmounts one and mounts the other on
                    the mic↔send swap, instead of reusing one instance and
                    mutating its variable-bearing className (which trips
                    css-interop's remount warning in dev).

                    The mic stays live mid-turn, as it does on the desktop: a
                    take recorded while the agent is working goes into the
                    running turn rather than being refused. */}
                  {!canSend && (
                    <Pressable
                      key="composer-mic"
                      accessibilityRole="button"
                      accessibilityLabel={t('chat.voice.record')}
                      hitSlop={6}
                      onPress={() => void startRecording()}
                      className="h-7 w-7 items-center justify-center rounded-md active:bg-border-soft"
                    >
                      <Mic01Icon size={16} className="text-muted" />
                    </Pressable>
                  )}
                  {/* The primary button keeps its place and its meaning mid-turn
                    — it sends, into the running turn. Stop is the separate red
                    one beside it, never the same control wearing two hats. */}
                  {canSend && (
                    <Pressable
                      key="composer-send"
                      accessibilityRole="button"
                      accessibilityLabel={t('chat.send')}
                      onPress={submitText}
                      className="bg-primary h-8 w-8 items-center justify-center rounded-full active:opacity-90"
                    >
                      <ArrowUp02Icon size={16} color={tokens.primaryFg} />
                    </Pressable>
                  )}
                </>
              )}
              {streaming && (
                <Pressable
                  key="composer-stop"
                  accessibilityRole="button"
                  accessibilityLabel={t('chat.stop')}
                  onPress={onStop}
                  className="h-8 w-8 items-center justify-center rounded-full bg-red-600 active:bg-red-700"
                >
                  <StopCircleIcon size={16} color="#ffffff" />
                </Pressable>
              )}
            </View>
          )}
        </View>
      </View>

      <AttachSheet
        open={attachOpen}
        onClose={() => setAttachOpen(false)}
        onPickMedia={() => attach('media')}
        onPickFiles={() => attach('files')}
      />
      <ChatMenuSheet
        open={menuOpen}
        onClose={() => setMenuOpen(false)}
        conversation={conversation}
      />
      {/* Project mode's dialog, opened from the slot above. It carries the two
          extras the desktop's project dialog carries — start another
          conversation here, and close the project — plus the way back to the
          chat controls that slot would otherwise have opened. */}
      <ProjectDialog
        project={projectOpen ? activeProject : null}
        busy={streaming}
        readOnly={!projectsWritable}
        onClose={() => setProjectOpen(false)}
        // Nothing to do with the edit: project mode is derived from the project
        // list, and every write has already landed there by the time this fires.
        onChanged={() => undefined}
        // In project mode this dialog stands where the menu button was, so it
        // carries the controls that button opens — behind its own view switch.
        // The project picker is left out: see ChatControlsPanel.showProject.
        controls={<ChatControlsPanel conversation={conversation} showProject={false} />}
        onNewConversation={() => {
          setProjectOpen(false)
          onNewConversation()
        }}
        onExitProject={() => {
          setProjectOpen(false)
          // Leaving the project lands in a plain new chat right here, rather
          // than navigating back to the projects list — the desktop's
          // Close-project does the same. The chat screen starts that chat off
          // the project-mode change itself, so nothing else is needed here.
          setActiveProject(null)
        }}
      />
      <PromptEditorModal
        open={editorOpen}
        initialValue={draft}
        streaming={streaming}
        onSend={submit}
        onDone={(value) => {
          setDraft(value)
          setEditorOpen(false)
        }}
      />
    </View>
  )
}
