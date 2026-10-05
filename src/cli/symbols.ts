import { readFileSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, isAbsolute, join, normalize, relative, sep } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import type { CodeLocation, ColumnRange, Lookup, Peek, Reference } from '../core/protocol.js'
import { displayLine, peekAt } from '../core/peek.js'
import { Snapshots } from '../core/snapshot.js'
import type { Git } from '../core/git.js'
import type * as TS from 'typescript'

/** scriptExtensions are the files the TypeScript language service can answer about. */
const scriptExtensions = new Set(['ts', 'tsx', 'mts', 'cts', 'js', 'jsx', 'mjs', 'cjs'])

/** Symbols answers the diff's ⌘-hovers from the repository's own TypeScript, at the commit under review. */
export class Symbols {
  private git: Git
  private snapshots: Snapshots
  private compilers = new Map<string, Promise<typeof TS | undefined>>()
  private projects = new Map<string, Promise<Project | undefined>>()
  private gates = new Map<string, Promise<unknown>>()
  private open = true

  constructor(git: Git) {
    this.git = git
    this.snapshots = new Snapshots(git)
  }

  /** prepare checks the commit out ahead of the first hover that needs it. */
  prepare(sha: string): void {
    this.snapshots.prepare(sha)
  }

  /** lookup finds where the symbol at a new-side position is defined, or that it is a declaration itself. */
  async lookup(sha: string, path: string, line: number, character: number): Promise<Lookup> {
    const project = await this.projectFor(sha, path)
    if (!this.open) {
      return { kind: 'none' }
    }
    return project?.lookup(path, line, character) ?? { kind: 'none' }
  }

  /** references lists every use of the symbol at a position, leaving out that position itself. */
  async references(sha: string, path: string, line: number, character: number): Promise<Reference[]> {
    const project = await this.projectFor(sha, path)
    return project?.references(path, line, character) ?? []
  }

  /** peek reads the window of a file a location points at, when that file belongs to the commit. */
  async peek(sha: string, location: CodeLocation): Promise<Peek | null> {
    if (!this.open) {
      return null
    }
    let file: string
    try {
      file = fileURLToPath(location.uri)
    } catch {
      return null
    }
    const root = await this.rootFor(sha)
    if (!within(file, root) && !within(file, this.git.repoRoot)) {
      return null
    }
    const text = readFile(file)
    if (text === undefined) {
      return null
    }
    return peekAt(labelFor(file, [root, this.git.repoRoot]), text, location)
  }

  /** close drops every language service the review opened. */
  close(): void {
    this.open = false
    this.disposeProjects()
  }

  /** projectFor is the language service for the file's project, built once per commit and tsconfig. */
  private async projectFor(sha: string, path: string): Promise<Project | undefined> {
    if (!this.open || !isScript(path)) {
      return undefined
    }
    const root = await this.rootFor(sha)
    const previous = this.gates.get(root) ?? Promise.resolve()
    const run = previous.catch(() => undefined).then(() => this.resolveProject(root, path))
    this.gates.set(root, run)
    return run
  }

  /** resolveProject reuses the service for a tsconfig, and adds the file to it. */
  private async resolveProject(root: string, path: string): Promise<Project | undefined> {
    const file = normalize(join(root, path))
    const ts = await this.compilerFor(root, file)
    if (!ts) {
      return undefined
    }
    const config = configIn(ts, root, file)
    const key = `${root}\0${config}`
    let pending = this.projects.get(key)
    if (!pending) {
      pending = Promise.resolve().then(() => {
        const project = Project.open(ts, root, config)
        if (!this.open) {
          project?.dispose()
          return undefined
        }
        return project
      })
      this.projects.set(key, pending)
    }
    const project = await pending
    project?.ensure(file)
    return project
  }

  /** rootFor is the checkout the commit is read from, reconsidered each time because nothing watches the tree. */
  private rootFor(sha: string): Promise<string> {
    this.snapshots.invalidate()
    return this.snapshots.rootFor(sha, false)
  }

  /** compilerFor loads the TypeScript the file's package installed, once per installed copy. */
  private compilerFor(root: string, file: string): Promise<typeof TS | undefined> {
    const spec = typeScriptPackage(file, root)
    const key = spec ?? `\0${file}`
    let pending = this.compilers.get(key)
    if (!pending) {
      pending = Promise.resolve().then(() => (spec ? requireTypeScript(spec) : undefined))
      this.compilers.set(key, pending)
    }
    return pending
  }

  /** disposeProjects frees the services held for checkouts no longer in use. */
  private disposeProjects(): void {
    for (const pending of this.projects.values()) {
      void pending.then(project => project?.dispose()).catch(() => undefined)
    }
    this.projects.clear()
    this.gates.clear()
  }
}

/** Project is one TypeScript language service rooted at a checkout. */
class Project {
  private ts: typeof TS
  private root: string
  private files: string[]
  private service: TS.LanguageService
  private disposed = false

  private constructor(ts: typeof TS, root: string, files: string[], service: TS.LanguageService) {
    this.ts = ts
    this.root = root
    this.files = files
    this.service = service
  }

