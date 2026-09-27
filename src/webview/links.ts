import type { ColumnRange } from '../core/protocol.js'

/** wordPattern is an identifier as most languages spell one. */
const wordPattern = /[\p{L}\p{N}_$]+/gu

/** wordAt is the identifier covering a column, or null when the column sits between words. */
export function wordAt(text: string, column: number): ColumnRange | null {
  for (const match of text.matchAll(wordPattern)) {
    const start = match.index
    const end = start + match[0].length
    if (column >= start && column < end) {
      return /^\p{N}/u.test(match[0]) ? null : { start, end }
    }
  }
  return null
}

/** isLinkModifier reports whether the key that turns a hover into a link is held: ⌘ on a Mac, Ctrl elsewhere. */
export function isLinkModifier(event: { metaKey: boolean; ctrlKey: boolean }, mac = onMac()): boolean {
  return mac ? event.metaKey : event.ctrlKey
}

/** isLinkModifierKey reports whether a key event is the link modifier itself going down or up. */
export function isLinkModifierKey(key: string, mac = onMac()): boolean {
  return key === (mac ? 'Meta' : 'Control')
}

/** columnAt is the character of a code cell under a point, or null when the point is past the text. */
export function columnAt(cell: HTMLElement, x: number, y: number): number | null {
  const caret = document.caretRangeFromPoint?.(x, y)
  if (!caret || !cell.contains(caret.startContainer)) {
    return null
  }
  const offset = offsetIn(cell, caret.startContainer, caret.startOffset)
  // the caret lands on the nearer edge of a character, so the one under the point is either side of it
  for (const column of [offset, offset - 1]) {
    const range = rangeIn(cell, { start: column, end: column + 1 })
    if (range && [...range.getClientRects()].some(rect => contains(rect, x, y))) {
      return column
    }
  }
  return null
}

/** rangeIn is a DOM range over columns of a code cell's text. */
export function rangeIn(cell: HTMLElement, columns: ColumnRange): Range | null {
  const start = pointAt(cell, columns.start)
  const end = pointAt(cell, columns.end)
  if (!start || !end || columns.start < 0) {
    return null
  }
  const range = document.createRange()
  range.setStart(start.node, start.offset)
  range.setEnd(end.node, end.offset)
  return range
}

/** offsetIn counts the characters of a cell that come before a point inside it. */
function offsetIn(cell: HTMLElement, node: Node, offset: number): number {
  let count = 0
  const walker = document.createTreeWalker(cell, NodeFilter.SHOW_TEXT)
  for (let text = walker.nextNode(); text; text = walker.nextNode()) {
    if (text === node) {
      return count + offset
    }
    count += text.textContent?.length ?? 0
  }
  return count
}

/** pointAt finds the text node and offset holding one column of a cell. */
function pointAt(cell: HTMLElement, column: number): { node: Node; offset: number } | null {
  let remaining = column
  const walker = document.createTreeWalker(cell, NodeFilter.SHOW_TEXT)
  let last: Node | null = null
  for (let text = walker.nextNode(); text; text = walker.nextNode()) {
    const length = text.textContent?.length ?? 0
    if (remaining < length) {
      return { node: text, offset: remaining }
    }
    remaining -= length
    last = text
  }
  // the column just past the last character closes a range at the end of the line
  return last && remaining === 0 ? { node: last, offset: last.textContent?.length ?? 0 } : null
}

/** contains reports whether a point falls inside a rectangle. */
function contains(rect: DOMRect, x: number, y: number): boolean {
  return x >= rect.left && x < rect.right && y >= rect.top && y < rect.bottom
}

/** onMac reports whether the webview runs on macOS, where links take ⌘ instead of Ctrl. */
function onMac(): boolean {
  return /Mac/i.test(navigator.platform || navigator.userAgent)
}
