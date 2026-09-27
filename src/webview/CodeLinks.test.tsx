// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import type { Reference } from '../core/protocol.js'
import { LinkTip, type Tip } from './CodeLinks.js'
import { post } from './vscodeApi.js'

vi.mock('./vscodeApi.js', () => ({ post: vi.fn() }))

const anchor = { left: 10, right: 40, top: 20, bottom: 36, width: 30, height: 16, x: 10, y: 20 } as DOMRect

function use(path: string, line: number, text: string): Reference {
  return { location: { uri: `file:///repo/${path}`, line: line - 1, character: 4, endLine: line - 1, endCharacter: 7 }, path, line, text }
}

function callers(references: Reference[] | null): Tip {
  return { kind: 'callers', key: 'k', anchor, name: 'sumOf', references }
}

describe('LinkTip', () => {
  afterEach(() => {
    cleanup()
    vi.mocked(post).mockClear()
  })

  it('names the symbol and runs the bar while the references load', () => {
    render(<LinkTip tip={callers(null)} onEnter={() => {}} onLeave={() => {}} />)
    expect(screen.getByText('sumOf')).toBeTruthy()
    expect(screen.getByRole('progressbar')).toBeTruthy()
  })

  it('says so when nothing uses the declaration', () => {
    render(<LinkTip tip={callers([])} onEnter={() => {}} onLeave={() => {}} />)
    expect(screen.getByText('No references')).toBeTruthy()
  })

  it('counts the callers and groups them under their files', () => {
    const references = [use('a.ts', 3, 'sumOf(xs)'), use('a.ts', 9, 'return sumOf(ys)'), use('b.ts', 1, 'sumOf([])')]
    const { container } = render(<LinkTip tip={callers(references)} onEnter={() => {}} onLeave={() => {}} />)
    expect(screen.getByText('3 references')).toBeTruthy()
    const groups = [...container.querySelectorAll('.gr-tip-group')].map(group => [
      group.querySelector('.gr-tip-path')?.textContent,
      group.querySelectorAll('.gr-tip-row').length,
    ])
    expect(groups).toEqual([
      ['a.ts', 2],
      ['b.ts', 1],
    ])
  })

  it('opens a call site when its row is clicked', () => {
    const reference = use('b.ts', 1, 'sumOf([])')
    render(<LinkTip tip={callers([reference])} onEnter={() => {}} onLeave={() => {}} />)
    fireEvent.click(screen.getByText('sumOf([])'))
    expect(post).toHaveBeenCalledWith({ type: 'openLocation', location: reference.location })
  })

  it('shows a note on its own', () => {
    render(<LinkTip tip={{ kind: 'message', key: 'k', anchor, text: 'No definition found' }} onEnter={() => {}} onLeave={() => {}} />)
    expect(screen.getByText('No definition found')).toBeTruthy()
  })
})
