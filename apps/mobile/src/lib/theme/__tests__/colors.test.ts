import { DARK_TOKENS, LIGHT_TOKENS, tokensFor } from '@/lib/theme/colors'

describe('tokensFor', () => {
  it('returns light tokens for light scheme', () => {
    expect(tokensFor(false)).toBe(LIGHT_TOKENS)
  })

  it('returns dark tokens for dark scheme', () => {
    expect(tokensFor(true)).toBe(DARK_TOKENS)
  })

  it('keeps both palettes structurally identical', () => {
    expect(Object.keys(LIGHT_TOKENS).sort()).toEqual(Object.keys(DARK_TOKENS).sort())
  })

  it('mirrors the wolffish semantic tokens from global.css', () => {
    expect(LIGHT_TOKENS.bg).toBe('#f0f4f8')
    expect(LIGHT_TOKENS.primary).toBe('#1b365d')
    expect(DARK_TOKENS.bg).toBe('#0d1117')
    expect(DARK_TOKENS.primary).toBe('#a5d8ff')
    expect(LIGHT_TOKENS.accent).toBe(DARK_TOKENS.accent)
  })
})
