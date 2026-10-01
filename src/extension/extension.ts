import * as vscode from 'vscode'
import { Git } from '../core/git.js'
import { ReviewService } from '../core/review.js'
import { installAgentSupport } from './agentSupport.js'
import { repoRootOfStub, threadIdOf } from '../core/threadLinks.js'
import { ReviewPanel, viewType } from './reviewPanel.js'

/** activate registers the commands and restores any review tabs from the previous session. */
export function activate(context: vscode.ExtensionContext): void {
  const root = context.extensionUri

  context.subscriptions.push(
    vscode.commands.registerCommand('guidedReviews.openReview', () => run(root, openReview)),
    vscode.commands.registerCommand('guidedReviews.deleteReview', () => run(root, deleteReview)),
    // addresses one comment without a deep link, for anything that can invoke a command
    vscode.commands.registerCommand('guidedReviews.focusComment', (threadId: unknown) =>
      run(root, (service, extension) => openReview(service, extension, typeof threadId === 'string' ? threadId : undefined)),
    ),
    vscode.commands.registerCommand('guidedReviews.installAgentSupport', () =>
      run(root, async service => {
        await install(context, service)
        void vscode.window.showInformationMessage('Guided Reviews: Claude Code skill and CLI installed.')
      }),
    ),
    vscode.window.registerUriHandler({
      handleUri: uri => {
        if (uri.path === '/review') {
          void openFromUri(uri, root)
        }
      },
    }),
    vscode.window.registerCustomEditorProvider('guidedReviews.comment', new CommentLinkEditor(root), {
      supportsMultipleEditorsPerDocument: true,
    }),
    // a link clicked from a chat opens a plain text editor, which never reaches the custom editor above;
    // the document event is the earliest notice of it, and the other two are there in case it is missed
    vscode.workspace.onDidOpenTextDocument(document => void revealFromStub(document.uri, root)),
    vscode.window.tabGroups.onDidChangeTabs(event => {
      for (const tab of event.opened) {
        if (tab.input instanceof vscode.TabInputText) {
          void revealFromStub(tab.input.uri, root)
        }
      }
    }),
    vscode.window.onDidChangeActiveTextEditor(editor => {
      if (editor) {
        void revealFromStub(editor.document.uri, root)
      }
    }),
    vscode.window.registerWebviewPanelSerializer(viewType, {
      async deserializeWebviewPanel(panel) {
        const service = await currentService()
        if (service) {
          ReviewPanel.adopt(panel, service, await service.defaultSelection(), root)
        }
      },
    }),
  )

  void run(root, service => install(context, service), { silent: true })
}

/** revealing holds the stubs already being handled, since three events announce the same one open. */
const revealing = new Set<string>()

/** revealFromStub swaps a stub opened as text for the review panel, revealing the comment it stands for. */
async function revealFromStub(stub: vscode.Uri, root: vscode.Uri): Promise<void> {
  const threadId = threadIdOf(stub.fsPath)
  if (!threadId || revealing.has(stub.toString())) {
    return
  }
  revealing.add(stub.toString())
  try {
    // raise the review first, so the stub's tab is never what the reader is looking at
    ReviewPanel.find(repoRootOfStub(stub.fsPath))?.reveal()
    await closeTab(stub)
    await run(root, (service, extension) => openReview(service, extension, threadId))
  } finally {
    revealing.delete(stub.toString())
  }
}

/** closeTab closes one document's tab by identity, never whichever tab happens to be active. */
async function closeTab(uri: vscode.Uri): Promise<void> {
  const tabs = vscode.window.tabGroups.all.flatMap(group => group.tabs)
  const opened = tabs.filter(tab => tab.input instanceof vscode.TabInputText && tab.input.uri.toString() === uri.toString())
  if (opened.length > 0) {
    await vscode.window.tabGroups.close(opened, true)
  }
}

/** CommentLinkEditor turns a comment stub file into a reveal: a file link is the one link a chat will follow. */
class CommentLinkEditor implements vscode.CustomReadonlyEditorProvider {
  private root: vscode.Uri

  constructor(root: vscode.Uri) {
    this.root = root
  }

  openCustomDocument(uri: vscode.Uri): vscode.CustomDocument {
    return { uri, dispose: () => undefined }
  }

