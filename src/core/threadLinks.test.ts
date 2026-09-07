import { describe, it, expect } from 'vitest'
import { storeDir } from './git.js'
import { repoRootOfStub, threadIdOf, threadLinkPath } from './threadLinks.js'

describe('thread links', () => {
  it('names one stub file per thread inside the ignored store', () => {
    expect(threadLinkPath('t_abc')).toBe(`${storeDir}/comments/t_abc.comment`)
  })

  it('reads the thread id back off a stub path', () => {
    expect(threadIdOf(`/repo/${threadLinkPath('t_abc')}`)).toBe('t_abc')
  })

  it('finds the repository a stub belongs to', () => {
    expect(repoRootOfStub(`/repo/${threadLinkPath('t_abc')}`)).toBe('/repo')
  })

  it('has no repository for a path that is not a stub', () => {
    expect(repoRootOfStub('/repo/src/a.ts')).toBe('')
  })

  it('refuses a path that is not a comment stub', () => {
    expect(threadIdOf('/repo/src/a.ts')).toBe('')
  })

  it('rejects an id that would escape the store', () => {
    expect(() => threadLinkPath('../../etc/passwd')).toThrow()
  })
})
