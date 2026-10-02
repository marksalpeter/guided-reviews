import type { CodeLocation, ColumnRange, Peek } from './protocol.js'

/** contextBefore is how many lines a peek keeps above the match. */
const contextBefore = 3

/** contextAfter is how many lines a peek keeps below the match. */
const contextAfter = 5

/** peekAt is the window of a file around a location, as the editor's peek would frame it. */
export function peekAt(path: string, text: string, location: CodeLocation): Peek | null {
  const lines = text.split(/\r?\n/)
  const line = lines[location.line]
  if (location.line < 0 || line === undefined) {
    return null
  }
  const start = Math.max(0, location.line - contextBefore)
  const end = Math.min(lines.length, location.line + contextAfter + 1)
  const endCharacter = location.endLine === location.line ? location.endCharacter : line.length
  return {
    path,
    line: location.line + 1,
    match: { start: location.character, end: Math.max(location.character, endCharacter) },
    startLine: start + 1,
    text: lines.slice(start, end).join('\n'),
  }
}

/** displayLine drops the indentation a peek row hides, and keeps the match on the text that remains. */
export function displayLine(line: string, start: number, end: number): { text: string; match: ColumnRange } {
  const leading = /^[ \t]*/.exec(line)?.[0].length ?? 0
  const text = line.slice(leading).trimEnd()
  const clamp = (column: number) => Math.max(0, Math.min(column - leading, text.length))
  const matchStart = clamp(start)
  return { text, match: { start: matchStart, end: Math.max(matchStart, clamp(end)) } }
}
