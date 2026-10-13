/**
 * A random id that works on every origin. `crypto.randomUUID` exists only in
 * secure contexts — HTTPS and localhost — and the Web UI is reached over plain
 * HTTP at a LAN or VPS address until Let's Encrypt is on; there the function
 * is undefined and anything calling it throws. `getRandomValues` carries no
 * such restriction, so it is the fallback.
 */
export function randomId(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}
