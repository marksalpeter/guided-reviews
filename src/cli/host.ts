import { watch, type FSWatcher } from 'node:fs'
import { stat } from 'node:fs/promises'
import type { GuideRunner } from '../core/guide.js'
import type { CodeLocation, HostMessage, ReviewPayload, SelectorState, ViewMessage } from '../core/protocol.js'
import { ReviewService, type Selection } from '../core/review.js'
import { ReviewStore } from '../core/store.js'
import { unansweredThreads } from '../core/fold.js'
import { renderThreads } from './render.js'
import { Symbols } from './symbols.js'

/** ReviewHost is the browser-side panel: the same messages the extension handles, plus Submit. */
export class ReviewHost {
  private service: ReviewService
  private runner: GuideRunner
  private selection: Selection | undefined
  private key = ''
  private guideBusy = false
  private guideAttempted = false
  private selectorCache: { for: string; state: SelectorState } | undefined
  private lastLogSize = -1
  private focusThread: string | undefined
  private watcher: FSWatcher | undefined
  private settle: ((result: SubmitResult) => void) | undefined
  private symbols: Symbols
  readonly submitted: Promise<SubmitResult>
  /** send is how a transport delivers one host message to the page. */
  send: (message: HostMessage) => void = () => {}

  constructor(service: ReviewService, runner: GuideRunner, focusThread = '') {
    this.service = service
    this.runner = runner
    this.focusThread = focusThread
    this.symbols = new Symbols(service.repo)
    this.submitted = new Promise(resolve => {
      this.settle = resolve
    })
  }

  /** start opens the branch review and follows the log while the page is up. */
  async start(): Promise<void> {
    this.selection = await this.service.defaultSelection()
    this.key = await this.service.openSelection(this.selection)
    await this.service.reviews.markCurrent(this.key)
    this.watch()
  }

  /** handle applies one page action. Submit ends the wait. */
  async handle(message: ViewMessage): Promise<void> {
    if (message.type === 'submit') {
      await this.finish()
      return
    }
    try {
      switch (message.type) {
        case 'ready':
          await this.push()
          await this.autoGenerateGuide()
          return
        case 'selectBaseBranch':
          return await this.retarget(await this.service.selectionAgainst(this.branch(), message.branch))
        case 'selectBase':
          return await this.retarget({ ...this.requireSelection(), baseSha: message.sha })
        case 'selectTarget':
          return await this.retarget({ ...this.requireSelection(), headSha: message.sha })
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
          await this.generateGuide()
          return
        case 'loadSource':
          await this.sendSource(message.blob)
          return
        case 'lookup':
          await this.answerLookup(message.id, message.path, message.line, message.character)
          return
        case 'references':
          await this.answerReferences(message.id, message.path, message.line, message.character)
          return
        case 'peek':
          await this.answerPeek(message.id, message.location)
          return
        case 'openFile':
        case 'openLocation':
          return
      }
      await this.push()
    } catch (error) {
      this.send({ type: 'error', message: messageOf(error) })
    }
  }

  /** close stops following the log and drops the language service. */
  close(): void {
    this.watcher?.close()
    this.watcher = undefined
    this.symbols.close()
  }

  /** finish prints nothing itself; it resolves the wait with the unanswered threads. */
  private async finish(): Promise<void> {
    if (!this.settle) {
      return
    }
    const review = await this.service.load(this.key)
    const threads = unansweredThreads(review.state)
    const result: SubmitResult = {
      approved: threads.length === 0,
      text: threads.length === 0 ? 'Review approved. No unresolved comments.' : renderThreads(review, threads),
    }
    const settle = this.settle
    this.settle = undefined
    this.close()
    settle(result)
  }

  /** push sends the review the page is reading. */
  private async push(): Promise<void> {
    try {
      await this.followBranch()
      this.symbols.prepare(this.requireSelection().headSha)
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
      this.focusThread = undefined
      this.send({ type: 'review', payload })
      this.lastLogSize = size
    } catch (error) {
      this.send({ type: 'error', message: messageOf(error) })
    }
  }

  /** followBranch carries a branch review onto a new commit, which the log itself never records. */
  private async followBranch(): Promise<void> {
    const selection = this.requireSelection()
    if (this.key !== ReviewStore.keyForBranch(selection.branch)) {
      return
    }
    const tip = await this.tipOf(selection.branch)
    if (!tip || tip === selection.headSha) {
      return
    }
    this.selection = await this.service.selectionAgainst(selection.branch, selection.baseBranch)
    this.key = await this.service.openSelection(this.selection)
    await this.service.reviews.markCurrent(this.key)
  }

