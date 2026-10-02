import * as vscode from 'vscode'
import { readFile } from 'node:fs/promises'
import { isAbsolute, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { CodeLocation, Lookup, Peek, Reference } from '../core/protocol.js'
import { displayLine, peekAt } from '../core/peek.js'
import { snapshotDir, type Snapshots } from '../core/snapshot.js'

/** snapshotGlob marks every snapshot read-only, including files reached from inside one. */
const snapshotGlob = `**/.git/${snapshotDir}/**`

/** Navigator answers the diff's ⌘-hovers and ⌘-clicks from the language servers, at the commit under review. */
export class Navigator {
  private snapshots: Snapshots
  private repoRoot: string
  private disposables: vscode.Disposable[] = []

  constructor(snapshots: Snapshots, repoRoot: string) {
    this.snapshots = snapshots
    this.repoRoot = repoRoot
    // anything written to disk may end the working tree's match with the commit
    const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(repoRoot, '**/*'))
    const forget = () => snapshots.invalidate()
    this.disposables.push(watcher, watcher.onDidChange(forget), watcher.onDidCreate(forget), watcher.onDidDelete(forget))
    this.disposables.push(vscode.workspace.onDidSaveTextDocument(forget))
  }

  /** prepare builds the commit's snapshot alongside the diff, when the working tree does not hold it. */
  prepare(sha: string): void {
    this.snapshots.prepare(sha)
  }

  /** lookup finds where the symbol at a new-side position is defined, or that it is a declaration itself. */
  async lookup(sha: string, path: string, line: number, character: number): Promise<Lookup> {
    const uri = await this.uriFor(sha, path)
    const position = new vscode.Position(line - 1, character)
    const document = await vscode.workspace.openTextDocument(uri)
    const found =
      (await vscode.commands.executeCommand<(vscode.Location | vscode.LocationLink)[] | undefined>(
        'vscode.executeDefinitionProvider',
        uri,
        position,
      )) ?? []
    const first = found[0]
    if (!first) {
      return { kind: 'none' }
    }
    const origin = ('originSelectionRange' in first ? first.originSelectionRange : undefined) ?? document.getWordRangeAtPosition(position)
    if (!origin || origin.start.line !== position.line || origin.end.line !== position.line) {
      return { kind: 'none' }
    }
    const range = { start: origin.start.character, end: origin.end.character }
    // the name range, not the whole body: a recursive call sits inside its own definition
    if (found.some(link => targetOf(link).uri.toString() === uri.toString() && targetOf(link).range.contains(position))) {
      return { kind: 'declaration', range }
    }
    const target = targetOf(first)
    return { kind: 'definition', range, target: locationOf(target.uri, target.range) }
  }

  /** references lists every use of the declaration at a position, leaving out the declaration itself. */
  async references(sha: string, path: string, line: number, character: number): Promise<Reference[]> {
    const uri = await this.uriFor(sha, path)
    const position = new vscode.Position(line - 1, character)
    await vscode.workspace.openTextDocument(uri)
    const found =
      (await vscode.commands.executeCommand<vscode.Location[] | undefined>('vscode.executeReferenceProvider', uri, position)) ?? []
    const root = rootOf(uri.fsPath, path)
    const texts = new Map<string, Promise<string[]>>()
    const uses = found.filter(use => !(use.uri.toString() === uri.toString() && use.range.contains(position)))
    const references = await Promise.all(
      uses.map(async use => {
        const raw = (await linesOf(use.uri, texts))[use.range.start.line] ?? ''
        const shown = displayLine(raw, use.range.start.character, use.range.end.line === use.range.start.line ? use.range.end.character : raw.length)
        return {
          location: locationOf(use.uri, use.range),
          path: this.labelFor(use.uri.fsPath, root),
          line: use.range.start.line + 1,
          text: shown.text,
          match: shown.match,
        }
      }),
    )
    return references.sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line || a.match.start - b.match.start)
  }

  /** peek reads the window around a location the language server pointed at. */
  async peek(location: CodeLocation): Promise<Peek | null> {
    let file: string
    try {
      file = fileURLToPath(location.uri)
    } catch {
      return null
    }
    let text: string
    try {
      text = await readFile(file, 'utf8')
    } catch {
      return null
    }
    return peekAt(this.labelFor(file, snapshotRoot(file) ?? this.repoRoot), text, location)
  }

  /** open shows a location beside the review, selected, without taking focus from the panel. */
  async open(location: CodeLocation): Promise<void> {
    const selection = new vscode.Range(location.line, location.character, location.endLine, location.endCharacter)
    await vscode.window.showTextDocument(vscode.Uri.parse(location.uri), {
      viewColumn: vscode.ViewColumn.Beside,
      preserveFocus: true,
      preview: true,
      selection,
    })
  }

  /** dispose stops watching the working tree. */
  dispose(): void {
    for (const disposable of this.disposables) {
      disposable.dispose()
    }
    this.disposables = []
  }

  /** uriFor is a changed file inside whichever copy of the commit the language server should read. */
  private async uriFor(sha: string, path: string): Promise<vscode.Uri> {
    const root = await this.snapshots.rootFor(sha, this.hasUnsavedEdits())
    if (root !== this.repoRoot) {
      await markSnapshotsReadonly()
    }
    return vscode.Uri.file(join(root, path))
  }

  /** hasUnsavedEdits reports whether an editor holds text the language server reads instead of the disk. */
  private hasUnsavedEdits(): boolean {
    return vscode.workspace.textDocuments.some(
      document => document.isDirty && document.uri.scheme === 'file' && document.uri.fsPath.startsWith(this.repoRoot + sep),
    )
  }

  /** labelFor names a file by its repository path, wherever the snapshot or the packages put it. */
  private labelFor(file: string, root: string): string {
    for (const base of [root, this.repoRoot]) {
      const path = relative(base, file)
      if (!path.startsWith('..') && !isAbsolute(path)) {
        return path.split(sep).join('/')
      }
    }
    return file
  }
}

