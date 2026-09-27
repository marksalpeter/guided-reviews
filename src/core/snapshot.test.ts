import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, mkdir, readFile, readlink, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SystemExec } from './exec.js'
import { Git } from './git.js'
import { Snapshots, snapshotDir } from './snapshot.js'

describe('Snapshots', () => {
  let dir: string
  let exec: SystemExec
  let git: Git
  let first: string
  let second: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'gr-snap-'))
    exec = new SystemExec(dir)
    await exec.run('git', ['init', '-q', '-b', 'main'])
    await exec.run('git', ['config', 'user.email', 'test@example.com'])
    await exec.run('git', ['config', 'user.name', 'Test'])
    git = new Git(dir, exec)

    await writeFile(join(dir, 'package.json'), '{}\n')
    await writeFile(join(dir, 'a.ts'), 'export const a = 1\n')
    await exec.run('git', ['add', '-A'])
    await exec.run('git', ['commit', '-qm', 'first'])
    first = await git.revParse('HEAD')
    await writeFile(join(dir, 'a.ts'), 'export const a = 2\n')
    await exec.run('git', ['commit', '-qam', 'second'])
    second = await git.revParse('HEAD')
    await mkdir(join(dir, 'node_modules'))
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('answers from the repository itself when it already holds the commit', async () => {
    expect(await new Snapshots(git).rootFor(second, false)).toBe(dir)
  })

  it('checks out a commit the working tree has moved past', async () => {
    const root = await new Snapshots(git).rootFor(first, false)
    expect(root).toBe(join(await git.gitCommonDir(), snapshotDir, first))
    expect(await readFile(join(root, 'a.ts'), 'utf8')).toBe('export const a = 1\n')
  })

  it('checks out the head commit once the working tree has uncommitted edits', async () => {
    const snapshots = new Snapshots(git)
    await writeFile(join(dir, 'a.ts'), 'export const a = 3\n')
    expect(await snapshots.rootFor(second, false)).not.toBe(dir)
  })

  it('checks out the head commit while an editor holds unsaved edits', async () => {
    expect(await new Snapshots(git).rootFor(second, true)).not.toBe(dir)
  })

  it('keeps its verdict on the working tree until told something changed', async () => {
    const snapshots = new Snapshots(git)
    expect(await snapshots.rootFor(second, false)).toBe(dir)
    await writeFile(join(dir, 'a.ts'), 'export const a = 3\n')
    expect(await snapshots.rootFor(second, false)).toBe(dir)
    snapshots.invalidate()
    expect(await snapshots.rootFor(second, false)).not.toBe(dir)
  })

  it('links the installed packages into the snapshot', async () => {
    const root = await new Snapshots(git).rootFor(first, false)
    expect(await readlink(join(root, 'node_modules'))).toBe(join(dir, 'node_modules'))
  })

  it('builds one checkout for lookups that race each other', async () => {
    const snapshots = new Snapshots(git)
    const roots = await Promise.all([snapshots.rootFor(first, true), snapshots.rootFor(first, true)])
    expect(roots[0]).toBe(roots[1])
  })

  it('drops the snapshot of a commit no longer under review', async () => {
    const snapshots = new Snapshots(git)
    const old = await snapshots.rootFor(first, true)
    await snapshots.rootFor(second, true)
    await expect(stat(old)).rejects.toThrow()
  })

  it('rebuilds a snapshot something else removed', async () => {
    const snapshots = new Snapshots(git)
    const root = await snapshots.rootFor(first, true)
    await git.removeWorktree(root)
    expect(await snapshots.rootFor(first, true)).toBe(root)
    expect(await readFile(join(root, 'a.ts'), 'utf8')).toBe('export const a = 1\n')
  })

  it('checks out a commit whose branch another worktree already holds', async () => {
    await exec.run('git', ['worktree', 'add', '-q', join(dir, '..', `${dir.split('/').pop()}-other`), '-b', 'held', first])
    try {
      expect(await readFile(join(await new Snapshots(git).rootFor(first, true), 'a.ts'), 'utf8')).toBe('export const a = 1\n')
    } finally {
      await rm(join(dir, '..', `${dir.split('/').pop()}-other`), { recursive: true, force: true })
    }
  })
})
