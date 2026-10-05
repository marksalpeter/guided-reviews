import { describe, it, expect } from 'vitest'
import { testsShut, withPath } from './App.js'

describe('withPath', () => {
  it('opens a reviewed file by forcing it, and shuts it again by collapsing it', () => {
    const collapsed = new Set<string>()
    const forced = new Set<string>()

    const opened = { collapsed: withPath(collapsed, 'a.ts', false), forced: withPath(forced, 'a.ts', true) }
    expect(opened.collapsed.has('a.ts')).toBe(false)
    expect(opened.forced.has('a.ts')).toBe(true)

    const shut = { collapsed: withPath(opened.collapsed, 'a.ts', true), forced: withPath(opened.forced, 'a.ts', false) }
    expect(shut.collapsed.has('a.ts')).toBe(true)
    expect(shut.forced.has('a.ts')).toBe(false)
  })

  it('leaves the set it was given alone', () => {
    const paths = new Set(['a.ts'])

    withPath(paths, 'b.ts', true)

    expect([...paths]).toEqual(['a.ts'])
  })
})

describe('testsShut', () => {
  it('shuts a test until the reader opens it', () => {
    const paths = ['a.ts', 'a.test.ts']

    expect(testsShut(paths, new Set(), new Set()).has('a.test.ts')).toBe(true)
    expect(testsShut(paths, new Set(), new Set(['a.test.ts'])).has('a.test.ts')).toBe(false)
    expect(testsShut(paths, new Set(), new Set()).has('a.ts')).toBe(false)
  })
})
