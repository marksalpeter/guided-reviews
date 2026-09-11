import * as vscode from 'vscode'
import { randomBytes } from 'node:crypto'
import { ClaudeCli } from '../core/guide.js'
import { stat } from 'node:fs/promises'
import type { HostMessage, ReviewPayload, SelectorState, ViewMessage } from '../core/protocol.js'
import { ReviewService, type Selection } from '../core/review.js'
import { ReviewStore } from '../core/store.js'

/** viewType identifies the panel for VS Code's tab restore. */
export const viewType = 'guidedReviews.review'

/** ReviewPanel hosts one repository's review and keeps it in step with the event log. */
export class ReviewPanel {
  private static open = new Map<string, ReviewPanel>()

  private panel: vscode.WebviewPanel
  private service: ReviewService
  private root: vscode.Uri
  private selection: Selection
  private key = ''
  private disposables: vscode.Disposable[] = []
  private guideBusy = false
  private guideAttempted = false
  private selectorCache: { for: string; state: SelectorState } | undefined
  private lastLogSize = -1
  private focusThread: string | undefined

  private constructor(panel: vscode.WebviewPanel, service: ReviewService, selection: Selection, root: vscode.Uri) {
    this.panel = panel
    this.service = service
    this.selection = selection
    this.root = root

    this.panel.iconPath = tabIcon(root)
    this.panel.webview.options = { enableScripts: true, localResourceRoots: [assetsIn(root)] }
    this.panel.webview.html = this.html()
    this.disposables.push(this.panel.webview.onDidReceiveMessage((m: ViewMessage) => void this.onMessage(m)))
    this.disposables.push(this.watchStore())
    this.panel.onDidDispose(() => this.dispose())
  }

  /** find returns the panel already open for a repository, so a link can raise it before any git work. */
  static find(repoRoot: string): ReviewPanel | undefined {
    return ReviewPanel.open.get(repoRoot)
  }

  /** reveal brings the panel to the foreground. */
  reveal(): void {
    this.panel.reveal()
  }

  /** show opens or focuses this repository's panel on a selection. */
  static show(service: ReviewService, selection: Selection, root: vscode.Uri): ReviewPanel {
    const existing = ReviewPanel.open.get(service.repo.repoRoot)
    if (existing) {
      existing.panel.reveal()
      void existing.retarget(selection)
      return existing
    }
    const panel = vscode.window.createWebviewPanel(viewType, titleFor(selection), vscode.ViewColumn.Active, {
      enableScripts: true,
      retainContextWhenHidden: true,
    })
    return ReviewPanel.adopt(panel, service, selection, root)
  }

  /** adopt attaches a panel VS Code restored on startup to a live selection. */
  static adopt(panel: vscode.WebviewPanel, service: ReviewService, selection: Selection, root: vscode.Uri): ReviewPanel {
    const created = new ReviewPanel(panel, service, selection, root)
    ReviewPanel.open.set(service.repo.repoRoot, created)
    void created.retarget(selection)
    return created
  }

  /** push sends the current selection and, once one exists, the review it resolves to. */
  async push(): Promise<void> {
    try {
      await this.followBranch()
      // read the size first, so an append that lands mid-push still looks new to the watcher
      const size = await this.logSize()
      const selector = await this.selector()
      const { state, files } = await this.service.load(this.key)
      const diff = await this.service.repo.unifiedDiff(state.refs.baseSha, state.refs.headSha)
      const payload: ReviewPayload = {
        review: { state, files, diff },
        selector,
        guideBusy: this.guideBusy,
        ...(this.focusThread ? { focusThread: this.focusThread } : {}),
      }
      // the reveal is a one-shot: a later push must not yank the reader back to that comment
      this.focusThread = undefined
      this.send({ type: 'review', payload })
      this.lastLogSize = size
    } catch (error) {
      this.send({ type: 'error', message: messageOf(error) })
    }
  }

  /** followBranch carries a branch review onto a new commit, which the log itself never records. */
  private async followBranch(): Promise<void> {
    if (this.key !== ReviewStore.keyForBranch(this.selection.branch)) {
      // a pair picked by commit is frozen where the reader put it
      return
    }
    const tip = await this.tipOf(this.selection.branch)
    if (!tip || tip === this.selection.headSha) {
      return
    }
    this.selection = await this.service.selectionAgainst(this.selection.branch, this.selection.baseBranch)
    this.key = await this.service.openSelection(this.selection)
    await this.service.reviews.markCurrent(this.key)
  }

