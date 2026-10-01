// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { applyScheme, effectiveScheme, readScheme, schemeCookie, schemeFromCookie, storeScheme } from './scheme.js'

describe('schemeFromCookie', () => {
  it('reads a saved light or dark choice and ignores anything else', () => {
    expect(schemeFromCookie('')).toBeUndefined()
    expect(schemeFromCookie('gr-scheme=light')).toBe('light')
    expect(schemeFromCookie('other=1; gr-scheme=dark')).toBe('dark')
    expect(schemeFromCookie('gr-scheme=sepia')).toBeUndefined()
  })
})

describe('effectiveScheme', () => {
  it('follows the system until the reader picks', () => {
    expect(effectiveScheme(undefined, true)).toBe('light')
    expect(effectiveScheme(undefined, false)).toBe('dark')
    expect(effectiveScheme('dark', true)).toBe('dark')
  })
})

describe('storeScheme', () => {
  it('paints the choice and keeps it where the next launch can read it', () => {
    storeScheme('light')
    expect(document.body.classList.contains('gr-light')).toBe(true)
    expect(document.body.classList.contains('gr-dark')).toBe(false)
    expect(readScheme()).toBe('light')
    expect(schemeCookie('dark')).toContain('gr-scheme=dark')

    applyScheme('dark')
    expect(document.body.classList.contains('gr-light')).toBe(false)
    expect(document.body.classList.contains('gr-dark')).toBe(true)
  })
})
