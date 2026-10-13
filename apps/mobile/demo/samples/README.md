# Sample files to publish

> **`cdn.wolffi.sh` is gone.** The published sample set no longer exists; host
> these files on a static server of your own and point `baseUrl` in
> `src/lib/files/publishedSamples.json` at it.

New entries for the published sample set —
the per-type stand-in bytes demo mode serves for workspace paths (see
src/lib/files/sampleFiles.ts). Upload each file here as-is, then make sure it
is listed in src/lib/files/publishedSamples.json (the manifest is the single
source of truth for what is published; the app and the demo build scripts
both read it).

Note this is a different target from demo/bundle/, which was published
separately (also on the old CDN).

- `wolffish-sample.chart.json` — the interactive chart card spec (matches the
  dataviz manual's reference example; drawn by the app's chart renderer).
