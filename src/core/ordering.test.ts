import { describe, it, expect } from 'vitest'
import { anchorOf, isTestPath, orderPaths, placeTests } from './ordering.js'
import type { Guide } from './types.js'

const guide = (groups: Guide['groups']): Guide => ({ baseSha: 'b', headSha: 'h', groups, generatedAt: 'a' })

describe('orderPaths', () => {
  it('keeps git order when there is no guide', () => {
    expect(orderPaths(['b.ts', 'a.ts'], undefined)).toEqual(['b.ts', 'a.ts'])
  })

  it('reorders files into the guide reading order', () => {
    const ordered = orderPaths(
      ['glue.ts', 'core.ts', 'fallout.ts'],
      guide([
        { id: 'g1', title: 'Core', summary: '', files: ['core.ts'] },
        { id: 'g2', title: 'Fallout', summary: '', files: ['fallout.ts'] },
        { id: 'g3', title: 'Glue', summary: '', files: ['glue.ts'] },
      ]),
    )
    expect(ordered).toEqual(['core.ts', 'fallout.ts', 'glue.ts'])
  })

  it('puts paths the guide never mentioned after every guided path', () => {
    const ordered = orderPaths(
      ['stray.ts', 'core.ts'],
      guide([{ id: 'g1', title: 'Core', summary: '', files: ['core.ts'] }]),
    )
    expect(ordered).toEqual(['core.ts', 'stray.ts'])
  })

  it('ignores guide paths that are not in the diff', () => {
    const ordered = orderPaths(['a.ts'], guide([{ id: 'g1', title: 'C', summary: '', files: ['ghost.ts', 'a.ts'] }]))
    expect(ordered).toEqual(['a.ts'])
  })

  it('does not lose or duplicate any path', () => {
    const paths = ['a.ts', 'b.ts', 'c.ts', 'd.ts']
    const ordered = orderPaths(
      paths,
      guide([
        { id: 'g1', title: 'One', summary: '', files: ['c.ts'] },
        { id: 'g2', title: 'Two', summary: '', files: ['a.ts'] },
      ]),
    )
    expect(ordered.slice().sort()).toEqual(paths.slice().sort())
    expect(new Set(ordered).size).toBe(paths.length)
  })
})

describe('placeTests', () => {
  it('puts a test directly under the source file it names', () => {
    expect(placeTests(['b.test.ts', 'a.ts', 'b.ts'])).toEqual(['a.ts', 'b.ts', 'b.test.ts'])
  })

  it('puts one test under every source file that shares its name', () => {
    expect(placeTests(['widget.tsx', 'widget.test.tsx', 'widget.ts'])).toEqual(['widget.tsx', 'widget.ts', 'widget.test.tsx'])
  })

  it('matches a test directory and a language suffix without reading the file', () => {
    expect(placeTests(['src/foo.go', 'src/foo_test.go', 'pkg/bar.py', 'tests/test_bar.py'])).toEqual([
      'src/foo.go',
      'src/foo_test.go',
      'pkg/bar.py',
      'tests/test_bar.py',
    ])
  })

  it('leaves a test where it is when more than one source shares its bare name', () => {
    expect(placeTests(['src/a/util.ts', 'src/b/util.ts', 'tests/util.test.ts'])).toEqual([
      'src/a/util.ts',
      'src/b/util.ts',
      'tests/util.test.ts',
    ])
  })

  it('keeps two tests for one file in their original order', () => {
    expect(placeTests(['a.spec.ts', 'a.ts', 'a.test.ts'])).toEqual(['a.ts', 'a.spec.ts', 'a.test.ts'])
  })
})

describe('anchorOf', () => {
  it('names the later source when a test matches two extensions', () => {
    expect(anchorOf('widget.test.tsx', ['widget.tsx', 'widget.test.tsx', 'widget.ts'])).toBe('widget.ts')
  })
})

describe('isTestPath', () => {
  it('recognises a test by its name and not by a source file that merely says test', () => {
    expect(isTestPath('src/__tests__/foo.ts')).toBe(true)
    expect(isTestPath('src/FooTest.java')).toBe(true)
    expect(isTestPath('src/latest.ts')).toBe(false)
    expect(isTestPath('src/testing/helper.ts')).toBe(false)
  })
})
