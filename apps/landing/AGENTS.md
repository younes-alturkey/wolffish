# Landing page — Agent Guide

One static page, deployed to GitHub Pages by `.github/workflows/pages.yml`. See `README.md`.

- `src/release.ts` owns every GitHub URL and the asset matching (`.dmg`, `.exe`, `.deb`, `.rpm`, `.AppImage`). If electron-builder's artifact names change, change the patterns there.
- `src/OceanScene.tsx` is the three.js background, lazy-loaded so the downloads render first.
- Any copy change updates both `src/locales/en.json` and `src/locales/ar.json`; check both LTR and RTL in a browser.
- Links point only at the monorepo. No mobile app, no hosted services, no wolffi.sh — those are gone.
- `base: './'` keeps every asset path relative, so the build works under `/wolffish/` and on a custom domain alike.