  /** retarget re-points the page at another commit pair. */
  private async retarget(selection: Selection): Promise<void> {
    this.selection = selection
    this.key = await this.service.openSelection(selection)
    await this.service.reviews.markCurrent(this.key)
    this.guideAttempted = false
    await this.push()
    await this.autoGenerateGuide()
  }

  /** autoGenerateGuide starts the first guide on its own, so the reader never has to ask for it. */
  private async autoGenerateGuide(): Promise<void> {
    if (!this.key || this.guideAttempted || this.guideBusy) {
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
    const generating = this.key
    try {
      await this.service.generateGuide(generating, this.runner)
    } catch {
      // the failure is already recorded in the log, and the page renders it with a Retry button
    } finally {
      this.guideBusy = false
      if (this.key === generating && this.settle) {
        await this.push()
      }
    }
  }

  /** answerLookup asks the language service where a symbol is defined. Silence counts as nothing. */
  private async answerLookup(id: number, path: string, line: number, character: number): Promise<void> {
    const sha = this.headSha()
    try {
      this.send({ type: 'lookup', id, lookup: sha ? await this.symbols.lookup(sha, path, line, character) : { kind: 'none' } })
    } catch {
      this.send({ type: 'lookup', id, lookup: { kind: 'none' } })
    }
  }

  /** answerReferences asks the language service who calls a declaration. */
  private async answerReferences(id: number, path: string, line: number, character: number): Promise<void> {
    const sha = this.headSha()
    try {
      this.send({ type: 'references', id, references: sha ? await this.symbols.references(sha, path, line, character) : [] })
    } catch {
      this.send({ type: 'references', id, references: [] })
    }
  }

  /** answerPeek reads the source window a caller or a definition points at. */
  private async answerPeek(id: number, location: CodeLocation): Promise<void> {
    const sha = this.headSha()
    try {
      this.send({ type: 'peek', id, peek: sha ? await this.symbols.peek(sha, location) : null })
    } catch {
      this.send({ type: 'peek', id, peek: null })
    }
  }

  /** headSha is the commit the page is reading. */
  private headSha(): string {
    return this.selection?.headSha ?? ''
  }

  /** sendSource hands the page one blob's text, so the diff can open the lines it left out. */
  private async sendSource(blob: string): Promise<void> {
    try {
      this.send({ type: 'source', blob, text: await this.service.repo.blobText(blob) })
    } catch {
      // a blob that will not read simply leaves that file's unchanged lines shut
    }
  }

  /** selector reuses the branch list and timeline until the selection moves. */
  private async selector(): Promise<SelectorState> {
    const selection = this.requireSelection()
    const tip = await this.tipOf(selection.branch)
    const key = [selection.branch, selection.baseBranch, selection.baseSha, selection.headSha, tip].join('\u0000')
    if (this.selectorCache?.for === key) {
      return this.selectorCache.state
    }
    const state = await this.service.selector(selection)
    this.selectorCache = { for: key, state }
    return state
  }

  /** watch reloads the page when an agent appends to the log. */
  private watch(): void {
    const file = this.service.reviews.pathFor(this.key)
    try {
      this.watcher = watch(file, () => {
        void this.pushIfLogGrew()
      })
    } catch {
      // the log is created by start(); a miss just leaves live replies until the next action
    }
  }

  /** pushIfLogGrew re-reads the review only when someone else appended to its log. */
  private async pushIfLogGrew(): Promise<void> {
    if (!this.settle || (await this.logSize()) === this.lastLogSize) {
      return
    }
    await this.push()
  }

  /** tipOf is the branch's current commit. */
  private async tipOf(branch: string): Promise<string> {
    try {
      return await this.service.repo.revParse(branch)
    } catch {
      return ''
    }
  }

  /** logSize is the length of the review's log. */
  private async logSize(): Promise<number> {
    try {
      return (await stat(this.service.reviews.pathFor(this.key))).size
    } catch {
      return -1
    }
  }

  /** branch is the selection's branch, or HEAD before start() has run. */
  private branch(): string {
    return this.selection?.branch || 'HEAD'
  }

  /** requireSelection is the open pair. */
  private requireSelection(): Selection {
    if (!this.selection) {
      throw new Error('the review is not open yet')
    }
    return this.selection
  }
}

/** SubmitResult is what the waiting process prints when the human clicks Submit. */
export interface SubmitResult {
  approved: boolean
  text: string
}

/** messageOf renders any thrown value as a string. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
