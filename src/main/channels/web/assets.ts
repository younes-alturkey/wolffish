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
 * gets no bundling and no TypeScript. Two jobs — show a notification for a
 * push message or a page message, and take the user to the conversation it
 * names when tapped (focusing an open tab before opening a new one).
 */
export const SERVICE_WORKER_SOURCE = `/* Wolffish Web UI service worker */
self.addEventListener('install', function () { self.skipWaiting() })
self.addEventListener('activate', function (event) { event.waitUntil(self.clients.claim()) })

function showNotification(data) {
  var title = (data && data.title) || 'Wolffish'
  var options = {
    body: (data && data.body) || '',
    icon: '/icon-256.png',
    badge: '/icon-128.png',
    tag: (data && data.id) || undefined,
    renotify: !!(data && data.id),
    data: { url: (data && data.url) || '/', id: data && data.id },
    requireInteraction: !!(data && data.phase === 'needs_input')
  }
  return self.registration.showNotification(title, options)
}

self.addEventListener('push', function (event) {
  var data = null
  try { data = event.data ? event.data.json() : null } catch (e) { data = { body: event.data ? event.data.text() : '' } }
  event.waitUntil(showNotification(data))
})

self.addEventListener('message', function (event) {
  var msg = event.data
  if (!msg || msg.type !== 'notify') return
  event.waitUntil(showNotification(msg.data))
})

self.addEventListener('notificationclick', function (event) {
  event.notification.close()
  var url = (event.notification.data && event.notification.data.url) || '/'
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (list) {
      var target = new URL(url, self.location.origin).href
      for (var i = 0; i < list.length; i++) {
        var client = list[i]
        if ('focus' in client) {
          client.postMessage({ type: 'open', url: target })
          return client.focus()
        }
      }
      if (self.clients.openWindow) return self.clients.openWindow(target)
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
