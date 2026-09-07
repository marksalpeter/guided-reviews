import { mkdir, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { storeDir } from './git.js'
import type { Thread } from './types.js'

/** commentsDir holds one stub file per thread, so a plain file link can open a comment. */
export const commentsDir = `${storeDir}/comments`

/** stubExtension is the suffix the editor matches to hand a stub to the review panel. */
export const stubExtension = '.comment'

/** threadLinkPath is the repo-relative stub file that stands for one thread. */
export function threadLinkPath(threadId: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(threadId)) {
    throw new Error(`unsafe thread id: ${threadId}`)
  }
  return `${commentsDir}/${threadId}${stubExtension}`
}

/** threadIdOf reads a thread id back off a stub path, or '' when the path is something else. */
export function threadIdOf(path: string): string {
  const name = basename(path)
  if (!name.endsWith(stubExtension) || basename(dirname(path)) !== basename(commentsDir)) {
    return ''
  }
  return name.slice(0, -stubExtension.length)
}

/** repoRootOfStub is the repository a stub file belongs to, or '' when the path is something else. */
export function repoRootOfStub(path: string): string {
  if (!threadIdOf(path)) {
    return ''
  }
  // <repo>/.guided-review/comments/<id>.comment
  return dirname(dirname(dirname(path)))
}

/** writeThreadLinks materialises a stub per thread, so the links printed for an agent resolve. */
export async function writeThreadLinks(repoRoot: string, threads: readonly Thread[]): Promise<void> {
  if (threads.length === 0) {
    return
  }
  await mkdir(join(repoRoot, commentsDir), { recursive: true })
  await Promise.all(
    threads.map(thread => writeFile(join(repoRoot, threadLinkPath(thread.id)), stubBody(thread))),
  )
}

/** stubBody is what a reader sees if the stub is ever opened as plain text. */
function stubBody(thread: Thread): string {
  const where = thread.anchor.kind === 'line' ? `${thread.anchor.path}:${thread.resolvedLine ?? thread.anchor.line}` : thread.anchor.groupId
  return `Guided Reviews comment ${thread.id} on ${where}. Opening this file reveals the comment in the review panel.\n`
}
