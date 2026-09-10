import { textLinesToHunk, type HunkData } from 'react-diff-view'

/** expandStep is how many lines a peek opens of a run too long to want in one go. */
export const expandStep = 20

/** Expansions maps a run's index to how many of its lines the reader has opened. */
export type Expansions = Record<number, number>

/** Gap is one run of unchanged lines the diff left out, in old-file line numbers. */
export interface Gap {
  /** index is the hunk the run sits above; the run below the last hunk carries the hunk count. */
  index: number
  /** start is the run's first line and end is one past its last. */
  start: number
  end: number
  /** shown is how many of those lines are open. */
  shown: number
  /** grows is the way the borrowed lines extend: down from the hunk above, or up into the one below. */
  grows: 'up' | 'down'
  /** delta is what the run's old line numbers are shifted by on the new side. */
  delta: number
}

/** sourceLines splits a blob into lines, dropping the empty tail a trailing newline leaves behind. */
export function sourceLines(text: string): string[] {
  const lines = text.split('\n')
  return lines[lines.length - 1] === '' ? lines.slice(0, -1) : lines
}

/** gapsOf lists a file's collapsed runs, each carrying how much of it is currently on screen. */
export function gapsOf(hunks: readonly HunkData[], lineCount: number, expansions: Expansions): Gap[] {
  if (hunks.length === 0) {
    return []
  }

  const gaps: Gap[] = []
  for (let index = 0; index <= hunks.length; index++) {
    const above = hunks[index - 1]
    const below = hunks[index]
    const start = above ? above.oldStart + above.oldLines : 1
    const end = below ? below.oldStart : lineCount + 1
    if (end > start) {
      // a run continues the hunk above it; the one at the top of a file has none, so it runs
      // into the hunk below instead
      gaps.push({
        index,
        start,
        end,
        shown: Math.min(expansions[index] ?? 0, end - start),
        grows: above ? 'down' : 'up',
        delta: deltaOf(above, below),
      })
    }
  }
  return gaps
}

/** borrowedHunk is the open part of a run, as a hunk of its own to render beside the patch's. */
export function borrowedHunk(gap: Gap, source: readonly string[]): HunkData | null {
  const from = gap.grows === 'down' ? gap.start : gap.end - gap.shown
  const lines = source.slice(from - 1, from - 1 + gap.shown)
  return lines.length === 0 ? null : textLinesToHunk([...lines], from, from + gap.delta)
}

/** sizeOf is how many lines the run holds in total. */
export function sizeOf(gap: Gap): number {
  return gap.end - gap.start
}

/** hiddenIn is how many of a run's lines are still out of sight. */
export function hiddenIn(gap: Gap): number {
  return sizeOf(gap) - gap.shown
}

/** deltaOf is what the old line numbers around a pair of hunks are shifted by on the new side. */
function deltaOf(above: HunkData | undefined, below: HunkData | undefined): number {
  if (above) {
    return above.newStart + above.newLines - (above.oldStart + above.oldLines)
  }
  return below ? below.newStart - below.oldStart : 0
}
