/**
 * Markdown imported as a bundled asset (metro.config.js registers the
 * extension). Metro hands back an asset module id — the number `Asset.
 * fromModule` resolves to a local URI — not the file's text, which is why
 * lib/changelog has to read it rather than simply using the import.
 */
declare module '*.md' {
  const asset: number
  export default asset
}
