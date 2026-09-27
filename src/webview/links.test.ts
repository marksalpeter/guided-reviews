// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { isLinkModifier, isLinkModifierKey, rangeIn, wordAt } from './links.js'

describe('wordAt', () => {
  it('finds the identifier a column falls inside', () => {
    expect(wordAt('const total = sumOf(items)', 16)).toEqual({ start: 14, end: 19 })
  })

  it('covers the first and last characters of a word', () => {
    expect(wordAt('foo.bar', 4)).toEqual({ start: 4, end: 7 })
    expect(wordAt('foo.bar', 6)).toEqual({ start: 4, end: 7 })
  })

  it('finds nothing between words', () => {
    expect(wordAt('foo = bar', 4)).toBeNull()
  })

  it('treats a number as no symbol', () => {
    expect(wordAt('retry(3)', 6)).toBeNull()
  })

  it('keeps underscores, dollars and letters beyond ASCII inside one word', () => {
    expect(wordAt('$el._naïve', 5)).toEqual({ start: 4, end: 10 })
  })
})

describe('isLinkModifier', () => {
  it('takes ⌘ on a Mac and Ctrl elsewhere', () => {
    expect(isLinkModifier({ metaKey: true, ctrlKey: false }, true)).toBe(true)
    expect(isLinkModifier({ metaKey: false, ctrlKey: true }, true)).toBe(false)
    expect(isLinkModifier({ metaKey: false, ctrlKey: true }, false)).toBe(true)
    expect(isLinkModifierKey('Meta', true)).toBe(true)
    expect(isLinkModifierKey('Control', false)).toBe(true)
  })
})

describe('rangeIn', () => {
  it('spans columns across the token spans a highlighted line is split into', () => {
    const cell = document.createElement('td')
    cell.innerHTML = '<span>const </span><span>total</span><span> = 1</span>'
    expect(rangeIn(cell, { start: 3, end: 8 })?.toString()).toBe('st to')
  })

  it('closes a range at the very end of the line', () => {
    const cell = document.createElement('td')
    cell.innerHTML = '<span>a</span><span>bc</span>'
    expect(rangeIn(cell, { start: 1, end: 3 })?.toString()).toBe('bc')
  })

  it('refuses columns past the text', () => {
    const cell = document.createElement('td')
    cell.textContent = 'ab'
    expect(rangeIn(cell, { start: 1, end: 5 })).toBeNull()
  })
})
