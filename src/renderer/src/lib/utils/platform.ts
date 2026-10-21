/**
 * Where the renderer is running. `isWeb` is the Web UI — the same bundle
 * served to a browser — flagged on the document by main.tsx before any of
 * the app's modules load, so it is settled by the time this file evaluates.
 */
export const isWeb =
  typeof document !== 'undefined' && document.documentElement.classList.contains('wf-web')

/**
 * Whether "reveal in folder" means anything here. A browser has no Finder —
 * the folder would open on the machine running Wolffish, out of sight — so
 * every reveal control renders only when this is true.
 */
export const canRevealInFolder = !isWeb

/**
 * Whether "open outside" can open anything. An installed phone web app has no
 * tabs and no way to hand a file to the system browser: a same-origin URL
 * replaces the app's own screen, with no way back. Expand and download cover
 * the phone, so every open control renders only when this is true.
 */
const installedPhoneApp =
  isWeb &&
  typeof window.matchMedia === 'function' &&
  ((navigator as Navigator & { standalone?: boolean }).standalone === true ||
    window.matchMedia('(display-mode: standalone)').matches) &&
  window.matchMedia('(hover: none)').matches
export const canOpenExternal = !installedPhoneApp

/**
 * Whether an `<iframe>` shows a whole PDF. iOS WebKit draws a framed PDF as a
 * still image of its first page — in every iOS browser and in the home-screen
 * app alike — and Android's Chrome has no PDF viewer at all. Those render the
 * pages with pdf.js instead. An iPad reports itself as a Mac; touch gives it away.
 */
const iOS =
  /iP(hone|ad|od)/.test(navigator.userAgent) ||
  (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1)
export const framesPdf = !isWeb || (!iOS && navigator.pdfViewerEnabled !== false)

/**
 * macOS runs the window with titleBarStyle 'hiddenInset' (no native titlebar);
 * content clears the traffic lights and lines up with the sidebar rail at `pt-8`
 * (32px). Windows and Linux draw their own native titlebar above the webview, so
 * content sits tighter (`pt-4`, 16px). One value drives every page's top offset —
 * the Sidebar, the page `<main>`, and the back-button rows all read from it, so
 * the home and the internal pages start at the same pixel from the top.
 *
 * A browser has no traffic lights whatever machine it runs on, so the web
 * takes the tighter offset even on a Mac.
 */
export const isMac = !isWeb && navigator.platform.startsWith('Mac')

/** Top padding for a page's root `<main>`, accounting for the macOS titlebar. */
export const pageTopPadding = isMac ? 'pt-8' : 'pt-4'
