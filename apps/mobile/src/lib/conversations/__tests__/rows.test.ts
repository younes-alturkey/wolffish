import {
  buildConversationRows,
  TERMINAL_FRESH_WINDOW_MS,
  type ConversationRun,
  type LiveTurnView
} from '@/lib/conversations/rows'
import type { ConversationMeta } from '@/lib/conversations/types'

/**
 * What a conversation LOOKS like in a list — the merge of the SQLite index, the
 * turns running right now, and how the last one ended.
 *
 * The three sources disagree constantly and by design (a running turn has no
 * saved row yet; a finished one has a row but no live entry; an old one has
 * neither), so every case below is a disagreement and what it must resolve to.
 */

const NOW = new Date(2026, 7, 6, 14, 0).getTime()

function meta(
  id: string,
  updatedAt: number,
  extra: Partial<ConversationMeta> = {}
): ConversationMeta {
  return { id, title: id, updatedAt, createdAt: updatedAt, messageCount: 2, ...extra }
}

function turn(status: string, at: number, prompt?: string): LiveTurnView {
  return {
    status,
    message: { timestamp: at },
    ...(prompt ? { user: { content: prompt, timestamp: at } } : {})
  }
}

function run(phase: ConversationRun['phase'], at: number): ConversationRun {
  return { phase, at }
}

const UNTITLED = 'Untitled'

describe('buildConversationRows', () => {
  it('reads processing off the live turn, not off a remembered flag', () => {
    const rows = buildConversationRows({
      metas: [meta('a', NOW - 1000), meta('b', NOW - 2000)],
      live: { a: turn('streaming', NOW) },
      untitled: UNTITLED,
      now: NOW
    })
    expect(rows.map((row) => [row.id, row.phase])).toEqual([
      ['a', 'processing'],
      ['b', null]
    ])
  })

  it('a turn that has ended but not been released is no longer processing', () => {
    // The live entry survives the end of a turn — it holds the reply until the
    // stored copy arrives. Reading `streaming` rather than "has an entry" is
    // what stops the chip pulsing through that window.
    const rows = buildConversationRows({
      metas: [meta('a', NOW)],
      live: { a: turn('complete', NOW) },
      runs: { a: run('completed', NOW) },
      untitled: UNTITLED,
      now: NOW
    })
    expect(rows[0].phase).toBe('completed')
  })

  it('keeps a terminal tint while it is fresh and drops it after', () => {
    const build = (age: number): ReturnType<typeof buildConversationRows> =>
      buildConversationRows({
        metas: [meta('a', NOW - age)],
        runs: { a: run('failed', NOW - age) },
        untitled: UNTITLED,
        now: NOW
      })
    expect(build(TERMINAL_FRESH_WINDOW_MS - 1)[0].phase).toBe('failed')
    expect(build(TERMINAL_FRESH_WINDOW_MS + 1)[0].phase).toBe(null)
  })

  it('a running turn beats a stale terminal tint for the same conversation', () => {
    // Resuming an expired conversation: the old record is still in the map and
    // the new turn is what the row is about.
    const rows = buildConversationRows({
      metas: [meta('a', NOW - 60_000)],
      live: { a: turn('streaming', NOW) },
      runs: { a: run('stopped', NOW - 120_000) },
      untitled: UNTITLED,
      now: NOW
    })
    expect(rows[0].phase).toBe('processing')
  })

  it('lifts a running conversation to the top even before anything is saved', () => {
    const rows = buildConversationRows({
      metas: [meta('old', NOW - 1000), meta('older', NOW - 500_000)],
      live: { older: turn('streaming', NOW) },
      untitled: UNTITLED,
      now: NOW
    })
    expect(rows.map((row) => row.id)).toEqual(['older', 'old'])
    expect(rows[0].at).toBe(NOW)
  })

  it('synthesizes a row for a turn whose conversation is not indexed yet', () => {
    // A conversation started ON THE DESKTOP: the phone gets turn.status before
    // it gets any metadata, and the row has to appear now rather than a whole
    // run later.
    const rows = buildConversationRows({
      metas: [meta('known', NOW - 1000)],
      live: { fresh: turn('streaming', NOW, 'summarize the release notes\nand the diff') },
      untitled: UNTITLED,
      now: NOW
    })
    expect(rows[0]).toMatchObject({
      id: 'fresh',
      title: 'summarize the release notes',
      phase: 'processing',
      indexed: false
    })
  })

  it('does not synthesize a row for a live entry that is no longer streaming', () => {
    // Nothing to show and nothing to open: the entry is the tail of a turn in a
    // conversation this phone has never indexed.
    const rows = buildConversationRows({
      metas: [],
      live: { gone: turn('complete', NOW) },
      untitled: UNTITLED,
      now: NOW
    })
    expect(rows).toEqual([])
  })

  it('the indexed row wins the moment it arrives', () => {
    const rows = buildConversationRows({
      metas: [meta('fresh', NOW - 10, { title: 'Release notes' })],
      live: { fresh: turn('streaming', NOW, 'summarize the release notes') },
      untitled: UNTITLED,
      now: NOW
    })
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ title: 'Release notes', indexed: true, phase: 'processing' })
  })

  it('resolves the badge emoji live from the project, then the stamp', () => {
    const rows = buildConversationRows({
      metas: [
        meta('bound', NOW - 1, { projectId: 'p1', icon: '🤖' }),
        meta('stamped', NOW - 2, { icon: '🫀' }),
        meta('plain', NOW - 3, { channel: 'telegram' })
      ],
      projects: [{ id: 'p1', icon: '📕' }],
      untitled: UNTITLED,
      now: NOW
    })
    // The project's own icon beats the conversation's stamp — an icon renamed
    // on the desktop has to propagate rather than sit frozen on the row.
    expect(rows.map((row) => row.icon)).toEqual(['📕', '🫀', null])
    expect(rows[2].channel).toBe('telegram')
  })

  it('falls back to the untitled label rather than showing the sentinel', () => {
    const rows = buildConversationRows({
      metas: [meta('a', NOW, { title: 'Untitled' })],
      untitled: 'No title yet',
      now: NOW
    })
    expect(rows[0].title).toBe('No title yet')
  })
})
