---
name: video
description: Generate videos with MiniMax H3 — text-to-video, image-to-video, first/last-frame, and reference-driven generation (subject images, motion clips, voice/music audio). Async task flow with a live task card in chat.
triggers:
  - video
  - generate video
  - make a video
  - create a video
  - text to video
  - image to video
  - animate
  - animation
  - clip
  - video clip
  - film
  - cinematic
  - footage
  - b-roll
  - motion
  - minimax
  - hailuo
  - h3
tools:
  - name: video_check
    readOnly: true
    description: "Confirm video generation is configured and the API key works — costs nothing and spends no credits. Call this FIRST when a video request is the start of a conversation, when a previous generation failed on credentials, or any time you are unsure the service is set up; a generation attempt against an unconfigured service wastes a turn and confuses the user. Reports exactly what to tell them when something is missing."
    parameters: {}
  - name: video_generate
    description: "Start a MiniMax H3 video generation task. ASYNC: returns a task id immediately and a live task card appears in chat on its own — do NOT restate the card's contents; add at most one short sentence, then call video_await to collect the result (typical 1.5–5 min). YOU place the media, nothing else does it for you: read every file path and https URL out of the user's message and pass each one in the parameter that matches what it IS (still image → first_frame, last_frame or reference_images; video clip → reference_videos; sound → reference_audios) and what they said it is FOR. Never leave a media URL sitting in the prompt text, and never guess a slot — when you cannot tell whether a link is an image, a clip or audio (no file extension, a share or page link, an unexplained role), call ask_user offering exactly those choices and generate only after they answer. Media inputs are local file paths (absolute, ~/ or workspace-relative) or public https URLs; files are auto-validated and auto-optimized (downscale/transcode) to fit API limits, URLs pass through untouched. The user's format asks travel the same way — as parameters, never prompt words: a stated length goes in duration_seconds, stated quality in resolution, stated orientation in ratio; 'a 15 second vertical clip' written only in the prompt text generates the 6s 16:9 default. Generated videos include an AI soundtrack. Costs real API credits per run — one task per user request unless they ask for variants."
    parameters:
      prompt:
        type: string
        description: "What to generate, up to 7000 chars. Rich cinematic language works best — subject, action, camera movement, lighting, mood. Scene words only: a length, resolution or aspect ratio written here does nothing — those have their own parameters."
      title:
        type: string
        description: "Short human label for the task card header (defaults to a prompt snippet)."
        required: false
      duration_seconds:
        type: number
        description: "Clip length in seconds — integer 4 to 15. The default 6 is ONLY for requests that name no length: when the user says '15 seconds' this MUST be 15 — a length written in the prompt text instead silently produces the 6s default. Beyond 15s is impossible in one task: say so and offer one 15s clip or a multi-clip sequence."
        required: false
      resolution:
        type: string
        description: "Output resolution. Default 768P (fast, ~1.5 MB per 4s). 2K is slower and ~7x larger."
        enum:
          - 768P
          - 2K
        required: false
      ratio:
        type: string
        description: "Aspect ratio. Text-only generation needs one (defaults to 16:9). With image/video inputs OMIT it — the output adapts to the media."
        enum:
          - "16:9"
          - "4:3"
          - "1:1"
          - "3:4"
          - "9:16"
          - "21:9"
        required: false
      first_frame:
        type: string
        description: "STILL IMAGE the video starts from (path or https URL) — never a clip or an audio link. JPG/PNG/WEBP/HEIC, each side 256-5760px, aspect between 2:5 and 5:2."
        required: false
      last_frame:
        type: string
        description: "STILL IMAGE the video ends on (path or https URL). Combine with first_frame for a bookend transition."
        required: false
      reference_images:
        type: array
        description: "Up to 9 STILL IMAGES (paths or https URLs) whose subject/style the video should keep consistent."
        required: false
      reference_videos:
        type: array
        description: "Up to 3 VIDEO clips (paths or https URLs) whose motion/behavior to reference. Each 2-15s, 15s combined max; oversized or non-H.264 files are transcoded automatically."
        required: false
      reference_audios:
        type: array
        description: "Up to 3 AUDIO clips (paths or https URLs) for voice/music reference. Each 2-15s; wav/mp3 pass through, anything else is converted."
        required: false
  - name: video_await
    description: "Wait for a video task to finish — the normal next call right after video_generate (blocks 1.5–5 min; that is expected, do not poll video_status in a loop instead). On success the mp4 is already saved locally and the result gives its absolute path: DELIVER it immediately — in-app call send_file with that path; on Telegram use telegram_send_video; on WhatsApp use whatsapp_send_video (channel tools auto-compress oversized files and note that the original stays in the app). On failure the result says exactly why — fix the inputs before any retry."
    parameters:
      task_id:
        type: string
        description: "Task to wait for. Omit for this conversation's most recent task."
        required: false
  - name: video_status
    readOnly: true
    description: "Instant, non-blocking snapshot of this conversation's video tasks (or one by id). For a quick glance while doing other work — video_await is how you actually collect a result."
    parameters:
      task_id:
        type: string
        description: "One task by id. Omit to list this conversation's tasks."
        required: false
  - name: video_cancel
    description: "Cancel a queued or running video generation task server-side. The task card flips to cancelled."
    parameters:
      task_id:
        type: string
        description: "The task to cancel, exactly as returned by video_generate."
