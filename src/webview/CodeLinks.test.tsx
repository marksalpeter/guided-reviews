// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import type { Peek, Reference } from '../core/protocol.js'
import { LinkTip, type Tip } from './CodeLinks.js'
import { referenceKey } from './Peek.js'
import { post } from './vscodeApi.js'

vi.mock('./vscodeApi.js', () => ({ post: vi.fn(), browserHost: false }))

const anchor = { left: 10, right: 40, top: 20, bottom: 36, width: 30, height: 16, x: 10, y: 20 } as DOMRect
const quiet = { onEnter: () => {}, onLeave: () => {}, onClose: () => {}, onSelect: () => {} }

function use(path: string, line: number, text: string): Reference {
  const start = text.indexOf('sumOf')
  return {
    location: { uri: `file:///repo/${path}`, line: line - 1, character: 4, endLine: line - 1, endCharacter: 7 },
    path,
    line,
    text,
    match: { start: Math.max(0, start), end: start < 0 ? 0 : start + 'sumOf'.length },
  }
}

function callers(references: Reference[] | null, extra: Partial<Extract<Tip, { kind: 'callers' }>> = {}): Tip {
  return { kind: 'callers', key: 'k', anchor, name: 'sumOf', references, selected: null, preview: undefined, ...extra }
}

describe('LinkTip', () => {
  afterEach(() => {
    cleanup()
    vi.mocked(post).mockClear()
  })

  it('names the symbol and runs the bar while the references load', () => {
    render(<LinkTip tip={callers(null)} {...quiet} />)
    expect(screen.getByText('sumOf')).toBeTruthy()
    expect(screen.getByRole('progressbar')).toBeTruthy()
  })

  it('says so when nothing uses the declaration', () => {
    render(<LinkTip tip={callers([])} {...quiet} />)
    expect(screen.getByText('No references')).toBeTruthy()
  })

  it('counts the callers and groups them under their files', () => {
    const references = [use('a.ts', 3, 'sumOf(xs)'), use('a.ts', 9, 'return sumOf(ys)'), use('b.ts', 1, 'sumOf([])')]
    const { container } = render(<LinkTip tip={callers(references)} {...quiet} />)
    expect(screen.getByText('3 references')).toBeTruthy()
    expect(container.querySelector('.gr-peek-filename')?.textContent).toBe('a.ts')
    const groups = [...container.querySelectorAll('.gr-peek-group')].map(group => [
      group.querySelector('.gr-peek-path')?.textContent,
      group.querySelectorAll('.gr-peek-row').length,
    ])
    expect(groups).toEqual([
      ['a.ts', 2],
      ['b.ts', 1],
    ])
    expect(container.querySelector('.gr-peek-match')?.textContent).toBe('sumOf')
  })

  it('opens a call site when its row is clicked', () => {
    const reference = use('b.ts', 1, 'sumOf([])')
    const onSelect = vi.fn()
    render(<LinkTip tip={callers([reference])} {...quiet} onSelect={onSelect} />)
    fireEvent.click(screen.getByRole('button', { name: /sumOf/ }))
    expect(onSelect).toHaveBeenCalledWith(reference)
    expect(post).toHaveBeenCalledWith({ type: 'openLocation', location: reference.location })
  })

  it('shows the selected call site beside the list', () => {
    const reference = use('b.ts', 1, 'sumOf([])')
    const preview: Peek = { path: 'b.ts', line: 1, match: { start: 0, end: 5 }, startLine: 1, text: 'sumOf([])' }
    const { container } = render(
      <LinkTip tip={callers([reference], { selected: referenceKey(reference), preview })} {...quiet} />,
    )
    expect(container.querySelector('.gr-peek-filename')?.textContent).toBe('b.ts')
    expect(container.querySelector('.gr-peek-meta')?.textContent).toBe('1 reference')
    expect(container.querySelector('.gr-peek-row.selected')).toBeTruthy()
    expect(container.querySelector('.gr-peek-editor .gr-peek-match')?.textContent).toBe('sumOf')
    expect(screen.getByText('1', { selector: '.gr-peek-gutter' })).toBeTruthy()
  })

  it('peeks a definition under its filename', () => {
    const peek: Peek = {
      path: 'src/auth.ts',
      line: 2,
      match: { start: 16, end: 22 },
      startLine: 1,
      text: '/** verify checks a token. */\nexport function verify(token: string): boolean {',
    }
    render(<LinkTip tip={{ kind: 'definition', key: 'k', anchor, peek }} {...quiet} />)
    expect(screen.getByText('auth.ts')).toBeTruthy()
    expect(screen.getByText('src')).toBeTruthy()
    expect(screen.getByText('verify', { selector: '.gr-peek-match' })).toBeTruthy()
  })

  it('shows a note on its own', () => {
    render(<LinkTip tip={{ kind: 'message', key: 'k', anchor, text: 'No definition found' }} {...quiet} />)
    expect(screen.getByText('No definition found')).toBeTruthy()
  })
})
