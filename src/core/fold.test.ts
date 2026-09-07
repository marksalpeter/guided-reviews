import { describe, it, expect } from 'vitest'
import type { ReviewEvent } from './events.js'
import { foldReview, unansweredThreads, unresolvedThreads } from './fold.js'
import type { LineAnchor } from './types.js'

const anchor = (line: number, blob = 'blob1'): LineAnchor => ({
  kind: 'line',
  path: 'src/a.ts',
  side: 'new',
  line,
  blob,
  text: `line ${line}`,
  contextHash: 'ctx',
})

const created: ReviewEvent = {
  t: 'review.created',
  v: 1,
  key: 'feature',
  kind: 'branch',
  branch: 'feature',
  baseSha: 'base1',
  headSha: 'head1',
  baseLabel: 'main',
  headLabel: 'feature',
  at: '2026-01-01T00:00:00Z',
}

describe('foldReview', () => {
  it('builds review refs from the created event', () => {
    const state = foldReview([created])
    expect(state.key).toBe('feature')
    expect(state.kind).toBe('branch')
    expect(state.refs).toEqual({ baseSha: 'base1', headSha: 'head1', baseLabel: 'main', headLabel: 'feature' })
  })

  it('advances head without changing the pinned base', () => {
    const state = foldReview([created, { t: 'review.head_moved', headSha: 'head2', headLabel: 'feature', at: 'x' }])
    expect(state.refs.headSha).toBe('head2')
    expect(state.refs.baseSha).toBe('base1')
  })

  it('assembles threads with their comments in order', () => {
    const state = foldReview([
      created,
      { t: 'thread.opened', id: 't1', anchor: anchor(10), at: 'a' },
      { t: 'comment.added', id: 'c1', threadId: 't1', author: 'human', body: 'first', at: 'b' },
      { t: 'comment.added', id: 'c2', threadId: 't1', author: 'agent', body: 'second', at: 'c' },
    ])
    expect(state.threads).toHaveLength(1)
    expect(state.threads[0]?.comments.map(c => c.body)).toEqual(['first', 'second'])
    expect(state.threads[0]?.state).toBe('open')
  })

  it('ignores comments for unknown threads', () => {
    const state = foldReview([created, { t: 'comment.added', id: 'c1', threadId: 'ghost', author: 'human', body: 'x', at: 'b' }])
    expect(state.threads).toHaveLength(0)
  })

  it('deletes one comment and drops the thread when its last comment goes', () => {
    const opened: ReviewEvent[] = [
      created,
      { t: 'thread.opened', id: 't1', anchor: anchor(10), at: 'a' },
      { t: 'comment.added', id: 'c1', threadId: 't1', author: 'human', body: 'first', at: 'b' },
      { t: 'comment.added', id: 'c2', threadId: 't1', author: 'agent', body: 'second', at: 'c' },
    ]

    const trimmed = foldReview([...opened, { t: 'comment.deleted', threadId: 't1', commentId: 'c1', at: 'd' }])
    expect(trimmed.threads[0]?.comments.map(c => c.body)).toEqual(['second'])

    const emptied = foldReview([
      ...opened,
      { t: 'comment.deleted', threadId: 't1', commentId: 'c1', at: 'd' },
      { t: 'comment.deleted', threadId: 't1', commentId: 'c2', at: 'e' },
    ])
    expect(emptied.threads).toHaveLength(0)
  })

  it('resolves and reopens a thread', () => {
    const base: ReviewEvent[] = [created, { t: 'thread.opened', id: 't1', anchor: anchor(10), at: 'a' }]
    const resolved = foldReview([...base, { t: 'thread.resolved', threadId: 't1', at: 'b' }])
    expect(resolved.threads[0]?.state).toBe('resolved')

    const reopened = foldReview([
      ...base,
      { t: 'thread.resolved', threadId: 't1', at: 'b' },
      { t: 'thread.reopened', threadId: 't1', at: 'c' },
    ])
    expect(reopened.threads[0]?.state).toBe('open')
  })

  it('keeps history across a resolve and reopen', () => {
    const state = foldReview([
      created,
      { t: 'thread.opened', id: 't1', anchor: anchor(10), at: 'a' },
      { t: 'comment.added', id: 'c1', threadId: 't1', author: 'human', body: 'before', at: 'b' },
      { t: 'thread.resolved', threadId: 't1', at: 'c' },
      { t: 'thread.reopened', threadId: 't1', at: 'd' },
      { t: 'comment.added', id: 'c2', threadId: 't1', author: 'human', body: 'after', at: 'e' },
    ])
    expect(state.threads[0]?.comments.map(c => c.body)).toEqual(['before', 'after'])
  })

  it('attaches a guide and marks it stale when head has moved past it', () => {
    const guide: ReviewEvent = {
      t: 'guide.generated',
      baseSha: 'base1',
      headSha: 'head1',
      groups: [{ id: 'g1', title: 'Core', summary: 's', files: ['src/a.ts'] }],
      at: 'a',
    }
    expect(foldReview([created, guide]).guideStale).toBe(false)

    const moved = foldReview([created, guide, { t: 'review.head_moved', headSha: 'head2', headLabel: 'f', at: 'b' }])
    expect(moved.guideStale).toBe(true)
    expect(moved.guide?.groups).toHaveLength(1)
  })

  it('records the last guide failure and clears it on success', () => {
    const failed = foldReview([created, { t: 'guide.failed', message: 'boom', at: 'a' }])
    expect(failed.guideError).toBe('boom')

    const recovered = foldReview([
      created,
      { t: 'guide.failed', message: 'boom', at: 'a' },
      { t: 'guide.generated', baseSha: 'base1', headSha: 'head1', groups: [], at: 'b' },
    ])
    expect(recovered.guideError).toBeUndefined()
  })
})

