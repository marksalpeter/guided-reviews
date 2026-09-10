import { Fragment, useEffect, useMemo, useState, type ReactNode } from 'react'
import {
  Diff,
  computeNewLineNumber,
  computeOldLineNumber,
  getChangeKey,
  markEdits,
  tokenize,
  type ChangeData,
  type DiffType,
  type FileData,
  type HunkData,
  type HunkTokens,
  type RenderToken,
} from 'react-diff-view'
import type { ChangedFile, Thread } from '../core/types.js'
import { Caret } from './Caret.js'
import { CommentThread, NewCommentBox, type Quote } from './CommentThread.js'
import { borrowedHunk, expandStep, gapsOf, hiddenIn, sizeOf, type Expansions, type Gap } from './expand.js'
import { languageForPath, plaintext, type HastNode, type RefractorLike } from './highlight.js'
import { classNameOf, inheritedStyle, markClassName, styleOf } from './tokens.js'
import { post } from './vscodeApi.js'

/** FileDiff renders one changed file, its threads, and the composer for new comments. */
export const FileDiff = ({
  file,
  meta,
  threads,
  refractor,
  source,
  reviewed,
  collapsed,
  forced,
  onToggleCollapsed,
  onToggleReviewed,
}: {
  file: FileData
  meta: ChangedFile | undefined
  threads: Thread[]
  refractor: RefractorLike | null
  source: string[] | undefined
  reviewed: boolean
  collapsed: boolean
  forced: boolean
  onToggleCollapsed: () => void
  onToggleReviewed: () => void
}) => {
  const [pending, setPending] = useState<PendingComment | null>(null)
  const [expansions, setExpansions] = useState<Expansions>({})
  const hidden = (reviewed || collapsed) && !forced
  useBaseText(meta?.oldBlob ?? undefined, hidden, source)
  useEffect(() => setExpansions({}), [file])

  const gaps = useGaps(file, source, expansions)
  useSettledPending(threads, pending, setPending)
  const borrowed = useBorrowed(gaps, source)
  const hunks = useMemo(() => [...file.hunks, ...borrowed.values()], [file, borrowed])
  const tokens = useTokens(file, hunks, refractor)
  const highlight = useHighlighter(file, refractor)
  const widgets = useWidgets(file, hunks, threads, pending, setPending)

  const table = (hunk: HunkData) => (
    <DiffTable file={file} hunk={hunk} tokens={tokens} widgets={widgets} onPick={setPending} />
  )
  const foldAt = (index: number) => {
    const gap = gaps.find(candidate => candidate.index === index)
    if (!gap) {
      return null
    }
    const lines = borrowed.get(gap.index)
    return (
      <Fold
        gap={gap}
        buried={buriedIn(gap, threads)}
        source={source ?? []}
        highlight={highlight}
        lines={lines ? table(lines) : null}
        onChange={shown => setExpansions(previous => ({ ...previous, [gap.index]: shown }))}
      />
    )
  }

  return (
    <section className={`gr-file${reviewed ? ' reviewed' : ''}`} id={fileAnchorId(pathOf(file))}>
      <header className="gr-file-header">
        <button
          className="gr-file-toggle"
          aria-label={hidden ? 'Expand' : 'Collapse'}
          aria-expanded={!hidden}
          onClick={onToggleCollapsed}
        >
          <Caret />
        </button>
        <strong>{displayPath(file)}</strong>
        <span className="gr-spacer" />
        {meta && <span className="gr-stat-add">+{meta.additions}</span>}
        {meta && <span className="gr-stat-del">−{meta.deletions}</span>}
        {threads.length > 0 && <span className="gr-badge">{threads.length}</span>}
        <label className="gr-reviewed">
          <input type="checkbox" checked={reviewed} onChange={onToggleReviewed} />
          Reviewed
        </label>
      </header>

      {!hidden &&
        (meta?.binary ? (
          <BinaryNote />
        ) : (
          <div className="gr-diff">
            {file.hunks.map((hunk, index) => (
              <Fragment key={hunk.content}>
                {foldAt(index)}
                {table(hunk)}
              </Fragment>
            ))}
            {foldAt(file.hunks.length)}
          </div>
        ))}
    </section>
  )
}

