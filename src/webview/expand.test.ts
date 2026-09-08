import { describe, it, expect } from 'vitest'
import { parseDiff, type HunkData } from 'react-diff-view'
import {
  expandStep,
  gapsOf,
  hiddenIn,
  opened,
  openedAll,
  segmentsOf,
  shownIn,
  sourceLines,
  type Gap,
} from './expand.js'

const source = Array.from({ length: 40 }, (_, i) => `line${i + 1}`)

/** patch is a two-hunk diff of a 40-line file, leaving runs above, between, and below the hunks. */
const patch = [
  'diff --git a/a.txt b/a.txt',
  '--- a/a.txt',
  '+++ b/a.txt',
  '@@ -7,7 +7,7 @@',
  ...context(7, 9),
  '-line10',
  '+LINE10',
  ...context(11, 13),
  '@@ -27,7 +27,7 @@',
  ...context(27, 29),
  '-line30',
  '+LINE30',
  ...context(31, 33),
  '',
].join('\n')

const hunks = parseDiff(patch)[0]?.hunks ?? []

/** context renders an unchanged run of the fixture file as diff context lines. */
function context(from: number, to: number): string[] {
  return source.slice(from - 1, to).map(line => ` ${line}`)
}

/** gapAt picks one gap out of a computed list. */
function gapAt(gaps: Gap[], index: number): Gap {
  const gap = gaps.find(candidate => candidate.index === index)
  if (!gap) {
    throw new Error(`no gap above hunk ${index}`)
  }
  return gap
}

/** contentsOf reads back the lines a rebuilt hunk shows. */
function contentsOf(hunk: HunkData | undefined): string[] {
  return (hunk?.changes ?? []).map(change => change.content)
}

describe('gapsOf', () => {
  it('finds the runs above, between, and below the hunks', () => {
    const gaps = gapsOf(hunks, source.length, {})

    expect(gaps.map(gap => [gap.index, gap.start, gap.end])).toEqual([
      [0, 1, 7],
      [1, 14, 27],
      [2, 34, 41],
    ])
  })

  it('offers only the edge that has a hunk beside it at the ends of the file', () => {
    const gaps = gapsOf(hunks, source.length, {})

    expect(gapAt(gaps, 0).edges).toEqual(['bottom'])
    expect(gapAt(gaps, 1).edges).toEqual(['top', 'bottom'])
    expect(gapAt(gaps, 2).edges).toEqual(['top'])
  })

  it('drops a run the hunks leave no room for', () => {
    const whole = parseDiff(
      ['--- a/a.txt', '+++ b/a.txt', '@@ -1,2 +1,2 @@', '-line1', '+LINE1', ' line2', ''].join('\n'),
    )[0]?.hunks

    expect(gapsOf(whole ?? [], 2, {})).toEqual([])
  })

  it('never opens a gap past its own size', () => {
    const gaps = gapsOf(hunks, source.length, { 0: { top: 5, bottom: 500 } })

    expect(gapAt(gaps, 0)).toMatchObject({ top: 0, bottom: 6 })
    expect(hiddenIn(gapAt(gaps, 0))).toBe(0)
  })

  it('opens a gap far enough to keep a commented line on screen', () => {
    const gaps = gapsOf(hunks, source.length, {}, [16])

    expect(gapAt(gaps, 1)).toMatchObject({ top: 3, bottom: 0 })
  })

  it('leaves a gap shut when the comment inside it is already on screen', () => {
    const gaps = gapsOf(hunks, source.length, { 1: { top: 5, bottom: 0 } }, [16])

    expect(gapAt(gaps, 1)).toMatchObject({ top: 5, bottom: 0 })
  })
})

describe('opened', () => {
  it('reveals one step at a time', () => {
    const wide: Gap = { index: 1, start: 14, end: 200, top: 0, bottom: 0, edges: ['top', 'bottom'] }

    expect(opened(wide, 'top')).toEqual({ top: expandStep, bottom: 0 })
    expect(opened({ ...wide, top: expandStep }, 'bottom')).toEqual({ top: expandStep, bottom: expandStep })
  })

  it('takes the rest of the run when less than a step is left', () => {
    const gap = gapAt(gapsOf(hunks, source.length, {}), 0)

    expect(opened(gap, 'bottom')).toEqual({ top: 0, bottom: 6 })
  })

  it('hangs a whole run from the edge that has a hunk beside it', () => {
    expect(openedAll(gapAt(gapsOf(hunks, source.length, {}), 0))).toEqual({ top: 0, bottom: 6 })
    expect(openedAll(gapAt(gapsOf(hunks, source.length, {}), 2))).toEqual({ top: 7, bottom: 0 })
  })
})

describe('segmentsOf', () => {
  it('leaves the hunks alone while every gap is shut', () => {
    const gaps = gapsOf(hunks, source.length, {})

    expect(segmentsOf(hunks, source, gaps).map(segment => segment.length)).toEqual([1, 1])
    expect(segmentsOf(hunks, source, gaps)[0]?.[0]).toBe(hunks[0])
  })

  it('carries the lines revealed above a hunk into that hunk', () => {
    const gaps = gapsOf(hunks, source.length, { 1: { top: 0, bottom: 3 } })
    const [, second] = segmentsOf(hunks, source, gaps)

    expect(second?.[0]?.oldStart).toBe(24)
    expect(contentsOf(second?.[0]).slice(0, 3)).toEqual(['line24', 'line25', 'line26'])
  })

  it('carries the lines revealed below a hunk into that hunk', () => {
    const gaps = gapsOf(hunks, source.length, { 1: { top: 4, bottom: 0 } })
    const [first] = segmentsOf(hunks, source, gaps)

    expect(first?.[0]?.oldLines).toBe(11)
    expect(contentsOf(first?.[0]).slice(-2)).toEqual(['line16', 'line17'])
  })

  it('renumbers revealed lines on the side the diff shifted', () => {
    const gaps = gapsOf(hunks, source.length, { 2: { top: 7, bottom: 0 } })
    const [, second] = segmentsOf(hunks, source, gaps)
    const last = second?.[0]?.changes.at(-1)

    expect(last).toMatchObject({ content: 'line40', oldLineNumber: 40, newLineNumber: 40 })
  })

  it('joins two hunks into one run when the gap between them is fully revealed', () => {
    const gaps = gapsOf(hunks, source.length, { 1: { top: 13, bottom: 0 } })
    const [first] = segmentsOf(hunks, source, gaps)

    expect(shownIn(gapAt(gaps, 1))).toBe(13)
    expect(contentsOf(first?.[0]).at(-1)).toBe('line26')
  })
})

describe('sourceLines', () => {
  it('drops the empty tail a trailing newline leaves behind', () => {
    expect(sourceLines('a\nb\n')).toEqual(['a', 'b'])
  })

  it('keeps a last line that was never terminated', () => {
    expect(sourceLines('a\nb')).toEqual(['a', 'b'])
  })
})
