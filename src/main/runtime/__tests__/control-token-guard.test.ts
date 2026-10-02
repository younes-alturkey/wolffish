/**
 * Behavior tests for the control-token guard — the three detectors that
 * surface (never strip) a model faking silence: a trailing tokenizer control
 * token, a reply that is punctuation and nothing else, and a bracketed phrase
 * typed in place of an empty reply.
 *
 * Run: TSX_TSCONFIG_PATH=tsconfig.node.json npx tsx src/main/runtime/__tests__/control-token-guard.test.ts
 */
import assert from 'node:assert/strict'
import {
  armContentFreeReplyNotice,
  armControlTokenNotice,
  armSilencePlaceholderNotice,
  contentFreeReply,
  contentFreeReplyNotice,
  controlTokenNotice,
  drainControlTokenNotice,
  silencePlaceholder,
  silencePlaceholderNotice,
  trailingControlToken
} from '@main/runtime/agent/control-token-guard'

function testCleanTextNeverTrips(): void {
  assert.equal(trailingControlToken('All set — the report is on your desktop.'), null)
  assert.equal(trailingControlToken(''), null)
  // A mid-prose MENTION is content, not a leak — the user may be discussing
  // tokenizers (or this very bug). Only a trailing token trips.
  assert.equal(trailingControlToken('The token <|eos|> is an end-of-sequence marker.'), null)
  // `</s>` is deliberately off the list: legitimate closing-tag markup.
  assert.equal(trailingControlToken('That was <s>wrong</s>'), null)
  console.log('ok: clean text, mid-prose mentions, and </s> endings never trip')
}

function testObservedLeakShapesTrip(): void {
  // The two shapes observed live (grok-4.6): the token as the ENTIRE reply of
  // a telemetry continuation, and the token appended to otherwise-good text
  // (the Aug 14 conversation title).
  assert.equal(trailingControlToken('<|eos|>'), '<|eos|>')
  assert.equal(trailingControlToken('Daily (15:22): Younes AI Daily Arabic PDF<|eos|>'), '<|eos|>')
  // Trailing whitespace after the token still counts as trailing.
  assert.equal(trailingControlToken('Done.<|eos|>\n'), '<|eos|>')
  console.log('ok: both observed leak shapes are detected')
}

function testKnownTokenListTrips(): void {
  for (const token of [
    '<|eos|>',
    '<|endoftext|>',
    '<|im_end|>',
    '<|eot_id|>',
    '<|end_of_text|>',
    '<|end▁of▁sentence|>'
  ]) {
    assert.equal(trailingControlToken(`reply text${token}`), token, `detects trailing ${token}`)
  }
  console.log('ok: every token on the conservative list is detected when trailing')
}

function testNoticeNamesTokenAndDefers(): void {
  const notice = controlTokenNotice('<|eos|>')
  assert.match(notice, /<\|eos\|>/, 'the notice names the leaked token')
  assert.match(notice, /disregard/, 'the notice defers to deliberate quoting')
  assert.match(notice, /close_turn/, 'the notice names the producible exit as the fix')
  assert.match(notice, /Parentheses are for real/, 'and says what brackets are actually for')
  assert.doesNotMatch(
    notice,
    /\(no output\)|\(nothing to add\)/i,
    'the notice never prints a stand-in it forbids — printing one is how the model learns it'
  )
  console.log('ok: the notice names the token, offers the silent exit, and defers')
}

