import { chmod, lstat, mkdir, readFile, readlink, rm, symlink, writeFile } from 'node:fs/promises'
import { dirname, join, relative } from 'node:path'
import { storeDir } from '../core/git.js'
import { ReviewStore } from '../core/store.js'
import { commentsDir, stubExtension, threadLinkPath } from '../core/threadLinks.js'

/** shimRelativePath is where the agent-facing CLI launcher is written, inside the ignored store. */
export const shimRelativePath = `${storeDir}/bin/review`

/** skillDirRelativePath is the Agent Skills standard directory, read natively by every agent but Claude Code. */
const skillDirRelativePath = '.agents/skills/guided-reviews'

/** skillRelativePath is the skill an agent discovers by filesystem. */
export const skillRelativePath = `${skillDirRelativePath}/SKILL.md`

/** claudeSkillRelativePath is the Claude Code skill directory, linked to the real one. */
export const claudeSkillRelativePath = '.claude/skills/guided-reviews'

/** skillVersion is bumped whenever the skill's contract changes, forcing a rewrite. */
export const skillVersion = 6

/** installAgentSupport writes the shim and skill, and hides the skill from git for this clone only. */
export async function installAgentSupport(options: InstallOptions): Promise<void> {
  // the shim lives inside the store, so the store's self-ignoring .gitignore must exist first
  await new ReviewStore(options.repoRoot).ensureStoreDir()
  await writeShim(options.repoRoot, options.nodePath, options.cliPath, { REVIEW_URI_SCHEME: options.uriScheme })
  await writeSkill(options.repoRoot)
  await excludeFromGit(options.gitCommonDir, skillDirRelativePath)
  await excludeFromGit(options.gitCommonDir, claudeSkillRelativePath)
}

/** writeShim drops an executable launcher that runs the bundled CLI through VS Code's own Node. */
export async function writeShim(repoRoot: string, nodePath: string, cliPath: string, env: Record<string, string> = {}): Promise<string> {
  const target = join(repoRoot, shimRelativePath)
  await mkdir(dirname(target), { recursive: true })
  const exported = Object.entries(env).map(([name, value]) => `${name}=${quote(value)} `).join('')
  // ELECTRON_RUN_AS_NODE lets the editor's bundled binary act as plain node, so PATH need not have one
  const script = ['#!/bin/sh', `${exported}ELECTRON_RUN_AS_NODE=1 exec ${quote(nodePath)} ${quote(cliPath)} "$@"`, ''].join('\n')
  await writeFile(target, script)
  await chmod(target, 0o755)
  return target
}

/** writeSkill installs the instructions that tell an agent the CLI exists and how to use it. */
export async function writeSkill(repoRoot: string): Promise<string> {
  const target = join(repoRoot, skillRelativePath)
  await mkdir(dirname(target), { recursive: true })
  await writeFile(target, skillBody())
  await linkClaudeSkill(repoRoot)
  return target
}

/** excludeFromGit appends a path to this clone's private ignore list, idempotently. */
export async function excludeFromGit(gitCommonDir: string, path: string): Promise<void> {
  const target = join(gitCommonDir, 'info', 'exclude')
  await mkdir(dirname(target), { recursive: true })
  const existing = await readFileOr(target, '')
  if (existing.split('\n').some(line => line.trim() === path)) {
    return
  }
  const separator = existing.length === 0 || existing.endsWith('\n') ? '' : '\n'
  await writeFile(target, `${existing}${separator}${path}\n`)
}

/** linkClaudeSkill points Claude Code's skill directory at the real skill, copying it where symlinks are refused. */
async function linkClaudeSkill(repoRoot: string): Promise<void> {
  const link = join(repoRoot, claudeSkillRelativePath)
  // relative so the link survives the repo being moved or cloned elsewhere
  const target = relative(dirname(claudeSkillRelativePath), skillDirRelativePath)
  if (await linksTo(link, target)) {
    return
  }
  await rm(link, { recursive: true, force: true })
  await mkdir(dirname(link), { recursive: true })
  try {
    await symlink(target, link, 'dir')
  } catch {
    // windows without developer mode refuses symlinks, so leave a real copy behind
    await mkdir(link, { recursive: true })
    await writeFile(join(link, 'SKILL.md'), skillBody())
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

/** skillBody is the skill document written into the workspace. */
function skillBody(): string {
  return `---
name: guided-reviews
version: ${skillVersion}
description: |
  Read and reply to code review comments left by the human in the Guided Reviews
  VS Code extension. Use when the user asks you to address review comments,
  check the guided review, respond to review feedback, or fix what the reviewer
  flagged.
---

# Guided Reviews comments

The human reviews your commits in VS Code and leaves comment threads. Those
threads are **not** in git and **not** greppable — read them through the CLI.

## Reading comments

\`\`\`sh
${shimRelativePath} comments
\`\`\`

Prints every **unresolved** thread of the review the panel has open: file path,
line number, the quoted code, the whole conversation, and a thread id. It prints
the pair that review covers — a branch is not always compared against the
default branch, so do not assume the range.

- \`--unanswered\` limits it to threads you have not replied to since the human
  last spoke. Use this on a second pass.
- \`--json\` emits the same data as JSON.

Resolved threads are never shown. If the command says no review has been
opened, open one yourself:

\`\`\`sh
${shimRelativePath} open
\`\`\`

That opens the review panel on the current branch in the editor, generating the
guide if the branch has none, and is also how you show the human your work.
If the file at \`${shimRelativePath}\` does not exist, the Guided Reviews
extension is not installed — say so rather than guessing.

## Replying

\`\`\`sh
${shimRelativePath} reply <thread-id> -m "handled the null case in abc123"
\`\`\`

Reply after you have made the change, and say what you changed. The human sees
your reply appear live in the review panel. A thread id names its own review, so
a reply lands even when the human is reading a pair other than this branch's.

Commit before you reply. A branch review follows its branch, so your commit is
what the human sees the reply against.

## Linking the human to a comment

Every thread the \`comments\` command prints has a stub file at
\`${commentsDir}/<thread-id>${stubExtension}\`, written for you by that command. Hand it to
the human as a **markdown link** with that repo-relative path:

\`\`\`md
[the null check comment](${threadLinkPath('t_abc')})
\`\`\`

Clicking it opens the review panel and scrolls to that comment. Use it whenever
you name a thread in your answer. The \`vscode://\` deep link the \`comments\`
command also prints is for pasting into a terminal or Quick Open — most chat
windows will not follow it, so prefer the file link.

## What you must not do

**You cannot resolve threads.** Only the human reviewer decides whether their
own comment was addressed. There is no resolve command; do not edit the files
under \`${storeDir}/\` directly to fake one.

## Working loop

1. \`${shimRelativePath} comments\`
2. Fix the code each thread asks for. Read the exact version that was reviewed
   with \`git show <blob>\` when a thread is marked outdated.
3. Commit.
4. \`${shimRelativePath} reply <thread-id> -m "..."\` for each thread you handled.
5. Tell the user what you changed and what you left alone.
`
}

/** readFileOr reads a file, returning a fallback when it does not exist. */
async function readFileOr(path: string, fallback: string): Promise<string> {
  try {
    return await readFile(path, 'utf8')
  } catch {
    return fallback
  }
}

/** quote wraps a path for safe interpolation into the shim's shell script. */
function quote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

/** InstallOptions are the paths needed to wire an agent up to a workspace. */
export interface InstallOptions {
  repoRoot: string
  gitCommonDir: string
  nodePath: string
  cliPath: string
  uriScheme: string
}

export const __test = { skillBody, quote, readFileOr }
