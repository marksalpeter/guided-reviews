import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SystemExec } from './exec.js'
import { Git } from './git.js'
import { ReviewService } from './review.js'
import { ReviewStore } from './store.js'
import { unansweredThreads, unresolvedThreads } from './fold.js'

describe('ReviewService', () => {
  let dir: string
  let exec: SystemExec
  let service: ReviewService

  const commit = async (message: string) => {
    await exec.run('git', ['add', '-A'])
    await exec.run('git', ['commit', '-qm', message])
  }

  const writeLines = (lines: string[]) => writeFile(join(dir, 'a.ts'), `${lines.join('\n')}\n`)

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'gr-review-'))
    exec = new SystemExec(dir)
    await exec.run('git', ['init', '-q', '-b', 'main'])
    await exec.run('git', ['config', 'user.email', 'test@example.com'])
    await exec.run('git', ['config', 'user.name', 'Test'])

    await writeLines(['one', 'two', 'three'])
    await commit('base')
    await exec.run('git', ['checkout', '-qb', 'feature'])
    await writeLines(['one', 'two', 'three', 'target', 'five'])
    await commit('feature work')

    service = new ReviewService(new Git(dir, exec))
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  describe('selection', () => {
    it('opens a feature branch on its head against the commit it forked from', async () => {
      const selection = await service.defaultSelection()

      expect(selection).toEqual({
        branch: 'feature',
        baseSha: await service.repo.mergeBase('main', 'feature'),
        headSha: await service.repo.revParse('feature'),
      })
    })

    it('opens the default branch against its previous commit, since it forked from nothing', async () => {
      await exec.run('git', ['checkout', '-q', 'main'])
      await writeLines(['one', 'two', 'three', 'main moved on'])
      await commit('main advances')

      const selection = await service.defaultSelection()

      expect(selection.branch).toBe('main')
      expect(selection.headSha).toBe(await service.repo.revParse('main'))
      expect(selection.baseSha).toBe(await service.repo.revParse('main~1'))
    })

    it('falls back to an empty range on a default branch with no parent commit', async () => {
      const bare = await mkdtemp(join(tmpdir(), 'gr-root-'))
      const rootExec = new SystemExec(bare)
      await rootExec.run('git', ['init', '-q', '-b', 'main'])
      await rootExec.run('git', ['config', 'user.email', 'test@example.com'])
      await rootExec.run('git', ['config', 'user.name', 'Test'])
      await writeFile(join(bare, 'a.ts'), 'only\n')
      await rootExec.run('git', ['add', '-A'])
      await rootExec.run('git', ['commit', '-qm', 'root'])

      const selection = await new ReviewService(new Git(bare, rootExec)).defaultSelection()

      expect(selection.baseSha).toBe(selection.headSha)
      await rm(bare, { recursive: true, force: true })
    })

    it('snaps the base to the fork point when a target branch is chosen', async () => {
      await exec.run('git', ['checkout', '-q', 'main'])
      await writeLines(['one', 'two', 'three', 'main moved on'])
      await commit('main advances')

      const selection = await service.selectionForBranch('feature')

      expect(selection.baseSha).toBe(await service.repo.mergeBase('main', 'feature'))
      expect(selection.headSha).toBe(await service.repo.revParse('feature'))
    })

    it('keys the branch review by branch name when the pair is the canonical one', async () => {
      expect(await service.openSelection(await service.defaultSelection())).toBe('feature')
    })

    it('keys an ad-hoc pair by its commits rather than the branch', async () => {
      const selection = await service.defaultSelection()
      const key = await service.openSelection({ ...selection, baseSha: await service.repo.revParse('main~0') })

      const moved = { ...selection, baseSha: await service.repo.revParse('feature') }
      expect(await service.openSelection(moved)).not.toBe(key)
      expect(await service.openSelection(moved)).toContain('..')
    })

    it('keeps each pair its own event log', async () => {
      const selection = await service.defaultSelection()
      const branchKey = await service.openSelection(selection)
      await service.startThread(branchKey, 'a.ts', 'new', 4, 'on the branch review')

      const pairKey = await service.openSelection({ ...selection, baseSha: await service.repo.revParse('feature') })

      expect((await service.load(branchKey)).state.threads).toHaveLength(1)
      expect((await service.load(pairKey)).state.threads).toHaveLength(0)
    })

    it('always hands the toolbar a timeline to select commits from', async () => {
      const onBranch = await service.selector(await service.defaultSelection())
      expect(onBranch.timeline.branch).toBe('feature')
      expect(onBranch.timeline.forkedFrom).toBe('main')

      await exec.run('git', ['checkout', '-q', 'main'])
      const onMain = await service.selector(await service.defaultSelection())
      expect(onMain.timeline.branch).toBe('main')
      expect(onMain.timeline.forkedFrom).toBe('')
    })

    it('lists the default branch first in the branch picker', async () => {
      const selector = await service.selector(await service.defaultSelection())

      expect(selector.branches[0]?.name).toBe('main')
      expect(selector.branches[0]?.isDefault).toBe(true)
      expect(selector.branches.map(branch => branch.name)).toContain('feature')
    })
  })

  it('creates a branch review pinned to the merge base', async () => {
    const key = await service.openBranchReview()
    const { state } = await service.load(key)

    expect(key).toBe('feature')
    expect(state.kind).toBe('branch')
    expect(state.branch).toBe('feature')
    expect(state.refs.baseSha).toBe(await service.repo.revParse('main'))
    expect(state.refs.headSha).toBe(await service.repo.revParse('HEAD'))
  })

  it('keeps the base pinned when the branch advances', async () => {
    const key = await service.openBranchReview()
    const originalBase = (await service.load(key)).state.refs.baseSha

    await writeLines(['one', 'two', 'three', 'target', 'five', 'six'])
    await commit('more work')
    await service.openBranchReview()

    const { state } = await service.load(key)
    expect(state.refs.baseSha).toBe(originalBase)
    expect(state.refs.headSha).toBe(await service.repo.revParse('HEAD'))
  })

  it('carries an unresolved thread forward, re-pinned, across a later commit', async () => {
    const key = await service.openBranchReview()
    await service.startThread(key, 'a.ts', 'new', 4, 'this needs a null check')
    expect((await service.load(key)).state.threads[0]?.status).toBe('current')

    // insert two lines above the anchored line, so it moves from 4 to 6
    await writeLines(['zero', 'half', 'one', 'two', 'three', 'target', 'five'])
    await commit('insert above')
    await service.openBranchReview()

    const thread = (await service.load(key)).state.threads[0]
    expect(thread?.status).toBe('relocated')
    expect(thread?.resolvedLine).toBe(6)
    expect(thread?.comments[0]?.body).toBe('this needs a null check')
  })

  it('marks a thread outdated when its line is deleted', async () => {
    const key = await service.openBranchReview()
    await service.startThread(key, 'a.ts', 'new', 4, 'comment on target')

    await writeLines(['one', 'two', 'three', 'five'])
    await commit('delete target')
    await service.openBranchReview()

    expect((await service.load(key)).state.threads[0]?.status).toBe('outdated')
  })

  it('marks a thread outdated when its file leaves the diff', async () => {
    const key = await service.openBranchReview()
    await service.startThread(key, 'a.ts', 'new', 4, 'comment')

    await writeLines(['one', 'two', 'three'])
    await commit('revert the file')
    await service.openBranchReview()

    expect((await service.load(key)).state.threads[0]?.status).toBe('outdated')
  })

  it('hides resolved threads from the agent and restores them on reopen', async () => {
    const key = await service.openBranchReview()
    const id = await service.startThread(key, 'a.ts', 'new', 4, 'fix this')

    await service.resolveThread(key, id)
    expect(unresolvedThreads((await service.load(key)).state)).toHaveLength(0)

    await service.reopenThread(key, id)
    expect(unresolvedThreads((await service.load(key)).state)).toHaveLength(1)
  })

  it('drops a thread out of the unanswered list once the agent replies', async () => {
    const key = await service.openBranchReview()
    const id = await service.startThread(key, 'a.ts', 'new', 4, 'fix this')
    expect(unansweredThreads((await service.load(key)).state)).toHaveLength(1)

    await service.reply(key, id, 'fixed in abc123', 'agent')
    expect(unansweredThreads((await service.load(key)).state)).toHaveLength(0)
  })

  it('creates a frozen range review between two arbitrary revisions', async () => {
    const key = await service.openRangeReview('main', 'HEAD')
    const { state, files } = await service.load(key)

    expect(state.kind).toBe('range')
    expect(key).toBe(ReviewStore.keyForRange(state.refs.baseSha, state.refs.headSha))
    expect(files.map(f => f.path)).toEqual(['a.ts'])
  })

  it('does not advance a range review when the branch moves', async () => {
    const key = await service.openRangeReview('main', 'HEAD')
    const pinned = (await service.load(key)).state.refs.headSha

    await writeLines(['one', 'two', 'three', 'target', 'five', 'six'])
    await commit('more work')

    expect((await service.load(key)).state.refs.headSha).toBe(pinned)
  })

  it('records a guide failure without losing the review', async () => {
    const key = await service.openBranchReview()
    const runner = {
      run: async () => {
        throw new Error('claude unavailable')
      },
    }

    await expect(service.generateGuide(key, runner)).rejects.toThrow('claude unavailable')
    const { state } = await service.load(key)
    expect(state.guideError).toBe('claude unavailable')
    expect(state.guide).toBeUndefined()
  })

  it('stores a generated guide covering every changed file', async () => {
    const key = await service.openBranchReview()
    const runner = {
      run: async () => JSON.stringify({ result: '{"groups":[{"title":"C","summary":"s","files":["a.ts"]}]}' }),
    }

    await service.generateGuide(key, runner)
    const { state } = await service.load(key)
    expect(state.guide?.groups[0]?.files).toEqual(['a.ts'])
    expect(state.guideStale).toBe(false)
  })

  it('reopens a resolved thread when anyone comments again', async () => {
    const key = await service.openBranchReview()
    const id = await service.startThread(key, 'a.ts', 'new', 4, 'fix this')
    await service.resolveThread(key, id)
    expect((await service.load(key)).state.threads[0]?.state).toBe('resolved')

    await service.reply(key, id, 'still broken', 'human')
    const thread = (await service.load(key)).state.threads[0]
    expect(thread?.state).toBe('open')
    expect(thread?.comments.map(c => c.body)).toEqual(['fix this', 'still broken'])
  })

  it('reopens for an agent reply too, so a resolved ask cannot be answered invisibly', async () => {
    const key = await service.openBranchReview()
    const id = await service.startThread(key, 'a.ts', 'new', 4, 'fix this')
    await service.resolveThread(key, id)

    await service.reply(key, id, 'fixed in abc123', 'agent')
    expect((await service.load(key)).state.threads[0]?.state).toBe('open')
  })

  it('does not stack reopen events when replying to an already open thread', async () => {
    const key = await service.openBranchReview()
    const id = await service.startThread(key, 'a.ts', 'new', 4, 'fix this')
    await service.reply(key, id, 'more', 'human')

    const events = await service.reviews.read(key)
    expect(events.filter(e => e.t === 'thread.reopened')).toHaveLength(0)
  })

  it('ticks a file off against the blob on screen', async () => {
    const key = await service.openBranchReview()
    const { files } = await service.load(key)
    const file = files[0]!

    await service.markReviewed(key, file.path, file.newBlob!)
    expect((await service.load(key)).state.reviewedBlobs[file.path]).toBe(file.newBlob)
  })

  it('leaves a stale tick behind when the file changes, so the UI can un-tick it', async () => {
    const key = await service.openBranchReview()
    const before = (await service.load(key)).files[0]!
    await service.markReviewed(key, before.path, before.newBlob!)

    await writeLines(['one', 'two', 'three', 'target', 'five', 'six'])
    await commit('more work')
    await service.openBranchReview()

    const { state, files } = await service.load(key)
    expect(state.reviewedBlobs['a.ts']).toBe(before.newBlob)
    expect(files[0]?.newBlob).not.toBe(before.newBlob)
  })

  it('clears a tick outright when unmarked', async () => {
    const key = await service.openBranchReview()
    const file = (await service.load(key)).files[0]!
    await service.markReviewed(key, file.path, file.newBlob!)
    await service.unmarkReviewed(key, file.path)

    expect((await service.load(key)).state.reviewedBlobs).toEqual({})
  })
})
