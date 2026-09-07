import type { LoadedReview } from '../core/review.js'
import type { Thread } from '../core/types.js'

/** noThreadsMessage is printed when the agent has nothing to act on. */
export const noThreadsMessage = 'No unresolved review comments.'

/** LinkFor builds the deep link that opens one thread in the panel. */
export type LinkFor = (threadId: string) => string

/** renderThreads formats threads as the markdown the agent reads. */
export function renderThreads(review: LoadedReview, threads: readonly Thread[], linkFor?: LinkFor): string {
  if (threads.length === 0) {
    return noThreadsMessage
  }
  const { state } = review
  const header = [
    `# Review ${state.key}`,
    `${state.refs.baseLabel} (${short(state.refs.baseSha)}) → ${state.refs.headLabel} (${short(state.refs.headSha)})`,
    `${threads.length} unresolved ${threads.length === 1 ? 'thread' : 'threads'}`,
  ].join('\n')

  return [header, ...threads.map(thread => renderThread(thread, linkFor)), replyInstructions].join('\n\n')
}

/** renderThread formats one thread with its location, quoted code and conversation. */
function renderThread(thread: Thread, linkFor?: LinkFor): string {
  return [renderHeading(thread, linkFor), renderQuote(thread), renderConversation(thread)].filter(Boolean).join('\n')
}

/** renderHeading identifies where the thread is anchored and whether it still points at live code. */
function renderHeading(thread: Thread, linkFor?: LinkFor): string {
  const link = linkFor ? `  ${linkFor(thread.id)}` : ''
  if (thread.anchor.kind === 'group') {
    return `## group: ${thread.anchor.groupId}  [${thread.id}]${link}\nfiles: ${thread.anchor.files.join(', ') || 'none'}`
  }
  const line = thread.resolvedLine ?? thread.anchor.line
  const range = thread.anchor.endLine ? `${line}-${thread.anchor.endLine}` : `${line}`
  const status = thread.status === 'outdated' ? '  (outdated — the line below has since changed)' : ''
  return `## ${thread.anchor.path}:${range}  [${thread.id}]${link}${status}\nblob ${short(thread.anchor.blob)}`
}

/** renderQuote shows the code the reviewer was looking at. */
function renderQuote(thread: Thread): string {
  return thread.anchor.kind === 'line' && thread.anchor.text ? `\n> ${thread.anchor.text}\n` : ''
}

/** renderConversation lists every message in the thread, oldest first. */
function renderConversation(thread: Thread): string {
  return thread.comments.map(comment => `${comment.author}: ${comment.body}`).join('\n')
}

/** short abbreviates a sha for display. */
function short(sha: string): string {
  return sha ? sha.slice(0, 8) : 'unknown'
}

/** replyInstructions tell the agent the only two things it is allowed to do. */
const replyInstructions = [
  '---',
  'Reply to a thread with: review reply <thread-id> -m "what you changed"',
  'You cannot resolve threads — only the human reviewer can.',
].join('\n')

export const __test = { renderThread, renderHeading, short }
