/**
 * The handful of files the Web UI serves that are not the renderer bundle:
 * the service worker that shows push notifications and routes their taps,
 * the PWA manifest that lets a phone keep the app on its home screen (which
 * is what makes Web Push possible on iOS at all), and the `<head>` tags the
 * server splices into the renderer's index.html so the Electron build keeps
 * an index.html with no web-only references in it.
 */

export const SERVICE_WORKER_PATH = '/sw.js'
export const MANIFEST_PATH = '/manifest.webmanifest'

/**
 * Written as plain ES5-ish JavaScript: the worker is served verbatim, so it
 * gets no bundling and no TypeScript. Its jobs: show a notification for a
 * push message or a page message, take the user to the conversation it
 * names when tapped (focusing an open tab before opening a new one), and own
 * the unread count — the ids of what arrived while the user was away, kept
 * in Cache Storage because a worker is killed between pushes and its memory
 * goes with it. The count goes on the app icon (installed apps) and to every
 * open page, which draws it on the tab title and favicon.
 */
export const SERVICE_WORKER_SOURCE = `/* Wolffish Web UI service worker */
self.addEventListener('install', function () { self.skipWaiting() })
self.addEventListener('activate', function (event) { event.waitUntil(self.clients.claim()) })

var UNREAD_CACHE = 'wolffish-unread'
var UNREAD_KEY = '/__wolffish/unread'
var UNREAD_MAX = 200
var unreadChain = Promise.resolve()

function readUnread() {
  return caches.open(UNREAD_CACHE)
    .then(function (cache) { return cache.match(UNREAD_KEY) })
    .then(function (res) { return res ? res.json() : [] })
    .then(function (ids) { return Array.isArray(ids) ? ids : [] }, function () { return [] })
}

function windows() {
  return self.clients.matchAll({ type: 'window', includeUncontrolled: true })
}

function publishUnread(count) {
  var nav = self.navigator
  var badge = null
  try {
    badge = count > 0
      ? (nav.setAppBadge ? nav.setAppBadge(count) : null)
      : (nav.clearAppBadge ? nav.clearAppBadge() : null)
  } catch (e) { badge = null }
  return Promise.resolve(badge).catch(function () {}).then(windows).then(function (list) {
    for (var i = 0; i < list.length; i++) list[i].postMessage({ type: 'unread', count: count })
  })
}

// Read-modify-write, one at a time: two pushes landing together must not
// both read the old list and drop each other's id.
function changeUnread(change) {
  unreadChain = unreadChain.then(function () {
    return readUnread().then(function (ids) {
      var next = change(ids)
      if (next === ids) return publishUnread(ids.length)
      return caches.open(UNREAD_CACHE)
        .then(function (cache) {
          return cache.put(UNREAD_KEY, new Response(JSON.stringify(next), { headers: { 'Content-Type': 'application/json' } }))
        })
        .then(function () { return publishUnread(next.length) })
    })
  }).catch(function () {})
  return unreadChain
}

function addUnread(id) {
  return changeUnread(function (ids) {
    if (!id || ids.indexOf(id) >= 0) return ids
    return ids.concat([id]).slice(-UNREAD_MAX)
  })
}

function clearUnread() {
  var closing = self.registration.getNotifications
    ? self.registration.getNotifications().then(function (list) {
        for (var i = 0; i < list.length; i++) list[i].close()
      }).catch(function () {})
    : null
  return Promise.all([closing, changeUnread(function () { return [] })])
}

// The page the user is looking at, if any: on screen with its window focused.
function attendedWindow() {
  return windows().then(function (list) {
    for (var i = 0; i < list.length; i++) {
      if (list[i].focused && list[i].visibilityState === 'visible') return list[i]
    }
    return null
  })
}

// Chromium lets a push go without a notification while one of the site's
// pages is focused; Safari revokes a subscription that skips them, and
// Firefox spends a quota. userAgentData is exposed by Chromium alone.
function mayStayQuiet() {
  return !!(self.navigator && self.navigator.userAgentData)
}

function showNotification(data) {
  var title = (data && data.title) || 'Wolffish'
  var options = {
    body: (data && data.body) || '',
    icon: '/icon-256.png',
    badge: '/icon-128.png',
    tag: (data && data.id) || undefined,
    renotify: !!(data && data.id),
    timestamp: (data && data.at) || Date.now(),
    data: { url: (data && data.url) || '/', id: data && data.id },
    requireInteraction: !!(data && data.phase === 'needs_input')
  }
  return self.registration.showNotification(title, options)
}

self.addEventListener('push', function (event) {
  var data = null
  try { data = event.data ? event.data.json() : null } catch (e) { data = { body: event.data ? event.data.text() : '' } }
  event.waitUntil(attendedWindow().then(function (client) {
    if (client) {
      // The user is on the page: its toast is the notification, and nothing
      // counts as unread. The frame may have missed a socket mid-reconnect,
      // so the page gets the payload too (it toasts each id once).
      if (data && data.id) client.postMessage({ type: 'push', data: data })
      if (mayStayQuiet()) return undefined
      return showNotification(data)
    }
    return Promise.all([showNotification(data), addUnread(data && data.id)])
  }))
})

self.addEventListener('message', function (event) {
  var msg = event.data
  if (!msg || typeof msg.type !== 'string') return
  if (msg.type === 'notify') event.waitUntil(showNotification(msg.data))
  else if (msg.type === 'unread:add') event.waitUntil(addUnread(msg.id))
  else if (msg.type === 'unread:clear') event.waitUntil(clearUnread())
  else if (msg.type === 'unread:get') event.waitUntil(changeUnread(function (ids) { return ids }))
})

// A tap answers the notification: the page marks it read in the log. An open
// tab is told directly; a new one finds the id on its URL as read=<id>.
self.addEventListener('notificationclick', function (event) {
  event.notification.close()
  var data = event.notification.data || {}
  var url = data.url || '/'
  var id = typeof data.id === 'string' ? data.id : null
  event.waitUntil(
    windows().then(function (list) {
      var target = new URL(url, self.location.origin)
      for (var i = 0; i < list.length; i++) {
        var client = list[i]
        if ('focus' in client) {
          client.postMessage({ type: 'open', url: target.href, id: id })
          return client.focus()
        }
      }
      if (id) target.searchParams.set('read', id)
      if (self.clients.openWindow) return self.clients.openWindow(target.href)
      return undefined
    })
  )
})
`

