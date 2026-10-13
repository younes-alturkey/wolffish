#!/usr/bin/env node
/**
 * Build the voice-prompt conversation into demo/ — a whole session held by
 * talking, from the phone.
 *
 *   node scripts/demo/build-voice-showcase.mjs      # writes into demo/
 *   node scripts/demo/build-demo-bundle.mjs         # pack for the CDN
 *
 * A voice prompt is not an attachment on a text message: the player IS the
 * prompt on screen. The desktop still stores the transcript as the message's
 * `content` — it is what the model receives and what titling reads — but
 * `voicePrompt: true` tells the bubble not to print it back under the player
 * (MessageBubbles UserBubble). So the shape being demonstrated here is
 * specifically "content present, deliberately not rendered", which no other
 * conversation in the dataset shows more than once in a row.
 *
 * The replies are spoken too, which is the other half: a voice reply persists
 * as a tool result whose output is `{filePath, fileName, isResponse}` JSON, and
 * segments.ts turns that into an audio card. Both directions in one thread.
 *
 * `channel: 'mobile'` on purpose — this is the one conversation in the dataset
 * that was started on the phone, so it is also what puts the phone glyph on a
 * row in History and the conversations sheet (ChannelBadge).
 *
 * Every recording is .m4a, deliberately. A phone-recorded note IS m4a, and it
 * is the format both platforms decode — .ogg (what a Telegram or WhatsApp note
 * arrives as) is on iOS's unplayable list, so those render the hand-off card
 * instead of a player (fileKinds isPlayable). That fallback is worth showing
 * and the dataset already shows it ten times over, on the bridged voice notes
 * that genuinely are .ogg. This conversation is about the player.
 *
 * No bytes are written: every path resolves to the published sample for its
 * extension (src/lib/files/sampleFiles.ts), fetched on first play.
 *
 * Timestamps anchor off conv-file-showcase so the showcases keep a fixed order
 * at the top of the list; re-run this whenever that one is regenerated.
 */
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { sampleExtFor } from './sample-exts.mjs'

const ROOT = path.join(path.dirname(new URL(import.meta.url).pathname), '..', '..')
const DEMO = process.env.DEMO_OUT ?? path.join(ROOT, 'demo')
const CONV_ID = 'voice-showcase'
/** Hours above the file showcase — see build-chart-showcase for the convention. */
const ANCHOR_OFFSET_H = 48

const MODEL = 'claude-opus-4-8'
const UPLOADS = `uploads/conv-${CONV_ID}`
const OUTBOX = `files/voice/${CONV_ID}`

/**
 * The session, in order. `spoken` is the transcript the desktop stores as the
 * message content; `lang` is what the STT model reported. The reply is either
 * plain prose or a spoken one (`voice`), which rides a tool result.
 *
 * Deliberately mixed: two Arabic prompts among the English ones, because the
 * transcript language and the app language are independent and the audio card
 * has to look identical either way. One prompt carries a photo alongside the
 * recording — a voice note is a message, and a message can have more than the
 * audio on it.
 */
