import { randomUUID } from 'node:crypto'
import { anchorContext, contextHash, relocate } from './anchors.js'
import type { ReviewEvent } from './events.js'
import { schemaVersion } from './events.js'
import { Git } from './git.js'
import { GuideGenerator, type ClaudeRunner } from './guide.js'
import type { SelectorState } from './protocol.js'
import { ReviewStore } from './store.js'
import type { Anchor, ChangedFile, LineAnchor, ReviewState, Thread } from './types.js'

/** commitPickerLimit is how many recent commits the two-commit picker offers. */
export const commitPickerLimit = 50

/** ReviewService is the use-case layer both the extension and the CLI drive. */
export class ReviewService {
  private git: Git
  private store: ReviewStore

  constructor(git: Git, store: ReviewStore = new ReviewStore(git.repoRoot)) {
    this.git = git
    this.store = store
  }

  /** repo exposes the underlying git instance for callers that need raw plumbing. */
  get repo(): Git {
    return this.git
  }

  /** reviews exposes the store for listing and deletion. */
  get reviews(): ReviewStore {
    return this.store
  }

  /** openBranchReview creates or advances the review for the current branch. */
  async openBranchReview(): Promise<string> {
    const branch = await this.git.currentBranch()
    const headSha = await this.git.revParse('HEAD')
    const key = branch ? ReviewStore.keyForBranch(branch) : ReviewStore.keyForRange('detached', headSha)

    const existing = await this.store.load(key)
    if (existing.refs.baseSha) {
      await this.advanceHead(key, existing, headSha, branch || headSha.slice(0, 12))
      return key
    }

    const defaultBranch = await this.git.defaultBranch()
    const baseSha = await this.git.mergeBase(defaultBranch, 'HEAD')
    await this.store.append(key, {
      t: 'review.created',
      v: schemaVersion,
      key,
      kind: 'branch',
      ...(branch ? { branch } : {}),
      baseSha,
      headSha,
      baseLabel: defaultBranch,
      headLabel: branch || headSha.slice(0, 12),
      at: now(),
    })
    return key
  }

  /** defaultSelection is where the panel opens: the branch's head against the commit it forked from. */
  async defaultSelection(): Promise<Selection> {
    const branch = (await this.git.currentBranch()) || 'HEAD'
    return this.selectionAgainst(branch, await this.git.defaultBranchName())
  }

  /** selectionAgainst brackets a branch by its merge base with another branch, up to its head. */
  async selectionAgainst(branch: string, baseBranch: string): Promise<Selection> {
    const headSha = await this.git.revParse(branch)
    return { branch, baseBranch, baseSha: await this.openingBase(branch, baseBranch, headSha), headSha }
  }

  /** openSelection creates or advances the review for one selected commit pair. */
  async openSelection(selection: Selection): Promise<string> {
    const canonical = await this.isCanonical(selection)
    if (canonical) {
      return this.openBranchReview()
    }
    return this.openRangeReview(selection.baseSha, selection.headSha)
  }

  /** selector builds the toolbar: the branch list, and the one timeline both commit pickers use. */
  async selector(selection: Selection): Promise<SelectorState> {
    return {
      branches: await this.git.baseBranches(selection.branch),
      timeline: await this.git.timeline(selection.branch, selection.baseBranch, commitPickerLimit),
      baseBranch: selection.baseBranch,
      baseSha: selection.baseSha,
      headSha: selection.headSha,
    }
  }

  /** openRangeReview creates a frozen review between two arbitrary revisions. */
  async openRangeReview(baseRev: string, headRev: string): Promise<string> {
    const baseSha = await this.git.revParse(baseRev)
    const headSha = await this.git.revParse(headRev)
    const key = ReviewStore.keyForRange(baseSha, headSha)

    const existing = await this.store.load(key)
    if (!existing.refs.baseSha) {
      await this.store.append(key, {
        t: 'review.created',
        v: schemaVersion,
        key,
        kind: 'range',
        baseSha,
        headSha,
        baseLabel: baseRev,
        headLabel: headRev,
        at: now(),
      })
    }
    return key
  }