  /** open builds a service from a tsconfig, or from one inferred for a repository that has none. */
  static open(ts: typeof TS, root: string, configPath: string): Project | undefined {
    try {
      const parsed = configPath ? readConfig(ts, configPath) : inferred(ts)
      const files = [...parsed.files]
      const options = parsed.options
      const host: TS.LanguageServiceHost = {
        getCompilationSettings: () => options,
        getScriptFileNames: () => files,
        getScriptVersion: versionOf,
        getScriptSnapshot: file => {
          const text = ts.sys.readFile(file)
          return text === undefined ? undefined : ts.ScriptSnapshot.fromString(text)
        },
        getCurrentDirectory: () => root,
        getDefaultLibFileName: settings => ts.getDefaultLibFilePath(settings),
        fileExists: ts.sys.fileExists,
        readFile: ts.sys.readFile,
        readDirectory: ts.sys.readDirectory,
        directoryExists: ts.sys.directoryExists,
        getDirectories: ts.sys.getDirectories,
        useCaseSensitiveFileNames: () => ts.sys.useCaseSensitiveFileNames,
        getNewLine: () => ts.sys.newLine,
        realpath: ts.sys.realpath,
      }
      return new Project(ts, root, files, ts.createLanguageService(host))
    } catch {
      return undefined
    }
  }

  /** ensure adds a file the diff asked about that the tsconfig did not list. */
  ensure(file: string): void {
    if (!this.files.some(known => sameFile(known, file))) {
      this.files.push(file)
    }
  }

  /** lookup resolves one position. A failure to read the file is the same as no symbol. */
  lookup(path: string, line: number, character: number): Lookup {
    const file = this.absolute(path)
    this.ensure(file)
    const text = this.ts.sys.readFile(file)
    const offset = text === undefined ? null : offsetAt(text, line, character)
    if (text === undefined || offset === null) {
      return { kind: 'none' }
    }
    const bound = this.service.getDefinitionAndBoundSpan(file, offset)
    const definitions = bound?.definitions
    if (!bound || !definitions || definitions.length === 0) {
      return { kind: 'none' }
    }
    const range = columnsOnLine(text, bound.textSpan, line)
    if (!range) {
      return { kind: 'none' }
    }
    if (definitions.some(definition => sameFile(definition.fileName, file) && contains(definition.textSpan, offset))) {
      return { kind: 'declaration', range }
    }
    const target = definitions[0]
    if (!target) {
      return { kind: 'none' }
    }
    return { kind: 'definition', range, target: this.locationOf(target.fileName, target.textSpan) }
  }

  /** references lists uses of the symbol, in path order, without the position that was asked. */
  references(path: string, line: number, character: number): Reference[] {
    const file = this.absolute(path)
    this.ensure(file)
    const text = this.ts.sys.readFile(file)
    const offset = text === undefined ? null : offsetAt(text, line, character)
    if (offset === null) {
      return []
    }
    const found = this.service.findReferences(file, offset) ?? []
    const uses = found
      .flatMap(symbol => symbol.references)
      .filter(use => !(sameFile(use.fileName, file) && contains(use.textSpan, offset)))
    return uses
      .map(use => this.referenceOf(use))
      .sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line || a.match.start - b.match.start)
  }

  /** dispose releases the documents the service is holding. */
  dispose(): void {
    if (this.disposed) {
      return
    }
    this.disposed = true
    this.service.dispose()
  }

  /** referenceOf turns one language-service use into the row the peek lists. */
  private referenceOf(use: TS.ReferenceEntry): Reference {
    const source = this.ts.sys.readFile(use.fileName) ?? ''
    const start = placeAt(source, use.textSpan.start)
    const end = placeAt(source, use.textSpan.start + use.textSpan.length)
    const raw = source.split(/\r?\n/)[start.line] ?? ''
    const shown = displayLine(raw, start.character, end.line === start.line ? end.character : raw.length)
    return {
      location: this.locationOf(use.fileName, use.textSpan),
      path: labelFor(use.fileName, [this.root]),
      line: start.line + 1,
      text: shown.text,
      match: shown.match,
    }
  }

  /** locationOf is a text span as the webview hands it back. */
  private locationOf(file: string, span: TS.TextSpan): CodeLocation {
    const source = this.ts.sys.readFile(file) ?? ''
    const start = placeAt(source, span.start)
    const end = placeAt(source, span.start + span.length)
    return {
      uri: pathToFileURL(file).href,
      line: start.line,
      character: start.character,
      endLine: end.line,
      endCharacter: end.character,
    }
  }

  /** absolute is a repository path inside this checkout. */
  private absolute(path: string): string {
    return normalize(join(this.root, path))
  }
}

/** typeScriptPackage is the nearest typescript that can answer a definition, walking up from the file. */
function typeScriptPackage(file: string, root: string): string | undefined {
  const rejected = new Set<string>()
  let dir = dirname(file)
  while (dir === root || within(dir, root)) {
    const found = usableTypeScript(dir, rejected)
    if (found) {
      return found
    }
    if (dir === root) {
      break
    }
    const parent = dirname(dir)
    if (parent === dir) {
      break
    }
    dir = parent
  }
  return undefined
}

