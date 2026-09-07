import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SystemExec } from './exec.js'
import { Git } from './git.js'

describe('Git', () => {
  let dir: string
  let git: Git

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'gr-git-'))
    const exec = new SystemExec(dir)
    await exec.run('git', ['init', '-q', '-b', 'main'])
    await exec.run('git', ['config', 'user.email', 'test@example.com'])
    await exec.run('git', ['config', 'user.name', 'Test'])
    git = new Git(dir, exec)

    await writeFile(join(dir, 'a.ts'), 'export const a = 1\nexport const b = 2\n')
    await writeFile(join(dir, 'keep.ts'), 'export const keep = true\n')
    await exec.run('git', ['add', '-A'])
    await exec.run('git', ['commit', '-qm', 'base'])

    await exec.run('git', ['checkout', '-qb', 'feature'])
    await writeFile(join(dir, 'a.ts'), 'export const a = 1\nexport const b = 22\nexport const c = 3\n')
    await mkdir(join(dir, 'sub'), { recursive: true })
    await writeFile(join(dir, 'sub/new.ts'), 'export const n = 1\n')
    await exec.run('git', ['add', '-A'])
    await exec.run('git', ['commit', '-qm', 'feature work'])
  })

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('resolves the merge base between two refs', async () => {
    const base = await git.mergeBase('main', 'feature')
    const mainSha = await git.revParse('main')
    expect(base).toBe(mainSha)
  })

  it('reports the current branch', async () => {
    expect(await git.currentBranch()).toBe('feature')
  })

  it('rejects an invalid revision', async () => {
    await expect(git.revParse('no-such-ref')).rejects.toThrow()
  })

  it('lists changed files with blobs and line counts', async () => {
    const files = await git.changedFiles('main', 'feature')
    const byPath = Object.fromEntries(files.map(f => [f.path, f]))

    expect(Object.keys(byPath).sort()).toEqual(['a.ts', 'sub/new.ts'])
    expect(byPath['a.ts']?.status).toBe('modified')
    expect(byPath['a.ts']?.additions).toBe(2)
    expect(byPath['a.ts']?.deletions).toBe(1)
    expect(byPath['a.ts']?.oldBlob).toMatch(/^[0-9a-f]{40}$/)
    expect(byPath['a.ts']?.newBlob).toMatch(/^[0-9a-f]{40}$/)
    expect(byPath['sub/new.ts']?.status).toBe('added')
    expect(byPath['sub/new.ts']?.oldBlob).toBeNull()
  })

  it('excludes the review store from the diff', async () => {
    const exec = new SystemExec(dir)
    await mkdir(join(dir, '.guided-review'), { recursive: true })
    await writeFile(join(dir, '.guided-review/feature.jsonl'), '{}\n')
    await exec.run('git', ['add', '-Af'])
    await exec.run('git', ['commit', '-qm', 'store'])

    const files = await git.changedFiles('main', 'feature')
    expect(files.map(f => f.path)).not.toContain('.guided-review/feature.jsonl')
  })

  it('produces a unified diff', async () => {
    const diff = await git.unifiedDiff('main', 'feature')
    expect(diff).toContain('diff --git')
    expect(diff).toContain('+export const c = 3')
  })

  it('reads blob contents', async () => {
    const files = await git.changedFiles('main', 'feature')
    const a = files.find(f => f.path === 'a.ts')
    const text = await git.blobText(a!.newBlob!)
    expect(text).toContain('export const c = 3')
  })

  it('detects renames', async () => {
    const exec = new SystemExec(dir)
    await exec.run('git', ['mv', 'keep.ts', 'moved.ts'])
    await exec.run('git', ['commit', '-qm', 'rename'])

    const files = await git.changedFiles('main', 'feature')
    const renamed = files.find(f => f.status === 'renamed')
    expect(renamed?.oldPath).toBe('keep.ts')
    expect(renamed?.path).toBe('moved.ts')
  })

  it('falls back through default-branch candidates when no origin exists', async () => {
    expect(await git.defaultBranch()).toBe('main')
  })

  it('honours an explicit default-branch override', async () => {
    const overridden = new Git(dir, new SystemExec(dir), 'feature')
    expect(await overridden.defaultBranch()).toBe('feature')
  })
})

