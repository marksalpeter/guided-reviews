import { appendFile, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parseEvent, serializeEvent, type ReviewEvent } from './events.js'
import { foldReview } from './fold.js'
import { storeDir } from './git.js'
import type { ReviewState } from './types.js'

/** atomicAppendLimit is the POSIX guarantee below which an O_APPEND write cannot interleave. */
const atomicAppendLimit = 4096

/** lockRetryMs is how long to wait between attempts to take the compaction-free write lock. */
const lockRetryMs = 5

/** lockTimeoutMs bounds a stuck lock so a crashed writer cannot wedge the store. */
const lockTimeoutMs = 5000

/** currentFile names the review the panel has open, which is not always the branch's own. */
const currentFile = 'current'

/** ReviewStore is the append-only JSONL event log backing every review. */
export class ReviewStore {
  private root: string

  constructor(root: string) {
    this.root = root
  }

  /** keyForBranch derives a filesystem-safe review key from a branch name. */
  static keyForBranch(branch: string): string {
    return branch.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '')
  }

  /** keyForRange derives the key for a frozen two-commit comparison. */
  static keyForRange(baseSha: string, headSha: string): string {
    return `${baseSha.slice(0, 12)}..${headSha.slice(0, 12)}`
  }

  /** dir is the absolute path of the review store. */
  get dir(): string {
    return join(this.root, storeDir)
  }

  /** pathFor is the log file backing one review key. */
  pathFor(key: string): string {
    return join(this.dir, `${key}.jsonl`)
  }

  /** ensureStoreDir creates the store and makes it ignore itself, never touching the user's gitignore. */
  async ensureStoreDir(): Promise<void> {
    await mkdir(this.dir, { recursive: true })
    await writeFile(join(this.dir, '.gitignore'), '*\n')
  }

  /** append adds one event, using a lock only when the line exceeds the atomic write size. */
  async append(key: string, event: ReviewEvent): Promise<void> {
    await this.ensureStoreDir()
    const line = serializeEvent(event)
    if (Buffer.byteLength(line) < atomicAppendLimit) {
      await appendFile(this.pathFor(key), line)
      return
    }
    await this.withLock(key, () => appendFile(this.pathFor(key), line))
  }

  /** read returns every well-formed event in a review's log, skipping corrupt lines. */
  async read(key: string): Promise<ReviewEvent[]> {
    const raw = await this.readRaw(key)
    if (raw === null) {
      return []
    }
    const events: ReviewEvent[] = []
    for (const line of raw.split('\n')) {
      const event = parseEvent(line)
      if (event) {
        events.push(event)
      }
    }
    return events
  }

  /** load reads and folds a review into its renderable state. */
  async load(key: string): Promise<ReviewState> {
    return foldReview(await this.read(key))
  }

  /** list names every review in the store. */
  async list(): Promise<string[]> {
    try {
      const entries = await readdir(this.dir)
      return entries.filter(e => e.endsWith('.jsonl')).map(e => e.slice(0, -'.jsonl'.length))
    } catch {
      return []
    }
  }

  /** markCurrent records which review the panel is showing, so an agent reads the one the human is reading. */
  async markCurrent(key: string): Promise<void> {
    await this.ensureStoreDir()
    await writeFile(join(this.dir, currentFile), `${key}\n`)
  }

  /** current is the review the panel last opened, or null when it names one that no longer exists. */
  async current(): Promise<string | null> {
    const key = (await this.readFileOr(join(this.dir, currentFile)))?.trim()
    if (!key) {
      return null
    }
    return (await this.read(key)).length > 0 ? key : null
  }

  /** findByThread returns the review holding a thread, since an agent names the thread and not the review. */
  async findByThread(threadId: string): Promise<string | null> {
    for (const key of await this.list()) {
      const state = await this.load(key)
      if (state.threads.some(thread => thread.id === threadId)) {
        return key
      }
    }
    return null
  }

  /** findByHead returns the review key whose head is the given sha, for agent lookups. */
  async findByHead(headSha: string): Promise<string | null> {
    for (const key of await this.list()) {
      const state = await this.load(key)
      if (state.refs.headSha === headSha) {
        return key
      }
    }
    return null
  }

  /** delete removes one review's log. */
  async delete(key: string): Promise<void> {
    await rm(this.pathFor(key), { force: true })
  }

  /** readRaw reads a log file, returning null when the review does not exist. */
  private async readRaw(key: string): Promise<string | null> {
    return this.readFileOr(this.pathFor(key))
  }

  /** readFileOr reads a file in the store, returning null when it is not there. */
  private async readFileOr(path: string): Promise<string | null> {
    try {
      return await readFile(path, 'utf8')
    } catch {
      return null
    }
  }

  /** withLock serialises oversized writes through an exclusive directory lock. */
  private async withLock(key: string, write: () => Promise<void>): Promise<void> {
    const lock = `${this.pathFor(key)}.lock`
    const deadline = Date.now() + lockTimeoutMs
    for (;;) {
      try {
        await mkdir(lock)
        break
      } catch {
        if (Date.now() > deadline) {
          await rm(lock, { recursive: true, force: true })
          continue
        }
        await delay(lockRetryMs)
      }
    }
    try {
      await write()
    } finally {
      await rm(lock, { recursive: true, force: true })
    }
  }
}

/** delay resolves after the given number of milliseconds. */
function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}
