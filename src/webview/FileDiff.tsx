import { useMemo, useState, type ReactNode } from 'react'
import {
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
  type HunkTokens,
  type RenderToken,
} from 'react-diff-view'
import type { ChangedFile, Thread } from '../core/types.js'
import { CommentThread, NewCommentBox } from './CommentThread.js'
import { languageForPath, plaintext, type RefractorLike } from './highlight.js'
import { classNameOf, markClassName, styleOf } from './tokens.js'
import { post } from './vscodeApi.js'

/** FileDiff renders one changed file, its threads, and the composer for new comments. */
export const FileDiff = ({
  file,
  meta,
  threads,
  refractor,
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
  reviewed: boolean
  collapsed: boolean
  forced: boolean
  onToggleCollapsed: () => void
  onToggleReviewed: () => void
}) => {
  const [pending, setPending] = useState<PendingComment | null>(null)
  const tokens = useTokens(file, refractor)
  const widgets = useWidgets(file, threads, pending, setPending)
  const hidden = (reviewed || collapsed) && !forced

  return (
    <section className={`gr-file${reviewed ? ' reviewed' : ''}`} id={fileAnchorId(pathOf(file))}>
      <header className="gr-file-header">
        <button className="gr-caret" aria-label={hidden ? 'Expand' : 'Collapse'} onClick={onToggleCollapsed}>
          {hidden ? '▸' : '▾'}
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
            hunks={file.hunks}
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
            {hunks => hunks.map(hunk => <Hunk key={hunk.content} hunk={hunk} />)}
          </Diff>
        ))}
    </section>
  )
}

/** useTokens highlights the file through Shiki, falling back to plain text on any failure. */
function useTokens(file: FileData, refractor: RefractorLike | null): HunkTokens | undefined {
  return useMemo(() => {
    const language = languageForPath(pathOf(file))
    try {
      if (language === plaintext || !refractor) {
        return tokenize(file.hunks, { enhancers: [markEdits(file.hunks, { type: 'block' })] })
      }
      return tokenize(file.hunks, {
        highlight: true,
        refractor: refractor as never,
        language,
        enhancers: [markEdits(file.hunks, { type: 'block' })],
      })
    } catch {
      return undefined
    }
  }, [file, refractor])
}

/** useWidgets maps each change key to the threads and composer rendered beneath that line. */
function useWidgets(
  file: FileData,
  threads: Thread[],
  pending: PendingComment | null,
  setPending: (value: PendingComment | null) => void,
): Record<string, ReactNode> {
  return useMemo(() => {
    const widgets: Record<string, ReactNode> = {}
    const path = pathOf(file)

    for (const hunk of file.hunks) {
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
  }, [file, threads, pending, setPending])
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
