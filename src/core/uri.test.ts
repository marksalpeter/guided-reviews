import { describe, it, expect } from 'vitest'
import { browserUri, extensionId, openCommand, reviewPageUrl, reviewUri } from './uri.js'

describe('review uri', () => {
  it('addresses the extension under the editor own scheme', () => {
    expect(reviewUri('cursor', '/repo')).toBe(`cursor://${extensionId}/review?repo=%2Frepo`)
  })

  it('targets one thread when the link is for a comment', () => {
    expect(reviewUri('vscode', '/repo', 't_abc')).toBe(`vscode://${extensionId}/review?repo=%2Frepo&thread=t_abc`)
  })

  it('encodes a repository path containing spaces', () => {
    expect(reviewUri('vscode', '/a b/repo')).toContain('repo=%2Fa%20b%2Frepo')
  })

  it('asks the editor to open the review page in its embedded browser', () => {
    expect(browserUri('cursor', 'http://127.0.0.1:9/')).toBe(
      `cursor://${extensionId}/browser?url=${encodeURIComponent('http://127.0.0.1:9/')}`,
    )
  })

  it('accepts only a review page on this machine', () => {
    expect(reviewPageUrl('http://127.0.0.1:4317/')).toBe('http://127.0.0.1:4317/')
    expect(reviewPageUrl('http://localhost:4317/review')).toBe('http://localhost:4317/review')
    expect(reviewPageUrl('https://example.com/')).toBeUndefined()
    expect(reviewPageUrl('file:///etc/passwd')).toBeUndefined()
    expect(reviewPageUrl('not a url')).toBeUndefined()
  })

  it('opens through the platform handler', () => {
    expect(openCommand('darwin', 'vscode://x')).toEqual({ command: 'open', args: ['vscode://x'] })
    expect(openCommand('linux', 'vscode://x')).toEqual({ command: 'xdg-open', args: ['vscode://x'] })
    expect(openCommand('win32', 'vscode://x').args).toEqual(['/c', 'start', '', 'vscode://x'])
  })
})
