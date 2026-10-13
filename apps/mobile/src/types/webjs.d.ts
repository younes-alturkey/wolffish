/**
 * Browser JavaScript bundled as an asset (metro.config.js registers the
 * extension) — the chart WebView's scripts. Same deal as '*.md': Metro hands
 * back an asset module id for `Asset.fromModule`, not the file's text.
 */
declare module '*.webjs' {
  const asset: number
  export default asset
}

/**
 * Font files are already bundleable assets (Metro's default assetExts);
 * expo's types just don't declare the module shape. The chart host imports
 * the Plex face directly to inline it into the WebView page.
 */
declare module '*.ttf' {
  const asset: number
  export default asset
}
