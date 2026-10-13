# Office WebView assets

Browser JavaScript loaded into the office card's WebView at runtime — bundled
as assets (see the `webjs` note in metro.config.js), never parsed by Metro.
Unlike `assets/pdf`, these ship on **both** platforms: iOS renders .docx/.xlsx/
.pptx natively in WKWebView, but that engine exposes no page or sheet count, so
a card backed by it could not drive the pager. One engine on both platforms is
also one behaviour to test.

- `office-engine.webjs` — the three renderers wolffish-app uses, bundled into
  one IIFE exposing `window.WolffishOffice`. Versions are pinned to
  wolffish-app's own dependencies so a document, deck or workbook looks the
  same on the phone as on the desktop — bump them together:

  | engine | version | what it renders |
  | --- | --- | --- |
  | `@office-kit/pptx` + `@office-kit/pptx-preview` | 0.13.0 / 0.9.3 | `.pptx` → one SVG per slide (`renderSlideToSvg`, the same call `deck-preview.ts` makes in main) |
  | `docx-preview` (+ `jszip`) | 0.4.0 / 3.10.2 | `.docx` → one `<section>` per page (the same `renderAsync` options as `useDocxPages.ts`) |
  | `xlsx` (SheetJS) | 0.20.3 | `.xlsx` / `.xls` → values and number-formatted text |

  ```
  npm pack @office-kit/pptx@0.13.0 @office-kit/pptx-preview@0.9.3 \
           docx-preview@0.4.0 jszip@3.10.2
  curl -sL https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz -o xlsx-0.20.3.tgz
  npm i ./*.tgz
  npx esbuild entry.mjs --bundle --format=iife --platform=browser \
    --target=es2018 --minify --outfile=office-engine.webjs
  ```

  where `entry.mjs` is:

  ```js
  import { getSlides, loadPresentation } from '@office-kit/pptx'
  import { renderSlideToSvg } from '@office-kit/pptx-preview'
  import { renderAsync } from 'docx-preview'
  import * as XLSX from 'xlsx'
  globalThis.WolffishOffice = {
    pptx: { loadPresentation, getSlides, renderSlideToSvg },
    docx: { renderAsync },
    xlsx: XLSX
  }
  ```

  SheetJS comes from **cdn.sheetjs.com, not npm**, and that is load-bearing:
  the `xlsx` package on npm is frozen at 0.18.5, which carries two unfixed
  high-severity advisories (prototype pollution GHSA-4r6h-8v6p-xvw6, ReDoS
  GHSA-5pgg-2g8v-p4x9). SheetJS publishes fixes only to its own CDN. It is
  fetched by the command above rather than declared as a dependency because
  npm ≥ 12 refuses remote tarballs by default (`EALLOWREMOTE`), which would
  break `npm ci` on EAS.

  The `@office-kit/pptx-preview` root entry is pure browser JavaScript; its
  `@resvg/resvg-js` and `fontkit` dependencies belong to the `./node` subpath
  and never enter this bundle.

- `office-page.webjs` — the page runtime: base64 → rendered pages, the
  fit-to-width scaling that turns a Word page into something readable at
  390pt, and the `ready` / `page` / `error` message protocol plus the
  `wolffishGoTo` entry point the card's pager drives.
