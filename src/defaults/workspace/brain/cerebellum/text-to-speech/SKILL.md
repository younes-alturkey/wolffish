---
name: text-to-speech
description: Generate voice memos from text using a fully local neural TTS engine (Kokoro). Convert any text to spoken audio, respond with voice memos, or create voice summaries — entirely on-device, no cloud.
triggers:
  - voice
  - speak
  - say
  - audio
  - read aloud
  - voice memo
  - tts
  - text to speech
  - say this
  - read this
  - talk
  - narrate
  - spoken
  - pronounce
  - recite
  - announce
  - dictate
  - speech
  - sound
  - mp3
  - audio file
  - voice message
  - voice note
  - podcast
  - audiobook
  - read out loud
  - tell me
  - convert to audio
  - generate audio
  - generate voice
  - synthesize
  - text to audio
  - make it speak
  - play this
  - listen to this
  - listen to text
  - vocal
  - voiceover
  - voice actor
  - narrator
  - announcer
  - ai voice
  - natural voice
  - human voice
  - male voice
  - female voice
  - accent
  - pitch
  - speed
  - rate
  - recording
  - audio output
  - sound file
  - save as audio
  - export audio
  - respond with voice
  - say it out loud
  - speak this text
  - read it to me
tools:
  - name: voice_generate
    description: Convert text to a voice memo (MP3). Returns the file path of the generated audio. The voice memo appears as an attachment alongside the text response.
    parameters:
      text:
        type: string
        description: The text to convert to speech
      voice:
        type: string
        required: false
        description: "Kokoro voice id (e.g. af_bella). OMIT to use the user's configured default voice (Settings → Text-to-Speech). American voices start af_ (female) / am_ (male); British voices bf_ / bm_."
      speed:
        type: string
        required: false
        description: "Speech rate multiplier between 0.5 and 1.5 (default 1.0). Omit to use the user's configured default."
  - name: voice_respond
    description: >-
      Reply to the user as a spoken voice memo — the default close for a <voice_note> prompt. The audio carries the reply — never restate its text as a regular message; a brief label like "Voice memo" is the only prose it needs. Files and other deliverables still go out normally BEFORE it. The memo is the TURN'S CLOSE, not an intermission: your wrap-up is SPOKEN by this call, so no second written version of it follows. If you find yourself composing prose after it, you have already said that news — end that reply with zero characters.
    parameters:
      text:
        type: string
        description: The full response text to speak
      voice:
        type: string
        required: false
        description: "Kokoro voice id (e.g. af_bella). OMIT to use the user's configured default voice."
      speed:
        type: string
        required: false
        description: "Speech rate multiplier between 0.5 and 1.5 (default 1.0). Omit to use the user's configured default."
  - name: voice_list
    readOnly: true
    description: List all voice memo files in the workspace voice directory with their timestamps and sizes.
    parameters: {}
  - name: voice_settings_get
    readOnly: true
    description: "Read the user's Text-to-Speech settings — default voice, default speed, whether voice replies are on, and whether the Kokoro engine is installed — plus the full list of selectable voices and speeds. Call this before changing a setting or answering a question about one."
    parameters: {}
  - name: voice_settings_set
    description: "Change the user's Text-to-Speech defaults. Applies to every later voice memo and updates the Settings → Text-to-Speech panel live. Pass only the fields being changed."
    parameters:
      voice:
        type: string
        required: false
        description: "New default voice id (e.g. am_onyx). Must be one of the selectable ids returned by voice_settings_get."
      speed:
        type: string
        required: false
        description: "New default speech rate: 0.75 (slow), 1.0 (normal), 1.25 (fast) or 1.5 (very fast)."
  - name: voice_engine_install
    description: "Install or repair the local Kokoro engine and its ~310 MB voice model — the same install as the button in Settings → Text-to-Speech, with the same progress bar. Only needed when voice_settings_get reports the engine is missing."
    parameters: {}
danger_patterns: []
confirm_patterns: []
requires:
  - python
  - ffmpeg
---

# Voice

## Interface

- Tools: `voice_generate`, `voice_respond`, `voice_list`
- Engine: **Kokoro** — a local 82M-parameter neural TTS model. Runs entirely
  on-device (CPU) via a managed Python runtime; no cloud, no API key, no account.
- Output: MP3 files stored in the workspace voice directory.

The first voice memo provisions the engine (a hermetic Python runtime, the
kokoro-onnx package, and the ~310 MB model) — this is a one-time download. Every
voice memo after that is fully offline.

You can also provision it up front with `voice_engine_install` — worth doing
when the user asks to set voice up, or when a first memo would otherwise stall
on a several-minute download with no explanation. `voice_settings_get` reports
whether it is already installed.

## When to use each tool

