// Preload for the custom Windows tray context menu. Native Win32 tray menus
// are drawn by the OS using the system menu font, so Electron can't enlarge
// them — to honor the "make the tray menu bigger" request we draw our own
// menu in a tiny frameless popup window and scale every metric up ~30%.
//
// Everything lives in the preload (not page <script>) so the popup's page can
// stay a bare, script-free data: URL: with contextIsolation on, the preload
// still shares the DOM, so it builds the menu, wires clicks/keyboard, and
// talks to main over IPC directly. Main sends `tray-menu:render` with the
// current locale + theme each time the popup opens.
import { ipcRenderer } from 'electron'

type Locale = 'en' | 'ar'
type TrayAction = 'show' | 'quit'
type TrayMenuState = { locale: Locale; dark: boolean }

const LABELS: Record<Locale, Record<TrayAction, string>> = {
  en: { show: 'Show Wolffish', quit: 'Quit' },
  ar: { show: 'إظهار وولفيش', quit: 'إغلاق' }
}

// Monochrome glyphs that inherit the item's text color via `currentColor`.
const ICONS: Record<TrayAction, string> = {
  show: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4.5" width="18" height="15" rx="2.5"/><path d="M3 9.5h18"/></svg>',
  quit: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v9"/><path d="M6.4 6.4a8 8 0 1 0 11.2 0"/></svg>'
}

// Win11-ish flyout, every dimension ~1.3× the native menu so the text reads
// noticeably larger. Window size in main is fixed to match (244 card + 14px
// transparent margin each side for the CSS drop shadow).
function css(dark: boolean): string {
  const c = dark
    ? {
        bg: '#2b2b2b',
        border: 'rgba(255,255,255,0.09)',
        fg: '#ffffff',
        hover: 'rgba(255,255,255,0.09)',
        sep: 'rgba(255,255,255,0.11)',
        shadow: '0 12px 32px rgba(0,0,0,0.50), 0 2px 8px rgba(0,0,0,0.35)'
      }
    : {
        bg: '#f9f9f9',
        border: 'rgba(0,0,0,0.07)',
        fg: '#1b1b1b',
        hover: 'rgba(0,0,0,0.06)',
        sep: 'rgba(0,0,0,0.10)',
        shadow: '0 12px 30px rgba(0,0,0,0.18), 0 2px 8px rgba(0,0,0,0.10)'
      }
  return `
  html, body { margin: 0; padding: 0; background: transparent; overflow: hidden; }
  *, *::before, *::after { box-sizing: border-box; }
  body {
    font-family: "Segoe UI Variable Text", "Segoe UI", system-ui, -apple-system, sans-serif;
    -webkit-user-select: none; user-select: none; cursor: default;
  }
  .tray-card {
    margin: 14px; width: 244px; padding: 6px 4px;
    background: ${c.bg}; color: ${c.fg};
    border: 1px solid ${c.border}; border-radius: 10px;
    box-shadow: ${c.shadow};
  }
  .tray-item {
    display: flex; align-items: center; gap: 12px;
    height: 40px; padding: 0 12px; margin: 1px 4px;
    border-radius: 6px; font-size: 16px; line-height: 1;
    color: inherit; outline: none;
  }
  .tray-item:hover, .tray-item.is-active { background: ${c.hover}; }
  .tray-ic { display: inline-flex; flex: 0 0 20px; width: 20px; height: 20px; opacity: 0.92; }
  .tray-ic svg { width: 20px; height: 20px; }
  .tray-label { flex: 1 1 auto; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .tray-sep { height: 1px; margin: 5px 8px; background: ${c.sep}; }
  `
}

function items(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>('.tray-item'))
}

function setActive(el: HTMLElement | null): void {
  for (const item of items()) item.classList.toggle('is-active', item === el)
  el?.focus()
}

function render(state: TrayMenuState): void {
  const { locale, dark } = state
  document.documentElement.lang = locale
  document.documentElement.dir = locale === 'ar' ? 'rtl' : 'ltr'

  let style = document.getElementById('tray-style')
  if (!style) {
    style = document.createElement('style')
    style.id = 'tray-style'
    document.head.appendChild(style)
  }
  style.textContent = css(dark)

  const labels = LABELS[locale]
  const row = (action: TrayAction): string =>
    `<div class="tray-item" role="menuitem" tabindex="-1" data-action="${action}">` +
    `<span class="tray-ic">${ICONS[action]}</span><span class="tray-label">${labels[action]}</span></div>`

  document.body.innerHTML =
    `<div class="tray-card" role="menu">` +
    row('show') +
    `<div class="tray-sep" role="separator"></div>` +
    row('quit') +
    `</div>`

  for (const item of items()) {
    item.addEventListener('click', () => {
      ipcRenderer.send('tray-menu:action', item.dataset.action as TrayAction)
    })
    item.addEventListener('mouseenter', () => setActive(item))
  }
  setActive(items()[0] ?? null)
}

function onKeyDown(e: KeyboardEvent): void {
  const all = items()
  if (e.key === 'Escape') {
    ipcRenderer.send('tray-menu:close')
    e.preventDefault()
    return
  }
  if (!all.length) return
  const current = all.findIndex((el) => el.classList.contains('is-active'))
  if (e.key === 'ArrowDown') {
    setActive(all[(current + 1) % all.length])
    e.preventDefault()
  } else if (e.key === 'ArrowUp') {
    setActive(all[(current - 1 + all.length) % all.length])
    e.preventDefault()
  } else if (e.key === 'Enter' || e.key === ' ') {
    all[current >= 0 ? current : 0]?.click()
    e.preventDefault()
  }
}

window.addEventListener('DOMContentLoaded', () => {
  ipcRenderer.on('tray-menu:render', (_event, state: TrayMenuState) => render(state))
  window.addEventListener('keydown', onKeyDown)
})
