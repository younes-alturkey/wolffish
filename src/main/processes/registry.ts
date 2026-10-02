import { diskWriter } from '@main/io/diskWriter'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { ProcessRecord } from './types'

/**
 * `brain/processes.json` — every process definition with its current or last
 * run. One file, written only through diskWriter.update (read-modify-write
 * inside the path's queue), so a tool call and the supervisor mutating at
 * the same moment cannot fork the list. Same shape and discipline as
 * projects.ts; the in-memory copy is the read path and is refreshed by every
 * write, so list() never touches disk.
 */

type StoreFile = { version: 1; processes: ProcessRecord[] }

export class ProcessRegistry {
  private records = new Map<string, ProcessRecord>()
  private loaded = false
  private mutationTail: Promise<unknown> = Promise.resolve()
  private changedListeners = new Set<(record: ProcessRecord | null) => void>()

  constructor(private readonly workspaceRoot: string) {}

  file(): string {
    return path.join(this.workspaceRoot, 'brain', 'processes.json')
  }

  onChanged(listener: (record: ProcessRecord | null) => void): () => void {
    this.changedListeners.add(listener)
    return () => this.changedListeners.delete(listener)
  }

  async load(): Promise<void> {
    try {
      const raw = await fs.readFile(this.file(), 'utf8')
      const parsed = JSON.parse(raw) as Partial<StoreFile>
      const list = Array.isArray(parsed?.processes) ? parsed.processes : []
      this.records = new Map(
        list.filter((r) => r && typeof r.name === 'string').map((r) => [r.name, r])
      )
    } catch {
      // Missing file / bad JSON — start from an empty list rather than throwing.
      this.records = new Map()
    }
    this.loaded = true
  }

  isLoaded(): boolean {
    return this.loaded
  }

  list(): ProcessRecord[] {
    return [...this.records.values()].sort((a, b) => a.createdAt - b.createdAt)
  }

  get(name: string): ProcessRecord | null {
    return this.records.get(name) ?? null
  }

  private serialize<T>(op: () => Promise<T>): Promise<T> {
    const run = this.mutationTail.then(op, op)
    this.mutationTail = run.then(
      () => undefined,
      () => undefined
    )
    return run
  }

  /** Insert or replace a record and persist. */
  upsert(record: ProcessRecord): Promise<ProcessRecord> {
    return this.serialize(async () => {
      this.records.set(record.name, record)
      await this.persist()
      this.fire(record)
      return record
    })
  }

  /** Read-modify-write one record; `mutate` returns the next value (or null to leave it). */
  mutate(
    name: string,
    mutate: (current: ProcessRecord) => ProcessRecord | null
  ): Promise<ProcessRecord | null> {
    return this.serialize(async () => {
      const current = this.records.get(name)
      if (!current) return null
      const next = mutate(current)
      if (!next) return current
      next.updatedAt = Date.now()
      this.records.set(name, next)
      await this.persist()
      this.fire(next)
      return next
    })
  }

  remove(name: string): Promise<boolean> {
    return this.serialize(async () => {
      const existed = this.records.delete(name)
      if (existed) {
        await this.persist()
        this.fire(null)
      }
      return existed
    })
  }

  private async persist(): Promise<void> {
    const body: StoreFile = { version: 1, processes: this.list() }
    await diskWriter.update(this.file(), () => JSON.stringify(body, null, 2))
  }

  private fire(record: ProcessRecord | null): void {
    for (const cb of this.changedListeners) {
      try {
        cb(record)
      } catch {
        // Never let a listener break a write.
      }
    }
  }
}