/** Fold is one run of unchanged lines: the bars that open and shut it, and the lines between them. */
const Fold = ({
  gap,
  buried,
  source,
  highlight,
  lines,
  onChange,
}: {
  gap: Gap
  buried: Thread[]
  source: readonly string[]
  highlight: (text: string) => ReactNode
  lines: ReactNode
  onChange: (shown: number) => void
}) => {
  const rest = hiddenIn(gap)
  const mark = rest > 0 && (
    <>
      <Bar
        role="gr-fold-mark"
        label={`${countOf(rest)} unchanged`}
        note={buried.length > 0 ? `${buried.length} comment${buried.length === 1 ? '' : 's'}` : undefined}
        onClick={() => onChange(sizeOf(gap))}
        onPeek={rest > expandStep ? () => onChange(gap.shown + expandStep) : undefined}
      />
      {buried.length > 0 && (
        <div className="gr-fold-notes">
          {buried.map(thread => (
            <CommentThread key={thread.id} thread={thread} quote={quoteOf(gap, thread, source, highlight)} />
          ))}
        </div>
      )}
    </>
  )
  const handle = gap.shown > 0 && (
    <Bar role="gr-fold-handle" label={`Collapse ${countOf(gap.shown)}`} onClick={() => onChange(0)} />
  )

  // the handle stays against the borrowed lines and the mark sits past it, at the run's outer
  // edge, so a run at the top of a file — which grows upward — reads in the opposite order
  return (
    <section className="gr-fold" data-grows={gap.grows}>
      {gap.grows === 'up' ? (
        <>
          {mark}
          {handle}
          {lines}
        </>
      ) : (
        <>
          {handle}
          {lines}
          {mark}
        </>
      )}
    </section>
  )
}

/** Bar is one edge of a fold: an action across its whole width, and the peek that takes a step. */
const Bar = ({
  role,
  label,
  note,
  onClick,
  onPeek,
}: {
  role: string
  label: string
  note?: string
  onClick: () => void
  onPeek?: () => void
}) => (
  <div className={role}>
    <button className="gr-fold-act" onClick={onClick}>
      <span className="gr-fold-caret">
        <Caret />
      </span>
      <span className="gr-fold-label">{label}</span>
      {note && <span className="gr-fold-note">{note}</span>}
    </button>
    {onPeek && (
      <button className="gr-fold-peek" onClick={onPeek}>
        Show {expandStep}
      </button>
    )}
  </div>
)

/** DiffTable renders one hunk under the file's shared tokens, widgets, and gutter behaviour. */
const DiffTable = ({
  file,
  hunk,
  tokens,
  widgets,
  onPick,
}: {
  file: FileData
  hunk: HunkData
  tokens: HunkTokens | undefined
  widgets: Record<string, ReactNode>
  onPick: (pending: PendingComment) => void
}) => (
  <Diff
    viewType="unified"
    diffType={file.type as DiffType}
    hunks={[hunk]}
    tokens={tokens}
    widgets={widgets}
    renderToken={renderToken}
    gutterEvents={{
      onClick: ({ change }) => {
        if (change) {
          onPick(pendingFor(change))
        }
      },
    }}
  />
)

/** BinaryNote stands in for a diff that cannot be rendered or commented on. */
const BinaryNote = () => <div className="gr-file-note">Binary file — not shown.</div>

/** useBaseText asks the host for the file's base text the first time the diff is on screen. */
function useBaseText(blob: string | undefined, hidden: boolean, source: string[] | undefined): void {
  useEffect(() => {
    if (blob && !hidden && !source) {
      post({ type: 'loadSource', blob })
    }
  }, [blob, hidden, source])
}