/** usableTypeScript is the typescript visible from one directory, when it still exports a language service. */
function usableTypeScript(dir: string, rejected: Set<string>): string | undefined {
  let resolved: string
  try {
    resolved = createRequire(join(dir, 'package.json')).resolve('typescript/package.json')
  } catch {
    return undefined
  }
  if (rejected.has(resolved)) {
    return undefined
  }
  try {
    const loaded = createRequire(resolved)('typescript') as typeof TS
    if (typeof loaded.createLanguageService === 'function') {
      return resolved
    }
  } catch {
    // a package that will not load is the same as one with no language service
  }
  rejected.add(resolved)
  return undefined
}

/** requireTypeScript loads a typescript package that typeScriptPackage already accepted. */
function requireTypeScript(spec: string): typeof TS | undefined {
  try {
    const loaded = createRequire(spec)('typescript') as typeof TS
    return typeof loaded.createLanguageService === 'function' ? loaded : undefined
  } catch {
    return undefined
  }
}

/** configIn is the nearest tsconfig or jsconfig inside the checkout, or none. */
function configIn(ts: typeof TS, root: string, file: string): string {
  const found = ts.findConfigFile(file, ts.sys.fileExists, 'tsconfig.json') ?? ts.findConfigFile(file, ts.sys.fileExists, 'jsconfig.json')
  if (!found || !within(found, root)) {
    return ''
  }
  return found
}

/** readConfig parses a tsconfig into the options and root files a service wants. */
function readConfig(ts: typeof TS, configPath: string): { options: TS.CompilerOptions; files: string[] } {
  const read = ts.readConfigFile(configPath, ts.sys.readFile)
  if (read.error) {
    return inferred(ts)
  }
  const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, dirname(configPath), { noEmit: true, allowJs: true }, configPath)
  return { options: { ...parsed.options, noEmit: true, allowJs: true }, files: parsed.fileNames }
}

/** inferred is the service for a script that belongs to no project. */
function inferred(ts: typeof TS): { options: TS.CompilerOptions; files: string[] } {
  return {
    options: {
      allowJs: true,
      allowNonTsExtensions: true,
      target: ts.ScriptTarget.ESNext,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      jsx: ts.JsxEmit.ReactJSX,
      esModuleInterop: true,
      strict: true,
      noEmit: true,
    },
    files: [],
  }
}

/** versionOf changes when the file on disk does, so a later hover sees an edit. */
function versionOf(file: string): string {
  try {
    return String(statSync(file).mtimeMs)
  } catch {
    return '0'
  }
}

/** columnsOnLine is a span that sits on the requested 1-based line, or null when it does not. */
function columnsOnLine(text: string, span: TS.TextSpan, line: number): ColumnRange | null {
  const start = placeAt(text, span.start)
  const end = placeAt(text, span.start + span.length)
  if (start.line !== line - 1 || end.line !== start.line) {
    return null
  }
  return { start: start.character, end: end.character }
}

/** offsetAt is a 1-based line and 0-based column as a UTF-16 offset, or null past the end. */
function offsetAt(text: string, line: number, character: number): number | null {
  if (line < 1 || character < 0) {
    return null
  }
  let current = 1
  let offset = 0
  while (current < line) {
    const next = text.indexOf('\n', offset)
    if (next < 0) {
      return null
    }
    offset = next + 1
    current++
  }
  return offset + character
}

/** placeAt is a UTF-16 offset as a 0-based line and column. */
function placeAt(text: string, offset: number): { line: number; character: number } {
  let line = 0
  let character = 0
  const end = Math.min(Math.max(0, offset), text.length)
  for (let index = 0; index < end; index++) {
    if (text.charCodeAt(index) === 10) {
      line++
      character = 0
    } else {
      character++
    }
  }
  return { line, character }
}

/** contains reports whether an offset sits inside a span. The end is exclusive. */
function contains(span: TS.TextSpan, offset: number): boolean {
  return offset >= span.start && offset < span.start + span.length
}

/** sameFile compares two paths after normalisation. */
function sameFile(a: string, b: string): boolean {
  return normalize(a) === normalize(b)
}

/** within reports whether a file sits inside a directory. */
function within(file: string, root: string): boolean {
  const path = relative(root, file)
  return path === '' || (!path.startsWith(`..${sep}`) && path !== '..' && !isAbsolute(path))
}

/** labelFor names a file by its path inside the first root that holds it. */
function labelFor(file: string, roots: readonly string[]): string {
  for (const root of roots) {
    const path = relative(root, file)
    if (path && !path.startsWith('..') && !isAbsolute(path)) {
      return path.split(sep).join('/')
    }
  }
  return file.split(sep).join('/')
}

/** isScript reports whether a repository path is one the language service reads. */
function isScript(path: string): boolean {
  const name = path.split('/').pop() ?? ''
  const extension = name.includes('.') ? (name.split('.').pop() ?? '') : ''
  return scriptExtensions.has(extension)
}

/** readFile reads a file as text, or undefined when it is missing. */
function readFile(file: string): string | undefined {
  try {
    return readFileSync(file, 'utf8')
  } catch {
    return undefined
  }
}
