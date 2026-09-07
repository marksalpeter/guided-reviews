import { describe, it, expect } from 'vitest'
import { extensionId, openCommand, reviewUri } from './uri.js'

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

  it('opens through the platform handler', () => {
    expect(openCommand('darwin', 'vscode://x')).toEqual({ command: 'open', args: ['vscode://x'] })
    expect(openCommand('linux', 'vscode://x')).toEqual({ command: 'xdg-open', args: ['vscode://x'] })
    expect(openCommand('win32', 'vscode://x').args).toEqual(['/c', 'start', '', 'vscode://x'])
  })
})
