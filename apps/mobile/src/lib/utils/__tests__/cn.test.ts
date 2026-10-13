import { cn } from '@/lib/utils/cn'

describe('cn', () => {
  it('joins class strings with spaces', () => {
    expect(cn('a', 'b', 'c')).toBe('a b c')
  })

  it('drops falsy values', () => {
    expect(cn('a', false, null, undefined, '', 'b')).toBe('a b')
  })

  it('supports conditional classes', () => {
    const active = false
    expect(cn('base', active && 'active')).toBe('base')
    expect(cn('base', !active && 'inactive')).toBe('base inactive')
  })

  it('flattens nested arrays', () => {
    expect(cn('a', ['b', ['c', false, 'd']], 'e')).toBe('a b c d e')
  })

  it('stringifies numbers', () => {
    expect(cn('z', 0, 1)).toBe('z 1')
  })

  it('returns an empty string with no usable input', () => {
    expect(cn()).toBe('')
    expect(cn(false, null, undefined)).toBe('')
  })
})
