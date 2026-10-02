import { isStartPage, startPageUrl } from '@components/common/browser-card/start-page'
import type { BrowserTabSnapshot } from '@preload/index'
import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

/**
 * The conversation's browser, as the renderer sees it: its tabs, which one is
 * showing, and everything the chrome can do to them. Main owns the truth
 * (tabs, the active one, navigation); this keeps a live copy from the
 * browser:changed / browser:closed pushes and hands actions straight back.
 *
 * Shared by the chat card and the expanded sheet, which is what makes them
 * the same browser at two sizes rather than two browsers.
 */
export type ConversationBrowser = {
  tabs: BrowserTabSnapshot[]
  /** The tab on show: main's active flag, else the newest. Null when none. */
  active: BrowserTabSnapshot | null
  /** False until main has answered the first listTabs. */
  loaded: boolean
  activate: (tabId: string) => void
  newTab: () => Promise<void>
  closeTab: (tabId: string) => void
  closeAll: () => void
  navigate: (url: string) => void
  goBack: () => void
  goForward: () => void
  reload: () => void
}

export function useConversationBrowser(scope: {
  conversationId: string | null
  /** Fallback identity for a tab that has no conversation. */
  tabId?: string
  /** A snapshot to show before the first list answers (the card's segment). */
  seed?: BrowserTabSnapshot
}): ConversationBrowser {
  const { t, i18n } = useTranslation()
  const { conversationId, tabId, seed } = scope
  const [tabs, setTabs] = useState<BrowserTabSnapshot[]>(seed ? [seed] : [])
  const [loaded, setLoaded] = useState(false)

  const mine = useCallback(
    (s: BrowserTabSnapshot): boolean =>
      conversationId !== null ? s.conversationId === conversationId : s.tabId === tabId,
    [conversationId, tabId]
  )

  useEffect(() => {
    let cancelled = false
    void window.api.browser
      .listTabs()
      .then((all) => {
        if (cancelled) return
        setTabs(all.filter(mine))
        setLoaded(true)
      })
      .catch(() => {
        if (!cancelled) setLoaded(true)
      })
    const offChanged = window.api.browser.onChanged((s) => {
      if (!mine(s)) return
      setTabs((prev) =>
        prev.some((x) => x.tabId === s.tabId)
          ? prev.map((x) => (x.tabId === s.tabId ? s : x))
          : [...prev, s]
      )
    })
    const offClosed = window.api.browser.onClosed((p) => {
      setTabs((prev) => prev.filter((x) => x.tabId !== p.tabId))
    })
    return () => {
      cancelled = true
      offChanged()
      offClosed()
    }
  }, [mine])

  const active = tabs.find((x) => x.active) ?? tabs[tabs.length - 1] ?? null
  const activeId = active?.tabId ?? null

  const newTab = useCallback(async (): Promise<void> => {
    const url = startPageUrl({
      title: t('chat.browser.startTitle'),
      chip: t('chat.browser.startChip'),
      subtitle: t('chat.browser.startTagline'),
      lang: i18n.language,
      dir: i18n.dir() === 'rtl' ? 'rtl' : 'ltr'
    })
    await window.api.browser.createTab({ url, conversationId })
  }, [conversationId, t, i18n])

  return {
    tabs,
    active,
    loaded,
    activate: (id) => void window.api.browser.activate(id),
    newTab,
    closeTab: (id) => void window.api.browser.closeTab(id),
    closeAll: () => {
      for (const x of tabs) void window.api.browser.closeTab(x.tabId)
    },
    navigate: (url) => activeId && void window.api.browser.navigate(activeId, url),
    goBack: () => activeId && void window.api.browser.goBack(activeId),
    goForward: () => activeId && void window.api.browser.goForward(activeId),
    reload: () => activeId && void window.api.browser.reload(activeId)
  }
}

/** The address field's text for a tab: nothing for the start page. */
export function addressOf(tab: BrowserTabSnapshot | null): string {
  if (!tab || isStartPage(tab.url)) return ''
  return tab.url
}

/** A tab's label in the strip. Chromium titles an untitled page with its URL. */
export function labelOf(tab: BrowserTabSnapshot, startTitle: string): string {
  if (isStartPage(tab.url)) return startTitle
  const title = tab.title === tab.url ? '' : tab.title
  if (title) return title
  try {
    return new URL(tab.url).host || tab.url
  } catch {
    return tab.url
  }
}