describe('selectors', () => {
  const state = foldReview([
    created,
    { t: 'thread.opened', id: 'open-unanswered', anchor: anchor(1), at: 'a' },
    { t: 'comment.added', id: 'c1', threadId: 'open-unanswered', author: 'human', body: 'fix this', at: 'b' },
    { t: 'thread.opened', id: 'open-answered', anchor: anchor(2), at: 'c' },
    { t: 'comment.added', id: 'c2', threadId: 'open-answered', author: 'human', body: 'and this', at: 'd' },
    { t: 'comment.added', id: 'c3', threadId: 'open-answered', author: 'agent', body: 'done', at: 'e' },
    { t: 'thread.opened', id: 'closed', anchor: anchor(3), at: 'f' },
    { t: 'comment.added', id: 'c4', threadId: 'closed', author: 'human', body: 'nit', at: 'g' },
    { t: 'thread.resolved', threadId: 'closed', at: 'h' },
  ])

  it('hides resolved threads from the agent', () => {
    expect(unresolvedThreads(state).map(t => t.id)).toEqual(['open-unanswered', 'open-answered'])
  })

  it('treats a thread as answered only while the agent replied last', () => {
    expect(unansweredThreads(state).map(t => t.id)).toEqual(['open-unanswered'])
  })

  it('re-lists an answered thread once the human speaks again', () => {
    const followUp = foldReview([
      created,
      { t: 'thread.opened', id: 't1', anchor: anchor(1), at: 'a' },
      { t: 'comment.added', id: 'c1', threadId: 't1', author: 'human', body: 'fix', at: 'b' },
      { t: 'comment.added', id: 'c2', threadId: 't1', author: 'agent', body: 'done', at: 'c' },
      { t: 'comment.added', id: 'c3', threadId: 't1', author: 'human', body: 'not quite', at: 'd' },
    ])
    expect(unansweredThreads(followUp).map(t => t.id)).toEqual(['t1'])
  })
})

describe('reviewed files', () => {
  it('records the blob a file was ticked off against', () => {
    const state = foldReview([created, { t: 'file.reviewed', path: 'a.ts', blob: 'blob1', at: 'a' }])
    expect(state.reviewedBlobs).toEqual({ 'a.ts': 'blob1' })
  })

  it('clears a tick when the file is unmarked', () => {
    const state = foldReview([
      created,
      { t: 'file.reviewed', path: 'a.ts', blob: 'blob1', at: 'a' },
      { t: 'file.unreviewed', path: 'a.ts', at: 'b' },
    ])
    expect(state.reviewedBlobs).toEqual({})
  })

  it('keeps the newest blob when a file is re-ticked', () => {
    const state = foldReview([
      created,
      { t: 'file.reviewed', path: 'a.ts', blob: 'blob1', at: 'a' },
      { t: 'file.reviewed', path: 'a.ts', blob: 'blob2', at: 'b' },
    ])
    expect(state.reviewedBlobs['a.ts']).toBe('blob2')
  })

  it('starts with nothing ticked off', () => {
    expect(foldReview([created]).reviewedBlobs).toEqual({})
  })
})
