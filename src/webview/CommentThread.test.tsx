// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import type { Thread } from '../core/types.js'
import { CommentThread } from './CommentThread.js'
import { post } from './vscodeApi.js'

vi.mock('./vscodeApi.js', () => ({ post: vi.fn() }))

const thread: Thread = {
  id: 't1',
  anchor: { kind: 'line', path: 'a.ts', side: 'new', line: 4, blob: 'blob', text: 'target', contextHash: 'hash' },
  state: 'open',
  comments: [
    { id: 'c1', author: 'human', body: 'fix this', at: 'a' },
    { id: 'c2', author: 'agent', body: 'fixed', at: 'b' },
  ],
  createdAt: 'a',
  status: 'current',
}

describe('CommentThread', () => {
  afterEach(() => {
    cleanup()
    vi.mocked(post).mockClear()
  })

  it('asks the host to delete the comment whose trash icon was clicked', () => {
    render(<CommentThread thread={thread} />)

    screen.getAllByLabelText('Delete comment')[1]?.click()

    expect(post).toHaveBeenCalledWith({ type: 'deleteComment', threadId: 't1', commentId: 'c2' })
  })

  it('offers a delete affordance for every comment', () => {
    render(<CommentThread thread={thread} />)

    expect(screen.getAllByLabelText('Delete comment')).toHaveLength(2)
  })
})
