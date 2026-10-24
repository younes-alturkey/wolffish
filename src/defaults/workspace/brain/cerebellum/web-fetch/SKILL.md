---
name: web-fetch
description: Read a web page as text — a free direct fetch, or DeepSeek Fetch for pages that refuse or break a plain GET
triggers:
  - url
  - link
  - fetch
  - page
  - website
  - site
  - article
  - read this
  - open this
  - docs
  - documentation
  - blog
  - changelog
  - release notes
  - readme
requires:
  - node
tools:
  - name: web_fetch
    readOnly: true
    description: Read one web page as text. Engines run in the user's order (default direct, then DeepSeek); pass `engine` to pick one, and it falls back down that order if the pick is off or fails. direct is a plain HTTP GET — instant and free, but it sees only what the server sends. deepseek is DeepSeek's Fetch API — clean Markdown, and it gets through some sites that refuse or break a direct GET; slower and paid per page. Neither runs JavaScript, signs in, or clicks — paywalls, logins and bot checks need the browser-extension capability. Neither reaches localhost or private networks.
    parameters:
      url:
        type: string
        description: The URL of the web page to fetch
      maxLength:
        type: number
        required: false
        description: Maximum characters to return (default 15000)
      engine:
        type: string
        required: false
        enum: [direct, deepseek]
        description: Optional. Which engine to try first — see "Picking an engine". Omit to follow the user's order.
      timeout:
        type: number
        required: false
        description: Optional. Seconds to wait before giving up on a slow or unresponsive page. Omit to wait indefinitely (no timeout).
danger_patterns:
  - pattern: 'web_fetch.*127\.0\.0\.1'
    level: block
    reason: SSRF — localhost access blocked
  - pattern: 'web_fetch.*localhost'
    level: block
    reason: SSRF — localhost access blocked
  - pattern: 'web_fetch.*192\.168\.'
    level: block
    reason: SSRF — private network access blocked
  - pattern: 'web_fetch.*10\.0\.'
    level: block
    reason: SSRF — private network access blocked
  - pattern: 'web_fetch.*172\.(1[6-9]|2[0-9]|3[01])\.'
    level: block
    reason: SSRF — private network access blocked
  - pattern: 'web_fetch.*file://'
    level: block
    reason: SSRF — local file access blocked
  - pattern: 'web_fetch.*\.local'
    level: block
    reason: SSRF — local network access blocked
confirm_patterns:
  - pattern: 'web_fetch.*\.(exe|msi|dmg|pkg|deb|rpm|sh|bat|ps1)$'
    reason: Fetching executable/installer content
---

# Web Fetch

## Tools

- `web_fetch` — read one page from a URL as text (Markdown-ish)

## Picking an engine

The user sets the order in Settings → Services → Web Fetch (default: direct, then DeepSeek). Omitting `engine` follows it; on failure the call falls through to the next engine on its own.

| engine | excels at | watch out for |
|---|---|---|
| `direct` | instant and free; static pages, docs, blogs, READMEs, raw text/JSON | sees only what the server sends — a JS-rendered page comes back empty, and 403s, cookie walls and bot checks defeat it |
| `deepseek` | clean Markdown; gets through some sites that refuse or break a direct GET; JS-heavy marketing and docs sites often read fine | paid per page; slower (seconds, up to ~12s on heavy sites); cannot read PDFs or other binary files; only when the user switched it on with a key |

- Pass `engine: "deepseek"` straight away for a page a direct fetch already failed on, or a site you know refuses plain clients — don't re-run the direct fetch first.
- A result read through DeepSeek or after a fallback ends with a `[web_fetch: …]` line naming the engine and why. Say so if the user asks where a page came from.
- A PDF or other binary file is never retried on DeepSeek — use the pdf or document capabilities on a downloaded file instead.

## When to use web_fetch

Use `web_fetch` after `web_search` when:
- The snippets aren't enough to fully answer the question (and the search couldn't return page text itself — see `includeContent` on DeepSeek search)
- You need to read an article, documentation page, or reference in detail
- The user explicitly asks you to read or visit a specific URL

Fetch the most relevant 1–2 URLs, not all of them. Never fetch more than 3 pages in one conversation turn.

## Read what comes back before trusting it

A page that returns a few hundred characters, a cookie banner, "enable JavaScript", a login form, or a subscribe wall did not actually load — it failed quietly. Don't answer from the fragment. Try `engine: "deepseek"` once if it is set up; if that is thin too, or the page needs a login or a click, it is a job for the browser extension (`tool_activate("browser-extension")`), which renders it as the user's own browser would. Two failed fetches cost more than opening the browser would have.
