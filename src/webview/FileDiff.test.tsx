// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import { parseDiff, type FileData } from 'react-diff-view'
import type { AnchorSide, ChangedFile, Thread } from '../core/types.js'
import { FileDiff } from './FileDiff.js'
import { post } from './vscodeApi.js'

vi.mock('./vscodeApi.js', () => ({ post: vi.fn() }))

const source = Array.from({ length: 60 }, (_, i) => `line${i + 1}`)

const patch = [
  'diff --git a/a.txt b/a.txt',
  '--- a/a.txt',
  '+++ b/a.txt',
  '@@ -11,3 +11,3 @@',
  ' line11',
  '-line12',
  '+LINE12',
  ' line13',
  '',
].join('\n')

const meta: ChangedFile = {
  path: 'a.txt',
  status: 'modified',
  oldBlob: 'base',
  newBlob: 'head',
  additions: 1,
  deletions: 1,
  binary: false,
}

/** file is the one parsed file the patch describes. */
const file = parseDiff(patch)[0] as FileData

/** show renders the diff with the base text already in hand. */
function show(withSource = true, threads: Thread[] = []) {
  return render(
    <FileDiff
      file={file}
      meta={meta}
      threads={threads}
      refractor={null}
      source={withSource ? source : undefined}
      reviewed={false}
      collapsed={false}
      forced={false}
      onToggleCollapsed={() => {}}
      onToggleReviewed={() => {}}
    />,
  )
}

/** lineThread pins a one-comment thread to a line on the given side. */
function lineThread(side: AnchorSide, line: number, body: string): Thread {
  return {
    id: `t-${side}-${line}`,
    anchor: { kind: 'line', path: 'a.txt', side, line, blob: side === 'new' ? 'head' : 'base', text: '', contextHash: '' },
    state: 'open',
    comments: [{ id: 'c1', author: 'human', body, at: '2026-01-01T00:00:00Z' }],
    createdAt: '2026-01-01T00:00:00Z',
    status: 'current',
    resolvedLine: line,
  }
}

describe('FileDiff', () => {
  afterEach(() => {
    cleanup()
    vi.mocked(post).mockClear()
  })

  it('asks the host for the base text the diff cannot show on its own', () => {
    show(false)

    expect(post).toHaveBeenCalledWith({ type: 'loadSource', blob: 'base' })
  })

  it('counts the unchanged lines on each side of the hunk', () => {
    show()

    expect(screen.getByText('10 lines unchanged')).toBeTruthy()
    expect(screen.getByText('47 lines unchanged')).toBeTruthy()
  })

  it('shows no expanders until the base text arrives', () => {
    show(false)

    expect(screen.queryByText(/unchanged/)).toBeNull()
  })

  it('reveals the run above the hunk, and takes it back on collapse', () => {
    show()

    fireEvent.click(screen.getByText('10 lines unchanged'))
    expect(screen.getByText('line1')).toBeTruthy()

    fireEvent.click(screen.getByText('Collapse 10 lines'))
    expect(screen.queryByText('line1')).toBeNull()
  })

  it('reveals one step of a longer run from the edge whose arrow was clicked', () => {
    show()

    fireEvent.click(screen.getAllByLabelText('Expand down')[0] as HTMLElement)

    expect(screen.getByText('line33')).toBeTruthy()
    expect(screen.queryByText('line34')).toBeNull()
    expect(screen.getByText('Collapse 20 lines')).toBeTruthy()
    expect(screen.getByText('27 lines unchanged')).toBeTruthy()
  })

  it('offers only the arrow that has a hunk beside it at the ends of the file', () => {
    show()

    expect(screen.getAllByLabelText('Expand up')).toHaveLength(1)
    expect(screen.getAllByLabelText('Expand down')).toHaveLength(1)
  })

  it('attaches a new-side comment only to the added line, not the deleted line of the same number', () => {
    show(true, [lineThread('new', 12, 'note on the addition')])

    expect(screen.getAllByText('note on the addition')).toHaveLength(1)
  })

  it('attaches an old-side comment only to the deleted line, not the added line of the same number', () => {
    show(true, [lineThread('old', 12, 'note on the deletion')])

    expect(screen.getAllByText('note on the deletion')).toHaveLength(1)
  })
})
