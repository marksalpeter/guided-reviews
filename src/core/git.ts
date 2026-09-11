import { SystemExec, type Exec } from './exec.js'
import type { BranchSummary, ChangedFile, FileStatus, Timeline } from './types.js'

/** storeDir is the review store, excluded from every diff so a review never reviews itself. */
export const storeDir = '.guided-review'

/** defaultBranchCandidates are tried in order when origin/HEAD is absent. */
const defaultBranchCandidates = ['origin/main', 'origin/master', 'main', 'master']

/** renameDetection turns on git's similarity-based rename following. */
const renameDetection = '-M'

/** Git is every git side effect the extension performs, scoped to one repository root. */
export class Git {
  private root: string
  private exec: Exec
  private branchOverride: string

  constructor(root: string, exec: Exec = new SystemExec(root), branchOverride = '') {
    this.root = root
    this.exec = exec
    this.branchOverride = branchOverride
  }

  /** repoRoot is the absolute path this instance operates on. */
  get repoRoot(): string {
    return this.root
  }

  /** defaultBranch resolves the branch a feature branch is considered to fork from. */
  async defaultBranch(): Promise<string> {
    if (this.branchOverride) {
      return this.branchOverride
    }
    const symbolic = await this.tryGit(['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'])
    if (symbolic) {
      return symbolic.trim()
    }
    for (const candidate of defaultBranchCandidates) {
      if (await this.tryGit(['rev-parse', '--verify', '--quiet', candidate])) {
        return candidate
      }
    }
    throw new Error('could not determine a default branch; set guidedReviews.defaultBranch')
  }

  /** mergeBase returns the common ancestor of two revisions. */
  async mergeBase(a: string, b: string): Promise<string> {
    const out = await this.git(['merge-base', a, b])
    return out.trim()
  }

  /** sharedBase is the common ancestor, or null when the two histories are unrelated. */
  async sharedBase(a: string, b: string): Promise<string | null> {
    const out = await this.tryGit(['merge-base', a, b])
    return out ? out.trim() : null
  }

  /** parentOf is a commit's first parent, or null at the root of history. */
  async parentOf(rev: string): Promise<string | null> {
    const out = await this.tryGit(['rev-parse', '--verify', '--quiet', `${rev}^1^{commit}`])
    return out ? out.trim() : null
  }

  /** revParse resolves any revspec to a full sha, throwing when it does not exist. */
  async revParse(rev: string): Promise<string> {
    const out = await this.git(['rev-parse', '--verify', `${rev}^{commit}`])
    return out.trim()
  }

  /** currentBranch is the checked-out branch name, or an empty string when detached. */
  async currentBranch(): Promise<string> {
    const out = await this.tryGit(['symbolic-ref', '--quiet', '--short', 'HEAD'])
    return out ? out.trim() : ''
  }

  /** gitCommonDir is the shared .git directory, which differs from .git in a worktree. */
  async gitCommonDir(): Promise<string> {
    const out = await this.git(['rev-parse', '--path-format=absolute', '--git-common-dir'])
    return out.trim()
  }

  /** changedFiles lists every path that differs between two commits, with blobs and counts. */
  async changedFiles(base: string, head: string): Promise<ChangedFile[]> {
    // --abbrev=40 because raw output shortens blob shas, and anchors are keyed by full blob
    const raw = await this.git([
      'diff',
      '--raw',
      '--abbrev=40',
      '-z',
      renameDetection,
      base,
      head,
      '--',
      '.',
      `:(exclude)${storeDir}`,
    ])
    const stats = await this.numstat(base, head)
    return parseRawDiff(raw).map(entry => ({
      ...entry,
      additions: stats.get(entry.path)?.additions ?? 0,
      deletions: stats.get(entry.path)?.deletions ?? 0,
      binary: stats.get(entry.path)?.binary ?? false,
    }))
  }

