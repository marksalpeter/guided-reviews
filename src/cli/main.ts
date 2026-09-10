import { SystemExec } from '../core/exec.js'
import { unansweredThreads, unresolvedThreads } from '../core/fold.js'
import { Git } from '../core/git.js'
import { ReviewService } from '../core/review.js'
import { ReviewStore } from '../core/store.js'
import { writeThreadLinks } from '../core/threadLinks.js'
import { openCommand, reviewUri } from '../core/uri.js'
import { noThreadsMessage, renderThreads } from './render.js'

/** usage is printed for `--help` and for any unrecognised invocation. */
const usage = `review — read and reply to guided review comments

  review open                               open the review panel for the current branch
  review comments [--unanswered] [--json]   list unresolved threads for the current review
  review reply <thread-id> -m <message>     reply to a thread

Only the human reviewer can resolve a thread.`

/** main parses argv, runs the requested command, and returns a process exit code. */
export async function main(argv: readonly string[], out: Writer = process.stdout, err: Writer = process.stderr): Promise<number> {
  const [command, ...rest] = argv
  try {
    switch (command) {
      case 'open':
        return await runReview(out)
      case 'comments':
        return await runComments(rest, out)
      case 'reply':
        return await runReply(rest, out)
      case '--help':
      case '-h':
      case undefined:
        out.write(`${usage}\n`)
        return 0
      default:
        err.write(`unknown command: ${command}\n\n${usage}\n`)
        return 2
    }
  } catch (error) {
    err.write(`${messageOf(error)}\n`)
    return 1
  }
}

/** runReview asks the editor to open, and advance, the review for the current branch. */
async function runReview(out: Writer): Promise<number> {
  const root = await repoRoot()
  // the shim records the editor's own scheme, so Cursor and Insiders deep-link to themselves
  const uri = reviewUri(process.env.REVIEW_URI_SCHEME ?? 'vscode', root)
  const { command, args } = openCommand(process.platform, uri)
  await new SystemExec(root).run(command, args)
  out.write(`opening the review panel for ${root}\n`)
  return 0
}

/** runComments prints the unresolved threads for the review covering the current HEAD. */
async function runComments(args: readonly string[], out: Writer): Promise<number> {
  const { service, key } = await resolveReview()
  const root = service.repo.repoRoot
  const scheme = process.env.REVIEW_URI_SCHEME ?? 'vscode'
  const review = await service.load(key)
  const threads = args.includes('--unanswered') ? unansweredThreads(review.state) : unresolvedThreads(review.state)

  // the stubs must exist before the links are printed, or a click resolves to nothing
  await writeThreadLinks(root, threads)

  if (args.includes('--json')) {
    const linked = threads.map(thread => ({ ...thread, link: reviewUri(scheme, root, thread.id) }))
    out.write(`${JSON.stringify({ key, refs: review.state.refs, threads: linked }, null, 2)}\n`)
    return 0
  }
  out.write(`${renderThreads(review, threads, id => reviewUri(scheme, root, id))}\n`)
  return 0
}

/** runReply appends an agent reply to one thread. */
async function runReply(args: readonly string[], out: Writer): Promise<number> {
  const threadId = args[0]
  const body = readMessage(args)
  if (!threadId || !body) {
    throw new Error('usage: review reply <thread-id> -m <message>')
  }

  const { service, key } = await resolveReview(threadId)
  const review = await service.load(key)
  if (!review.state.threads.some(thread => thread.id === threadId)) {
    throw new Error(`no thread ${threadId} in any review of this repository`)
  }

  await service.reply(key, threadId, body, 'agent')
  out.write(`replied to ${threadId}\n`)
  return 0
}

/** resolveReview finds the review a command is about: the thread's own, else the one the panel has open. */
async function resolveReview(threadId = ''): Promise<{ service: ReviewService; key: string }> {
  const root = await repoRoot()
  const git = new Git(root)
  const service = new ReviewService(git)
  const store = service.reviews

  // a thread names its review exactly, and a branch can hold several reviews at once
  const byThread = threadId ? await store.findByThread(threadId) : null
  if (byThread) {
    return { service, key: byThread }
  }

  // the panel may be showing a pair the branch's own review knows nothing about
  const open = await store.current()
  if (open) {
    return { service, key: open }
  }

  const branch = await git.currentBranch()
  const byBranch = branch ? ReviewStore.keyForBranch(branch) : ''
  if (byBranch && (await store.read(byBranch)).length > 0) {
    return { service, key: byBranch }
  }

  const byHead = await store.findByHead(await git.revParse('HEAD'))
  if (byHead) {
    return { service, key: byHead }
  }
  throw new Error(`${noThreadsMessage} No review has been opened for this branch — open one in VS Code first.`)
}

/** repoRoot locates the repository containing the working directory. */
async function repoRoot(): Promise<string> {
  const out = await new SystemExec(process.cwd()).run('git', ['rev-parse', '--show-toplevel'])
  return out.trim()
}

/** readMessage pulls the -m/--message value out of argv. */
function readMessage(args: readonly string[]): string {
  const index = args.findIndex(arg => arg === '-m' || arg === '--message')
  return index === -1 ? '' : (args[index + 1] ?? '')
}

/** messageOf renders any thrown value as a string. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Writer is the output seam so tests can capture what the CLI prints. */
export interface Writer {
  write(chunk: string): void
}

if (require.main === module) {
  void main(process.argv.slice(2)).then(code => {
    process.exitCode = code
  })
}
