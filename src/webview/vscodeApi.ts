import type { ViewMessage } from '../core/protocol.js'

/** vscode is the host bridge, acquired once because the API may only be taken a single time. */
const vscode = acquire()

/** browserHost is the compiled review binary, which has no editor bridge. */
export const browserHost = vscode === undefined && typeof window !== 'undefined'

/** post sends one message to the extension host, or to the local review server. */
export function post(message: ViewMessage): void {
  if (vscode) {
    vscode.postMessage(message)
    return
  }
  if (typeof fetch === 'undefined') {
    return
  }
  void fetch('/api/message', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(message),
  })
}

connectBrowserHost()

/** connectBrowserHost turns server-sent events into the same window messages the editor posts. */
function connectBrowserHost(): void {
  if (!browserHost || typeof EventSource === 'undefined') {
    return
  }
  const source = new EventSource('/api/events')
  source.onmessage = event => {
    window.dispatchEvent(new MessageEvent('message', { data: JSON.parse(String(event.data)) }))
  }
}

/** saveViewState persists ephemeral view state so a restored tab looks the way it was left. */
export function saveViewState(state: ViewState): void {
  vscode?.setState(state)
}

/** loadViewState restores the view state a previous session saved. */
export function loadViewState(): ViewState {
  return (vscode?.getState() as ViewState | undefined) ?? {}
}

/** acquire takes the VS Code webview API, returning undefined outside the host. */
function acquire(): VsCodeApi | undefined {
  const globalWithApi = globalThis as { acquireVsCodeApi?: () => VsCodeApi }
  return globalWithApi.acquireVsCodeApi?.()
}

/** ViewState is per-viewer scroll and layout state, never domain data. */
export interface ViewState {
  mode?: 'guided' | 'diff'
  scrollTop?: number
  collapsed?: string[]
  openedTests?: string[]
}

/** VsCodeApi is the subset of the webview bridge this view uses. */
interface VsCodeApi {
  postMessage(message: unknown): void
  setState(state: unknown): void
  getState(): unknown
}
