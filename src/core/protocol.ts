import type { BranchSummary, ChangedFile, ReviewState, Timeline } from './types.js'

/** LoadedDiff is the review itself: its folded state and the diff it describes. */
export interface LoadedDiff {
  state: ReviewState
  files: ChangedFile[]
  diff: string
}

/** SelectorState drives the toolbar: one branch choice, and the two commits picked from its ancestry. */
export interface SelectorState {
  branches: BranchSummary[]
  timeline: Timeline
  baseSha: string
  headSha: string
}

/** ReviewPayload is everything the webview needs to render one review. */
export interface ReviewPayload {
  review: LoadedDiff
  selector: SelectorState
  guideBusy: boolean
}

/** HostMessage is sent from the extension host to the webview. */
export type HostMessage =
  | { type: 'review'; payload: ReviewPayload }
  | { type: 'error'; message: string }

/** ViewMessage is sent from the webview to the extension host. */
export type ViewMessage =
  | { type: 'ready' }
  | { type: 'selectBranch'; branch: string }
  | { type: 'selectBase'; sha: string }
  | { type: 'selectTarget'; sha: string }
  | { type: 'startThread'; path: string; side: 'old' | 'new'; line: number; endLine?: number; body: string }
  | { type: 'startGroupThread'; groupId: string; body: string }
  | { type: 'reply'; threadId: string; body: string }
  | { type: 'resolve'; threadId: string }
  | { type: 'reopen'; threadId: string }
  | { type: 'markReviewed'; path: string; blob: string }
  | { type: 'unmarkReviewed'; path: string }
  | { type: 'reviewFiles'; files: { path: string; blob: string }[]; reviewed: boolean }
  | { type: 'generateGuide' }
  | { type: 'openFile'; path: string; line: number }
