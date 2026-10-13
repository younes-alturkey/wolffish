import { mapConversationMessages } from '@lib/conversation-open'
import { useFlow } from '@providers/flow/useFlow'
import { useSessions } from '@providers/sessions/useSessions'
import { useEffect } from 'react'

/**
 * Web only. A notification tap (or a pasted link) lands on
 * `/?conversation=<id>`: open that conversation and clean the address bar.
 * The service worker relays taps on an already-open tab as a `wolffish:open`
 * event carrying the same URL, handled the same way.
 */
export function WebDeeplink(): null {
  const { openConversation, activateConversation } = useSessions()
  const { goTo } = useFlow()

  useEffect(() => {
    let disposed = false
    const open = async (search: string): Promise<void> => {
      const id = new URLSearchParams(search).get('conversation')
      if (!id) return
      goTo('chat')
      if (activateConversation(id)) return
      const conversation = await window.api.conversation.load(id)
      if (disposed || !conversation) return
      openConversation(conversation, mapConversationMessages(conversation))
    }
    if (location.search.includes('conversation=')) {
      void open(location.search)
      history.replaceState(null, '', location.pathname)
    }
    const onOpen = (event: Event): void => {
      const url = (event as CustomEvent<{ url: string }>).detail?.url
      if (!url) return
      const qs = url.indexOf('?')
      void open(qs >= 0 ? url.slice(qs) : '')
    }
    window.addEventListener('wolffish:open', onOpen)
    return () => {
      disposed = true
      window.removeEventListener('wolffish:open', onOpen)
    }
  }, [openConversation, activateConversation, goTo])

  return null
}
