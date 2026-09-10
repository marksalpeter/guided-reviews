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
  '@@ -31,3 +31,3 @@',
  ' line31',
  '-line32',
  '+LINE32',
  ' line33',
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

    expect(screen.getByText('30 lines unchanged')).toBeTruthy()
    expect(screen.getByText('27 lines unchanged')).toBeTruthy()
  })

  it('shows no expanders until the base text arrives', () => {
    show(false)

    expect(screen.queryByText(/unchanged/)).toBeNull()
  })

  it('opens a whole run when its bar is clicked, and takes it back on collapse', () => {
    show()

    fireEvent.click(screen.getByText('30 lines unchanged'))
    expect(screen.getByText('line1')).toBeTruthy()

    fireEvent.click(screen.getByText('Collapse 30 lines'))
    expect(screen.queryByText('line1')).toBeNull()
  })

  it('keeps a run shut even when a comment sits inside it', () => {
    show(true, [lineThread('old', 12, 'buried')])

    expect(screen.getByText('30 lines unchanged')).toBeTruthy()
  })

  it('counts the comments a shut run is hiding', () => {
    show(true, [lineThread('old', 12, 'buried'), lineThread('old', 14, 'also buried')])

    expect(screen.getByText('2 comments')).toBeTruthy()
  })

  it('lists the threads a shut run is hiding, under its bar', () => {
    show(true, [lineThread('old', 12, 'buried')])

    expect(screen.getByText('buried')).toBeTruthy()
  })

  it('quotes the hidden line a listed thread was left on', () => {
    show(true, [lineThread('old', 12, 'buried')])

    expect(screen.getByText('line 12')).toBeTruthy()
    expect(screen.getByText('line12')).toBeTruthy()
  })

  it('grows a listed thread quote to the lines around it, without opening the run', () => {
    show(true, [lineThread('old', 12, 'buried')])

    fireEvent.click(screen.getByText('show context'))

    expect(screen.getByText('line10')).toBeTruthy()
    expect(screen.getByText('line14')).toBeTruthy()
    expect(screen.getByText('30 lines unchanged')).toBeTruthy()
  })

  it('peeks one step of a run, leaving the rest of it marked', () => {
    show()

    fireEvent.click(screen.getAllByText('Show 20')[1] as HTMLElement)

    expect(screen.getByText('line34')).toBeTruthy()
    expect(screen.getByText('line53')).toBeTruthy()
    expect(screen.queryByText('line54')).toBeNull()
    expect(screen.getByText('Collapse 20 lines')).toBeTruthy()
    expect(screen.getByText('7 lines unchanged')).toBeTruthy()
  })

  it('reads mark, then handle, then lines for the run at the top of a file', () => {
    show()

    fireEvent.click(screen.getAllByText('Show 20')[0] as HTMLElement)
    const read = document.body.textContent ?? ''

    expect(read.indexOf('10 lines unchanged')).toBeLessThan(read.indexOf('Collapse 20 lines'))
    expect(read.indexOf('Collapse 20 lines')).toBeLessThan(read.indexOf('line11'))
  })

  it('reads handle, then lines, then mark for a run below the top of a file', () => {
    show()

    fireEvent.click(screen.getAllByText('Show 20')[1] as HTMLElement)
    const read = document.body.textContent ?? ''

    expect(read.indexOf('Collapse 20 lines')).toBeLessThan(read.indexOf('line34'))
    expect(read.indexOf('line34')).toBeLessThan(read.indexOf('7 lines unchanged'))
  })

  it('attaches a new-side comment only to the added line, not the deleted line of the same number', () => {
    show(true, [lineThread('new', 32, 'note on the addition')])

    expect(screen.getAllByText('note on the addition')).toHaveLength(1)
  })

  it('attaches an old-side comment only to the deleted line, not the added line of the same number', () => {
    show(true, [lineThread('old', 32, 'note on the deletion')])

    expect(screen.getAllByText('note on the deletion')).toHaveLength(1)
  })
})