const TURNS = [
  {
    file: 'voice_0731.m4a',
    lang: 'en',
    spoken:
      'Morning. Give me the quick version of yesterday — what actually got finished, not the ' +
      'whole log.',
    reply:
      'Three things closed yesterday:\n\n' +
      '- **Release branch** rebased and pushed — `release/1.0.18`.\n' +
      '- **FFmpeg** installed, so the media tests stopped skipping.\n' +
      '- **Weekly review** moved to Sunday morning and is scheduled.\n\n' +
      'Still open: the download cache you asked me to leave alone, and the CI run that was ' +
      'testing the pre-rebase tip.',
    voice: 'reply_0731.mp3'
  },
  {
    file: 'voice_0733.m4a',
    lang: 'en',
    spoken: 'Re-run that CI build for me and tell me when it goes green.',
    reply:
      'Re-run queued against `41e7b83`. It usually takes about eight minutes; I will notify the ' +
      'phone when it settles rather than making you watch it.'
  },
  {
    file: 'voice_0742.m4a',
    lang: 'ar',
    spoken: 'كم صار عندي مصاريف هالشهر؟ اقرأها لي بصوتك.',
    reply:
      'إجمالي مصاريف الشهر حتى الآن **4,180 ريال** على 23 إيصالًا.\n\n' +
      'أكبر بند: الاشتراكات، 1,240 ريال — منها 890 ريال لخدمات لم تُستخدم منذ يونيو.',
    voice: 'reply_0742.mp3'
  },
  {
    file: 'voice_0751.m4a',
    lang: 'en',
    spoken:
      'This is the receipt from the place on Tahlia — file it under the finance database and ' +
      'tell me what the VAT came to.',
    photo: 'receipt.jpg',
    reply:
      'Filed.\n\n' +
      '| Field | Value |\n| --- | --- |\n| Merchant | Half Million, Tahlia |\n' +
      '| Date | 26 Jul 2026 |\n| Total | 74.75 SAR |\n| VAT | 9.75 SAR |\n\n' +
      'The VAT line was legible, so nothing was inferred. Row appended to the finance database.'
  },
  {
    file: 'voice_0758.m4a',
    lang: 'ar',
    spoken: 'ذكّرني أكلم أمي الساعة تسع بالليل.',
    reply: 'ضبطت تذكيرًا الساعة 9:00 مساءً بتوقيت الرياض. سيصلك إشعار على الجوال.'
  },
  {
    file: 'voice_0804.m4a',
    lang: 'en',
    spoken:
      'Last one. Read me back what you have written into my user file today, then stop — I do ' +
      'not want it changed again while I am driving.',
    reply:
      'Two lines were added today:\n\n' +
      '- Tuesday mornings are blocked until 11:00.\n' +
      '- Nothing is scheduled before 09:00 unless you named the time yourself.\n\n' +
      'Nothing else in `brain/identity/user.md` was touched, and I will not write to it again ' +
      'this session.',
    voice: 'reply_0804.mp3'
  }
]

