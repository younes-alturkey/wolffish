/**
 * Stands in for `*.webjs` imports under jest.
 *
 * Metro treats these as assets and hands back a module id (see webjs.d.ts), but
 * jest knows nothing about the extension and so *runs* them — 1.8MB of pdf.js
 * evaluating in Node, where it takes its Node branch and dies on a missing
 * DOMMatrix, taking down every suite that transitively imports a WebView host.
 * The id is all the app ever passes to `Asset.fromModule` anyway; a test that
 * wants the real script text reads the file itself (see charts/chartPage.test).
 */
module.exports = 1