export function manifestJson(): string {
  return JSON.stringify(
    {
      name: 'Wolffish',
      short_name: 'Wolffish',
      description: 'Your personal AI agent, from any browser.',
      start_url: '/',
      scope: '/',
      display: 'standalone',
      orientation: 'any',
      background_color: '#0d1117',
      theme_color: '#1b365d',
      icons: [
        { src: '/icon-128.png', sizes: '128x128', type: 'image/png' },
        { src: '/icon-256.png', sizes: '256x256', type: 'image/png', purpose: 'any' },
        { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any maskable' }
      ]
    },
    null,
    2
  )
}

/** Spliced in before `</head>` of the renderer's index.html when served over the web. */
export const HEAD_TAGS = [
  `<link rel="manifest" href="${MANIFEST_PATH}" />`,
  '<link rel="icon" href="/icon-128.png" sizes="128x128" type="image/png" />',
  '<link rel="apple-touch-icon" href="/icon-256.png" />',
  '<meta name="theme-color" content="#f0f4f8" media="(prefers-color-scheme: light)" />',
  '<meta name="theme-color" content="#0d1117" media="(prefers-color-scheme: dark)" />',
  '<meta name="apple-mobile-web-app-capable" content="yes" />',
  '<meta name="mobile-web-app-capable" content="yes" />',
  '<meta name="apple-mobile-web-app-status-bar-style" content="default" />',
  '<meta name="apple-mobile-web-app-title" content="Wolffish" />'
].join('\n    ')

export function injectHeadTags(html: string): string {
  const index = html.indexOf('</head>')
  if (index < 0) return html
  return `${html.slice(0, index)}    ${HEAD_TAGS}\n  ${html.slice(index)}`
}
