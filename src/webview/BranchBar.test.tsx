// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import type { SelectorState } from '../core/protocol.js'
import type { Timeline, TimelineCommit } from '../core/types.js'
import { BranchBar, chipLabel, commitPill, commitTone, forkMarkerIndex, isReachable, shortSha } from './BranchBar.js'

vi.mock('./vscodeApi.js', () => ({ post: vi.fn() }))

const commit = (sha: string, subject: string, afterFork: boolean): TimelineCommit => ({
  sha,
  subject,
  author: 'ada',
  when: '2 hours ago',
  afterFork,
})

const forked: Timeline = {
  branch: 'feat/x',
  forkedFrom: 'main',
  forkSha: 'c31de0bbbbb',
  commits: [
    commit('f00ba12aaaa', 'add the picker', true),
    commit('9dd4e5cffff', 'wire the protocol', true),
    commit('c31de0bbbbb', 'describe files', false),
    commit('7a1b2c3dddd', 'refresh screenshots', false),
  ],
}

const unforked: Timeline = {
  branch: 'main',
  forkedFrom: '',
  forkSha: '',
  commits: [commit('f00ba12aaaa', 'add the picker', false), commit('9dd4e5cffff', 'wire the protocol', false)],
}

const selector: SelectorState = {
  branches: [{ name: 'main', headSha: 'f00ba12aaaa', when: '2 hours ago', ahead: 0, isDefault: true }],
  timeline: forked,
  baseBranch: 'main',
  baseSha: 'c31de0bbbbb',
  headSha: 'f00ba12aaaa',
}

describe('BranchBar', () => {
  afterEach(cleanup)

  it('announces the base chip as the merge base and the branch it forked from', () => {
    render(<BranchBar selector={selector} />)

    expect(screen.getByLabelText('base, the merge base where this branch forked from main')).toBeTruthy()
  })
})

describe('chipLabel', () => {
  it('reads as head at the tip of the branch', () => {
    expect(chipLabel('f00ba12aaaa', forked)).toBe('head')
  })

  it('reads as base at the fork point', () => {
    expect(chipLabel('c31de0bbbbb', forked)).toBe('base')
  })

  it('reads as a short sha anywhere else', () => {
    expect(chipLabel('9dd4e5cffff', forked)).toBe('9dd4e5c')
    expect(chipLabel('7a1b2c3dddd', forked)).toBe('7a1b2c3')
  })

  it('reads as a short sha below the tip of an unforked branch', () => {
    expect(chipLabel('9dd4e5cffff', unforked)).toBe('9dd4e5c')
  })
})

describe('commitPill', () => {
  it('pills the tip commit as head', () => {
    expect(commitPill('f00ba12aaaa', forked)).toBe('head')
  })

  it('pills the merge base as base', () => {
    expect(commitPill('c31de0bbbbb', forked)).toBe('base')
  })

  it('leaves an ordinary commit unpilled', () => {
    expect(commitPill('9dd4e5cffff', forked)).toBe('')
    expect(commitPill('7a1b2c3dddd', forked)).toBe('')
  })

  it('pills nothing but the tip without a fork sha', () => {
    expect(commitPill('f00ba12aaaa', unforked)).toBe('head')
    expect(commitPill('9dd4e5cffff', unforked)).toBe('')
  })

  it('prefers head where the tip is itself the merge base', () => {
    expect(commitPill('f00ba12aaaa', { ...forked, forkSha: 'f00ba12aaaa' })).toBe('head')
  })
})

describe('commitTone', () => {
  it('colours by which side of the fork a commit sits on', () => {
    expect(commitTone(commit('a', 'one', true), forked)).toBe('after')
    expect(commitTone(commit('b', 'two', false), forked)).toBe('before')
  })

  it('leaves every commit uncoloured on an unforked branch', () => {
    expect(commitTone(commit('a', 'one', true), unforked)).toBe('none')
    expect(commitTone(commit('b', 'two', false), unforked)).toBe('none')
  })
})

describe('forkMarkerIndex', () => {
  it('marks the first commit below the fork', () => {
    expect(forkMarkerIndex(forked)).toBe(2)
  })

  it('has no marker on an unforked branch', () => {
    expect(forkMarkerIndex(unforked)).toBe(-1)
  })

  it('has no marker when every commit is after the fork', () => {
    expect(forkMarkerIndex({ ...forked, commits: [commit('a', 'one', true), commit('b', 'two', true)] })).toBe(-1)
  })

  it('has no marker when every commit is before the fork', () => {
    expect(forkMarkerIndex({ ...forked, commits: [commit('a', 'one', false), commit('b', 'two', false)] })).toBe(-1)
  })

  it('has no marker in an empty timeline', () => {
    expect(forkMarkerIndex({ ...forked, commits: [] })).toBe(-1)
  })
})

describe('isReachable', () => {
  it('reaches only rows older than the target when picking the base', () => {
    expect(isReachable(2, 'base', 1)).toBe(true)
    expect(isReachable(3, 'base', 1)).toBe(true)
    expect(isReachable(0, 'base', 1)).toBe(false)
  })

  it('leaves the target row itself out of reach of the base', () => {
    expect(isReachable(1, 'base', 1)).toBe(false)
  })

  it('reaches only rows newer than the base when picking the target', () => {
    expect(isReachable(1, 'target', 2)).toBe(true)
    expect(isReachable(0, 'target', 2)).toBe(true)
    expect(isReachable(3, 'target', 2)).toBe(false)
  })

  it('leaves the base row itself out of reach of the target', () => {
    expect(isReachable(2, 'target', 2)).toBe(false)
  })

  it('reaches every row when the other end is off the timeline', () => {
    expect(isReachable(0, 'base', -1)).toBe(true)
    expect(isReachable(0, 'target', -1)).toBe(true)
  })
})

describe('shortSha', () => {
  it('abbreviates to seven characters', () => {
    expect(shortSha('3be4e1a9c31de0f00ba12')).toBe('3be4e1a')
  })
})
