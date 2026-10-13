import { AssistantMessageView, UserBubble } from '@/components/chat/MessageBubbles'
import { SelectTextHost } from '@/components/chat/SelectTextSheet'
import { ChatFeed, FEED_FADE_MS, type ChatFeedHandle } from '@/components/chat/ChatFeed'
import { ChatSkeleton } from '@/components/chat/ChatSkeleton'
import { Composer, type ComposerSubmit } from '@/components/chat/Composer'
import { ConversationNotificationsSheet } from '@/components/chat/ConversationNotificationsSheet'
import { ConversationsSheet } from '@/components/chat/ConversationsSheet'
import { FLOATING_AREA, FLOATING_GAP, FloatingChrome } from '@/components/chat/FloatingChrome'
import { PendingInterjectionBubble } from '@/components/chat/PendingInterjections'
import { buildFeed, LIVE_KEY } from '@/lib/conversations/feed'
import {
  failedTurnEnd,
  latestBrowserCards,
  latestTodoLists,
  todoListId
} from '@/lib/conversations/segments'
import { useConversation } from '@/lib/conversations/hooks'
import {
  mintMessageId,
  type ConversationMessage,
  type MessageAttachment
} from '@/lib/conversations/types'
import {
  demoInterject,
  deriveTitle,
  ensureDemoConversation,
  sendDemoPrompt,
  stopDemoTurn,
  withdrawDemoInterjection
} from '@/lib/demo/agent'
import { discardStagedFile, importLocalFile, stageOutgoingFile } from '@/lib/files/fileCache'
import type { PickedFile } from '@/lib/files/pickAttachments'
import { DEFAULT_PROJECT_ICON } from '@/components/workspace/ProjectDialog'
import { PromptPreview } from '@/components/workspace/PromptSheet'
import { NEW_CHAT_PENDING_KEY, selectPending, useChatRuntime } from '@/state/chatRuntime'
import { useConfigValue } from '@/state/demoConfig'
import { Image } from 'expo-image'
import { useFocusEffect, useLocalSearchParams } from 'expo-router'
import { dismissConversationBanners, setActiveConversation } from '@/lib/notifications/push'
import { useActiveProject } from '@/lib/sync/projects'
import { seedPlanMode } from '@/lib/sync/planMode'
import {
  abortTurn,
  beginTurn,
  interject,
  sendPrompt,
  withdrawInterjection
} from '@/lib/sync/prompt'
import { useDesktopReachable } from '@/lib/tunnel/useTunnelStatus'
import {
  discardStaged,
  fileLocally,
  stageForSend,
  stagedAttachment,
  uploadForSend
} from '@/lib/sync/attachments'
import { uploadFileToDesktop } from '@/lib/sync/files'
import { tunnelClient } from '@/lib/tunnel/client'
import { useToast } from '@/providers/toast/useToast'
import { useAppStore } from '@/state/appStore'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { AppState, KeyboardAvoidingView, StyleSheet, Text, View } from 'react-native'
import Animated, { FadeOut } from 'react-native-reanimated'
import { useSafeAreaInsets } from 'react-native-safe-area-context'

/**
 * The chat screen — the desktop Chat page adapted to one column, and the only
 * screen the app really has: a bottom-pinned feed under two floating controls
 * (the conversations sheet, a new chat), and a composer with send/stop/record.
 * Works identically for a fresh chat and for any conversation the sheet opens.
 *
 * There is no top bar. The sheet is the navigator — every core page and every
 * conversation — and it opens a conversation IN PLACE rather than pushing a
 * copy of this screen per row tapped. That is the desktop's model (one window,
 * many conversations, turns running concurrently in whichever) and it is what
 * `opened` and `generationRef` below exist to make safe.
 *
 * The feed is a plain ScrollView, deliberately:
 * - inverted FlatList: Fabric text measurement explodes on RTL-heavy rows
 *   (real Arabic conversations blanked the whole feed);
 * - non-inverted FlatList: scrollToEnd targets the ESTIMATED content end,
 *   which never converges with a few huge rows, so opening at the bottom
 *   is unreliable.
 * Conversations are small (median 2, max 30 messages in three months of
 * real data), so full rendering is cheap and bottom-pinning deterministic.
 * Everything about WHERE that ScrollView sits lives in ChatFeed.
 *
 * The screen has four display states and exactly one transition between any
 * two of them, because the alternative — letting each state appear as soon as
 * its data happens to arrive — is what made opening a conversation flash the
 * hero, then the top of the transcript, then snap to the end:
 *
 *   new chat        no id, nothing to load          → hero, immediately
 *   opening         id, transcript not laid out yet → skeleton
 *   open            transcript pinned to its end    → feed, faded in
 *   empty           id, but genuinely no messages   → hero
 *
 * The skeleton covers the whole "opening" window — reading SQLite, downloading
 * the body over the tunnel, laying the messages out, pinning to the end — so
 * the transcript is never seen anywhere but at its final position.
 *
 * SENDING adds a fifth state that none of those four can express, and getting
 * it wrong is what made a prompt sent from here disappear into nothing: a new
 * chat has no conversation to load, so it is neither "opening" (no skeleton)
 * nor "empty" (the hero is gone the moment the user sends) for the whole round
 * trip in which the desktop mints one. The prompt is therefore rendered from
 * local state for exactly that window — `pendingUser` — and handed to the live
 * turn the moment there is an id to file it under. Neither the hero nor a bare
 * feed is ever shown while a turn is in flight.
 *
 * SENDING MID-TURN goes INTO the running turn, not behind it: a submit that
 * arrives while a turn is running is handed to the desktop's turn runner
 * (Rpc.interject) and the agent reads it at its next step — "skip the tests
 * folder", "use the other file" — instead of after the work it was meant to
 * steer is finished. It enters the feed at once, as the user's own bubble
 * after the live assistant row with a "read at the next step" caption, and
 * moves inside the assistant card when the agent reads it. See
 * `interjectSubmit` below, and sync/prompt.ts interject.
 */

