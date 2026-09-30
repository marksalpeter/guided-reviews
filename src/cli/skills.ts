import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { SystemExec } from '../core/exec.js'

/** claudeSkillPath is the Claude Code skill that backgrounds `review` and waits. */
export const claudeSkillPath = '.claude/skills/review/SKILL.md'

/** cursorSkillPath is the Cursor skill that runs `review` in the foreground and waits. */
export const cursorSkillPath = '.cursor/skills/review/SKILL.md'

/** installReviewSkills writes both /review skills and hides them from this clone's git status. */
export async function installReviewSkills(repoRoot: string): Promise<void> {
  await writeSkill(repoRoot, claudeSkillPath, claudeSkill)
  await writeSkill(repoRoot, cursorSkillPath, cursorSkill)
  const gitCommonDir = (await new SystemExec(repoRoot).run('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'])).trim()
  await excludeFromGit(gitCommonDir, '.claude/skills/review')
  await excludeFromGit(gitCommonDir, '.cursor/skills/review')
}

/** writeSkill puts one skill document in place. */
async function writeSkill(repoRoot: string, relative: string, body: string): Promise<void> {
  const target = join(repoRoot, relative)
  await mkdir(dirname(target), { recursive: true })
  await writeFile(target, body)
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

const sharedLoop = `When \`review\` exits, read **stdout** for the comments and **stderr** for \`approved: true\` or \`approved: false\`.

If stderr says \`approved: true\`, tell the user no changes were requested and stop.

For each unresolved thread in stdout:

1. Change the code it asks for.
2. Commit.
3. Reply with \`review reply <thread-id> -m "what you changed"\`.
4. Do not resolve the thread. Only the human can.

Then run \`review\` again the same way and wait for the next Submit. Stop when a later Submit is approved.
`

/** claudeSkill backgrounds the wait, because Claude Code can wait on a background task without polling. */
const claudeSkill = `---
name: review
description: Open a guided review in the browser and wait until the human submits comments. Use only when the user explicitly invokes /review. A generic request to review code does not count.
disable-model-invocation: true
allowed-tools: Bash(review:*)
---

# Review

Run this only after the user invokes \`/review\`. Do not infer it from a generic review request.

## Wait for Submit

Run \`review\` in the background with \`run_in_background: true\`.

The process opens the browser and does not exit until the human clicks Submit. Stderr prints the URL as soon as it is listening. Relay it:

> **"Review is open at <url>. Leave comments, then click Submit."**

Do not read the review log. Do not ask the user to type anything. Wait until the background task finishes.

${sharedLoop}
`

/** cursorSkill blocks the foreground, because a background task in Cursor is polled and spams the chat. */
const cursorSkill = `---
name: review
description: Open a guided review in the browser and wait until the human submits comments. Use only when the user explicitly invokes /review. A generic request to review code does not count.
disable-model-invocation: true
---

# Review

Run this only after the user invokes \`/review\`. Do not infer it from a generic review request.

## Wait for Submit

Run \`review\` in the foreground and wait until the process exits. Do not background it.

The process opens the browser and does not exit until the human clicks Submit. Stderr prints the URL as soon as it is listening. Relay it:

> **"Review is open at <url>. Leave comments, then click Submit."**

Do not read the review log. Do not ask the user to type anything. Wait until the command exits.

${sharedLoop}
`