/** useHighlighter colours one line of the base text the way the diff colours its own. */
function useHighlighter(file: FileData, refractor: RefractorLike | null): (text: string) => ReactNode {
  return useMemo(() => {
    const language = languageForPath(pathOf(file))
    if (!refractor || language === plaintext) {
      return (text: string) => text
    }
    return (text: string) => {
      try {
        return refractor.highlight(text, language).map((node, index) => renderHast(node, index))
      } catch {
        return text
      }
    }
  }, [file, refractor])
}

/** useSettledPending drops a new comment box once the thread the host wrote for it arrives. */
function useSettledPending(
  threads: Thread[],
  pending: PendingComment | null,
  setPending: (value: PendingComment | null) => void,
): void {
  const arrived = pending !== null && threads.some(thread => onSameLine(thread, pending))

  useEffect(() => {
    if (arrived) {
      setPending(null)
    }
  }, [arrived, setPending])
}

/** useGaps finds the runs the diff left out, which only the base text can measure. */
function useGaps(file: FileData, source: string[] | undefined, expansions: Expansions): Gap[] {
  return useMemo(
    () => (source ? gapsOf(file.hunks, source.length, expansions) : []),
    [file, source, expansions],
  )
}

/** useBorrowed builds the hunk of opened lines each run is currently showing. */
function useBorrowed(gaps: Gap[], source: string[] | undefined): Map<number, HunkData> {
  return useMemo(() => {
    const opened = new Map<number, HunkData>()
    for (const gap of source ? gaps : []) {
      const hunk = borrowedHunk(gap, source ?? [])
      if (hunk) {
        opened.set(gap.index, hunk)
      }
    }
    return opened
  }, [gaps, source])
}

/** useTokens highlights the file through Shiki, falling back to plain text on any failure. */
function useTokens(file: FileData, hunks: HunkData[], refractor: RefractorLike | null): HunkTokens | undefined {
  return useMemo(() => {
    const language = languageForPath(pathOf(file))
    try {
      if (language === plaintext || !refractor) {
        return tokenize(hunks, { enhancers: [markEdits(hunks, { type: 'block' })] })
      }
      return tokenize(hunks, {
        highlight: true,
        refractor: refractor as never,
        language,
        enhancers: [markEdits(hunks, { type: 'block' })],
      })
    } catch {
      return undefined
    }
  }, [file, hunks, refractor])
}

/** useWidgets maps each change key to the threads and composer rendered beneath that line. */
function useWidgets(
  file: FileData,
  hunks: HunkData[],
  threads: Thread[],
  pending: PendingComment | null,
  setPending: (value: PendingComment | null) => void,
): Record<string, ReactNode> {
  return useMemo(() => {
    const widgets: Record<string, ReactNode> = {}
    const path = pathOf(file)

    for (const hunk of hunks) {
      for (const change of hunk.changes) {
        const key = getChangeKey(change)
        const onLine = threads.filter(thread => thread.status !== 'outdated' && anchoredAt(thread, change))
        const isPending = pending?.key === key
        if (onLine.length === 0 && !isPending) {
          continue
        }

        widgets[key] = (
          <div className="gr-widget">
            {onLine.map(thread => (
              <CommentThread key={thread.id} thread={thread} />
            ))}
            {isPending && pending && (
              <NewCommentBox
                onCancel={() => setPending(null)}
                onSubmit={body => post({ type: 'startThread', path, side: pending.side, line: pending.line, body })}
              />
            )}
          </div>
        )
      }
    }
    return widgets
  }, [file, hunks, threads, pending, setPending])
}

/** renderToken draws one syntax token, recursing so Shiki's inline styles survive edit marks. */
const renderToken: RenderToken = (token, renderDefault, index) => {
  if (token.type === 'text') {
    return token.value
  }
  const children =
    typeof token.value === 'string'
      ? token.value
      : token.children?.map((child, i) => renderToken(child, renderDefault, i))
  if (children === undefined) {
    return renderDefault(token, index)
  }
  return (
    <span key={index} className={markClassName(token) ?? classNameOf(token)} style={styleOf(token)}>
      {children}
    </span>
  )
}

