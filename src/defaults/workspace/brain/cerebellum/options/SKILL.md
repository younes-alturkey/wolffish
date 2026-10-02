---
name: options
description: Show the user several alternative pieces of content side by side — code, commands, config, message drafts, any markdown — as one tabbed card they can read and copy. Use it whenever you'd otherwise dump two or more variants of the same thing into your reply.
triggers:
  - give me options
  - show me a few versions
  - a couple of variants
  - alternatives
  - draft some options
  - a few ways
  - which wording
  - variations
  - some examples to pick from
  - write me a few
tools:
  - name: offer_options
    readOnly: true
    description: Show the user several alternative pieces of content as one tabbed card they can read and copy. Each option is a short title plus a body of code or markdown; the card puts the titles in a scrollable tab row (A, B, C …) and shows the selected option's body underneath with a copy button. Reach for it whenever a choice genuinely serves the user, not only when you were already going to paste two variants — if you are producing something to copy and a second version is defensibly different (shorter or warmer wording, another platform's command, a different trade-off between simple and complete), show both here rather than picking one silently or asking whether they also want the other. Lean toward it for that kind of work; skip it when there is one honest answer, where a card is padding. Purely presentational — it does not pause your turn and the user does not answer it, so continue your reply after the call; use ask_user instead when you need a decision back.
    parameters:
      title:
        type: string
        required: false
        description: Optional heading for the whole card, e.g. "Three ways to write the migration". Skip it when the options speak for themselves.
      options:
        type: array
        description: 'The alternatives, in display order. 2–8 items. Each is an object with a required "title" (2–4 words, shown in the tab) and "content" (the code or markdown body), plus optional "description" and "language".'
        items:
          type: object
          properties:
            title:
              type: string
              description: Short tab label — 2–4 words, e.g. "Postgres" or "Formal tone". Keep every title distinct and scannable; it is all the user sees before opening the tab.
            description:
              type: string
              description: Optional one-line note shown under the title — the trade-off this option makes, or when to reach for it.
            language:
              type: string
              description: 'Set this when the content is raw code, to the language id for highlighting (ts, python, bash, json, yaml, sql …). Leave it out when the content is markdown prose, and it renders as markdown.'
            content:
              type: string
              description: The body of this option, copied verbatim when the user hits copy. Raw code when "language" is set; otherwise markdown (which may itself contain fenced code blocks).
          required:
            - title
            - content
---

# Offer options

`offer_options` is how you hand the user **several versions of the same thing**
without turning your reply into a wall of stacked code blocks. It draws one
card in the chat: a horizontally scrolling row of lettered tabs (A, B, C …)
across the top, each labelled with that option's short title, and the selected
option's body underneath with a copy button.

It is **presentation only**. It does not pause your turn, the user never
answers it, and nothing comes back but a confirmation that the card was
drawn. Keep writing your reply after the call.

## When to use it

Whenever the honest answer is "here are a few ways to do this" and each way is
something the user would copy:

- Alternative implementations of the same function, query or config.
- The same command for macOS / Linux / Windows, or for npm / pnpm / yarn.
- Several drafts of a message, commit message, README section or docstring.
- The same data in a few shapes (JSON, YAML, TOML), or a schema in a few dialects.
- Before-and-after pairs the user may want to paste either half of.

**Don't wait until you were already going to paste two versions.** The common
case is quieter than that: you're about to produce ONE thing the user will
copy, and a second version is defensibly different — a shorter draft, a warmer
one, the other platform's command, the simple version next to the complete
one. Show both in the card. Two habits this replaces, both worse:

- Silently picking one and never telling them the other existed.
- Writing one, then asking *"want a shorter version too?"* — that costs the
  user a whole round trip to get something you could have handed them now.
  Show the options; don't offer to produce them.

Lean toward the card on that kind of work. It earns its place often — just not
every turn.

## When NOT to use it

- **One honest answer** — an explanation, a lookup, arithmetic, a single
  obvious implementation. Put it in your reply as a normal code block; a card
  with one tab is worse than no card, and inventing a second option to fill it
  is padding.
- Variants that differ only cosmetically. If you can't say in one clause why
  someone would pick B over A, B isn't an option.
- You need the user to **pick** so you can act on the choice — that's
  `ask_user`, which pauses and returns the answer. `offer_options` returns
  nothing; the user copies what they want and moves on.
- Long prose, an explanation, or a file you're delivering — reply normally, or
  `send_file` it.

## How to call it

- `options` — 2–8 items, best first. Each `{ title, content, description?, language? }`.
- `title` (per option) — 2–4 words, distinct, scannable. It is the entire tab
  label; "Option 1" tells the user nothing, "Postgres + JSONB" tells them
  everything.
- `content` — exactly what the user should end up with on their clipboard.
  Don't wrap it in a fence yourself when you're setting `language`; the card
  does that.
- `language` — set it for raw code so it highlights. Leave it off and the
  content renders as markdown, fenced blocks inside it included.
- `description` — optional, one line, the trade-off. Say what makes this
  option the right one, not what it is.

Two limits, and both REFUSE the whole call rather than quietly showing the
user less than you think they're seeing: at most **10 options**, and at most
**12,000 characters** per option (about 300 lines). Anything longer isn't a
snippet to copy — write it to a file and `send_file` it instead.

```
offer_options({
  title: "Three ways to debounce",
  options: [
    {
      title: "Plain timeout",
      description: "No deps, trailing edge only.",
      language: "ts",
      content: "export function debounce<T extends (...a: any[]) => void>(fn: T, ms = 250) {\n  let t: ReturnType<typeof setTimeout>\n  return (...args: Parameters<T>) => {\n    clearTimeout(t)\n    t = setTimeout(() => fn(...args), ms)\n  }\n}"
    },
    {
      title: "Leading + trailing",
      description: "Fires immediately, then settles — better for buttons.",
      language: "ts",
      content: "…"
    },
    {
      title: "lodash.debounce",
      description: "One dep, every edge case already handled.",
      language: "bash",
      content: "npm i lodash.debounce"
    }
  ]
})
```

## After the call

Say in one line what the options are and how they differ — "A is the
zero-dependency version, C is the one I'd ship" — and **don't repeat their
contents in your reply**. The card is where the content lives; echoing it
underneath is exactly the wall of code the card exists to replace.
