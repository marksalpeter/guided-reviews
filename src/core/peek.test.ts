import { describe, it, expect } from 'vitest'
import type { CodeLocation } from './protocol.js'
import { displayLine, peekAt } from './peek.js'

function location(line: number, character: number, endCharacter: number, endLine = line): CodeLocation {
  return { uri: 'file:///repo/a.ts', line, character, endLine, endCharacter }
}

describe('peekAt', () => {
  const text = ['one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'].join('\n')

  it('frames the match with a few lines on either side', () => {
    expect(peekAt('src/a.ts', text, location(4, 1, 4))).toEqual({
      path: 'src/a.ts',
      line: 5,
      match: { start: 1, end: 4 },
      startLine: 2,
      text: ['two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'].join('\n'),
    })
  })

  it('stops at the ends of a short file', () => {
    expect(peekAt('a.ts', 'only\n', location(0, 0, 4))?.text).toBe('only\n')
    expect(peekAt('a.ts', 'only\n', location(0, 0, 4))?.startLine).toBe(1)
  })

  it('returns nothing for a line the file does not have', () => {
    expect(peekAt('a.ts', 'only\n', location(4, 0, 1))).toBeNull()
  })
})

describe('displayLine', () => {
  it('shifts the match by the indentation it drops', () => {
    expect(displayLine('    return verify(token)', 11, 17)).toEqual({
      text: 'return verify(token)',
      match: { start: 7, end: 13 },
    })
  })

  it('keeps a match that starts at the first visible column', () => {
    expect(displayLine('verify', 0, 6)).toEqual({ text: 'verify', match: { start: 0, end: 6 } })
  })
})