describe('Git.branches', () => {
  let dir: string
  let git: Git

  beforeAll(async () => {
    const { dir: repo, exec } = await initRepo()
    dir = repo
    git = new Git(dir, exec)

    await writeFile(join(dir, 'a.txt'), 'a\n')
    await commitAt(exec, 'base', '2020-01-01T00:00:00Z')

    await exec.run('git', ['checkout', '-qb', 'stale'])
    await writeFile(join(dir, 'stale.txt'), 's\n')
    await commitAt(exec, 'stale work', '2021-01-01T00:00:00Z')

    await exec.run('git', ['checkout', '-q', 'main'])
    await exec.run('git', ['checkout', '-qb', 'fresh'])
    for (const [i, when] of ['2022-01-01T00:00:00Z', '2022-06-01T00:00:00Z', '2023-01-01T00:00:00Z'].entries()) {
      await writeFile(join(dir, `fresh-${i}.txt`), `${i}\n`)
      await commitAt(exec, `fresh ${i}`, when)
    }
    await exec.run('git', ['checkout', '-q', 'main'])
  })

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('lists the default branch first, then the rest by most recent commit', async () => {
    const rows = await git.branches()
    expect(rows.map(b => b.name)).toEqual(['main', 'fresh', 'stale'])
    expect(rows.map(b => b.isDefault)).toEqual([true, false, false])
  })

  it('counts how many commits each branch carries beyond the default branch', async () => {
    const ahead = Object.fromEntries((await git.branches()).map(b => [b.name, b.ahead]))
    expect(ahead).toEqual({ main: 0, fresh: 3, stale: 1 })
  })

  it('carries each branch head sha and relative commit time', async () => {
    const fresh = (await git.branches()).find(b => b.name === 'fresh')
    expect(fresh?.headSha).toBe(await git.revParse('fresh'))
    expect(fresh?.when).toBeTruthy()
  })
})

describe('Git.timeline', () => {
  let dir: string
  let git: Git

  beforeAll(async () => {
    const { dir: repo, exec } = await initRepo()
    dir = repo
    git = new Git(dir, exec)

    await writeFile(join(dir, 'a.txt'), 'a\n')
    await commitAt(exec, 'first', '2020-01-01T00:00:00Z')
    await writeFile(join(dir, 'b.txt'), 'b\n')
    await commitAt(exec, 'second', '2020-02-01T00:00:00Z')

    await exec.run('git', ['checkout', '-qb', 'feat'])
    await writeFile(join(dir, 'c.txt'), 'c\n')
    await commitAt(exec, 'feat one', '2021-01-01T00:00:00Z')
    await writeFile(join(dir, 'd.txt'), 'd\n')
    await commitAt(exec, 'feat two', '2021-02-01T00:00:00Z')
  })

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('flags commits after the fork and leaves shared history unflagged', async () => {
    const timeline = await git.timeline('feat', 10)
    expect(timeline.branch).toBe('feat')
    expect(timeline.forkedFrom).toBe('main')
    expect(timeline.commits.map(c => [c.subject, c.afterFork])).toEqual([
      ['feat two', true],
      ['feat one', true],
      ['second', false],
      ['first', false],
    ])
  })

  it('sets forkSha to the merge base with the default branch', async () => {
    const timeline = await git.timeline('feat', 10)
    expect(timeline.forkSha).toBe(await git.mergeBase('main', 'feat'))
    expect(timeline.forkSha).toBe(await git.revParse('main'))
  })

  it('reports no fork point for the default branch itself', async () => {
    const timeline = await git.timeline('main', 10)
    expect(timeline.forkedFrom).toBe('')
    expect(timeline.forkSha).toBe('')
    expect(timeline.commits.map(c => c.subject)).toEqual(['second', 'first'])
    expect(timeline.commits.some(c => c.afterFork)).toBe(false)
  })

  it('honours the limit', async () => {
    const timeline = await git.timeline('feat', 2)
    expect(timeline.commits.map(c => c.subject)).toEqual(['feat two', 'feat one'])
  })
})

