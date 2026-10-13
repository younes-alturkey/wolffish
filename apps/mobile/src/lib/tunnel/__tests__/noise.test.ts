import {
  generateKeypair,
  InitiatorIK,
  InitiatorXX,
  ResponderIK,
  ResponderXX
} from '@/lib/tunnel/noise'
import {
  decodePairingPayload,
  encodePairingPayload,
  fingerprint,
  fromBase64Url,
  normalizeCode,
  rendezvousId,
  secretFromCode,
  toBase64Url,
  toHex
} from '@/lib/tunnel/pairing'

/**
 * The tunnel's crypto is vendored — this exact directory is copied into
 * wolffish-app as `src/main/tunnel/`. These tests pin the behaviour both
 * copies must share, so a change made on one side and not the other shows up
 * here rather than as a phone that silently cannot pair.
 *
 * What they deliberately assert is the *interop contract*: which key each side
 * ends up pinning, that both derive the same transcript, that transport works
 * in both directions, and that a wrong pairing secret fails. Noise's internals
 * are not re-tested — the patterns come from the spec.
 */

const enc = new TextEncoder()
const dec = new TextDecoder()
const psk = (): Uint8Array => new Uint8Array(32).map((_, i) => (i * 7 + 3) % 256)

describe('Noise IKpsk2 — QR pairing and every reconnect', () => {
  it('pins both keys, agrees on a transcript, and carries traffic both ways', () => {
    const secret = psk()
    const desktop = generateKeypair()
    const phone = generateKeypair()

    const responder = new ResponderIK({ staticKeypair: desktop, psk: secret })
    const initiator = new InitiatorIK({
      staticKeypair: phone,
      remoteStaticPublicKey: desktop.publicKey,
      psk: secret
    })

    const incoming = responder.readMessage1(
      initiator.writeMessage1(enc.encode(JSON.stringify({ device: 'mobile' })))
    )
    const out = responder.writeMessage2(enc.encode(JSON.stringify({ device: 'desktop' })))
    const result = initiator.readMessage2(out.message)

    expect(toHex(incoming.remoteStaticPublicKey)).toBe(toHex(phone.publicKey))
    expect(toHex(result.remoteStaticPublicKey)).toBe(toHex(desktop.publicKey))
    expect(toHex(out.handshakeHash)).toBe(toHex(result.handshakeHash))

    const down = out.send.encrypt(enc.encode('desktop→mobile'))
    expect(dec.decode(result.receive.decrypt(down))).toBe('desktop→mobile')
    const up = result.send.encrypt(enc.encode('mobile→desktop'))
    expect(dec.decode(out.receive.decrypt(up))).toBe('mobile→desktop')
  })

  it('rejects a peer that does not hold the pairing secret', () => {
    const desktop = generateKeypair()
    const phone = generateKeypair()
    const responder = new ResponderIK({ staticKeypair: desktop, psk: psk() })
    const impostor = new InitiatorIK({
      staticKeypair: phone,
      remoteStaticPublicKey: desktop.publicKey,
      psk: new Uint8Array(32).fill(9) // never saw the QR
    })
    responder.readMessage1(impostor.writeMessage1())
    // The responder derives keys either way; the impostor cannot open message 2.
    expect(() => impostor.readMessage2(responder.writeMessage2().message)).toThrow()
  })
})

describe('Noise XXpsk3 — typed-code pairing', () => {
  it('exchanges both static keys inside the handshake', () => {
    const secret = psk()
    const desktop = generateKeypair()
    const phone = generateKeypair()

    const responder = new ResponderXX({ staticKeypair: desktop, psk: secret })
    const initiator = new InitiatorXX({ staticKeypair: phone, psk: secret })

    responder.readMessage1(initiator.writeMessage1())
    const learned = initiator.readMessage2(responder.writeMessage2())
    const third = initiator.writeMessage3()
    const finished = responder.readMessage3(third.message)

    // Neither side knew the other's key beforehand; both know it now.
    expect(toHex(learned.remoteStaticPublicKey)).toBe(toHex(desktop.publicKey))
    expect(toHex(finished.remoteStaticPublicKey)).toBe(toHex(phone.publicKey))
    expect(toHex(third.handshakeHash)).toBe(toHex(finished.handshakeHash))

    const payload = third.send.encrypt(enc.encode('paired by code'))
    expect(dec.decode(finished.receive.decrypt(payload))).toBe('paired by code')
  })

  it('fails when the typed code was wrong', () => {
    const desktop = generateKeypair()
    const phone = generateKeypair()
    const responder = new ResponderXX({ staticKeypair: desktop, psk: secretFromCode('K7M9-2QXR') })
    const initiator = new InitiatorXX({ staticKeypair: phone, psk: secretFromCode('AAAA-BBBB') })
    responder.readMessage1(initiator.writeMessage1())
    initiator.readMessage2(responder.writeMessage2())
    expect(() => responder.readMessage3(initiator.writeMessage3().message)).toThrow()
  })
})

describe('pairing helpers', () => {
  it('folds what a human actually types', () => {
    const canonical = secretFromCode('K7M9-2QXR')
    for (const sloppy of ['k7m9-2qxr', 'K7M92QXR', 'k7m9 2qxr', 'K7M9-2QXR ']) {
      expect(toHex(secretFromCode(sloppy))).toBe(toHex(canonical))
    }
    // O/0 and I/L/1 are folded, so a code read aloud still lands.
    expect(normalizeCode('k7m9-2qxr')).toBe('K7M92QXR')
    expect(() => normalizeCode('ABC')).toThrow()
    expect(() => normalizeCode('ABCD-EF!$')).toThrow()
  })

  it('derives a 256-bit rendezvous ID', () => {
    const rid = rendezvousId(secretFromCode('K7M9-2QXR'))
    expect(rid).toMatch(/^[0-9a-f]{64}$/)
    // Different codes must never meet at the same rendezvous.
    expect(rid).not.toBe(rendezvousId(secretFromCode('AAAA-BBBB')))
  })

  it('round-trips base64url without btoa/atob', () => {
    for (let length = 0; length < 40; length += 1) {
      const bytes = new Uint8Array(length).map((_, i) => (i * 37 + length * 11) % 256)
      expect(Array.from(fromBase64Url(toBase64Url(bytes)))).toEqual(Array.from(bytes))
    }
  })

  it('round-trips a QR payload', () => {
    const payload = {
      v: 1,
      relay: 'wss://relay.wolffi.sh',
      pk: toHex(generateKeypair().publicKey),
      ps: toBase64Url(secretFromCode('K7M9-2QXR'))
    }
    const decoded = decodePairingPayload(encodePairingPayload(payload))
    expect(decoded).toEqual(payload)
    expect(() => decodePairingPayload('https://example.com')).toThrow()
  })

  it('shortens keys to a comparable fingerprint', () => {
    expect(fingerprint('2d5b37a08c1bc1aa129950cd9261203a')).toBe('2d5b…203a')
    expect(fingerprint('abcd')).toBe('abcd')
  })
})
