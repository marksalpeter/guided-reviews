import { Fragment, useEffect, useRef, useState, type ReactNode, type RefObject } from 'react'

import type { SelectorState } from '../core/protocol.js'
import type { BranchSummary, Timeline, TimelineCommit } from '../core/types.js'
import { post } from './vscodeApi.js'

/** BranchBar is the toolbar's picker row: the branch compared against, then the two commits bracketing the diff. */
export const BranchBar = ({ selector }: { selector: SelectorState }) => {
  const { timeline } = selector
  const baseIndex = commitIndex(selector.baseSha, timeline)
  const targetIndex = commitIndex(selector.headSha, timeline)

  return (
    <div className="gr-branchbar">
      <span className="gr-branch">
        <BranchPicker branches={selector.branches} baseBranch={selector.baseBranch} />
      </span>
      <CommitPicker
        role="base"
        timeline={timeline}
        baseBranch={selector.baseBranch}
        selectedSha={selector.baseSha}
        oppositeIndex={targetIndex}
        onSelect={sha => post({ type: 'selectBase', sha })}
      />
      <span className="gr-sep" aria-hidden="true">
        <Chevron />
      </span>
      <CommitPicker
        role="target"
        timeline={timeline}
        baseBranch={selector.baseBranch}
        selectedSha={selector.headSha}
        oppositeIndex={baseIndex}
        onSelect={sha => post({ type: 'selectTarget', sha })}
      />
    </div>
  )
}

/** BranchPicker chooses the branch the review is compared against. */
const BranchPicker = ({ branches, baseBranch }: { branches: readonly BranchSummary[]; baseBranch: string }) => (
  <Dropdown
    className="gr-chip gr-chip-branch"
    title={baseBranch}
    trigger={
      <>
        <ForkGlyph />
        <span className="gr-chip-value">{baseBranch}</span>
      </>
    }
  >
    {close =>
      branches.map(summary => (
        <BranchRow
          key={summary.name}
          summary={summary}
          selected={summary.name === baseBranch}
          onSelect={() => {
            post({ type: 'selectBaseBranch', branch: summary.name })
            close()
          }}
        />
      ))
    }
  </Dropdown>
)

/** BranchRow is one branch in the branch list. */
const BranchRow = ({
  summary,
  selected,
  onSelect,
}: {
  summary: BranchSummary
  selected: boolean
  onSelect: () => void
}) => (
  <button
    role="option"
    aria-selected={selected}
    className={`gr-row gr-row-branch${selected ? ' selected' : ''}`}
    title={summary.name}
    onClick={onSelect}
  >
    <ForkGlyph />
    <span className="gr-row-name">{summary.name}</span>
    {summary.isDefault && <Pill label="default" />}
    <span className="gr-row-when">{summary.when}</span>
  </button>
)