async function main() {
  await fs.mkdir(path.join(DEMO, 'conversations'), { recursive: true })

  const referenced = [
    ...TURNS.map((turn) => turn.file),
    ...TURNS.filter((turn) => turn.photo).map((turn) => turn.photo),
    ...TURNS.filter((turn) => turn.voice).map((turn) => turn.voice)
  ]
  const unpublished = referenced.filter((name) => !sampleExtFor(name))
  if (unpublished.length) {
    console.warn(`no published sample for: ${unpublished.join(', ')} — will render unavailable`)
  }

  const showcaseRaw = await fs.readFile(
    path.join(DEMO, 'conversations', 'conv-file-showcase.json'),
    'utf8'
  )
  const anchor = JSON.parse(showcaseRaw).updatedAt
  if (typeof anchor !== 'number') throw new Error('conv-file-showcase.json has no updatedAt')
  const updatedAt = anchor + ANCHOR_OFFSET_H * 3600_000
  // Roughly the real gaps between the prompts, so the thread reads as a
  // morning rather than as six messages a second apart.
  const GAPS_MS = [0, 2 * 60_000, 11 * 60_000, 9 * 60_000, 7 * 60_000, 6 * 60_000]
  const span = GAPS_MS.reduce((sum, gap) => sum + gap, 0)
  const createdAt = updatedAt - span - 40_000

  const messages = []
  const ratings = []
  let at = createdAt

  TURNS.forEach((turn, index) => {
    at += GAPS_MS[index]
    const userId = `m_voice_u${index}`
    const assistantId = `m_voice_a${index}`

    messages.push({
      id: userId,
      role: 'user',
      // The transcript, stored but not printed — `voicePrompt` is what makes
      // the player the whole prompt on screen.
      content: turn.spoken,
      timestamp: at,
      attachments: [
        {
          type: 'audio',
          filePath: `${UPLOADS}/${turn.file}`,
          originalName: turn.file,
          mimeType: 'audio/mp4',
          // 0: the size is not known until the sample is downloaded, and the
          // cards already fall back to the size of the file the cache holds.
          sizeBytes: 0,
          durationSeconds: 4 + index
        },
        ...(turn.photo
          ? [
              {
                type: 'image',
                filePath: `${UPLOADS}/${turn.photo}`,
                originalName: turn.photo,
                mimeType: 'image/jpeg',
                sizeBytes: 0
              }
            ]
          : [])
      ],
      voicePrompt: true,
      voiceLang: turn.lang
    })

    const turnId = `t${index + 1}`
    const segments = [
      {
        kind: 'active_model',
        turnId,
        segmentId: `${turnId}s0`,
        provider: 'anthropic',
        model: MODEL
      },
      { kind: 'text', turnId, segmentId: `${turnId}s1`, delta: turn.reply }
    ]
    if (turn.voice) {
      const callId = `call_voice_${index}`
      segments.push({
        kind: 'tool_call',
        turnId,
        segmentId: `${turnId}s2`,
        toolCallId: callId,
        name: 'voice_speak',
        args: { text: turn.reply, voice: 'af_heart' }
      })
      // A spoken reply persists as this JSON payload; segments.ts recognises
      // `filePath` in a tool result and renders the audio card from it.
      segments.push({
        kind: 'tool_result',
        turnId,
        segmentId: `${turnId}s3`,
        toolCallId: callId,
        status: 'success',
        output: JSON.stringify({
          filePath: `${OUTBOX}/${turn.voice}`,
          fileName: turn.voice,
          isResponse: true
        })
      })
    }
    segments.push({
      kind: 'turn_end',
      turnId,
      segmentId: `${turnId}s9`,
      stopReason: 'end_turn',
      iterationCount: turn.voice ? 2 : 1
    })

    at += 30_000
    messages.push({
      id: assistantId,
      role: 'assistant',
      content: '',
      timestamp: at,
      segments,
      stopReason: 'end_turn'
    })

    // A couple of scores, so the ratings array is exercised on a conversation
    // with more than one ratable turn rather than only on its last.
    if (index === 0)
      ratings.push({ messageId: assistantId, score: 8, at: at + 20_000, source: 'mobile' })
    if (index === 3)
      ratings.push({ messageId: assistantId, score: 10, at: at + 15_000, source: 'mobile' })
  })

  const conversation = {
    id: CONV_ID,
    title: 'Morning, out loud',
    model: MODEL,
    // Started on the phone — the one row in the dataset wearing the phone glyph.
    channel: 'mobile',
    createdAt,
    updatedAt,
    messages,
    stats: {
      allTime: {
        turns: TURNS.length,
        toolCalls: TURNS.filter((turn) => turn.voice).length,
        apiCalls: TURNS.length + TURNS.filter((turn) => turn.voice).length,
        inputTokens: 21_960,
        outputTokens: 1_884,
        cost: 0.1043,
        provider: 'anthropic',
        model: MODEL,
        elapsedMs: span + 40_000,
        endedAt: updatedAt
      },
      meter: { contextTokens: 23_844, contextBudget: 200_000, model: MODEL }
    },
    ratings
  }

  await fs.writeFile(
    path.join(DEMO, 'conversations', `conv-${CONV_ID}.json`),
    JSON.stringify(conversation)
  )

  const spoken = TURNS.filter((turn) => turn.voice).length
  console.log(`voice prompts: ${TURNS.length} in, ${spoken} spoken replies out, 0 bytes`)
  console.log(`sorts above file showcase: updatedAt ${new Date(updatedAt).toISOString()}`)
  console.log(`conversation: demo/conversations/conv-${CONV_ID}.json`)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
