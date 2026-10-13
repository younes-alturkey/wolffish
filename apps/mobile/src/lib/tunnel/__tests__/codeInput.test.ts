// client.ts pulls in the notifications module (push registration rides the
// tunnel), whose AsyncStorage native module does not exist under jest.
jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock')
)

import { autoDashPairingCode, formatPairingCode, pairingCodeIssue } from '@/lib/tunnel/client'
import { generateCode, normalizeCode } from '@/lib/tunnel/pairing'

describe('formatPairingCode', () => {
  it('adds the dash and upper-cases a finished code', () => {
    expect(formatPairingCode('k7m92qxr')).toBe('K7M9-2QXR')
    expect(formatPairingCode('K7M92QXR')).toBe('K7M9-2QXR')
    expect(formatPairingCode('k7m9-2qxr')).toBe('K7M9-2QXR')
    expect(formatPairingCode('k7m9 2qxr')).toBe('K7M9-2QXR')
    expect(formatPairingCode('  K7M9-2QXR  ')).toBe('K7M9-2QXR')
  })

  it('folds the look-alike characters the way normalizeCode does', () => {
    // O→0, I→1, L→1, U→V.
    expect(formatPairingCode('oilu0000')).toBe('011V-0000')
    expect(normalizeCode(formatPairingCode('oilu0000'))).toBe('011V0000')
  })

  // The whole point of post-processing rather than live formatting: whatever
  // is half-typed must survive untouched, or the caret fights the typist.
  it('leaves an unfinished code alone', () => {
    for (const partial of ['', 'K', 'K7M9', 'K7M9-', 'K7M9-2', 'k7m9-2qx']) {
      expect(formatPairingCode(partial)).toBe(partial.trim())
    }
  })

  it('does not truncate an over-long value into a different code', () => {
    // Silently keeping the first eight characters would pair with a code the
    // user never saw. Leave it; pairingCodeIssue explains the problem.
    expect(formatPairingCode('K7M9-2QXR-EXTRA')).toBe('K7M9-2QXR-EXTRA')
    expect(formatPairingCode('K7M92QXRZZZZ')).toBe('K7M92QXRZZZZ')
  })

  it('leaves a value holding characters a code cannot contain', () => {
    expect(formatPairingCode('K7M9-2QX@')).toBe('K7M9-2QX@')
    expect(formatPairingCode('😀K7M92QX')).toBe('😀K7M92QX')
  })

  it('is idempotent — tidying its own output changes nothing', () => {
    for (const input of ['', 'K7M9', 'k7m92qxr', 'K7M9-2QXR', 'K7M9-2QX@']) {
      const once = formatPairingCode(input)
      expect(formatPairingCode(once)).toBe(once)
    }
  })

  // Guards the constants duplicated out of the vendored pairing.ts: if its
  // code length or alphabet ever changes, this fails instead of drifting.
  it('round-trips a freshly generated code', () => {
    let seed = 7
    const bytes = (length: number): Uint8Array =>
      Uint8Array.from({ length }, () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) % 256)
    for (let i = 0; i < 50; i += 1) {
      const generated = generateCode(bytes)
      expect(formatPairingCode(generated)).toBe(generated)
      expect(pairingCodeIssue(generated)).toBeNull()
      expect(() => normalizeCode(formatPairingCode(generated))).not.toThrow()
    }
  })
})

describe('pairingCodeIssue', () => {
  it('accepts a correct code however it is spelled', () => {
    for (const spelling of ['K7M9-2QXR', 'k7m92qxr', 'K7M9 2QXR', ' k7m9-2qxr ', 'K7M-92Q-XR']) {
      expect(pairingCodeIssue(spelling)).toBeNull()
    }
  })

  it('reports an empty field separately, so nothing is shouted at a blank input', () => {
    expect(pairingCodeIssue('')).toBe('empty')
    expect(pairingCodeIssue('   ')).toBe('empty')
    expect(pairingCodeIssue('--')).toBe('empty')
  })

  it('reports the wrong length', () => {
    expect(pairingCodeIssue('K7M9')).toBe('length')
    expect(pairingCodeIssue('K7M9-2QX')).toBe('length')
    expect(pairingCodeIssue('K7M9-2QXRR')).toBe('length')
  })

  it('reports a character a code cannot contain, ahead of length', () => {
    expect(pairingCodeIssue('K7M9-2QX@')).toBe('character')
    expect(pairingCodeIssue('@')).toBe('character')
    expect(pairingCodeIssue('😀')).toBe('character')
  })

  it('treats the look-alikes as valid, not as bad characters', () => {
    // These are substituted, never rejected — O/0 and I/L/1 and U/V.
    expect(pairingCodeIssue('OILU0000')).toBeNull()
    expect(pairingCodeIssue('oilu0000')).toBeNull()
  })

  // What the Connect button promises: anything it enables, pairing accepts,
  // and anything it blocks, pairing would have rejected.
  it('agrees with normalizeCode on exactly what is submittable', () => {
    const inputs = [
      'K7M9-2QXR',
      'k7m92qxr',
      'K7M9 2QXR',
      'oilu0000',
      'K7M9',
      'K7M9-2QX',
      'K7M9-2QXRR',
      'K7M9-2QX@',
      ''
    ]
    for (const input of inputs) {
      if (pairingCodeIssue(input) === null) {
        expect(() => normalizeCode(input)).not.toThrow()
      } else {
        expect(() => normalizeCode(input)).toThrow()
      }
    }
  })
})

describe('autoDashPairingCode', () => {
  it('adds the dash as the fourth character lands', () => {
    expect(autoDashPairingCode('K7M9', 'K7M')).toBe('K7M9-')
  })

  it('does nothing on the way to four, or after', () => {
    expect(autoDashPairingCode('K7M', 'K7')).toBe('K7M')
    expect(autoDashPairingCode('K7M9-2', 'K7M9-')).toBe('K7M9-2')
    expect(autoDashPairingCode('K7M9-2QXR', 'K7M9-2QX')).toBe('K7M9-2QXR')
  })

  // The trap: reinstating the dash under the caret pins typing at four.
  it('never puts the dash back while deleting', () => {
    expect(autoDashPairingCode('K7M9', 'K7M9-')).toBe('K7M9')
    expect(autoDashPairingCode('K7M', 'K7M9')).toBe('K7M')
    expect(autoDashPairingCode('', 'K')).toBe('')
  })

  it('leaves a paste alone — it is already past the fourth character', () => {
    expect(autoDashPairingCode('K7M92QXR', '')).toBe('K7M92QXR')
    expect(autoDashPairingCode('K7M9-2QXR', '')).toBe('K7M9-2QXR')
  })

  it('is safe to re-apply to its own output', () => {
    const once = autoDashPairingCode('K7M9', 'K7M')
    expect(autoDashPairingCode(once, once)).toBe(once)
  })
})