  /** load folds a review and re-pins every thread against the current head. */
  async load(key: string): Promise<LoadedReview> {
    const state = await this.store.load(key)
    if (!state.refs.baseSha) {
      throw new Error(`review ${key} does not exist`)
    }
    const files = await this.git.changedFiles(state.refs.baseSha, state.refs.headSha)
    const threads = await this.relocateThreads(state.threads, files)
    return { state: { ...state, threads }, files }
  }

  /** startThread opens a thread at a line, capturing the text and context it was anchored to. */
  async startThread(key: string, path: string, side: LineAnchor['side'], line: number, body: string, endLine?: number): Promise<string> {
    const { files } = await this.load(key)
    const file = files.find(f => f.path === path)
    const blob = (side === 'new' ? file?.newBlob : file?.oldBlob) ?? ''
    const source = blob ? await this.git.blobText(blob) : ''
    const text = source.split('\n')[line - 1] ?? ''

    const anchor: LineAnchor = {
      kind: 'line',
      path,
      side,
      line,
      ...(endLine && endLine !== line ? { endLine } : {}),
      blob,
      text,
      contextHash: contextHash(anchorContext(source, line)),
    }
    return this.appendThread(key, anchor, body)
  }

  /** startGroupThread opens a thread against a guide chapter rather than a line. */
  async startGroupThread(key: string, groupId: string, body: string): Promise<string> {
    const { state } = await this.load(key)
    const group = state.guide?.groups.find(g => g.id === groupId)
    return this.appendThread(key, { kind: 'group', groupId, files: group?.files ?? [] }, body)
  }

  /** reply appends a message, reopening the thread when it had already been resolved. */
  async reply(key: string, threadId: string, body: string, author: 'human' | 'agent'): Promise<void> {
    const state = await this.store.load(key)
    if (state.threads.find(thread => thread.id === threadId)?.state === 'resolved') {
      await this.store.append(key, { t: 'thread.reopened', threadId, at: now() })
    }
    await this.store.append(key, {
      t: 'comment.added',
      id: `c_${randomUUID().slice(0, 8)}`,
      threadId,
      author,
      body,
      at: now(),
    })
  }

  /** markReviewed ticks a file off against the blob currently shown, so a later edit clears it. */
  markReviewed(key: string, path: string, blob: string): Promise<void> {
    return this.store.append(key, { t: 'file.reviewed', path, blob, at: now() })
  }

  /** unmarkReviewed clears a file's reviewed tick. */
  unmarkReviewed(key: string, path: string): Promise<void> {
    return this.store.append(key, { t: 'file.unreviewed', path, at: now() })
  }

  /** deleteComment drops one message from a thread, taking the thread with it when nothing is left. */
  deleteComment(key: string, threadId: string, commentId: string): Promise<void> {
    return this.store.append(key, { t: 'comment.deleted', threadId, commentId, at: now() })
  }

  /** resolveThread closes a thread, which hides it from the agent. */
  resolveThread(key: string, threadId: string): Promise<void> {
    return this.store.append(key, { t: 'thread.resolved', threadId, at: now() })
  }

  /** reopenThread returns a resolved thread to the agent's view. */
  reopenThread(key: string, threadId: string): Promise<void> {
    return this.store.append(key, { t: 'thread.reopened', threadId, at: now() })
  }

  /** generateGuide runs inference for the current head and records success or failure. */
  async generateGuide(key: string, runner: ClaudeRunner): Promise<void> {
    const { state, files } = await this.load(key)
    try {
      const diff = await this.git.unifiedDiff(state.refs.baseSha, state.refs.headSha)
      const groups = await new GuideGenerator(runner).generate(files, diff)
      await this.store.append(key, {
        t: 'guide.generated',
        baseSha: state.refs.baseSha,
        headSha: state.refs.headSha,
        groups,
        at: now(),
      })
    } catch (error) {
      await this.store.append(key, { t: 'guide.failed', message: messageOf(error), at: now() })
      throw error
    }
  }