  /** unifiedDiff is the full patch between two commits, excluding the review store. */
  unifiedDiff(base: string, head: string, contextLines = 3): Promise<string> {
    return this.git([
      'diff',
      renameDetection,
      `--unified=${contextLines}`,
      base,
      head,
      '--',
      '.',
      `:(exclude)${storeDir}`,
    ])
  }

  /** diffBlobs is the patch between two blobs, used to map thread anchors across commits. */
  async diffBlobs(oldBlob: string, newBlob: string): Promise<string> {
    return this.tryGit(['diff', '--unified=0', '--no-color', oldBlob, newBlob]).then(out => out ?? '')
  }

  /** blobText reads one blob's contents. */
  blobText(blob: string): Promise<string> {
    return this.git(['cat-file', 'blob', blob])
  }

  /** hasRef reports whether a revision still resolves, since a chosen base branch can later be deleted. */
  async hasRef(rev: string): Promise<boolean> {
    return (await this.tryGit(['rev-parse', '--verify', '--quiet', `${rev}^{commit}`])) !== null
  }

  /** baseBranchName is the default branch under the name the picker lists it by, or the remote ref when no local branch carries it. */
  async baseBranchName(): Promise<string> {
    const full = await this.defaultBranch()
    const local = full.replace(/^[^/]+\//, '')
    return (await this.hasRef(local)) ? local : full
  }

  /** defaultBranchName is the default branch without its remote prefix, for display and fork labels. */
  async defaultBranchName(): Promise<string> {
    const full = await this.defaultBranch()
    return full.replace(/^[^/]+\//, '')
  }

  /** baseBranches lists the branches a branch can be compared against, newest first after the default. */
  async baseBranches(branch: string): Promise<BranchSummary[]> {
    const defaultName = await this.defaultBranchName()
    const out = await this.git([
      'for-each-ref',
      '--sort=-committerdate',
      '--format=%(refname:short)%00%(objectname)%00%(committerdate:relative)',
      'refs/heads',
    ])
    const rows = out
      .split('\n')
      .filter(Boolean)
      .map(line => {
        const [name = '', headSha = '', when = ''] = line.split('\0')
        return { name, headSha, when, isDefault: name === defaultName }
      })
      // a branch cannot be its own base, and an unrelated history has nothing to compare against
      .filter(row => row.name !== branch)

    const candidates = await Promise.all(
      rows.map(async row => ({
        ...row,
        ahead: await this.aheadCount(defaultName, row.name),
        shares: (await this.sharedBase(row.name, branch)) !== null,
      })),
    )
    const offered = candidates.filter(row => row.shares).map(({ shares: _shares, ...row }) => row)
    return [...offered.filter(row => row.isDefault), ...offered.filter(row => !row.isDefault)]
  }

  /** timeline is one branch's selectable history, flagging which commits postdate the fork. */
  async timeline(branch: string, against: string, limit: number): Promise<Timeline> {
    const forkedFrom = against
    const isDefault = branch === forkedFrom
    const forkSha = isDefault ? '' : await this.mergeBase(forkedFrom, branch)
    // a set membership test, rather than log order, so a merged-in base commit cannot be miscoloured
    const after = forkSha ? await this.shasBetween(forkSha, branch) : new Set<string>()
    const out = await this.git(['log', `-${limit}`, '--topo-order', '--format=%H%x00%s%x00%an%x00%ar', branch])
    const commits = out
      .split('\n')
      .filter(Boolean)
      .map(line => {
        const [sha = '', subject = '', author = '', when = ''] = line.split('\0')
        return { sha, subject, author, when, afterFork: after.has(sha) }
      })
    return { branch, forkedFrom: isDefault ? '' : forkedFrom, forkSha, commits }
  }

  /** aheadCount is how many commits a branch carries that its base does not. */
  private async aheadCount(base: string, branch: string): Promise<number> {
    const out = await this.tryGit(['rev-list', '--count', `${base}..${branch}`])
    return out ? Number(out.trim()) || 0 : 0
  }

  /** shasBetween collects every commit reachable from head but not from base. */
  private async shasBetween(base: string, head: string): Promise<Set<string>> {
    const out = await this.tryGit(['rev-list', `${base}..${head}`])
    return new Set((out ?? '').split('\n').filter(Boolean))
  }

  /** git runs a git subcommand in the repository root. */
  private git(args: readonly string[]): Promise<string> {
    return this.exec.run('git', args)
  }

  /** tryGit runs a git subcommand, returning null instead of throwing when it fails. */
  private async tryGit(args: readonly string[]): Promise<string | null> {
    try {
      return await this.git(args)
    } catch {
      return null
    }
  }

  /** numstat collects per-path line counts and binary flags for a commit pair. */
  private async numstat(base: string, head: string): Promise<Map<string, NumStat>> {
    const out = await this.git(['diff', '--numstat', '-z', renameDetection, base, head, '--', '.', `:(exclude)${storeDir}`])
    return parseNumstat(out)
  }
}

/** parseRawDiff turns `git diff --raw -z` output into per-path blob and status records. */
function parseRawDiff(raw: string): RawEntry[] {
  const fields = raw.split('\0').filter(f => f.length > 0)
  const entries: RawEntry[] = []
  let i = 0
  while (i < fields.length) {
    const meta = fields[i]
    if (!meta || !meta.startsWith(':')) {
      i++
      continue
    }
    const parts = meta.slice(1).split(' ')
    const [oldMode = '', newMode = '', oldSha = '', newSha = '', statusCode = ''] = parts
    const isRename = statusCode.startsWith('R') || statusCode.startsWith('C')
    const first = fields[i + 1] ?? ''
    const second = isRename ? (fields[i + 2] ?? '') : ''
    i += isRename ? 3 : 2

    entries.push({
      path: isRename ? second : first,
      ...(isRename ? { oldPath: first } : {}),
      status: toFileStatus(statusCode),
      oldBlob: isNullSha(oldSha) ? null : oldSha,
      newBlob: isNullSha(newSha) ? null : newSha,
      oldMode,
      newMode,
    })
  }
  return entries
}

/** parseNumstat turns `git diff --numstat -z` output into per-path counts. */
function parseNumstat(out: string): Map<string, NumStat> {
  const stats = new Map<string, NumStat>()
  const fields = out.split('\0').filter(f => f.length > 0)
  let i = 0
  while (i < fields.length) {
    const record = fields[i] ?? ''
    const [addRaw = '', delRaw = '', inlinePath = ''] = record.split('\t')
    // a rename emits an empty trailing path, then old and new paths as separate fields
    if (inlinePath === '') {
      const newPath = fields[i + 2] ?? ''
      stats.set(newPath, toNumStat(addRaw, delRaw))
      i += 3
      continue
    }
    stats.set(inlinePath, toNumStat(addRaw, delRaw))
    i += 1
  }
  return stats
}

/** toNumStat reads one numstat pair, treating git's `-` markers as a binary file. */
function toNumStat(additions: string, deletions: string): NumStat {
  const binary = additions === '-' || deletions === '-'
  return {
    additions: binary ? 0 : Number(additions) || 0,
    deletions: binary ? 0 : Number(deletions) || 0,
    binary,
  }
}

/** toFileStatus maps a git raw status code to the domain status. */
function toFileStatus(code: string): FileStatus {
  switch (code.charAt(0)) {
    case 'A':
      return 'added'
    case 'D':
      return 'deleted'
    case 'R':
    case 'C':
      return 'renamed'
    default:
      return 'modified'
  }
}

/** isNullSha reports whether a raw-diff sha is git's all-zero placeholder. */
function isNullSha(sha: string): boolean {
  return /^0+$/.test(sha)
}

/** RawEntry is one parsed `git diff --raw` record before line counts are joined in. */
type RawEntry = Omit<ChangedFile, 'additions' | 'deletions' | 'binary'>

/** NumStat is the per-path line counts joined onto a raw entry. */
interface NumStat {
  additions: number
  deletions: number
  binary: boolean
}

export const __test = { parseRawDiff, parseNumstat, toFileStatus }
