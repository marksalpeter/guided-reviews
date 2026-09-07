import { Fragment, useEffect, useRef, useState, type ReactNode, type RefObject } from 'react'

import type { SelectorState } from '../core/protocol.js'
import type { BranchSummary, Timeline, TimelineCommit } from '../core/types.js'
import { post } from './vscodeApi.js'

/** BranchBar is the toolbar's two rows: the branch under review, then the commit range inside it. */
export const BranchBar = ({ selector }: { selector: SelectorState }) => (
  <div className="gr-branchbar">
    <BranchDropdown branches={selector.branches} branch={selector.timeline.branch} />

    <div className="gr-commitbar">
      <CommitDropdown
        timeline={selector.timeline}
        selectedSha={selector.baseSha}
        label={baseTriggerLabel(selector.baseSha, selector.timeline)}
        onSelect={sha => post({ type: 'selectBase', sha })}
      />
      <span className="gr-commitbar-arrow" aria-hidden="true">
        →
      </span>
      <CommitDropdown
        timeline={selector.timeline}
        selectedSha={selector.headSha}
        label={{ owner: '', ref: commitRef(selector.headSha, selector.timeline) }}
        onSelect={sha => post({ type: 'selectTarget', sha })}
      />
    </div>
  </div>
)

/** BranchDropdown is the header band: the fork glyph, the branch under review, and the branch list it opens. */
const BranchDropdown = ({ branches, branch }: { branches: readonly BranchSummary[]; branch: string }) => (
  <Dropdown
    className="gr-branch-trigger"
    title={branch}
    trigger={
      <>
        <ForkGlyph />
        <span className="gr-branch-lead">Review</span>
        <span className="gr-branch-name">{branch}</span>
      </>
    }
  >
    {close =>
      branches.map(summary => (
        <button
          key={summary.name}
          role="option"
          aria-selected={summary.name === branch}
          className={`gr-branch-row${summary.name === branch ? ' selected' : ''}`}
          onClick={() => {
            post({ type: 'selectBranch', branch: summary.name })
            close()
          }}
        >
          <span className="gr-branch-row-name">{summary.name}</span>
          <span className="gr-spacer" />
          <span className="gr-branch-meta">{summary.when}</span>
        </button>
      ))
    }
  </Dropdown>
)

/** CommitDropdown picks one end of the range out of the timeline both ends share. */
const CommitDropdown = ({
  timeline,
  selectedSha,
  label,
  onSelect,
}: {
  timeline: Timeline
  selectedSha: string
  label: CommitLabel
  onSelect: (sha: string) => void
}) => {
  const marker = forkMarkerIndex(timeline)
  return (
    <Dropdown
      className="gr-commit-trigger"
      title={selectedSha}
      trigger={
        <>
          {label.owner && <span className="gr-commit-owner">{label.owner} /</span>}
          <span className="gr-commit-value">{label.ref}</span>
        </>
      }
    >
      {close =>
        timeline.commits.map((commit, index) => (
          <Fragment key={commit.sha}>
            {index === marker && <ForkMarker forkedFrom={timeline.forkedFrom} />}
            <CommitRow
              commit={commit}
              timeline={timeline}
              selected={commit.sha === selectedSha}
              onSelect={() => {
                onSelect(commit.sha)
                close()
              }}
            />
          </Fragment>
        ))
      }
    </Dropdown>
  )
}

/** CommitRow is one commit in a dropdown, coloured by which side of the fork it sits on. */
const CommitRow = ({
  commit,
  timeline,
  selected,
  onSelect,
}: {
  commit: TimelineCommit
  timeline: Timeline
  selected: boolean
  onSelect: () => void
}) => (
  <button
    role="option"
    aria-selected={selected}
    className={`gr-commit-row gr-commit-${commitTone(commit, timeline)}${selected ? ' selected' : ''}`}
    title={commit.sha}
    onClick={onSelect}
  >
    <span className="gr-commit-dot" aria-hidden="true">
      ●
    </span>
    <span className="gr-commit-ref">{commitRef(commit.sha, timeline)}</span>
    <span className="gr-commit-subject">{commit.subject}</span>
    <span className="gr-commit-when">{commit.when}</span>
  </button>
)

