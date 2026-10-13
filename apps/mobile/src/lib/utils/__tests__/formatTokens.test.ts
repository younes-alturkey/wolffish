import { formatTokens } from '@/lib/utils/formatTokens'

describe('formatTokens', () => {
  it('leaves counts under a thousand alone', () => {
    expect(formatTokens(0, 'en')).toBe('0')
    expect(formatTokens(637, 'en')).toBe('637')
    expect(formatTokens(999, 'en')).toBe('999')
  })

  it('switches unit at each thousand-fold', () => {
    expect(formatTokens(1_000, 'en')).toBe('1k')
    expect(formatTokens(10_000, 'en')).toBe('10k')
    expect(formatTokens(967_232, 'en')).toBe('967.2k')
    expect(formatTokens(1_500_000, 'en')).toBe('1.5m')
    expect(formatTokens(2_000_000_000, 'en')).toBe('2b')
  })

  it('treats a missing count as zero', () => {
    expect(formatTokens(undefined, 'en')).toBe('0')
  })
})
