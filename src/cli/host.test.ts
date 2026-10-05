import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { chmod, lstat, mkdtemp, mkdir, readFile, readlink, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { SystemExec } from '../core/exec.js'
import { Git } from '../core/git.js'
import type { HostMessage } from '../core/protocol.js'
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

/** typescriptPackage is the compiler this repository installed, resolved before any test changes directory. */
const typescriptPackage = dirname(createRequire(join(process.cwd(), 'package.json')).resolve('typescript/package.json'))

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

  it('answers a definition from the project typescript', async () => {
    await mkdir(join(dir, 'src'), { recursive: true })
    await writeFile(join(dir, 'package.json'), '{"name":"fixture"}\n')
    await writeFile(
      join(dir, 'tsconfig.json'),
      '{ "compilerOptions": { "strict": true, "target": "ES2022", "module": "ESNext", "moduleResolution": "Bundler" }, "include": ["src"] }\n',
    )
    await writeFile(join(dir, 'src/auth.ts'), 'export function verify(token: string): boolean {\n  return token.length > 0\n}\n')
    await writeFile(join(dir, 'src/server.ts'), 'import { verify } from "./auth"\nexport function handle(token: string): boolean {\n  return verify(token)\n}\n')
    await mkdir(join(dir, 'node_modules'), { recursive: true })
    await symlink(typescriptPackage, join(dir, 'node_modules/typescript'))
    const exec = new SystemExec(dir)
    await exec.run('git', ['add', 'package.json', 'tsconfig.json', 'src'])
    await exec.run('git', ['commit', '-qm', 'types'])

    const host = new ReviewHost(service, failingRunner)
    const messages: HostMessage[] = []
    host.send = message => messages.push(message)
    await host.start()
    await host.handle({ type: 'lookup', id: 7, path: 'src/server.ts', line: 3, character: 9 })
    const lookup = messages.find(message => message.type === 'lookup' && message.id === 7)
    expect(lookup?.type === 'lookup' && lookup.lookup.kind).toBe('definition')
    if (!lookup || lookup.type !== 'lookup' || lookup.lookup.kind !== 'definition') {
      return
    }
    await host.handle({ type: 'peek', id: 8, location: lookup.lookup.target })
    const peek = messages.find(message => message.type === 'peek' && message.id === 8)
    expect(peek?.type === 'peek' && peek.peek?.text).toContain('export function verify')
    host.close()
  })

  it('opens the commit pair named on ready', async () => {
    const host = new ReviewHost(service, failingRunner)
    const messages: HostMessage[] = []
    host.send = message => messages.push(message)
    await host.start()
    const head = await service.repo.revParse('HEAD')
    const base = await service.repo.parentOf('HEAD')
    await host.handle({ type: 'ready', base: base ?? '', head })
    const review = messages.find(message => message.type === 'review')
    const refs = review?.type === 'review' ? review.payload.review.state.refs : undefined
    expect(refs?.baseSha).toBe(base)
    expect(refs?.headSha).toBe(head)
    expect(review?.type === 'review' && review.payload.review.files.map(file => file.path)).toEqual(['a.ts'])
    host.close()
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

  it('leaves the browser to the editor when launched from Cursor or VS Code', async () => {
    const opened: string[] = []
    const pending = binMain([], out, err, {
      runner: failingRunner,
      env: { CURSOR_AGENT: '1', TERM_PROGRAM: 'vscode' },
      platform: 'darwin',
      launch: async (_command, args) => {
        opened.push(args[0] ?? '')
      },
    })
    const url = await waitForUrl(err)
    await fetch(`${url}api/message`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'submit' }),
    })
    expect(await pending).toBe(0)
    expect(opened).toEqual([])
  })

  it('opens the system browser outside an editor', async () => {
    const opened: string[] = []
    const pending = binMain([], out, err, {
      runner: failingRunner,
      env: {},
      platform: 'linux',
      launch: async (_command, args) => {
        opened.push(args[0] ?? '')
      },
    })
    const url = await waitForUrl(err)
    await waitFor(() => opened.length > 0)
    expect(opened).toEqual([url])
    await fetch(`${url}api/message`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'submit' }),
    })
    expect(await pending).toBe(0)
  })

  it('installs /review under the home directory and links it into ~/.claude', async () => {
    const home = join(dir, 'home')
    const installed = await binMain(['install'], out, err, { homeDir: home, env: { PATH: '/usr/bin' } })

    expect(installed).toBe(0)
    const skill = await readFile(join(home, reviewSkillPath), 'utf8')
    expect(skill).toContain('run_in_background: true')
    expect(skill).toContain('in the foreground')
    expect(skill).toContain("editor's embedded browser")
    expect(skill).toContain('Browser tab')
    const link = join(home, claudeSkillDir)
    expect((await lstat(link)).isSymbolicLink()).toBe(true)
    expect(await readlink(link)).toBe('../../.agents/skills/review')
    expect(await readFile(join(link, 'SKILL.md'), 'utf8')).toBe(skill)
    expect(out.text).toContain(`installed /review skill to ${join(home, reviewSkillDir)}`)
    expect(out.text).toContain('skipped binary install')
    await expect(lstat(join(dir, reviewSkillDir))).rejects.toThrow()
  })

  it('replaces a real directory or a wrong link at the claude skill path', async () => {
    const home = join(dir, 'home')
    const link = join(home, claudeSkillDir)
    await mkdir(link, { recursive: true })
    await writeFile(join(link, 'SKILL.md'), 'stale')
    const deps = { homeDir: home, env: { PATH: '/usr/bin' } }

    expect(await binMain(['install'], out, err, deps)).toBe(0)
    expect((await lstat(link)).isSymbolicLink()).toBe(true)
    expect(await readFile(join(link, 'SKILL.md'), 'utf8')).not.toBe('stale')

    await rm(link, { recursive: true, force: true })
    await mkdir(dirname(link), { recursive: true })
    await symlink('../../elsewhere', link, 'dir')

    expect(await binMain(['install'], out, err, deps)).toBe(0)
    expect(await readlink(link)).toBe('../../.agents/skills/review')
  })

  it('copies the compiled binary into the system bin directory', async () => {
    const home = join(dir, 'home')
    const binDir = join(dir, 'bin')
    const execPath = join(dir, 'build', 'review')
    await mkdir(dirname(execPath), { recursive: true })
    await writeFile(execPath, 'binary')
    await chmod(execPath, 0o755)

    expect(await binMain(['install'], out, err, { homeDir: home, binDir, execPath, platform: 'linux', env: { PATH: '/usr/bin' } })).toBe(0)

    expect(await readFile(join(binDir, 'review'), 'utf8')).toBe('binary')
    expect(out.text).toContain(`installed review to ${join(binDir, 'review')}`)
    expect(out.text).toContain(`add ${binDir} to PATH`)
  })

  it('does not copy a Homebrew binary into the system bin directory', async () => {
    const home = join(dir, 'home')
    const execPath = join(dir, 'opt', 'homebrew', 'Cellar', 'review', 'HEAD', 'bin', 'review')
    await mkdir(dirname(execPath), { recursive: true })
    await writeFile(execPath, 'brewed')

    expect(await binMain(['install'], out, err, {
      homeDir: home,
      binDir: join(dir, 'usr-local-bin'),
      execPath,
      platform: 'linux',
      env: { PATH: '/usr/bin' },
    })).toBe(0)

    expect(out.text).toContain('review is already installed at')
    expect(await readFile(join(home, reviewSkillPath), 'utf8')).toContain('run_in_background: true')
    await expect(lstat(join(dir, 'usr-local-bin', 'review'))).rejects.toThrow()
  })

  it('leaves a binary that is already on PATH where it is', async () => {
    const home = join(dir, 'home')
    const binDir = join(dir, 'bin')
    const execPath = join(binDir, 'review')
    await mkdir(binDir, { recursive: true })
    await writeFile(execPath, 'already')

    expect(await binMain(['install'], out, err, { homeDir: home, binDir: join(dir, 'elsewhere'), execPath, platform: 'linux', env: { PATH: `/usr/bin:${binDir}` } })).toBe(0)

    expect(out.text).toContain('review is already installed at')
    await expect(lstat(join(dir, 'elsewhere', 'review'))).rejects.toThrow()
  })

  it('puts one commit in the url as its parent and itself', async () => {
    await writeFile(join(dir, 'a.ts'), 'one\ntwo\n')
    const exec = new SystemExec(dir)
    await exec.run('git', ['add', '-A'])
    await exec.run('git', ['commit', '-qm', 'second'])
    const head = (await exec.run('git', ['rev-parse', 'HEAD'])).trim()
    const base = (await exec.run('git', ['rev-parse', 'HEAD^'])).trim()

    const pending = binMain(['--no-open', 'HEAD'], out, err, { runner: failingRunner, noOpen: true })
    const url = await waitForUrl(err)
    const params = new URL(url).searchParams
    expect(params.get('base')).toBe(base)
    expect(params.get('head')).toBe(head)
    await fetch(`${url.split('?')[0]}api/message`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'ready', base, head }),
    })
    await fetch(`${url.split('?')[0]}api/message`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'submit' }),
    })
    expect(await pending).toBe(0)
  })

  it('puts a base..head range in the url', async () => {
    await writeFile(join(dir, 'a.ts'), 'one\ntwo\n')
    const exec = new SystemExec(dir)
    await exec.run('git', ['add', '-A'])
    await exec.run('git', ['commit', '-qm', 'second'])
    const head = (await exec.run('git', ['rev-parse', '--short', 'HEAD'])).trim()
    const base = (await exec.run('git', ['rev-parse', '--short', 'HEAD^'])).trim()
    const fullHead = (await exec.run('git', ['rev-parse', 'HEAD'])).trim()
    const fullBase = (await exec.run('git', ['rev-parse', 'HEAD^'])).trim()

    const pending = binMain(['--no-open', `${base}..${head}`], out, err, { runner: failingRunner, noOpen: true })
    const url = await waitForUrl(err)
    const params = new URL(url).searchParams
    expect(params.get('base')).toBe(fullBase)
    expect(params.get('head')).toBe(fullHead)
    await fetch(`${url.split('?')[0]}api/message`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'submit' }),
    })
    expect(await pending).toBe(0)
  })

  it('still lists comments without waiting', async () => {
    expect(await binMain(['comments'], out, err)).toBe(1)
    expect(err.text).toContain('No review has been opened')
  })
})

/** waitFor polls until a condition holds, for a step that follows the printed URL. */
async function waitFor(ready: () => boolean): Promise<void> {
  for (let i = 0; i < 50; i++) {
    if (ready()) {
      return
    }
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  throw new Error('timed out waiting')
}

/** waitForUrl polls stderr until the server prints its address. */
async function waitForUrl(err: Capture): Promise<string> {
  for (let i = 0; i < 50; i++) {
    const match = err.text.match(/http:\/\/127\.0\.0\.1:\d+\/[^\s.]*/)
    if (match) {
      return match[0]
    }
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  throw new Error(`server did not print a url: ${err.text}`)
}