/** countOf renders a line count the way a fold's bars read it out. */
function countOf(lines: number): string {
  return `${lines} line${lines === 1 ? '' : 's'}`
}

/** pendingFor turns a clicked change into the composer target for that line. */
function pendingFor(change: ChangeData): PendingComment {
  const newLine = computeNewLineNumber(change)
  return {
    key: getChangeKey(change),
    line: newLine > 0 ? newLine : computeOldLineNumber(change),
    side: newLine > 0 ? 'new' : 'old',
  }
}

/** anchoredAt reports whether a line thread points at this change on its own side of the diff. */
function anchoredAt(thread: Thread, change: ChangeData): boolean {
  if (thread.anchor.kind !== 'line') {
    return false
  }
  const line = threadLine(thread)
  const onSide = thread.anchor.side === 'old' ? computeOldLineNumber(change) : computeNewLineNumber(change)
  return onSide > 0 && onSide === line
}

/** threadLine is the line a thread currently points at, after relocation. */
function threadLine(thread: Thread): number | undefined {
  return thread.anchor.kind === 'line' ? (thread.resolvedLine ?? thread.anchor.line) : undefined
}

/** renderHast draws one syntax node, keeping the inline colours the grammar gave it. */
function renderHast(node: HastNode, index: number): ReactNode {
  if (node.type === 'text') {
    return node.value
  }
  return (
    <span key={index} className={classNameOf(node)} style={inheritedStyle(node)}>
      {node.children?.map((child, at) => renderHast(child, at))}
    </span>
  )
}

/** onSameLine reports whether a thread is anchored where a new comment box is waiting. */
function onSameLine(thread: Thread, pending: PendingComment): boolean {
  return (
    thread.anchor.kind === 'line' &&
    thread.anchor.side === pending.side &&
    threadLine(thread) === pending.line
  )
}

/** quoteOf is the hidden line a listed thread points at, within the reach of its own run. */
function quoteOf(
  gap: Gap,
  thread: Thread,
  source: readonly string[],
  highlight: (text: string) => ReactNode,
): Quote | undefined {
  const line = hiddenLine(gap, thread)
  return line === undefined ? undefined : { line, from: gap.start, to: gap.end, source, highlight }
}

/** buriedIn is the threads left on lines a run is still hiding. */
function buriedIn(gap: Gap, threads: Thread[]): Thread[] {
  return threads.filter(thread => {
    const line = hiddenLine(gap, thread)
    return line !== undefined && line >= gap.start + gap.shown && line < gap.end
  })
}

/** hiddenLine is where a thread sits in a run's own numbering, or nothing if it sits elsewhere. */
function hiddenLine(gap: Gap, thread: Thread): number | undefined {
  const line = threadLine(thread)
  if (thread.status === 'outdated' || thread.anchor.kind !== 'line' || line === undefined) {
    return undefined
  }
  return thread.anchor.side === 'old' ? line : line - gap.delta
}

/** pathOf is the file's current path, falling back to its pre-rename path. */
export function pathOf(file: FileData): string {
  return file.newPath || file.oldPath || ''
}

/** displayPath renders a rename as old → new, and anything else as its path. */
function displayPath(file: FileData): string {
  return file.type === 'rename' && file.oldPath ? `${file.oldPath} → ${file.newPath}` : pathOf(file)
}

/** fileAnchorId is the DOM id the guide rail scrolls to. */
export function fileAnchorId(path: string): string {
  return `file-${path.replace(/[^a-zA-Z0-9]/g, '-')}`
}

/** PendingComment is the line the reviewer is currently composing against. */
interface PendingComment {
  key: string
  line: number
  side: 'old' | 'new'
}
