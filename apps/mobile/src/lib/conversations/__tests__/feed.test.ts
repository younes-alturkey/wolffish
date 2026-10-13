import { buildFeed, LIVE_KEY } from '@/lib/conversations/feed'
import type { ConversationMessage } from '@/lib/conversations/types'
import type { LiveStream } from '@/state/chatRuntime'

/**
 * Where a mid-turn message sits in the feed, and when it stops sitting there.
 *
 * The merge has no notion of time (see feed.ts), so both facts are about ids:
 * a pending row is emitted AFTER the live assistant row — it is waiting on
 * that row's turn — and it is dropped the moment its id is anywhere in the
 * transcript, as a stored message or as a `user_message` segment inside an
 * assistant message. That second match is what makes a missed `delivered`
 * push harmless: the mirror carrying the segment retires the row by itself.
 */

const user = (id: string, content: string): ConversationMessage => ({
  id,
  role: 'user',
  content,
  timestamp: 1
})

const live = (message: Partial<ConversationMessage> = {}): LiveStream => ({
  message: { role: 'assistant', content: '', timestamp: 2, ...message },
  status: 'streaming'
})

const keys = (items: ReturnType<typeof buildFeed>): string[] => items.map((item) => item.key)

describe('pending mid-turn messages in the feed', () => {
  it('draws them after the live assistant row, in order, marked pending', () => {
    const items = buildFeed({
      messages: [user('m_1', 'do the thing')],
      live: live({ id: 'a_1' }),
      pending: [user('m_2', 'skip the tests'), user('m_3', 'and use the other file')]
    })
    expect(keys(items)).toEqual(['m_1', LIVE_KEY, 'm_2', 'm_3'])
    expect(items[2].pending).toBe(true)
    expect(items[3].pending).toBe(true)
    expect(items[1].pending).toBeUndefined()
  })

  it('draws them after the thinking row of a send that has no turn yet', () => {
    const items = buildFeed({ sending: true, pending: [user('m_2', 'skip the tests')] })
    expect(keys(items)).toEqual([LIVE_KEY, 'm_2'])
  })

  it('drops a row once the live message carries it as a user_message segment', () => {
    const items = buildFeed({
      live: live({
        id: 'a_1',
        segments: [
          { kind: 'text', turnId: 't', segmentId: 's1', delta: 'working…' },
          {
            kind: 'user_message',
            turnId: 't',
            segmentId: 's2',
            messageId: 'm_2',
            text: 'skip the tests',
            timestamp: 3
          }
        ]
      }),
      pending: [user('m_2', 'skip the tests'), user('m_3', 'still waiting')]
    })
    expect(keys(items)).toEqual([LIVE_KEY, 'm_3'])
  })

  it('drops a row the stored transcript already holds, by id', () => {
    const stored: ConversationMessage = {
      id: 'a_0',
      role: 'assistant',
      content: '',
      timestamp: 1,
      segments: [
        {
          kind: 'user_message',
          turnId: 't',
          segmentId: 's',
          messageId: 'm_2',
          text: 'skip the tests',
          timestamp: 1
        }
      ]
    }
    const items = buildFeed({
      messages: [stored, user('m_9', 'sent as a turn after all')],
      live: live(),
      pending: [user('m_2', 'skip the tests'), user('m_9', 'sent as a turn after all')]
    })
    expect(keys(items)).toEqual(['a_0', 'm_9', LIVE_KEY])
  })

  it('never draws a row that has no id — nothing could ever retire it', () => {
    const items = buildFeed({
      live: live(),
      pending: [{ role: 'user', content: 'no id', timestamp: 1 }]
    })
    expect(keys(items)).toEqual([LIVE_KEY])
  })
})
