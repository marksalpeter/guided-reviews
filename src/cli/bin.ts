import { dirname, join } from 'node:path'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { AgentRunner, type AgentCommand, type GuideRunner } from '../core/guide.js'
import { detectEditor } from '../core/editor.js'
import { detectAgentCommand } from '../core/harness.js'
import { Git } from '../core/git.js'
import { SystemExec } from '../core/exec.js'
import { ReviewService } from '../core/review.js'
import { openCommand } from '../core/uri.js'
import { main } from './main.js'
import { startReviewServer } from './server.js'
import { installReviewBinary, installReviewSkills, reviewSkillDir, systemBinDir } from './skills.js'
import type { Writer } from './main.js'

/** usage is printed for `--help`. */
const usage = `review — open a guided review and wait until it is submitted

  review                                 open the branch review and block until Submit
  review <rev>                           open that commit, against its parent
  review <base>..<head>                  open the diff from base to head
  review <base> <head>                   the same range, as two arguments
  review comments [--unanswered] [--json]
  review reply <thread-id> -m <message>
  review install                         install the /review skill and the binary

  --harness claude|codex                 headless command that writes the guide
  --model <name>                         model for that command
  --claude <path>                        claude binary, when the harness is claude
  --codex <path>                         codex binary, when the harness is codex
  --no-open                              do not open a browser
  --port <n>                             listen port (default: an ephemeral port)
`

/** commands are the words that name a subcommand rather than a revision. */
const commands = new Set(['comments', 'reply', 'install', 'open'])

/** binMain is the compiled binary. No arguments wait for Submit; comments and reply stay immediate. */
export async function binMain(
  argv: readonly string[],
  out: Writer = process.stdout,
  err: Writer = process.stderr,
  deps: BinDeps = {},
): Promise<number> {
  try {
    return await dispatch(argv, out, err, deps)
  } catch (error) {
    err.write(`${error instanceof Error ? error.message : String(error)}\n`)
    return 1
  }
}

/** dispatch runs one binary command. */
async function dispatch(argv: readonly string[], out: Writer, err: Writer, deps: BinDeps): Promise<number> {
  const parsed = parseArgs(argv)
  if (parsed.help) {
    out.write(`${usage}\n`)
    return 0
  }
  if (parsed.command === 'comments' || parsed.command === 'reply') {
    return main([parsed.command, ...parsed.rest], out, err)
  }
  if (parsed.command === 'install') {
    const home = deps.homeDir ?? homedir()
    await installReviewSkills(home)
    out.write(`installed /review skill to ${join(home, reviewSkillDir)}\n`)
    const binary = await installReviewBinary(deps.execPath ?? process.execPath, {
      binDir: deps.binDir ?? systemBinDir(deps.platform, deps.env),
      platform: deps.platform,
      env: deps.env,
    })
    if (binary.status === 'installed') {
      out.write(`installed review to ${binary.path}\n`)
      if (!binary.onPath) {
        out.write(`add ${dirname(binary.path)} to PATH\n`)
      }
    } else if (binary.status === 'present') {
      out.write(`review is already installed at ${binary.path}\n`)
    } else {
      out.write('skipped binary install; run the compiled review binary, or brew install review\n')
    }
    return 0
  }
  if (parsed.command !== undefined && parsed.command !== 'open') {
    err.write(`unknown command: ${parsed.command}\n\n${usage}\n`)
    return 2
  }
  return serve(parsed, out, err, deps)
}

/** serve opens the review, generates the guide, and blocks until Submit. */
async function serve(parsed: ParsedArgs, out: Writer, err: Writer, deps: BinDeps): Promise<number> {
  const root = await repoRoot()
  const git = new Git(root, new SystemExec(root))
  const service = new ReviewService(git)
  const page = await reviewUrl(git, parsed.rest)
  const command = parsed.harness ?? detectAgentCommand(process.env)
  const runner = deps.runner ?? new AgentRunner(command, { bin: binaryFor(command, parsed), model: parsed.model })
  const running = await startReviewServer({
    service,
    runner,
    assetsDir: deps.assetsDir ?? assetDir(),
    ...(parsed.port ? { port: parsed.port } : {}),
  })
  const url = `${running.url}${page}`
  err.write(`Review is open at ${url}. Leave comments, then click Submit.\n`)
  if (!parsed.noOpen && !deps.noOpen) {
    const env = deps.env ?? process.env
    const platform = deps.platform ?? process.platform
    const launch = deps.launch ?? ((command: string, args: readonly string[]) => new SystemExec(root).run(command, args).then(() => undefined))
    await openReview(detectEditor(env), url, platform, launch)
  }
  const result = await running.submitted
  await running.close()
  err.write(`approved: ${result.approved}\n`)
  out.write(`${result.text}\n`)
  return 0
}