- **The user's message is tagged `<voice_note>` (they spoke instead of typing)** → follow the `<voice_prompts>` block when your prompt carries one — it is present exactly when the Voice replies switch (Preferences page, default ON) is on, and it makes the rule explicit: the turn MUST end with exactly one `voice_respond` speaking the answer — a conversational answer is the memo and nothing else; a working turn delivers files/tables/code exactly as a typed turn would, then closes with the memo. Only an explicit ask in the user's own message ("reply in text") overrides it. No `<voice_prompts>` block in your prompt means the switch is off — reply as normal text.
- **"convert this to a voice memo"**, **"read this aloud"**, **"say this"** → `voice_generate` with the specified text. The voice memo attaches below your text response.
- **"respond in voice"**, **"reply with audio"**, **"voice memo only"** → `voice_respond` with your full response. Do NOT also send the text as a regular message — the voice IS the response. Write only a brief label like "Voice memo" as your text output.
- **"summarize the last response as a voice memo"** → Condense your most recent response into spoken form and use `voice_respond`.
- **"from now on reply with voice memos"** → Use `voice_respond` for all subsequent responses until told otherwise.
- **"list my voice memos"** → `voice_list`.
- **"use a British voice from now on"**, **"talk slower"**, **"what voice are you using?"** →
  the settings tools below. Changing a default is something you do, not
  something you send the user to Settings for.

## Managing the settings for the user

You control this capability's own settings. The user never has to open Settings
to change their voice or speed — asking you IS the way to change it.

- `voice_settings_get` — the current default voice and speed, whether voice
  replies are on, whether the engine is installed, and the full selectable
  catalog. **Read before you write**: it tells you the exact voice ids and speed
  values that are accepted, so you never guess one.
- `voice_settings_set` — writes a new default `voice` and/or `speed`. Pass only
  what changes. The change is immediate and permanent until changed again.
- `voice_engine_install` — provisions the engine on demand.

**How to handle a request:**

| The user says | Do this |
|---|---|
| "use a male British voice" | `voice_settings_get`, pick a matching id (bm_george, bm_lewis, bm_daniel, bm_fable), `voice_settings_set` |
| "you're talking too fast" | `voice_settings_set` with the next speed down (1.25 → 1.0 → 0.75) |
| "speak slower **this time**" | Do NOT change the default — pass `speed` to that one `voice_generate` call |
| "what voice do you use?" | `voice_settings_get` and answer; no write |
| "try a few voices" | `voice_generate` per voice with an explicit `voice` argument; only set a default once they pick |

**Rules for changing a default:**

- A one-off request changes nothing. "Read this in a deeper voice" is a `voice`
  argument on that call; "use a deeper voice from now on" is a settings change.
  When it is genuinely ambiguous, make the one-off call and ask if they want it
  as their default.
- Say what you changed, in words the user recognizes — "Switched your default
  voice to George (English UK, male)" — not the raw id alone.
- Never invent a voice id. If the user names a voice that is not selectable,
  `voice_settings_set` refuses and tells you why; relay that and offer the
  closest match rather than silently substituting one.
- The panel and the user's phone update the moment you write, so do not tell
  the user to restart, reopen Settings, or refresh anything.
- Do not change a default the user did not ask you to change — not as a
  workaround for a failed memo, and not as a "while I was in there" tidy-up.

## Available voices

English only. American (`af_`/`am_`) and British (`bf_`/`bm_`) accents.

| Voice | Language | Gender |
|---|---|---|
| af_bella (default) | English (US) | Female |
| af_heart | English (US) | Female |
| af_nicole | English (US) | Female |
| af_sarah | English (US) | Female |
| am_adam | English (US) | Male |
| am_michael | English (US) | Male |
| am_onyx | English (US) | Male |
| bf_emma | English (UK) | Female |
| bf_isabella | English (UK) | Female |
| bm_george | English (UK) | Male |
| bm_lewis | English (UK) | Male |

These are the voices that can be set as the **default** (via
`voice_settings_set`), and they are exactly what Settings → Text-to-Speech and
the phone's Services screen list. Kokoro ships a handful more that no picker
offers — those still work as an explicit `voice` argument on a single call, but
cannot be made the default, because a value the panel does not recognize gets
rewritten back the next time the user opens Settings.

Leave `voice` unset unless the user explicitly names one for that memo.

## Speed

A multiplier from `0.5` (slow) to `1.5` (fast); `1.0` is normal. Omit to use the
user's configured default.

As the stored **default**, only the four values the panel offers are accepted:
`0.75` (slow), `1.0` (normal), `1.25` (fast), `1.5` (very fast). Any float in
`0.5`–`1.5` still works as a one-off `speed` argument.

## Rules

- Always pass text that reads naturally when spoken. Strip markdown formatting,
  code blocks, and special characters before sending to TTS.
- **Leave `voice` unset by default.** The configured default is applied
  automatically. Only pass `voice` when the user names one for that memo — to
  change what they get every time, use `voice_settings_set` instead.
- For long texts the engine handles them in one pass. No chunking needed.
- Voice files are stored in the workspace and persist across sessions.