---

# Video generation (MiniMax H3)

Runs on the key saved under **Settings → Services → Video generation**. That
is a SEPARATE field from the MiniMax chat provider: the same MiniMax key
value works in both, but the app never copies one into the other, so a user
with MiniMax configured as a chat brain may still have video generation
unconfigured. When in doubt call `video_check` before generating — it is free
and tells you exactly what to say if something is missing.

One model, four modes, all through `video_generate`:

| Mode | Inputs | Notes |
| --- | --- | --- |
| Text-to-video | `prompt` only | `ratio` required (defaults to 16:9) |
| Image-to-video | `first_frame` and/or `last_frame` | output adapts to the image — omit `ratio` |
| Reference | `reference_images` / `reference_videos` / `reference_audios` | keeps subject, motion, or voice consistent |
| Mixed | any combination of the above | ≤12 media items total |

Output: H.264 mp4 with an AI-generated soundtrack, 24 fps, 768P (≈1344×768)
or 2K (≈2560×1440), 4–15 s. Saved automatically under
`generations/video/conv-<conversation>/` in the workspace — never re-download it.

## Placing the user's media (you do this, not the UI)

There is no picker that tells the app which link is the first frame and which
is the voice reference. **The user writes a message; you read the media out of
it and put every item in the right parameter.** Do this before anything else in
a video turn:

1. **Collect** every media reference in the request — attached files (their
   absolute paths come in the `<attachments>` note), https URLs written in the
   prose, and paths named earlier in the conversation that they are pointing
   back at ("use the logo from before").
2. **Classify each one** by what it IS. Extension first (`.png` → image,
   `.mp4` → video, `.mp3`/`.wav` → audio), then the sentence around it —
   "start on this", "her voice", "match this camera move". An attachment's
   `type=` field settles it outright.
3. **Assign by what it is FOR**, which the wording tells you:

   | They said | Parameter |
   | --- | --- |
   | start on / open with / from this photo | `first_frame` |
   | end on / land on / finish with | `last_frame` |
   | keep this character / this style / this product | `reference_images` |
   | move like this / this camera work / this action | `reference_videos` |
   | this voice / this music / sing this | `reference_audios` |

   An image with no stated role and no other image present is the
   `first_frame`; several unroled images are `reference_images`.
4. **Never** paste a media URL into `prompt`. The prompt describes the scene in
   words; media travels in its own parameter. A link left in the prompt is read
   as prose, not fetched.

### When you cannot tell, ask — do not guess

Extensionless links are common (signed CDN links, `?format=` params, share
pages) and a wrong slot fails the whole request. If a link's kind or its role
is genuinely unclear, stop and call `ask_user` **before** `video_generate`:

```
ask_user({ questions: [{
  question: "What is https://cdn.example.com/a8f3c2?",
  details: "The link has no file extension, so I cannot tell what it holds. It decides where it goes in the video request.",
  options: [
    { label: "An image", description: "Used as the opening frame" },
    { label: "A video clip", description: "Referenced for motion and camera work" },
    { label: "An audio clip", description: "Referenced for voice or music" }
  ]
}] })
```

