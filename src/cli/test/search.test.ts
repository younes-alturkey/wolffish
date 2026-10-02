/**
 * The terminal's conversation title search (src/cli/lib/search.mjs).
 *
 * The cases below are deliberately the SAME table the app's side is pinned
 * against (src/renderer/src/lib/__tests__/conversation-search.test.ts). The
 * two matchers are separate code in separate languages; the only thing that
 * keeps `/conversations release notes` and the app's search box agreeing is
 * that both are held to this list.
 *
 * Run: bun --cwd src/cli test search
 */
import { describe, expect, test } from 'bun:test'
import { filterConversationsByTitle, matchesKeywords } from '../lib/search.mjs'

const TITLES = [
  'Notes for the 1.0.311 release',
  'Invoice follow-up with the bank',
  'Café menu translation',
  'Untitled'
]

const found = (query: string): string[] =>
  (
    filterConversationsByTitle(
      TITLES.map((title, i) => ({ id: String(i), title })),
      query
    ) as { title: string }[]
  ).map((c) => c.title)

describe('conversation title search', () => {
  test('an empty query is not a filter', () => {
    expect(found('')).toEqual(TITLES)
    expect(found('   ')).toEqual(TITLES)
  })

  test('every keyword must appear, in any order', () => {
    expect(found('release notes')).toEqual(['Notes for the 1.0.311 release'])
    expect(found('notes release')).toEqual(['Notes for the 1.0.311 release'])
    // Both words, but not in one title.
    expect(found('release invoice')).toEqual([])
  })

  test('case and combining marks do not decide a match', () => {
    expect(found('CAFE')).toEqual(['Café menu translation'])
    expect(found('café')).toEqual(['Café menu translation'])
  })

  test('a substring of a word still matches it', () => {
    expect(found('invo')).toEqual(['Invoice follow-up with the bank'])
  })

  test('a title-less conversation is searchable by its placeholder', () => {
    expect(found('untitled')).toEqual(['Untitled'])
  })

  test('the haystack is the caller’s, so the menu keeps reaching channel and id', () => {
    expect(
      matchesKeywords('Invoice follow-up with the bank telegram 2026-09-22_x', 'telegram')
    ).toBe(true)
    expect(
      matchesKeywords('Invoice follow-up with the bank telegram 2026-09-22_x', 'whatsapp')
    ).toBe(false)
    // Both halves of the haystack at once — the reason it is one string.
    expect(
      matchesKeywords('Invoice follow-up with the bank telegram 2026-09-22_x', 'telegram invoice')
    ).toBe(true)
  })
})
