---
name: memes
description: Find, generate, and share memes and GIFs. Can create custom captioned memes from popular templates or search for reaction GIFs.
triggers:
  - meme
  - memes
  - funny
  - gif
  - laugh
  - humor
  - joke
  - lighten
  - mood
  - reaction
  - lol
  - lmao
  - haha
  - cheer up
  - frustrated
  - celebrate
  - hilarious
  - comedy
  - rofl
  - emoji
  - sticker
  - drake
  - distracted boyfriend
  - this is fine
  - stonks
  - doge
  - pepe
  - sarcasm
  - irony
  - send meme
  - make meme
  - create meme
  - trending
  - viral
  - entertainment
  - fun
  - bored
  - xd
  - bruh
  - oof
  - rip
  - facepalm
  - shrug
  - clap
  - fire
  - dead
  - crying
  - laughing
  - wink
  - smirk
  - thumbs up
  - mind blown
  - surprised pikachu
  - galaxy brain
  - wojak
  - chad
  - npc
  - copium
  - based
  - sus
  - among us
  - rickroll
  - wholesome
  - cringe
  - relatable
  - mood
  - vibe
  - show me a meme
  - find a gif
  - send a gif
  - reaction gif
  - make me laugh
  - cheer me up
  - something funny
tools:
  - name: add_to_chat
    description: Insert the most recently generated meme or GIF into the CURRENT chat as an inline image. No arguments needed. Call after meme_generate, gif_search, or gif_trending when the image should appear here. To send it to someone on a channel instead, pass the wolffish-media:// path from the generate result to send_file / whatsapp_send_image — never base64 it.
    parameters: {}
  - name: meme_generate
    description: Generate a captioned meme image from a template. Pass template_id exactly as returned by meme_templates — the id determines the provider on its own. Returns a wolffish-media:// path to the saved image.
    parameters:
      template_id:
        type: string
        description: "Template id from meme_templates. A slug (e.g. drake, fry, distracted-boyfriend) renders via memegen; an all-numeric id renders via Imgflip. Reuse the id as-is."
      lines:
        type: array
        description: "Caption text for each box in the meme template, in order (top to bottom)"
      provider:
        type: string
        description: "Optional and usually unnecessary — the provider is inferred from template_id. Don't pass a provider that disagrees with the id; the id wins."
        enum:
          - memegen
          - imgflip
        required: false
  - name: meme_templates
    description: List available meme templates, each tagged with its provider. Pass a returned id straight to meme_generate. Default (no provider) queries memegen's large searchable library; Imgflip only exposes ~100 popular templates.
    parameters:
      provider:
        type: string
        description: "Which API to query: memegen (default, large + searchable) or imgflip (~100 popular only)"
        enum:
          - memegen
          - imgflip
        required: false
      query:
        type: string
        description: "Filter templates by name (case-insensitive)"
        required: false
  - name: gif_search
    readOnly: true
    description: Search Giphy for a GIF by keyword. Requires Giphy API key in config.
    parameters:
      query:
        type: string
        description: "What to search for (e.g. frustrated developer, celebration, facepalm)"
      limit:
        type: number
        description: "Max results to return, 1-25 (default 3)"
        required: false
  - name: gif_trending
    description: Get trending GIFs from Giphy. Requires Giphy API key in config.
    parameters:
      limit:
        type: number
        description: "Max results to return, 1-25 (default 5)"
        required: false
---

# Memes

## When to meme

**Proactively (sparingly):** If the user seems frustrated, stressed, or the conversation naturally calls for humor — include a relevant meme. Once per conversation at most unless the user asks for more.

**On request:** When the user explicitly asks for a meme, says "send me a meme", "make a meme about X", "I need a laugh", "cheer me up", etc.

**When NOT to meme:** Don't send memes during genuinely serious issues, focused deep-work sessions, or when the tone is clearly not playful.

## Picking a provider

