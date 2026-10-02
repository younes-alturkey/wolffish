/**
 * The page a new tab opens on: Wolffish branding, a one-line description of
 * this browser, centered — never Chromium's bare about:blank. Built in the
 * renderer so it speaks the user's language; main never sees the strings.
 *
 * It travels as a data: URL with a marker, which is how the chrome knows to
 * show an empty address field and a friendly tab label for it.
 */

import wordmark from '../../../assets/wolffish-wordmark.svg?raw'

const MARKER = '<!--wolffish-start-->'
const PREFIX = 'data:text/html;charset=utf-8,'

export function isStartPage(url: string): boolean {
  return (
    url.startsWith(PREFIX) &&
    decodeURIComponent(url.slice(PREFIX.length, PREFIX.length + 40)).startsWith(MARKER)
  )
}

export function startPageUrl(strings: {
  title: string
  chip: string
  subtitle: string
  lang: string
  dir: 'ltr' | 'rtl'
}): string {
  const esc = (v: string): string =>
    v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  // Chrome's new tab, in spirit: the mark with a small "Browser" chip at its
  // side, one line under it, nothing else.
  const html = `${MARKER}<!doctype html><html lang="${esc(strings.lang)}" dir="${strings.dir}"><head><meta charset="utf-8"><title>${esc(strings.title)}</title><style>
:root{color-scheme:light dark}
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;background:#ffffff;color:#141414}
@media(prefers-color-scheme:dark){body{background:#0f1115;color:#e8eaf0}}
.w{display:flex;flex-direction:column;align-items:center;gap:1rem;padding:2rem;text-align:center}
.brand{display:flex;align-items:center;gap:.8rem;color:#00a9cc}
@media(prefers-color-scheme:dark){.brand{color:#00d4ff}}
.logo{width:min(240px,62vw)}
.logo svg{display:block;width:100%;height:auto}
.chip{border:1.5px solid currentColor;border-radius:999px;padding:.2em .7em;font-size:.8rem;font-weight:600;letter-spacing:.04em;white-space:nowrap}
p{margin:0;font-size:.95rem;opacity:.65}
</style></head><body><div class="w"><div class="brand"><div class="logo">${wordmark}</div><span class="chip">${esc(strings.chip)}</span></div><p>${esc(strings.subtitle)}</p></div></body></html>`
  return PREFIX + encodeURIComponent(html)
}
