import { chmod, copyFile, lstat, mkdir, readlink, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { basename, dirname, join, relative } from 'node:path'
import { homedir } from 'node:os'

/** reviewSkillDir is the Agent Skills directory. Every harness reads it except Claude Code. */
export const reviewSkillDir = '.agents/skills/review'

/** reviewSkillPath is the skill document those harnesses discover. */
export const reviewSkillPath = `${reviewSkillDir}/SKILL.md`

/** claudeSkillDir is Claude Code's copy. Claude does not read .agents, so this links at the real skill. */
export const claudeSkillDir = '.claude/skills/review'

/** systemBinDir is where the operating system expects a locally installed command. */
export function systemBinDir(platform: string = process.platform, env: NodeJS.ProcessEnv = process.env): string {
  if (platform === 'win32') {
    const local = env.LOCALAPPDATA || join(env.USERPROFILE || homedir(), 'AppData', 'Local')
    return join(local, 'Programs', 'review')
  }
  return '/usr/local/bin'
}

/** installReviewSkills writes /review under the home directory. */
export async function installReviewSkills(homeDir: string): Promise<void> {
  await writeSkill(homeDir)
  await linkClaudeSkill(homeDir)
}

/** BinaryInstall is the result of putting the compiled binary on disk. */
export type BinaryInstall =
  | { status: 'skipped' }
  | { status: 'present'; path: string }
  | { status: 'installed'; path: string; onPath: boolean }

/** installReviewBinary copies a compiled review binary into binDir, unless it is already on PATH. */
export async function installReviewBinary(execPath: string, options: BinaryInstallOptions): Promise<BinaryInstall> {
  const platform = options.platform ?? process.platform
  const env = options.env ?? process.env
  const base = basename(execPath).toLowerCase()
  if (base !== 'review' && base !== 'review.exe') {
    return { status: 'skipped' }
  }
  const resolved = await realpath(execPath).catch(() => execPath)
  const from = dirname(resolved)
  const binRoot = await realpath(options.binDir).catch(() => options.binDir)
  // Homebrew's prefix bin is already on PATH; copying that binary to /usr/local/bin would duplicate it.
  if (from === binRoot || pathIncludes(from, platform, env) || homebrewManaged(execPath) || homebrewManaged(resolved)) {
    return { status: 'present', path: resolved }
  }
  const dest = join(options.binDir, base.endsWith('.exe') ? 'review.exe' : 'review')
  await mkdir(options.binDir, { recursive: true })
  try {
    await copyFile(execPath, dest)
    await chmod(dest, 0o755)
  } catch (error) {
    const code = error instanceof Error && 'code' in error ? String((error as { code?: unknown }).code) : ''
    if (code === 'EACCES' || code === 'EPERM') {
      throw new Error(`cannot write ${dest}\nsudo cp ${quote(execPath)} ${quote(dest)}`)
    }
    throw error
  }
  return { status: 'installed', path: dest, onPath: pathIncludes(options.binDir, platform, env) }
}

/** BinaryInstallOptions choose the destination and how PATH is judged. */
export interface BinaryInstallOptions {
  binDir: string
  platform?: string
  env?: NodeJS.ProcessEnv
}

/** writeSkill puts the one skill document in the home directory. */
async function writeSkill(homeDir: string): Promise<void> {
  const target = join(homeDir, reviewSkillPath)
  await mkdir(dirname(target), { recursive: true })
  await writeFile(target, reviewSkill)
}

/** linkClaudeSkill points Claude Code's skill directory at the real skill, copying it where symlinks are refused. */
async function linkClaudeSkill(homeDir: string): Promise<void> {
  const link = join(homeDir, claudeSkillDir)
  const target = relative(dirname(claudeSkillDir), reviewSkillDir)
  if (await linksTo(link, target)) {
    return
  }
  await rm(link, { recursive: true, force: true })
  await mkdir(dirname(link), { recursive: true })
  try {
    await symlink(target, link, 'dir')
  } catch {
    await mkdir(link, { recursive: true })
    await writeFile(join(link, 'SKILL.md'), reviewSkill)
  }
}

/** linksTo reports whether path is itself a symlink already pointing at target. */
async function linksTo(path: string, target: string): Promise<boolean> {
  try {
    const info = await lstat(path)
    return info.isSymbolicLink() && (await readlink(path)) === target
  } catch {
    return false
  }
}

/** homebrewManaged reports whether Homebrew itself owns this binary. */
function homebrewManaged(filePath: string): boolean {
  return filePath.split(/[\\/]+/).some(part => part === 'Cellar' || part === 'homebrew' || part.includes('linuxbrew'))
}

/** pathIncludes reports whether dir is an entry of PATH. */
function pathIncludes(dir: string, platform: string, env: NodeJS.ProcessEnv): boolean {
  const sep = platform === 'win32' ? ';' : ':'
  const target = strip(dir)
  const path = env.PATH ?? env.Path ?? ''
  return path.split(sep).some(entry => strip(entry) === target)
}

/** strip drops a trailing slash so equivalent directories compare equal. */
function strip(path: string): string {
  return path.replace(/[\\/]+$/, '')
}

/** quote wraps a path for the sudo command printed when the bin directory is not writable. */
function quote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

const reviewSkill = `---
name: review
description: Open a guided review in the browser and wait until the human submits comments. Use only when the user explicitly invokes /review. A generic request to review code does not count.
disable-model-invocation: true
allowed-tools: Bash(review:*)
---

# Review

Run this only after the user invokes \`/review\`. Do not infer it from a generic review request.

## Wait for Submit

Run \`review\` and wait until the human clicks Submit.

- **Claude Code:** run it in the background with \`run_in_background: true\`, then wait for that task. Do not poll.
- **Every other harness:** run it in the foreground and wait until the process exits. Do not background it. A background task in Cursor is polled and spams the chat.

The process opens the browser and does not exit until the human clicks Submit. Stderr prints the URL as soon as it is listening. Relay it:

> **"Review is open at <url>. Leave comments, then click Submit."**

Do not read the review log. Do not ask the user to type anything.

When \`review\` exits, read **stdout** for the comments and **stderr** for \`approved: true\` or \`approved: false\`.

If stderr says \`approved: true\`, tell the user no changes were requested and stop.

For each unresolved thread in stdout:

1. Change the code it asks for.
2. Commit.
3. Reply with \`review reply <thread-id> -m "what you changed"\`.
4. Do not resolve the thread. Only the human can.

Then run \`review\` again the same way and wait for the next Submit. Stop when a later Submit is approved.
`
