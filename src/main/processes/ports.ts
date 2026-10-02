import { createHash } from 'node:crypto'
import { isPortFree, listeningPorts } from './platform'
import type { ListeningPort } from './types'

/**
 * Port arbitration.
 *
 * Wolffish never takes a framework's default port (3000, 5173, 8000…): those
 * belong to whatever the user runs by hand. The default allocation comes
 * from the Wolffish band — 20000-20999, above every framework default and
 * below every OS ephemeral range (macOS/Windows 49152+, Linux 32768+) —
 * deterministically per definition, so the same project lands on the same
 * port across restarts and a bookmarked URL keeps working, then probed
 * forward until a port is free by BOTH tests: no listener in the OS table
 * and a successful bind.
 */
export const BAND_START = 20000
export const BAND_SIZE = 1000

export function bandCandidate(name: string, cwd: string): number {
  const digest = createHash('sha1').update(`${name}\0${cwd}`).digest()
  return BAND_START + (digest.readUInt32BE(0) % BAND_SIZE)
}

export async function allocateBandPort(
  name: string,
  cwd: string,
  listeners?: ListeningPort[]
): Promise<number | null> {
  const busy = new Set((listeners ?? (await listeningPorts())).map((l) => l.port))
  const start = bandCandidate(name, cwd)
  for (let i = 0; i < BAND_SIZE; i++) {
    const port = BAND_START + ((start - BAND_START + i) % BAND_SIZE)
    if (busy.has(port)) continue
    if (await isPortFree(port)) return port
  }
  return null
}

/** Who holds a port right now, from the OS table (null when nobody listens). */
export async function portOwner(
  port: number,
  listeners?: ListeningPort[]
): Promise<ListeningPort | null> {
  const list = listeners ?? (await listeningPorts())
  return list.find((l) => l.port === port) ?? null
}

/** Substitute `{port}` everywhere in a command. */
export function fillPort(command: string, port: number): string {
  return command.replace(/\{port\}/gi, String(port))
}

export function commandWantsPort(command: string): boolean {
  return /\{port\}/i.test(command)
}
