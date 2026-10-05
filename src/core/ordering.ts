import type { Guide } from './types.js'

const testDirs = new Set(['__tests__', 'test', 'tests', 'spec', 'specs'])

/** orderPaths sorts diff paths into the guide's reading order, keeping unguided paths last. */
export function orderPaths(paths: readonly string[], guide: Guide | undefined): string[] {
  if (!guide) {
    return [...paths]
  }
  const rank = new Map<string, number>()
  let next = 0
  for (const group of guide.groups) {
    for (const path of group.files) {
      if (!rank.has(path)) {
        rank.set(path, next++)
      }
    }
  }
  return [...paths].sort((a, b) => rankOf(rank, a, paths) - rankOf(rank, b, paths))
}

/** rankOf places a guided path by chapter order and an unguided one after every guided path. */
function rankOf(rank: Map<string, number>, path: string, paths: readonly string[]): number {
  const guided = rank.get(path)
  return guided ?? rank.size + paths.indexOf(path)
}

/** placeTests moves each test under the source file or files its name points at. */
export function placeTests(paths: readonly string[]): string[] {
  const moved = new Set<string>()
  const followers = new Map<string, string[]>()
  for (const path of paths) {
    const anchor = anchorOf(path, paths)
    if (!anchor) continue
    const list = followers.get(anchor) ?? []
    list.push(path)
    followers.set(anchor, list)
    moved.add(path)
  }
  const ordered: string[] = []
  for (const path of paths) {
    if (moved.has(path)) continue
    ordered.push(path)
    ordered.push(...(followers.get(path) ?? []))
  }
  return ordered
}

/** anchorOf is the last source file a test names, in the given order. */
export function anchorOf(path: string, paths: readonly string[]): string | undefined {
  const subjects = subjectsOf(path, paths)
  return subjects.reduce<string | undefined>(
    (later, candidate) => (later === undefined || paths.indexOf(candidate) > paths.indexOf(later) ? candidate : later),
    undefined,
  )
}

/** isTestPath reports whether a path is a test from its name alone. */
export function isTestPath(path: string): boolean {
  const name = base(path)
  if (/\.(test|spec)\.[^.]+$/.test(name) || /[._](test|spec)\.[^.]+$/.test(name) || /^test_.+\.[^.]+$/.test(name)) {
    return true
  }
  if (/(Tests|Test|Spec)\.(java|kt|scala|cs|rb)$/.test(name)) return true
  return segments(path).some(part => testDirs.has(part))
}

/** subjectsOf lists the source files in paths that a test's name points at. */
function subjectsOf(test: string, paths: readonly string[]): string[] {
  if (!isTestPath(test)) return []
  const want = subjectStem(test)
  const sources = paths.filter(path => path !== test && !isTestPath(path))
  const exact = sources.filter(path => stem(path) === want)
  if (exact.length > 0) return exact
  // a bare name matches only when one source file has it
  const name = leaf(want)
  const named = sources.filter(path => leaf(stem(path)) === name)
  return named.length === 1 ? named : []
}

/** subjectStem is the source path a test name points at, without an extension. */
function subjectStem(path: string): string {
  const { dir, name } = split(path)
  let stripped = name.replace(/\.(test|spec)$/, '').replace(/_(test|spec)$/, '').replace(/^test_/, '')
  if (/(Tests|Test|Spec)$/.test(name) && /\.(java|kt|scala|cs|rb)$/.test(base(path))) {
    stripped = name.replace(/(Tests|Test|Spec)$/, '')
  }
  const dirs = dir.split('/').filter(part => part && !testDirs.has(part))
  return [...dirs, stripped].filter(Boolean).join('/')
}

/** stem is a path without its final extension. */
function stem(path: string): string {
  const { dir, name } = split(path)
  return dir ? `${dir}/${name}` : name
}

/** split divides a path into its directory and its name without the final extension. */
function split(path: string): { dir: string; name: string } {
  const file = base(path)
  const dir = path.slice(0, path.length - file.length).replace(/\/$/, '')
  const dot = file.lastIndexOf('.')
  return { dir, name: dot === -1 ? file : file.slice(0, dot) }
}

/** leaf is the last segment of a stem. */
function leaf(stemPath: string): string {
  const slash = stemPath.lastIndexOf('/')
  return slash === -1 ? stemPath : stemPath.slice(slash + 1)
}

/** base is the last segment of a path. */
function base(path: string): string {
  const slash = path.lastIndexOf('/')
  return slash === -1 ? path : path.slice(slash + 1)
}

/** segments are the directory parts of a path. */
function segments(path: string): string[] {
  return path.split('/').slice(0, -1)
}

