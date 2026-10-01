/** detectEditor is the URI scheme of the IDE that launched this process, if it is one. */
export function detectEditor(env: NodeJS.ProcessEnv): string | undefined {
  // the extension shim records the editor's own scheme, which wins over every guess
  const recorded = env.REVIEW_URI_SCHEME?.trim()
  if (recorded && /^[a-z][a-z0-9+.-]*$/i.test(recorded)) {
    return recorded
  }
  // Cursor is a VS Code fork, so it sets the VS Code markers too. Check it first.
  if (isCursor(env)) {
    return 'cursor'
  }
  if (!isVsCode(env)) {
    return undefined
  }
  return isInsiders(env) ? 'vscode-insiders' : 'vscode'
}

/** isCursor reads the markers Cursor adds on top of the VS Code ones. */
function isCursor(env: NodeJS.ProcessEnv): boolean {
  if (env.CURSOR_AGENT || env.CURSOR_TRACE_ID) {
    return true
  }
  return /(?:^|[\\/])Cursor(?:\.app)?(?:[\\/]|$)/.test(editorPaths(env))
}

/** isVsCode reads the markers an integrated terminal or agent shell inherits from the editor. */
function isVsCode(env: NodeJS.ProcessEnv): boolean {
  return env.TERM_PROGRAM === 'vscode' || Boolean(env.VSCODE_IPC_HOOK_CLI) || Boolean(env.VSCODE_GIT_ASKPASS_NODE) || env.VSCODE_INJECTION === '1'
}

/** isInsiders distinguishes VS Code Insiders, whose links use their own scheme. */
function isInsiders(env: NodeJS.ProcessEnv): boolean {
  return /insiders/i.test(editorPaths(env))
}

/** editorPaths is where the editor records its own install location. */
function editorPaths(env: NodeJS.ProcessEnv): string {
  return [env.VSCODE_GIT_ASKPASS_NODE, env.VSCODE_GIT_ASKPASS_MAIN].filter(Boolean).join('\n')
}
