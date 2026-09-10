import { useEffect, useRef, useState } from 'react'
import type { Comment, Thread } from '../core/types.js'
import { post } from './vscodeApi.js'

/** threadElementId is how a deep link finds one thread's card in the document. */
export const threadElementId = (threadId: string): string => `gr-thread-${threadId}`

/** collapsedPreviewLength is how much of the first comment a resolved thread shows. */
const collapsedPreviewLength = 90

/** contextLines is how far either side of its own line a quote reaches once opened. */
const contextLines = 2

/** CommentThread renders one conversation: a resolve tick, the messages, and a composer. */
export const CommentThread = ({ thread, quote }: { thread: Thread; quote?: Quote }) => {
  const [expanded, setExpanded] = useState(false)
  const resolved = thread.state === 'resolved'

  return (
    <div className={`gr-thread${resolved ? ' resolved' : ''}`} id={threadElementId(thread.id)}>
      <ResolveTick
        resolved={resolved}
        onToggle={() => post({ type: resolved ? 'reopen' : 'resolve', threadId: thread.id })}
      />

      {resolved && !expanded ? (
        <button className="gr-thread-collapsed" onClick={() => setExpanded(true)}>
          {preview(thread)}
        </button>
      ) : (
        <>
          {thread.status === 'outdated' && <OutdatedNotice thread={thread} />}
          {quote && <QuoteBand quote={quote} />}
          <div className="gr-comments">
            {thread.comments.map(comment => (
              <CommentBody
                key={comment.id}
                comment={comment}
                onDelete={() => post({ type: 'deleteComment', threadId: thread.id, commentId: comment.id })}
              />
            ))}
          </div>
          <Composer
            placeholder="Reply…"
            submitLabel="Reply"
            settled={thread.comments.length}
            onSubmit={body => post({ type: 'reply', threadId: thread.id, body })}
          />
        </>
      )}
    </div>
  )
}

/** ResolveTick is the bare checkmark in the thread's top corner. */
const ResolveTick = ({ resolved, onToggle }: { resolved: boolean; onToggle: () => void }) => (
  <button
    className={`gr-tick${resolved ? ' checked' : ''}`}
    role="checkbox"
    aria-checked={resolved}
    aria-label={resolved ? 'Reopen thread' : 'Resolve thread'}
    title={resolved ? 'Reopen' : 'Resolve'}
    onClick={onToggle}
  >
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false">
      <path fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" d="M3 8.6 6.2 12 13 4.6" />
    </svg>
  </button>
)

