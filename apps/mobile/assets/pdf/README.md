# PDF WebView assets

Browser JavaScript loaded into the PDF card's WebView at runtime — bundled as
assets (see the `webjs` note in metro.config.js), never parsed by Metro. Android
only: iOS renders PDFs in WKWebView natively, so none of this ships into that
path (see `PdfFileCard` in components/chat/FileViewers.tsx).

- `pdf.min.webjs` / `pdf.worker.min.webjs` — pdf.js 6.2.108, the `legacy` build
  (Apache-2.0, banner prepended — the minified dist carries none). pdfjs-dist
  ships ES modules only, and a `file://` page cannot load a module script: the
  fetch is cross-origin against an opaque origin and Chrome blocks it. So each
  `.mjs` is rewrapped as a classic script exposing the global it needs —
  `pdfjsLib` for the API, `pdfjsWorker` for the message handler pdf.js looks up
  when it runs on the main thread:

  ```
  npm pack pdfjs-dist@6.2.108
  npx esbuild package/legacy/build/pdf.min.mjs --bundle --format=iife \
    --global-name=pdfjsLib --minify --target=es2018 --outfile=pdf.min.webjs
  npx esbuild package/legacy/build/pdf.worker.min.mjs --bundle --format=iife \
    --global-name=pdfjsWorker --minify --target=es2018 --outfile=pdf.worker.min.webjs
  ```

  `--target=es2018` is load-bearing, not tidiness: it rewrites the `import.meta`
  in pdf.js's Node-only branches, which is a syntax error in a classic script.

- `pdf-page.webjs` — the page runtime: base64 → document, fit-to-width
  rasterization, the preview/full split and the lazy page observer.
