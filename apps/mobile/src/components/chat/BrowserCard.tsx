import { Copy01Icon, Globe02Icon, LinkSquare02Icon, Tick02Icon } from '@/components/core/icons'
import type { BrowserTabSnapshot } from '@/lib/conversations/types'
import { useWorkspaceFile } from '@/lib/files/useWorkspaceFile'
import { cn } from '@/lib/utils/cn'
import * as Clipboard from 'expo-clipboard'
import { Image } from 'expo-image'
import * as WebBrowser from 'expo-web-browser'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Linking, Pressable, ScrollView, Text, View } from 'react-native'

/**
 * The conversation's in-app browser, on the phone — read-only, the mobile
 * twin of the desktop's BrowserCard. Nothing browses here: the card is the
 * desktop's chrome (logo, tab strip, address) over a STILL of the page the
 * desktop is showing, pushed as a workspace file whenever that page settles
 * (browser.changed). One card per conversation, at the latest turn that used
 * the browser — segments.ts latestBrowserCards, the desktop's rule mirrored.
 *
 * A public, healthy URL opens live on tap in the system in-app browser
 * (expo-web-browser, the same one the app's own links use) and can be handed
 * to the phone's default browser. A page only the desktop can reach —
 * localhost, a private network, a start page, or one the desktop reports
 * down — keeps the still and says so; the URL can be copied.
 */

const STILL_ASPECT = 651 / 340 // the desktop card's viewport

/** True when the page is on the public internet — the phone can open it. */
export function isPublicUrl(url: string): boolean {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return false
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false
  const host = parsed.hostname.toLowerCase()
  if (
    host === 'localhost' ||
    host === '0.0.0.0' ||
    host === '::1' ||
    host === '[::1]' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host.endsWith('.internal') ||
    !host.includes('.')
  ) {
    return false
  }
  const m = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(host)
  if (m) {
    const [a, b] = [Number(m[1]), Number(m[2])]
    if (a === 10 || a === 127 || a === 0) return false
    if (a === 192 && b === 168) return false
    if (a === 172 && b >= 16 && b <= 31) return false
    if (a === 169 && b === 254) return false
  }
  return true
}

function hostOf(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return ''
  }
}

function isStartPage(url: string): boolean {
  return url.startsWith('data:')
}

