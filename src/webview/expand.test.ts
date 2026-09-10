import { describe, it, expect } from 'vitest'
import { parseDiff } from 'react-diff-view'
import { borrowedHunk, gapsOf, gutterDigits, hiddenIn } from './expand.js'

const source = Array.from({ length: 40 }, (_, i) => `line${i + 1}`)

/** patch is a two-hunk diff of a 40-line file, leaving runs above, between, and below the hunks. */
const patch = [
  'diff --git a/a.txt b/a.txt',
  '--- a/a.txt',
  '+++ b/a.txt',
  '@@ -7,7 +7,8 @@',
  ...context(7, 9),
  '-line10',
  '+LINE10',
  '+LINE10b',
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

describe('gapsOf', () => {
  it('grows the run at the top of a file up into the hunk below, and every other run down', () => {
    expect(gapsOf(hunks, source.length, {}).map(gap => [gap.index, gap.grows])).toEqual([
      [0, 'up'],
      [1, 'down'],
      [2, 'down'],
    ])
  })
})

describe('borrowedHunk', () => {
  it('takes a downward run from the line after the hunk above, on both sides of the diff', () => {
    const [, middle] = gapsOf(hunks, source.length, { 1: 4 })
    const changes = borrowedHunk(middle!, source)?.changes ?? []

    expect(changes).toHaveLength(4)
    expect(changes[0]).toMatchObject({ content: 'line14', oldLineNumber: 14, newLineNumber: 15 })
    expect(changes[3]).toMatchObject({ content: 'line17', oldLineNumber: 17, newLineNumber: 18 })
  })

  it('takes an upward run from the lines that run into the hunk below', () => {
    const [leading] = gapsOf(hunks, source.length, { 0: 3 })

    expect((borrowedHunk(leading!, source)?.changes ?? []).map(change => change.content))
      .toEqual(['line4', 'line5', 'line6'])
  })

  it('is empty while the run is shut', () => {
    const [, middle] = gapsOf(hunks, source.length, {})

    expect(borrowedHunk(middle!, source)).toBeNull()
  })
})

describe('hiddenIn', () => {
  it('never opens a run past its own length', () => {
    const [, middle] = gapsOf(hunks, source.length, { 1: 500 })

    expect(middle!.shown).toBe(13)
    expect(hiddenIn(middle!)).toBe(0)
  })
})

describe('gutterDigits', () => {
  it('counts the digits of the last line, not the last one the patch touches', () => {
    expect(gutterDigits(hunks, source.length)).toBe(2)
    expect(gutterDigits(hunks, 1200)).toBe(4)
  })

  it('counts the new side when the change pushes it past the old one', () => {
    const grown = parseDiff(
      ['diff --git a/a.txt b/a.txt', '--- a/a.txt', '+++ b/a.txt', '@@ -9,1 +9,2 @@', ' line9', '+line10', ''].join('\n'),
    )[0]?.hunks ?? []

    expect(gutterDigits(grown, 9)).toBe(2)
  })

  it('holds a digit open for a file with no hunks at all', () => {
    expect(gutterDigits([], 0)).toBe(1)
  })
})
