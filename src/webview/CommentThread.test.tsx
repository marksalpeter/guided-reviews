// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import type { Thread } from '../core/types.js'
import { CommentThread, NewCommentBox } from './CommentThread.js'
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

  it('sends the reply on Enter', () => {
    render(<CommentThread thread={thread} />)
    const field = screen.getByRole('textbox')

    fireEvent.change(field, { target: { value: 'looks right' } })
    fireEvent.keyDown(field, { key: 'Enter' })

    expect(post).toHaveBeenCalledWith({ type: 'reply', threadId: 't1', body: 'looks right' })
  })

  it('keeps writing on Shift+Enter', () => {
    render(<CommentThread thread={thread} />)
    const field = screen.getByRole('textbox')

    fireEvent.change(field, { target: { value: 'one' } })
    fireEvent.keyDown(field, { key: 'Enter', shiftKey: true })

    expect(post).not.toHaveBeenCalled()
  })

  it('starts typing when the composer region is clicked', () => {
    const { container } = render(<CommentThread thread={thread} />)

    fireEvent.click(container.querySelector('.gr-composer') as HTMLElement)

    expect(document.activeElement).toBe(screen.getByRole('textbox'))
  })

  it('keeps a sent reply on screen until the host echoes it back', () => {
    const { rerender } = render(<CommentThread thread={thread} />)
    const field = screen.getByRole('textbox')

    fireEvent.change(field, { target: { value: 'still here' } })
    fireEvent.keyDown(field, { key: 'Enter' })

    expect(screen.getByRole('textbox')).toHaveProperty('value', 'still here')

    const echoed = { ...thread, comments: [...thread.comments, { id: 'c3', author: 'human' as const, body: 'still here', at: 'c' }] }
    rerender(<CommentThread thread={echoed} />)

    expect(screen.getByRole('textbox')).toHaveProperty('value', '')
  })

  it('marks the agent comment and leaves the reader own unmarked', () => {
    render(<CommentThread thread={thread} />)

    expect(screen.getAllByTitle('agent')).toHaveLength(1)
    expect(screen.queryByText('agent')).toBeNull()
  })
})

describe('NewCommentBox', () => {
  afterEach(cleanup)

  it('closes from the corner rather than a cancel button', () => {
    const onCancel = vi.fn()
    render(<NewCommentBox onSubmit={vi.fn()} onCancel={onCancel} />)

    screen.getByLabelText('Close').click()

    expect(onCancel).toHaveBeenCalled()
    expect(screen.queryByText('Cancel')).toBeNull()
  })

  it('saves the first comment on Enter', () => {
    const onSubmit = vi.fn()
    render(<NewCommentBox onSubmit={onSubmit} onCancel={vi.fn()} />)
    const field = screen.getByRole('textbox')

    fireEvent.change(field, { target: { value: 'a thought' } })
    fireEvent.keyDown(field, { key: 'Enter' })

    expect(onSubmit).toHaveBeenCalledWith('a thought')
  })
})