  /** focus reveals one comment, bringing the panel forward so a deep link lands on the thread. */
  async focus(threadId: string): Promise<void> {
    this.focusThread = threadId
    this.panel.reveal()
    await this.push()
  }

  /** selector reuses the branch list and timeline, rebuilding them only when the selection or the branch moves. */
  private async selector(): Promise<SelectorState> {
    const tip = await this.tipOf(this.selection.branch)
    const { branch, baseBranch, baseSha, headSha } = this.selection
    const key = [branch, baseBranch, baseSha, headSha, tip].join('\u0000')
    if (this.selectorCache?.for === key) {
      return this.selectorCache.state
    }
    const state = await this.service.selector(this.selection)
    this.selectorCache = { for: key, state }
    return state
  }

  /** tipOf is the branch's current commit, the one thing outside the panel that dates the timeline. */
  private async tipOf(branch: string): Promise<string> {
    try {
      return await this.service.repo.revParse(branch)
    } catch {
      return ''
    }
  }

  /** logSize is the length of the review's log, which only ever grows as events are appended. */
  private async logSize(): Promise<number> {
    try {
      return (await stat(this.service.reviews.pathFor(this.key))).size
    } catch {
      return -1
    }
  }

  /** retarget re-points the open panel at another commit pair, replacing what it was showing. */
  private async retarget(selection: Selection): Promise<void> {
    this.selection = selection
    // a different pair is a different event log, so the guide attempt has to be reconsidered
    this.key = await this.service.openSelection(selection)
    // the agent CLI has no other way to tell which of several reviews the human is reading
    await this.service.reviews.markCurrent(this.key)
    this.guideAttempted = false
    this.panel.title = titleFor(selection)
    await this.push()
    await this.autoGenerateGuide()
  }

  /** onMessage applies one webview action and pushes the resulting state back. */
  private async onMessage(message: ViewMessage): Promise<void> {
    try {
      switch (message.type) {
        case 'ready':
          await this.push()
          return await this.autoGenerateGuide()
        case 'selectBaseBranch':
          return await this.retarget(await this.service.selectionAgainst(this.selection.branch, message.branch))
        case 'selectBase':
          return await this.retarget({ ...this.selection, baseSha: message.sha })
        case 'selectTarget':
          return await this.retarget({ ...this.selection, headSha: message.sha })
        case 'startThread':
          await this.service.startThread(this.key, message.path, message.side, message.line, message.body, message.endLine)
          break
        case 'startGroupThread':
          await this.service.startGroupThread(this.key, message.groupId, message.body)
          break
        case 'reply':
          await this.service.reply(this.key, message.threadId, message.body, 'human')
          break
        case 'deleteComment':
          await this.service.deleteComment(this.key, message.threadId, message.commentId)
          break
        case 'resolve':
          await this.service.resolveThread(this.key, message.threadId)
          break
        case 'reopen':
          await this.service.reopenThread(this.key, message.threadId)
          break
        case 'markReviewed':
          await this.service.markReviewed(this.key, message.path, message.blob)
          break
        case 'unmarkReviewed':
          await this.service.unmarkReviewed(this.key, message.path)
          break
        case 'reviewFiles':
          for (const file of message.files) {
            await (message.reviewed
              ? this.service.markReviewed(this.key, file.path, file.blob)
              : this.service.unmarkReviewed(this.key, file.path))
          }
          break
        case 'generateGuide':
          return await this.generateGuide()
        case 'loadSource':
          return await this.sendSource(message.blob)
        case 'openFile':
          return await this.openFile(message.path, message.line)
      }
      await this.push()
    } catch (error) {
      void vscode.window.showErrorMessage(`Guided Reviews: ${messageOf(error)}`)
    }
  }

  /** autoGenerateGuide starts the first guide on its own, so the reader never has to ask for it. */
  private async autoGenerateGuide(): Promise<void> {
    if (!this.key || this.guideAttempted || this.guideBusy) {
      return
    }
    if (!vscode.workspace.getConfiguration('guidedReviews').get('autoGenerateGuide', true)) {
      return
    }
    const { state } = await this.service.load(this.key)
    if (state.guide || state.guideError) {
      return
    }
    this.guideAttempted = true
    await this.generateGuide()
  }

