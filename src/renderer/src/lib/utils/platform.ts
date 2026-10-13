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
