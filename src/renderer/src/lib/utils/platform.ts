/**
 * macOS runs the window with titleBarStyle 'hiddenInset' (no native titlebar);
 * content clears the traffic lights and lines up with the sidebar rail at `pt-8`
 * (32px). Windows and Linux draw their own native titlebar above the webview, so
 * content sits tighter (`pt-4`, 16px). One value drives every page's top offset —
 * the Sidebar, the page `<main>`, and the back-button rows all read from it, so
 * the home and the internal pages start at the same pixel from the top.
 */
export const isMac = navigator.platform.startsWith('Mac')

/** Top padding for a page's root `<main>`, accounting for the macOS titlebar. */
export const pageTopPadding = isMac ? 'pt-8' : 'pt-4'
