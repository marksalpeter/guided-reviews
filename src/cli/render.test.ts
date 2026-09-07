import { describe, it, expect } from 'vitest'
import { noThreadsMessage, renderThreads } from './render.js'
import type { LoadedReview } from '../core/review.js'
import type { Thread } from '../core/types.js'

const review: LoadedReview = {
  state: {
    key: 'feature',
    kind: 'branch',
    branch: 'feature',
    refs: { baseSha: 'abcdef1234', headSha: '1234abcdef', baseLabel: 'main', headLabel: 'feature' },
    threads: [],
    guideStale: false,
    reviewedBlobs: {},
  },
  files: [],
}

const lineThread = (over: Partial<Thread> = {}): Thread => ({
  id: 't_abc',
  anchor: {
    kind: 'line',
    path: 'src/a.ts',
    side: 'new',
    line: 4,
    blob: 'blob1234567',
    text: 'const x = doThing()',
    contextHash: 'c',
  },
  state: 'open',
  comments: [{ id: 'c1', author: 'human', body: 'needs a null check', at: 'a' }],
  createdAt: 'a',
  status: 'current',
  ...over,
})

describe('renderThreads', () => {
  it('says so plainly when there is nothing to act on', () => {
    expect(renderThreads(review, [])).toBe(noThreadsMessage)
  })

  it('renders location, quoted code and the conversation', () => {
    const out = renderThreads(review, [lineThread()])
    expect(out).toContain('src/a.ts:4  [t_abc]')
    expect(out).toContain('> const x = doThing()')
    expect(out).toContain('human: needs a null check')
  })

  it('links each thread to its comment in the panel when given a link builder', () => {
    const out = renderThreads(review, [lineThread()], id => `vscode://ext/review?thread=${id}`)
    expect(out).toContain('src/a.ts:4  [t_abc]  vscode://ext/review?thread=t_abc')
  })

  it('uses the relocated line rather than the original', () => {
    expect(renderThreads(review, [lineThread({ status: 'relocated', resolvedLine: 9 })])).toContain('src/a.ts:9')
  })

  it('flags an outdated anchor so the agent does not trust the line number', () => {
    expect(renderThreads(review, [lineThread({ status: 'outdated' })])).toContain('outdated')
  })

  it('renders a line range when the thread spans one', () => {
    const thread = lineThread()
    const out = renderThreads(review, [{ ...thread, anchor: { ...thread.anchor, kind: 'line', endLine: 7 } as Thread['anchor'] }])
    expect(out).toContain('src/a.ts:4-7')
  })

  it('shows the whole conversation including the agent replies', () => {
    const thread = lineThread({
      comments: [
        { id: 'c1', author: 'human', body: 'needs a null check', at: 'a' },
        { id: 'c2', author: 'agent', body: 'fixed in abc123', at: 'b' },
        { id: 'c3', author: 'human', body: 'still throws', at: 'c' },
      ],
    })
    const out = renderThreads(review, [thread])
    expect(out).toContain('agent: fixed in abc123')
    expect(out).toContain('human: still throws')
  })

  it('renders a group thread with its file set', () => {
    const thread = lineThread({ anchor: { kind: 'group', groupId: 'g0-core', files: ['a.ts', 'b.ts'] } })
    const out = renderThreads(review, [thread])
    expect(out).toContain('group: g0-core')
    expect(out).toContain('files: a.ts, b.ts')
  })

  it('tells the agent how to reply and that it cannot resolve', () => {
    const out = renderThreads(review, [lineThread()])
    expect(out).toContain('review reply <thread-id>')
    expect(out).toContain('only the human reviewer can')
  })

  it('reports the review refs and the thread count', () => {
    const out = renderThreads(review, [lineThread(), lineThread({ id: 't_def' })])
    expect(out).toContain('main (abcdef12) → feature (1234abcd)')
    expect(out).toContain('2 unresolved threads')
  })
})