/** openReview opens the system browser. An editor has its own browser, which the agent opens, so this stays quiet there. */
async function openReview(
  editor: string | undefined,
  pageUrl: string,
  platform: string,
  launch: (command: string, args: readonly string[]) => Promise<void>,
): Promise<void> {
  // the editor will not run its browser for an outside process, and the system browser is the wrong window
  if (editor) {
    return
  }
  const launched = openCommand(platform, pageUrl)
  await launch(launched.command, launched.args).catch(() => undefined)
}

/** binaryFor is the path override for the preset actually in use. */
function binaryFor(command: AgentCommand, parsed: ParsedArgs): string | undefined {
  if (command === 'codex') {
    return parsed.codex
  }
  return parsed.claude
}

/** assetDir is the built webview, beside the bundled script or in the repo's dist. */
export function assetDir(): string {
  const candidates = [join(__dirname, 'webview'), join(__dirname, '../dist/webview'), join(process.cwd(), 'dist/webview')]
  return candidates.find(dir => existsSync(join(dir, 'index.html'))) ?? candidates[candidates.length - 1] ?? 'dist/webview'
}

/** repoRoot locates the repository containing the working directory. */
async function repoRoot(): Promise<string> {
  const out = await new SystemExec(process.cwd()).run('git', ['rev-parse', '--show-toplevel'])
  return out.trim()
}

/** reviewUrl is the query string that opens one commit pair, or nothing for the branch review. */
async function reviewUrl(git: Git, revs: readonly string[]): Promise<string> {
  const range = await commitRange(git, revs)
  if (!range) {
    return ''
  }
  return `?${new URLSearchParams({ base: range.base, head: range.head })}`
}

/** commitRange resolves a revision, a base..head pair, or two revisions into full shas. */
async function commitRange(git: Git, revs: readonly string[]): Promise<{ base: string; head: string } | undefined> {
  if (revs.length === 0) {
    return undefined
  }
  if (revs.length === 1 && revs[0]?.includes('..')) {
    const [base, head] = splitRange(revs[0] ?? '')
    return { base: await git.revParse(base), head: await git.revParse(head) }
  }
  if (revs.length === 1) {
    const rev = revs[0] ?? ''
    const head = await git.revParse(rev)
    const base = await git.parentOf(rev)
    if (!base) {
      throw new Error(`${rev} has no parent commit`)
    }
    return { base, head }
  }
  if (revs.length === 2) {
    return { base: await git.revParse(revs[0] ?? ''), head: await git.revParse(revs[1] ?? '') }
  }
  throw new Error('usage: review [rev | base..head | base head]')
}

/** splitRange divides base..head, refusing the three-dot form. */
function splitRange(spec: string): [string, string] {
  if (spec.includes('...')) {
    throw new Error(`use base..head, not ${spec}`)
  }
  const dots = spec.indexOf('..')
  const base = spec.slice(0, dots)
  const head = spec.slice(dots + 2)
  if (!base || !head) {
    throw new Error('a range needs both ends: base..head')
  }
  return [base, head]
}

/** parseArgs splits flags from the subcommand. */
function parseArgs(argv: readonly string[]): ParsedArgs {
  const rest: string[] = []
  const parsed: ParsedArgs = { rest, noOpen: false }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? ''
    if (arg === '--help' || arg === '-h') {
      parsed.help = true
    } else if (arg === '--no-open') {
      parsed.noOpen = true
    } else if (arg === '--harness') {
      parsed.harness = argv[++i] === 'codex' ? 'codex' : 'claude'
    } else if (arg === '--model') {
      parsed.model = argv[++i]
    } else if (arg === '--claude') {
      parsed.claude = argv[++i]
    } else if (arg === '--codex') {
      parsed.codex = argv[++i]
    } else if (arg === '--port') {
      parsed.port = Number(argv[++i])
    } else if (!parsed.command && !arg.startsWith('-') && commands.has(arg)) {
      parsed.command = arg
    } else {
      rest.push(arg)
    }
  }
  return parsed
}

/** ParsedArgs is the binary's command line. */
interface ParsedArgs {
  command?: string
  rest: string[]
  help?: boolean
  noOpen: boolean
  harness?: AgentCommand
  model?: string
  claude?: string
  codex?: string
  port?: number
}

/** BinDeps let tests supply a guide runner and skip the browser. */
export interface BinDeps {
  runner?: GuideRunner
  assetsDir?: string
  noOpen?: boolean
  homeDir?: string
  binDir?: string
  execPath?: string
  platform?: string
  env?: NodeJS.ProcessEnv
  launch?: (command: string, args: readonly string[]) => Promise<void>
}

if (require.main === module) {
  void binMain(process.argv.slice(2)).then(code => {
    process.exit(code)
  })
}