  /** openingBase is where the branch meets its base branch, or its previous commit when they are one. */
  private async openingBase(branch: string, baseBranch: string, headSha: string): Promise<string> {
    if (branch !== baseBranch) {
      return this.git.mergeBase(baseBranch, branch)
    }
    // a branch forked from nothing, so the newest commit is the reviewable unit
    return (await this.git.parentOf(headSha)) ?? headSha
  }

  /** isCanonical reports whether a selection is the branch's own review rather than an ad-hoc pair. */
  private async isCanonical(selection: Selection): Promise<boolean> {
    if (selection.branch !== (await this.git.currentBranch())) {
      return false
    }
    const [head, fork] = await Promise.all([
      this.git.revParse(selection.branch),
      this.git.mergeBase(selection.baseBranch, selection.branch),
    ])
    return selection.headSha === head && selection.baseSha === fork
  }

  /** appendThread writes the open event and its first comment. */
  private async appendThread(key: string, anchor: Anchor, body: string): Promise<string> {
    const id = `t_${randomUUID().slice(0, 8)}`
    const events: ReviewEvent[] = [
      { t: 'thread.opened', id, anchor, at: now() },
      { t: 'comment.added', id: `c_${randomUUID().slice(0, 8)}`, threadId: id, author: 'human', body, at: now() },
    ]
    for (const event of events) {
      await this.store.append(key, event)
    }
    return id
  }

  /** advanceHead records a new head commit when the branch has moved on. */
  private async advanceHead(key: string, state: ReviewState, headSha: string, headLabel: string): Promise<void> {
    if (state.refs.headSha === headSha) {
      return
    }
    await this.store.append(key, { t: 'review.head_moved', headSha, headLabel, at: now() })
  }

  /** relocateThreads re-pins every line anchor against the blobs in the current diff. */
  private async relocateThreads(threads: readonly Thread[], files: readonly ChangedFile[]): Promise<Thread[]> {
    const byPath = new Map(files.map(f => [f.path, f]))
    return Promise.all(threads.map(thread => this.relocateThread(thread, byPath)))
  }

  /** relocateThread resolves one thread's current line, or marks it outdated. */
  private async relocateThread(thread: Thread, byPath: Map<string, ChangedFile>): Promise<Thread> {
    if (thread.anchor.kind !== 'line') {
      return thread
    }
    const anchor = thread.anchor
    const file = byPath.get(anchor.path)
    const currentBlob = (anchor.side === 'new' ? file?.newBlob : file?.oldBlob) ?? ''
    if (!currentBlob) {
      return { ...thread, status: 'outdated' }
    }
    if (currentBlob === anchor.blob) {
      return { ...thread, status: 'current', resolvedLine: anchor.line }
    }

    const patch = await this.git.diffBlobs(anchor.blob, currentBlob)
    const source = await this.git.blobText(currentBlob)
    const outcome = relocate(anchor, currentBlob, patch, source)
    return outcome.status === 'outdated'
      ? { ...thread, status: 'outdated' }
      : { ...thread, status: outcome.status, resolvedLine: outcome.line }
  }
}

/** now is the timestamp written on every appended event. */
function now(): string {
  return new Date().toISOString()
}

/** messageOf renders any thrown value as a string. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** LoadedReview pairs folded state with the diff it describes. */
export interface LoadedReview {
  state: ReviewState
  files: ChangedFile[]
}

/** Selection is the branch under review, the branch it is measured against, and the commits bracketing it. */
export interface Selection {
  branch: string
  baseBranch: string
  baseSha: string
  headSha: string
}