export function BrowserCard({
  snapshot,
  conversationId
}: {
  snapshot: BrowserTabSnapshot
  conversationId?: string
}): React.JSX.Element {
  const { t } = useTranslation()
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (!copied) return
    const id = setTimeout(() => setCopied(false), 1500)
    return () => clearTimeout(id)
  }, [copied])

  // The strip is the browser; the snapshot's own tab may not be the one on
  // show. Draw the active entry, falling back to the snapshot itself.
  const strip = snapshot.strip?.length
    ? snapshot.strip
    : [{ url: snapshot.url, title: snapshot.title, active: true }]
  const active = strip.find((x) => x.active) ?? strip[strip.length - 1]
  const url = active.url
  const start = isStartPage(url)
  const live = !start && isPublicUrl(url) && snapshot.loadState !== 'error'
  const host = hostOf(url)
  // A still is a workspace file the desktop wrote — except in the demo
  // dataset, where it is a published image: an http(s) still is used as-is.
  const remoteStill = snapshot.still && /^https?:\/\//.test(snapshot.still) ? snapshot.still : null
  const file = useWorkspaceFile(remoteStill ? null : snapshot.still, conversationId)
  const uri = remoteStill ?? file.uri
  const loading = remoteStill ? false : file.loading

  const openLive = (): void => {
    if (!live) return
    void WebBrowser.openBrowserAsync(url).catch(() => Linking.openURL(url).catch(() => undefined))
  }
  const copy = (): void => {
    void Clipboard.setStringAsync(url).then(() => setCopied(true))
  }

  const chip = 'text-muted hover:text-fg items-center justify-center rounded p-1'

  return (
    <View className="bg-surface border-border w-[85%] flex-col self-start overflow-hidden rounded-xl border">
      {/* Row 1: logo · the conversation's tabs */}
      <View className="border-border flex-row items-center gap-2 border-b px-2.5 py-1.5">
        <Image
          source={require('@/assets/images/icon.png')}
          style={{ width: 18, height: 18, borderRadius: 5 }}
          accessibilityLabel={t('chat.browser.title')}
        />
        <View className="bg-border h-4 w-px" />
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          className="min-w-0 flex-1"
          contentContainerClassName="flex-row items-center gap-1"
          accessibilityLabel={t('chat.browser.pages')}
        >
          {strip.map((x, i) => {
            const label = isStartPage(x.url)
              ? t('chat.browser.title')
              : x.title && x.title !== x.url
                ? x.title
                : hostOf(x.url) || x.url
            return (
              <View
                key={`${i}:${x.url}`}
                className={cn(
                  'max-w-44 rounded-md border px-2 py-0.5',
                  x.active ? 'border-border bg-border-soft' : 'border-transparent'
                )}
              >
                <Text
                  numberOfLines={1}
                  className={cn('font-sans text-[11px]', x.active ? 'text-fg' : 'text-muted')}
                >
                  {label}
                </Text>
              </View>
            )
          })}
        </ScrollView>
      </View>

      {/* Row 2: address · actions */}
      <View className="border-border flex-row items-center gap-1 border-b px-2.5 py-1.5">
        <Text
          selectable
          numberOfLines={1}
          className="text-muted min-w-0 flex-1 text-left font-mono text-[11px]"
        >
          {start ? '' : url}
        </Text>
        {live && (
          <Pressable
            onPress={openLive}
            accessibilityRole="button"
            accessibilityLabel={t('chat.browser.openLive')}
            hitSlop={6}
            className={chip}
          >
            <Globe02Icon size={15} className="text-muted" />
          </Pressable>
        )}
        {live && (
          <Pressable
            onPress={() => void Linking.openURL(url).catch(() => undefined)}
            accessibilityRole="button"
            accessibilityLabel={t('chat.browser.openExternal')}
            hitSlop={6}
            className={chip}
          >
            <LinkSquare02Icon size={15} className="text-muted" />
          </Pressable>
        )}
        {!start && (
          <Pressable
            onPress={copy}
            accessibilityRole="button"
            accessibilityLabel={t('chat.browser.copyUrl')}
            hitSlop={6}
            className={chip}
          >
            {copied ? (
              <Tick02Icon size={15} className="text-primary" />
            ) : (
              <Copy01Icon size={15} className="text-muted" />
            )}
          </Pressable>
        )}
      </View>

      {/* The page: the desktop's still. Tap opens the live page when it can. */}
      <Pressable
        onPress={openLive}
        disabled={!live}
        accessibilityRole={live ? 'imagebutton' : 'image'}
        accessibilityLabel={live ? t('chat.browser.openLive') : host || t('chat.browser.title')}
        className="bg-border-soft w-full"
        style={{ aspectRatio: STILL_ASPECT }}
      >
        {uri ? (
          <Image
            source={{ uri }}
            contentFit="cover"
            contentPosition="top"
            style={{ width: '100%', height: '100%' }}
          />
        ) : (
          <View className="flex-1 items-center justify-center gap-2">
            <Globe02Icon size={26} className="text-muted" />
            <Text className="text-muted font-sans text-xs">
              {loading ? '' : t('chat.browser.noStill')}
            </Text>
          </View>
        )}
        {!live && !start && (
          <View className="absolute inset-x-2 bottom-2 flex-row items-center justify-center rounded-md bg-black/60 px-2 py-1">
            <Text className="font-sans text-[11px] text-white">
              {t('chat.browser.desktopOnly')}
            </Text>
          </View>
        )}
      </Pressable>
    </View>
  )
}
