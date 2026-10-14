import { mapConversationMessages } from '@lib/conversation-open'
import { useFlow } from '@providers/flow/useFlow'
import { useSessions } from '@providers/sessions/useSessions'
import { useEffect, useRef } from 'react'

/**
 * Web only. A notification tap (or a pasted link) lands on
 * `/?conversation=<id>`: open that conversation. The service worker relays
 * taps on an already-open tab as a `wolffish:open` event carrying the same
 * URL, handled the same way.
 *
 * The address bar then follows the open conversation, so a reload — a phone
 * refreshing a backgrounded tab, an update, a dev rebuild — lands back in it
 * (live, if its run is still going) instead of on an empty chat while the
 * run carries on out of sight.
 */
export function WebDeeplink(): null {
  const { openConversation, activateConversation, activeConversationId } = useSessions()
  const { goTo } = useFlow()

  // Read through a ref: both callbacks change identity whenever the session
  // list does — i.e. on every conversation switch — and re-running the effect
  // then re-read the address bar, still naming the conversation being left,
  // and switched straight back to it.
  const actions = useRef({ openConversation, activateConversation, goTo })
  useEffect(() => {
    actions.current = { openConversation, activateConversation, goTo }
  }, [openConversation, activateConversation, goTo])

  // Until the landing link's conversation is open, the null active id is the
  // pre-restore state, not a new chat: clearing the query then would erase
  // the id the open effect is still loading.
  const restoring = useRef(location.search.includes('conversation='))

  useEffect(() => {
    let disposed = false
    const open = async (search: string, show: boolean): Promise<void> => {
      const id = new URLSearchParams(search).get('conversation')
      if (!id) return
      if (show) actions.current.goTo('chat')
      if (actions.current.activateConversation(id)) return
      const conversation = await window.api.conversation.load(id)
      if (disposed) return
      if (!conversation) {
        restoring.current = false
        return
      }
      actions.current.openConversation(conversation, mapConversationMessages(conversation))
    }
    // On load the screen is FlowProvider's call — the changelog after an
    // update, onboarding, the disk gate — so the conversation opens behind it.
    if (location.search.includes('conversation=')) void open(location.search, false)
    const onOpen = (event: Event): void => {
      const url = (event as CustomEvent<{ url: string }>).detail?.url
      if (!url) return
      const qs = url.indexOf('?')
      void open(qs >= 0 ? url.slice(qs) : '', true)
    }
    window.addEventListener('wolffish:open', onOpen)
    return () => {
      disposed = true
      window.removeEventListener('wolffish:open', onOpen)
    }
  }, [])

  useEffect(() => {
    if (restoring.current) {
      if (activeConversationId === null) return
      restoring.current = false
    }
    const want = activeConversationId
      ? `?conversation=${encodeURIComponent(activeConversationId)}`
      : ''
    if (location.search !== want) history.replaceState(history.state, '', location.pathname + want)
  }, [activeConversationId])

  return null
}
