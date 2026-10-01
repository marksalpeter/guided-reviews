import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { lstat, mkdtemp, mkdir, readFile, readlink, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { SystemExec } from '../core/exec.js'
import { Git } from '../core/git.js'
import { ReviewService } from '../core/review.js'
import { binMain } from './bin.js'
import { ReviewHost } from './host.js'
import { claudeSkillDir, reviewSkillDir, reviewSkillPath } from './skills.js'

/** Capture collects CLI output for assertions. */
class Capture {
  text = ''
  write(chunk: string): void {
    this.text += chunk
  }
}

/** failingRunner stands in for a headless agent so a test never spawns one. */
const failingRunner = { run: async () => { throw new Error('no model in test') } }

describe('ReviewHost', () => {
  let dir: string
  let cwd: string
  let service: ReviewService

  beforeEach(async () => {
    cwd = process.cwd()
    dir = await mkdtemp(join(tmpdir(), 'gr-host-'))
    const exec = new SystemExec(dir)
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
  })

  afterEach(async () => {
    process.chdir(cwd)
    await rm(dir, { recursive: true, force: true })
  })

  it('returns the unanswered threads when the human submits', async () => {
    const host = new ReviewHost(service, failingRunner)
    await host.start()
    await host.handle({ type: 'startThread', path: 'a.ts', side: 'new', line: 4, body: 'needs a null check' })

    const pending = host.submitted
    await host.handle({ type: 'submit' })
    const result = await pending

    expect(result.approved).toBe(false)
    expect(result.text).toContain('needs a null check')
    expect(result.text).toContain('a.ts:4')
  })

  it('approves a submit with nothing unanswered', async () => {
    const host = new ReviewHost(service, failingRunner)
    await host.start()
    const pending = host.submitted
    await host.handle({ type: 'submit' })
    const result = await pending
    expect(result.approved).toBe(true)
    expect(result.text).toContain('Review approved')
  })
})

describe('review binary', () => {
  let dir: string
  let cwd: string
  let out: Capture
  let err: Capture

  beforeEach(async () => {
    cwd = process.cwd()
    dir = await mkdtemp(join(tmpdir(), 'gr-bin-'))
    const exec = new SystemExec(dir)
    await exec.run('git', ['init', '-q', '-b', 'main'])
    await exec.run('git', ['config', 'user.email', 'test@example.com'])
    await exec.run('git', ['config', 'user.name', 'Test'])
    await writeFile(join(dir, 'a.ts'), 'one\n')
    await exec.run('git', ['add', '-A'])
    await exec.run('git', ['commit', '-qm', 'base'])
    process.chdir(dir)
    out = new Capture()
    err = new Capture()
  })

  afterEach(async () => {
    process.chdir(cwd)
    await rm(dir, { recursive: true, force: true })
  })

  it('blocks with no arguments until Submit, then approves an empty review', async () => {
    const pending = binMain(['--no-open'], out, err, { runner: failingRunner, noOpen: true })
    const url = await waitForUrl(err)
    await fetch(`${url}api/message`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'submit' }),
    })
    expect(await pending).toBe(0)
    expect(err.text).toContain('approved: true')
    expect(out.text).toContain('Review approved')
  })

  it('installs /review in .agents and links it into .claude', async () => {
    const stale = join(dir, '.cursor/skills/review')
    await mkdir(stale, { recursive: true })
    await writeFile(join(stale, 'SKILL.md'), 'stale cursor skill')

    expect(await binMain(['install'], out, err)).toBe(0)

    const skill = await readFile(join(dir, reviewSkillPath), 'utf8')
    expect(skill).toContain('run_in_background: true')
    expect(skill).toContain('in the foreground')
    const link = join(dir, claudeSkillDir)
    expect((await lstat(link)).isSymbolicLink()).toBe(true)
    expect(await readlink(link)).toBe('../../.agents/skills/review')
    expect(await readFile(join(link, 'SKILL.md'), 'utf8')).toBe(skill)
    await expect(lstat(stale)).rejects.toThrow()
    const lines = (await readFile(join(dir, '.git/info/exclude'), 'utf8')).split('\n').map(line => line.trim())
    expect(lines.filter(line => line === reviewSkillDir)).toHaveLength(1)
    expect(lines.filter(line => line === claudeSkillDir)).toHaveLength(1)
  })

  it('replaces a real directory or a wrong link at the claude skill path', async () => {
    const link = join(dir, claudeSkillDir)
    await mkdir(link, { recursive: true })
    await writeFile(join(link, 'SKILL.md'), 'stale')

    expect(await binMain(['install'], out, err)).toBe(0)
    expect((await lstat(link)).isSymbolicLink()).toBe(true)
    expect(await readFile(join(link, 'SKILL.md'), 'utf8')).not.toBe('stale')

    await rm(link, { recursive: true, force: true })
    await mkdir(dirname(link), { recursive: true })
    await symlink('../../elsewhere', link, 'dir')

    expect(await binMain(['install'], out, err)).toBe(0)
    expect(await readlink(link)).toBe('../../.agents/skills/review')
    const lines = (await readFile(join(dir, '.git/info/exclude'), 'utf8')).split('\n').map(line => line.trim())
    expect(lines.filter(line => line === reviewSkillDir)).toHaveLength(1)
    expect(lines.filter(line => line === claudeSkillDir)).toHaveLength(1)
  })

  it('still lists comments without waiting', async () => {
    expect(await binMain(['comments'], out, err)).toBe(1)
    expect(err.text).toContain('No review has been opened')
  })
})

/** waitForUrl polls stderr until the server prints its address. */
async function waitForUrl(err: Capture): Promise<string> {
  for (let i = 0; i < 50; i++) {
    const match = err.text.match(/http:\/\/127\.0\.0\.1:\d+\//)
    if (match) {
      return match[0]
    }
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  throw new Error(`server did not print a url: ${err.text}`)
}
