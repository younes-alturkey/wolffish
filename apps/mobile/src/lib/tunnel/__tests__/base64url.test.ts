import { fromBase64Url, toBase64Url } from '@/lib/tunnel/pairing'

// Node's Buffer, present under jest. The app's tsconfig deliberately carries
// no node types (Hermes has no Buffer), so declare the sliver this test uses.
declare const Buffer: {
  from(input: Uint8Array): { toString(encoding: 'base64url'): string }
}

/**
 * File chunks cross the tunnel as base64url: this side encodes with the
 * hand-rolled helpers in pairing.ts (Hermes has no btoa/atob), the desktop
 * with Node's Buffer 'base64url' codec. These tests pin the two to the same
 * dialect — unpadded, URL-safe — across every length class, because a drift
 * here corrupts every transferred file at once and nothing else would say so.
 */
describe('base64url wire compatibility', () => {
  const lengths = [0, 1, 2, 3, 4, 255, 256, 1000, 65537]

  function sampleBytes(length: number): Uint8Array {
    const bytes = new Uint8Array(length)
    for (let i = 0; i < length; i++) bytes[i] = (i * 31 + 7) % 256
    return bytes
  }

  it('encodes exactly what Node Buffer base64url produces', () => {
    for (const length of lengths) {
      const bytes = sampleBytes(length)
      expect(toBase64Url(bytes)).toBe(Buffer.from(bytes).toString('base64url'))
    }
  })

  it('decodes what Node Buffer base64url produces, byte for byte', () => {
    for (const length of lengths) {
      const bytes = sampleBytes(length)
      const decoded = fromBase64Url(Buffer.from(bytes).toString('base64url'))
      expect(Array.from(decoded)).toEqual(Array.from(bytes))
    }
  })

  it('round-trips through its own pair', () => {
    for (const length of lengths) {
      const bytes = sampleBytes(length)
      expect(Array.from(fromBase64Url(toBase64Url(bytes)))).toEqual(Array.from(bytes))
    }
  })
})