/** ForkMarker rules off the commits shared with the branch this one grew out of. */
const ForkMarker = ({ forkedFrom }: { forkedFrom: string }) => (
  <div className="gr-fork-marker" aria-hidden="true">
    <span className="gr-fork-label">forked from {forkedFrom}</span>
    <span className="gr-fork-rule" />
  </div>
)

/** ForkGlyph is the extension's own trunk-and-limb mark, drawn in the current text colour. */
const ForkGlyph = () => (
  <svg className="gr-branch-glyph" viewBox="0 0 128 128" width="13" height="13" aria-hidden="true">
    <g stroke="currentColor" fill="none" strokeLinecap="round" strokeWidth="12">
      <path d="M 42 32 L 42 96" />
      <path d="M 42 88 C 42 60 82 68 82 42" />
    </g>
    <g fill="currentColor">
      <circle cx="42" cy="32" r="13" />
      <circle cx="42" cy="96" r="13" />
      <circle cx="82" cy="42" r="13" />
    </g>
  </svg>
)

/** Dropdown is the button-and-popup listbox every trigger uses, since a native select cannot colour its rows. */
const Dropdown = ({
  className,
  title,
  trigger,
  children,
}: {
  className: string
  title?: string
  trigger: ReactNode
  children: (close: () => void) => ReactNode
}) => {
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLSpanElement>(null)
  useDismiss(root, open, () => setOpen(false))

  return (
    <span className="gr-dropdown" ref={root}>
      <button
        className={className}
        aria-haspopup="listbox"
        aria-expanded={open}
        title={title}
        onClick={() => setOpen(previous => !previous)}
      >
        {trigger}
        <span className="gr-caret" aria-hidden="true">
          ▾
        </span>
      </button>
      {open && (
        <div className="gr-popup" role="listbox">
          {children(() => setOpen(false))}
        </div>
      )}
    </span>
  )
}

/** useDismiss closes an open popup on Escape or on a click landing outside it. */
function useDismiss(root: RefObject<HTMLElement | null>, open: boolean, onDismiss: () => void): void {
  useEffect(() => {
    if (!open) {
      return
    }
    const onMouseDown = (event: MouseEvent) => {
      if (!root.current?.contains(event.target as Node)) {
        onDismiss()
      }
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onDismiss()
      }
    }
    document.addEventListener('mousedown', onMouseDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('mousedown', onMouseDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [root, open, onDismiss])
}

/** commitRef names a commit: `head` at the tip, the branch it forked from at the fork point, else a short sha. */
export function commitRef(sha: string, timeline: Timeline): string {
  if (sha === timeline.commits[0]?.sha) {
    return 'head'
  }
  if (timeline.forkedFrom && sha === timeline.forkSha) {
    return timeline.forkedFrom
  }
  return shortSha(sha)
}

/** baseTriggerLabel names the base commit, owning it to the parent branch only below the fork point. */
export function baseTriggerLabel(sha: string, timeline: Timeline): CommitLabel {
  const commit = timeline.commits.find(entry => entry.sha === sha)
  const belowFork = commit !== undefined && !commit.afterFork && sha !== timeline.forkSha
  return { owner: timeline.forkedFrom && belowFork ? timeline.forkedFrom : '', ref: commitRef(sha, timeline) }
}

/** commitTone is which side of the fork a commit is coloured for, or `none` on an unforked branch. */
export function commitTone(commit: TimelineCommit, timeline: Timeline): CommitToneName {
  if (!timeline.forkedFrom) {
    return 'none'
  }
  return commit.afterFork ? 'after' : 'before'
}

/** forkMarkerIndex is the row the fork marker precedes, or -1 when the timeline has no crossing. */
export function forkMarkerIndex(timeline: Timeline): number {
  if (!timeline.forkedFrom) {
    return -1
  }
  const lastAfterFork = timeline.commits.findLastIndex(commit => commit.afterFork)
  return lastAfterFork === -1 || lastAfterFork === timeline.commits.length - 1 ? -1 : lastAfterFork + 1
}

/** shortSha is the 7-character form git abbreviates a commit to. */
export function shortSha(sha: string): string {
  return sha.slice(0, 7)
}

/** CommitLabel is how one commit reads on a dropdown trigger. */
export interface CommitLabel {
  owner: string
  ref: string
}

/** CommitToneName is the palette a commit row is drawn in. */
export type CommitToneName = 'after' | 'before' | 'none'
