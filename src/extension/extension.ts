import * as vscode from 'vscode'
import { Git } from '../core/git.js'
import { ReviewService } from '../core/review.js'
import { installAgentSupport } from './agentSupport.js'
import { ReviewPanel, viewType } from './reviewPanel.js'

/** activate registers the commands and restores any review tabs from the previous session. */
export function activate(context: vscode.ExtensionContext): void {
  const root = context.extensionUri

  context.subscriptions.push(
    vscode.commands.registerCommand('guidedReviews.openReview', () => run(root, openReview)),
    vscode.commands.registerCommand('guidedReviews.deleteReview', () => run(root, deleteReview)),
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

/** deactivate is a no-op; every disposable is registered on the context. */
export function deactivate(): void {}

/** openReview launches straight into the panel; the toolbar, not a quick pick, chooses the commits. */
async function openReview(service: ReviewService, root: vscode.Uri): Promise<void> {
  ReviewPanel.show(service, await service.defaultSelection(), root)
}

/** openFromUri opens the review for the repository a `review` deep link names. */
async function openFromUri(uri: vscode.Uri, root: vscode.Uri): Promise<void> {
  const repo = new URLSearchParams(uri.query).get('repo') ?? ''
  // the link can land in any window running the extension, so prefer the folder it asked for
  const folder = vscode.workspace.workspaceFolders?.find(candidate => repo.startsWith(candidate.uri.fsPath))
  await run(root, openReview, { service: folder ? await serviceFor(folder) : undefined })
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