/** markSnapshotsReadonly adds the snapshot glob to the user's read-only files, once. */
async function markSnapshotsReadonly(): Promise<void> {
  const files = vscode.workspace.getConfiguration('files')
  const current = files.inspect<Record<string, boolean>>('readonlyInclude')?.globalValue ?? {}
  if (current[snapshotGlob]) {
    return
  }
  await files.update('readonlyInclude', { ...current, [snapshotGlob]: true }, vscode.ConfigurationTarget.Global)
}

/** targetOf is where a definition points, narrowed to the name when the server gives one. */
function targetOf(link: vscode.Location | vscode.LocationLink): { uri: vscode.Uri; range: vscode.Range } {
  return 'targetUri' in link
    ? { uri: link.targetUri, range: link.targetSelectionRange ?? link.targetRange }
    : { uri: link.uri, range: link.range }
}

/** locationOf flattens a range into what crosses to the webview. */
function locationOf(uri: vscode.Uri, range: vscode.Range): CodeLocation {
  return {
    uri: uri.toString(),
    line: range.start.line,
    character: range.start.character,
    endLine: range.end.line,
    endCharacter: range.end.character,
  }
}

/** snapshotRoot is the checkout a snapshot file was read from, when the path is one. */
function snapshotRoot(file: string): string | undefined {
  const marker = `${sep}.git${sep}${snapshotDir}${sep}`
  const at = file.indexOf(marker)
  if (at < 0) {
    return undefined
  }
  const rest = file.slice(at + marker.length)
  const slash = rest.indexOf(sep)
  if (slash < 0) {
    return undefined
  }
  return file.slice(0, at + marker.length + slash)
}

/** rootOf is the directory a changed file's repository path was joined onto. */
function rootOf(file: string, path: string): string {
  return file.slice(0, file.length - path.split('/').join(sep).length - 1)
}

/** linesOf reads a file's lines once per listing, however many uses it holds. */
function linesOf(uri: vscode.Uri, cache: Map<string, Promise<string[]>>): Promise<string[]> {
  let lines = cache.get(uri.fsPath)
  if (!lines) {
    lines = readFile(uri.fsPath, 'utf8').then(text => text.split(/\r?\n/), () => [])
    cache.set(uri.fsPath, lines)
  }
  return lines
}
