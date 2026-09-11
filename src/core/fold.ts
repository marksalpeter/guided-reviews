import type { ReviewEvent } from './events.js'
import type { Comment, ReviewState, Thread } from './types.js'

/** emptyRefs is the placeholder used until a review-created event is seen. */
const emptyRefs = { baseSha: '', headSha: '', baseLabel: '', headLabel: '' }

/** foldReview derives the renderable state of a review from its append-only event log. */
export function foldReview(events: readonly ReviewEvent[]): ReviewState {
  const state: ReviewState = {
    key: '',
    kind: 'branch',
    refs: { ...emptyRefs },
    threads: [],
    guideStale: false,
    reviewedBlobs: {},
  }
  const threads = new Map<string, Thread>()

  for (const event of events) {
    applyEvent(state, threads, event)
  }

  state.threads = [...threads.values()]
  state.guideStale = isGuideStale(state)
  return state
}

/** unresolvedThreads is the agent's view: resolved threads are never visible to it. */
export function unresolvedThreads(state: ReviewState): Thread[] {
  return state.threads.filter(thread => thread.state === 'open')
}

/** unansweredThreads narrows to open threads the agent has not replied to since the last human comment. */
export function unansweredThreads(state: ReviewState): Thread[] {
  return unresolvedThreads(state).filter(thread => lastComment(thread)?.author !== 'agent')
}

/** applyEvent mutates the accumulator for one event. */
function applyEvent(state: ReviewState, threads: Map<string, Thread>, event: ReviewEvent): void {
  switch (event.t) {
    case 'review.created':
      state.key = event.key
      state.kind = event.kind
      if (event.branch) {
        state.branch = event.branch
      }
      state.refs = {
        baseSha: event.baseSha,
        headSha: event.headSha,
        baseLabel: event.baseLabel,
        headLabel: event.headLabel,
      }
      return
    case 'review.base_moved':
      state.refs.baseSha = event.baseSha
      state.refs.baseLabel = event.baseLabel
      return
    case 'review.head_moved':
      state.refs.headSha = event.headSha
      state.refs.headLabel = event.headLabel
      return
    case 'thread.opened':
      threads.set(event.id, {
        id: event.id,
        anchor: event.anchor,
        state: 'open',
        comments: [],
        createdAt: event.at,
        status: 'current',
      })
      return
    case 'comment.added': {
      const thread = threads.get(event.threadId)
      thread?.comments.push(toComment(event))
      return
    }
    case 'comment.deleted': {
      const thread = threads.get(event.threadId)
      if (!thread) {
        return
      }
      thread.comments = thread.comments.filter(comment => comment.id !== event.commentId)
      if (thread.comments.length === 0) {
        threads.delete(event.threadId)
      }
      return
    }
    case 'thread.resolved':
      setThreadState(threads, event.threadId, 'resolved')
      return
    case 'thread.reopened':
      setThreadState(threads, event.threadId, 'open')
      return
    case 'guide.generated':
      state.guide = {
        baseSha: event.baseSha,
        headSha: event.headSha,
        groups: event.groups,
        generatedAt: event.at,
      }
      delete state.guideError
      return
    case 'guide.failed':
      state.guideError = event.message
      return
    case 'file.reviewed':
      state.reviewedBlobs[event.path] = event.blob
      return
    case 'file.unreviewed':
      delete state.reviewedBlobs[event.path]
      return
  }
}

/** setThreadState flips a thread's lifecycle, ignoring events for threads that never opened. */
function setThreadState(threads: Map<string, Thread>, id: string, next: Thread['state']): void {
  const thread = threads.get(id)
  if (thread) {
    thread.state = next
  }
}

/** toComment projects a comment event into the domain shape. */
function toComment(event: Extract<ReviewEvent, { t: 'comment.added' }>): Comment {
  return { id: event.id, author: event.author, body: event.body, at: event.at }
}

/** lastComment is the most recent message in a thread. */
function lastComment(thread: Thread): Comment | undefined {
  return thread.comments[thread.comments.length - 1]
}

/** isGuideStale reports whether head has moved past the commit the guide describes. */
function isGuideStale(state: ReviewState): boolean {
  if (state.guide === undefined) {
    return false
  }
  return state.guide.headSha !== state.refs.headSha || state.guide.baseSha !== state.refs.baseSha
}

export const __test = { isGuideStale, lastComment }