  async resolveCustomEditor(document: vscode.CustomDocument, panel: vscode.WebviewPanel): Promise<void> {
    const threadId = threadIdOf(document.uri.fsPath)
    // the stub is a doorway, never a document: close it and put the reader in the review
    panel.webview.html = '<!doctype html><body></body>'
    panel.dispose()
    if (threadId) {
      await run(this.root, (service, root) => openReview(service, root, threadId))
    }
  }
}

/** deactivate is a no-op; every disposable is registered on the context. */
export function deactivate(): void {}

/** openReview launches straight into the panel; the toolbar, not a quick pick, chooses the commits. */
async function openReview(service: ReviewService, root: vscode.Uri, focusThread?: string): Promise<void> {
  const panel = ReviewPanel.show(service, await service.defaultSelection(), root)
  if (focusThread) {
    await panel.focus(focusThread)
  }
}

/** openFromUri opens the review for the repository a `review` deep link names. */
async function openFromUri(uri: vscode.Uri, root: vscode.Uri): Promise<void> {
  const query = new URLSearchParams(uri.query)
  const repo = query.get('repo') ?? ''
  const thread = query.get('thread') ?? ''
  // the link can land in any window running the extension, so prefer the folder it asked for
  const folder = vscode.workspace.workspaceFolders?.find(candidate => repo.startsWith(candidate.uri.fsPath))
  await run(root, (service, extension) => openReview(service, extension, thread || undefined), {
    service: folder ? await serviceFor(folder) : undefined,
  })
}

/** deleteReview removes one review's log after confirmation. */
async function deleteReview(service: ReviewService): Promise<void> {
  const keys = await service.reviews.list()
  if (keys.length === 0) {
    void vscode.window.showInformationMessage('Guided Reviews: no reviews to delete.')
    return
  }
  const key = await vscode.window.showQuickPick(keys, { title: 'Delete which review?' })
  if (key) {
    await service.reviews.delete(key)
    void vscode.window.showInformationMessage(`Guided Reviews: deleted review ${key}.`)
  }
}

/** install writes the agent shim and skill, rewriting them on every activation so they cannot go stale. */
async function install(context: vscode.ExtensionContext, service: ReviewService): Promise<void> {
  await installAgentSupport({
    repoRoot: service.repo.repoRoot,
    gitCommonDir: await service.repo.gitCommonDir(),
    nodePath: process.execPath,
    cliPath: vscode.Uri.joinPath(context.extensionUri, 'dist', 'cli.js').fsPath,
    uriScheme: vscode.env.uriScheme,
  })
}

/** run resolves the workspace repository and hands it to a command, reporting failures once. */
async function run(
  root: vscode.Uri,
  command: (service: ReviewService, root: vscode.Uri) => Promise<void>,
  options: { silent?: boolean; service?: ReviewService } = {},
): Promise<void> {
  try {
    const service = options.service ?? (await currentService())
    if (!service) {
      if (!options.silent) {
        void vscode.window.showErrorMessage('Guided Reviews: open a git repository first.')
      }
      return
    }
    await command(service, root)
  } catch (error) {
    if (!options.silent) {
      void vscode.window.showErrorMessage(`Guided Reviews: ${messageOf(error)}`)
    }
  }
}

/** currentService builds a review service for the workspace folder the user is working in. */
async function currentService(): Promise<ReviewService | undefined> {
  const folder = await currentFolder()
  return folder ? serviceFor(folder) : undefined
}

/** serviceFor builds a review service for one workspace folder, unless it holds no repository. */
async function serviceFor(folder: vscode.WorkspaceFolder): Promise<ReviewService | undefined> {
  const override = vscode.workspace.getConfiguration('guidedReviews').get('defaultBranch', '')
  const git = new Git(folder.uri.fsPath, undefined, override)
  try {
    await git.revParse('HEAD')
  } catch {
    return undefined
  }
  return new ReviewService(git)
}

/** currentFolder picks the active editor's workspace folder, asking when a choice is needed. */
async function currentFolder(): Promise<vscode.WorkspaceFolder | undefined> {
  const folders = vscode.workspace.workspaceFolders ?? []
  if (folders.length <= 1) {
    return folders[0]
  }
  const active = vscode.window.activeTextEditor?.document.uri
  return active ? vscode.workspace.getWorkspaceFolder(active) : vscode.window.showWorkspaceFolderPick()
}

/** messageOf renders any thrown value as a string. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
