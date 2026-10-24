---
name: web-search
description: Search the web for current information, documentation, news, and research — Brave, DeepSeek or DuckDuckGo, in the user's order
triggers:
  - search
  - google
  - look up
  - find online
  - web
  - browse
  - website
  - news
  - latest
  - current
  - today
  - recent
  - article
  - documentation
  - docs
  - what is
  - who is
  - how to
  - site
  - research
  - information
  - learn about
  - tell me about
  - explain
  - find out
  - look into
  - check online
  - weather
  - price
  - stock
  - score
  - result
  - update
  - trending
  - wiki
  - wikipedia
  - tutorial
  - guide
  - reference
  - manual
  - blog
  - forum
  - stackoverflow
  - api docs
  - reddit
  - quora
  - medium
  - github pages
  - npm package
  - pypi
  - crate
  - library
  - framework
  - changelog
  - release notes
  - announcement
  - event
  - conference
  - compare
  - versus
  - vs
  - best practices
  - alternatives
  - reviews
  - ratings
  - benchmark
  - definition
  - meaning
  - translate
  - convert
  - calculate
  - recipe
  - address
  - directions
  - map
  - location
  - what happened
  - when did
  - where is
  - why does
  - can you find
  - search for
  - google it
  - look this up
requires:
  - node
tools:
  - name: web_search
    readOnly: true
    description: Search the web. Returns titles, snippets and URLs — never a page. Fast, and a query on Brave or DeepSeek spends the user's money, so use it to settle one fact or to find which URL to open. Engines run in the user's order (default Brave, then DeepSeek, then DuckDuckGo); pass `engine` to pick one, and it falls back down that order if the pick is off or fails. The result names the engine that answered. To actually read or work with a site, prefer the browser-extension capability.
    parameters:
      query:
        type: string
        description: 'The search query. On DeepSeek it also takes operators: site:, -site:, "exact phrase", -term, lang:en, after:2026-01-01, before:2026.'
      maxResults:
        type: number
        required: false
        description: Maximum number of results to return (default 5, max 20)
      engine:
        type: string
        required: false
        enum: [brave, deepseek, duckduckgo]
        description: Optional. Which engine to try first — see "Picking an engine". Omit to follow the user's order.
      includeContent:
        type: boolean
        required: false
        description: Optional, DeepSeek only. Also return each result's page text (capped per result), which often saves a web_fetch. Ignored by other engines.
---

# Web Search

## Tools

- `web_search` — search the web, returns titles + snippets + URLs (and, on DeepSeek, summaries, dates and optional page text)

To read a page, use `web_fetch` from the **web-fetch** capability.

## Search is one of three routes — pick deliberately

`web_search` is not the only way to reach the web, and often not the best one:

| | reaches | costs |
|---|---|---|
| `web_search` | an index — snippets, never a page | real money per query on Brave / DeepSeek; very fast |
| `web_fetch` | one page, as text | free (direct) or paid per page (DeepSeek); blind to JS, paywalls, logins |
| browser extension | essentially any page the user can open, and can click/scroll/fill | more tokens, more seconds; needs a connected browser |

**Lean toward the browser** whenever the task names a specific site, needs a logged-in or paid-for page, needs interaction, or spans more than a page or two. Nothing here is a rule — weigh it yourself.

## Picking an engine

The user sets which engines are on and their order in Settings → Services → Web Search. Omitting `engine` follows that order, and that is the right call most of the time. Pass `engine` when the query plays to one engine's strengths:

| engine | excels at | watch out for |
|---|---|---|
| `brave` | broad general index; English-language and Western news, products, docs | paid per query beyond the free tier; plain snippets only |
| `deepseek` | query operators (`site:`, `-site:`, `"exact"`, `-term`, `lang:`, `after:`, `before:`); a publication `date`, an `authority` tier (0–4, 3+ is highly authoritative) and a relevance `score` (1.5+ is good) per result; a long `summary` written for you to read; `includeContent: true` returns page text so you often skip a fetch; strong on Chinese and other Asian sources | paid per search; queries are capped at 128 characters; stacking several operators can come back empty — drop one and retry |
| `duckduckgo` | free, needs no key | scraped, so slow (throttled to one query per 10s) and easily rate-limited; plain snippets only |

- If the engine you asked for is off or fails, the call still answers from the next engine in the user's order. The result's `engine` says which one did; `notes` says why your pick was skipped and `fallback` lists engines that failed first. Don't retry an engine the notes say is not set up.
- For time-sensitive questions, `deepseek` with `after:` (or reading each result's `date`) beats guessing freshness from snippets.
- When you'd fetch the top hits anyway, `engine: "deepseek"` with `includeContent: true` is one paid call instead of a search plus several fetches.

## When to use web_search

Use `web_search` when the user:
- Asks about current events, recent news, or anything time-sensitive
- Needs documentation or reference material
- Asks "what is X", "who is X", or "how to do X" and you aren't confident in your answer
- Wants to look something up, find a link, or research a topic
- Asks about something you don't have reliable knowledge about
- Needs live data (prices, weather, scores, stock info)

## When NOT to search

Do not search when the user is:
- Asking you to perform a local task (run a command, edit a file, create something)
- Having casual conversation or asking for opinions
- Asking about something you already know well and confidently
- Asking about their local files, system, or workspace

## How to search effectively

- Use specific queries: "Python asyncio tutorial" not "how to do async stuff"
- Include relevant keywords and terms
- If the first search doesn't answer the question, refine the query and search again
- Don't guess — search and verify

## How to present results

- Synthesize information into a natural answer — don't dump raw search results
- Cite sources when presenting factual claims
- If multiple sources disagree, mention the disagreement
- Include relevant URLs so the user can read more

## Rate limiting

If every engine fails, tell the user search is temporarily unavailable and answer from your existing knowledge instead. Don't retry the same query more than twice.