/** CommitPicker chooses one end of the range out of the timeline both ends share. */
const CommitPicker = ({
  role,
  timeline,
  baseBranch,
  selectedSha,
  oppositeIndex,
  onSelect,
}: {
  role: PickerRole
  timeline: Timeline
  baseBranch: string
  selectedSha: string
  oppositeIndex: number
  onSelect: (sha: string) => void
}) => {
  const marker = forkMarkerIndex(timeline)
  return (
    <Dropdown
      className="gr-chip"
      title={selectedSha}
      ariaLabel={commitPill(selectedSha, timeline) === 'base' ? baseLabel(baseBranch) : undefined}
      trigger={<span className="gr-chip-value">{chipLabel(selectedSha, timeline)}</span>}
    >
      {close =>
        timeline.commits.map((commit, index) => (
          <Fragment key={commit.sha}>
            {index === marker && <ForkMarker forkedFrom={timeline.forkedFrom} />}
            <CommitRow
              commit={commit}
              timeline={timeline}
              selected={commit.sha === selectedSha}
              reachable={isReachable(index, role, oppositeIndex)}
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

/** CommitRow is one commit in a commit list, coloured by which side of the fork it sits on. */
const CommitRow = ({
  commit,
  timeline,
  selected,
  reachable,
  onSelect,
}: {
  commit: TimelineCommit
  timeline: Timeline
  selected: boolean
  reachable: boolean
  onSelect: () => void
}) => {
  const pill = commitPill(commit.sha, timeline)
  return (
    <button
      role="option"
      aria-selected={selected}
      aria-disabled={!reachable}
      className={rowClassName(commitTone(commit, timeline), selected, reachable)}
      title={commit.sha}
      onClick={reachable ? onSelect : undefined}
    >
      <span className="gr-dot" aria-hidden="true" />
      <span className="gr-row-sha">{shortSha(commit.sha)}</span>
      {pill && <Pill label={pill} />}
      <span className="gr-row-subject">{commit.subject}</span>
      <span className="gr-row-when">{commit.when}</span>
    </button>
  )
}

/** ForkMarker rules off the commits shared with the branch this one grew out of. */
const ForkMarker = ({ forkedFrom }: { forkedFrom: string }) => (
  <div className="gr-fork-marker" aria-hidden="true">
    <span className="gr-fork-label">
      <ForkGlyph />
      {forkedFrom}
    </span>
    <span className="gr-fork-rule" />
  </div>
)

/** Pill is the hairline chip that names what makes a row special. */
const Pill = ({ label }: { label: string }) => <span className="gr-tag">{label}</span>

/** Chevron is the '>' the range reads across: from the base commit to the target. */
const Chevron = () => (
  <svg viewBox="0 0 6 10" width="5" height="9" aria-hidden="true">
    <path
      d="M1 1 L5 5 L1 9"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
)

/** ForkGlyph is the extension's own trunk-and-limb mark, drawn in the current text colour. */
const ForkGlyph = () => (
  <svg className="gr-glyph" viewBox="0 0 128 128" width="13" height="13" aria-hidden="true">
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

/** Dropdown is the button-and-popup listbox every chip uses, since a native select cannot colour its rows. */
const Dropdown = ({
  className,
  title,
  ariaLabel,
  trigger,
  children,
}: {
  className: string
  title?: string
  ariaLabel?: string
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
        aria-label={ariaLabel}
        title={title}
        onClick={() => setOpen(previous => !previous)}
      >
        {trigger}
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

/** chipLabel names a commit on a chip: `head` at the tip, `base` at the fork point, else a short sha. */
export function chipLabel(sha: string, timeline: Timeline): string {
  return commitPill(sha, timeline) || shortSha(sha)
}

/** commitPill is the pill a commit row carries, empty when the commit is an ordinary one. */
export function commitPill(sha: string, timeline: Timeline): CommitPillName | '' {
  if (sha !== '' && sha === timeline.commits[0]?.sha) {
    return 'head'
  }
  if (sha !== '' && sha === timeline.forkSha) {
    return 'base'
  }
  return ''
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

/** isReachable is whether a row may be picked, keeping the base strictly older than the target. */
export function isReachable(index: number, role: PickerRole, oppositeIndex: number): boolean {
  if (oppositeIndex < 0) {
    return true
  }
  return role === 'base' ? index > oppositeIndex : index < oppositeIndex
}

/** shortSha is the 7-character form git abbreviates a commit to. */
export function shortSha(sha: string): string {
  return sha.slice(0, 7)
}

/** commitIndex locates a sha in the timeline, or -1 when the timeline does not carry it. */
function commitIndex(sha: string, timeline: Timeline): number {
  return timeline.commits.findIndex(commit => commit.sha === sha)
}

/** baseLabel spells out for screen readers what the base chip points at. */
function baseLabel(baseBranch: string): string {
  return `base, the merge base where this branch forked from ${baseBranch}`
}

/** rowClassName assembles the classes one commit row is drawn with. */
function rowClassName(tone: CommitToneName, selected: boolean, reachable: boolean): string {
  return `gr-row gr-row-commit gr-tone-${tone}${selected ? ' selected' : ''}${reachable ? '' : ' unreachable'}`
}

/** PickerRole is which end of the range a commit dropdown selects. */
export type PickerRole = 'base' | 'target'

/** CommitPillName is the pill a special commit row carries. */
export type CommitPillName = 'head' | 'base'

/** CommitToneName is the palette a commit row is drawn in. */
export type CommitToneName = 'after' | 'before' | 'none'
