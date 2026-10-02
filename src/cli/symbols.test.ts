import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { SystemExec } from '../core/exec.js'
import { Git } from '../core/git.js'
import { snapshotDir } from '../core/snapshot.js'
import { Symbols } from './symbols.js'

const typescriptPackage = dirname(createRequire(join(process.cwd(), 'package.json')).resolve('typescript/package.json'))

const auth = [
  '/** verify checks a token. */',
  'export function verify(token: string): boolean {',
  '  return token.length > 0 && verify(token.slice(1))',
  '}',
  '',
].join('\n')

const server = [
  "import { verify } from './auth'",
  '',
  'export function handle(token: string): boolean {',
  '  return verify(token)',
  '}',
  '',
].join('\n')

/** at is the 1-based line and 0-based column of the first occurrence of a needle. */
function at(source: string, needle: string): { line: number; character: number } {
  const offset = source.indexOf(needle)
  if (offset < 0) {
    throw new Error(`missing ${needle}`)
  }
  const before = source.slice(0, offset)
  return { line: before.split('\n').length, character: offset - (before.lastIndexOf('\n') + 1) }
}

describe('Symbols', () => {
  let dir: string
  let git: Git
  let sha: string
  let symbols: Symbols

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'gr-symbols-'))
    const exec = new SystemExec(dir)
    await exec.run('git', ['init', '-q', '-b', 'main'])
    await exec.run('git', ['config', 'user.email', 'test@example.com'])
    await exec.run('git', ['config', 'user.name', 'Test'])
    git = new Git(dir, exec)
    symbols = new Symbols(git)
  })

  afterEach(async () => {
    symbols.close()
    await rm(dir, { recursive: true, force: true })
  })

  it('finds a definition, a declaration, and the callers of the declaration', async () => {
    sha = await commitProject()
    const use = at(server, 'verify(token)')
    const declaration = at(auth, 'function verify')
    declaration.character += 'function '.length

    const definition = await symbols.lookup(sha, 'src/server.ts', use.line, use.character)
    expect(definition.kind).toBe('definition')
    if (definition.kind !== 'definition') {
      return
    }
    expect(definition.range).toEqual({ start: use.character, end: use.character + 'verify'.length })
    expect(fileURLToPath(definition.target.uri).endsWith('/src/auth.ts')).toBe(true)
    expect(definition.target.line).toBe(declaration.line - 1)
    expect(definition.target.character).toBe(declaration.character)

    const declared = await symbols.lookup(sha, 'src/auth.ts', declaration.line, declaration.character)
    expect(declared).toEqual({ kind: 'declaration', range: { start: declaration.character, end: declaration.character + 'verify'.length } })

    const recursive = at(auth, 'verify(token.slice')
    const inner = await symbols.lookup(sha, 'src/auth.ts', recursive.line, recursive.character)
    expect(inner.kind).toBe('definition')

    const references = await symbols.references(sha, 'src/auth.ts', declaration.line, declaration.character)
    expect(references.map(reference => [reference.path, reference.line, reference.text, reference.match])).toEqual([
      ['src/auth.ts', recursive.line, 'return token.length > 0 && verify(token.slice(1))', { start: recursive.character - 2, end: recursive.character - 2 + 'verify'.length }],
      ['src/server.ts', 1, "import { verify } from './auth'", { start: at(server, 'verify').character, end: at(server, 'verify').character + 'verify'.length }],
      ['src/server.ts', use.line, 'return verify(token)', { start: use.character - 2, end: use.character - 2 + 'verify'.length }],
    ])

    const peek = await symbols.peek(sha, definition.target)
    expect(peek?.path).toBe('src/auth.ts')
    expect(peek?.text).toContain('export function verify')
    expect(peek?.line).toBe(declaration.line)
  })

  it('answers from the commit when the working tree has moved on', async () => {
    sha = await commitProject()
    await writeFile(join(dir, 'src/auth.ts'), 'export function check(token: string): boolean {\n  return false\n}\n')
    const use = at(server, 'verify(token)')
    const definition = await symbols.lookup(sha, 'src/server.ts', use.line, use.character)
    expect(definition.kind).toBe('definition')
    if (definition.kind !== 'definition') {
      return
    }
    expect(fileURLToPath(definition.target.uri)).toContain(`${snapshotDir}/${sha}/`)
    const peek = await symbols.peek(sha, definition.target)
    expect(peek?.text).toContain('export function verify')
    expect(peek?.text).not.toContain('function check')
  })

  it('has nothing to say when the repository has not installed typescript', async () => {
    sha = await commitProject(false)
    const use = at(server, 'verify(token)')
    expect(await symbols.lookup(sha, 'src/server.ts', use.line, use.character)).toEqual({ kind: 'none' })
    expect(await symbols.references(sha, 'src/server.ts', use.line, use.character)).toEqual([])
  })

  it('ignores a file the language service does not read', async () => {
    sha = await commitProject()
    expect(await symbols.lookup(sha, 'README.md', 1, 0)).toEqual({ kind: 'none' })
  })

  it('refuses to read a location outside the repository', async () => {
    sha = await commitProject()
    expect(await symbols.peek(sha, { uri: 'file:///etc/passwd', line: 0, character: 0, endLine: 0, endCharacter: 1 })).toBeNull()
  })

  /** commitProject writes a small TypeScript program and returns its commit. */
  async function commitProject(withTypeScript = true): Promise<string> {
    await mkdir(join(dir, 'src'), { recursive: true })
    await writeFile(join(dir, 'package.json'), '{"name":"fixture"}\n')
    await writeFile(
      join(dir, 'tsconfig.json'),
      '{ "compilerOptions": { "strict": true, "target": "ES2022", "module": "ESNext", "moduleResolution": "Bundler" }, "include": ["src"] }\n',
    )
    await writeFile(join(dir, 'src/auth.ts'), auth)
    await writeFile(join(dir, 'src/server.ts'), server)
    await writeFile(join(dir, 'README.md'), '# notes\n')
    if (withTypeScript) {
      await mkdir(join(dir, 'node_modules'), { recursive: true })
      await symlink(typescriptPackage, join(dir, 'node_modules/typescript'))
    }
    const exec = new SystemExec(dir)
    await exec.run('git', ['add', 'package.json', 'tsconfig.json', 'src', 'README.md'])
    await exec.run('git', ['commit', '-qm', 'work'])
    return git.revParse('HEAD')
  }
})
