import { mkdir, readdir, stat, symlink } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { Git } from './git.js'

/** snapshotDir is where checkouts of reviewed commits live, inside the shared git directory. */
export const snapshotDir = 'guided-reviews'

/** Snapshots gives the language server a copy of the reviewed commit to answer from. */
export class Snapshots {
  private git: Git
  private building = new Map<string, Promise<string>>()
  private clean = new Map<string, Promise<boolean>>()

  constructor(git: Git) {
    this.git = git
  }

  /** rootFor is the repository itself when it already holds the commit, and a detached checkout of it otherwise. */
  async rootFor(sha: string, unsaved: boolean): Promise<string> {
    if (!unsaved && (await this.checksOut(sha))) {
      return this.git.repoRoot
    }
    return this.checkout(sha)
  }

  /** prepare starts the checkout a lookup would need, so the first one does not wait on it. */
  prepare(sha: string): void {
    void this.checksOut(sha).then(clean => (clean ? undefined : this.checkout(sha))).catch(() => undefined)
  }

  /** invalidate forgets whether the working tree matches, after anything on disk may have changed. */
  invalidate(): void {
    this.clean.clear()
  }

  /** checksOut caches the working tree's match against a commit until the next invalidate. */
  private checksOut(sha: string): Promise<boolean> {
    let known = this.clean.get(sha)
    if (!known) {
      known = this.git.checksOut(sha)
      this.clean.set(sha, known)
    }
    return known
  }

  /** checkout builds a commit's snapshot once, and rebuilds it if another window pruned it. */
  private checkout(sha: string): Promise<string> {
    // chained, so lookups racing the first build wait on it instead of starting their own
    const next = (this.building.get(sha) ?? Promise.resolve(''))
      .catch(() => '')
      .then(async built => (built && (await exists(join(built, '.git'))) ? built : this.build(sha, await this.pathFor(sha))))
    this.building.set(sha, next)
    return next
  }

  /** build checks the commit out, links in the installed packages, and drops every older snapshot. */
  private async build(sha: string, path: string): Promise<string> {
    if (!(await exists(join(path, '.git')))) {
      await mkdir(dirname(path), { recursive: true })
      await this.git.addDetachedWorktree(path, sha)
      await this.linkPackages(sha, path)
    }
    await this.prune(path)
    return path
  }

  /** linkPackages points each package in the snapshot at the dependencies already installed for it. */
  private async linkPackages(sha: string, path: string): Promise<void> {
    const packages = (await this.git.pathsAt(sha)).filter(file => file === 'package.json' || file.endsWith('/package.json'))
    for (const manifest of packages) {
      const dir = dirname(manifest)
      const installed = join(this.git.repoRoot, dir, 'node_modules')
      if (await exists(installed)) {
        await symlink(installed, join(path, dir, 'node_modules'), 'junction').catch(() => undefined)
      }
    }
  }

  /** prune removes the snapshots of commits no longer under review. */
  private async prune(keep: string): Promise<void> {
    const parent = dirname(keep)
    for (const name of await readdir(parent).catch(() => [])) {
      const other = join(parent, name)
      if (other !== keep) {
        this.building.delete(name)
        await this.git.removeWorktree(other)
      }
    }
  }

  /** pathFor is where one commit's snapshot is checked out. */
  private async pathFor(sha: string): Promise<string> {
    return join(await this.git.gitCommonDir(), snapshotDir, sha)
  }
}

/** exists reports whether a path is on disk. */
async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}
