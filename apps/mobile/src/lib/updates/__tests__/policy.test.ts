import { CHECK_INTERVAL_MS, isCheckDue } from '@/lib/updates/policy'

describe('isCheckDue', () => {
  it('is not due right after a check', () => {
    expect(isCheckDue(1_000, 1_000)).toBe(false)
    expect(isCheckDue(1_000, 1_000 + CHECK_INTERVAL_MS - 1)).toBe(false)
  })

  it('is due once the interval has fully passed', () => {
    expect(isCheckDue(1_000, 1_000 + CHECK_INTERVAL_MS)).toBe(true)
    expect(isCheckDue(1_000, 1_000 + CHECK_INTERVAL_MS * 10)).toBe(true)
  })
})
