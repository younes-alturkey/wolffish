import type { ConversationStats } from '@/lib/conversations/types'
import { compactionAtFor, contextWindowFor, foldDemoTurn } from '@/lib/demo/turnStats'

const TURN = {
  promptText: 'a'.repeat(400), // 100 tokens at 4 chars each
  attachmentCount: 0,
  replyText: 'b'.repeat(800), // 200 tokens
  provider: 'deepseek',
  model: 'deepseek-v4-pro',
  elapsedMs: 3000,
  endedAt: 1_800_000_000_000
}

describe('foldDemoTurn', () => {
  it('opens a conversation by writing the window to cache, not reading it', () => {
    const stats = foldDemoTurn(null, TURN)
    expect(stats.lastTurn?.cacheReadTokens).toBe(0)
    expect(stats.lastTurn?.cacheCreationTokens).toBeGreaterThan(0)
    expect(stats.lastTurn?.inputTokens).toBe(100)
    expect(stats.lastTurn?.outputTokens).toBe(200)
    expect(stats.allTime?.turns).toBe(1)
  })

  it('reads the window back on every later turn and grows the context', () => {
    const first = foldDemoTurn(null, TURN)
    const second = foldDemoTurn(first, TURN)
    // The second turn ingests exactly what the first left in the window.
    expect(second.lastTurn?.cacheReadTokens).toBe(first.meter?.contextTokens)
    expect(second.lastTurn?.cacheCreationTokens).toBe(0)
    expect(second.meter?.contextTokens).toBeGreaterThan(first.meter?.contextTokens ?? 0)
    expect(second.allTime?.turns).toBe(2)
    expect(second.allTime?.inputTokens).toBe(200)
    expect(second.allTime?.cost).toBeGreaterThan(first.allTime?.cost ?? 0)
  })

  it('counts attachments toward the prompt', () => {
    const withFile = foldDemoTurn(null, { ...TURN, attachmentCount: 2 })
    expect(withFile.lastTurn?.inputTokens).toBeGreaterThan(100)
  })

  it('measures the window under the answering model', () => {
    const local = foldDemoTurn(null, { ...TURN, provider: 'local', model: 'gemma4:e2b' })
    expect(local.meter?.contextBudget).toBe(131_072)
    expect(local.meter?.model).toBe('gemma4:e2b')
  })

  it('never reports more context than the window holds', () => {
    // A conversation already parked at the ceiling stays there.
    const full: ConversationStats = {
      allTime: { turns: 9 },
      meter: { contextTokens: 999_900, contextBudget: 1_000_000, model: 'deepseek-v4-pro' }
    }
    const next = foldDemoTurn(full, TURN)
    expect(next.meter?.contextTokens).toBeLessThanOrEqual(1_000_000)
  })
})

describe('compactionAtFor', () => {
  it('reproduces the pair the desktop wrote into the imported dataset', () => {
    // deepseek-v4-pro: 1,000,000 window, 32,768 reserved for output, 0.75 of
    // the remainder — the 725,424 seen throughout the real conversations.
    expect(contextWindowFor('deepseek-v4-pro').window).toBe(1_000_000)
    expect(compactionAtFor('deepseek-v4-pro')).toBe(725_424)
  })

  it('falls back to the common shape for a model it has never seen', () => {
    expect(contextWindowFor('some-new-model')).toEqual({ window: 131_072, reserve: 32_768 })
  })
})
