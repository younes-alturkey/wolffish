/**
 * The unread count, drawn everywhere a page is allowed to draw it:
 *
 *   - the app icon (`navigator.setAppBadge`) — the Dock on macOS, the taskbar
 *     on Windows, the Home Screen on iOS. Only an INSTALLED web app has an
 *     icon to badge; in a plain tab the call does nothing, and Firefox does
 *     not offer it at all;
 *   - the tab title, `(3) Wolffish` — every browser, installed or not, and
 *     the window title of an installed app;
 *   - the favicon, redrawn with a count — Chromium and Firefox tabs (Safari
 *     keeps its own icon, the title still carries the count there).
 */

const TITLE_PREFIX = /^\(\d+\+?\) /
const ICON_SIZE = 64

let originalIcon: string | null = null
let iconImage: Promise<HTMLImageElement | null> | null = null
let drawn = 0

function label(count: number): string {
  return count > 99 ? '99+' : String(count)
}

function iconLink(): HTMLLinkElement | null {
  return document.querySelector<HTMLLinkElement>('link[rel~="icon"]')
}

function loadIcon(href: string): Promise<HTMLImageElement | null> {
  iconImage ??= new Promise((resolve) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => resolve(null)
    img.src = href
  })
  return iconImage
}

async function drawFavicon(count: number): Promise<void> {
  const link = iconLink()
  if (!link) return
  originalIcon ??= link.href
  if (count === 0) {
    link.href = originalIcon
    return
  }
  const img = await loadIcon(originalIcon)
  // A newer count landed while the icon loaded; that call draws.
  if (count !== drawn) return
  const canvas = document.createElement('canvas')
  canvas.width = ICON_SIZE
  canvas.height = ICON_SIZE
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  if (img) ctx.drawImage(img, 0, 0, ICON_SIZE, ICON_SIZE)
  const text = count > 9 ? '9+' : String(count)
  const radius = 20
  const cx = ICON_SIZE - radius
  const cy = radius
  ctx.beginPath()
  ctx.arc(cx, cy, radius, 0, Math.PI * 2)
  ctx.fillStyle = '#e5484d'
  ctx.fill()
  ctx.lineWidth = 3
  ctx.strokeStyle = '#ffffff'
  ctx.stroke()
  ctx.fillStyle = '#ffffff'
  ctx.font = `bold ${text.length > 1 ? 22 : 28}px system-ui, -apple-system, sans-serif`
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText(text, cx, cy + 1)
  try {
    link.href = canvas.toDataURL('image/png')
  } catch {
    // a tainted canvas (icon from another origin) keeps the plain icon
  }
}

function setAppBadge(count: number): void {
  const nav = navigator as Navigator & {
    setAppBadge?: (n?: number) => Promise<void>
    clearAppBadge?: () => Promise<void>
  }
  try {
    const pending = count > 0 ? nav.setAppBadge?.(count) : nav.clearAppBadge?.()
    // Rejects outside an installed app on some builds, and without the
    // notification permission on Apple's — nothing to do about either.
    pending?.catch(() => undefined)
  } catch {
    // not offered here
  }
}

export function renderUnreadBadge(count: number): void {
  const next = Math.max(0, Math.floor(count))
  const bare = document.title.replace(TITLE_PREFIX, '')
  document.title = next > 0 ? `(${label(next)}) ${bare}` : bare
  setAppBadge(next)
  if (next === drawn) return
  drawn = next
  void drawFavicon(next)
}
