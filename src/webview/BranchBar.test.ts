import { describe, it, expect } from 'vitest'
import { baseTriggerLabel, commitRef, commitTone, forkMarkerIndex, shortSha } from './BranchBar.js'
import type { Timeline, TimelineCommit } from '../core/types.js'

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

describe('commitRef', () => {
  it('reads as head at the tip of the branch', () => {
    expect(commitRef('f00ba12aaaa', forked)).toBe('head')
  })

  it('reads as the parent branch at the fork point', () => {
    expect(commitRef('c31de0bbbbb', forked)).toBe('main')
  })

  it('reads as a short sha anywhere else', () => {
    expect(commitRef('9dd4e5cffff', forked)).toBe('9dd4e5c')
    expect(commitRef('7a1b2c3dddd', forked)).toBe('7a1b2c3')
  })

  it('reads as a short sha at the fork sha of an unforked branch', () => {
    expect(commitRef('9dd4e5cffff', unforked)).toBe('9dd4e5c')
  })
})

describe('baseTriggerLabel', () => {
  it('owns a commit below the fork to the parent branch', () => {
    expect(baseTriggerLabel('7a1b2c3dddd', forked)).toEqual({ owner: 'main', ref: '7a1b2c3' })
  })

  it('drops the owner at the fork point itself', () => {
    expect(baseTriggerLabel('c31de0bbbbb', forked)).toEqual({ owner: '', ref: 'main' })
  })

  it('drops the owner above the fork', () => {
    expect(baseTriggerLabel('9dd4e5cffff', forked)).toEqual({ owner: '', ref: '9dd4e5c' })
    expect(baseTriggerLabel('f00ba12aaaa', forked)).toEqual({ owner: '', ref: 'head' })
  })

  it('drops the owner on an unforked branch', () => {
    expect(baseTriggerLabel('9dd4e5cffff', unforked)).toEqual({ owner: '', ref: '9dd4e5c' })
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

describe('shortSha', () => {
  it('abbreviates to seven characters', () => {
    expect(shortSha('3be4e1a9c31de0f00ba12')).toBe('3be4e1a')
  })
})