function testArmAndDrainReachTheModelAnywhere(): void {
  assert.equal(drainControlTokenNotice('conv-a'), undefined, 'nothing pending initially')
  armControlTokenNotice('conv-a', '<|eos|>')
  const drained = drainControlTokenNotice('conv-a')
  assert.ok(drained && drained.includes('<|eos|>'), 'armed notice drains for its conversation')
  assert.doesNotMatch(
    drained!,
    /DIFFERENT conversation/,
    'same conversation gets the notice as written — the stray text IS in the history above'
  )
  assert.equal(
    drainControlTokenNotice('conv-a'),
    undefined,
    'drain clears — announced exactly once'
  )

  // The hole this guard existed inside until 2026-09-17: every autonomous run
  // mints a fresh conversation that is sealed after one turn, so a notice that
  // only drained for its OWN conversation could never be delivered at all.
  // It now reaches the model's next call wherever that call happens.
  armControlTokenNotice('conv-sealed-heartbeat', '<|eos|>')
  const elsewhere = drainControlTokenNotice('conv-b')
  assert.ok(elsewhere && elsewhere.includes('<|eos|>'), 'a dead conversation still teaches')
  assert.match(
    elsewhere!,
    /DIFFERENT conversation/,
    'and says so, so the model never apologises here for a message nobody here saw'
  )
  assert.match(elsewhere!, /Carry the rule forward/, 'the clause says what to do instead')
  assert.equal(drainControlTokenNotice('conv-c'), undefined, 'still announced exactly once')

  // A leak with no conversation id still travels; it just never claims to be
  // the conversation it lands in.
  armControlTokenNotice(null, '<|eos|>')
  const anon = drainControlTokenNotice(null)
  assert.ok(anon && anon.includes('DIFFERENT conversation'), 'unknown origin never claims "here"')

  // Latest leak wins when two arm before a drain.
  armControlTokenNotice('conv-c', '<|eos|>')
  armControlTokenNotice('conv-c', '<|im_end|>')
  const latest = drainControlTokenNotice('conv-c')
  assert.ok(latest && latest.includes('<|im_end|>'), 'latest arm overwrites')
  console.log('ok: arm/drain reaches the model anywhere, once-only, latest-wins')
}

function testContentFreeDetectsFakedSilence(): void {
  // The observed leak (2026-09-06, deepseek-v4): a lone period as the whole reply.
  assert.equal(contentFreeReply('.'), '.')
  assert.equal(contentFreeReply('...'), '...')
  assert.equal(contentFreeReply('…'), '…')
  assert.equal(contentFreeReply('-'), '-')
  // Surrounding whitespace and invisible format chars are not content either.
  assert.equal(contentFreeReply('  .\n'), '.')
  assert.equal(contentFreeReply('\u200b.'), '.')
  console.log('ok: punctuation-only replies are detected as faked silence')
}

function testContentFreeNeverTripsOnContent(): void {
  // Truly empty is the empty-turn guard's job — nothing has reached the user yet.
  assert.equal(contentFreeReply(''), null)
  assert.equal(contentFreeReply('   \n'), null)
  // Real replies, however short, in any script.
  assert.equal(contentFreeReply('Done.'), null)
  assert.equal(contentFreeReply('Yes'), null)
  assert.equal(contentFreeReply('42'), null)
  assert.equal(contentFreeReply('نعم'), null)
  // Emoji are symbols, not punctuation — a thumbs-up IS a reply.
  assert.equal(contentFreeReply('👍'), null)
  assert.equal(contentFreeReply('✅'), null)
  // A long punctuation run is plausibly the content asked for; the guard defers.
  assert.equal(contentFreeReply('-----------'), null)
  console.log('ok: content, emoji, empty text and long rules never trip')
}

function testContentFreeNoticeEchoesAndDefers(): void {
  const notice = contentFreeReplyNotice('.')
  assert.match(notice, /`\.`/, 'the notice echoes the characters the user saw')
  assert.match(notice, /close_turn/, 'the notice names the producible exit as the fix')
  assert.doesNotMatch(
    notice,
    /\(no output\)|\(nothing to add\)/i,
    'the notice never prints a stand-in it forbids'
  )
  assert.match(notice, /disregard/, 'the notice defers to deliberate punctuation')
  assert.match(notice, /parenthesis/, 'brackets do not make a note out-of-band')
  console.log('ok: the content-free notice echoes, offers the silent exit, and defers')
}

function testContentFreeSharesTheNoticeSlot(): void {
  armContentFreeReplyNotice('conv-d', '.')
  const drained = drainControlTokenNotice('conv-d')
  assert.ok(drained && drained.includes('CONTENT-FREE'), 'drains through the shared slot')
  assert.equal(drainControlTokenNotice('conv-d'), undefined, 'drain clears')
  armContentFreeReplyNotice(null, '.')
  assert.ok(drainControlTokenNotice(null), 'an id-less leak still travels')
  console.log('ok: the content-free notice rides the same shared slot')
}

