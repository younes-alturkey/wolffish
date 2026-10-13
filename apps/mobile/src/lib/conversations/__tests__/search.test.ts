import {
  conversationSearchKeywords,
  filterConversationRows,
  type ConversationRow
} from '@/lib/conversations/rows'

/**
 * The conversation title search the History screen and the conversations
 * sheet both narrow their lists with.
 *
 * These cases are deliberately the SAME table the desktop pins its two copies
 * against (wolffish-app: src/renderer/src/lib/__tests__/conversation-search.test.ts
 * and src/cli/test/search.test.ts). The three matchers are separate code; the
 * only thing keeping a query answering identically on the phone, in the app
 * and in a terminal is that all three are held to this list.
 */

const TITLES = [
  'Notes for the 1.0.311 release',
  'Invoice follow-up with the bank',
  'Café menu translation',
  'Untitled'
]

const ROWS: ConversationRow[] = TITLES.map((title, i) => ({
  id: String(i),
  title,
  phase: null,
  channel: null,
  icon: null,
  projectId: null,
  at: 1000 - i,
  indexed: true
}))

const found = (query: string): string[] =>
  filterConversationRows(ROWS, query).map((row) => row.title)

describe('filterConversationRows', () => {
  it('an empty query is not a filter — and hands back the same array', () => {
    expect(found('')).toEqual(TITLES)
    expect(found('   ')).toEqual(TITLES)
    expect(filterConversationRows(ROWS, '')).toBe(ROWS)
  })

  it('every keyword must appear, in any order, all in one title', () => {
    expect(found('release notes')).toEqual(['Notes for the 1.0.311 release'])
    expect(found('notes release')).toEqual(['Notes for the 1.0.311 release'])
    expect(found('release invoice')).toEqual([])
  })

  it('a substring of a word still matches it', () => {
    expect(found('invo')).toEqual(['Invoice follow-up with the bank'])
  })

  it('case and combining marks do not decide a match', () => {
    expect(found('CAFE')).toEqual(['Café menu translation'])
    expect(found('café')).toEqual(['Café menu translation'])
  })

  it('a conversation whose title has not resolved is findable by its placeholder', () => {
    expect(found('untitled')).toEqual(['Untitled'])
  })

  it('an Arabic query finds its vowelled spelling, and the vowelled one the bare', () => {
    // A model writes "مُحادثة" as readily as "محادثة"; the person searching
    // types whichever their keyboard gives them.
    const arabic: ConversationRow[] = [{ ...ROWS[0], id: 'ar', title: 'مُحَادَثَة العمل' }]
    expect(filterConversationRows(arabic, 'محادثة').map((row) => row.id)).toEqual(['ar'])
    const bare: ConversationRow[] = [{ ...ROWS[0], id: 'ar', title: 'محادثة العمل' }]
    expect(filterConversationRows(bare, 'مُحَادَثَة').map((row) => row.id)).toEqual(['ar'])
  })

  it('keywords are the words typed, folded, with the empties dropped', () => {
    expect(conversationSearchKeywords('  Café   RELEASE ')).toEqual(['cafe', 'release'])
  })
})
