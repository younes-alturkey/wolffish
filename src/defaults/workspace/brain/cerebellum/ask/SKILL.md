---
name: ask
description: Ask the user one or more multiple-choice questions with an interactive in-app card — pause for their decisions, then continue with the options they pick or the custom instructions they type. Also the delivery mechanism for quizzes and knowledge checks.
triggers:
  - ask the user
  - ask me
  - which option
  - which one
  - let me choose
  - give me options
  - which do you prefer
  - up to you
  - your call
  - clarify
  - confirm with me
  - quiz me
  - quiz
  - test me
  - test my knowledge
  - knowledge check
  - multiple choice
tools:
  - name: ask_user
    readOnly: true
    description: Pose one or more multiple-choice questions to the user and wait for their answers. Renders a single interactive card in the chat (numbered tabs when asking several questions); the user answers each question by clicking an option or writing their own instructions, then your loop resumes with all their choices. Quizzes and knowledge checks MUST run through this tool — one item per quiz question, then grade from the returned answers; never print a quiz as chat text with answers hidden below.
    parameters:
      questions:
        type: array
        description: 'The questions to ask, in order. One item per question — a single item for a simple ask, several to bundle related decisions into one card instead of chaining separate asks. Each item is an object with a required "question" (one clear line) and "options" (2–5 choices, each { label, description? }), plus optional "details", "allow_other" (default true), "other_label", and "other_description".'
        items:
          type: object
          properties:
            question:
              type: string
              description: The question or decision to put to the user. One clear line, e.g. "Which database should I use?".
            details:
              type: string
              description: Optional extra context shown under the question — why you're asking, or what each choice affects.
            options:
              type: array
              description: The choices to offer, in display order. 2–5 focused, distinct options.
              items:
                type: object
                properties:
                  label:
                    type: string
                    description: The choice text shown to the user, e.g. "Use PostgreSQL".
                  description:
                    type: string
                    description: Optional short clarifying line shown under the label.
                required:
                  - label
            allow_other:
              type: boolean
              description: Whether this question shows the free-text "something else" escape hatch so the user can type their own instructions instead of picking a listed option. Defaults to true; set false only when the listed options are genuinely exhaustive.
            other_label:
              type: string
              description: Optional custom title for the free-text option (defaults to a localized "Something else").
            other_description:
              type: string
              description: Optional custom hint for the free-text option (defaults to a localized "Tell wolffish exactly what to do instead").
          required:
            - question
            - options
---

# Ask the user

`ask_user` is how you put decisions back to the user **with concrete choices**
instead of guessing or asking in plain prose. It pauses your turn, shows one
interactive card in the chat — each question with its numbered options (a
title and a short description each) and, unless you turn it off, a free-text
box for the user to write their own instructions — and resumes your loop the
moment every question is answered. Whatever they choose comes back to you as
the tool result, so you just continue from there.

One call takes a **list of questions**. With a single question the card looks
like a simple ask; with several, the card shows numbered tabs (1 2 3 …) and
moves to the next question as the user answers each one. On Telegram and
WhatsApp the questions are posed one message at a time, in order.

## When to use it

Reach for `ask_user` when **the next step depends on choices only the user
can make, and you can frame each choice as a few discrete options**:

- A real fork in the work: which approach, which file, which format, which of
  several candidates to act on.
- Disambiguating a vague request before you spend effort down one path.
- Confirming a consequential direction when there's more than a yes/no at stake.
- **Quizzing or testing the user — always through this tool.** Put every quiz
  question in ONE call (usually `allow_other: false` so answers stay gradeable),
  wait for the answers, then grade and explain in your reply. Never print a
  quiz as chat text — answers tucked behind `<details>` blocks are still the
  wrong shape; the interactive card is the quiz surface.

## When NOT to use it

- **Don't** use it for things you can decide yourself from context, the files,
  or sensible defaults. Asking when you should just act is friction.
- **Don't** use it for a plain open-ended question with no natural options —
  just ask in your normal reply.
- **Don't** chain separate `ask_user` calls for decisions you already know you
  need: bundle them as one call with several questions, so the user answers
  once. Only ask again if a genuinely new decision appears from their answers.

## How to call it

- `questions` — one item per question, in the order you want them answered.
  Keep the list short (1–4 is typical); every question should be one the user
  actually has to decide.
- Per question:
  - `question` — one clear line.
  - `options` — 2–5 items, each `{ label, description? }`. Keep labels short
    and the choices genuinely distinct. Order them the way you'd recommend.
  - `details` — optional context shown under the question.
  - `allow_other` — leave it on (default) so the user can always override with
    their own instructions; only set `false` when your options are exhaustive.

```
ask_user({
  questions: [
    {
      question: "Which database should I set up?",
      details: "This is for a single-user desktop app, so it'll run locally.",
      options: [
        { label: "SQLite", description: "Zero-config, file-based — simplest for local single-user." },
        { label: "PostgreSQL", description: "Heavier, but room to grow into multi-user later." }
      ]
    },
    {
      question: "Should I seed it with demo data?",
      options: [
        { label: "Yes", description: "A handful of sample rows to click around with." },
        { label: "No", description: "Start empty." }
      ]
    }
  ]
})
```

## What you get back

The tool result tells you exactly what happened:

- **Single question** → "The user selected option N: …" for a listed pick, or
  "The user … instead instructed: …" when they wrote their own instructions
  (which override your options).
- **Several questions** → one summary listing every question with its answer,
  in order — each either the selected option or the user's own words.
- **Dismissed / stopped** → they didn't answer (the run was stopped). Don't
  re-ask in a loop; fall back to a sensible default or your plain reply.

After you act on the answers, just keep going — don't re-announce the
questions.