function testSilencePlaceholderDetectsTheObservedLeaks(): void {
  // The two shapes that actually shipped to users.
  assert.deepEqual(silencePlaceholder('(no content)'), { text: '(no content)', trailing: false })
  assert.deepEqual(silencePlaceholder('(no output)'), { text: '(no output)', trailing: false })
  assert.deepEqual(silencePlaceholder('  (No Output)\n'), {
    text: '(No Output)',
    trailing: false
  })
  // Stapled under a real reply, which is how 2026-09-12 landed.
  assert.deepEqual(
    silencePlaceholder('Done — the report is on your desktop.\n\n(no output)'),
    { text: '(no output)', trailing: true },
    'a marker on its own line after prose is the trailing shape'
  )
  // Observed live 2026-09-17 (deepseek-flash, heartbeat run): the model's own
  // reasoning concluded "Let me output nothing" and then typed this instead.
  assert.deepEqual(silencePlaceholder('[Empty response]'), {
    text: '[Empty response]',
    trailing: false
  })
  // The rest of the vocabulary, in every bracket the models reach for.
  for (const reply of [
    '(nothing to add)',
    '[no reply]',
    '(empty response)',
    '(staying silent)',
    '(end of turn)',
    '(silence)',
    '(no further output)',
    '{nothing further}'
  ]) {
    assert.ok(silencePlaceholder(reply), `detects ${reply}`)
  }
  console.log('ok: bracketed stand-ins trip, alone and stapled onto prose')
}

function testSilencePlaceholderClosesTheClass(): void {
  // The whole point of the structural detector. Observed live 2026-09-19
  // (deepseek-flash, mobile, conversation 2026-09-19_23-43-28_568-9587df):
  // the model wrote its reply, sent its notification, then typed this —
  // APPENDED to a reply that had already finished. The old exact-match
  // allowlist rejected it (the `empty` branch was anchored and forbade
  // trailing text), so no notice was armed and the model was never told.
  assert.deepEqual(
    silencePlaceholder('One flag: the two lines conflict. 🐟[(empty — nothing further)]'),
    { text: '[(empty — nothing further)]', trailing: true },
    'the 2026-09-19 appended leak must trip'
  )
  assert.deepEqual(silencePlaceholder('[(empty — nothing further)]'), {
    text: '[(empty — nothing further)]',
    trailing: false
  })
  // Nobody has ever seen these. They must trip anyway — that is what proves
  // the guard stopped being a list of known literals. A vocabulary test can
  // only verify the past; these verify the future.
  for (const reply of [
    '(nothing else to say)',
    '[no message follows]',
    '(I have nothing to add here)',
    '(empty, no content)',
    '{nothing further from me}',
    '(no further response required)',
    '(nothing more)',
    '(silent)'
  ]) {
    assert.ok(silencePlaceholder(reply), `detects the never-seen phrasing ${reply}`)
  }
  console.log('ok: novel phrasings trip — the class is closed, not enumerated')
}

function testSilencePlaceholderDetectsTheChineseLeak(): void {
  // Observed live 2026-09-18 (deepseek-flash, heartbeat run): the runtime's own
  // todo close-out nudge ordered "end with an entirely empty response — zero
  // characters", and the model answered with the Chinese set phrase for
  // "utterly empty" — four characters, four output tokens, the whole final
  // reply. Every check here was English-only, so nothing saw it and the model
  // was never told. See CJK_SILENCE_PHRASES and todo-guard.
  assert.deepEqual(silencePlaceholder('空空如也'), {
    text: '空空如也',
    trailing: false
  })
  // Stapled under prose, the same second shape the English vocabulary has.
  assert.deepEqual(
    silencePlaceholder('Published, verified live, ledgered.\n\n空空如也'),
    { text: '空空如也', trailing: true },
    'a CJK stand-in after real prose is the trailing shape'
  )
  // Bare, and inside brackets of either width — both reach the user identically.
  for (const reply of [
    '无内容',
    '無內容',
    '无输出',
    '没有内容',
    '无话可说',
    '保持沉默',
    '（无输出）',
    '[无内容]',
    '【空回复】',
    '无内容。'
  ]) {
    assert.ok(silencePlaceholder(reply), `detects ${reply}`)
  }
  console.log('ok: the Chinese stand-in trips, bare and bracketed, alone and after prose')
}

