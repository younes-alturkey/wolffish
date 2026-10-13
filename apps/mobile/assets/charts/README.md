# Chart WebView assets

Browser JavaScript loaded into the chart card's WebView at runtime — bundled
as assets (see the `webjs` note in metro.config.js), never parsed by Metro.

- `echarts.min.webjs` — Apache ECharts 6.1.0, `dist/echarts.min.js` verbatim
  (Apache-2.0, license banner intact at the top of the file). The version is
  pinned to wolffish-app's `echarts` dependency so both apps render a
  `.chart.json` spec with the same engine — bump the two together.
- `chart-page.webjs` — the page runtime: the spec → ECharts option mapper
  (a port of wolffish-app `toOption.ts` — keep in sync) plus the render /
  snapshot message protocol the app drives over `injectJavaScript`.
