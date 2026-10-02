/**
 * Per-turn file snapshots — the lightweight stand-in for OpenCode's shadow
 * git index. Before the first mutating file tool call touches a path in a
 * turn, the Agent stores the file's original bytes (or records that it did
 * not exist); the `changes` capability lists turns and restores them. No
 * git dependency, works on any folder, covers the case that matters: "that
 * fix made it worse — put it back".
 *
 * Layout under `<workspace>/snapshots/<conversation>/<turn>/`:
 *   manifest.json   { turnId, conversationId, startedAt, files: { [abs]: { blob|null, size } } }
 *   <n>.orig        original bytes, one per file (absent when the file was created)
 *
 * Retention: the last SNAPSHOT_TURNS_KEPT turns per conversation; older
 * turns are pruned on write. Everything is best-effort and never throws
 * into the tool loop.
 */
import fs from 'node:fs/promises'
import path from 'node:path'

export const SNAPSHOT_DIR = 'snapshots'
export const SNAPSHOT_TURNS_KEPT = 20
/** Files above this size are not snapshotted (a note is recorded instead). */
export const SNAPSHOT_MAX_BYTES = 8 * 1024 * 1024

export type SnapshotEntry = { blob: string | null; size: number; skipped?: string }
export type SnapshotManifest = {
  turnId: string
  conversationId: string
  startedAt: number
  files: Record<string, SnapshotEntry>
}

function safe(id: string): string {
  return id.replace(/[^a-z0-9_.-]/gi, '_')
}

export class SnapshotStore {
  constructor(private readonly workspaceRoot: string) {}

  private dir(conversationId: string, turnId?: string): string {
    const base = path.join(this.workspaceRoot, SNAPSHOT_DIR, safe(conversationId))
    return turnId ? path.join(base, safe(turnId)) : base
  }

  private async readManifest(
    conversationId: string,
    turnId: string
  ): Promise<SnapshotManifest | null> {
    try {
      const raw = await fs.readFile(
        path.join(this.dir(conversationId, turnId), 'manifest.json'),
        'utf8'
      )
      return JSON.parse(raw) as SnapshotManifest
    } catch {
      return null
    }
  }

  private async writeManifest(m: SnapshotManifest): Promise<void> {
    const dir = this.dir(m.conversationId, m.turnId)
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(path.join(dir, 'manifest.json'), JSON.stringify(m, null, 2), 'utf8')
  }

  /**
   * Record `file`'s current state for `turnId` unless already recorded this
   * turn. Call BEFORE the mutation. Never throws.
   */
  async capture(conversationId: string, turnId: string, file: string): Promise<void> {
    try {
      const abs = path.resolve(file)
      const manifest = (await this.readManifest(conversationId, turnId)) ?? {
        turnId,
        conversationId,
        startedAt: Date.now(),
        files: {}
      }
      if (manifest.files[abs]) return
      let entry: SnapshotEntry
      try {
        const stat = await fs.stat(abs)
        if (!stat.isFile()) return
        if (stat.size > SNAPSHOT_MAX_BYTES) {
          entry = {
            blob: null,
            size: stat.size,
            skipped: `larger than ${SNAPSHOT_MAX_BYTES} bytes`
          }
        } else {
          const dir = this.dir(conversationId, turnId)
          await fs.mkdir(dir, { recursive: true })
          const name = `${Object.keys(manifest.files).length + 1}.orig`
          await fs.copyFile(abs, path.join(dir, name))
          entry = { blob: name, size: stat.size }
        }
      } catch (err) {
        if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') return
        entry = { blob: null, size: 0 } // did not exist: revert = delete
      }
      manifest.files[abs] = entry
      await this.writeManifest(manifest)
      await this.prune(conversationId)
    } catch {
      // best-effort
    }
  }

  /** Turns with recorded changes, newest first. */
  async list(conversationId: string): Promise<SnapshotManifest[]> {
    try {
      const entries = await fs.readdir(this.dir(conversationId), { withFileTypes: true })
      const manifests: SnapshotManifest[] = []
      for (const e of entries) {
        if (!e.isDirectory()) continue
        const m = await this.readManifest(conversationId, e.name)
        if (m && Object.keys(m.files).length > 0) manifests.push(m)
      }
      return manifests.sort((a, b) => b.startedAt - a.startedAt)
    } catch {
      return []
    }
  }

  /**
   * Restore every file of `turnId` (or just `only`) to its pre-turn state:
   * recorded bytes written back, created files deleted. Returns what was
   * done. The snapshot is kept so a revert can itself be undone by the
   * next turn's snapshot of the restored state.
   */
  async revert(
    conversationId: string,
    turnId: string,
    only?: string
  ): Promise<{ restored: string[]; deleted: string[]; skipped: string[] }> {
    const out = { restored: [] as string[], deleted: [] as string[], skipped: [] as string[] }
    const manifest = await this.readManifest(conversationId, turnId)
    if (!manifest) return out
    const dir = this.dir(conversationId, turnId)
    for (const [abs, entry] of Object.entries(manifest.files)) {
      if (only && path.resolve(only) !== abs) continue
      try {
        if (entry.skipped) {
          out.skipped.push(`${abs} (${entry.skipped})`)
        } else if (entry.blob) {
          await fs.mkdir(path.dirname(abs), { recursive: true })
          await fs.copyFile(path.join(dir, entry.blob), abs)
          out.restored.push(abs)
        } else {
          await fs.rm(abs, { force: true })
          out.deleted.push(abs)
        }
      } catch (err) {
        out.skipped.push(`${abs} (${(err as Error)?.message ?? 'error'})`)
      }
    }
    return out
  }

  private async prune(conversationId: string): Promise<void> {
    try {
      const base = this.dir(conversationId)
      const entries = (await fs.readdir(base, { withFileTypes: true })).filter((e) =>
        e.isDirectory()
      )
      if (entries.length <= SNAPSHOT_TURNS_KEPT) return
      const dated = await Promise.all(
        entries.map(async (e) => {
          const st = await fs.stat(path.join(base, e.name)).catch(() => null)
          return { name: e.name, mtime: st?.mtimeMs ?? 0 }
        })
      )
      dated.sort((a, b) => a.mtime - b.mtime)
      for (const d of dated.slice(0, dated.length - SNAPSHOT_TURNS_KEPT)) {
        await fs.rm(path.join(base, d.name), { recursive: true, force: true })
      }
    } catch {
      // best-effort
    }
  }
}
