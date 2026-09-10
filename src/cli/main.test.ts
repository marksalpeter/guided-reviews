import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SystemExec } from '../core/exec.js'
import { Git } from '../core/git.js'
import { ReviewService } from '../core/review.js'
import { main } from './main.js'

/** Capture collects CLI output for assertions. */
class Capture {
  text = ''
  write(chunk: string): void {
    this.text += chunk
  }
}

describe('review', () => {
  let dir: string
  let cwd: string
  let exec: SystemExec
  let service: ReviewService
  let out: Capture
  let err: Capture

  beforeEach(async () => {
    cwd = process.cwd()
    dir = await mkdtemp(join(tmpdir(), 'gr-cli-'))
    exec = new SystemExec(dir)
    await exec.run('git', ['init', '-q', '-b', 'main'])
    await exec.run('git', ['config', 'user.email', 'test@example.com'])
    await exec.run('git', ['config', 'user.name', 'Test'])
    await writeFile(join(dir, 'a.ts'), 'one\ntwo\nthree\n')
    await exec.run('git', ['add', '-A'])
    await exec.run('git', ['commit', '-qm', 'base'])
    await exec.run('git', ['checkout', '-qb', 'feature'])
    await writeFile(join(dir, 'a.ts'), 'one\ntwo\nthree\ntarget\n')
    await exec.run('git', ['add', '-A'])
    await exec.run('git', ['commit', '-qm', 'work'])

    service = new ReviewService(new Git(dir, exec))
    process.chdir(dir)
    out = new Capture()
    err = new Capture()
  })

  afterEach(async () => {
    process.chdir(cwd)
    await rm(dir, { recursive: true, force: true })
  })

  it('prints usage with no arguments', async () => {
    expect(await main([], out, err)).toBe(0)
    expect(out.text).toContain('review comments')
  })

  it('rejects an unknown command', async () => {
    expect(await main(['frobnicate'], out, err)).toBe(2)
    expect(err.text).toContain('unknown command')
  })

  it('explains itself when no review has been opened', async () => {
    expect(await main(['comments'], out, err)).toBe(1)
    expect(err.text).toContain('open one in VS Code first')
  })

  it('lists unresolved threads for the current branch', async () => {
    const key = await service.openBranchReview()
    await service.startThread(key, 'a.ts', 'new', 4, 'needs a null check')

    expect(await main(['comments'], out, err)).toBe(0)
    expect(out.text).toContain('a.ts:4')
    expect(out.text).toContain('human: needs a null check')
  })

  it('never shows the agent a resolved thread', async () => {
    const key = await service.openBranchReview()
    const id = await service.startThread(key, 'a.ts', 'new', 4, 'nit')
    await service.resolveThread(key, id)

    await main(['comments'], out, err)
    expect(out.text).toContain('No unresolved review comments')
    expect(out.text).not.toContain('nit')
  })

  it('filters to unanswered threads on request', async () => {
    const key = await service.openBranchReview()
    const answered = await service.startThread(key, 'a.ts', 'new', 4, 'answered one')
    await service.reply(key, answered, 'done', 'agent')
    await service.startThread(key, 'a.ts', 'new', 2, 'open one')

    await main(['comments', '--unanswered'], out, err)
    expect(out.text).toContain('open one')
    expect(out.text).not.toContain('answered one')
  })

  it('emits machine-readable output on request', async () => {
    const key = await service.openBranchReview()
    await service.startThread(key, 'a.ts', 'new', 4, 'needs a null check')

    await main(['comments', '--json'], out, err)
    const parsed = JSON.parse(out.text)
    expect(parsed.key).toBe('feature')
    expect(parsed.threads[0].comments[0].body).toBe('needs a null check')
  })

  it('appends an agent reply that the human then sees', async () => {
    const key = await service.openBranchReview()
    const id = await service.startThread(key, 'a.ts', 'new', 4, 'needs a null check')

    expect(await main(['reply', id, '-m', 'fixed in abc123'], out, err)).toBe(0)
    const { state } = await service.load(key)
    expect(state.threads[0]?.comments.map(c => `${c.author}:${c.body}`)).toEqual([
      'human:needs a null check',
      'agent:fixed in abc123',
    ])
  })

  it('refuses to reply to a thread that does not exist', async () => {
    const key = await service.openBranchReview()
    await service.startThread(key, 'a.ts', 'new', 4, 'x')

    expect(await main(['reply', 't_missing', '-m', 'hi'], out, err)).toBe(1)
    expect(err.text).toContain('no thread t_missing')
  })

  it('replies into the review holding the thread, not the branch review beside it', async () => {
    // the shape that breaks it: a branch review against main, and the stacked pair the human is reading
    await exec.run('git', ['checkout', '-qb', 'parent', 'main'])
    await writeFile(join(dir, 'p.ts'), 'parent\n')
    await exec.run('git', ['add', '-A'])
    await exec.run('git', ['commit', '-qm', 'parent work'])
    await exec.run('git', ['checkout', '-q', 'feature'])
    const branchKey = await service.openBranchReview()
    const pairKey = await service.openRangeReview('parent', 'feature')
    const id = await service.startThread(pairKey, 'a.ts', 'new', 4, 'needs a null check')

    expect(await main(['reply', id, '-m', 'fixed it'], out, err)).toBe(0)

    expect((await service.load(pairKey)).state.threads[0]?.comments).toHaveLength(2)
    expect((await service.load(branchKey)).state.threads).toHaveLength(0)
  })

  it('lists the review the panel has open, not the one the branch name points at', async () => {
    const branchKey = await service.openBranchReview()
    await service.startThread(branchKey, 'a.ts', 'new', 4, 'on the branch review')
    const pairKey = await service.openRangeReview('main', 'feature')
    await service.startThread(pairKey, 'a.ts', 'new', 4, 'on the pair the human opened')
    await service.reviews.markCurrent(pairKey)

    expect(await main(['comments'], out, err)).toBe(0)

    expect(out.text).toContain('on the pair the human opened')
    expect(out.text).not.toContain('on the branch review')
  })

  it('falls back to the branch when the review the panel opened has been deleted', async () => {
    const branchKey = await service.openBranchReview()
    await service.startThread(branchKey, 'a.ts', 'new', 4, 'on the branch review')
    const pairKey = await service.openRangeReview('main', 'feature')
    await service.reviews.markCurrent(pairKey)
    await service.reviews.delete(pairKey)

    expect(await main(['comments'], out, err)).toBe(0)
    expect(out.text).toContain('on the branch review')
  })

  it('requires a message when replying', async () => {
    expect(await main(['reply', 't_abc'], out, err)).toBe(1)
    expect(err.text).toContain('usage: review reply')
  })

  it('has no way to resolve a thread', async () => {
    expect(await main(['resolve', 't_abc'], out, err)).toBe(2)
    expect(err.text).toContain('unknown command')
  })
})
