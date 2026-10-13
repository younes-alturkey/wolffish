const { getDefaultConfig } = require('expo/metro-config')
const { withNativeWind } = require('nativewind/metro')

const config = getDefaultConfig(__dirname)

// Markdown ships as a bundled asset, not as source: src/changelog/<month>/
// <locale>.md are release notes the Updates screen reads at runtime (see
// lib/changelog). Registering the extension here is what makes `import
// page from '@/changelog/2026-07/en.md'` resolve to an asset — served by
// Metro in development, packed into the binary for a store build — instead
// of Metro trying to parse the prose as JavaScript.
config.resolver.assetExts.push('md')

// WebView page scripts ship as bundled assets too: assets/charts/*.webjs are
// plain browser JavaScript (the vendored ECharts build and the chart page
// runtime) that runs inside a WebView, never through Metro. The made-up
// extension is deliberate — registering plain `js` as an asset extension
// would collide with source resolution.
config.resolver.assetExts.push('webjs')

// expo-sqlite's web implementation imports its SQLite build as
// `./wa-sqlite/wa-sqlite.wasm`, and Metro ships no `wasm` asset extension, so
// the file resolves nowhere and every web bundle fails on it — including the
// static render the dev server does the moment a browser hits localhost:8081,
// which is why the failure showed up in a native run. Native never imports
// wasm; this only makes the web graph resolvable.
config.resolver.assetExts.push('wasm')

module.exports = withNativeWind(config, { input: './src/global.css' })