- **Giphy** — **preferred first choice.** If a Giphy API key is configured, search for a relevant GIF before generating a captioned meme. Giphy results are fast, expressive, and usually land better than generated text memes. Use `gif_search` with a descriptive query matching the mood or topic.
- **memegen.link** — fallback for captioned memes. Use when Giphy has no good match, the user explicitly asks for a captioned/template meme, or no Giphy API key is configured.
- **Imgflip** — only if the user has configured credentials AND specifically asks for it. Its library is just ~100 popular templates with no real search, so `meme_templates` with `provider: imgflip` often comes back empty — drop the provider to search memegen instead.

**One rule that prevents wasted calls: never mix provider and id.** The id from `meme_templates` already carries its provider (slug = memegen, all-numeric = Imgflip). Pass that id straight to `meme_generate` and leave `provider` off — `meme_generate` routes by the id. Don't take a memegen slug like `db` and call it with `provider: imgflip`; that combination is what used to fail.

## Popular templates and when to use them

| Template ID | Name | When to use |
|---|---|---|
| `drake` | Drake Hotline Bling | Preferring one thing over another |
| `distracted-boyfriend` | Distracted Boyfriend | Being tempted by something new |
| `this-is-fine` | This Is Fine | Everything is on fire but you're pretending it's okay |
| `change-my-mind` | Change My Mind | Hot takes, controversial opinions |
| `uno-draw-25` | UNO Draw 25 | Refusing to do something obvious |
| `always-has-been` | Always Has Been | Realizations about how things have always been |
| `expanding-brain` | Expanding Brain | Escalating levels of an idea (use 4 lines) |
| `panik-kalm-panik` | Panik Kalm Panik | Alternating emotions (use 3 lines) |
| `buzz` | Buzz Lightyear | "X, X everywhere" |
| `fry` | Futurama Fry | "Not sure if X or Y" |
| `success` | Success Kid | Celebrating a small win |
| `rollsafe` | Roll Safe | Clever but questionable logic |
| `picard-facepalm` | Picard Facepalm | Disappointment, disbelief |
| `doge` | Doge | Such X, much Y, very Z |
| `bad-luck-brian` | Bad Luck Brian | When something goes hilariously wrong |
| `one-does-not-simply` | One Does Not Simply | When something is harder than expected |
| `batman-slapping-robin` | Batman Slapping Robin | Shutting down a bad idea |
| `two-buttons` | Two Buttons | Choosing between two options |
| `afraid-to-ask` | Afraid to Ask Andy | Too embarrassed to admit ignorance |
| `disaster-girl` | Disaster Girl | Mischievous chaos |
| `aliens` | Ancient Aliens | Attributing everything to one cause |
| `woman-yelling-at-cat` | Woman Yelling at Cat | Heated disagreement with a calm counterpoint |
| `bernie-sitting` | Bernie Sitting | Showing up unexpectedly |
| `surprised-pikachu` | Surprised Pikachu | Predictable outcome that still surprises |
| `is-this-a-pigeon` | Is This a Pigeon | Misidentifying something completely |

## Caption guidelines

- Keep captions short and punchy.
- Match the meme format's conventions (e.g. Drake: top = bad thing, bottom = good thing).
- Make it specific to the conversation context — generic memes aren't as funny.
- For multi-box templates, each element in `lines` maps to a box in order.

## Delivering the image

Where the image should land decides how you deliver it:

**Into the current chat** — call `add_to_chat()` after generating or finding an image. It takes no arguments and automatically injects whatever was just generated.

Workflow:
1. If Giphy is configured, try `gif_search` first with a descriptive query. Fall back to `meme_generate` only if no good result or if a captioned meme is specifically needed.
2. Call `add_to_chat()` — no arguments needed
3. Add a short comment in your text response

Do **not** copy the markdown URL into your prose — `add_to_chat` handles delivery automatically.

**To someone on a channel** (e.g. "send this meme to my wife on WhatsApp") — do NOT use `add_to_chat` (that only posts to the current chat). Take the `wolffish-media://…` path from the `meme_generate` / `gif_search` result and pass it as the `path` to the channel's send tool — `whatsapp_send_image`, `telegram_send_photo`, or `send_file`. Those tools read the file off disk themselves. **Never** `base64`-encode the image to send it: that floods the context and hangs the turn. The path is all you need.