/** QuoteBand stands in for the hidden code a thread points at, and opens the lines around it. */
const QuoteBand = ({ quote }: { quote: Quote }) => {
  const [context, setContext] = useState(false)
  const from = context ? Math.max(quote.from, quote.line - contextLines) : quote.line
  const to = context ? Math.min(quote.to, quote.line + contextLines + 1) : quote.line + 1

  return (
    <div className="gr-preview">
      <div className="gr-preview-head">
        <button className="gr-preview-line" onClick={() => setContext(!context)}>
          line {quote.line}
          <span className="gr-preview-more">{context ? 'hide context' : 'show context'}</span>
        </button>
      </div>
      <table className="gr-preview-code">
        <tbody>
          {window(from, to).map(line => (
            <tr key={line} className={line === quote.line ? 'subject' : undefined}>
              <td className="gr-preview-num">{line}</td>
              <td className="gr-preview-text">{quote.source[line - 1] ?? ''}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

/** CommentBody renders one message, marking only the agent, with a delete affordance on hover. */
const CommentBody = ({ comment, onDelete }: { comment: Comment; onDelete: () => void }) => (
  <div className="gr-comment">
    <span className="gr-comment-mark">
      {comment.author === 'agent' && <i className="gr-comment-dot" title="agent" />}
    </span>
    <div className="gr-comment-body">{comment.body}</div>
    <button className="gr-comment-delete" aria-label="Delete comment" title="Delete comment" onClick={onDelete}>
      <TrashIcon />
    </button>
  </div>
)

/** TrashIcon is the delete glyph shown when a comment is hovered. */
const TrashIcon = () => (
  <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true" focusable="false">
    <path
      fill="none"
      stroke="currentColor"
      strokeWidth="1.2"
      strokeLinecap="round"
      d="M2.5 4.5h11M6 4.5V3h4v1.5M4 4.5l.7 8.2a1 1 0 0 0 1 .8h4.6a1 1 0 0 0 1-.8l.7-8.2M6.6 7v4M9.4 7v4"
    />
  </svg>
)

/** OutdatedNotice shows the code a thread was written against once that code has moved on. */
const OutdatedNotice = ({ thread }: { thread: Thread }) => (
  <>
    <span className="gr-badge">outdated</span>
    {thread.anchor.kind === 'line' && thread.anchor.text && <div className="gr-quote">{thread.anchor.text}</div>}
  </>
)

/** Composer is the box for adding a message: the whole region types, the button sends. */
const Composer = ({
  placeholder,
  submitLabel,
  autoFocus = false,
  settled,
  onSubmit,
  onCancel,
}: {
  placeholder: string
  submitLabel: string
  autoFocus?: boolean
  settled?: number
  onSubmit: (body: string) => void
  onCancel?: () => void
}) => {
  const [draft, setDraft] = useState('')
  const [sent, setSent] = useState(false)
  const field = useRef<HTMLTextAreaElement>(null)
  const submit = () => {
    if (draft.trim()) {
      onSubmit(draft.trim())
      setSent(true)
    }
  }

  // the host writes the comment, reads the diff and pushes a whole payload back, so the draft
  // stands in for it until then rather than leaving the reader looking at a hole
  useEffect(() => {
    if (sent) {
      setDraft('')
      setSent(false)
    }
  }, [settled])

  return (
    <div className="gr-composer" onClick={() => field.current?.focus()}>
      <textarea
        ref={field}
        rows={1}
        autoFocus={autoFocus}
        value={draft}
        placeholder={placeholder}
        onChange={event => {
          setDraft(event.target.value)
          grow(event.target)
        }}
        onKeyDown={event => {
          if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault()
            submit()
          }
          if (event.key === 'Escape') {
            onCancel?.()
          }
        }}
      />
      <div className="gr-composer-buttons">
        <button className="gr-send" disabled={!draft.trim()} onClick={submit}>
          <ReturnIcon />
          {submitLabel}
        </button>
      </div>
    </div>
  )
}

/** ReturnIcon is the key the send button answers to. */
const ReturnIcon = () => (
  <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true" focusable="false">
    <path
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      d="M13.5 3.5v3.5a2 2 0 0 1-2 2H3.5M6.5 6 3.5 9l3 3"
    />
  </svg>
)

/** CloseIcon is the way out of a comment box nothing has been written in yet. */
const CloseIcon = () => (
  <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true" focusable="false">
    <path fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" d="M4 4l8 8M12 4l-8 8" />
  </svg>
)

/** NewCommentBox is the composer shown when a line is first clicked. */
export const NewCommentBox = ({ onSubmit, onCancel }: { onSubmit: (body: string) => void; onCancel: () => void }) => (
  <div className="gr-thread fresh">
    <button className="gr-close" aria-label="Close" title="Close" onClick={onCancel}>
      <CloseIcon />
    </button>
    <Composer placeholder="Leave a comment…" submitLabel="Comment" autoFocus onSubmit={onSubmit} onCancel={onCancel} />
  </div>
)

/** grow keeps the field the height of the draft it holds. */
function grow(field: HTMLTextAreaElement): void {
  field.style.height = 'auto'
  field.style.height = `${field.scrollHeight}px`
}

/** window lists the line numbers between two bounds. */
function window(from: number, to: number): number[] {
  return Array.from({ length: Math.max(0, to - from) }, (_, offset) => from + offset)
}

/** preview is the one-line summary a resolved thread collapses to. */
function preview(thread: Thread): string {
  const first = thread.comments[0]?.body ?? ''
  const extra = thread.comments.length > 1 ? `  +${thread.comments.length - 1}` : ''
  const trimmed = first.length > collapsedPreviewLength ? `${first.slice(0, collapsedPreviewLength)}…` : first
  return `${trimmed}${extra}`
}

/** Quote is the hidden code a thread points at, and how far around it its run reaches. */
export interface Quote {
  line: number
  from: number
  to: number
  source: readonly string[]
}