describe('Git.timeline across a merge from the default branch', () => {
  let dir: string
  let git: Git

  beforeAll(async () => {
    const { dir: repo, exec } = await initRepo()
    dir = repo
    git = new Git(dir, exec)

    await writeFile(join(dir, 'a.txt'), 'a\n')
    await commitAt(exec, 'first', '2020-01-01T00:00:00Z')

    await exec.run('git', ['checkout', '-qb', 'feat'])
    await writeFile(join(dir, 'feat.txt'), 'f\n')
    await commitAt(exec, 'feat work', '2021-01-01T00:00:00Z')

    await exec.run('git', ['checkout', '-q', 'main'])
    await writeFile(join(dir, 'main.txt'), 'm\n')
    await commitAt(exec, 'main after fork', '2022-01-01T00:00:00Z')

    await exec.run('git', ['checkout', '-q', 'feat'])
    await exec.run('git', ['merge', '-q', '--no-ff', '-m', 'merge main into feat', 'main'])
  })

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('flags branch commits by reachability, not by log order', async () => {
    const timeline = await git.timeline('feat', 10)
    // log order sinks 'feat work' below the fork point, so position alone would miscolour it
    expect(timeline.commits.map(c => c.subject)).toEqual([
      'merge main into feat',
      'main after fork',
      'feat work',
      'first',
    ])
    const flagged = Object.fromEntries(timeline.commits.map(c => [c.subject, c.afterFork]))
    expect(flagged['feat work']).toBe(true)
    expect(flagged['merge main into feat']).toBe(true)
  })

  it('moves the fork point to the merged default-branch commit', async () => {
    const timeline = await git.timeline('feat', 10)
    expect(timeline.forkSha).toBe(await git.revParse('main'))
    const merged = timeline.commits.find(c => c.subject === 'main after fork')
    expect(merged?.sha).toBe(timeline.forkSha)
    expect(merged?.afterFork).toBe(false)
  })
})

describe('Git.defaultBranchName', () => {
  let dir: string
  let remote: string
  let git: Git

  beforeAll(async () => {
    const { dir: repo, exec } = await initRepo()
    dir = repo
    git = new Git(dir, exec)

    remote = await mkdtemp(join(tmpdir(), 'gr-remote-'))
    await new SystemExec(remote).run('git', ['init', '-q', '--bare', '-b', 'main'])

    await writeFile(join(dir, 'a.txt'), 'a\n')
    await commitAt(exec, 'base', '2020-01-01T00:00:00Z')
    await exec.run('git', ['remote', 'add', 'origin', remote])
    await exec.run('git', ['push', '-q', '-u', 'origin', 'main'])
    await exec.run('git', ['remote', 'set-head', 'origin', 'main'])

    await exec.run('git', ['checkout', '-qb', 'feat'])
    await writeFile(join(dir, 'b.txt'), 'b\n')
    await commitAt(exec, 'feat work', '2021-01-01T00:00:00Z')
  })

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true })
    await rm(remote, { recursive: true, force: true })
  })

  it('strips the remote prefix from the default branch', async () => {
    expect(await git.defaultBranch()).toBe('origin/main')
    expect(await git.defaultBranchName()).toBe('main')
  })

  it('matches the stripped name against local branches', async () => {
    const rows = await git.branches()
    expect(rows.map(b => b.name)).toEqual(['main', 'feat'])
    expect(rows[0]?.isDefault).toBe(true)
  })

  it('labels a branch as forked from the stripped default name', async () => {
    expect((await git.timeline('feat', 10)).forkedFrom).toBe('main')
  })
})

async function initRepo(): Promise<{ dir: string; exec: SystemExec }> {
  const dir = await mkdtemp(join(tmpdir(), 'gr-git-'))
  const exec = new SystemExec(dir)
  await exec.run('git', ['init', '-q', '-b', 'main'])
  await exec.run('git', ['config', 'user.email', 'test@example.com'])
  await exec.run('git', ['config', 'user.name', 'Test'])
  return { dir, exec }
}

/** commitAt stages everything and commits with a fixed author and committer date. */
async function commitAt(exec: SystemExec, message: string, when: string): Promise<void> {
  await exec.run('git', ['add', '-A'])
  process.env.GIT_COMMITTER_DATE = when
  try {
    await exec.run('git', ['commit', '-qm', message, `--date=${when}`])
  } finally {
    delete process.env.GIT_COMMITTER_DATE
  }
}
