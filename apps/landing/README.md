# Wolffish landing page

The one-page site at **https://younes-alturkey.github.io/wolffish/**: the three.js ocean, the latest version, and the download links for the desktop app.

- **Static.** Vite + React + Tailwind, built to `dist/` and served by GitHub Pages.
- **Release data comes from GitHub.** The build bakes in the latest release from the GitHub API, and the page looks it up again on load, so a new release shows up without a redeploy. If the lookup fails, every download link falls back to the Releases page.
- **Deployed by [`.github/workflows/pages.yml`](../../.github/workflows/pages.yml)** on any push to `main` that touches `apps/landing/`, after every successful `Release` run, and on demand from the Actions tab.
- **English and Arabic.** Strings live in `src/locales/{en,ar}.json`; the choice is remembered per browser.

```bash
npm install
npm run dev       # http://localhost:5173
npm run build     # typecheck + dist/
```

The fonts come from the repo's `resources/fonts/` through the `@resources` alias. `public/og.jpg` is the link-preview image (1200×630: logo, tagline, subtitle), kept in `public/` so it has a fixed URL.