  /** generateGuide runs inference without blocking the diff, which is already on screen. */
  private async generateGuide(): Promise<void> {
    if (this.guideBusy || !this.key) {
      return
    }
    this.guideAttempted = true
    this.guideBusy = true
    await this.push()

    const settings = vscode.workspace.getConfiguration('guidedReviews')
    const runner = new ClaudeCli(settings.get('claudePath', 'claude'), settings.get('model', 'claude-opus-5'))
    const generating = this.key
    try {
      await this.service.generateGuide(generating, runner)
    } catch {
      // the failure is already recorded in the log, and the toolbar renders it with a Retry button
    } finally {
      this.guideBusy = false
      // the reader may have moved to another pair while this ran; only that pair's view is stale
      if (this.key === generating) {
        await this.push()
      }
    }
  }

  /** sendSource hands the webview one blob's text, so the diff can open the lines it left out. */
  private async sendSource(blob: string): Promise<void> {
    try {
      this.send({ type: 'source', blob, text: await this.service.repo.blobText(blob) })
    } catch {
      // a blob that will not read simply leaves that file's unchanged lines shut
    }
  }

  /** openFile reveals a path in a normal editor at the given line. */
  private async openFile(path: string, line: number): Promise<void> {
    const uri = vscode.Uri.joinPath(vscode.Uri.file(this.service.repo.repoRoot), path)
    const editor = await vscode.window.showTextDocument(uri, { preview: true })
    const position = new vscode.Position(Math.max(0, line - 1), 0)
    editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenter)
  }

  /** watchStore reloads the panel whenever the agent or another window appends to the log. */
  private watchStore(): vscode.Disposable {
    // the whole store, not one file: the panel re-points between logs as the reader changes commits
    const pattern = new vscode.RelativePattern(this.service.repo.repoRoot, '.guided-review/*.jsonl')
    const watcher = vscode.workspace.createFileSystemWatcher(pattern)
    // our own appends were already pushed, so only a write we have not folded yet is worth the work
    const reload = debounce(() => void this.pushIfLogGrew(), 120)
    watcher.onDidChange(reload)
    watcher.onDidCreate(reload)
    return watcher
  }

  /** pushIfLogGrew re-reads the review only when someone else appended to its log. */
  private async pushIfLogGrew(): Promise<void> {
    if ((await this.logSize()) === this.lastLogSize) {
      return
    }
    await this.push()
  }

  /** send posts one message to the webview. */
  private send(message: HostMessage): void {
    void this.panel.webview.postMessage(message)
  }

  /** html builds the webview document, locking scripts down to the bundled assets. */
  private html(): string {
    const nonce = randomBytes(16).toString('hex')
    const webview = this.panel.webview
    const assets = assetsIn(this.root)
    const script = webview.asWebviewUri(vscode.Uri.joinPath(assets, 'main.js'))
    const style = webview.asWebviewUri(vscode.Uri.joinPath(assets, 'main.css'))
    const csp = [
      `default-src 'none'`,
      `img-src ${webview.cspSource} data:`,
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `font-src ${webview.cspSource}`,
      `script-src 'nonce-${nonce}'`,
    ].join('; ')

    return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta http-equiv="Content-Security-Policy" content="${csp}" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <link rel="stylesheet" href="${style.toString()}" />
    <title>Guided Reviews</title>
  </head>
  <body>
    <div id="root"></div>
    <script nonce="${nonce}" type="module" src="${script.toString()}"></script>
  </body>
</html>`
  }

  /** dispose tears the panel down and forgets it. */
  private dispose(): void {
    ReviewPanel.open.delete(this.service.repo.repoRoot)
    for (const disposable of this.disposables) {
      disposable.dispose()
    }
    this.disposables = []
  }
}

/** assetsIn locates the built webview bundle inside the extension. */
function assetsIn(root: vscode.Uri): vscode.Uri {
  return vscode.Uri.joinPath(root, 'dist', 'webview')
}

/** tabIcon is the fork glyph the editor tab carries, in a weight for each theme. */
function tabIcon(root: vscode.Uri): { light: vscode.Uri; dark: vscode.Uri } {
  return {
    light: vscode.Uri.joinPath(root, 'media', 'tab-icon-light.svg'),
    dark: vscode.Uri.joinPath(root, 'media', 'tab-icon-dark.svg'),
  }
}

/** titleFor names the tab after the branch under review. */
function titleFor(selection: Selection): string {
  return `Review ${selection.branch}`
}

/** debounce collapses a burst of file-watcher events into one reload. */
function debounce(action: () => void, ms: number): () => void {
  let timer: NodeJS.Timeout | undefined
  return () => {
    if (timer) {
      clearTimeout(timer)
    }
    timer = setTimeout(action, ms)
  }
}

/** messageOf renders any thrown value as a string. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
