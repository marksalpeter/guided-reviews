import { lstat, mkdir, readFile, readlink, rm, symlink, writeFile } from 'node:fs/promises'
import { dirname, join, relative } from 'node:path'
import { SystemExec } from '../core/exec.js'

/** reviewSkillDir is the Agent Skills directory. Every harness reads it except Claude Code. */
export const reviewSkillDir = '.agents/skills/review'

/** reviewSkillPath is the skill document those harnesses discover. */
export const reviewSkillPath = `${reviewSkillDir}/SKILL.md`

/** claudeSkillDir is Claude Code's copy. Claude does not read .agents, so this links at the real skill. */
export const claudeSkillDir = '.claude/skills/review'

/** installReviewSkills writes /review once and hides both paths from this clone's git status. */
export async function installReviewSkills(repoRoot: string): Promise<void> {
  await writeSkill(repoRoot)
  await linkClaudeSkill(repoRoot)
  // an older install wrote a separate Cursor skill; Cursor reads .agents, so that copy would disagree
  await rm(join(repoRoot, '.cursor/skills/review'), { recursive: true, force: true })
  const gitCommonDir = (await new SystemExec(repoRoot).run('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'])).trim()
  await excludeFromGit(gitCommonDir, reviewSkillDir)
  await excludeFromGit(gitCommonDir, claudeSkillDir)
}

/** writeSkill puts the one skill document in the standard directory. */
async function writeSkill(repoRoot: string): Promise<void> {
  const target = join(repoRoot, reviewSkillPath)
  await mkdir(dirname(target), { recursive: true })
  await writeFile(target, reviewSkill)
}

/** linkClaudeSkill points Claude Code's skill directory at the real skill, copying it where symlinks are refused. */
async function linkClaudeSkill(repoRoot: string): Promise<void> {
  const link = join(repoRoot, claudeSkillDir)
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

/** excludeFromGit appends a path to this clone's private ignore list, idempotently. */
async function excludeFromGit(gitCommonDir: string, path: string): Promise<void> {
  const target = join(gitCommonDir, 'info', 'exclude')
  await mkdir(dirname(target), { recursive: true })
  const existing = await readFile(target, 'utf8').catch(() => '')
  if (existing.split('\n').some(line => line.trim() === path)) {
    return
  }
  const separator = existing.length === 0 || existing.endsWith('\n') ? '' : '\n'
  await writeFile(target, `${existing}${separator}${path}\n`)
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