Bundle several unclear items into ONE `ask_user` call (one question each), then
generate once with everything placed. Asking costs a few seconds; a mis-slotted
input costs a failed run and real credits.

The tools defend the same line: a URL whose extension proves the wrong kind
(an `.mp3` handed to `first_frame`) is rejected before the API call, with the
correct parameter named. Extensionless URLs are passed through untouched — which
is exactly why the ask above is yours to make, not the tool's.

## The user's specs ride as parameters too

Exactly like media, format asks are parameters, never prompt words. The API
reads `duration_seconds`, `resolution` and `ratio` — it does not read "a 15
second vertical clip in 2K" out of the prompt; that prose generates the
default 6 s, 768P, 16:9 video. Mine the request for specs the same way you
mine it for media:

| They said | Parameter |
| --- | --- |
| "15 seconds", "a short 4s clip", "as long as possible" | `duration_seconds: 15` / `4` / `15` |
| "2K", "high quality", "max resolution" | `resolution: "2K"` |
| "vertical", "portrait", "for Shorts/Reels/TikTok" | `ratio: "9:16"` (text-only runs — with visual inputs still omit `ratio`) |
| "square" | `ratio: "1:1"` |

Defaults (6 s, 768P, 16:9) are for requests that say nothing — never
overrides of what the user asked. A length beyond 15 s cannot happen in one
task: say so and offer one 15 s clip or a sequence to stitch. The
`video_generate` result echoes the settings actually used — if they do not
match what the user asked, `video_cancel` and resubmit before the credits
are spent.

## The task flow (follow exactly)

0. `video_check` when the service's state is unknown (first video request of a
   conversation, or after a credential failure). Free; skip it once you have
   seen it pass in this conversation.
1. `video_generate` → task id + live task card. The card shows status,
   progress, and the finished video on its own — write at most one short
   sentence around it, never a play-by-play.
2. `video_await` → parks until the task lands. Success returns the absolute
   mp4 path; failure returns the API's reason.
3. Deliver: in-app `send_file <path>`; Telegram `telegram_send_video`;
   WhatsApp `whatsapp_send_video`. Channel tools compress oversized videos
   automatically and tell the user the original quality is in the app.

If you skip `video_await` and keep working, a runtime notice announces the
landing; deliver the artifact then. If the user asks to stop, `video_cancel`.

## Limits the tools enforce for you

- Images: JPG/PNG/WEBP/HEIC/HEIF, sides 256–5760 px, aspect 2:5–5:2, ≤30 MB.
  Anything large is downscaled to ~2048 px (verified: output quality is
  unchanged — generation caps at 2K anyway).
- Video refs: 2–15 s each and combined, ≤3 clips; auto-transcoded to H.264
  ≤1280 px when oversized or in another codec/container.
- Audio refs: 2–15 s each, ≤3 clips, wav/mp3 (auto-converted otherwise).
- Whole request ≤64 MB. Files ship base64; https URLs cost nothing against
  that budget — prefer URLs for big media.
- Prompt ≤7000 chars.

When an input violates a limit that cannot be fixed automatically (a 40 s
clip, a 1:6 panorama), the tool error says so — trim/crop with ffmpeg
(`ffmpeg_run`) and retry once, or ask the user.

## Prompt craft and Director mode

Your system prompt carries a `<video_prompting>` directive set by the user's
Settings → Services → Video generation toggle. Honor it exactly — nothing
enforces it but you:

- **Director ON**: you write the prompt. Name the subject, the action, the
  camera (push-in, orbit, handheld), the light, and the mood; one scene per
  clip beats a shot list; for first/last-frame runs describe the MOTION
  between the frames, not the frames. Then show the user the exact prompt
  you sent, as a short quoted block ("Directed as: …") — that replay is how
  they steer the next take.
- **Director OFF**: the user's request IS the prompt — forward it to
  `video_generate` verbatim, no rewriting or added style language, however
  flat it looks. Strip only obvious non-prompt framing ("make a video
  of…"). No replay needed: they already know what they wrote.

Both modes share one hard rule: directing (or verbatim forwarding) shapes
the **prose**. A length, resolution or ratio the user stated goes in its
parameter — a rewrite must never eat a spec, and leaving it in the prompt
text does not send it.
