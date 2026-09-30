import type { BranchSummary, ChangedFile, ReviewState, Timeline } from './types.js'

/** LoadedDiff is the review itself: its folded state and the diff it describes. */
export interface LoadedDiff {
  state: ReviewState
  files: ChangedFile[]
  diff: string
}

/** SelectorState drives the toolbar: the branch compared against, and the two commits bracketing the diff. */
export interface SelectorState {
  branches: BranchSummary[]
  timeline: Timeline
  baseBranch: string
  baseSha: string
  headSha: string
}

/** ReviewPayload is everything the webview needs to render one review. */
export interface ReviewPayload {
  review: LoadedDiff
  selector: SelectorState
  guideBusy: boolean
  /** focusThread is the comment a deep link asked the panel to reveal, if any. */
  focusThread?: string
}

/** HostMessage is sent from the extension host to the webview. */
export type HostMessage =
  | { type: 'review'; payload: ReviewPayload }
  | { type: 'source'; blob: string; text: string }
  | { type: 'error'; message: string }
  | { type: 'lookup'; id: number; lookup: Lookup }
  | { type: 'references'; id: number; references: Reference[] }

/** ViewMessage is sent from the webview to the extension host. */
export type ViewMessage =
  | { type: 'ready' }
  | { type: 'selectBaseBranch'; branch: string }
  | { type: 'selectBase'; sha: string }
  | { type: 'selectTarget'; sha: string }
  | { type: 'startThread'; path: string; side: 'old' | 'new'; line: number; endLine?: number; body: string }
  | { type: 'startGroupThread'; groupId: string; body: string }
  | { type: 'reply'; threadId: string; body: string }
  | { type: 'deleteComment'; threadId: string; commentId: string }
  | { type: 'resolve'; threadId: string }
  | { type: 'reopen'; threadId: string }
  | { type: 'markReviewed'; path: string; blob: string }
  | { type: 'unmarkReviewed'; path: string }
  | { type: 'reviewFiles'; files: { path: string; blob: string }[]; reviewed: boolean }
  | { type: 'generateGuide' }
  | { type: 'loadSource'; blob: string }
  | { type: 'openFile'; path: string; line: number }
  | { type: 'lookup'; id: number; path: string; line: number; character: number }
  | { type: 'references'; id: number; path: string; line: number; character: number }
  | { type: 'openLocation'; location: CodeLocation }
  | { type: 'submit' }

/** Lookup is what the language server knows about the symbol under the pointer, on the new side of the diff. */
export type Lookup =
  | { kind: 'none' }
  | { kind: 'definition'; range: ColumnRange; target: CodeLocation }
  | { kind: 'declaration'; range: ColumnRange }

/** ColumnRange is a span of one line, in zero-based columns, end exclusive. */
export interface ColumnRange {
  start: number
  end: number
}

/** CodeLocation is a place the language server pointed at; the webview only hands it back to be opened. */
export interface CodeLocation {
  uri: string
  line: number
  character: number
  endLine: number
  endCharacter: number
}

/** Reference is one use of a declaration, labelled for the list of callers. */
export interface Reference {
  location: CodeLocation
  path: string
  line: number
  text: string
}