function testSilencePlaceholderNeverTripsOnChineseContent(): void {
  // A set phrase inside a sentence is content, exactly as in English.
  assert.equal(
    silencePlaceholder('我们的数据库空空如也，需要重新导入数据'),
    null,
    'mid-sentence is Chinese, not a faked silence'
  )
  assert.equal(silencePlaceholder('The folder was 空空如也 when I checked it.'), null)
  assert.equal(
    silencePlaceholder('任务已完成，所有五条推文已发布。'),
    null,
    'a real Chinese wrap-up is a reply, not a stand-in'
  )
  // Single characters are deliberately off the list, for the same reason
  // `(none)` is off the English one: each has an ordinary use as content.
  assert.equal(silencePlaceholder('空'), null)
  assert.equal(silencePlaceholder('无'), null)
  // A longer idiom that merely contains a listed phrase is not that phrase.
  assert.equal(silencePlaceholder('沉默是金，但这次需要说明'), null)
  console.log('ok: Chinese prose, single characters and longer idioms never trip')
}

function testSilencePlaceholderNeverTripsOnContent(): void {
  assert.equal(silencePlaceholder(''), null)
  assert.equal(silencePlaceholder('Done.'), null)
  assert.equal(silencePlaceholder('.'), null, "punctuation is the other detector's job")
  // An ordinary parenthetical inside a sentence is content, not a marker.
  assert.equal(
    silencePlaceholder('The command printed nothing (no output) and exited 0.'),
    null,
    'mid-sentence parentheticals are English, not a faked silence'
  )
  assert.equal(
    silencePlaceholder('The build ran clean (no output)'),
    null,
    'a trailing parenthetical on the SAME line as its sentence is still prose'
  )
  // Phrases with an ordinary use as content stay off the vocabulary.
  assert.equal(silencePlaceholder('Blockers: (none)'), null)
  assert.equal(silencePlaceholder('(n/a)'), null)
  assert.equal(silencePlaceholder('(see the attached diff for the full list of changes)'), null)
  console.log('ok: parentheticals, (none) and long asides never trip')
}

function testSilencePlaceholderNoticeSeparatesTheTwoShapes(): void {
  const alone = silencePlaceholderNotice({ text: '(no content)', trailing: false })
  assert.match(alone, /`\(no content\)`/, 'echoes what the user saw')
  assert.match(alone, /close_turn/, 'names the producible exit as the fix')
  assert.match(alone, /entire previous reply/, 'says the whole reply was the stand-in')
  assert.match(alone, /disregard/, 'defers to deliberate content')

  assert.match(alone, /Parentheses/, 'brackets do not make a note out-of-band')
  assert.match(
    alone,
    /writing it IS the failure it describes/,
    'a well-argued note about the silence is still the failure'
  )

  const stapled = silencePlaceholderNotice({ text: '(no output)', trailing: true })
  assert.match(stapled, /last real character/, 'names the appended-marker shape')
  assert.doesNotMatch(stapled, /entire previous reply/, 'a different mistake gets different copy')
  console.log('ok: the notice echoes, splits the two shapes, and defers')
}

function testSilencePlaceholderSharesTheNoticeSlot(): void {
  armSilencePlaceholderNotice('conv-e', { text: '(no content)', trailing: false })
  const drained = drainControlTokenNotice('conv-e')
  assert.ok(drained && drained.includes('SILENCE-PLACEHOLDER'), 'drains through the shared slot')
  assert.equal(drainControlTokenNotice('conv-e'), undefined, 'drain clears')
  armSilencePlaceholderNotice(null, { text: '(no content)', trailing: false })
  assert.ok(drainControlTokenNotice(null), 'an id-less leak still travels')
  console.log('ok: the silence-placeholder notice rides the same shared slot')
}

function main(): void {
  testCleanTextNeverTrips()
  testObservedLeakShapesTrip()
  testKnownTokenListTrips()
  testNoticeNamesTokenAndDefers()
  testArmAndDrainReachTheModelAnywhere()
  testContentFreeDetectsFakedSilence()
  testContentFreeNeverTripsOnContent()
  testContentFreeNoticeEchoesAndDefers()
  testSilencePlaceholderDetectsTheObservedLeaks()
  testSilencePlaceholderClosesTheClass()
  testSilencePlaceholderDetectsTheChineseLeak()
  testSilencePlaceholderNeverTripsOnChineseContent()
  testSilencePlaceholderNeverTripsOnContent()
  testSilencePlaceholderNoticeSeparatesTheTwoShapes()
  testSilencePlaceholderSharesTheNoticeSlot()
  testContentFreeSharesTheNoticeSlot()
  console.log('\nAll control-token-guard tests passed.')
}

main()
