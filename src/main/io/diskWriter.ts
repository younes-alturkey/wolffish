import { randomBytes } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'

/**
 * The single disk-writing layer for every Wolffish-authored file.
 *
 * ALL json/log/md writes the app makes go through here — direct `fs` writes
 * from anywhere else are forbidden. It serializes per resolved absolute path:
 * writes to the SAME file run one-after-another (never torn or interleaved),
 * writes to DIFFERENT files stay parallel. Two shapes:
 *
 *  - `writeFileAtomic` — whole-file (state json, md). Streams to a sibling temp
 *    file, fsyncs, then `rename(2)`s over the target, so a concurrent reader or
 *    a crash always sees the complete old file or the complete new one — never
 *    the truncated window a bare `fs.writeFile` exposes mid-write.
 *  - `appendLine` — append (logs). One serialized sink per file so lines never
 *    interleave across concurrent writers.
 *
 * Out of scope BY DESIGN: files owned by third-party libraries or native
 * modules (e.g. Baileys' `whatsapp/auth/`) and large binary streams — we don't
 * control how those write, so we don't pretend to.
 */

// One promise tail per resolved absolute path. Each op chains onto the tail so
// same-path ops run FIFO; the entry is dropped once it's the live tail again so
// the map can't grow unbounded. (Generalizes workspace.ts `withConfigLock`.)
const queues = new Map<string, Promise<unknown>>()

function enqueue<T>(absPath: string, op: () => Promise<T>): Promise<T> {
  const key = path.resolve(absPath)
  const prev = queues.get(key) ?? Promise.resolve()
  const run = prev.then(op, op)
  // Track a never-rejecting tail so a failed op can't wedge the queue or
  // surface as an unhandled rejection.
  const tail = run.then(
    () => undefined,
    () => undefined
  )
  queues.set(key, tail)
  void tail.then(() => {
    if (queues.get(key) === tail) queues.delete(key)
  })
  return run
}

// Cache directories we've already created so high-frequency appends don't pay a
// mkdir syscall every line. The cache is an optimization, NOT a correctness
// invariant — `withDir` self-heals if a cached dir is removed out from under us
// (e.g. deleteConversation recursively rms an uploads subtree).
const ensuredDirs = new Set<string>()

async function ensureDir(dir: string): Promise<void> {
  if (ensuredDirs.has(dir)) return
  await fs.mkdir(dir, { recursive: true })
  ensuredDirs.add(dir)
}

/**
 * Run a write op with the dir ensured, self-healing on ENOENT: if the target
 * directory was deleted after we cached it, evict the stale entry, recreate the
 * dir, and retry the op once.
 */
async function withDir<T>(dir: string, op: () => Promise<T>): Promise<T> {
  await ensureDir(dir)
  try {
    return await op()
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') throw err
    ensuredDirs.delete(dir)
    await fs.mkdir(dir, { recursive: true })
    ensuredDirs.add(dir)
    return await op()
  }
}

// Fsync the parent directory so the rename's directory-entry change is durable
// across power loss (rename(2) alone isn't until the dir inode is synced).
// Best-effort: Windows can't fsync a directory handle (EISDIR/EPERM).
async function fsyncDir(dir: string): Promise<void> {
  let dh: import('node:fs/promises').FileHandle | undefined
  try {
    dh = await fs.open(dir, 'r')
    await dh.sync()
  } catch {
    // best-effort
  } finally {
    await dh?.close().catch(() => {})
  }
}

async function atomicWrite(absPath: string, data: string | Buffer): Promise<void> {
  const dir = path.dirname(absPath)
  await withDir(dir, async () => {
    const tmp = path.join(
      dir,
      `${path.basename(absPath)}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`
    )
    let handle: import('node:fs/promises').FileHandle | undefined
    try {
      handle = await fs.open(tmp, 'wx') // exclusive create — never clobber a stray temp
      await handle.writeFile(data)
      await handle.sync()
    } finally {
      await handle?.close()
    }
    try {
      await fs.rename(tmp, absPath)
    } catch (err) {
      // Rename failed — don't leave the scratch file behind.
      await fs.rm(tmp, { force: true }).catch(() => {})
      throw err
    }
    await fsyncDir(dir)
  })
}

export const diskWriter = {
  /** Whole-file atomic write (temp + fsync + rename), serialized per path. */
  writeFileAtomic(absPath: string, data: string | Buffer): Promise<void> {
    return enqueue(absPath, () => atomicWrite(absPath, data))
  },

  /**
   * Read-modify-write INSIDE the path's queue, so concurrent updates to one
   * file can never lose each other's changes (the classic two-writers-load-
   * the-same-copy clobber). `mutate` receives the current raw contents (null
   * when the file doesn't exist) and returns the new contents — or null to
   * skip writing. The write itself is atomic like writeFileAtomic.
   */
  update(
    absPath: string,
    mutate: (current: string | null) => string | Buffer | null | Promise<string | Buffer | null>
  ): Promise<void> {
    return enqueue(absPath, async () => {
      let current: string | null
      try {
        current = await fs.readFile(absPath, 'utf8')
      } catch {
        current = null
      }
      const next = await mutate(current)
      if (next === null) return
      await atomicWrite(absPath, next)
    })
  },

  /** Serialized append — lines never interleave across writers to one file. */
  appendLine(absPath: string, text: string): Promise<void> {
    return enqueue(absPath, () =>
      withDir(path.dirname(absPath), () => fs.appendFile(absPath, text, 'utf8'))
    )
  },

  /**
   * Serialized append where the text depends on whether the file already
   * exists (date headers, section preambles). The existence probe runs
   * INSIDE the queue — a probe outside it races a concurrent creator and
   * duplicates the header. `make` may return null to skip the append.
   */
  appendWithInit(absPath: string, make: (exists: boolean) => string | null): Promise<void> {
    return enqueue(absPath, () =>
      withDir(path.dirname(absPath), async () => {
        let exists = true
        try {
          await fs.access(absPath)
        } catch {
          exists = false
        }
        const text = make(exists)
        if (text === null) return
        await fs.appendFile(absPath, text, 'utf8')
      })
    )
  },

  /** Serialized delete, ordered against writes to the same path. */
  deleteFile(absPath: string): Promise<void> {
    return enqueue(absPath, () => fs.rm(absPath, { force: true }))
  },

  /** Ensure a directory exists (recursive, idempotent). */
  mkdirp(dir: string): Promise<void> {
    return ensureDir(dir)
  },

  /**
   * Await in-flight queued writes. With a path, awaits that file's queue;
   * without, awaits every write queued AT CALL TIME (one snapshot round) —
   * used on turn teardown so queued json lands atomically before the turn
   * closes. Deliberately NOT drain-until-empty: with concurrent turns other
   * writers keep enqueueing (per-line logs, the corpus 2s flush), and a
   * finishing turn waiting for global quiescence would spin forever.
   * Best-effort: never rejects.
   */
  async flush(absPath?: string): Promise<void> {
    if (absPath) {
      const key = path.resolve(absPath)
      // Drain until this path has no queued tail — a tail can chain a new write
      // while we await, so re-check rather than awaiting a single snapshot.
      while (queues.has(key)) {
        await (queues.get(key) ?? Promise.resolve()).catch(() => {})
      }
      return
    }
    await Promise.allSettled([...queues.values()])
  }
}