export default function ChatScreen(): React.JSX.Element {
  const { t } = useTranslation()
  const toast = useToast()
  const insets = useSafeAreaInsets()
  const params = useLocalSearchParams<{ id?: string }>()
  const feedRef = useRef<ChatFeedHandle>(null)
  /** Whether the current `opened` has ever put rows on screen — what tells a
   *  transcript that VANISHED apart from one still arriving. See `vanished`. */
  const hadRowsRef = useRef(false)
  const [conversationId, setConversationId] = useState<string | null>(params.id ?? null)
  /**
   * The conversation this screen is OPEN ON — seeded from the route (History, a
   * deep link, a notification) and then moved, in place, by the conversations
   * sheet. Distinct from `conversationId`, which ALSO moves when a new chat gets
   * its id on first send: that transition must not re-gate a feed the user is
   * already looking at.
   *
   * State rather than the route parameter, because the sheet switches
   * conversations without navigating: this screen is the app's single surface,
   * as the desktop window is, and pushing a copy of it per conversation would
   * stack one screen per row the user taps. Everything a switch has to reset
   * hangs off this one value, below.
   */
  const [opened, setOpened] = useState<string | null>(params.id ?? null)
  const [feedRevealed, setFeedRevealed] = useState(opened === null)
  /**
   * How many conversations this screen has shown. A send captures the number it
   * started under and refuses to settle against a later one — see performSubmit.
   * The whole reason in-place switching needs it: an RPC in flight outlives the
   * conversation it was sent from, and its result would otherwise drag the user
   * back to a chat they had already walked away from.
   */
  const generationRef = useRef(0)
  useEffect(() => {
    generationRef.current += 1
    setConversationId(opened)
    setFeedRevealed(opened === null)
    hadRowsRef.current = false
    // Nothing in flight follows the user out of the conversation they left. The
    // TURN does keep running — it lives in chatRuntime under its own id, and
    // walking away is not stopping — but this screen's copy of the last prompt
    // does not, nor do mid-turn messages written into a chat that had no id
    // yet (they were never handed to the desktop; the ones that were are the
    // desktop's facts, keyed by their conversation, and are drawn again on
    // the way back).
    setPendingUser(null)
    sendingRef.current = false
    setSending(false)
    heldRef.current = []
    useChatRuntime.getState().clearPending(NEW_CHAT_PENDING_KEY)
  }, [opened])
  /**
   * Which conversation is on screen, and its banners off the lock screen.
   *
   * NOT its unread count. Being in a conversation is not reading what it sent
   * you — the transcript does not repeat a notification — so the count stays
   * on the bell in the chrome above, and opening that bell is what answers it.
   * What does end here is the tray: a banner for the conversation you are
   * standing in is noise whether or not you have read it.
   *
   * Runs on the return path too — back from a pushed settings screen, and back
   * from the background, where a foreground reconciliation may have just
   * landed banners for the very conversation on screen. Blur or unmount
   * reports no conversation active.
   *
   * Keyed on `conversationId`, NOT `opened`: a chat minted by first send gets
   * an id without ever being "opened" (see the doc on `opened` above), and the
   * model's notify for that run deep-links to that id. `conversationId` is the
   * conversation actually on screen in every case — route, sheet, and mint.
   */
  useFocusEffect(
    useCallback(() => {
      const seeing = (): void => {
        setActiveConversation(conversationId)
        if (conversationId) dismissConversationBanners(conversationId)
      }
      seeing()
      const subscription = AppState.addEventListener('change', (next) => {
        if (next === 'active') seeing()
      })
      return () => {
        subscription.remove()
        setActiveConversation(null)
      }
    }, [conversationId])
  )
  const paired = useAppStore((state) => state.paired)
  // The desktop's plan-mode stance for this conversation, read once per open
  // and again on reconnect; pushes keep it current in between.
  const desktopReachable = useDesktopReachable()
  useEffect(() => {
    if (conversationId && paired && desktopReachable) void seedPlanMode(conversationId)
  }, [conversationId, paired, desktopReachable])
  const { data: conversation, isFetching: conversationFetching } = useConversation(conversationId)
  // The turn being written into this conversation right now, from whichever
  // side started it — this phone, the desktop, a channel. One store for demo
  // and paired alike, so the feed has one streaming shape rather than two.
  const live = useChatRuntime((state) =>
    conversationId ? state.streams[conversationId] : undefined
  )
  // Project mode — set from the Projects screen or a project-bound procedure.
  // The hero and the composer's project button both render from it.
  const activeProject = useActiveProject()
  const activeProjectId = useChatRuntime((state) => state.activeProjectId)
  // A prompt sent from a chat with no id yet, held for the round trip that
  // mints one. Cleared as it is handed to the live turn below.
  const [pendingUser, setPendingUser] = useState<ConversationMessage | null>(null)
  const [sending, setSending] = useState(false)
  /**
   * The same fact as `sending`, a render earlier.
   *
   * `sending` is state, so it is only true from the NEXT commit — and a submit
   * arriving inside that one frame reads an idle screen. That happens: a double
   * tap on the send button, or a tap landing in the same commit as the queue
   * flush below. Both submits then take the send path, two `sendMessage` RPCs
   * reach the desktop for one conversation, and it runs them one after the
   * other — so the second reply looks like a hang, and the same message is
   * answered twice. The desktop closes the identical window with its own
   * sendingRef; this is that guard.
   *
   * Mirrors `sending` at every point one is set, and is read only where a
   * decision is made inside that frame — never to render.
   */
  const sendingRef = useRef(false)
  /**
   * Mid-turn messages of the conversation on screen that the agent has not
   * read yet — the desktop's inbox, mirrored (sync/prompt.ts). For a chat
   * with no id yet they file under NEW_CHAT_PENDING_KEY until the first send
   * comes back with one; see `heldRef`.
   */
  const pending = useChatRuntime(selectPending(conversationId ?? NEW_CHAT_PENDING_KEY))
  /**
   * Mid-turn submits written while a send was still in flight — before there
   * is a TURN to hand them to.
   *
   * Two shapes of the same window. A chat with no conversation id yet has no
   * turn and no id; a chat that HAS one can still be mid-send, and an upload
   * makes that window seconds long. Either way the turn the message means to
   * steer is the one being opened right now, and handing it over early is
   * worse than waiting: the desktop answers `no_live_turn` — correctly, it
   * has not started yet — and the message would go as a turn OF ITS OWN,
   * racing the send it was written behind. Two turns then run in one
   * conversation, fighting over one live overlay.
   *
   * So the payloads wait here, bubbles already up, and go the moment `settle`
   * says the first send landed. Cleared, with the bubbles, when the user
   * walks away.
   */
  const heldRef = useRef<{ messageId: string; payload: ComposerSubmit }[]>([])
  /** Ids withdrawn while their upload was still running — the delivery skips them. */
  const withdrawnRef = useRef(new Set<string>())
  /**
   * Mid-turn messages whose hand-over has not happened yet, by id → the words
   * to give back. A message is only the desktop's (or the demo turn's) once it
   * has been handed over; until then — while its files upload, which is
   * seconds — nobody else can decide anything about it, so a withdraw in that
   * window is answered HERE rather than by waiting for a `withdrawn` push that
   * is never coming. Cleared at the hand-over, after which the push is the
   * give-back.
   */
  const deliveringRef = useRef(new Map<string, string>())
  // The navigator — every core page, and every conversation. Closed by default
  // and mounted lazily by the sheet itself, so it costs nothing until opened.
  const [sheetOpen, setSheetOpen] = useState(false)
  /** The conversation's own notifications sheet, from the trailing edge. */
  const [notificationsOpen, setNotificationsOpen] = useState(false)
  // One flag for both ends: the desktop's `inapp.verbose`. The feed is a
  // display preference of the workspace, not of the device rendering it.
  const verbose = useConfigValue('inappVerbose')

  const streaming = live?.status === 'streaming' || sending

  const feed = useMemo(
    () => buildFeed({ messages: conversation?.messages, live, pendingUser, sending, pending }),
    [conversation, live, pendingUser, sending, pending]
  )
  // Every task list in its latest state, keyed by list id: a later turn's
  // todo_write that continues an earlier list resolves THAT card in place.
  // Memoized on a signature of the todo segments only, so streaming text
  // never rebuilds it (and never re-renders every row through the prop).
  const todoSignature = useMemo(
    () =>
      feed
        .flatMap((item) => (item.message.role === 'assistant' ? (item.message.segments ?? []) : []))
        .filter((segment) => segment.kind === 'todo')
        .map((segment) => `${todoListId(segment)}:${segment.segmentId}`)
        .join('|'),
    [feed]
  )
  const todoLists = useMemo(
    () => latestTodoLists(feed.map((item) => item.message)),
    // todoSignature is the memo key on purpose: it changes exactly when a todo segment does.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [todoSignature]
  )
  // Where each conversation browser's one card lives (segments.ts
  // latestBrowserCards) — a cheap walk, so keyed on the feed itself.
  const browserCards = useMemo(() => latestBrowserCards(feed.map((item) => item.message)), [feed])

  /**
   * Is this conversation between turns? Not "is nothing streaming right now" —
   * that is the question this used to ask, and the two differ exactly where it
   * matters.
   *
   * A turn is over when someone SAID so. Two things can say it:
   *
   *   no overlay at all   nothing is in flight and nothing recently was. An
   *                       overlay exists for every turn this phone believes is
   *                       running — opened at the tap, on `turn.status:
   *                       started`, on the desktop's first mirror, and seeded
   *                       from the desktop's active runs when the tunnel comes
   *                       up (seedActiveRuns) — so its absence is real.
   *   ended: 'desktop'    a terminal `turn.status` for this turn. The overlay
   *                       is still up because the saved copy has not arrived,
   *                       but the turn itself is finished.
   *
   * What is deliberately NOT idle is an overlay that merely stopped streaming.
   * The reconnect re-settle clears the streaming flag on every turn it might
   * have missed the end of (attachTurnStream), which is a guess — and while
   * that guess stood, end-of-turn chrome flashed over a turn the desktop was
   * still writing and vanished again on its next frame. That is the flash this
   * closes, and a backgrounded phone coming back mid-turn hits it every time.
   */
  const idle = !live || (live.status !== 'streaming' && live.ended === 'desktop')

  const lastItem = feed[feed.length - 1]
  /**
   * The desktop's Try Again gate, ported: is the feed's last row a failed
   * assistant turn? Failure is read from the message itself — its turn_end or
   * error string — or, for the live row, from the stream the desktop marked
   * failed, which can end a turn before any segment reaches this phone.
   * A failed turn offers the retry; the desktop's card replaces its bubble
   * the same way.
   */
  const lastFailed =
    !!lastItem &&
    !lastItem.streaming &&
    lastItem.message.role === 'assistant' &&
    (!!lastItem.message.error ||
      !!failedTurnEnd(lastItem.message) ||
      (lastItem.key === LIVE_KEY && live?.status === 'error'))

  /**
   * A send that will not happen, taken back down. The live turn opened at the
   * tap has to come with it, or the thinking words run against a desktop that
   * was never asked — the same take-back sendPrompt does when its own RPC
   * throws.
   */
  const abandon = useCallback(
    (settle: (id?: string) => void): void => {
      if (conversationId) useChatRuntime.getState().endStream(conversationId)
      settle()
    },
    [conversationId]
  )

  /**
   * A message carrying files.
   *
   * The desktop copies an attachment into the workspace at the PICK and sends
   * the path; a phone cannot, because the workspace is on the other side of a
   * relay. So the bytes travel here, at the send, and the ordering is what
   * keeps the two surfaces identical:
   *
   *   stage  — the picked files move into the local workspace, and the bubble
   *            is re-published with them, so the message on screen carries its
   *            pictures while the upload is still running
   *   upload — one file at a time; the desktop names each one and, for a first
   *            message, mints the conversation it lands in
   *   send   — the prompt goes with the desktop's own attachment metadata, so
   *            the stored message is byte-for-byte what a desktop send makes
   *
   * A file that fails says so and costs only itself; the prompt and the rest
   * of the files still go, exactly as a bad file costs only itself when it is
   * dropped on the desktop composer.
   */
  const sendWithFiles = useCallback(
    async (text: string, files: PickedFile[], settle: (id?: string) => void): Promise<void> => {
      const staged = await stageForSend(files)
      const optimistic = staged.map(stagedAttachment)
      if (optimistic.length > 0) {
        const user: ConversationMessage = {
          id: mintMessageId(),
          role: 'user',
          content: text,
          timestamp: Date.now(),
          attachments: optimistic
        }
        // A conversation that exists gets the row through the live turn, not
        // through the screen's own copy: buildFeed prefers `live.user`, and a
        // stream left over from a turn whose stored copy never arrived would
        // otherwise keep showing the PREVIOUS prompt for the whole upload.
        // A chat with no id yet has no stream to file it under.
        if (conversationId) beginTurn(conversationId, user)
        else setPendingUser(user)
      }
      // Every file failed to even reach the workspace, and there is no prompt
      // to send without them: there is no message here.
      if (staged.length === 0 && !text) {
        toast.show({ tone: 'error', message: t('chat.attach.error') })
        abandon(settle)
        return
      }

      try {
        if (paired && tunnelClient.connected) {
          const result = await uploadForSend(staged, conversationId)
          if (result.failed.length > 0) {
            toast.show({
              tone: 'error',
              message: t('chat.attach.failed', { names: result.failed.join(', ') })
            })
          }
          // Nothing landed and nothing was typed — sending would be an empty
          // prompt, which the desktop refuses anyway.
          if (result.attachments.length === 0 && !text) {
            abandon(settle)
            return
          }
          const sent = await sendPrompt({
            conversationId: result.conversationId ?? conversationId,
            text,
            attachments: result.attachments
          })
          settle(sent.conversationId)
          return
        }

        // Demo, or a paired phone that cannot reach its desktop right now: the
        // files are filed under the conversation's own uploads folder, in the
        // shape the desktop would have produced, so the feed has one kind of
        // attachment rather than two. Offline, sendPrompt writes the reply
        // that says why nothing answered and the desktop's copy replaces the
        // whole conversation once the link is back.
        let id = conversationId
        if (!id) id = await ensureDemoConversation(deriveTitle(text, optimistic))
        const attachments = await fileLocally(staged, id)
        if (paired) {
          const sent = await sendPrompt({ conversationId: id, text, attachments })
          settle(sent.conversationId)
          return
        }
        await sendDemoPrompt({ conversationId: id, text, attachments })
        settle(id)
      } catch {
        discardStaged(staged)
        abandon(settle)
      }
    },
    [conversationId, paired, toast, t, abandon]
  )

  /**
   * Carry one mid-turn message to the running turn. The bubble is already up
   * (interjectSubmit put it there at the tap); this stages and uploads its
   * files exactly as sendWithFiles and the voice branch of performSubmit do
   * for a normal send — re-publishing the bubble with each — then hands the
   * message to the desktop's inbox. Nothing here touches the turn on screen:
   * no beginTurn, no endStream, no `sending`. The turn being steered keeps
   * its overlay throughout, which is the whole point.
   *
   * Two ways it is NOT an interjection after all, both ending in a normal
   * send under the same id and with the files already uploaded: the desktop
   * reports no live turn (it ended in the sliver between the tap and the
   * hand-over), or it predates the method. A failed transfer, or a desktop
   * that refused, drops the bubble and hands the words back to the composer.
   *
   * DEMO takes the same road with the turn runner on this phone: the files
   * are filed locally instead of uploaded (sendWithFiles' own demo branch)
   * and the message parks on the running demo turn, which reads it at its
   * stop point. It is not a second turn there either — two demo turns in one
   * conversation would fight over one live stream.
   */
  const deliverInterjection = useCallback(
    async (cid: string, messageId: string, payload: ComposerSubmit): Promise<void> => {
      const runtime = useChatRuntime.getState()
      let text = payload.kind === 'text' ? payload.text : ''
      deliveringRef.current.set(messageId, text)
      const giveBack = (): void => {
        deliveringRef.current.delete(messageId)
        runtime.dropPending(cid, messageId)
        if (text) runtime.restoreDraft(cid, text)
        toast.show({ tone: 'error', message: t('chat.interject.failed') })
      }
      /** Every early exit that is not a give-back still ends the window. */
      const settled = (): void => void deliveringRef.current.delete(messageId)
      /**
       * Taken back while the bytes were still moving. The row came down and
       * the words went back at the tap (handleWithdraw), so this delivery
       * simply stops — and stops BEFORE re-publishing the row with its files,
       * or the bubble the user just dismissed would come back for as long as
       * the upload runs and then vanish again.
       */
      const takenBack = (): boolean => {
        if (!withdrawnRef.current.delete(messageId)) return false
        settled()
        return true
      }
      try {
        let attachments: MessageAttachment[] = []
        let voicePrompt = false
        if (payload.kind === 'text' && payload.files.length > 0) {
          const staged = await stageForSend(payload.files)
          if (takenBack()) {
            discardStaged(staged)
            return
          }
          const optimistic = staged.map(stagedAttachment)
          if (optimistic.length > 0) {
            runtime.putPending(cid, {
              id: messageId,
              role: 'user',
              content: text,
              timestamp: Date.now(),
              attachments: optimistic
            })
          }
          if (staged.length === 0 && !text) {
            toast.show({ tone: 'error', message: t('chat.attach.error') })
            settled()
            runtime.dropPending(cid, messageId)
            return
          }
          if (!paired) {
            // Demo: the workspace is this phone, so the files are already
            // where they are going — the same local filing sendWithFiles does.
            attachments = await fileLocally(staged, cid)
          } else {
            if (!tunnelClient.connected) {
              discardStaged(staged)
              giveBack()
              return
            }
            const result = await uploadForSend(staged, cid)
            if (result.failed.length > 0) {
              toast.show({
                tone: 'error',
                message: t('chat.attach.failed', { names: result.failed.join(', ') })
              })
            }
            if (result.attachments.length === 0 && !text) {
              settled()
              runtime.dropPending(cid, messageId)
              return
            }
            attachments = result.attachments
          }
        } else if (payload.kind === 'voice') {
          const timestamp = Date.now()
          const name = `voice-${timestamp}.m4a`
          const staged = await stageOutgoingFile(payload.uri, `voice_${timestamp}`, name)
          if (!staged) {
            toast.show({ tone: 'error', message: t('chat.voice.error') })
            settled()
            runtime.dropPending(cid, messageId)
            return
          }
          runtime.putPending(cid, {
            id: messageId,
            role: 'user',
            content: '',
            timestamp,
            voicePrompt: true,
            attachments: [
              {
                type: 'audio',
                filePath: staged.relPath,
                originalName: name,
                mimeType: 'audio/mp4',
                sizeBytes: staged.sizeBytes,
                durationSeconds: payload.durationSeconds
              }
            ]
          })
          if (!paired) {
            // Demo: no upload and no transcription — the recording lands in
            // the conversation's own uploads folder, in the shape the desktop
            // would have produced, exactly as performSubmit's voice branch
            // files it.
            const relPath = `uploads/conv-${cid}/${name}`
            await importLocalFile(staged.uri, relPath, cid)
            discardStagedFile(staged.relPath)
            attachments = [
              {
                type: 'audio',
                filePath: relPath,
                originalName: name,
                mimeType: 'audio/mp4',
                sizeBytes: staged.sizeBytes,
                durationSeconds: payload.durationSeconds
              }
            ]
          } else {
            let uploaded: Awaited<ReturnType<typeof uploadFileToDesktop>> = null
            try {
              uploaded = await uploadFileToDesktop(staged.uri, name, 'audio/mp4', cid)
            } catch {
              uploaded = null
            }
            if (!uploaded) {
              discardStagedFile(staged.relPath)
              settled()
              runtime.dropPending(cid, messageId)
              toast.show({ tone: 'error', message: t('chat.voice.error') })
              return
            }
            await importLocalFile(staged.uri, uploaded.attachment.filePath, uploaded.conversationId)
            discardStagedFile(staged.relPath)
            attachments = [{ ...uploaded.attachment, durationSeconds: payload.durationSeconds }]
          }
          voicePrompt = true
          // The desktop transcribes; the text this phone holds for a give-back
          // is nothing, so a failed voice hand-over is a toast, not a draft.
          text = ''
        }
        deliveringRef.current.set(messageId, text)
        if (takenBack()) return
        if (!paired) {
          settled()
          // Parked on the running demo turn, which reads it at its stop
          // point. No turn left to park it on — it ended while the files were
          // being filed — and it is simply the next demo prompt, under the
          // same id, so the bubble on screen becomes its stored copy.
          if (
            demoInterject(cid, { messageId, text, attachments, voicePrompt, timestamp: Date.now() })
          )
            return
          runtime.dropPending(cid, messageId)
          await sendDemoPrompt({ conversationId: cid, text, attachments, voicePrompt, messageId })
          return
        }
        settled()
        const result = await interject({
          conversationId: cid,
          messageId,
          text,
          attachments,
          voicePrompt
        })
        if (result.status === 'pending') {
          // Taken back while the desktop was still deciding — a window that
          // is a whole transcription long for a voice note. The withdraw that
          // went out then asked for a message the desktop did not have yet;
          // it has it now, so the ask is worth making again.
          if (withdrawnRef.current.delete(messageId)) void withdrawInterjection(cid, messageId)
          return
        }
        await sendPrompt({ conversationId: cid, text, attachments, voicePrompt, messageId })
      } catch {
        giveBack()
      }
    },
    [toast, t, paired]
  )

  /**
   * The id-less window closing. A first send came back — with the id the
   * held messages were waiting for, or without one (it failed): under an id
   * the bubbles move under it and each message goes to the turn it opened;
   * without, the words go back to the composer, since nothing ran.
   */
  const releaseHeld = useCallback(
    (id?: string): void => {
      const held = heldRef.current
      heldRef.current = []
      if (held.length === 0) return
      const runtime = useChatRuntime.getState()
      if (!id) {
        // The send failed, so no turn was ever opened for these to steer.
        // They go back to the composer of the chat they were written in —
        // which is the one that had no id only if it still has none.
        const key = conversationId ?? NEW_CHAT_PENDING_KEY
        runtime.clearPending(key)
        for (const item of held) {
          if (item.payload.kind === 'text' && item.payload.text) {
            runtime.restoreDraft(key, item.payload.text)
          }
        }
        return
      }
      runtime.movePending(NEW_CHAT_PENDING_KEY, id)
      for (const item of held) void deliverInterjection(id, item.messageId, item.payload)
    },
    [conversationId, deliverInterjection]
  )

  /**
   * Send one submit, now: the idle path. A mid-turn submit takes
   * interjectSubmit instead — see handleSubmit.
   */
  const performSubmit = useCallback(
    (payload: ComposerSubmit): void => {
      // The one case CSS can't cover on the desktop either: sending while
      // scrolled up. Re-pin at the send, before the message exists, so the
      // user always sees their own prompt and the reply that follows it.
      feedRef.current?.scrollToEnd()
      const attaching = payload.kind === 'text' && payload.files.length > 0
      // Everything visible about the send happens in THIS tick — before any
      // await — so the prompt and the thinking words are on screen from the tap
      // rather than from the reply. For a conversation that already exists,
      // sendPrompt opens the live turn itself; a new chat has nowhere to file
      // one yet, so the screen holds the prompt for that one round trip.
      //
      // Files make that round trip long — a video is a minute of chunks — and
      // they make it long for an EXISTING conversation too, since nothing is
      // sent until the last byte lands. So a message with attachments is always
      // held here, and re-published a moment later with its files (below) once
      // they have a path to render from.
      if (payload.kind === 'text' && (conversationId === null || attaching)) {
        setPendingUser({
          id: mintMessageId(),
          role: 'user',
          content: payload.text,
          timestamp: Date.now()
        })
      }
      sendingRef.current = true
      setSending(true)
      const generation = generationRef.current
      // Handing over is one state change, not three: by the time this runs the
      // live turn carries the prompt under the conversation's own id, so the
      // row the screen was holding is released in the same frame its
      // replacement appears.
      //
      // Unless the screen has moved on. A send survives the conversation it was
      // sent from — the user can open another one from the sheet mid-flight, and
      // the turn carries on running where it was sent — but everything below is
      // about THIS screen's state, and the conversation it now shows has its own.
      // Adopting a stale id here is how a settling send would yank the user back
      // into the chat they just left; clearing `sending` is how it would mark a
      // NEW send idle. Both are simply not this send's business any more.
      const settle = (id?: string): void => {
        if (generationRef.current !== generation) return
        sendingRef.current = false
        setPendingUser(null)
        setSending(false)
        if (id) setConversationId(id)
        releaseHeld(id)
      }
      void (async () => {
        if (payload.kind === 'text' && !attaching) {
          try {
            // Paired: the desktop runs the turn and streams it back. Demo: the
            // on-device stand-in answers. Same call site, same result shape.
            const id = paired
              ? (await sendPrompt({ conversationId, text: payload.text })).conversationId
              : await sendDemoPrompt({ conversationId, text: payload.text })
            settle(id)
          } catch {
            settle()
          }
          return
        }

        if (payload.kind === 'text') {
          await sendWithFiles(payload.text, payload.files, settle)
          return
        }
        // Voice note. Paired, the desktop owns the workspace: upload the
        // bytes first — the desktop names the file and, for a first message,
        // creates the conversation — keep a local copy under that same path
        // so playback never re-downloads, then send the message referencing
        // it. The desktop transcribes and runs the turn from there.
        //
        // The bubble does not wait for any of that. The recording is staged
        // into the workspace — a local move — and published exactly as a file
        // send publishes its pictures, so the transport is on screen from the
        // tap and the upload runs behind a message already rendering. The
        // re-publish under the desktop's own path is a cache hit.
        const timestamp = Date.now()
        const name = `voice-${timestamp}.m4a`
        const staged = await stageOutgoingFile(payload.uri, `voice_${timestamp}`, name)
        if (!staged) {
          // The recorder's file cannot be read — there is nothing to send.
          toast.show({ tone: 'error', message: t('chat.voice.error') })
          abandon(settle)
          return
        }
        const optimistic: ConversationMessage = {
          id: mintMessageId(timestamp),
          role: 'user',
          content: '',
          timestamp,
          voicePrompt: true,
          attachments: [
            {
              type: 'audio',
              filePath: staged.relPath,
              originalName: name,
              mimeType: 'audio/mp4',
              sizeBytes: staged.sizeBytes,
              durationSeconds: payload.durationSeconds
            }
          ]
        }
        // Same handover sendWithFiles makes: an existing conversation carries
        // the row on its live turn, a chat with no id yet has no stream to
        // file one under and the screen holds it for the round trip.
        if (conversationId) beginTurn(conversationId, optimistic)
        else setPendingUser(optimistic)
        try {
          if (paired) {
            let uploaded: Awaited<ReturnType<typeof uploadFileToDesktop>> = null
            try {
              uploaded = await uploadFileToDesktop(staged.uri, name, 'audio/mp4', conversationId)
            } catch {
              uploaded = null // a broken transfer keeps the recording local, like offline
            }
            if (uploaded) {
              await importLocalFile(
                staged.uri,
                uploaded.attachment.filePath,
                uploaded.conversationId
              )
              discardStagedFile(staged.relPath)
              // The optimistic id rides along, so the desktop-path copy
              // REPLACES the bubble already on screen instead of remounting
              // it — and the stored transcript later supersedes both by the
              // same id.
              const result = await sendPrompt({
                conversationId: uploaded.conversationId,
                text: '',
                attachments: [{ ...uploaded.attachment, durationSeconds: payload.durationSeconds }],
                voicePrompt: true,
                messageId: optimistic.id
              })
              settle(result.conversationId)
              return
            }
          }
          // Demo — or a paired phone that cannot reach its desktop right now:
          // file the recording locally under the conversation's uploads dir and
          // send the same attachment shape. Offline the reply says why nothing
          // answers, and the local conversation is pruned when the real list
          // resyncs.
          let id = conversationId
          if (!id) id = await ensureDemoConversation(t('chat.voice.record'))
          const relPath = `uploads/conv-${id}/${name}`
          await importLocalFile(staged.uri, relPath, id)
          discardStagedFile(staged.relPath)
          const attachments = [
            {
              type: 'audio' as const,
              filePath: relPath,
              originalName: name,
              mimeType: 'audio/mp4',
              sizeBytes: staged.sizeBytes,
              durationSeconds: payload.durationSeconds
            }
          ]
          if (paired) {
            const result = await sendPrompt({
              conversationId: id,
              text: '',
              attachments,
              voicePrompt: true,
              messageId: optimistic.id
            })
            settle(result.conversationId)
            return
          }
          await sendDemoPrompt({
            conversationId: id,
            text: '',
            attachments,
            voicePrompt: true,
            messageId: optimistic.id
          })
          settle(id)
        } catch {
          // The send never happened; the bubble published above comes down
          // with it, like a file send's does.
          discardStagedFile(staged.relPath)
          abandon(settle)
        }
      })()
    },
    [conversationId, paired, t, toast, abandon, sendWithFiles, releaseHeld]
  )

  /**
   * A submit while a turn is running: into that turn. The bubble goes up in
   * THIS tick under the id the desktop will echo back — the same tap-to-screen
   * rule as a normal send — and the hand-over runs behind it. A chat with no
   * id yet has no turn to hand it to; the payload waits in `heldRef` for the
   * first send's answer (releaseHeld), its bubble already showing.
   */
  const interjectSubmit = useCallback(
    (payload: ComposerSubmit): void => {
      feedRef.current?.scrollToEnd()
      const timestamp = Date.now()
      const messageId = mintMessageId(timestamp)
      const key = conversationId ?? NEW_CHAT_PENDING_KEY
      useChatRuntime
        .getState()
        .putPending(
          key,
          payload.kind === 'text'
            ? { id: messageId, role: 'user', content: payload.text, timestamp }
            : { id: messageId, role: 'user', content: '', timestamp, voicePrompt: true }
        )
      if (!conversationId || sendingRef.current) {
        heldRef.current.push({ messageId, payload })
        return
      }
      void deliverInterjection(conversationId, messageId, payload)
    },
    [conversationId, deliverInterjection]
  )

  /**
   * What the composer hands over. Idle it goes as a turn; mid-turn it goes
   * INTO the turn.
   *
   * "Mid-turn" is `streaming`, which is both a turn running in this
   * conversation — this phone's, the desktop's, a channel's — and a send of
   * this screen's own that has not come back yet — including one handed over
   * in THIS frame, which `sending` cannot report yet and `sendingRef` can.
   * That second half matters: without it a fast second tap would race the
   * first send's round trip, and the two prompts would reach the desktop in
   * whichever order the network settled on.
   *
   * Demo runs its agent on this phone, and steers the same way: the turn
   * runner is demo/agent.ts and the inbox is its own (demoInterject). It is
   * NOT exempted here — a demo mid-turn submit that fell through to
   * performSubmit would start a SECOND demo turn in the conversation, and the
   * two would share one live stream and one timer entry: whichever finished
   * first would end the other's overlay, leaving a reply with no card and a
   * Stop that stops nothing.
   */
  const handleSubmit = useCallback(
    (payload: ComposerSubmit): void => {
      if (streaming || sendingRef.current) {
        interjectSubmit(payload)
        return
      }
      performSubmit(payload)
    },
    [streaming, interjectSubmit, performSubmit]
  )

  /**
   * Take a pending message back — and with it, the words.
   *
   * WHO GIVES THEM BACK is whoever holds the message at that moment, and the
   * rule is the same every time: the give-back belongs to the last surface
   * that actually has it. Held for an id, or still uploading, it never left
   * this screen and the answer is local. Parked on the demo turn, the demo
   * runner hands it over. Parked on the desktop, the desktop decides — the
   * agent may have read it a beat ago — and its `withdrawn` push is the
   * give-back, with sync/prompt.ts covering the case where that push can
   * never come because the ask never landed.
   */
  const handleWithdraw = useCallback(
    (messageId: string): void => {
      const runtime = useChatRuntime.getState()
      const giveBackLocally = (key: string, text: string | undefined): void => {
        runtime.dropPending(key, messageId)
        if (text) runtime.restoreDraft(key, text)
      }
      if (!conversationId) {
        const index = heldRef.current.findIndex((item) => item.messageId === messageId)
        if (index < 0) return
        const [item] = heldRef.current.splice(index, 1)
        giveBackLocally(
          NEW_CHAT_PENDING_KEY,
          item.payload.kind === 'text' ? item.payload.text : undefined
        )
        return
      }
      // Still on its way over: the files are moving and nobody downstream has
      // been told this message exists, so no push and no runner answer is
      // coming for it. The delivery reads `withdrawnRef` and stands down.
      const inFlight = deliveringRef.current.get(messageId)
      if (inFlight !== undefined) {
        withdrawnRef.current.add(messageId)
        deliveringRef.current.delete(messageId)
        giveBackLocally(conversationId, inFlight)
        return
      }
      if (!paired) {
        // Nothing parked means the demo turn read it a beat ago: the row is
        // still down, and the words are in the transcript rather than owed
        // back. Either way the bubble ends here — a withdraw must never
        // leave one on screen with its X still asking to be pressed.
        const parked = withdrawDemoInterjection(conversationId, messageId)
        giveBackLocally(conversationId, parked && !parked.voicePrompt ? parked.text : undefined)
        return
      }
      withdrawnRef.current.add(messageId)
      void withdrawInterjection(conversationId, messageId)
    },
    [conversationId, paired]
  )

  /**
   * The desktop's retry, verbatim: not a re-send of the failed prompt but a
   * fresh continuation turn told what broke, so the model checks what already
   * completed instead of redoing it. Dropped, never queued, while anything is
   * in flight — the button only renders idle, so this guard is the double-tap.
   */
  const handleTryAgain = useCallback(
    (reason: string): void => {
      if (streaming || sendingRef.current) return
      performSubmit({
        kind: 'text',
        text: t('errors.provider.tryAgainMessage', { reason }),
        files: []
      })
    },
    [streaming, performSubmit, t]
  )

  const handleStop = useCallback((): void => {
    if (!conversationId) return
    // Paired, the turn runs on the desktop — stopping is an RPC, not a local
    // timer. Demo turns stay the demo agent's to cancel.
    if (paired) void abortTurn(conversationId)
    else stopDemoTurn(conversationId)
  }, [conversationId, paired])

  /**
   * Back to an empty chat. A turn still running in the conversation being left
   * keeps its own live entry, keyed by its id — leaving is not stopping. What
   * must not follow the user is this screen's copy of the last prompt, or
   * mid-turn messages still waiting for a conversation id that will now
   * never be theirs.
   *
   * Shared with project mode, whose two actions both land here: another
   * conversation in the project, and closing the project (which has already
   * cleared it by the time this runs).
   */
  const startNewChat = useCallback((): void => {
    setPendingUser(null)
    sendingRef.current = false
    setSending(false)
    heldRef.current = []
    useChatRuntime.getState().clearPending(NEW_CHAT_PENDING_KEY)
    setConversationId(null)
    // Both, deliberately. `opened` re-gates the feed and is what the effect
    // above keys on; `conversationId` is what the screen actually sends into,
    // and after a first send the two differ (a new chat mints an id without
    // ever being "opened"). Clearing only one of them is how "new chat" from a
    // chat that had already been sent into ended up back in it.
    setOpened(null)
  }, [])

  /**
   * Open another conversation, in place. The sheet asks; this decides.
   *
   * Nothing is torn down here beyond what the `opened` effect resets: a turn
   * running in the conversation being left keeps writing into chatRuntime under
   * its own id, so coming back to it — from the sheet, moments or minutes later
   * — finds it exactly where it was. That is what makes concurrent conversations
   * work on the phone the way they do on the desktop.
   */
  const openConversation = useCallback(
    (id: string): void => {
      // Already here. Re-gating the feed for it would put a skeleton over a
      // transcript that is already on screen.
      if (id === conversationId) return
      setOpened(id)
    },
    [conversationId]
  )

  /**
   * Entering — or leaving — a project starts a fresh conversation in it.
   *
   * One rule in one place, because there are two ways in (the Projects screen and
   * the chat menu's picker) and both live on other screens: this screen owns the
   * open conversation, so it is the only thing that can put it down. Why it must:
   * a project's instructions are the base a conversation starts FROM, and every
   * turn of a conversation created outside the project runs without them — so
   * carrying the chat you were already in into a project would show its chrome
   * over turns that never received it.
   *
   * On the CHANGE, never on the value: opening a project's conversation from
   * History must not bounce you out of the transcript you just asked for. The ref
   * seeds from the first render, and project mode is not persisted, so a launch
   * can never arrive already inside one.
   */
  const seenProjectRef = useRef(activeProjectId)
  useEffect(() => {
    if (seenProjectRef.current === activeProjectId) return
    seenProjectRef.current = activeProjectId
    startNewChat()
  }, [activeProjectId, startNewChat])

  /**
   * A procedure's run: the prompt is left in the runtime by the Procedures
   * screen and sent from HERE, because this screen owns sending — it holds the
   * live turn and the optimistic bubble, and a prompt sent behind its back
   * would render as a reply to nothing.
   *
   * TWO PHASES, and the split is the whole point. `startNewChat` clears the open
   * conversation through state, so it is only true from the next commit —
   * submitting in the same tick would read the conversation the user was looking
   * at and send the procedure INTO it. So the first phase resets and the second
   * fires once the reset has actually landed (`conversationId === null`), which
   * is also when performSubmit's own closure sees the empty chat.
   *
   * Taken from the store rather than read, so it is consumed exactly once even
   * though both effects re-run on every render that follows.
   */
  const pendingPrompt = useChatRuntime((state) => state.pendingPrompt)
  useEffect(() => {
    if (pendingPrompt === null || conversationId === null) return
    startNewChat()
  }, [pendingPrompt, conversationId, startNewChat])
  useEffect(() => {
    if (pendingPrompt === null || conversationId !== null) return
    useChatRuntime.getState().setPendingPrompt(null)
    performSubmit({ kind: 'text', text: pendingPrompt, files: [] })
  }, [pendingPrompt, conversationId, performSubmit])

  // Emptiness is a property of the FEED, not of the stored transcript: a turn
  // in flight is on screen whether or not anything has been saved for it yet,
  // and that is what keeps a fresh send out of both the hero and the skeleton.
  const empty = feed.length === 0
  // Whether this screen has shown rows for the CURRENT `opened` (reset with
  // the gate). A ref written during render, deliberately: the fact is needed
  // in the same frame the rows appear, and it subscribes to nothing.
  if (!empty) hadRowsRef.current = true
  // Reading the conversation out of SQLite is async, so an opened conversation
  // has no messages for a frame or two. Show placeholders rather than letting
  // it fall through to the new-chat hero and snap to the feed.
  //
  // `isFetching` covers the second case: a paired conversation opened before
  // its body has been downloaded is present but empty, and the download that
  // fills it is a *refetch* — the data is no longer undefined, so the first
  // test alone would show an empty transcript while the messages are on their
  // way. Only when there is nothing to show yet: a conversation that is
  // genuinely empty stays empty while a background refresh runs.
  const loading =
    empty && conversationId !== null && (conversation === undefined || conversationFetching)
  // A transcript that VANISHED: this screen showed rows for this conversation
  // and now holds a present-but-empty copy. Nothing in the product empties a
  // conversation in place, so this is always a sync transient mid-heal (a
  // fetch that raced a desktop-side write) — never a state to draw as final.
  // Without it, the one frame the machine had for this was the worst one: the
  // hero needs `!loading`, the skeleton needed `!feedRevealed`, and a feed
  // with no rows paints nothing — the pure-blank chat reported 2026-08-26,
  // opened from a notification mid-run. A conversation the query answers
  // `null` for is genuinely gone and falls through to the hero as ever.
  const vanished = empty && hadRowsRef.current && conversation != null

  // The skeleton stands in for the whole opening sequence, not just the read:
  // it stays up while the body arrives AND while the laid-out feed is pinning
  // itself to the end behind it (ChatFeed.onReady) — and it comes BACK over
  // any later empty-but-unsettled frame (`loading` after reveal, `vanished`),
  // so no ordering of fetches and invalidations can ever paint a blank
  // transcript. A conversation that settles as genuinely empty resolves to
  // the hero — `loading` and `vanished` both false, nothing to lay out.
  const showSkeleton = (!feedRevealed && !empty) || (empty && (loading || vanished))

  return (
    // No top padding, and no top bar: the transcript owns the whole column and
    // runs under the status bar, with the two floating controls (below) laid
    // over it. What keeps the first message clear of them is padding INSIDE the
    // scroller, which is also what lets the conversation pass beneath them.
    <View className="bg-bg flex-1">
      {/* One per screen, not one per message: every bubble and tool card can
          open it, and it holds whichever text was long-pressed last. */}
      <SelectTextHost />
      {/* 'padding' on BOTH platforms. The app runs edge-to-edge on Android,
          where the window ignores adjustResize and the keyboard just paints
          over the composer — so RN has to do the lifting there exactly as it
          does on iOS. */}
      <KeyboardAvoidingView behavior="padding" className="flex-1" keyboardVerticalOffset={0}>
        <View className="flex-1">
          {empty && !loading && !vanished ? (
            // Project mode swaps the wolffish hero for the project's own
            // identity — emoji, title, and its instructions in the same
            // recessed block the cards use — because that IS what a new
            // conversation here starts from. The desktop makes the same swap.
            <View className="flex-1 items-center justify-center gap-4 px-8">
              {activeProject ? (
                <Text className="text-6xl leading-[64px]">
                  {activeProject.icon || DEFAULT_PROJECT_ICON}
                </Text>
              ) : (
                <Image
                  source={require('@/assets/images/icon-trans.png')}
                  style={{ width: 80, height: 80 }}
                  contentFit="contain"
                />
              )}
              <Text className="text-fg font-sans-semibold text-center text-2xl">
                {activeProject
                  ? activeProject.title.trim() || t('projects.untitled')
                  : t('chat.empty.title')}
              </Text>
              {activeProject ? (
                activeProject.instructions.trim() ? (
                  <View className="w-full">
                    <PromptPreview
                      value={activeProject.instructions}
                      empty={t('projects.noInstructions')}
                      maxHeight={140}
                      // The hero has no card around it, so the block takes the
                      // card colour rather than the recessed one.
                      onSurface
                    />
                  </View>
                ) : null
              ) : (
                <Text className="text-muted text-center font-sans text-sm leading-relaxed">
                  {t('chat.empty.subtitle')}
                </Text>
              )}
            </View>
          ) : (
            <ChatFeed
              // A different conversation is a different scroll position and a
              // different gate; keying on the opened id restarts both.
              key={opened ?? 'new'}
              ref={feedRef}
              gated={opened !== null}
              // The gate opens on rows, never on the empty feed that stands
              // here for the frames before the transcript arrives — that is
              // the window the skeleton is covering.
              hasContent={!empty}
              // Clearance for the floating controls, which the transcript
              // scrolls under rather than stopping below.
              topInset={insets.top + FLOATING_AREA}
              // Streamed growth is glued to the end, not eased — see ChatFeed.
              streaming={streaming}
              onReady={() => setFeedRevealed(true)}
            >
              {feed.map((item) =>
                item.pending ? (
                  <PendingInterjectionBubble
                    key={item.key}
                    message={item.message}
                    conversationId={conversationId ?? undefined}
                    onWithdraw={() => handleWithdraw(item.key)}
                  />
                ) : item.message.role === 'user' ? (
                  <UserBubble
                    key={item.key}
                    message={item.message}
                    conversationId={conversationId ?? undefined}
                  />
                ) : (
                  <AssistantMessageView
                    key={item.key}
                    message={item.message}
                    conversationId={conversationId ?? undefined}
                    verbose={verbose}
                    todoLists={todoLists}
                    browserCards={browserCards}
                    streaming={item.streaming}
                    // The in-flight turn's row is the one that hosts the
                    // conversation's live ask/approval cards.
                    liveTurn={item.key === LIVE_KEY}
                    liveError={item.key === LIVE_KEY && live?.status === 'error'}
                    // Present only on the last row when it is a failed turn
                    // and no turn is running — the desktop's own predicate.
                    onTryAgain={
                      item === lastItem && lastFailed && !streaming && idle
                        ? handleTryAgain
                        : undefined
                    }
                  />
                )
              )}
            </ChatFeed>
          )}
          {showSkeleton && (
            // Fades out as the feed fades in — one cross-dissolve, so the
            // placeholders resolve into the messages they stood in for
            // instead of being replaced by them.
            <Animated.View exiting={FadeOut.duration(FEED_FADE_MS)} style={StyleSheet.absoluteFill}>
              <ChatSkeleton />
            </Animated.View>
          )}
        </View>

        <View style={{ paddingBottom: insets.bottom }}>
          <Composer
            streaming={streaming}
            conversation={conversation}
            conversationId={conversationId}
            onSubmit={handleSubmit}
            onStop={handleStop}
            onNewConversation={startNewChat}
          />
        </View>
      </KeyboardAvoidingView>

      {/* Last, so they paint over the transcript and the skeleton alike. The
          navigator on the leading edge, a new chat on the trailing one — the
          only two things the header held that were worth a fixed strip. */}
      <FloatingChrome
        top={insets.top + FLOATING_GAP}
        conversationId={conversationId}
        onOpenSheet={() => setSheetOpen(true)}
        onOpenNotifications={() => setNotificationsOpen(true)}
        onNewChat={startNewChat}
      />
      <ConversationsSheet
        open={sheetOpen}
        onClose={() => setSheetOpen(false)}
        activeId={conversationId}
        onSelect={openConversation}
      />
      {/* What this conversation has notified about, from the opposite edge.
          Only reachable when the bell is there, which is only when it has
          something to list — and keyed to the conversation, so switching
          conversations under an open sheet cannot leave the other one's
          notifications on screen. */}
      {conversationId && (
        <ConversationNotificationsSheet
          key={conversationId}
          open={notificationsOpen}
          onClose={() => setNotificationsOpen(false)}
          conversationId={conversationId}
        />
      )}
    </View>
  )
}
