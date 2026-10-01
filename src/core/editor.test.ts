import { describe, expect, it } from 'vitest'
import { detectEditor } from './editor.js'

describe('detectEditor', () => {
  it('is absent outside an editor', () => {
    expect(detectEditor({})).toBeUndefined()
    expect(detectEditor({ CODEX_THREAD_ID: '1' })).toBeUndefined()
  })

  it('uses the scheme the extension recorded', () => {
    expect(detectEditor({ REVIEW_URI_SCHEME: 'cursor', TERM_PROGRAM: 'vscode' })).toBe('cursor')
    expect(detectEditor({ REVIEW_URI_SCHEME: 'not a scheme' })).toBeUndefined()
  })

  it('prefers Cursor when the fork also sets the VS Code markers', () => {
    expect(detectEditor({ CURSOR_AGENT: '1', TERM_PROGRAM: 'vscode' })).toBe('cursor')
    expect(detectEditor({
      TERM_PROGRAM: 'vscode',
      VSCODE_GIT_ASKPASS_NODE: '/Applications/Cursor.app/Contents/Resources/app/extensions/git/dist/askpass-node.js',
    })).toBe('cursor')
  })

  it('names VS Code and Insiders from the terminal markers', () => {
    expect(detectEditor({ TERM_PROGRAM: 'vscode' })).toBe('vscode')
    expect(detectEditor({
      VSCODE_GIT_ASKPASS_NODE: '/usr/share/code-insiders/extensions/git/dist/askpass-node.js',
    })).toBe('vscode-insiders')
  })
})
