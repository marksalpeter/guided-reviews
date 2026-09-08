import { useEffect, useMemo, useState, type ReactElement, type ReactNode } from 'react'
import {
  Decoration,
  Diff,
  Hunk,
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
import { CommentThread, NewCommentBox } from './CommentThread.js'
import {
  gapsOf,
  hiddenIn,
  opened,
  openedAll,
  segmentsOf,
  shownIn,
  shut,
  type Expansion,
  type Expansions,
  type Gap,
} from './expand.js'
import { languageForPath, plaintext, type RefractorLike } from './highlight.js'
import { classNameOf, markClassName, styleOf } from './tokens.js'
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

  const gaps = useGaps(file, source, expansions, threads)
  const segments = useSegments(file, source, gaps)
  const hunks = useMemo(() => segments.flat(), [segments])
  const tokens = useTokens(file, hunks, refractor)
  const widgets = useWidgets(file, hunks, threads, pending, setPending)

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
          <Diff
            viewType="unified"
            diffType={file.type as DiffType}
            hunks={hunks}
            tokens={tokens}
            widgets={widgets}
            renderToken={renderToken}
            gutterEvents={{
              onClick: ({ change }) => {
                if (change) {
                  setPending(pendingFor(change))
                }
              },
            }}
          >
            {() =>
              rows(segments, gaps, (index, expansion) =>
                setExpansions(previous => ({ ...previous, [index]: expansion })),
              )
            }
          </Diff>
        ))}
    </section>
  )
}

/** rows lays the file out as it reads: each gap's control row, then the hunk that follows it. */
function rows(
  segments: readonly HunkData[][],
  gaps: readonly Gap[],
  onChange: (index: number, expansion: Expansion) => void,
): ReactElement[] {
  const laid: ReactElement[] = []

  for (let index = 0; index <= segments.length; index++) {
    const gap = gaps.find(candidate => candidate.index === index)
    if (gap) {
      laid.push(<GapRow key={`gap-${index}`} gap={gap} onChange={expansion => onChange(index, expansion)} />)
    }
    for (const hunk of segments[index] ?? []) {
      laid.push(<Hunk key={hunk.content} hunk={hunk} />)
    }
  }

  return laid
}

/** GapRow stands in for a run of unchanged lines, carrying the controls that open and shut it. */
const GapRow = ({ gap, onChange }: { gap: Gap; onChange: (expansion: Expansion) => void }) => {
  const hiddenLines = hiddenIn(gap)
  const shownLines = shownIn(gap)

  return (
    <Decoration className="gr-expander">
      <div className="gr-expander-arrows">
        {hiddenLines > 0 &&
          gap.edges.map(edge => (
            <button
              key={edge}
              className={`gr-expander-arrow${edge === 'bottom' ? ' up' : ''}`}
              aria-label={edge === 'top' ? 'Expand down' : 'Expand up'}
              onClick={() => onChange(opened(gap, edge))}
            >
              <Caret />
            </button>
          ))}
      </div>
      <div className="gr-expander-content">
        {hiddenLines > 0 && (
          <button className="gr-expander-label" onClick={() => onChange(openedAll(gap))}>
            {countOf(hiddenLines)} unchanged
          </button>
        )}
        {shownLines > 0 && (
          <button className="gr-expander-label" onClick={() => onChange(shut)}>
            Collapse {countOf(shownLines)}
          </button>
        )}
      </div>
    </Decoration>
  )
}

/** countOf renders a line count the way the row reads it out. */
function countOf(lines: number): string {
  return `${lines} line${lines === 1 ? '' : 's'}`
}

/** useBaseText asks the host for the file's base text the first time the diff is on screen. */
function useBaseText(blob: string | undefined, hidden: boolean, source: string[] | undefined): void {
  useEffect(() => {
    if (blob && !hidden && !source) {
      post({ type: 'loadSource', blob })
    }
  }, [blob, hidden, source])
}

/** useGaps finds the runs the diff left out, which only the base text can measure. */
function useGaps(file: FileData, source: string[] | undefined, expansions: Expansions, threads: Thread[]): Gap[] {
  const pinned = threads.filter(thread => thread.status !== 'outdated').map(threadLine)
  const signature = pinned.join(',')

  return useMemo(
    // the threads arrive as fresh objects each push, so the memo keys on the lines they hold
    () => (source ? gapsOf(file.hunks, source.length, expansions, pinned.filter(isLine)) : []),
    [file, source, expansions, signature],
  )
}

/** useSegments rebuilds each hunk with the lines its neighbouring gaps have opened. */
function useSegments(file: FileData, source: string[] | undefined, gaps: Gap[]): HunkData[][] {
  return useMemo(
    () => (source ? segmentsOf(file.hunks, source, gaps) : file.hunks.map(hunk => [hunk])),
    [file, source, gaps],
  )
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
        const line = lineOf(change)
        const onLine = threads.filter(thread => threadLine(thread) === line && thread.status !== 'outdated')
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
                onSubmit={body => {
                  post({ type: 'startThread', path, side: pending.side, line: pending.line, body })
                  setPending(null)
                }}
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

/** pendingFor turns a clicked change into the composer target for that line. */
function pendingFor(change: ChangeData): PendingComment {
  const newLine = computeNewLineNumber(change)
  return {
    key: getChangeKey(change),
    line: newLine > 0 ? newLine : computeOldLineNumber(change),
    side: newLine > 0 ? 'new' : 'old',
  }
}

/** lineOf is the line number a change occupies on whichever side it exists. */
function lineOf(change: ChangeData): number {
  const newLine = computeNewLineNumber(change)
  return newLine > 0 ? newLine : computeOldLineNumber(change)
}

/** threadLine is the line a thread currently points at, after relocation. */
function threadLine(thread: Thread): number | undefined {
  return thread.anchor.kind === 'line' ? (thread.resolvedLine ?? thread.anchor.line) : undefined
}

/** isLine narrows away the threads that hang off a chapter rather than a line. */
function isLine(line: number | undefined): line is number {
  return line !== undefined
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

/** BinaryNote stands in for a diff that cannot be rendered or commented on. */
const BinaryNote = () => <div className="gr-file-note">Binary file — not shown.</div>

/** PendingComment is the line the reviewer is currently composing against. */
interface PendingComment {
  key: string
  line: number
  side: 'old' | 'new'
}
