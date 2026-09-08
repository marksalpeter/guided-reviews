import { expandFromRawCode, type HunkData } from 'react-diff-view'

/** expandStep is how many lines one arrow reveals before the reader has to ask again. */
export const expandStep = 20

/** Edge is which end of a gap a reveal grows from: the top, next to the hunk above, or the bottom. */
export type Edge = 'top' | 'bottom'

/** Expansion is how many of a gap's lines the reader has opened from each edge. */
export interface Expansion {
  top: number
  bottom: number
}

/** Expansions maps a gap's index to how far it has been opened; a missing entry is shut. */
export type Expansions = Record<number, Expansion>

/** Gap is one run of unchanged lines the diff left out, in old-file line numbers. */
export interface Gap {
  /** index is the hunk the gap sits above; the gap below the last hunk carries the hunk count. */
  index: number
  /** start is the gap's first line and end is one past its last. */
  start: number
  end: number
  /** top and bottom are how many lines stand open at each edge, after clamping and pinning. */
  top: number
  bottom: number
  /** edges are the ends a reveal can grow from — the file's first and last gap have only one. */
  edges: Edge[]
}

/** sourceLines splits a blob into lines, dropping the empty tail a trailing newline leaves behind. */
export function sourceLines(text: string): string[] {
  const lines = text.split('\n')
  return lines[lines.length - 1] === '' ? lines.slice(0, -1) : lines
}

/** gapsOf lists a file's collapsed runs, each carrying how much of it is currently on screen. */
export function gapsOf(
  hunks: readonly HunkData[],
  lineCount: number,
  expansions: Expansions,
  pinned: readonly number[] = [],
): Gap[] {
  if (hunks.length === 0) {
    return []
  }

  const gaps: Gap[] = []
  for (let index = 0; index <= hunks.length; index++) {
    const above = hunks[index - 1]
    const below = hunks[index]
    const start = above ? above.oldStart + above.oldLines : 1
    const end = below ? below.oldStart : lineCount + 1
    if (end <= start) {
      continue
    }
    const edges: Edge[] = [...(above ? (['top'] as const) : []), ...(below ? (['bottom'] as const) : [])]
    const open = clamp(expansions[index], end - start, edges)
    gaps.push(pin({ index, start, end, ...open, edges }, delta(above, below), pinned))
  }
  return gaps
}

/** segmentsOf rebuilds each hunk with the lines its two neighbouring gaps have opened. */
export function segmentsOf(hunks: readonly HunkData[], source: string[], gaps: readonly Gap[]): HunkData[][] {
  return hunks.map((hunk, index) => {
    const above = gaps.find(gap => gap.index === index)?.bottom ?? 0
    const below = gaps.find(gap => gap.index === index + 1)?.top ?? 0
    const end = hunk.oldStart + hunk.oldLines
    let segment = [hunk]
    if (above > 0) {
      segment = expandFromRawCode(segment, source, hunk.oldStart - above, hunk.oldStart)
    }
    if (below > 0) {
      segment = expandFromRawCode(segment, source, end, end + below)
    }
    return segment
  })
}

/** hiddenIn is how many of a gap's lines are still out of sight. */
export function hiddenIn(gap: Gap): number {
  return gap.end - gap.start - gap.top - gap.bottom
}

/** shownIn is how many of a gap's lines a reveal has already brought on screen. */
export function shownIn(gap: Gap): number {
  return gap.top + gap.bottom
}

/** opened is the gap after one more step from an edge, taking the rest when little is left. */
export function opened(gap: Gap, edge: Edge): Expansion {
  const hidden = hiddenIn(gap)
  const step = hidden <= expandStep ? hidden : expandStep
  return edge === 'top' ? { top: gap.top + step, bottom: gap.bottom } : { top: gap.top, bottom: gap.bottom + step }
}

/** openedAll is the gap with every line revealed, hung from whichever edge has a hunk beside it. */
export function openedAll(gap: Gap): Expansion {
  const size = gap.end - gap.start
  return gap.edges[0] === 'top' ? { top: size, bottom: 0 } : { top: 0, bottom: size }
}

/** shut is the expansion of a gap the reader has collapsed again. */
export const shut: Expansion = { top: 0, bottom: 0 }

/** clamp keeps a stored expansion within the gap it belongs to and off the edges it has no hunk for. */
function clamp(expansion: Expansion | undefined, size: number, edges: Edge[]): Expansion {
  const top = edges.includes('top') ? Math.min(expansion?.top ?? 0, size) : 0
  const bottom = edges.includes('bottom') ? Math.min(expansion?.bottom ?? 0, size - top) : 0
  return { top, bottom }
}

/** delta is what a gap's old line numbers are shifted by on the new side. */
function delta(above: HunkData | undefined, below: HunkData | undefined): number {
  if (above) {
    return above.newStart + above.newLines - (above.oldStart + above.oldLines)
  }
  return below ? below.newStart - below.oldStart : 0
}

/** pin opens a gap far enough to keep any commented line inside it on screen. */
function pin(gap: Gap, delta: number, pinned: readonly number[]): Gap {
  let { top, bottom } = gap
  for (const line of pinned) {
    const old = line - delta
    const visible = old < gap.start + top || old >= gap.end - bottom
    if (old < gap.start || old >= gap.end || visible) {
      continue
    }
    const fromTop = old - gap.start + 1
    const fromBottom = gap.end - old
    // reach from whichever edge shows the line for the fewest revealed lines
    if (gap.edges.includes('top') && (fromTop <= fromBottom || !gap.edges.includes('bottom'))) {
      top = fromTop
    } else if (gap.edges.includes('bottom')) {
      bottom = fromBottom
    }
  }
  return { ...gap, ...spread(gap, top, bottom) }
}

/** spread collapses two overlapping reveals into one whole-gap reveal, which is what they amount to. */
function spread(gap: Gap, top: number, bottom: number): Expansion {
  const size = gap.end - gap.start
  if (top + bottom < size) {
    return { top, bottom }
  }
  return openedAll(gap)
}
